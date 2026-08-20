// The "cavern depths" side-scrolling level, reached through a second door
// carved into the back (north wall) of the dragon's cave once the dragon is
// dead. Deliberately a SEPARATE, parallel system from the outside-world
// map/monsters/projectiles in map.js/monsters.js/index.js -- new file, new
// entity classes, new event names -- so none of the already-tested overworld
// combat code is touched or put at risk.
//
// Physics/level-geometry convention: 1 unit = 1 "tile", matching the rest of
// the game. Unlike the top-down outside/tavern maps, (x, y) for an entity in
// the cavern is its FOOT position (bottom-center), the standard platformer
// convention -- y increases downward, as everywhere else in this codebase.
// There are exactly three horizontal "tiers" a player can stand on: a solid
// ground floor (blocks from every direction, like normal terrain) and two
// one-way platform tiers above it (jump up through them from below, land on
// top, drop back down through them by holding S + pressing space). Tier
// spacing was chosen and numerically validated (via a discrete 20Hz Euler
// simulation matching the server's real tick integration, not textbook
// continuous-time kinematics) against CAVERN_JUMP_VELOCITY/CAVERN_GRAVITY in
// index.js so every gap is comfortably jumpable with margin to spare.

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVEL_WIDTH = 350; // tiles -- 5x the original 70, per the boss-fight expansion
const GROUND_Y = 20; // solid floor's walkable surface y
const TIER_SPACING = 1.8; // vertical gap between tiers -- keep <= ~2.0 (see index.js physics constants)
const TIER_Y = [GROUND_Y, GROUND_Y - TIER_SPACING, GROUND_Y - TIER_SPACING * 2]; // [ground, mid, top]
const MAX_SAME_TIER_GAP = 3.0; // tiles -- stays under the ~4-tile full-arc jump distance with margin
// The last stretch of the level is reserved as an open, platform-free boss
// arena (regular goblins/trolls only spawn before this point) -- flat
// ground only, so the giant boss's telegraphed slam/shout attacks have
// clean, readable space to play out in.
const BOSS_ARENA_LEN = 34;
const BOSS_ARENA_START = LEVEL_WIDTH - BOSS_ARENA_LEN;
// How far below the ground line a player must fall inside a pit before
// hitting the spikes at the bottom and dying -- see index.js's
// applyCavernInput. A few tiles gives a believable "you fell in" beat
// (visible mid-air over the pit for a moment) without dragging it out.
const PIT_KILL_DEPTH = 4;

// True if `x` (a player's center foot position) is currently over one of
// the level's spike pits -- shared by index.js's ground-collision check
// (no ground support here) and its pit-fall death check.
function isOverPit(level, x) {
  return (level.pits || []).some((p) => x > p.x0 && x < p.x1);
}

// The cave's ceiling -- "about 10 tiles high" above the ground. Purely a
// geometry constant (there's no actual collision up here -- a player's max
// jump apex is only ~2.4 tiles, nowhere near reaching it); it exists as the
// visual roof the client renders AND the spawn height falling spikes drop
// from (see index.js's tick loop -- a real-time hazard, spawned/moved with
// Math.random() same as the fire bats, not part of this deterministic
// per-seed level layout).
const CEILING_Y = GROUND_Y - 10;

