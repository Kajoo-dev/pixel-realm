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
// halves every level (10% at L1, 5% at L2, 2.5% at L3, ...), and each level
// grants +10 max HP and a further x1.2 multiplier on outgoing damage
// (melee and arrows alike). ---------------------------------------------
const LEVEL_XP_PER_KILL_BASE = 0.10;
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
const CAVERN_MONSTER_RESPAWN_MS = 15000;

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

// Where a player who DIES respawns -- the graveyard area just outside the
// tavern (see world.graveyard in map.js), NOT the plaza spawn new players
// join at. Same open-spot search as findOpenSpawn, just anchored on the
// graveyard's own point instead of a map's generic `spawn`.
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
    // Personal flying-minigame instance state (enemies/projectiles/timer),
    // or null outside the "flying" area -- see server/flying.js.
    this.flying = null;
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

  applyInput(dt) {
    if (this.dead) { this.moving = false; return; }
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
    if (!landed && ny >= cavernLevel.groundY) {
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
// The west-side cave door is a ONE-WAY latch, unlike the other two doors:
// once the dragon first dies it opens and STAYS open forever, even once a
// fresh dragon respawns and reseals the main/back doors again. Set true in
// killMonster() below, the moment a dragon dies, and never reset.
let caveSideDoorOpened = false;

function setCaveSealed(sealed) {
  if (sealed === caveSealed) return;
  caveSealed = sealed;
  for (const t of world.caveEntranceTiles) world.collision[t.y][t.x] = sealed ? 1 : 0;
  // The back door (into the cavern depths side-scroller) opens/seals in
  // lockstep with the main entrance -- same dragon-alive/dead condition,
  // no separate seal state to track.
  world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] = sealed ? 1 : 0;
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
    targetX: kind === "slam" ? targetX : undefined,
    windupMs: kind === "slam" ? cavernModule.BOSS_SLAM_WINDUP_MS : cavernModule.BOSS_SHOUT_WINDUP_MS,
  });
  if (Math.random() < BOSS_TAUNT_CHANCE) {
    const text = BOSS_TAUNT_LINES[Math.floor(Math.random() * BOSS_TAUNT_LINES.length)];
    io.emit("cavern_boss_taunt", { id: boss.id, text });
  }
}

function onCavernBossSlam(boss, targetX, now) {
  const hitPlayerIds = [];
  for (const p of players.values()) {
    if (p.area !== "cavern" || p.dead) continue;
    if (Math.abs(p.x - targetX) <= cavernModule.BOSS_SLAM_RADIUS) {
      p.takeDamage(cavernModule.BOSS_SLAM_DAMAGE, now);
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
  if (!caveSealed) {
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
        caveTreasure: world.caveTreasure,
        graveyardHeadstones: world.graveyard.headstones,
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

  // Mouse click in the flying minigame: shoot a fireball from the player's
  // dragon toward the clicked screen point (see the client's mousedown
  // handler, which converts screen coords to an arena-relative angle and
  // emits this while myArea === "flying"). Space bar still works too, as a
  // straight-up fallback (angle omitted).
  socket.on("fly_shoot", (info) => {
    const player = players.get(socket.id);
    if (!player || player.dead || player.area !== "flying" || !player.flying) return;
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
        if (dist > PLAYER_ATTACK_RANGE) continue;
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
    else player.applyInput(dt);
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
      // Respawn always lands the player back in the outside world, even if
      // they died in the cavern depths -- simplest, and matches how dying to
      // the dragon/monsters already worked. Specifically, it's the graveyard
      // area just outside the tavern, not the plaza spawn.
      player.area = "outside";
      const spawn = findOpenGraveyardSpawn();
      player.x = spawn.x;
      player.y = spawn.y;
      player.hp = player.maxHp;
      player.dead = false;
      player.burning = false;
      player.flying = null;
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
      if (now - fs.startedAt >= flyingModule.DURATION_MS) {
        exitFlyingToTavern(player, now);
      } else {
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
            fs.enemyProjectiles.push({
              id: "ep" + fs.nextEnemyProjId++, x: e.x, y: e.y,
              vx: (edx / edist) * flyingModule.ENEMY_FIRE_SPEED,
              vy: (edy / edist) * flyingModule.ENEMY_FIRE_SPEED,
            });
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
      } else if (m.batState === "flyoff" && (m.x < -3 || m.x > cavernLevel.width + 3 || m.y < -3)) {
        // Missed and has now left the level bounds -- just vanishes, no fx.
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
        if (Math.hypot(m.x - nx, my - ny) < CAVERN_ARROW_HIT_RADIUS) {
          m.hp -= a.dmg;
          io.emit("cavern_arrow_hit", { x: nx, y: ny, hitType: "monster" });
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
          io.emit("cavern_arrow_hit", { x: nx, y: ny, hitType: "player" });
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
};
