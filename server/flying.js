// The post-boss "flying shooter" minigame: reached by touching one of the 2
// dragon NPCs on the cliff (see server/cliff.js). Deliberately a PERSONAL,
// per-player instance rather than a shared world zone (like the outside
// world/cavern are) -- each player who enters gets their own timer, their
// own enemy wave, their own fire-breath projectiles, and only that player's
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

const ARENA_W = 16; // tile units
const ARENA_H = 10;
const PLAYER_PAD = 0.7; // keeps the player's dragon fully on screen

// "About the same length as the scroller level" -- the cavern is a
// traversal-length level (350 tiles), which doesn't map onto a fixed-arena
// shmup directly, so this is a documented assumption: a fixed play duration
// in the same ballpark as how long a full cavern run takes.
const DURATION_MS = 75000;

const ENEMY_SPAWN_INTERVAL_MS = 1400;
const ENEMY_SPEED = 2.2; // tiles/sec, homes toward the player
const ENEMY_HP = 3; // 2-3 fire-breath hits to kill, per the request
const ENEMY_CONTACT_DAMAGE = 1;
const ENEMY_CONTACT_COOLDOWN_MS = 900;
const ENEMY_CONTACT_RADIUS = 0.9;

const FIRE_SPEED = 9; // tiles/sec, straight up
const FIRE_DAMAGE = 1;
const FIRE_COOLDOWN_MS = 260;
const FIRE_HIT_RADIUS = 0.6;

function newFlyingState(now) {
  return {
    startedAt: now,
    enemies: [], // [{id,x,y,hp,maxHp,lastAttackAt}]
    projectiles: [], // [{id,x,y}]
    nextEnemyId: 1,
    nextProjId: 1,
    nextSpawnAt: now + 900,
    lastFireAt: 0,
  };
}

module.exports = {
  ARENA_W,
  ARENA_H,
  PLAYER_PAD,
  DURATION_MS,
  ENEMY_SPAWN_INTERVAL_MS,
  ENEMY_SPEED,
  ENEMY_HP,
  ENEMY_CONTACT_DAMAGE,
  ENEMY_CONTACT_COOLDOWN_MS,
  ENEMY_CONTACT_RADIUS,
  FIRE_SPEED,
  FIRE_DAMAGE,
  FIRE_COOLDOWN_MS,
  FIRE_HIT_RADIUS,
  newFlyingState,
};
