// Monster entities: simple state-machine AI (idle wander -> aggro chase ->
// melee attack -> death), spawn placement, and respawn helpers. Combat
// resolution (taking damage from a player's sword swing) lives in
// server/index.js since it needs to reach across both the player map and
// the monster map; this module just owns a monster's own behavior.

const MAX_HP = 3;

const MONSTER_TYPES = {
  rat: { speed: 3.2, wanderRadius: 4, aggroRange: 5, deaggroRange: 9 },
  bat: { speed: 3.6, wanderRadius: 6, aggroRange: 6, deaggroRange: 10 },
  spider: { speed: 2.4, wanderRadius: 3, aggroRange: 4.5, deaggroRange: 8 },
};
const TYPE_NAMES = Object.keys(MONSTER_TYPES);

const ATTACK_COOLDOWN_MS = 1000;
const ATTACK_RANGE = 0.85;
const MIN_SPAWN_SEPARATION = 15; // tiles, between any two monsters

let nextMonsterId = 1;

class Monster {
  constructor(type, x, y) {
    this.id = `m${nextMonsterId++}`;
    this.type = type;
    this.x = x;
    this.y = y;
    this.dir = "down";
    this.moving = false;
    this.hp = MAX_HP;
    this.maxHp = MAX_HP;
    this.dead = false;
    this.aggroTarget = null; // player id
    this.lastAttackAt = 0;
    this.wanderGoal = null; // {x,y}
    this.nextWanderDecisionAt = 0;
    this.homeX = x;
    this.homeY = y;
  }

  publicState() {
    return {
      id: this.id,
      type: this.type,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      dir: this.dir,
      moving: this.moving,
      hp: this.hp,
      maxHp: this.maxHp,
    };
  }
}

function faceToward(m, dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) m.dir = dx > 0 ? "right" : "left";
  else if (dy !== 0) m.dir = dy > 0 ? "down" : "up";
}

/**
 * Advances one monster's AI by dt seconds.
 * canMoveTo(x, y, excludeId) must return whether that world point is free
 * of both terrain collision and other entities (see server/index.js).
 * getPlayer(id) returns a live player object ({x,y,hp,dead,...}) or null.
 * onAttack(monster, targetPlayer) is called when the monster actually
 * lands a hit (caller applies the damage / handles player death).
 */
function updateMonster(m, dt, now, { canMoveTo, getPlayer, onAttack }) {
  if (m.dead) return;
  const def = MONSTER_TYPES[m.type];

  // Drop aggro if the target disconnected, died, or fled far enough away.
  if (m.aggroTarget) {
    const target = getPlayer(m.aggroTarget);
    if (!target || target.dead) {
      m.aggroTarget = null;
    } else {
      const d = Math.hypot(target.x - m.x, target.y - m.y);
      if (d > def.deaggroRange) m.aggroTarget = null;
    }
  }

  if (m.aggroTarget) {
    const target = getPlayer(m.aggroTarget);
    const dx = target.x - m.x;
    const dy = target.y - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist > ATTACK_RANGE) {
      m.moving = true;
      faceToward(m, dx, dy);
      const step = def.speed * dt;
      const nx = m.x + (dx / dist) * step;
      const ny = m.y + (dy / dist) * step;
      if (canMoveTo(nx, m.y, m.id)) m.x = nx;
      if (canMoveTo(m.x, ny, m.id)) m.y = ny;
    } else {
      m.moving = false;
      faceToward(m, dx, dy);
      if (now - m.lastAttackAt >= ATTACK_COOLDOWN_MS) {
        m.lastAttackAt = now;
        onAttack(m, target);
      }
    }
    return;
  }

  // Idle: gentle wander near home so monsters don't drift across the map.
  if (now >= m.nextWanderDecisionAt) {
    m.nextWanderDecisionAt = now + 2500 + Math.random() * 3500;
    if (Math.random() < 0.6) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * def.wanderRadius;
      m.wanderGoal = { x: m.homeX + Math.cos(ang) * r, y: m.homeY + Math.sin(ang) * r };
    } else {
      m.wanderGoal = null;
    }
  }

  if (m.wanderGoal) {
    const dx = m.wanderGoal.x - m.x;
    const dy = m.wanderGoal.y - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) {
      m.wanderGoal = null;
      m.moving = false;
    } else {
      m.moving = true;
      faceToward(m, dx, dy);
      const step = def.speed * 0.4 * dt; // wander slower than a chase
      const nx = m.x + (dx / dist) * step;
      const ny = m.y + (dy / dist) * step;
      if (canMoveTo(nx, m.y, m.id)) m.x = nx;
      else m.wanderGoal = null;
      if (canMoveTo(m.x, ny, m.id)) m.y = ny;
      else m.wanderGoal = null;
    }
  } else {
    m.moving = false;
  }
}

/** Finds a walkable point at least MIN_SPAWN_SEPARATION away from every
 * monster in `existing`, trying random points first and falling back to a
 * relaxed search so we never hang forever on a crowded map. */
function findSpawnSpot(world, existing, canMoveTo, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    const x = 1.5 + Math.random() * (world.width - 3);
    const y = 1.5 + Math.random() * (world.height - 3);
    if (!canMoveTo(x, y, null)) continue;
    let ok = true;
    for (const m of existing) {
      if (Math.hypot(m.x - x, m.y - y) < MIN_SPAWN_SEPARATION) { ok = false; break; }
    }
    if (ok) return { x, y };
  }
  // Relax the spacing requirement rather than fail outright once the map
  // is getting crowded relative to its size.
  for (let i = 0; i < attempts; i++) {
    const x = 1.5 + Math.random() * (world.width - 3);
    const y = 1.5 + Math.random() * (world.height - 3);
    if (!canMoveTo(x, y, null)) continue;
    let ok = true;
    for (const m of existing) {
      if (Math.hypot(m.x - x, m.y - y) < MIN_SPAWN_SEPARATION * 0.5) { ok = false; break; }
    }
    if (ok) return { x, y };
  }
  return null;
}

function spawnInitialMonsters(world, canMoveTo, count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const spot = findSpawnSpot(world, list, canMoveTo);
    if (!spot) break;
    const type = TYPE_NAMES[i % TYPE_NAMES.length];
    list.push(new Monster(type, spot.x, spot.y));
  }
  return list;
}

module.exports = {
  Monster,
  MONSTER_TYPES,
  TYPE_NAMES,
  MAX_HP,
  ATTACK_RANGE,
  MIN_SPAWN_SEPARATION,
  updateMonster,
  findSpawnSpot,
  spawnInitialMonsters,
};
