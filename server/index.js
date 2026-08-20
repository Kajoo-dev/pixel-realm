const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { generateMap, generateTavernMap, TILE_IDS } = require("./map");
const monsters = require("./monsters");
const dragonModule = require("./dragon");
const cavernModule = require("./cavern");
const cliffModule = require("./cliff");
const flyingModule = require("./flying");
const tavernNpcModule = require("./tavernNpcs");

const PORT = process.env.PORT || 3000;
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const SPEED_TILES_PER_SEC = 4.5;
const PLAYER_RADIUS = 0.32; // terrain-collision half-width, in tiles
const ENTITY_RADIUS = monsters.DEFAULT_ENTITY_RADIUS; // players/small monsters' own entity-collision half-width
const MAX_NAME_LEN = 16;

// --- Dash: space bar in the tavern/outside world (the two "first area"
// top-down areas -- the cavern/cliff/flying areas have their own movement
// systems and aren't included) bursts the player 3 tiles at 5x normal
// speed, on a 3s cooldown. Server-authoritative: it's really just a very
// fast, direction-locked burst of the normal per-tick collision-checked
// movement (see Player.applyInput), not a teleport, so it still slides
// along walls/furniture the same way regular movement does instead of
// clipping through them. -------------------------------------------------
const DASH_DISTANCE_TILES = 3;
const DASH_SPEED_MULT = 5;
const DASH_SPEED_TILES_PER_SEC = SPEED_TILES_PER_SEC * DASH_SPEED_MULT;
const DASH_DURATION_MS = (DASH_DISTANCE_TILES / DASH_SPEED_TILES_PER_SEC) * 1000;
const DASH_COOLDOWN_MS = 3000;
const COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];
const RACES = ["human", "elf", "orc", "goblin"];

const PLAYER_MAX_HP = 10;
const FLAMING_SWORD_MAX_HP = 50;
const FLAMING_SWORD_PICKUP_RADIUS = 0.7;
// The flaming sword's offensive upgrade -- 10x melee damage against the
// dragon and every other creature, on top of the player's normal
// level-based dmgMultiplier.
const FLAMING_SWORD_DMG_MULT = 10;
const BOW_PICKUP_RADIUS = 0.7;
const TAVERN_EXIT_TRIGGER_ZONE_TILES = 2; // last N rows in front of the door count as "at the door" -- exits regardless of room size
const TAVERN_ENTER_TRIGGER_RADIUS = 0.9; // tiles, around the outside world's tavern door tile
const PLAYER_ATTACK_MIN_INTERVAL_MS = 150; // anti-spam floor, well under any real click rate
const PLAYER_ATTACK_RANGE = 1.3;
const PLAYER_ATTACK_ARC_RAD = (110 * Math.PI) / 180;
const REGEN_OUT_OF_COMBAT_MS = 10000;
const REGEN_INTERVAL_MS = 3000;
const PLAYER_RESPAWN_DELAY_MS = 3000;
const WATER_SPEED_MULT = 0.5;

// --- Leveling: each kill grants a fraction of the XP bar; that fraction
// halves every level (40% at L1, 20% at L2, 10% at L3, ...), and each level
// grants +10 max HP and a further x1.2 multiplier on outgoing damage
// (melee and arrows alike). Bumped to 4x the original 0.10 base per a later
// balance request ("have creatures give 4x more exp per kill") -- every
// kill path (outside monsters, the dragon, fire goblins, cavern goblins/
// troll, the cavern boss) funnels through Player.grantXp's use of this one
// constant, so scaling it here scales XP from every creature uniformly. ---
const LEVEL_XP_PER_KILL_BASE = 0.40;
const LEVEL_HP_BONUS = 10;
const LEVEL_DMG_MULT = 1.2;
const XP_SHARE_RADIUS = 20; // tiles -- everyone this close to a kill gets XP too

// --- Dragon-death fire hazard --------------------------------------------
const FIRE_HAZARD_RADIUS = 1.1;
const FIRE_HAZARD_LIFETIME_MS = 10000;
const FIRE_BURN_MS = 3000;

// --- Bow + arrows ----------------------------------------------------------
const ARROW_SPEED_TILES_PER_SEC = 5; // 2.5x the original 2 tiles/sec
const ARROW_MAX_LIFETIME_MS = 15000; // safety cap so a missed shot doesn't fly forever
const ARROW_HIT_RADIUS = 0.55;

const MONSTER_COUNT = 10;
const MONSTER_RESPAWN_DELAY_MS = 20000;
const DRAGON_RESPAWN_DELAY_MS = 3 * 60 * 1000; // a boss this tough shouldn't come back quickly

// --- Cavern depths (side-scroller through the cave's back door) -----------
// Physics constants numerically validated against the server's real 20Hz
// Euler tick integration (not textbook continuous-time kinematics): a full
// jump clears ~2.08 tiles of height, comfortably above cavernModule's
// TIER_SPACING (1.8) with margin, and covers ~4 tiles of horizontal
// distance over the full arc, comfortably above the platform-gap cap.
const CAVERN_GRAVITY = 28;
const CAVERN_JUMP_VELOCITY = -11.5;
const CAVERN_HSPEED = 5;
const CAVERN_MAX_FALL_SPEED = 18;
const CAVERN_PLAYER_HALF_WIDTH = 0.34;
// Holding S (down/crouch) and pressing space while grounded on a one-way
// platform drops you through it instead of jumping: a short grace window
// during which ALL one-way-platform landing checks are skipped (plus a
// small downward nudge so gravity actually carries you below it that same
// tick) rather than tracking which specific platform was dropped through.
const CAVERN_DROP_THROUGH_MS = 350;
const CAVERN_DROP_NUDGE_VY = 3;
const CAVERN_DOOR_ENTER_RADIUS = 0.9;
const CAVERN_ARROW_SPEED_TILES_PER_SEC = 7;
const CAVERN_ARROW_MAX_LIFETIME_MS = 6000;
const CAVERN_ARROW_HIT_RADIUS = 0.6;
const CAVERN_MONSTER_RESPAWN_MS = 45000; // bumped 3x from the original 15s per a later balance request

// --- Fire goblins guarding the cave treasure (top-down outside world) -----
// Two dedicated, fixed-position guardians -- not part of the general random
// world monster pool -- rendered client-side with the playable "goblin"
// race sprite tinted red (see race_goblin_red.png) rather than the flat
// rat/bat/spider monster sprite style.
const FIRE_GOBLIN_HP = 8;
const FIRE_GOBLIN_DAMAGE = 2;
const FIRE_GOBLIN_RESPAWN_MS = 25000;

const world = generateMap(60, 42, 1337);
const tavern = generateTavernMap();
const cavernLevel = cavernModule.generateCavernLevel();
const cliffLevel = cliffModule.generateCliffLevel();
// XP multiplier for the giant boss kill -- not explicitly specified by the
// feature request, so this mirrors the same "documented assumption" pattern
// used for the fire goblins' 10x multiplier, just doubled for a boss.
const CAVERN_BOSS_XP_MULT = cavernModule.BOSS_XP_MULT;
// Flips true once the boss is killed -- gates the invisible wall in front of
// the boss arena's exit door (see Player.applyCavernInput) the same way
// setCaveSealed gates the dragon's cave entrance.
let cavernBossDefeated = false;
// Fire bat random-spawn cadence -- see the tick loop below.
const FIRE_BAT_SPAWN_INTERVAL_MIN_MS = 6000;
const FIRE_BAT_SPAWN_INTERVAL_MAX_MS = 14000;
let nextFireBatSpawnAt = Date.now() + FIRE_BAT_SPAWN_INTERVAL_MIN_MS;

// Ceiling spikes: "add a ceiling in the side scroller area, about 10 tiles
// high, and have random spikes that drop down in a straight line to hit the
// player, if it hits them they die instantly." A real-time hazard (spawned
// with Math.random(), same convention as the fire bats above), not part of
// cavern.js's deterministic per-seed level layout. Each spike telegraphs
// briefly at the ceiling (a warning shadow on the ground, client-side) then
// falls straight down; any player it sweeps through on the way down dies
// instantly, same as the ground spike pits.
const SPIKE_SPAWN_INTERVAL_MIN_MS = 2200;
const SPIKE_SPAWN_INTERVAL_MAX_MS = 4200;
const SPIKE_TELEGRAPH_MS = 550; // warning beat before it actually starts falling
const SPIKE_FALL_SPEED = 16; // tiles/sec
const SPIKE_HIT_RADIUS_X = 0.45;
const SPIKE_PLAYER_HEIGHT = 1.5; // approx sprite height, for the vertical sweep-hit band
let nextSpikeSpawnAt = Date.now() + SPIKE_SPAWN_INTERVAL_MIN_MS;
let nextFallingSpikeId = 1;
const cavernFallingSpikes = new Map(); // id -> {id,x,y,telegraphUntil}

// Purely decorative tavern patrons -- see server/tavernNpcs.js. The bar
// stays EMPTY (no wandering patrons) until the player finishes the dragon
// flight minigame and returns with the booze -- see startTavernParty below,
// triggered from exitFlyingToTavern. Dante (the big NPC) is always present,
// standing still at the bar, from the very start of the game.
// canStandOnTerrain is a hoisted function declaration (defined further
// below) so it's already callable here despite the textual order.
const TAVERN_PATRON_COUNT = 16;
const tavernPatrons = [];
const tavernDancer = tavernNpcModule.spawnDancer(tavern);
const tavernNpcs = [tavernDancer];
let tavernPartyStarted = false;

// One-way latch: the first time this fires (when the player exits the
// flying minigame back into the tavern), it populates the previously-empty
// bar with the full 16-patron crowd and kicks off Dante's dance. Pushes
// into the EXISTING tavernPatrons/tavernNpcs array objects (rather than
// reassigning) so the references already captured by module.exports and
// the tick loop stay valid.
function startTavernParty(now) {
  if (tavernPartyStarted) return;
  tavernPartyStarted = true;
  const newPatrons = tavernNpcModule.spawnPatrons(
    tavern,
    (x, y) => canStandOnTerrain("tavern", x, y, PLAYER_RADIUS),
    TAVERN_PATRON_COUNT
  );
  tavernPatrons.push(...newPatrons);
  tavernNpcs.push(...newPatrons);
  tavernDancer.dancing = true;
}

function mapForArea(area) {
  return area === "tavern" ? tavern : world;
}

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, Player>} */
const players = new Map();
/** @type {Map<string, monsters.Monster>} */
const activeMonsters = new Map();
/** pending respawn timers: [{type, at}] */
const respawnQueue = [];

function isBlocked(area, tx, ty) {
  const map = mapForArea(area);
  if (tx < 0 || ty < 0 || ty >= map.height || tx >= map.width) return true;
  return map.collision[ty][tx] === 1;
}

function canStandOnTerrain(area, x, y, radius) {
  const corners = [
    [x - radius, y - radius],
    [x + radius, y - radius],
    [x - radius, y + radius],
    [x + radius, y + radius],
  ];
  for (const [cx, cy] of corners) {
    if (isBlocked(area, Math.floor(cx), Math.floor(cy))) return false;
  }
  return true;
}

/** Terrain + other-entity collision, used by players, monsters, and the
 * dragon alike. `area` ("outside" | "tavern") selects which map/grid and
 * which subset of players to check against -- the two areas are separate
 * spaces, so a player standing at (4, 4) in the tavern never collides with
 * anything at (4, 4) outside. Monsters/the dragon only ever exist in
 * "outside". excludeId keeps an entity from colliding with itself.
 * selfRadius/selfTerrainRadius default to the small-entity size (players
 * and rats/bats/spiders); the dragon calls this with its own much larger
 * radii so its 4x3-tile footprint actually shoves things out of the way
 * instead of clipping through them. */