function generateCavernLevel(seed = 4242) {
  const rand = mulberry32(seed);
  const platforms = []; // one-way platforms only -- the ground floor is handled separately as solid terrain
  const monsterSpawns = [];

  // Tiers 1 (mid) and 2 (top): procedurally chop the level width into
  // alternating platform segments and gaps, offset from each other so the
  // two tiers don't line up into one boring flat strip. Stops short of the
  // boss arena (see BOSS_ARENA_START above).
  for (let tier = 1; tier <= 2; tier++) {
    const y = TIER_Y[tier];
    let x = 3 + (tier === 2 ? 4 : 0); // stagger the starting offset between tiers
    let seg = 0;
    while (x < BOSS_ARENA_START - 3) {
      const segLen = 4 + rand() * 5; // 4..9 tiles
      const x0 = x;
      const x1 = Math.min(BOSS_ARENA_START - 2, x + segLen);
      platforms.push({ x0, x1, y, tier });
      seg += 1;
      const gap = 2 + rand() * (MAX_SAME_TIER_GAP - 2);
      x = x1 + gap;
    }
  }

  // Monsters: alternate goblins (melee, patrol a platform or the ground) and
  // trolls (ranged, perch on an elevated platform and shoot arrows down/
  // across at anyone in range), spread out along the level so the player
  // keeps encountering fresh threats as they scroll right. Skip anything too
  // close to the entrance so the player isn't ambushed the instant they walk
  // through the door, and stop before the boss arena.
  let mi = 0;
  for (let x = 12; x < BOSS_ARENA_START - 6; x += 7 + rand() * 4) {
    const useTroll = mi % 2 === 1;
    if (useTroll) {
      // Perch trolls on whichever platform tier actually has a segment near
      // this x; fall back to the ground if neither elevated tier does.
      const candidates = platforms.filter((p) => p.tier >= 1 && x >= p.x0 + 0.5 && x <= p.x1 - 0.5);
      const plat = candidates[Math.floor(rand() * candidates.length)];
      if (plat) {
        monsterSpawns.push({ type: "troll", x, y: plat.y, tier: plat.tier, x0: plat.x0, x1: plat.x1 });
      } else {
        monsterSpawns.push({ type: "troll", x, y: GROUND_Y, tier: 0, x0: Math.max(3, x - 4), x1: Math.min(LEVEL_WIDTH - 3, x + 4) });
      }
    } else {
      const candidates = platforms.filter((p) => x >= p.x0 + 0.5 && x <= p.x1 - 0.5);
      const plat = candidates[Math.floor(rand() * candidates.length)];
      if (plat && rand() < 0.5) {
        monsterSpawns.push({ type: "goblin", x, y: plat.y, tier: plat.tier, x0: plat.x0, x1: plat.x1 });
      } else {
        monsterSpawns.push({ type: "goblin", x, y: GROUND_Y, tier: 0, x0: Math.max(3, x - 4), x1: Math.min(LEVEL_WIDTH - 3, x + 4) });
      }
    }
    mi += 1;
  }

  // Spike pits: gaps carved into the solid ground floor that the player
  // must jump over -- falling in is fatal (see PIT_KILL_DEPTH + index.js's
  // applyCavernInput, which stops treating the ground as solid across a
  // pit's x-range and kills the player once they've fallen far enough past
  // it to reach the spikes). Widths stay <= MAX_SAME_TIER_GAP (the same
  // "comfortably jumpable, numerically validated" margin already used for
  // the platform-tier gaps above), so every pit is jumpable with the same
  // safety margin. Kept off the boss arena (clean, readable fight space)
  // and away from the entrance (no ambush-by-geometry the instant you walk
  // in) and the exit door.
  const pits = [];
  {
    let x = 10;
    while (x < BOSS_ARENA_START - 10) {
      // Not every gap in this stride becomes a pit -- keeps them feeling
      // like scattered hazards rather than a relentless every-few-tiles
      // obstacle course.
      const width = 2.0 + rand() * 1.0; // 2..3 tiles, jumpable with margin
      if (rand() < 0.5) pits.push({ x0: x, x1: x + width });
      x += width + 6 + rand() * 8; // generous spacing so pits never chain into an unjumpable double-gap
    }
  }

  // Decor: purely cosmetic scatter (wall torches / hanging stalactites /
  // glowing crystal clusters) so the cave doesn't look so bland. No
  // collision, not entities -- generated once here, deterministically, from
  // the same seeded PRNG stream as everything else above, so the layout is
  // stable and never reshuffles/flickers on the client (the client just
  // renders whatever static list it's given, same pattern as `platforms`).
  // Skipped inside the boss arena so it stays clean and readable for the
  // fight's telegraphed attacks.
  const decor = [];
  for (let x = 6; x < BOSS_ARENA_START - 4; x += 4.5 + rand() * 4.5) {
    const roll = rand();
    if (roll < 0.4) {
      decor.push({ type: "torch", x, y: rand() < 0.4 ? GROUND_Y - TIER_SPACING * 2 : GROUND_Y });
    } else if (roll < 0.75) {
      decor.push({ type: "stalactite", x, y: TIER_Y[2] - 2.0 - rand() * 1.4 });
    } else {
      decor.push({ type: "crystal", x, y: GROUND_Y });
    }
  }

  return {
    width: LEVEL_WIDTH,
    groundY: GROUND_Y,
    tierSpacing: TIER_SPACING,
    tierY: TIER_Y,
    platforms,
    pits,
    spawn: { x: 4, y: GROUND_Y },
    exitZoneX: 3, // x < this, on/near the ground, returns the player to the cave
    bossArenaStart: BOSS_ARENA_START,
    bossSpawn: { x: BOSS_ARENA_START + BOSS_ARENA_LEN / 2, y: GROUND_Y },
    nextDoorX: LEVEL_WIDTH - 3, // door to the cliff area, gated by bossDefeated (see index.js)
    monsterSpawns,
    decor,
  };
}

