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

const LEVEL_WIDTH = 70; // tiles
const GROUND_Y = 20; // solid floor's walkable surface y
const TIER_SPACING = 1.8; // vertical gap between tiers -- keep <= ~2.0 (see index.js physics constants)
const TIER_Y = [GROUND_Y, GROUND_Y - TIER_SPACING, GROUND_Y - TIER_SPACING * 2]; // [ground, mid, top]
const MAX_SAME_TIER_GAP = 3.0; // tiles -- stays under the ~4-tile full-arc jump distance with margin

function generateCavernLevel(seed = 4242) {
  const rand = mulberry32(seed);
  const platforms = []; // one-way platforms only -- the ground floor is handled separately as solid terrain
  const monsterSpawns = [];

  // Tiers 1 (mid) and 2 (top): procedurally chop the level width into
  // alternating platform segments and gaps, offset from each other so the
  // two tiers don't line up into one boring flat strip.
  for (let tier = 1; tier <= 2; tier++) {
    const y = TIER_Y[tier];
    let x = 3 + (tier === 2 ? 4 : 0); // stagger the starting offset between tiers
    let seg = 0;
    while (x < LEVEL_WIDTH - 3) {
      const segLen = 4 + rand() * 5; // 4..9 tiles
      const x0 = x;
      const x1 = Math.min(LEVEL_WIDTH - 2, x + segLen);
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
  // through the door.
  let mi = 0;
  for (let x = 12; x < LEVEL_WIDTH - 6; x += 7 + rand() * 4) {
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

  return {
    width: LEVEL_WIDTH,
    groundY: GROUND_Y,
    tierSpacing: TIER_SPACING,
    tierY: TIER_Y,
    platforms,
    spawn: { x: 4, y: GROUND_Y },
    exitZoneX: 3, // x < this, on/near the ground, returns the player to the cave
    monsterSpawns,
  };
}

// --- Goblin (melee) + troll (ranged) enemies --------------------------------

const GOBLIN_SPEED = 2.2;
const GOBLIN_AGGRO_RANGE = 6;
const GOBLIN_DEAGGRO_RANGE = 9;
const GOBLIN_ATTACK_RANGE = 0.9;
const GOBLIN_ATTACK_COOLDOWN_MS = 900;
const GOBLIN_MAX_HP = 4;
const GOBLIN_DAMAGE = 1;

const TROLL_SPEED = 1.0;
const TROLL_AGGRO_RANGE = 11;
const TROLL_DEAGGRO_RANGE = 15;
const TROLL_LOS_TOLERANCE_Y = TIER_SPACING * 2 + 0.6; // can "see" across tiers, side-view style
const TROLL_ATTACK_COOLDOWN_MS = 2000;
const TROLL_MAX_HP = 5;
const TROLL_ARROW_DAMAGE = 1;

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
    this.hp = type === "troll" ? TROLL_MAX_HP : GOBLIN_MAX_HP;
    this.maxHp = this.hp;
    this.dead = false;
    this.aggroTarget = null;
    this.lastAttackAt = 0;
    this.patrolGoal = null;
    this.nextPatrolDecisionAt = 0;
    this.attacking = false; // client-facing: currently mid swing/shot, for animation
    this.attackUntil = 0;
    this.damage = type === "troll" ? TROLL_ARROW_DAMAGE : GOBLIN_DAMAGE;
  }

  publicState() {
    return {
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
    };
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

function spawnCavernMonsters(level) {
  const list = [];
  for (const spec of level.monsterSpawns) {
    list.push(new CavernMonster(spec.type, spec.x, spec.y, spec.tier, spec.x0, spec.x1));
  }
  return list;
}

module.exports = {
  generateCavernLevel,
  CavernMonster,
  updateGoblin,
  updateTroll,
  spawnCavernMonsters,
  GOBLIN_ATTACK_RANGE,
  TROLL_ARROW_DAMAGE,
  TIER_SPACING,
};