function canMoveTo(area, x, y, excludeId, selfRadius = ENTITY_RADIUS, selfTerrainRadius = PLAYER_RADIUS) {
  if (!canStandOnTerrain(area, x, y, selfTerrainRadius)) return false;
  for (const p of players.values()) {
    if (p.id === excludeId || p.dead || p.area !== area) continue;
    const required = selfRadius + (p.radius || ENTITY_RADIUS);
    if (Math.hypot(p.x - x, p.y - y) < required) return false;
  }
  if (area === "outside") {
    for (const m of activeMonsters.values()) {
      if (m.id === excludeId || m.dead) continue;
      const required = selfRadius + (m.radius || ENTITY_RADIUS);
      if (Math.hypot(m.x - x, m.y - y) < required) return false;
    }
  }
  return true;
}

function findOpenSpawn(area) {
  const map = mapForArea(area);
  const base = area === "tavern" ? { x: map.spawn.x, y: map.spawn.y } : { x: map.spawn.x + 0.5, y: map.spawn.y + 0.5 };
  if (canMoveTo(area, base.x, base.y, null)) return base;
  for (let r = 1; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = base.x + dx;
        const ny = base.y + dy;
        if (canMoveTo(area, nx, ny, null)) return { x: nx, y: ny };
      }
    }
  }
  return base;
}

// Where a player who DIES respawns -- the graveyard area, now moved into
// the spawn plaza itself (see world.graveyard in map.js). Same open-spot
// search as findOpenSpawn, just anchored on the graveyard's own point
// instead of a map's generic `spawn` (the two happen to be the same tile
// now, but kept as separate lookups in case they diverge again later).
function findOpenGraveyardSpawn() {
  const base = { x: world.graveyard.spawn.x, y: world.graveyard.spawn.y };
  if (canMoveTo("outside", base.x, base.y, null)) return base;
  for (let r = 1; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = base.x + dx;
        const ny = base.y + dy;
        if (canMoveTo("outside", nx, ny, null)) return { x: nx, y: ny };
      }
    }
  }
  return base;
}

function sanitizeName(raw) {
  const s = String(raw || "").replace(/[^\w \-'.]/g, "").trim().slice(0, MAX_NAME_LEN);
  return s.length ? s : "Wanderer";
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function dirFromAngle(angle) {
  const deg = ((angle * 180) / Math.PI + 360) % 360;
  if (deg >= 315 || deg < 45) return "right";
  if (deg >= 45 && deg < 135) return "down";
  if (deg >= 135 && deg < 225) return "left";
  return "up";
}

class Player {
  constructor(id, name, color, race) {
    this.id = id;
    this.name = sanitizeName(name);
    this.color = COLORS.includes(color) ? color : COLORS[Math.floor(Math.random() * COLORS.length)];
    this.race = RACES.includes(race) ? race : "human";
    // Every player starts inside the tavern; the outside world (and the
    // dragon's cave/monsters within it) is only reached by walking out the
    // door (see checkAreaTransition).
    this.area = "tavern";
    const spawn = findOpenSpawn(this.area);
    this.x = spawn.x;
    this.y = spawn.y;
    this.dir = "down";
    this.moving = false;
    this.input = { up: false, down: false, left: false, right: false };
    this.hp = PLAYER_MAX_HP;
    this.maxHp = PLAYER_MAX_HP;
    this.dead = false;
    this.deadAt = 0;
    this.lastAttackAt = 0;
    this.lastCombatAt = 0;
    this.lastRegenAt = 0;
    this.radius = ENTITY_RADIUS;
    this.hasFlamingSword = false;
    this.hasBow = false;
    this.activeWeapon = "sword";
    this.level = 1;
    this.xp = 0; // 0..1 fraction of the way to the next level
    this.dmgMultiplier = 1;
    this.burning = false;
    // Cavern (side-scroller) platformer physics state -- unused/inert
    // outside the "cavern" area.
    this.vy = 0;
    this.grounded = false;
    this.groundedTier = null; // 0 = ground floor, 1 = mid platforms, 2 = top platforms
    this.crouching = false;
    this.dropThroughUntil = 0;
    // Set by the cavern boss's scream attack; blocks movement/jump/attack
    // input (but not gravity/falling) until this timestamp.
    this.stunnedUntil = 0;
    // "Getting stomped 3 times kills you" -- a per-player counter for the
    // boss's stomp attack (see onCavernBossStomp), reset on every respawn.
    this.bossStompCount = 0;
    // Personal flying-minigame instance state (enemies/projectiles/timer),
    // or null outside the "flying" area -- see server/flying.js.
    this.flying = null;
    // Dash state -- see startDash/applyInput. dashUntil is the timestamp the
    // current dash burst ends (0/past = not dashing); dashCooldownUntil is
    // the next time a new dash is allowed; dashDirX/Y is the locked
    // direction for the current burst (normalized, doesn't change mid-dash
    // even if the player's held keys change).
    this.dashUntil = 0;
    this.dashCooldownUntil = 0;
    this.dashDirX = 0;
    this.dashDirY = 0;
  }

  // Space bar in the tavern/outside world -- see the DASH_* constants' doc
  // comment. Returns true if a dash actually started (so the caller knows
  // whether to broadcast it), false if it's on cooldown/not applicable.
  startDash(now) {
    if (this.dead) return false;
    if (this.area !== "outside" && this.area !== "tavern") return false;
    if (now < this.dashCooldownUntil) return false;
    const { up, down, left, right } = this.input;
    let dx = (right ? 1 : 0) - (left ? 1 : 0);
    let dy = (down ? 1 : 0) - (up ? 1 : 0);
    if (dx === 0 && dy === 0) {
      // No directional input currently held -- dash the way we're facing.
      if (this.dir === "left") dx = -1;
      else if (this.dir === "right") dx = 1;
      else if (this.dir === "up") dy = -1;
      else dy = 1;
    }
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }
    this.dashDirX = dx;
    this.dashDirY = dy;
    this.dashUntil = now + DASH_DURATION_MS;
    this.dashCooldownUntil = now + DASH_COOLDOWN_MS;
    return true;
  }

  // Base max HP is 50 while holding the flaming sword, 10 otherwise; each
  // level then adds a further flat +10 on top of whichever base applies.
  recomputeMaxHp() {
    const base = this.hasFlamingSword ? FLAMING_SWORD_MAX_HP : PLAYER_MAX_HP;
    this.maxHp = base + LEVEL_HP_BONUS * (this.level - 1);
    if (this.hp > this.maxHp) this.hp = this.maxHp;
  }

  grantXp(now, mult = 1) {
    const gain = (LEVEL_XP_PER_KILL_BASE / Math.pow(2, this.level - 1)) * mult;
    this.xp += gain;
    let leveled = false;
    // Epsilon guard: repeated 0.1-per-kill additions land at
    // 0.9999999999999999 after exactly 10 kills in floating point, not 1 --
    // without this, leveling up would silently require an extra 11th kill.
    while (this.xp >= 1 - 1e-9) {
      this.xp = Math.max(0, this.xp - 1);
      this.level += 1;
      this.dmgMultiplier = Math.pow(LEVEL_DMG_MULT, this.level - 1);
      this.recomputeMaxHp();
      this.hp = this.maxHp; // leveling up also fully heals, like the HP bonus itself
      leveled = true;
    }
    if (leveled) io.to(this.id).emit("level_up", { level: this.level });
  }

  applyInput(dt, now) {
    if (this.dead) { this.moving = false; return; }

    // Mid-dash: a fixed-direction, fixed-speed burst that overrides normal
    // WASD movement for its short duration, still going through the same
    // per-axis canMoveTo collision check as regular movement (so it slides
    // to a stop against a wall/table instead of clipping through).
    if (now < this.dashUntil) {
      this.moving = true;
      const step = DASH_SPEED_TILES_PER_SEC * dt;
      const nx = this.x + this.dashDirX * step;
      const ny = this.y + this.dashDirY * step;
      if (canMoveTo(this.area, nx, this.y, this.id)) this.x = nx;
      if (canMoveTo(this.area, this.x, ny, this.id)) this.y = ny;
      return;
    }

    const { up, down, left, right } = this.input;
    let dx = (right ? 1 : 0) - (left ? 1 : 0);
    let dy = (down ? 1 : 0) - (up ? 1 : 0);
    this.moving = dx !== 0 || dy !== 0;
    if (!this.moving) return;

    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }

    if (Math.abs(dx) > Math.abs(dy)) this.dir = dx > 0 ? "right" : "left";
    else if (dy !== 0) this.dir = dy > 0 ? "down" : "up";

    const map = mapForArea(this.area);
    const tileRow = map.grid[Math.floor(this.y)];
    const inWater = this.area === "outside" && tileRow && tileRow[Math.floor(this.x)] === TILE_IDS.water;
    const step = SPEED_TILES_PER_SEC * (inWater ? WATER_SPEED_MULT : 1) * dt;
    const nx = this.x + dx * step;
    const ny = this.y + dy * step;

    if (canMoveTo(this.area, nx, this.y, this.id)) this.x = nx;
    if (canMoveTo(this.area, this.x, ny, this.id)) this.y = ny;
  }

  // Side-scroller physics for the cavern depths level: (x, y) is the FOOT
  // position, y increases downward like everywhere else in this codebase.
  // Horizontal movement is free (no terrain collision -- the level has no
  // walls, just tiers of platforms); vertical movement is gravity + a
  // discrete jump impulse (see the "jump" socket handler), with the ground
  // floor (tier 0) solid and tiers 1/2 one-way (see cavernLevel.platforms).
  applyCavernInput(dt, now) {
    if (this.dead) { this.moving = false; return; }
    // Stunned (by the boss's shout) blocks horizontal movement/crouching --
    // gravity and landing below still run as normal, so a stunned player in
    // mid-air still falls and lands, they just can't steer or act.
    const stunned = now < this.stunnedUntil;
    const { left, right, down } = this.input;
    this.crouching = !stunned && !!down;
    const dx = stunned ? 0 : (right ? 1 : 0) - (left ? 1 : 0);
    this.moving = dx !== 0;
    if (dx !== 0) this.dir = dx > 0 ? "right" : "left";

    // The boss arena's exit door is an invisible wall until the boss dies --
    // same "sealed until the guardian is dead" gating as the dragon's cave.
    const maxX = cavernBossDefeated ? cavernLevel.width - 0.5 : Math.min(cavernLevel.width - 0.5, cavernLevel.nextDoorX - 0.5);
    this.x = Math.max(0.5, Math.min(maxX, this.x + dx * CAVERN_HSPEED * dt));

    const prevFootY = this.y;
    this.vy += CAVERN_GRAVITY * dt;
    if (this.vy > CAVERN_MAX_FALL_SPEED) this.vy = CAVERN_MAX_FALL_SPEED;
    const ny = this.y + this.vy * dt;

    let landed = null;
    if (this.vy > 0 && now >= this.dropThroughUntil) {
      for (const p of cavernLevel.platforms) {
        if (
          prevFootY <= p.y + 0.01 &&
          ny >= p.y &&
          this.x + CAVERN_PLAYER_HALF_WIDTH > p.x0 &&
          this.x - CAVERN_PLAYER_HALF_WIDTH < p.x1
        ) {
          landed = { y: p.y, tier: p.tier };
          break;
        }
      }
    }
    // The ground floor isn't solid across a spike pit -- walk/fall past its
    // edge without jumping and there's nothing to land on.
    const overPit = cavernModule.isOverPit(cavernLevel, this.x);
    if (!landed && !overPit && ny >= cavernLevel.groundY) {
      landed = { y: cavernLevel.groundY, tier: 0 };
    }

    if (landed) {
      this.y = landed.y;
      this.vy = 0;
      this.grounded = true;
      this.groundedTier = landed.tier;
    } else {
      this.y = ny;
      this.grounded = false;
      this.groundedTier = null;
      // Fallen far enough into a pit to hit the spikes at the bottom --
      // instant death, same as any other lethal hit.
      if (overPit && this.y >= cavernLevel.groundY + cavernModule.PIT_KILL_DEPTH) {
        this.takeDamage(this.hp + 1, now);
      }
    }
  }

  // The cliff area: a flat ledge, no gravity/jumping at all -- pure
  // horizontal movement, same foot-position (x = position, y = fixed ground
  // line) convention as the cavern.
  applyCliffInput(dt) {
    if (this.dead) { this.moving = false; return; }
    const { left, right } = this.input;
    const dx = (right ? 1 : 0) - (left ? 1 : 0);
    this.moving = dx !== 0;
    if (dx !== 0) this.dir = dx > 0 ? "right" : "left";
    this.x = Math.max(0.5, Math.min(cliffLevel.width - 0.5, this.x + dx * CAVERN_HSPEED * dt));
    this.y = cliffLevel.groundY;
    this.grounded = true;
  }

  // The flying minigame: free 2D movement within a small fixed arena (NOT a
  // scrolling world -- see server/flying.js's header comment). Reuses the
  // same diagonal-normalized movement as the outside-world applyInput.
  applyFlyingInput(dt) {
    if (this.dead) { this.moving = false; return; }
    const { up, down, left, right } = this.input;
    let dx = (right ? 1 : 0) - (left ? 1 : 0);
    let dy = (down ? 1 : 0) - (up ? 1 : 0);
    this.moving = dx !== 0 || dy !== 0;
    if (!this.moving) return;
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv; dy *= inv;
    }
    if (Math.abs(dx) > Math.abs(dy)) this.dir = dx > 0 ? "right" : "left";
    else if (dy !== 0) this.dir = dy > 0 ? "down" : "up";
    const step = CAVERN_HSPEED * dt;
    this.x = Math.max(flyingModule.PLAYER_PAD, Math.min(flyingModule.ARENA_W - flyingModule.PLAYER_PAD, this.x + dx * step));
    this.y = Math.max(flyingModule.PLAYER_PAD, Math.min(flyingModule.ARENA_H - flyingModule.PLAYER_PAD, this.y + dy * step));
  }

  takeDamage(amount, now) {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this.lastCombatAt = now;
    this.lastRegenAt = now;
    if (this.hp <= 0) {
      this.dead = true;
      this.deadAt = now;
      this.burning = false;
      io.emit("player_died", { id: this.id });
    }
  }

  publicState() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      race: this.race,
      area: this.area,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      dir: this.dir,
      moving: this.moving,
      hp: Math.round(this.hp * 100) / 100,
      maxHp: this.maxHp,
      dead: this.dead,
      hasFlamingSword: this.hasFlamingSword,
      hasBow: this.hasBow,
      activeWeapon: this.activeWeapon,
      level: this.level,
      xp: Math.round(this.xp * 1000) / 1000,
      dmgMultiplier: Math.round(this.dmgMultiplier * 1000) / 1000,
      burning: this.burning,
      crouching: this.crouching,
      grounded: this.grounded,
      stunnedUntil: this.stunnedUntil,
    };
  }
}