// --- Goblin (melee) + troll (ranged) enemies --------------------------------

const GOBLIN_SPEED = 2.2;
// Aggro/chase range widened to 5 tiles per the "more aggressive, attack/chase
// within 5 tiles" request (was 6, close already, but pinned to exactly 5).
const GOBLIN_AGGRO_RANGE = 5;
const GOBLIN_DEAGGRO_RANGE = 8;
const GOBLIN_ATTACK_RANGE = 0.9;
const GOBLIN_ATTACK_COOLDOWN_MS = 900;
const GOBLIN_MAX_HP = 4;
// These are "fire goblins" -- originally 5x the base melee damage, now
// ANOTHER 10x on top of that per a later balance request (50x base), and
// (see index.js's killCavernMonster) worth 10x the normal kill XP.
const GOBLIN_DAMAGE = 50;
const GOBLIN_XP_MULT = 10;
const GOBLIN_SHADE_COUNT = 3; // 3 red shades, randomly assigned per spawn

const TROLL_SPEED = 1.0;
const TROLL_AGGRO_RANGE = 11;
const TROLL_DEAGGRO_RANGE = 15;
const TROLL_LOS_TOLERANCE_Y = TIER_SPACING * 2 + 0.6; // can "see" across tiers, side-view style
const TROLL_ATTACK_COOLDOWN_MS = 2000;
const TROLL_MAX_HP = 5;
// Was left at its original pre-balance-pass value (1) when GOBLIN_DAMAGE
// above got its 5->50 (10x) bump -- against a 10-max-hp player, 1 damage
// with no other feedback is imperceptible, which is exactly what a player
// report of "the arrows seem to just pass through and do no damage" looks
// like even though the hit was registering server-side the whole time (see
// also the missing hitFlashUntil fix in index.js's cavern_arrow_hit
// handling, the other half of that same bug report). Bring it in line with
// the same 10x balance pass so a landed arrow reads as a real hit.
const TROLL_ARROW_DAMAGE = 10;

// --- Fire bats: swooping random-spawn hazard --------------------------------
// Perch/idle-drift right at the cave ceiling until a player passes near
// underneath, then swoop down and dive-bomb the player's position AT THE
// MOMENT THE DIVE STARTS (same "captured target, dodge by moving" pattern as
// the boss's slam) -- a hit deals damage and pops the bat, a miss just
// carries it on past the target point until it exits the level bounds
// ("flies off screen"), never turning back to retry. Detection is
// horizontal-distance-only (not a radial hypot check) -- the bat is way up
// near the ceiling, often 8+ tiles above a player standing on the ground
// tier, so a radial range large enough to still catch that vertical gap
// would also trigger from absurdly far away horizontally; checking only "is
// a player roughly below/near my x" is what actually reads as "swoops down
// on you" as you walk underneath it.
const FIRE_BAT_HP = 2;
const FIRE_BAT_DAMAGE = GOBLIN_DAMAGE; // "same amount of damage as the fire goblins"
const FIRE_BAT_CEILING_Y_OFFSET = 0.8; // tiles below the ceiling while perched/idling
const FIRE_BAT_DETECT_RANGE_X = 4; // horizontal-only detection width, tiles
const FIRE_BAT_IDLE_SPEED = 1.1;
const FIRE_BAT_DIVE_SPEED = 8.5;
const FIRE_BAT_HIT_RADIUS = 0.85;

