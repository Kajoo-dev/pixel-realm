// The post-boss "flying shooter" minigame: reached by touching one of the 2
// dragon NPCs on the cliff (see server/cliff.js). Deliberately a PERSONAL,
// per-player instance rather than a shared world zone (like the outside
// world/cavern are) -- each player who enters gets their own timer, their
// own enemy wave, their own fireball projectiles, and only that player's
// socket receives updates for it (see index.js's tick loop and the
// "flying_state"/"flying_*" events) -- simplest correct behavior for what's
// really a personal arcade minigame bolted onto a multiplayer world, and it
// avoids the awkwardness of players entering the same shared timer/wave at
// different moments.
//
// Coordinate convention: a small FIXED arena in tile units (NOT a scrolling
// world) -- the player's dragon stays within the arena bounds, enemies
// spawn off the top edge and home in on the player, classic vertical shmup
// style. Player.x/y (see index.js) are reused directly as the arena
// position while area === "flying", same as every other area.
//
// This is the "redo" version: mouse-aim fireballs (any direction, not just
// straight up), a progressive spawn ramp (slow start, fast finish), and a
// genuine bullet-hell layer where every enemy dragon also fires aimed
// fireballs back at the player.

const ARENA_W = 16; // tile units
const ARENA_H = 10;
const PLAYER_PAD = 0.7; // keeps the player's dragon fully on screen

// "About the same length as the scroller level" -- the cavern is a
// traversal-length level (350 tiles), which doesn't map onto a fixed-arena
// shmup directly, so this is a documented assumption: a fixed play duration
// in the same ballpark as how long a full cavern run takes.
const DURATION_MS = 75000;

// Spawn ramp: "spawn slowly at first then progressively faster until the
// end" -- linearly interpolated by elapsed/DURATION_MS (see spawnIntervalAt
// below), not a flat interval.
const ENEMY_SPAWN_INTERVAL_START_MS = 2600;
const ENEMY_SPAWN_INTERVAL_END_MS = 450;
const ENEMY_SPEED = 2.2; // tiles/sec, homes toward the player
const ENEMY_HP = 3; // 2-3 fireball hits to kill, per the request
// "5x more damage if they hit the player" -- was 1, now 5. Applies to both
// a direct collision AND getting hit by one of the enemy's own fireballs
// (see ENEMY_FIRE_DAMAGE below), so either way of getting hit reads as
// equally dangerous.
const ENEMY_CONTACT_DAMAGE = 5;
const ENEMY_CONTACT_COOLDOWN_MS = 900;
const ENEMY_CONTACT_RADIUS = 0.9;

// Enemy fireballs: "the enemy dragons need to be shooting fireballs too,
// fairly quickly, this is a bullet storm type game" -- each enemy fires
// independently on its own randomized timer, aimed at the player's position
// at the moment it fires (so it's dodgeable, same "captured at cast time"
// convention as the cavern boss's slam).
const ENEMY_FIRE_INTERVAL_MIN_MS = 900;
const ENEMY_FIRE_INTERVAL_MAX_MS = 1700;
const ENEMY_FIRE_SPEED = 6; // tiles/sec
const ENEMY_FIRE_DAMAGE = ENEMY_CONTACT_DAMAGE;
const ENEMY_FIRE_HIT_RADIUS = 0.55;

// Player fireballs: mouse-aim, any direction (was fixed straight-up).
const FIRE_SPEED = 9; // tiles/sec
const FIRE_DAMAGE = 1;
const FIRE_COOLDOWN_MS = 260;
const FIRE_HIT_RADIUS = 0.6;

// Linearly ramps the spawn interval down from START to END across the
// minigame's duration -- clamped so a stray elapsed value past DURATION_MS
// (the tick loop checks the exit condition separately) never goes negative.
function spawnIntervalAt(elapsedMs) {
  const frac = Math.max(0, Math.min(1, elapsedMs / DURATION_MS));
  return ENEMY_SPAWN_INTERVAL_START_MS + (ENEMY_SPAWN_INTERVAL_END_MS - ENEMY_SPAWN_INTERVAL_START_MS) * frac;
}

function randomEnemyFireDelay() {
  return ENEMY_FIRE_INTERVAL_MIN_MS + Math.random() * (ENEMY_FIRE_INTERVAL_MAX_MS - ENEMY_FIRE_INTERVAL_MIN_MS);
}

function newFlyingState(now) {
  return {
    startedAt: now,
    enemies: [], // [{id,x,y,hp,maxHp,lastAttackAt,nextFireAt}]
    projectiles: [], // player fireballs: [{id,x,y,vx,vy}]
    enemyProjectiles: [], // enemy fireballs: [{id,x,y,vx,vy}]
    nextEnemyId: 1,
    nextProjId: 1,
    nextEnemyProjId: 1,
    nextSpawnAt: now + 1200,
    lastFireAt: 0,
  };
}

module.exports = {
  ARENA_W,
  ARENA_H,
  PLAYER_PAD,
  DURATION_MS,
  ENEMY_SPAWN_INTERVAL_START_MS,
  ENEMY_SPAWN_INTERVAL_END_MS,
  ENEMY_SPEED,
  ENEMY_HP,
  ENEMY_CONTACT_DAMAGE,
  ENEMY_CONTACT_COOLDOWN_MS,
  ENEMY_CONTACT_RADIUS,
  ENEMY_FIRE_INTERVAL_MIN_MS,
  ENEMY_FIRE_INTERVAL_MAX_MS,
  ENEMY_FIRE_SPEED,
  ENEMY_FIRE_DAMAGE,
  ENEMY_FIRE_HIT_RADIUS,
  FIRE_SPEED,
  FIRE_DAMAGE,
  FIRE_COOLDOWN_MS,
  FIRE_HIT_RADIUS,
  spawnIntervalAt,
  randomEnemyFireDelay,
  newFlyingState,
};