function scheduleMonsterRespawn(type, now) {
  respawnQueue.push({ type, at: now + MONSTER_RESPAWN_DELAY_MS });
}

function scheduleDragonRespawn(now) {
  respawnQueue.push({ type: "dragon", at: now + DRAGON_RESPAWN_DELAY_MS });
}

const CAVE_KEEPOUT_RADIUS = 12; // small monsters never spawn this close to the dragon's cave
function canMoveToAvoidingCave(x, y, excludeId) {
  if (Math.hypot(x - world.caveEntrance.x, y - world.caveEntrance.y) < CAVE_KEEPOUT_RADIUS) return false;
  return canMoveTo("outside", x, y, excludeId);
}

// The flaming sword: a single shared world item that sits in the middle of
// the dragon's cave until a player walks over it. While held it swaps the
// holder's attack sprite (client-side), boosts their max HP, and blunts the
// dragon's damage against them specifically (see onEntityAttack below). If
// the holder disconnects, it resets back to the cave for the next player.
const flamingSword = {
  held: false,
  holderId: null,
  x: world.caveCenter.x,
  y: world.caveCenter.y,
};

function resetFlamingSwordToCave() {
  flamingSword.held = false;
  flamingSword.holderId = null;
  flamingSword.x = world.caveCenter.x;
  flamingSword.y = world.caveCenter.y;
}

function swordStatePayload() {
  return { held: flamingSword.held, holderId: flamingSword.holderId, x: flamingSword.x, y: flamingSword.y };
}

// The golden bow: a second shared cave item, same touch-to-pickup pattern
// as the flaming sword. Picking it up switches the holder's active weapon
// to "bow" immediately; they can toggle back to the sword client-side
// (select_weapon) any time afterward.
const bow = {
  held: false,
  holderId: null,
  x: world.caveBowSpawn.x,
  y: world.caveBowSpawn.y,
};

function resetBowToCave() {
  bow.held = false;
  bow.holderId = null;
  bow.x = world.caveBowSpawn.x;
  bow.y = world.caveBowSpawn.y;
}

function bowStatePayload() {
  return { held: bow.held, holderId: bow.holderId, x: bow.x, y: bow.y };
}

// The dragon's cave entrance is sealed (blocked) the whole time the dragon
// is alive, and opens once it's dead -- both apply to a fresh dragon after
// it eventually respawns, too. world.collision is mutated in place (and the
// change broadcast) rather than resending the whole grid.
let caveSealed = true;
for (const t of world.caveEntranceTiles) world.collision[t.y][t.x] = 1;
world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] = 1;
world.collision[world.caveSideDoorTile.y][world.caveSideDoorTile.x] = 1;
// The west-side cave door AND the back door (into the cavern depths
// side-scroller) are both ONE-WAY latches, unlike the main entrance: once
// the dragon first dies they open and STAY open forever, even once a fresh
// dragon respawns and reseals the main entrance again -- "stay unlocked if
// the dragon dies, just like the side door". Set true in killMonster()
// below, the moment a dragon dies, and never reset.
let caveSideDoorOpened = false;
let caveBackDoorOpened = false;

function setCaveSealed(sealed) {
  if (sealed === caveSealed) return;
  caveSealed = sealed;
  for (const t of world.caveEntranceTiles) world.collision[t.y][t.x] = sealed ? 1 : 0;
  io.emit("cave_gate", { sealed });
}

// Called once, the moment the dragon first dies -- opens the west side door
// permanently and broadcasts it. A no-op on every subsequent dragon death.
function openCaveSideDoorOnce() {
  if (caveSideDoorOpened) return;
  caveSideDoorOpened = true;
  world.collision[world.caveSideDoorTile.y][world.caveSideDoorTile.x] = 0;
  io.emit("cave_side_gate", { opened: true });
}

// Same one-way latch as openCaveSideDoorOnce, for the back door into the
// cavern depths side-scroller -- previously resealed/unsealed in lockstep
// with the main entrance on every dragon respawn, which meant a fresh
// dragon spawning while someone was already deep in the cavern would lock
// the door behind them. Now it just opens once and stays open.
function openCaveBackDoorOnce() {
  if (caveBackDoorOpened) return;
  caveBackDoorOpened = true;
  world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] = 0;
  io.emit("cave_back_gate", { opened: true });
}

// Fire hazard left behind where the dragon dies: touching it ignites a
// player, who then burns down to 0 HP over FIRE_BURN_MS regardless of
// whether they stay standing in the fire. The patch itself disappears after
// FIRE_HAZARD_LIFETIME_MS.
const fireHazards = []; // { x, y, expiresAt }
function spawnFireHazard(x, y, now) {
  const hazard = { x, y, expiresAt: now + FIRE_HAZARD_LIFETIME_MS };
  fireHazards.push(hazard);
  io.emit("fire_spawned", hazard);
}

// Arrow projectiles fired by the bow.
let nextArrowId = 1;
const projectiles = new Map();
function fireArrow(player, angle, now) {
  const id = "a" + nextArrowId++;
  projectiles.set(id, { id, ownerId: player.id, x: player.x, y: player.y, angle, spawnedAt: now, dmg: player.dmgMultiplier });
}

// --- Cavern depths: goblins/trolls + their own arrow projectiles ----------
// Entirely separate Maps/state from the outside world's activeMonsters and
// projectiles above, by design -- see server/cavern.js's header comment.
const cavernMonsters = new Map();
for (const m of cavernModule.spawnCavernMonsters(cavernLevel)) cavernMonsters.set(m.id, m);
// The giant boss at the end of the boss arena -- one fixed instance, doesn't
// respawn (see killCavernMonster).
const cavernBoss = cavernModule.spawnCavernBoss(cavernLevel);
cavernMonsters.set(cavernBoss.id, cavernBoss);
const cavernRespawnQueue = []; // [{ spec: {type,x,y,tier,x0,x1}, at }]
let nextCavernArrowId = 1;
const cavernProjectiles = new Map(); // both player-fired and troll-fired arrows share this Map

function cavernPlayersNear(y, tolerance) {
  const out = [];
  for (const p of players.values()) {
    if (p.area !== "cavern" || p.dead) continue;
    if (Math.abs(p.y - y) <= tolerance) out.push(p);
  }
  return out;
}

function cavernLivePlayers() {
  const out = [];
  for (const p of players.values()) {
    if (p.area === "cavern" && !p.dead) out.push(p);
  }
  return out;
}

function grantCavernKillXpNearby(x, y, now, mult = 1) {
  for (const p of players.values()) {
    if (p.area !== "cavern" || p.dead) continue;
    if (Math.hypot(p.x - x, p.y - y) <= XP_SHARE_RADIUS) p.grantXp(now, mult);
  }
}

// --- Giant boss goblin: telegraphed slam + shout attacks -------------------
// See cavernModule.updateBossGoblin's header comment for the alternation
// rules. These three callbacks are wired into updateBossGoblin from the tick
// loop below; they're the only place actual damage/stun is applied -- the AI
// function itself just decides *when* an attack windup starts and completes.
// Random taunt lines, per the feature request -- rolled each time a new
// windup starts (roughly every BOSS_ACTION_INTERVAL_MS while a player is
// close enough to fight), so they surface "throughout the fight" without
// needing a separate timer loop.
const BOSS_TAUNT_LINES = [
  "You ruined your own lands, you won't ruin mine!",
  "Stay the fuck away from my booze you drunk bitch!",
  "Looks like meat is back on the menu!",
  "I'll grind your bones to make my bread!",
];
const BOSS_TAUNT_CHANCE = 0.5;

function onCavernBossWindupStart(boss, kind, targetX) {
  io.emit("cavern_boss_windup", {
    id: boss.id,
    kind,
    targetX: kind === "slam" || kind === "stomp" ? targetX : undefined,
    windupMs:
      kind === "slam" ? cavernModule.BOSS_SLAM_WINDUP_MS
      : kind === "stomp" ? cavernModule.BOSS_STOMP_WINDUP_MS
      : cavernModule.BOSS_SHOUT_WINDUP_MS,
  });
  // Taunts are flavor for the slower slam/shout cadence -- skip them on the
  // much more frequent reflexive stomp so they don't spam.
  if (kind !== "stomp" && Math.random() < BOSS_TAUNT_CHANCE) {
    const text = BOSS_TAUNT_LINES[Math.floor(Math.random() * BOSS_TAUNT_LINES.length)];
    io.emit("cavern_boss_taunt", { id: boss.id, text });
  }
}

function onCavernBossSlam(boss, targetX, now) {
  const hitPlayerIds = [];
  for (const p of players.values()) {
    if (p.area !== "cavern" || p.dead) continue;
    if (Math.abs(p.x - targetX) <= cavernModule.BOSS_SLAM_RADIUS) {
      // "Make his hits take 25% of your health if it hits you with his
      // club" -- a fraction of the VICTIM's own max HP, not a flat amount.
      p.takeDamage(Math.round(p.maxHp * cavernModule.BOSS_CLUB_DAMAGE_FRACTION), now);
      hitPlayerIds.push(p.id);
    }
  }
  io.emit("cavern_boss_slam", { id: boss.id, targetX, hitPlayerIds });
}

function onCavernBossShout(boss, now) {
  const stunnedPlayerIds = [];
  for (const p of players.values()) {
    if (p.area !== "cavern" || p.dead) continue;
    if (Math.hypot(p.x - boss.x, p.y - boss.y) <= cavernModule.BOSS_SHOUT_RADIUS) {
      p.stunnedUntil = now + cavernModule.BOSS_STUN_MS;
      stunnedPlayerIds.push(p.id);
    }
  }
  io.emit("cavern_boss_shout", { id: boss.id, stunnedPlayerIds });
}