// --- Giant goblin boss (end of the boss arena) ------------------------------
// Same HP as the outside-world dragon (see index.js MAX_HP for the dragon).
// Alternates between two telegraphed attacks on a fixed cadence, with a
// chance to repeat the same attack back-to-back instead of strictly
// alternating (per the "sometimes happen one after another" request):
//   - slam: windup captures the CURRENT position of a random cavern player
//     as the target -- not their position at impact -- so moving away during
//     the windup dodges it entirely.
//   - shout: windup then a level-wide stun (nobody can dodge this one; it's
//     a "get moving before the windup ends" telegraph instead).
const BOSS_HP = 100;
const BOSS_ACTION_INTERVAL_MS = 2000; // "adjust the goblin king's attack speed to attacking every 2 seconds" (was 5000)
const BOSS_REPEAT_CHANCE = 0.25;
const BOSS_SLAM_WINDUP_MS = 1300;
const BOSS_SHOUT_WINDUP_MS = 700;
const BOSS_SLAM_RADIUS = 3.5; // tiles, horizontal AOE around the telegraphed spot
const BOSS_SLAM_DAMAGE = 3;
const BOSS_SHOUT_RADIUS = 60; // tiles -- effectively the whole boss arena
const BOSS_STUN_MS = 3000;
const BOSS_XP_MULT = 20; // not explicitly specified by the request; documented assumption
// The boss only starts a new attack once someone has actually reached the
// arena or is roughly on-screen -- a fixed x-distance proxy for "visible",
// since the side-scroller camera follows horizontally. Wandering the boss
// room's approach corridor shouldn't get you slammed from off-screen.
const BOSS_AGGRO_DISTANCE = 18;
// The boss's sprite is drawn ~8x normal-enemy scale (BOSS_CW/CH in
// gen_assets.py / game.js) -- roughly 2.7-3 tiles from his center x to the
// edge of his actual body (torso/head/club-arm), well past
// PLAYER_ATTACK_RANGE's 1.3 tiles. Without this, a melee/arrow hit only
// registers when the player is standing almost exactly under his feet (his
// sprite's horizontal center) -- "he only takes damage if hit his feet".
// Added on top of the normal attack range/radius at both cavern hit-check
// call sites in index.js, same pattern already used for outside-world
// monsters via their own m.hitRadius.
const BOSS_HIT_RADIUS = 2.6;
// Club damage is now a fraction of the victim's OWN max HP (see the
// "make his hits take 25% of your health" request) rather than a flat
// number, applied at the onSlam call site in index.js.
const BOSS_CLUB_DAMAGE_FRACTION = 0.25;
// Stomp: an immediate, short-fuse punish for standing directly beneath the
// boss's feet (so hugging his base doesn't dodge the slam/shout cycle for
// free) -- its own short cooldown, independent of the slam/shout cadence.
// "getting stomped 3 times kills you" is enforced at the onStomp call site
// in index.js via a per-player counter, not a damage-fraction calculation.
const BOSS_STOMP_RANGE = 2.6; // tiles from boss.x -- matches BOSS_HIT_RADIUS
const BOSS_STOMP_WINDUP_MS = 550;
const BOSS_STOMP_COOLDOWN_MS = 1500;

let nextCavernMonsterId = 1;

class CavernMonster {
  constructor(type, x, y, tier, x0, x1) {
    this.id = `cm${nextCavernMonsterId++}`;
    this.type = type;
    this.x = x;
    this.y = y;
    this.tier = tier;
    this.x0 = x0;
    this.x1 = x1;
    this.dir = "left";
    this.moving = false;
    this.hp = type === "troll" ? TROLL_MAX_HP : type === "boss_goblin" ? BOSS_HP : type === "fire_bat" ? FIRE_BAT_HP : GOBLIN_MAX_HP;
    this.maxHp = this.hp;
    this.dead = false;
    this.aggroTarget = null;
    this.lastAttackAt = 0;
    this.patrolGoal = null;
    this.nextPatrolDecisionAt = 0;
    this.attacking = false; // client-facing: currently mid swing/shot, for animation
    this.attackUntil = 0;
    this.damage = type === "troll" ? TROLL_ARROW_DAMAGE : type === "boss_goblin" ? BOSS_SLAM_DAMAGE : type === "fire_bat" ? FIRE_BAT_DAMAGE : GOBLIN_DAMAGE;
    // Widens the melee/arrow hit-check radius against this monster (see
    // BOSS_HIT_RADIUS above) -- 0 for everything except the giant boss,
    // whose sprite is drawn far larger than his actual (x,y) point.
    this.hitRadius = type === "boss_goblin" ? BOSS_HIT_RADIUS : 0;
    // All non-boss cave enemies (goblins, trolls, fire bats alike) render as
    // the same goblin sprite family in one of the 3 red shades -- "use the
    // goblin character as the enemy model inside the cave, don't use any
    // other models" -- so this is assigned regardless of type now, not just
    // for type === "goblin".
    this.shade = type !== "boss_goblin" ? 1 + Math.floor(Math.random() * GOBLIN_SHADE_COUNT) : 0;
    // Boss-only AI state -- see updateBossGoblin below.
    if (type === "boss_goblin") {
      this.actionState = "idle"; // idle | windup_slam | windup_shout | windup_stomp
      this.nextActionAt = 0;
      this.lastActionType = null;
      this.windupUntil = 0;
      this.slamTargetX = x;
      // "Aggro" state, independent of the attack state machine above --
      // drives the client's dynamic combat-music switch. See updateBossGoblin.
      this.aggro = false;
      this.lastSeenPlayerAt = 0;
      // Own short cooldown for the stomp punish -- separate from
      // nextActionAt's slam/shout cadence, see updateBossGoblin.
      this.stompCooldownUntil = 0;
    }
    // Fire-bat-only AI state -- see updateFireBat below.
    if (type === "fire_bat") {
      this.batState = "idle"; // idle | diving | flyoff
      this.diveTargetX = x;
      this.diveTargetY = y;
      this.diveDirX = 0;
      this.diveDirY = 0;
      this.homeX = x;
      this.homeY = y;
      this.wanderGoalX = x;
    }
  }

