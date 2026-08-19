const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { generateMap, generateTavernMap, TILE_IDS } = require("./map");
const monsters = require("./monsters");
const dragonModule = require("./dragon");
const cavernModule = require("./cavern");

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

const world = generateMap(60, 42, 1337);
const tavern = generateTavernMap();
const cavernLevel = cavernModule.generateCavernLevel();

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
  }

  // Base max HP is 50 while holding the flaming sword, 10 otherwise; each
  // level then adds a further flat +10 on top of whichever base applies.
  recomputeMaxHp() {
    const base = this.hasFlamingSword ? FLAMING_SWORD_MAX_HP : PLAYER_MAX_HP;
    this.maxHp = base + LEVEL_HP_BONUS * (this.level - 1);
    if (this.hp > this.maxHp) this.hp = this.maxHp;
  }

  grantXp(now) {
    const gain = LEVEL_XP_PER_KILL_BASE / Math.pow(2, this.level - 1);
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
    const { left, right, down } = this.input;
    this.crouching = !!down;
    const dx = (right ? 1 : 0) - (left ? 1 : 0);
    this.moving = dx !== 0;
    if (dx !== 0) this.dir = dx > 0 ? "right" : "left";

    this.x = Math.max(0.5, Math.min(cavernLevel.width - 0.5, this.x + dx * CAVERN_HSPEED * dt));

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

function grantCavernKillXpNearby(x, y, now) {
  for (const p of players.values()) {
    if (p.area !== "cavern" || p.dead) continue;
    if (Math.hypot(p.x - x, p.y - y) <= XP_SHARE_RADIUS) p.grantXp(now);
  }
}

function killCavernMonster(m, now) {
  m.dead = true;
  io.emit("cavern_monster_died", { id: m.id, x: m.x, y: m.y, type: m.type });
  cavernMonsters.delete(m.id);
  cavernRespawnQueue.push({
    spec: { type: m.type, x: m.x, y: m.y, tier: m.tier, x0: m.x0, x1: m.x1 },
    at: now + CAVERN_MONSTER_RESPAWN_MS,
  });
  grantCavernKillXpNearby(m.x, m.y, now);
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

function checkAreaTransition(player) {
  if (player.dead) return;
  if (player.area === "tavern") {
    if (player.y >= tavern.height - TAVERN_EXIT_TRIGGER_ZONE_TILES) {
      player.area = "outside";
      player.x = world.tavernOutsideSpawn.x;
      player.y = world.tavernOutsideSpawn.y;
    }
    return;
  }
  if (player.area === "cavern") {
    if (player.x <= cavernLevel.exitZoneX) exitCavern(player);
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

for (const m of monsters.spawnInitialMonsters(world, canMoveToAvoidingCave, MONSTER_COUNT)) {
  activeMonsters.set(m.id, m);
}

const initialDragon = new dragonModule.Dragon(world.caveEntrance.x, world.caveEntrance.y + DRAGON_SPAWN_Y_OFFSET, SPEED_TILES_PER_SEC);
activeMonsters.set(initialDragon.id, initialDragon);

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
        },
        swordState: swordStatePayload(),
        bowState: bowStatePayload(),
        caveEntranceTiles: world.caveEntranceTiles,
        caveSealed,
        caveTreasure: world.caveTreasure,
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
    if (player.crouching && player.groundedTier > 0) {
      player.dropThroughUntil = now + CAVERN_DROP_THROUGH_MS;
      player.vy = CAVERN_DROP_NUDGE_VY;
    } else {
      player.vy = CAVERN_JUMP_VELOCITY;
    }
    player.grounded = false;
    player.groundedTier = null;
  });

  socket.on("attack", (payload) => {
    const player = players.get(socket.id);
    if (!player || player.dead) return;
    const now = Date.now();
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
        m.hp -= player.dmgMultiplier;
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

      m.hp -= player.dmgMultiplier;
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
      // the dragon/monsters already worked.
      player.area = "outside";
      const spawn = findOpenSpawn(player.area);
      player.x = spawn.x;
      player.y = spawn.y;
      player.hp = player.maxHp;
      player.dead = false;
      player.burning = false;
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

  for (let i = respawnQueue.length - 1; i >= 0; i--) {
    if (now >= respawnQueue[i].at) {
      const { type } = respawnQueue[i];
      respawnQueue.splice(i, 1);
      if (type === "dragon") spawnDragon();
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
module.exports = { Player, cavernLevel, world, checkAreaTransition, setCaveSealed, enterCavern, exitCavern };