// "Make him stomp his feet if the player stands under him... getting
// stomped 3 times kills you" -- tracked as a per-player counter
// (player.bossStompCount, reset on respawn) rather than a pure HP-fraction
// calculation, so the 3rd stomp is ALWAYS lethal regardless of any healing
// that may have happened between stomps. The first two stomps still apply
// real damage so the HP bar visibly telegraphs the danger.
const BOSS_STOMP_DAMAGE_FRACTION = 0.3;
function onCavernBossStomp(boss, now) {
  const hitPlayerIds = [];
  const killedPlayerIds = [];
  for (const p of players.values()) {
    if (p.area !== "cavern" || p.dead) continue;
    if (!p.grounded || p.groundedTier !== 0) continue;
    if (Math.abs(p.x - boss.x) > cavernModule.BOSS_STOMP_RANGE) continue;
    p.bossStompCount = (p.bossStompCount || 0) + 1;
    hitPlayerIds.push(p.id);
    if (p.bossStompCount >= 3) {
      killedPlayerIds.push(p.id);
      p.takeDamage(p.hp + 1, now); // guaranteed lethal on the 3rd stomp
    } else {
      p.takeDamage(Math.round(p.maxHp * BOSS_STOMP_DAMAGE_FRACTION), now);
    }
  }
  io.emit("cavern_boss_stomp", { id: boss.id, x: boss.x, hitPlayerIds, killedPlayerIds });
}

// Killing the boss opens the door at the end of the arena (see
// applyCavernInput's maxX gating) -- broadcast so the client can show a
// door-opening cue.
function onBossGoblinDefeated(now) {
  cavernBossDefeated = true;
  io.emit("cavern_boss_defeated", { at: now });
}

function killCavernMonster(m, now) {
  m.dead = true;
  io.emit("cavern_monster_died", { id: m.id, x: m.x, y: m.y, type: m.type });
  cavernMonsters.delete(m.id);
  // The boss doesn't respawn (killing it is a one-time level gate) --
  // everything else (fire goblins, trolls) respawns after a delay.
  if (m.type !== "boss_goblin") {
    cavernRespawnQueue.push({
      spec: { type: m.type, x: m.x, y: m.y, tier: m.tier, x0: m.x0, x1: m.x1 },
      at: now + CAVERN_MONSTER_RESPAWN_MS,
    });
  }
  const xpMult = m.type === "goblin" ? cavernModule.GOBLIN_XP_MULT : m.type === "boss_goblin" ? CAVERN_BOSS_XP_MULT : 1;
  grantCavernKillXpNearby(m.x, m.y, now, xpMult);
  if (m.type === "boss_goblin") onBossGoblinDefeated(now);
}

// shotIndex/shotCount let a troll fire a burst of 2-3 arrows at once with a
// slight angle spread, rather than always a single shot.
function fireCavernArrowAtPlayer(troll, target, shotIndex, shotCount, now) {
  const dx = target.x - troll.x;
  const dy = target.y - 0.7 - (troll.y - 0.6);
  let angle = Math.atan2(dy, dx);
  if (shotCount > 1) angle += (shotIndex - (shotCount - 1) / 2) * 0.12;
  const id = "ca" + nextCavernArrowId++;
  cavernProjectiles.set(id, {
    id, firedBy: "monster", ownerId: troll.id, x: troll.x, y: troll.y - 0.6, angle, spawnedAt: now, dmg: troll.damage,
  });
}

function firePlayerCavernArrow(player, angle, now) {
  const id = "ca" + nextCavernArrowId++;
  cavernProjectiles.set(id, {
    id, firedBy: "player", ownerId: player.id, x: player.x, y: player.y - 0.7, angle, spawnedAt: now, dmg: player.dmgMultiplier,
  });
}

/** Shared cleanup when any monster (including the dragon) dies, regardless
 * of whether a sword swing or an arrow landed the killing blow: announce
 * it, queue its respawn, hand out shared kill XP to everyone nearby, and
 * -- for the dragon specifically -- leave a fire hazard behind. */
function killMonster(m, now) {
  m.dead = true;
  io.emit("monster_died", { id: m.id, x: m.x, y: m.y, type: m.type });
  activeMonsters.delete(m.id);
  if (m.type === "dragon") {
    scheduleDragonRespawn(now);
    spawnFireHazard(m.x, m.y, now);
    openCaveSideDoorOnce();
    openCaveBackDoorOnce();
  } else if (m.type === "fire_goblin") {
    respawnQueue.push({ type: "fire_goblin", spotIndex: m.spotIndex, at: now + FIRE_GOBLIN_RESPAWN_MS });
  } else {
    scheduleMonsterRespawn(m.type, now);
  }
  grantKillXpNearby(m.x, m.y, now);
}

function grantKillXpNearby(x, y, now) {
  for (const p of players.values()) {
    if (p.area !== "outside" || p.dead) continue;
    if (Math.hypot(p.x - x, p.y - y) <= XP_SHARE_RADIUS) p.grantXp(now);
  }
}

/** Door-proximity area transitions: walking down through the tavern's door
 * sends a player outside; walking up to the tavern building's door outside
 * sends them in. Trigger points are offset from each other's arrival spot
 * by more than their trigger radius so the two checks can't ping-pong a
 * player back and forth on the same tick. */
// Stepping through the cave's back door drops the player into the cavern
// depths side-scroller; they keep whatever weapon they already have (sword
// is always implicit, hasBow/activeWeapon carry over unchanged -- nothing
// to reset here). Landing spot is the level's own entrance platform.
function enterCavern(player) {
  player.area = "cavern";
  player.x = cavernLevel.spawn.x;
  player.y = cavernLevel.spawn.y;
  player.vy = 0;
  player.grounded = true;
  player.groundedTier = 0;
  player.crouching = false;
  player.dropThroughUntil = 0;
}

// Walking back to the level's entrance edge returns the player to the cave
// interior, a couple tiles past the back door tile so the two triggers
// can't ping-pong (mirrors the tavern door's own offset trick).
function exitCavern(player) {
  player.area = "outside";
  player.x = world.caveBackDoorTile.x + 0.5;
  player.y = world.caveBackDoorTile.y + 1.8;
  player.vy = 0;
  player.grounded = false;
  player.groundedTier = null;
}

// Walking through the boss-arena door (only reachable once the giant boss is
// dead -- see cavernBossDefeated) lands the player on the cliff's entrance.
function enterCliff(player) {
  player.area = "cliff";
  player.x = cliffLevel.spawn.x;
  player.y = cliffLevel.spawn.y;
}

// Walking back toward the cliff's entrance edge returns to the cavern's boss
// arena, just past the (now permanently open) door.
function exitCliff(player) {
  player.area = "cavern";
  player.x = cavernLevel.nextDoorX - 1.2;
  player.y = cavernLevel.groundY;
  player.vy = 0;
  player.grounded = true;
  player.groundedTier = 0;
}

// Touching one of the cliff's dragon NPCs launches the personal flying
// minigame -- see server/flying.js.
function enterFlying(player, now) {
  player.area = "flying";
  player.x = flyingModule.ARENA_W / 2;
  player.y = flyingModule.ARENA_H - 2;
  player.flying = flyingModule.newFlyingState(now);
  io.to(player.id).emit("flying_start", {
    arenaW: flyingModule.ARENA_W,
    arenaH: flyingModule.ARENA_H,
    durationMs: flyingModule.DURATION_MS,
  });
}

// The minigame's own timer (see the tick loop) calls this once it's over:
// the dragons land and the player fades back into the tavern, per the
// request.
function exitFlyingToTavern(player, now) {
  player.area = "tavern";
  const spawn = findOpenSpawn("tavern");
  player.x = spawn.x;
  player.y = spawn.y;
  player.flying = null;
  io.to(player.id).emit("flying_end", {});
  // First return from the dragon flight populates the bar and starts the
  // party -- a one-way latch, so subsequent flying runs (if any) don't
  // re-trigger it.
  startTavernParty(now);
}

function checkAreaTransition(player) {
  if (player.dead) return;
  // The flying minigame's only exit is timer-driven (see the tick loop's
  // per-player flying update), not a proximity trigger.
  if (player.area === "flying") return;
  if (player.area === "tavern") {
    if (player.y >= tavern.height - TAVERN_EXIT_TRIGGER_ZONE_TILES) {
      player.area = "outside";
      player.x = world.tavernOutsideSpawn.x;
      player.y = world.tavernOutsideSpawn.y;
    }
    return;
  }
  if (player.area === "cavern") {
    if (player.x <= cavernLevel.exitZoneX) { exitCavern(player); return; }
    if (cavernBossDefeated && player.x >= cavernLevel.nextDoorX - 0.6) enterCliff(player);
    return;
  }
  if (player.area === "cliff") {
    if (player.x <= cliffLevel.exitZoneX) { exitCliff(player); return; }
    for (const spot of cliffLevel.dragonSpots) {
      if (Math.hypot(player.x - spot.x, player.y - spot.y) < cliffModule.CLIFF_DRAGON_TOUCH_RADIUS) {
        enterFlying(player, Date.now());
        return;
      }
    }
    return;
  }
  // area === "outside" (covers both the open world and the cave interior)
  const dx = player.x - (world.tavernDoorTile.x + 0.5);
  const dy = player.y - (world.tavernDoorTile.y + 0.5);
  if (Math.hypot(dx, dy) < TAVERN_ENTER_TRIGGER_RADIUS) {
    player.area = "tavern";
    player.x = tavern.spawn.x;
    player.y = tavern.spawn.y;
    return;
  }
  if (caveBackDoorOpened) {
    const bx = player.x - (world.caveBackDoorTile.x + 0.5);
    const by = player.y - (world.caveBackDoorTile.y + 0.5);
    if (Math.hypot(bx, by) < CAVERN_DOOR_ENTER_RADIUS) enterCavern(player);
  }
}

function spawnMonster(type) {
  const spot = monsters.findSpawnSpot(world, Array.from(activeMonsters.values()), canMoveToAvoidingCave);
  if (!spot) return null;
  const m = new monsters.Monster(type, spot.x, spot.y);
  activeMonsters.set(m.id, m);
  io.emit("monster_spawned", m.publicState());
  return m;
}

// Spawned 1 tile further out (south) than the cave entrance's own point --
// right at world.caveEntrance the dragon was landing directly on/against
// the newly-sealed entrance gate tiles (blocked in the collision grid
// while it's alive), which could leave it wedged against its own seal.
const DRAGON_SPAWN_Y_OFFSET = 1;

function spawnDragon() {
  const d = new dragonModule.Dragon(world.caveEntrance.x, world.caveEntrance.y + DRAGON_SPAWN_Y_OFFSET, SPEED_TILES_PER_SEC);
  activeMonsters.set(d.id, d);
  io.emit("monster_spawned", d.publicState());
  return d;
}

// Fixed guard points flanking the cave's treasure/sword center -- clear of
// the sword/bow/treasure spots themselves (see world.caveTreasure's own
// keepout logic in map.js).
const FIRE_GOBLIN_SPOTS = [
  { x: world.caveCenter.x - 4, y: world.caveCenter.y + 3 },
  { x: world.caveCenter.x + 4, y: world.caveCenter.y + 3 },
];

function spawnFireGoblin(spotIndex) {
  const spot = FIRE_GOBLIN_SPOTS[spotIndex] || FIRE_GOBLIN_SPOTS[0];
  const m = new monsters.Monster("fire_goblin", spot.x, spot.y);
  m.hp = FIRE_GOBLIN_HP;
  m.maxHp = FIRE_GOBLIN_HP;
  m.damage = FIRE_GOBLIN_DAMAGE;
  m.homeX = spot.x;
  m.homeY = spot.y;
  m.spotIndex = spotIndex;
  activeMonsters.set(m.id, m);
  io.emit("monster_spawned", m.publicState());
  return m;
}

for (const m of monsters.spawnInitialMonsters(world, canMoveToAvoidingCave, MONSTER_COUNT)) {
  activeMonsters.set(m.id, m);
}