  publicState() {
    const s = {
      id: this.id,
      type: this.type,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      tier: this.tier,
      dir: this.dir,
      moving: this.moving,
      attacking: this.attacking,
      hp: this.hp,
      maxHp: this.maxHp,
      shade: this.shade,
    };
    if (this.type === "boss_goblin") {
      s.actionState = this.actionState;
      s.slamTargetX = Math.round(this.slamTargetX * 100) / 100;
      s.aggro = !!this.aggro;
    }
    if (this.type === "fire_bat") {
      s.batState = this.batState;
    }
    return s;
  }
}

function faceTowardX(m, dx) {
  if (dx !== 0) m.dir = dx > 0 ? "right" : "left";
}

/** Goblins stay locked to their own tier's y and patrol/chase only along x,
 * clamped to their platform segment's [x0,x1] bounds. getPlayersOnTier(tier)
 * returns live, non-dead cavern-area players currently standing on that
 * tier (within a small y tolerance) -- see index.js. onAttack(goblin,
 * targetPlayer) applies melee damage. */
function updateGoblin(m, dt, now, { getPlayersOnTier, onAttack }) {
  if (m.dead) return;

  if (m.aggroTarget) {
    const target = m.aggroTarget;
    if (target.dead || target.area !== "cavern") { m.aggroTarget = null; }
    else {
      const d = Math.hypot(target.x - m.x, target.y - m.y);
      if (d > GOBLIN_DEAGGRO_RANGE) m.aggroTarget = null;
    }
  }

  if (!m.aggroTarget) {
    const onTier = getPlayersOnTier(m.tier);
    let best = null, bestDist = Infinity;
    for (const p of onTier) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d <= GOBLIN_AGGRO_RANGE && d < bestDist) { best = p; bestDist = d; }
    }
    if (best) m.aggroTarget = best;
  }

  if (m.aggroTarget) {
    const target = m.aggroTarget;
    const dx = target.x - m.x;
    const dist = Math.abs(dx);
    if (dist > GOBLIN_ATTACK_RANGE) {
      m.moving = true;
      faceTowardX(m, dx);
      const step = GOBLIN_SPEED * dt * Math.sign(dx);
      const nx = Math.max(m.x0, Math.min(m.x1, m.x + step));
      m.x = nx;
    } else {
      m.moving = false;
      faceTowardX(m, dx);
      if (now - m.lastAttackAt >= GOBLIN_ATTACK_COOLDOWN_MS) {
        m.lastAttackAt = now;
        m.attacking = true;
        m.attackUntil = now + 300;
        onAttack(m, target);
      }
    }
    if (m.attacking && now >= m.attackUntil) m.attacking = false;
    return;
  }

  // Idle patrol back and forth across the platform.
  if (now >= m.nextPatrolDecisionAt) {
    m.nextPatrolDecisionAt = now + 1200 + Math.random() * 1800;
    m.patrolGoal = Math.random() < 0.8 ? (m.dir === "left" ? m.x0 : m.x1) : null;
  }
  if (m.patrolGoal !== null) {
    const dx = m.patrolGoal - m.x;
    if (Math.abs(dx) < 0.15) { m.patrolGoal = null; m.moving = false; }
    else {
      m.moving = true;
      faceTowardX(m, dx);
      const step = GOBLIN_SPEED * 0.5 * dt * Math.sign(dx);
      m.x = Math.max(m.x0, Math.min(m.x1, m.x + step));
    }
  } else {
    m.moving = false;
  }
  if (m.attacking && now >= m.attackUntil) m.attacking = false;
}

