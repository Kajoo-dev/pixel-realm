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
// "Halfway through the enemy dragons start shooting 2 fireballs that spread
// out a little bit" -- once elapsed >= DURATION_MS/2, each enemy's regular
// aimed shot becomes a pair of shots fanned symmetrically around the same
// aimed-at-cast-time angle instead of a single line, still on the same
// per-enemy randomized fire timer (see the "waves" phase tick in index.js).
const ENEMY_FIRE_SPREAD_RAD = Math.PI / 14; // ~13 degrees between the two shots -- "a little bit"

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

// --- Giant dragon boss finale ---------------------------------------------
// "At the end of the dragon flight encounter make all the dragons on the
// map disappear then have a giant dragon appear and start shooting 10
// fireballs at a time in a cone spray at the player. The player must shoot
// the giant dragon 50 times to kill it. When it dies make it explode with
// fire and smoke then make the player dragon woosh off the screen then
// transition to the tavern for the party." This runs as a distinct phase
// after the wave-survival timer (DURATION_MS) elapses -- see newBossState
// and the tick loop's fs.phase state machine in index.js ("waves" ->
// "boss" -> "bossDying" -> "woosh" -> exitFlyingToTavern).
const BOSS_MAX_HP = 50; // "shoot it 50 times" -- 1 hit = FIRE_DAMAGE(1) * dmgMultiplier, same convention as ENEMY_HP
const BOSS_APPEAR_GRACE_MS = 1800; // telegraph beat before it opens fire, so "dragons vanish, giant appears" reads clearly
const BOSS_CONE_COUNT = 10;
const BOSS_CONE_SPREAD_RAD = Math.PI / 2.4; // ~75 degrees -- wide enough to force real dodging, not a single dodgeable line
const BOSS_FIRE_INTERVAL_MIN_MS = 2000;
const BOSS_FIRE_INTERVAL_MAX_MS = 2800;
const BOSS_FIRE_SPEED = 5.5;
const BOSS_CONTACT_DAMAGE = ENEMY_CONTACT_DAMAGE * 2;
const BOSS_CONTACT_RADIUS = 2.0;
const BOSS_HIT_RADIUS = 1.5; // giant hitbox for the player's own fireballs (vs FIRE_HIT_RADIUS for normal enemies)
const BOSS_DRIFT_RANGE = ARENA_W * 0.3; // slow side-to-side hover, purely a function of elapsed time (see index.js)
const BOSS_DRIFT_PERIOD_S = 5.5;
const BOSS_Y = 1.7;
// "Add a little bit more of a pause before the dragon dies before the
// player whooshes away, so that there's time to read the chat bubble" --
// was 1800; the "We did it!" speech bubble is shown for this entire beat
// (plus the woosh, see FLYING_BOSS_DEATH_FX_MS/flyingVictoryBubbleUntil in
// public/js/game.js), so lengthening it directly buys more reading time.
const BOSS_DEATH_FX_MS = 3200; // fire/smoke explosion beat before the woosh-off starts
const BOSS_WOOSH_MS = 1300; // player dragon flies off screen before cutting to the tavern

// --- Boss fire-beam sweep (new attack) --------------------------------------
// "Add a new attack for the boss at the end of the dragon flight, make him
// do a fire beam in a straight line that moves with him as he strafes left
// and right, he can only make one pass to the left or right while the beam
// is active though, the player needs to stay ahead of it to avoid it."
// Independent cooldown from the cone-spray attack -- never both active at
// once (see the tick loop in index.js, which suppresses the cone trigger
// and the normal drift-hover while a beam exists). A beam picks ONE
// direction at trigger time and sweeps across the full arena width exactly
// once, then turns off; the boss's own x is driven by the sweep the whole
// time, so he visibly strafes alongside his own beam.
// "Fires off more often but only shoots across 75% of the screen so that
// the player can still get away from it" -- interval roughly halved from
// the original 6.5-9.5s, and the sweep now travels only
// BOSS_BEAM_SWEEP_FRACTION of the full arena width from its starting edge
// instead of all the way to the far edge, leaving a guaranteed-safe strip
// on the far side for the player to run to (see the sweep-distance/endX
// logic in index.js's tick loop).
const BOSS_BEAM_INTERVAL_MIN_MS = 3200;
const BOSS_BEAM_INTERVAL_MAX_MS = 4800;
const BOSS_BEAM_TELEGRAPH_MS = 900; // warning beat at the starting edge before the sweep actually begins
const BOSS_BEAM_STRAFE_SPEED = 3.0; // tiles/sec -- deliberately slower than the player's own ~5 tiles/sec move speed, so outrunning it is achievable
const BOSS_BEAM_WIDTH = 1.0; // tiles -- half-width of the lethal beam column
const BOSS_BEAM_SWEEP_FRACTION = 0.75; // only covers 75% of the arena width per pass
const BOSS_BEAM_DAMAGE = ENEMY_CONTACT_DAMAGE * 2; // a full-arena hazard should sting more than a single contact hit