const initialDragon = new dragonModule.Dragon(world.caveEntrance.x, world.caveEntrance.y + DRAGON_SPAWN_Y_OFFSET, SPEED_TILES_PER_SEC);
activeMonsters.set(initialDragon.id, initialDragon);

for (let i = 0; i < FIRE_GOBLIN_SPOTS.length; i++) spawnFireGoblin(i);

io.on("connection", (socket) => {
  socket.on("join", (payload, ack) => {
    if (players.has(socket.id)) return;
    const player = new Player(
      socket.id,
      payload && payload.name,
      payload && payload.color,
      payload && payload.race
    );
    players.set(socket.id, player);

    if (typeof ack === "function") {
      ack({
        you: player.publicState(),
        map: {
          width: world.width,
          height: world.height,
          grid: world.grid,
          collision: world.collision,
          tavernDoorTile: world.tavernDoorTile,
          caveBackDoorTile: world.caveBackDoorTile,
          caveSideDoorTile: world.caveSideDoorTile,
        },
        tavernMap: {
          width: tavern.width,
          height: tavern.height,
          grid: tavern.grid,
          collision: tavern.collision,
          doorTile: tavern.doorTile,
          decor: tavern.decor,
        },
        cavernMap: {
          width: cavernLevel.width,
          groundY: cavernLevel.groundY,
          tierY: cavernLevel.tierY,
          platforms: cavernLevel.platforms,
          pits: cavernLevel.pits,
          ceilingY: cavernModule.CEILING_Y,
          spawn: cavernLevel.spawn,
          exitZoneX: cavernLevel.exitZoneX,
          bossArenaStart: cavernLevel.bossArenaStart,
          nextDoorX: cavernLevel.nextDoorX,
          bossDefeated: cavernBossDefeated,
          decor: cavernLevel.decor,
        },
        cliffMap: {
          width: cliffLevel.width,
          groundY: cliffLevel.groundY,
          spawn: cliffLevel.spawn,
          exitZoneX: cliffLevel.exitZoneX,
          dragonSpots: cliffLevel.dragonSpots,
          barrels: cliffLevel.barrels,
          sign: cliffLevel.sign,
        },
        swordState: swordStatePayload(),
        bowState: bowStatePayload(),
        caveEntranceTiles: world.caveEntranceTiles,
        caveSealed,
        caveSideDoorOpened,
        caveBackDoorOpened,
        caveTreasure: world.caveTreasure,
        graveyardHeadstones: world.graveyard.headstones,
        tavernRoofSign: world.tavernRoofSign,
        fireHazards,
        players: Array.from(players.values()).map((p) => p.publicState()),
        monsters: Array.from(activeMonsters.values()).map((m) => m.publicState()),
        cavernMonsters: Array.from(cavernMonsters.values()).map((m) => m.publicState()),
        colors: COLORS,
        races: RACES,
      });
    }

    socket.broadcast.emit("player_joined", player.publicState());
  });

  socket.on("input", (input) => {
    const player = players.get(socket.id);
    if (!player || !input) return;
    player.input.up = !!input.up;
    player.input.down = !!input.down;
    player.input.left = !!input.left;
    player.input.right = !!input.right;
  });

  // Discrete jump event (not a sustained input flag, so the server doesn't
  // need to detect a rising edge itself): space bar in the cavern. Holding
  // S (down) at the moment of a jump while grounded on a one-way platform
  // (tier 1/2) drops the player through it instead of jumping up.
  socket.on("jump", () => {
    const player = players.get(socket.id);
    if (!player || player.dead || player.area !== "cavern" || !player.grounded) return;
    const now = Date.now();
    if (now < player.stunnedUntil) return;
    if (player.crouching && player.groundedTier > 0) {
      player.dropThroughUntil = now + CAVERN_DROP_THROUGH_MS;
      player.vy = CAVERN_DROP_NUDGE_VY;
    } else {
      player.vy = CAVERN_JUMP_VELOCITY;
    }
    player.grounded = false;
    player.groundedTier = null;
  });

  // Discrete dash event: space bar in the tavern/outside world (see the
  // DASH_* constants' doc comment near the top of this file). Broadcasts
  // player_dash to everyone (not just the dasher) so remote clients can
  // render the fading mirage trail behind any dashing player, not only
  // their own.
  socket.on("dash", () => {
    const player = players.get(socket.id);
    if (!player) return;
    const now = Date.now();
    if (player.startDash(now)) {
      io.emit("player_dash", {
        id: player.id,
        dirX: player.dashDirX,
        dirY: player.dashDirY,
        durationMs: DASH_DURATION_MS,
      });
    }
  });

  // Mouse click in the flying minigame: shoot a fireball from the player's
  // dragon toward the clicked screen point (see the client's mousedown
  // handler, which converts screen coords to an arena-relative angle and
  // emits this while myArea === "flying"). Space bar still works too, as a
  // straight-up fallback (angle omitted).
  socket.on("fly_shoot", (info) => {
    const player = players.get(socket.id);
    if (!player || player.dead || player.area !== "flying" || !player.flying) return;
    // Only the two phases with something to shoot at accept fire input --
    // "bossDying"/"woosh" are a scripted cutscene beat (see the tick loop),
    // so a shot fired during them would just be a stray, never-processed
    // projectile with no target left to hit.
    if (player.flying.phase !== "waves" && player.flying.phase !== "boss") return;
    const now = Date.now();
    if (now - player.flying.lastFireAt < flyingModule.FIRE_COOLDOWN_MS) return;
    player.flying.lastFireAt = now;
    const angle = info && typeof info.angle === "number" && isFinite(info.angle) ? info.angle : -Math.PI / 2;
    player.flying.projectiles.push({
      id: "fp" + player.flying.nextProjId++,
      x: player.x,
      y: player.y - 0.5,
      vx: Math.cos(angle) * flyingModule.FIRE_SPEED,
      vy: Math.sin(angle) * flyingModule.FIRE_SPEED,
    });
  });

  // Melee damage for one sword swing: level-based dmgMultiplier, further
  // multiplied by FLAMING_SWORD_DMG_MULT once the flaming sword's been
  // picked up -- applies against every creature (cavern goblins/trolls,
  // outside-world monsters, and the dragon alike), not just the dragon.
  function swordDamage(player) {
    return player.dmgMultiplier * (player.hasFlamingSword ? FLAMING_SWORD_DMG_MULT : 1);
  }

  socket.on("attack", (payload) => {
    const player = players.get(socket.id);
    if (!player || player.dead) return;
    const now = Date.now();
    if (now < player.stunnedUntil) return;
    if (now - player.lastAttackAt < PLAYER_ATTACK_MIN_INTERVAL_MS) return;
    player.lastAttackAt = now;
    player.lastCombatAt = now;

    const angle = Number(payload && payload.angle);
    if (!Number.isFinite(angle)) return;
    player.dir = dirFromAngle(angle);

    io.emit("player_attack", { id: player.id, angle, weapon: player.activeWeapon });

    if (player.area === "cavern") {
      if (player.activeWeapon === "bow" && player.hasBow) {
        firePlayerCavernArrow(player, angle, now);
        return;
      }
      for (const m of cavernMonsters.values()) {
        if (m.dead) continue;
        const dx = m.x - player.x;
        const dy = (m.y - 0.7) - (player.y - 0.7);
        const dist = Math.hypot(dx, dy);
        // Widened for the giant boss (m.hitRadius) so his much-larger sprite
        // registers hits anywhere on his body, not just exactly at his feet
        // -- same pattern already used for outside-world monsters below.
        const effRange = PLAYER_ATTACK_RANGE + (m.hitRadius || 0);
        if (dist > effRange) continue;
        const targetAngle = Math.atan2(dy, dx);
        if (Math.abs(normalizeAngle(targetAngle - angle)) > PLAYER_ATTACK_ARC_RAD / 2) continue;
        m.hp -= swordDamage(player);
        io.emit("cavern_sword_hit", { attackerId: player.id, targetId: m.id, x: m.x, y: m.y });
        if (m.hp <= 0) killCavernMonster(m, now);
        break;
      }
      return;
    }

    if (player.area !== "outside") return; // monsters/the dragon only exist outside

    if (player.activeWeapon === "bow" && player.hasBow) {
      fireArrow(player, angle, now);
      return;
    }

    for (const m of activeMonsters.values()) {
      if (m.dead) continue;
      const dx = m.x - player.x;
      const dy = m.y - player.y;
      const dist = Math.hypot(dx, dy);
      const effRange = PLAYER_ATTACK_RANGE + (m.hitRadius || 0);
      if (dist > effRange) continue;
      const targetAngle = Math.atan2(dy, dx);
      if (Math.abs(normalizeAngle(targetAngle - angle)) > PLAYER_ATTACK_ARC_RAD / 2) continue;

      m.hp -= swordDamage(player);
      m.aggroTarget = player.id;
      io.emit("sword_hit", { attackerId: player.id, targetId: m.id, x: m.x, y: m.y });
      if (m.hp <= 0) killMonster(m, now);
      break; // one target per swing keeps combat readable
    }
  });

  // Only takes effect if the player actually has that weapon (the sword is
  // always implicitly available; the bow requires having picked it up).
  socket.on("select_weapon", (payload) => {
    const player = players.get(socket.id);
    if (!player) return;
    const w = payload && payload.weapon;
    if (w === "bow" && player.hasBow) player.activeWeapon = "bow";
    else if (w === "sword") player.activeWeapon = "sword";
  });

  socket.on("chat", (text) => {
    const player = players.get(socket.id);
    if (!player) return;
    const clean = String(text || "").slice(0, 140).trim();
    if (!clean) return;
    io.emit("chat", { id: player.id, name: player.name, text: clean, t: Date.now() });
  });

  // --- Proximity voice chat signaling -------------------------------
  // The server never sees/touches audio itself; it's a pure relay for
  // WebRTC offer/answer/ICE messages between two specific peers so they
  // can establish a direct peer-to-peer connection. To avoid both sides
  // racing to send an offer at once, only the player who was already in
  // the room initiates the offer toward a newly-joined player (see the
  // "player_joined" broadcast above, and voice.js on the client).
  socket.on("voice-signal", (msg) => {
    if (!msg || !msg.to || !players.has(msg.to)) return;
    if (!players.has(socket.id)) return;
    io.to(msg.to).emit("voice-signal", {
      from: socket.id,
      voiceType: msg.voiceType,
      data: msg.data,
    });
  });

  socket.on("disconnect", () => {
    if (players.has(socket.id)) {
      if (flamingSword.held && flamingSword.holderId === socket.id) {
        resetFlamingSwordToCave();
        io.emit("sword_state", swordStatePayload());
      }
      if (bow.held && bow.holderId === socket.id) {
        resetBowToCave();
        io.emit("bow_state", bowStatePayload());
      }
      players.delete(socket.id);
      io.emit("player_left", socket.id);
    }
  });
});