/** Trolls barely move (slow perch-patrol) and shoot arrows -- sometimes a
 * single shot, sometimes a burst of 2-3 -- at any player within range on a
 * nearby tier (side-view "line of sight": tier doesn't have to match
 * exactly, just be within TROLL_LOS_TOLERANCE_Y). onRangedShot(troll,
 * targetPlayer, shotIndex, shotCount) is called once per arrow in the
 * volley so index.js can spawn each cavern projectile with a slight angle
 * spread. */
function updateTroll(m, dt, now, { getPlayersInLOS, onRangedShot }) {
  if (m.dead) return;

  if (m.aggroTarget) {
    const target = m.aggroTarget;
    if (target.dead || target.area !== "cavern") { m.aggroTarget = null; }
    else {
      const d = Math.hypot(target.x - m.x, target.y - m.y);
      if (d > TROLL_DEAGGRO_RANGE) m.aggroTarget = null;
    }
  }

  if (!m.aggroTarget) {
    const visible = getPlayersInLOS(m.y, TROLL_LOS_TOLERANCE_Y);
    let best = null, bestDist = Infinity;
    for (const p of visible) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d <= TROLL_AGGRO_RANGE && d < bestDist) { best = p; bestDist = d; }
    }
    if (best) m.aggroTarget = best;
  }

  if (m.aggroTarget) {
    const target = m.aggroTarget;
    faceTowardX(m, target.x - m.x);
    m.moving = false;
    if (now - m.lastAttackAt >= TROLL_ATTACK_COOLDOWN_MS) {
      m.lastAttackAt = now;
      m.attacking = true;
      m.attackUntil = now + 400;
      const burst = Math.random() < 0.4 ? (Math.random() < 0.5 ? 2 : 3) : 1;
      for (let i = 0; i < burst; i++) onRangedShot(m, target, i, burst);
    }
    if (m.attacking && now >= m.attackUntil) m.attacking = false;
    return;
  }

  // Idle: slow shuffle within the platform, mostly standing still (perched).
  if (now >= m.nextPatrolDecisionAt) {
    m.nextPatrolDecisionAt = now + 2000 + Math.random() * 2500;
    m.patrolGoal = Math.random() < 0.4 ? (Math.random() < 0.5 ? m.x0 : m.x1) : null;
  }
  if (m.patrolGoal !== null) {
    const dx = m.patrolGoal - m.x;
    if (Math.abs(dx) < 0.15) { m.patrolGoal = null; m.moving = false; }
    else {
      m.moving = true;
      faceTowardX(m, dx);
      const step = TROLL_SPEED * dt * Math.sign(dx);
      m.x = Math.max(m.x0, Math.min(m.x1, m.x + step));
    }
  } else {
    m.moving = false;
  }
  if (m.attacking && now >= m.attackUntil) m.attacking = false;
}

/** The giant boss goblin doesn't chase or patrol -- it stands in the arena
 * and, on a fixed cadence, alternates between two telegraphed attacks
 * (mostly strictly alternating, but sometimes repeats -- see
 * BOSS_REPEAT_CHANCE). getPlayersInCavern() returns all live, non-dead
 * cavern-area players. onWindupStart(boss, kind, targetX) fires the instant
 * a windup begins (so the client can show the telegraph); onSlam/onShout
 * fire once the windup completes and the attack actually lands. */
// How long the boss stays "aggro'd" (and its combat music keeps playing)
// after nobody's close/on-screen anymore -- avoids the music flickering
// off and back on between one windup cycle ending and the next beginning.
const BOSS_AGGRO_LINGER_MS = 3000;