function randomBossFireDelay() {
  return BOSS_FIRE_INTERVAL_MIN_MS + Math.random() * (BOSS_FIRE_INTERVAL_MAX_MS - BOSS_FIRE_INTERVAL_MIN_MS);
}

function randomBossBeamDelay() {
  return BOSS_BEAM_INTERVAL_MIN_MS + Math.random() * (BOSS_BEAM_INTERVAL_MAX_MS - BOSS_BEAM_INTERVAL_MIN_MS);
}

function newBossState(now) {
  return {
    x: ARENA_W / 2,
    y: BOSS_Y,
    hp: BOSS_MAX_HP,
    maxHp: BOSS_MAX_HP,
    spawnedAt: now,
    nextFireAt: now + BOSS_APPEAR_GRACE_MS,
    lastContactAt: 0,
    // Delayed past the cone-spray's own opening grace beat so the two
    // telegraphs don't both land on the player in the first couple seconds.
    nextBeamAt: now + BOSS_APPEAR_GRACE_MS + randomBossBeamDelay(),
    beam: null, // {dir, telegraphUntil, sweeping, lastHitAt} while an attack is in progress
  };
}

function newFlyingState(now) {
  return {
    startedAt: now,
    phase: "waves", // "waves" -> "boss" -> "bossDying" -> "woosh" (see the tick loop in index.js)
    enemies: [], // [{id,x,y,hp,maxHp,lastAttackAt,nextFireAt}]
    projectiles: [], // player fireballs: [{id,x,y,vx,vy}]
    enemyProjectiles: [], // enemy fireballs (waves) / boss cone-spray fireballs (boss phase): [{id,x,y,vx,vy}]
    nextEnemyId: 1,
    nextProjId: 1,
    nextEnemyProjId: 1,
    nextSpawnAt: now + 1200,
    lastFireAt: 0,
    boss: null, // set on entering "boss" phase -- see newBossState
    bossDiedAt: 0,
    wooshStartAt: 0,
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
  ENEMY_FIRE_SPREAD_RAD,
  FIRE_SPEED,
  FIRE_DAMAGE,
  FIRE_COOLDOWN_MS,
  FIRE_HIT_RADIUS,
  spawnIntervalAt,
  randomEnemyFireDelay,
  newFlyingState,
  BOSS_MAX_HP,
  BOSS_APPEAR_GRACE_MS,
  BOSS_CONE_COUNT,
  BOSS_CONE_SPREAD_RAD,
  BOSS_FIRE_INTERVAL_MIN_MS,
  BOSS_FIRE_INTERVAL_MAX_MS,
  BOSS_FIRE_SPEED,
  BOSS_CONTACT_DAMAGE,
  BOSS_CONTACT_RADIUS,
  BOSS_HIT_RADIUS,
  BOSS_DRIFT_RANGE,
  BOSS_DRIFT_PERIOD_S,
  BOSS_Y,
  BOSS_DEATH_FX_MS,
  BOSS_WOOSH_MS,
  randomBossFireDelay,
  newBossState,
  BOSS_BEAM_INTERVAL_MIN_MS,
  BOSS_BEAM_INTERVAL_MAX_MS,
  BOSS_BEAM_TELEGRAPH_MS,
  BOSS_BEAM_STRAFE_SPEED,
  BOSS_BEAM_WIDTH,
  BOSS_BEAM_SWEEP_FRACTION,
  BOSS_BEAM_DAMAGE,
  randomBossBeamDelay,
};