// Authoritative game loop.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  for (const player of players.values()) {
    if (player.area === "cavern") player.applyCavernInput(dt, now);
    else if (player.area === "cliff") player.applyCliffInput(dt);
    else if (player.area === "flying") player.applyFlyingInput(dt);
    else player.applyInput(dt, now);
    checkAreaTransition(player);

    // Regen: only once you've been out of combat for a while, then a
    // trickle every few seconds.
    if (!player.dead && player.hp < player.maxHp && now - player.lastCombatAt >= REGEN_OUT_OF_COMBAT_MS) {
      if (now - player.lastRegenAt >= REGEN_INTERVAL_MS) {
        player.hp = Math.min(player.maxHp, player.hp + 1);
        player.lastRegenAt = now;
      }
    }

    if (player.dead && now - player.deadAt >= PLAYER_RESPAWN_DELAY_MS) {
      // Where you respawn depends on where you died -- player.area is never
      // touched between death and respawn (dead players' input is ignored),
      // so it still reflects that. Per the spec: dying in the general cave
      // side-scroller sends you back to its start; dying specifically at
      // the giant boss goblin (inside the boss arena) drops you right back
      // at its door instead of all the way at the cave entrance; dying
      // during the dragon flight restarts that same encounter. Everywhere
      // else (outside world, tavern, cliff) keeps the previous graveyard
      // behavior.
      const dieArea = player.area;
      if (dieArea === "cavern" && player.x >= cavernLevel.bossArenaStart) {
        player.area = "cavern";
        player.x = Math.max(2, cavernLevel.bossArenaStart - 3);
        player.y = cavernLevel.groundY;
        player.vy = 0;
        player.grounded = true;
        player.groundedTier = 0;
        player.crouching = false;
        player.dropThroughUntil = 0;
      } else if (dieArea === "cavern") {
        enterCavern(player);
      } else if (dieArea === "flying") {
        enterFlying(player, now); // fresh run of the encounter, already sets area/x/y/flying
      } else {
        player.area = "outside";
        const spawn = findOpenGraveyardSpawn();
        player.x = spawn.x;
        player.y = spawn.y;
      }
      player.hp = player.maxHp;
      player.dead = false;
      player.burning = false;
      player.bossStompCount = 0;
      player.dashUntil = 0; // don't resume flinging them in a stale direction if they died mid-dash
      if (dieArea !== "flying") player.flying = null; // enterFlying already set a fresh instance
      player.lastCombatAt = now;
      player.lastRegenAt = now;
      io.emit("player_respawned", player.publicState());
    }

    // Burning: ignited by touching a dragon-death fire hazard (below), deals
    // damage over FIRE_BURN_MS regardless of whether the player is still
    // standing in the fire, so a full-health player burns to death in
    // almost exactly that long.
    if (player.burning && !player.dead) {
      player.takeDamage((player.maxHp / (FIRE_BURN_MS / 1000)) * dt, now);
    }

    // --- Flying minigame: personal per-player instance (see server/flying.js
    // header comment) -- enemy spawning (on a ramp)/homing/contact damage,
    // both sides' fireball movement/hits (bullet-hell: enemies fire back),
    // and the fixed-duration end condition, all ticked here and pushed ONLY
    // to this player's own socket below. ---
    if (player.area === "flying" && player.flying && !player.dead) {
      const fs = player.flying;
      if (fs.phase === "waves" && now - fs.startedAt >= flyingModule.DURATION_MS) {
        // "make all the dragons on the map disappear then have a giant
        // dragon appear" -- clean slate: the wave enemies/both sides'
        // projectiles are wiped, then the boss phase takes over the same
        // fs.enemyProjectiles array for its own cone-spray fireballs.
        fs.enemies = [];
        fs.projectiles = [];
        fs.enemyProjectiles = [];
        fs.phase = "boss";
        fs.boss = flyingModule.newBossState(now);
        io.to(player.id).emit("flying_boss_start", {
          x: fs.boss.x, y: fs.boss.y, hp: fs.boss.hp, maxHp: fs.boss.maxHp,
        });
      } else if (fs.phase === "bossDying") {
        // Fire/smoke explosion beat (purely client-visual) plays out for
        // BOSS_DEATH_FX_MS, then the player's dragon wooshes off screen.
        if (now - fs.bossDiedAt >= flyingModule.BOSS_DEATH_FX_MS) {
          fs.phase = "woosh";
          fs.wooshStartAt = now;
          io.to(player.id).emit("flying_woosh_start", {});
        }
      } else if (fs.phase === "woosh") {
        // Client plays its own woosh-off tween; once it's had time to
        // finish, cut to the tavern for the party (per the request).
        if (now - fs.wooshStartAt >= flyingModule.BOSS_WOOSH_MS) {
          exitFlyingToTavern(player, now);
        }
      } else if (fs.phase === "boss") {
        const boss = fs.boss;

        // Fire-beam sweep: independent cooldown from the cone-spray attack,
        // and mutually exclusive with it (see the cone-fire trigger and the
        // drift-hover below, both gated on !boss.beam). "He can only make
        // one pass to the left or right while the beam is active" -- a
        // direction is picked once, the boss (and beam) starts at that
        // side's edge, and it sweeps straight across to the opposite edge
        // exactly once before turning off.
        if (!boss.beam && now >= boss.nextBeamAt) {
          const dir = Math.random() < 0.5 ? -1 : 1;
          const startX = dir === 1 ? flyingModule.PLAYER_PAD : flyingModule.ARENA_W - flyingModule.PLAYER_PAD;
          // "Only shoots across 75% of the screen so the player can still
          // get away from it" -- the sweep travels BOSS_BEAM_SWEEP_FRACTION
          // of the full arena width from its starting edge, not all the way
          // to the far edge, leaving a guaranteed-safe strip to run to.
          const fullTravel = flyingModule.ARENA_W - flyingModule.PLAYER_PAD * 2;
          const endX = startX + dir * fullTravel * flyingModule.BOSS_BEAM_SWEEP_FRACTION;
          boss.x = startX;
          boss.beam = { dir, endX, telegraphUntil: now + flyingModule.BOSS_BEAM_TELEGRAPH_MS, sweeping: false, lastHitAt: 0 };
          io.to(player.id).emit("flying_boss_beam_start", { dir, x: startX, telegraphMs: flyingModule.BOSS_BEAM_TELEGRAPH_MS });
        }

        if (boss.beam) {
          const beam = boss.beam;
          if (!beam.sweeping && now >= beam.telegraphUntil) beam.sweeping = true;
          if (beam.sweeping) {
            boss.x = Math.max(
              flyingModule.PLAYER_PAD,
              Math.min(flyingModule.ARENA_W - flyingModule.PLAYER_PAD, boss.x + beam.dir * flyingModule.BOSS_BEAM_STRAFE_SPEED * dt)
            );
            if (
              Math.abs(player.x - boss.x) <= flyingModule.BOSS_BEAM_WIDTH &&
              now - beam.lastHitAt >= flyingModule.ENEMY_CONTACT_COOLDOWN_MS
            ) {
              beam.lastHitAt = now;
              player.takeDamage(flyingModule.BOSS_BEAM_DAMAGE, now);
              io.to(player.id).emit("flying_hit", {});
            }
            const reachedEnd = beam.dir === 1
              ? boss.x >= beam.endX - 0.01
              : boss.x <= beam.endX + 0.01;
            if (reachedEnd) {
              boss.beam = null;
              boss.nextBeamAt = now + flyingModule.randomBossBeamDelay();
              io.to(player.id).emit("flying_boss_beam_end", {});
            }
          }
        } else {
          // Slow side-to-side hover, purely a function of elapsed time (same
          // "deterministic function of stable inputs" convention used
          // elsewhere -- see the cavern pit spike jitter) rather than homing
          // in on the player like the wave enemies do. Suspended entirely
          // while a beam attack owns his x position.
          boss.x = flyingModule.ARENA_W / 2 + Math.sin((now - boss.spawnedAt) / 1000 / flyingModule.BOSS_DRIFT_PERIOD_S * Math.PI * 2) * flyingModule.BOSS_DRIFT_RANGE;
        }

        // Cone-spray attack: 10 fireballs fanned across a wide arc centered
        // on the player's position AT CAST TIME (dodgeable, same convention
        // as the wave enemies' aimed shots / the cavern boss's slam).
        // Suppressed entirely while the beam attack is in progress (telegraph
        // or sweeping) -- these two attacks never overlap.
        if (!boss.beam && now >= boss.nextFireAt) {
          boss.nextFireAt = now + flyingModule.randomBossFireDelay();
          const baseAngle = Math.atan2(player.y - boss.y, player.x - boss.x);
          const n = flyingModule.BOSS_CONE_COUNT;
          for (let i = 0; i < n; i++) {
            const t = n === 1 ? 0 : i / (n - 1) - 0.5; // -0.5..0.5 across the fan
            const a = baseAngle + t * flyingModule.BOSS_CONE_SPREAD_RAD;
            fs.enemyProjectiles.push({
              id: "ep" + fs.nextEnemyProjId++, x: boss.x, y: boss.y,
              vx: Math.cos(a) * flyingModule.BOSS_FIRE_SPEED,
              vy: Math.sin(a) * flyingModule.BOSS_FIRE_SPEED,
            });
          }
        }

        // Touching the giant dragon's body still hurts, same as any other
        // contact damage in the game.
        const bDist = Math.hypot(player.x - boss.x, player.y - boss.y);
        if (bDist <= flyingModule.BOSS_CONTACT_RADIUS && now - boss.lastContactAt >= flyingModule.ENEMY_CONTACT_COOLDOWN_MS) {
          boss.lastContactAt = now;
          player.takeDamage(flyingModule.BOSS_CONTACT_DAMAGE, now);
          io.to(player.id).emit("flying_hit", {});
        }

        // Player fireballs vs the boss -- "the player must shoot the giant
        // dragon 50 times to kill it" (BOSS_MAX_HP=50, 1 dmg/hit at the
        // base dmgMultiplier, same convention as the wave enemies).
        for (let i = fs.projectiles.length - 1; i >= 0; i--) {
          const pr = fs.projectiles[i];
          pr.x += pr.vx * dt;
          pr.y += pr.vy * dt;
          if (boss.hp > 0 && Math.hypot(boss.x - pr.x, boss.y - pr.y) < flyingModule.BOSS_HIT_RADIUS) {
            boss.hp -= flyingModule.FIRE_DAMAGE * player.dmgMultiplier;
            fs.projectiles.splice(i, 1);
            if (boss.hp <= 0) {
              boss.hp = 0;
              fs.phase = "bossDying";
              fs.bossDiedAt = now;
              fs.enemyProjectiles = []; // the cone-spray attack stops the instant it dies
              io.to(player.id).emit("flying_boss_died", { x: boss.x, y: boss.y });
            }
            continue;
          }
          if (pr.x < -1 || pr.x > flyingModule.ARENA_W + 1 || pr.y < -1 || pr.y > flyingModule.ARENA_H + 1) {
            fs.projectiles.splice(i, 1);
          }
        }

        // Boss cone-spray fireballs vs the player -- same movement/hit/prune
        // logic as the wave phase's enemy fireballs. Guarded on the boss
        // still being alive: a hit in the loop above may have just flipped
        // fs.phase to "bossDying" and cleared fs.enemyProjectiles, in which
        // case this is a clean no-op (nothing left to move or broadcast).
        if (fs.phase === "boss") {
          for (let i = fs.enemyProjectiles.length - 1; i >= 0; i--) {
            const pr = fs.enemyProjectiles[i];
            pr.x += pr.vx * dt;
            pr.y += pr.vy * dt;
            if (Math.hypot(player.x - pr.x, player.y - pr.y) < flyingModule.ENEMY_FIRE_HIT_RADIUS) {
              fs.enemyProjectiles.splice(i, 1);
              player.takeDamage(flyingModule.ENEMY_FIRE_DAMAGE, now);
              io.to(player.id).emit("flying_hit", {});
              continue;
            }
            if (pr.x < -1 || pr.x > flyingModule.ARENA_W + 1 || pr.y < -1 || pr.y > flyingModule.ARENA_H + 1) {
              fs.enemyProjectiles.splice(i, 1);
            }
          }

          io.to(player.id).emit("flying_boss_state", {
            boss: {
              x: Math.round(boss.x * 100) / 100, y: Math.round(boss.y * 100) / 100, hp: boss.hp, maxHp: boss.maxHp,
              // Lets the client draw the actual lethal beam column (boss.x
              // IS the beam's x while sweeping, see above) without needing a
              // separate high-frequency event for it.
              beamSweeping: !!(boss.beam && boss.beam.sweeping),
            },
            projectiles: fs.projectiles.map((pr) => ({ id: pr.id, x: Math.round(pr.x * 100) / 100, y: Math.round(pr.y * 100) / 100 })),
            enemyProjectiles: fs.enemyProjectiles.map((pr) => ({ id: pr.id, x: Math.round(pr.x * 100) / 100, y: Math.round(pr.y * 100) / 100 })),
          });
        }
      } else if (fs.phase === "waves") {
        const elapsed = now - fs.startedAt;
        if (now >= fs.nextSpawnAt) {
          fs.nextSpawnAt = now + flyingModule.spawnIntervalAt(elapsed);
          const ex = flyingModule.PLAYER_PAD + Math.random() * (flyingModule.ARENA_W - flyingModule.PLAYER_PAD * 2);
          fs.enemies.push({
            id: "fe" + fs.nextEnemyId++, x: ex, y: -1,
            hp: flyingModule.ENEMY_HP, maxHp: flyingModule.ENEMY_HP, lastAttackAt: 0,
            nextFireAt: now + flyingModule.randomEnemyFireDelay(),
          });
        }

        for (const e of fs.enemies) {
          const dx = player.x - e.x, dy = player.y - e.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.05) {
            const step = flyingModule.ENEMY_SPEED * dt;
            e.x += (dx / dist) * step;
            e.y += (dy / dist) * step;
          }
          if (dist <= flyingModule.ENEMY_CONTACT_RADIUS && now - e.lastAttackAt >= flyingModule.ENEMY_CONTACT_COOLDOWN_MS) {
            e.lastAttackAt = now;
            player.takeDamage(flyingModule.ENEMY_CONTACT_DAMAGE, now);
            io.to(player.id).emit("flying_hit", { enemyId: e.id });
          }
          // Bullet-hell: each enemy fires an aimed fireball back at the
          // player independently, on its own randomized timer -- aimed at
          // the player's position AT THE MOMENT OF FIRING (dodgeable), same
          // "captured at cast time" convention used by the cavern boss's slam.
          if (now >= e.nextFireAt) {
            e.nextFireAt = now + flyingModule.randomEnemyFireDelay();
            const edx = player.x - e.x, edy = player.y - e.y;
            const edist = Math.hypot(edx, edy) || 1;
            const baseAngle = Math.atan2(edy, edx);
            // "Halfway through the enemy dragons start shooting 2 fireballs
            // that spread out a little bit" -- past the halfway point of the
            // survival timer, fan two shots symmetrically around the same
            // aimed-at-cast-time angle instead of firing just one.
            const pastHalfway = elapsed >= flyingModule.DURATION_MS / 2;
            const angles = pastHalfway
              ? [baseAngle - flyingModule.ENEMY_FIRE_SPREAD_RAD / 2, baseAngle + flyingModule.ENEMY_FIRE_SPREAD_RAD / 2]
              : [baseAngle];
            for (const a of angles) {
              fs.enemyProjectiles.push({
                id: "ep" + fs.nextEnemyProjId++, x: e.x, y: e.y,
                vx: Math.cos(a) * flyingModule.ENEMY_FIRE_SPEED,
                vy: Math.sin(a) * flyingModule.ENEMY_FIRE_SPEED,
              });
            }
          }
        }

        // Player fireballs (mouse-aim, any direction) vs enemies.
        for (let i = fs.projectiles.length - 1; i >= 0; i--) {
          const pr = fs.projectiles[i];
          pr.x += pr.vx * dt;
          pr.y += pr.vy * dt;
          let hitIdx = -1;
          for (let j = 0; j < fs.enemies.length; j++) {
            if (Math.hypot(fs.enemies[j].x - pr.x, fs.enemies[j].y - pr.y) < flyingModule.FIRE_HIT_RADIUS) { hitIdx = j; break; }
          }
          if (hitIdx >= 0) {
            const e = fs.enemies[hitIdx];
            e.hp -= flyingModule.FIRE_DAMAGE * player.dmgMultiplier;
            fs.projectiles.splice(i, 1);
            if (e.hp <= 0) {
              fs.enemies.splice(hitIdx, 1);
              io.to(player.id).emit("flying_enemy_died", { id: e.id, x: e.x, y: e.y });
            }
            continue;
          }
          if (pr.x < -1 || pr.x > flyingModule.ARENA_W + 1 || pr.y < -1 || pr.y > flyingModule.ARENA_H + 1) {
            fs.projectiles.splice(i, 1);
          }
        }

        // Enemy fireballs vs the player.
        for (let i = fs.enemyProjectiles.length - 1; i >= 0; i--) {
          const pr = fs.enemyProjectiles[i];
          pr.x += pr.vx * dt;
          pr.y += pr.vy * dt;
          if (Math.hypot(player.x - pr.x, player.y - pr.y) < flyingModule.ENEMY_FIRE_HIT_RADIUS) {
            fs.enemyProjectiles.splice(i, 1);
            player.takeDamage(flyingModule.ENEMY_FIRE_DAMAGE, now);
            io.to(player.id).emit("flying_hit", {});
            continue;
          }
          if (pr.x < -1 || pr.x > flyingModule.ARENA_W + 1 || pr.y < -1 || pr.y > flyingModule.ARENA_H + 1) {
            fs.enemyProjectiles.splice(i, 1);
          }
        }

        io.to(player.id).emit("flying_state", {
          enemies: fs.enemies.map((e) => ({ id: e.id, x: Math.round(e.x * 100) / 100, y: Math.round(e.y * 100) / 100, hp: e.hp, maxHp: e.maxHp })),
          projectiles: fs.projectiles.map((pr) => ({ id: pr.id, x: Math.round(pr.x * 100) / 100, y: Math.round(pr.y * 100) / 100 })),
          enemyProjectiles: fs.enemyProjectiles.map((pr) => ({ id: pr.id, x: Math.round(pr.x * 100) / 100, y: Math.round(pr.y * 100) / 100 })),
          timeLeftMs: Math.max(0, flyingModule.DURATION_MS - (now - fs.startedAt)),
        });
      }
    }
  }

  // Dragon-death fire hazards: expire old ones, then ignite anyone touching
  // a still-active one (skips players already burning so it can't restack).
  for (let i = fireHazards.length - 1; i >= 0; i--) {
    if (now >= fireHazards[i].expiresAt) {
      const [expired] = fireHazards.splice(i, 1);
      io.emit("fire_expired", { x: expired.x, y: expired.y });
    }
  }
  for (const fire of fireHazards) {
    for (const player of players.values()) {
      if (player.area !== "outside" || player.dead || player.burning) continue;
      if (Math.hypot(player.x - fire.x, player.y - fire.y) < FIRE_HAZARD_RADIUS) {
        player.burning = true;
      }
    }
  }

  // Flaming sword pickup: any live player standing over it in the cave
  // claims it (touch-to-pickup, no keypress needed).
  if (!flamingSword.held) {
    for (const player of players.values()) {
      if (player.area !== "outside" || player.dead) continue;
      if (Math.hypot(player.x - flamingSword.x, player.y - flamingSword.y) < FLAMING_SWORD_PICKUP_RADIUS) {
        flamingSword.held = true;
        flamingSword.holderId = player.id;
        player.hasFlamingSword = true;
        player.recomputeMaxHp();
        player.hp = player.maxHp;
        io.emit("sword_state", swordStatePayload());
        break;
      }
    }
  }

  // Golden bow pickup: same touch-to-pickup pattern; also switches the
  // holder's active weapon to "bow" right away.
  if (!bow.held) {
    for (const player of players.values()) {
      if (player.area !== "outside" || player.dead) continue;
      if (Math.hypot(player.x - bow.x, player.y - bow.y) < BOW_PICKUP_RADIUS) {
        bow.held = true;
        bow.holderId = player.id;
        player.hasBow = true;
        player.activeWeapon = "bow";
        io.emit("bow_state", bowStatePayload());
        break;
      }
    }
  }

  // Cave gate: sealed the whole time a dragon is alive (including after it
  // eventually respawns), open once it's dead.
  const dragonAlive = Array.from(activeMonsters.values()).some((m) => m.type === "dragon");
  setCaveSealed(dragonAlive);

  // Arrow projectiles: advance, then despawn on hitting terrain (a "clunk")
  // or a monster (damage, same sword_hit-style feedback), or after too long
  // in the air with nothing hit.
  for (const [id, a] of projectiles) {
    if (now - a.spawnedAt > ARROW_MAX_LIFETIME_MS) { projectiles.delete(id); continue; }
    const step = ARROW_SPEED_TILES_PER_SEC * dt;
    const nx = a.x + Math.cos(a.angle) * step;
    const ny = a.y + Math.sin(a.angle) * step;

    if (isBlocked("outside", Math.floor(nx), Math.floor(ny))) {
      io.emit("arrow_hit", { x: nx, y: ny, monster: false });
      projectiles.delete(id);
      continue;
    }

    let hit = false;
    for (const m of activeMonsters.values()) {
      if (m.dead) continue;
      if (Math.hypot(m.x - nx, m.y - ny) < ARROW_HIT_RADIUS + (m.hitRadius || 0)) {
        m.hp -= a.dmg;
        m.aggroTarget = a.ownerId;
        io.emit("arrow_hit", { x: nx, y: ny, monster: true });
        if (m.hp <= 0) killMonster(m, now);
        hit = true;
        break;
      }
    }
    if (hit) { projectiles.delete(id); continue; }

    a.x = nx;
    a.y = ny;
  }

  const getPlayer = (id) => {
    const p = players.get(id);
    return p && p.area === "outside" ? p : null;
  };
  const getAllPlayers = () => Array.from(players.values()).filter((p) => p.area === "outside");
  const outsideCanMoveTo = (x, y, excludeId, selfRadius, selfTerrainRadius) =>
    canMoveTo("outside", x, y, excludeId, selfRadius, selfTerrainRadius);
  const onEntityAttack = (m, target, kind, roar) => {
    const dmg = m.type === "dragon" && target.hasFlamingSword ? 1 : m.damage || 1;
    target.takeDamage(dmg, now);
    io.emit("monster_attack", { id: m.id, targetId: target.id, kind: kind || null, roar: !!roar });
  };
  for (const m of activeMonsters.values()) {
    if (m.type === "dragon") {
      dragonModule.updateDragon(m, dt, now, { canMoveTo: outsideCanMoveTo, getAllPlayers, getPlayer, onAttack: onEntityAttack });
    } else {
      monsters.updateMonster(m, dt, now, { canMoveTo: outsideCanMoveTo, getPlayer, onAttack: onEntityAttack });
    }
  }

  // Tavern patrons: purely decorative, no combat/collision against players
  // or each other -- see server/tavernNpcs.js.
  for (const npc of tavernNpcs) {
    tavernNpcModule.updateTavernNpc(npc, dt, now, (x, y) => canStandOnTerrain("tavern", x, y, PLAYER_RADIUS));
  }

  for (let i = respawnQueue.length - 1; i >= 0; i--) {
    if (now >= respawnQueue[i].at) {
      const { type, spotIndex } = respawnQueue[i];
      respawnQueue.splice(i, 1);
      if (type === "dragon") spawnDragon();
      else if (type === "fire_goblin") spawnFireGoblin(spotIndex);
      else spawnMonster(type);
    }
  }

  // --- Cavern depths: goblin/troll AI, their arrow projectiles, respawns --
  // Entirely separate from the outside-world monster/projectile handling
  // above -- see server/cavern.js's header comment for why.
  for (const m of cavernMonsters.values()) {
    if (m.dead) continue;
    if (m.type === "troll") {
      cavernModule.updateTroll(m, dt, now, {
        getPlayersInLOS: (y, tolerance) => cavernPlayersNear(y, tolerance),
        onRangedShot: (troll, target, shotIndex, shotCount) => fireCavernArrowAtPlayer(troll, target, shotIndex, shotCount, now),
      });
    } else if (m.type === "boss_goblin") {
      cavernModule.updateBossGoblin(m, dt, now, {
        getPlayersInCavern: cavernLivePlayers,
        onWindupStart: onCavernBossWindupStart,
        onSlam: (boss, targetX) => onCavernBossSlam(boss, targetX, now),
        onShout: (boss) => onCavernBossShout(boss, now),
        onStomp: (boss) => onCavernBossStomp(boss, now),
      });
    } else if (m.type === "fire_bat") {
      cavernModule.updateFireBat(m, dt, now, {
        getPlayersInCavern: cavernLivePlayers,
        onAttack: (bat, target) => {
          target.takeDamage(bat.damage, now);
          io.emit("cavern_monster_attack", { id: bat.id, targetId: target.id });
        },
      });
      if (m.dead) {
        // A successful dive-hit -- pops like a normal kill, but no XP (it's
        // a hazard, not something you're meant to farm).
        io.emit("cavern_monster_died", { id: m.id, x: m.x, y: m.y, type: m.type });
        cavernMonsters.delete(m.id);
      } else if (m.batState === "flyoff" && (m.x < -3 || m.x > cavernLevel.width + 3 || m.y < -3 || m.y > cavernLevel.groundY + 5)) {
        // Missed and has now left the level bounds -- just vanishes, no fx.
        // The extra `m.y > groundY + 5` bound is needed now that bats swoop
        // all the way down from the ceiling: a miss on a ground-tier player
        // continues straight down past the floor, and with a mostly-vertical
        // dive direction (small dx) it could take a very long time -- or
        // never -- to drift far enough in x to hit the other bounds checks,
        // leaving it falling forever below the visible level otherwise.
        cavernMonsters.delete(m.id);
      }
    } else {
      cavernModule.updateGoblin(m, dt, now, {
        getPlayersOnTier: (tier) => cavernPlayersNear(cavernLevel.tierY[tier], 0.6),
        onAttack: (goblin, target) => {
          target.takeDamage(goblin.damage, now);
          io.emit("cavern_monster_attack", { id: goblin.id, targetId: target.id });
        },
      });
    }
  }

  // Fire bats: random timed spawns anywhere along the non-boss stretch of
  // the cavern, only while at least one player is out there to encounter
  // them (and never inside/near the boss arena -- "except during the boss
  // fight").
  if (now >= nextFireBatSpawnAt) {
    nextFireBatSpawnAt = now + FIRE_BAT_SPAWN_INTERVAL_MIN_MS + Math.random() * (FIRE_BAT_SPAWN_INTERVAL_MAX_MS - FIRE_BAT_SPAWN_INTERVAL_MIN_MS);
    const eligible = cavernLivePlayers().filter((p) => p.x < cavernLevel.bossArenaStart - 6);
    if (eligible.length) {
      const near = eligible[Math.floor(Math.random() * eligible.length)];
      const spawnX = Math.max(2, Math.min(cavernLevel.bossArenaStart - 6, near.x + (Math.random() - 0.5) * 16));
      const bat = cavernModule.spawnFireBat(cavernLevel, spawnX);
      cavernMonsters.set(bat.id, bat);
      io.emit("cavern_monster_spawned", bat.publicState());
    }
  }

  // Ceiling spikes: random spawn (same eligible-player-anchored placement as
  // the fire bats above), then telegraph briefly before falling straight
  // down and instant-killing anyone it sweeps through.
  if (now >= nextSpikeSpawnAt) {
    nextSpikeSpawnAt = now + SPIKE_SPAWN_INTERVAL_MIN_MS + Math.random() * (SPIKE_SPAWN_INTERVAL_MAX_MS - SPIKE_SPAWN_INTERVAL_MIN_MS);
    const eligible = cavernLivePlayers().filter((p) => p.x < cavernLevel.bossArenaStart - 6);
    if (eligible.length) {
      const near = eligible[Math.floor(Math.random() * eligible.length)];
      const spawnX = Math.max(2, Math.min(cavernLevel.bossArenaStart - 6, near.x + (Math.random() - 0.5) * 16));
      const id = "spk" + nextFallingSpikeId++;
      // No separate "spawned" event needed -- the per-tick "cavern_falling_spikes"
      // broadcast below is a full authoritative snapshot (same add/update/remove-
      // by-diff convention the client already uses for cavern_arrows/flyingEnemies),
      // so a brand new spike just appears in the very next tick's broadcast.
      cavernFallingSpikes.set(id, { id, x: spawnX, y: cavernModule.CEILING_Y, telegraphUntil: now + SPIKE_TELEGRAPH_MS });
    }
  }

  for (const [id, spike] of cavernFallingSpikes) {
    if (now < spike.telegraphUntil) continue; // still just a warning shadow, hasn't started falling
    const prevY = spike.y;
    spike.y = Math.min(cavernLevel.groundY, spike.y + SPIKE_FALL_SPEED * dt);

    for (const p of cavernLivePlayers()) {
      if (Math.abs(p.x - spike.x) > SPIKE_HIT_RADIUS_X) continue;
      const playerTop = p.y - SPIKE_PLAYER_HEIGHT;
      // Swept interval check (same shape as the platform-landing check
      // above) so a fast-falling spike can't tunnel through a player
      // between two ticks without registering a hit.
      if (spike.y >= playerTop && prevY <= p.y) {
        p.takeDamage(p.hp + 1, now);
        io.emit("cavern_spike_hit", { id, x: spike.x, y: p.y, targetId: p.id });
        break;
      }
    }

    if (spike.y >= cavernLevel.groundY) {
      cavernFallingSpikes.delete(id);
      io.emit("cavern_spike_landed", { id, x: spike.x, y: cavernLevel.groundY });
    }
  }

  for (const [id, a] of cavernProjectiles) {
    if (now - a.spawnedAt > CAVERN_ARROW_MAX_LIFETIME_MS) { cavernProjectiles.delete(id); continue; }
    const step = CAVERN_ARROW_SPEED_TILES_PER_SEC * dt;
    const nx = a.x + Math.cos(a.angle) * step;
    const ny = a.y + Math.sin(a.angle) * step;

    if (nx < -1 || nx > cavernLevel.width + 1 || ny > cavernLevel.groundY + 3 || ny < -10) {
      cavernProjectiles.delete(id);
      continue;
    }

    let hit = false;
    if (a.firedBy === "player") {
      for (const m of cavernMonsters.values()) {
        if (m.dead) continue;
        const my = m.y - 0.7;
        // Same hitRadius widening as the melee hit-check above -- an arrow
        // grazing any part of the boss's oversized sprite should count, not
        // just a shot landing exactly on his (x,y) point.
        if (Math.hypot(m.x - nx, my - ny) < CAVERN_ARROW_HIT_RADIUS + (m.hitRadius || 0)) {
          m.hp -= a.dmg;
          io.emit("cavern_arrow_hit", { x: nx, y: ny, hitType: "monster", targetId: m.id });
          if (m.hp <= 0) killCavernMonster(m, now);
          hit = true;
          break;
        }
      }
    } else {
      for (const p of players.values()) {
        if (p.area !== "cavern" || p.dead || p.id === a.ownerId) continue;
        const py = p.y - 0.7;
        if (Math.hypot(p.x - nx, py - ny) < CAVERN_ARROW_HIT_RADIUS) {
          p.takeDamage(a.dmg, now);
          // targetId lets the client flash the actual player that was hit
          // (see game.js's cavern_arrow_hit handler) -- previously this was
          // omitted, so an enemy arrow landing on a player applied real
          // damage server-side but produced NO visual feedback at all
          // (no hit-flash, unlike every other damage source in the game),
          // which read to players as "the arrow just passed through and
          // did nothing."
          io.emit("cavern_arrow_hit", { x: nx, y: ny, hitType: "player", targetId: p.id });
          hit = true;
          break;
        }
      }
    }
    if (hit) { cavernProjectiles.delete(id); continue; }

    a.x = nx;
    a.y = ny;
  }

  for (let i = cavernRespawnQueue.length - 1; i >= 0; i--) {
    if (now >= cavernRespawnQueue[i].at) {
      const { spec } = cavernRespawnQueue[i];
      cavernRespawnQueue.splice(i, 1);
      const nm = new cavernModule.CavernMonster(spec.type, spec.x, spec.y, spec.tier, spec.x0, spec.x1);
      cavernMonsters.set(nm.id, nm);
      io.emit("cavern_monster_spawned", nm.publicState());
    }
  }

  if (players.size > 0) {
    io.emit("state", Array.from(players.values()).map((p) => p.publicState()));
    io.emit("monsters", Array.from(activeMonsters.values()).map((m) => m.publicState()));
    io.emit("tavern_npcs", tavernNpcs.map((n) => n.publicState()));
    if (projectiles.size > 0) {
      io.emit("arrows", Array.from(projectiles.values()).map((a) => ({
        id: a.id,
        x: Math.round(a.x * 100) / 100,
        y: Math.round(a.y * 100) / 100,
        angle: a.angle,
      })));
    }
    io.emit("cavern_monsters", Array.from(cavernMonsters.values()).map((m) => m.publicState()));
    if (cavernProjectiles.size > 0) {
      io.emit("cavern_arrows", Array.from(cavernProjectiles.values()).map((a) => ({
        id: a.id,
        x: Math.round(a.x * 100) / 100,
        y: Math.round(a.y * 100) / 100,
        angle: a.angle,
      })));
    }
    if (cavernFallingSpikes.size > 0) {
      io.emit("cavern_falling_spikes", Array.from(cavernFallingSpikes.values()).map((s) => ({
        id: s.id,
        x: Math.round(s.x * 100) / 100,
        y: Math.round(s.y * 100) / 100,
        telegraphing: Date.now() < s.telegraphUntil,
      })));
    }
  }
}, TICK_MS);