function updateBossGoblin(boss, dt, now, { getPlayersInCavern, onWindupStart, onSlam, onShout, onStomp }) {
  if (boss.dead) return;

  if (boss.nextActionAt === 0) boss.nextActionAt = now + BOSS_ACTION_INTERVAL_MS;

  // Aggro/engaged tracking -- independent of the attack state machine below,
  // purely for the client's dynamic combat-music switch.
  if (boss.actionState !== "idle") {
    boss.lastSeenPlayerAt = now;
  } else if (getPlayersInCavern().some((p) => Math.abs(p.x - boss.x) <= BOSS_AGGRO_DISTANCE)) {
    boss.lastSeenPlayerAt = now;
  }
  boss.aggro = now - boss.lastSeenPlayerAt < BOSS_AGGRO_LINGER_MS;

  if (boss.actionState === "idle") {
    // Stomp: fires immediately (subject to its own short cooldown) whenever
    // someone is standing on the ground right under him, regardless of the
    // slam/shout cadence below -- "make him stomp his feet if the player
    // stands under him".
    if (now >= (boss.stompCooldownUntil || 0)) {
      const underfoot = getPlayersInCavern().some(
        (p) => p.grounded && p.groundedTier === 0 && Math.abs(p.x - boss.x) <= BOSS_STOMP_RANGE
      );
      if (underfoot) {
        boss.actionState = "windup_stomp";
        boss.windupUntil = now + BOSS_STOMP_WINDUP_MS;
        boss.stompCooldownUntil = now + BOSS_STOMP_COOLDOWN_MS;
        boss.attacking = true;
        onWindupStart(boss, "stomp", boss.x);
        return;
      }
    }

    if (now >= boss.nextActionAt) {
      const plist0 = getPlayersInCavern();
      const someoneClose = plist0.some((p) => Math.abs(p.x - boss.x) <= BOSS_AGGRO_DISTANCE);
      if (!someoneClose) {
        // Nobody's within reach or on-screen -- stay idle, check back soon
        // rather than winding up an attack at an empty arena.
        boss.nextActionAt = now + 500;
        return;
      }
      let type;
      if (!boss.lastActionType) {
        type = Math.random() < 0.5 ? "slam" : "shout";
      } else {
        type = Math.random() < BOSS_REPEAT_CHANCE
          ? boss.lastActionType
          : (boss.lastActionType === "slam" ? "shout" : "slam");
      }
      boss.lastActionType = type;
      boss.attacking = true;
      if (type === "slam") {
        const plist = getPlayersInCavern();
        const target = plist.length ? plist[Math.floor(Math.random() * plist.length)] : null;
        // Captured NOW, at the start of the windup -- a player who moves
        // away during the windup dodges the slam entirely.
        boss.slamTargetX = target ? target.x : boss.x;
        boss.actionState = "windup_slam";
        boss.windupUntil = now + BOSS_SLAM_WINDUP_MS;
        boss.dir = boss.slamTargetX < boss.x ? "left" : "right";
      } else {
        boss.actionState = "windup_shout";
        boss.windupUntil = now + BOSS_SHOUT_WINDUP_MS;
      }
      onWindupStart(boss, type, boss.slamTargetX);
    }
    return;
  }

  if (now >= boss.windupUntil) {
    if (boss.actionState === "windup_slam") onSlam(boss, boss.slamTargetX);
    else if (boss.actionState === "windup_shout") onShout(boss);
    else if (boss.actionState === "windup_stomp") onStomp(boss);
    // A stomp is a reflexive punish, not part of the slam/shout cadence --
    // don't push nextActionAt out when one resolves, so hugging his feet
    // doesn't also buy extra time before the next slam/shout telegraph.
    const wasStomp = boss.actionState === "windup_stomp";
    boss.actionState = "idle";
    boss.attacking = false;
    if (!wasStomp) boss.nextActionAt = now + BOSS_ACTION_INTERVAL_MS;
  }
}

/** Fire bat AI: perch/idle-drift right at the cave ceiling until a player
 * passes near underneath, then swoop down and dive-bomb the player's
 * position CAPTURED AT THE START OF THE DIVE (same dodge-by-moving pattern
 * as the boss slam) -- a hit pops the bat and deals damage, a miss carries
 * it on past the target in a straight line ("flies off screen") until
 * index.js's tick loop notices it's out of level bounds and removes it (no
 * death fx/XP for a miss, it just leaves). */