// Guarded so this file can be `require()`d (e.g. from a test script) without
// binding the port a second time -- `npm start` runs it directly, where
// require.main === module still holds, so production behavior is unchanged.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Pixel Realm server listening on port ${PORT}`);
  });
}

// Exported for tools/cavern_*_test.js only -- lets those tests exercise the
// real door-transition/seal-toggle code paths directly (in-process, no
// socket connection or live dragon kill needed) rather than a hand-copied
// reimplementation. Doesn't change production behavior at all.
module.exports = {
  Player, cavernLevel, world, checkAreaTransition, setCaveSealed, enterCavern, exitCavern,
  // Exposed for tools/dash_test.js -- lets it compute an exact expected
  // travel distance/duration for the dash rather than hardcoding a
  // recomputed copy of these constants that could silently drift out of
  // sync with the real ones.
  DASH_DURATION_MS, DASH_COOLDOWN_MS, DASH_DISTANCE_TILES, DASH_SPEED_MULT,
  // Exposed for tools/cavern_boss_test.js -- exercises the real boss
  // kill/door-gating code path rather than a hand-copied reimplementation.
  cavernMonsters, killCavernMonster,
  // Exposed for tools/cliff_flying_test.js -- same "exercise the real code
  // path" approach.
  cliffLevel, enterCliff, exitCliff, enterFlying, exitFlyingToTavern,
  // Exposed for tools/tavern_npc_test.js. startTavernParty is exposed so the
  // test can trigger the one-way latch directly (rather than driving a full
  // flying-minigame completion), and isTavernPartyStarted lets it assert the
  // pre-trigger empty-bar state.
  tavern, tavernNpcs, tavernPatrons, tavernDancer,
  startTavernParty, isTavernPartyStarted: () => tavernPartyStarted,
  // Exposed for a quick unit check of the west side-door one-way latch --
  // exercises the real killMonster() code path rather than reimplementing it.
  activeMonsters, killMonster, isCaveSideDoorOpened: () => caveSideDoorOpened,
  isCaveBackDoorOpened: () => caveBackDoorOpened,
  // Exposed for tools/flying_redo_test.js -- lets it drive a real
  // socket-joined player straight into the real enterFlying() code path
  // in-process, then inspect the live player.flying state after emitting
  // real "fly_shoot" socket events, rather than reimplementing any of it.
  // `server` (the underlying http.Server, listen() not yet called since
  // require.main !== module here) lets such a test bind its OWN port
  // in-process, so the socket client and the player-state inspection are
  // both talking to the same in-memory instance -- required, since two
  // separate `node` processes never share the same `players` Map.
  players,
  server,
  // Exposed for tools/cavern_falling_spike_test.js -- lets it inspect/drive
  // the real falling-spike hazard state (cavernFallingSpikes) and cavern
  // monster respawn timing (CAVERN_MONSTER_RESPAWN_MS) directly.
  cavernFallingSpikes, CAVERN_MONSTER_RESPAWN_MS,
  // Exposed for tools/goblin_king_test.js -- lets it inject a cavern arrow
  // at an exact point (widened hitRadius check) and call the real
  // slam-resolution function directly to verify the 25%-of-maxHp club
  // damage formula, rather than reimplementing either.
  cavernProjectiles, onCavernBossSlamForTest: onCavernBossSlam,
};