function updateFireBat(bat, dt, now, { getPlayersInCavern, onAttack }) {
  if (bat.dead) return;

  if (bat.batState === "idle") {
    if (now >= (bat.nextPatrolDecisionAt || 0)) {
      bat.wanderGoalX = bat.homeX + (Math.random() - 0.5) * 6;
      bat.nextPatrolDecisionAt = now + 1500 + Math.random() * 1500;
    }
    const dx = bat.wanderGoalX - bat.x;
    if (Math.abs(dx) > 0.1) {
      bat.x += Math.sign(dx) * Math.min(Math.abs(dx), FIRE_BAT_IDLE_SPEED * dt);
      bat.moving = true;
      faceTowardX(bat, dx);
    } else {
      bat.moving = false;
    }
    bat.y = bat.homeY;

    const plist = getPlayersInCavern();
    for (const p of plist) {
      const py = p.y - 0.7;
      if (Math.abs(p.x - bat.x) <= FIRE_BAT_DETECT_RANGE_X) {
        bat.batState = "diving";
        bat.diveTargetX = p.x;
        bat.diveTargetY = py;
        const ddx = bat.diveTargetX - bat.x, ddy = bat.diveTargetY - bat.y;
        const dlen = Math.max(0.01, Math.hypot(ddx, ddy));
        bat.diveDirX = ddx / dlen;
        bat.diveDirY = ddy / dlen;
        faceTowardX(bat, ddx);
        break;
      }
    }
    return;
  }

  if (bat.batState === "diving") {
    const step = FIRE_BAT_DIVE_SPEED * dt;
    bat.x += bat.diveDirX * step;
    bat.y += bat.diveDirY * step;
    bat.moving = true;
    if (Math.hypot(bat.x - bat.diveTargetX, bat.y - bat.diveTargetY) <= FIRE_BAT_HIT_RADIUS) {
      const plist = getPlayersInCavern();
      const hit = plist.find((p) => Math.hypot(p.x - bat.diveTargetX, (p.y - 0.7) - bat.diveTargetY) <= FIRE_BAT_HIT_RADIUS);
      if (hit) {
        onAttack(bat, hit);
        bat.dead = true; // pops on a successful hit
      } else {
        bat.batState = "flyoff"; // missed -- keeps flying the same direction, off screen
      }
    }
    return;
  }

  if (bat.batState === "flyoff") {
    bat.x += bat.diveDirX * FIRE_BAT_DIVE_SPEED * dt;
    bat.y += bat.diveDirY * FIRE_BAT_DIVE_SPEED * dt;
    bat.moving = true;
  }
}

/** Spawns one fire bat perched at the cave ceiling above the given x --
 * "the bats that spawn in the side scroller spawn at the top of the cave
 * ceiling then swoop down on you". Callers keep x within
 * [0, level.bossArenaStart) -- bats never spawn in/near the boss arena
 * ("except during the boss fight"). */
function spawnFireBat(level, x) {
  const y = CEILING_Y + FIRE_BAT_CEILING_Y_OFFSET;
  return new CavernMonster("fire_bat", x, y, 0, 0, level.bossArenaStart);
}

function spawnCavernMonsters(level) {
  const list = [];
  for (const spec of level.monsterSpawns) {
    list.push(new CavernMonster(spec.type, spec.x, spec.y, spec.tier, spec.x0, spec.x1));
  }
  return list;
}

/** The boss stands roughly centered in the reserved boss arena, on the
 * ground tier. x0/x1 are just descriptive arena bounds (the boss doesn't
 * patrol), kept for consistency with the CavernMonster shape. */
function spawnCavernBoss(level) {
  return new CavernMonster("boss_goblin", level.bossSpawn.x, level.bossSpawn.y, 0, level.bossArenaStart, level.width - 2);
}

module.exports = {
  generateCavernLevel,
  isOverPit,
  PIT_KILL_DEPTH,
  CEILING_Y,
  CavernMonster,
  updateGoblin,
  updateTroll,
  updateBossGoblin,
  updateFireBat,
  spawnCavernMonsters,
  spawnCavernBoss,
  spawnFireBat,
  GOBLIN_ATTACK_RANGE,
  TROLL_ARROW_DAMAGE,
  TIER_SPACING,
  GOBLIN_XP_MULT,
  BOSS_HP,
  BOSS_SLAM_RADIUS,
  BOSS_SLAM_DAMAGE,
  BOSS_SHOUT_RADIUS,
  BOSS_STUN_MS,
  BOSS_SLAM_WINDUP_MS,
  BOSS_SHOUT_WINDUP_MS,
  BOSS_XP_MULT,
  BOSS_HIT_RADIUS,
  BOSS_CLUB_DAMAGE_FRACTION,
  BOSS_STOMP_RANGE,
  BOSS_STOMP_WINDUP_MS,
  BOSS_STOMP_COOLDOWN_MS,
  FIRE_BAT_DAMAGE,
};
