// The dragon boss: a large (4x3 tile) guardian that lives at the cave
// entrance. Unlike the small monsters in monsters.js, it aggroes purely by
// proximity (no need to hit it first) and, once it loses its target, walks
// itself back home to the cave mouth instead of just idly wandering there.
// Kept in its own module because its AI, size, and damage output are all
// meaningfully different from the rat/bat/spider state machine.

const MAX_HP = 100;
const SPEED_MULT_OVER_PLAYER = 2; // "twice as fast as a player"
const AGGRO_RANGE = 8;
const DEAGGRO_RANGE = 11; // a little slack past the aggro range so it doesn't flicker at the boundary
const ATTACK_COOLDOWN_MS = 1000;
const ATTACK_RANGE = 2.6; // generous melee/breath reach for a creature this size
const DAMAGE = 4;
const RADIUS = 1.7; // entity-vs-entity collision half-width (large footprint)
const HIT_RADIUS = 1.6; // extra reach added to the player's own sword hit-check against the dragon
const TERRAIN_RADIUS = 1.5; // used for the dragon's own terrain-collision corner checks
const HOME_LEASH_RADIUS = 0.6; // how close to home counts as "back"
const ATTACK_KINDS = ["fire", "claw"];

let nextDragonId = 1;

class Dragon {
  constructor(x, y, playerSpeed) {
    this.id = `dragon${nextDragonId++}`;
    this.type = "dragon";
    this.x = x;
    this.y = y;
    this.homeX = x;
    this.homeY = y;
    this.dir = "down";
    this.moving = false;
    this.hp = MAX_HP;
    this.maxHp = MAX_HP;
    this.dead = false;
    this.aggroTarget = null;
    this.lastAttackAt = 0;
    this.attackCount = 0; // every 3rd attack roars (see updateDragon)
    this.speed = playerSpeed * SPEED_MULT_OVER_PLAYER;
    this.damage = DAMAGE;
    this.radius = RADIUS;
    this.hitRadius = HIT_RADIUS;
    this.terrainRadius = TERRAIN_RADIUS;
    this.attackKind = null; // "fire" | "claw", set each time it swings, for the client's animation
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
      radius: this.radius,
      aggro: !!this.aggroTarget,
    };
  }
}

function faceToward(d, dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) d.dir = dx > 0 ? "right" : "left";
  else if (dy !== 0) d.dir = dy > 0 ? "down" : "up";
}

/**
 * Advances the dragon's AI by dt seconds. Proximity-based aggro: any live
 * player within AGGRO_RANGE becomes the target even without attacking
 * first. canMoveTo(x, y, excludeId, radius) must check both terrain and
 * entity collision. getAllPlayers() returns an iterable of live players.
 * onAttack(dragon, target, kind, roar) is invoked when a swing actually
 * lands; roar is true on every 3rd attack.
 */
function updateDragon(d, dt, now, { canMoveTo, getAllPlayers, getPlayer, onAttack }) {
  if (d.dead) return;

  if (d.aggroTarget) {
    const target = getPlayer(d.aggroTarget);
    if (!target || target.dead) {
      d.aggroTarget = null;
    } else {
      const dist = Math.hypot(target.x - d.x, target.y - d.y);
      if (dist > DEAGGRO_RANGE) d.aggroTarget = null;
    }
  }

  if (!d.aggroTarget) {
    let nearest = null, nearestDist = Infinity;
    for (const p of getAllPlayers()) {
      if (p.dead) continue;
      const dist = Math.hypot(p.x - d.x, p.y - d.y);
      if (dist <= AGGRO_RANGE && dist < nearestDist) { nearest = p; nearestDist = dist; }
    }
    if (nearest) d.aggroTarget = nearest.id;
  }

  if (d.aggroTarget) {
    const target = getPlayer(d.aggroTarget);
    const dx = target.x - d.x;
    const dy = target.y - d.y;
    const dist = Math.hypot(dx, dy);
    if (dist > ATTACK_RANGE) {
      d.moving = true;
      faceToward(d, dx, dy);
      const step = d.speed * dt;
      const nx = d.x + (dx / dist) * step;
      const ny = d.y + (dy / dist) * step;
      if (canMoveTo(nx, d.y, d.id, d.radius, d.terrainRadius)) d.x = nx;
      if (canMoveTo(d.x, ny, d.id, d.radius, d.terrainRadius)) d.y = ny;
    } else {
      d.moving = false;
      faceToward(d, dx, dy);
      if (now - d.lastAttackAt >= ATTACK_COOLDOWN_MS) {
        d.lastAttackAt = now;
        d.attackKind = ATTACK_KINDS[Math.floor(Math.random() * ATTACK_KINDS.length)];
        d.attackCount += 1;
        const roar = d.attackCount % 3 === 0;
        onAttack(d, target, d.attackKind, roar);
      }
    }
    return;
  }

  // No target: head back toward the cave mouth and idle there once close.
  const hdx = d.homeX - d.x;
  const hdy = d.homeY - d.y;
  const homeDist = Math.hypot(hdx, hdy);
  if (homeDist > HOME_LEASH_RADIUS) {
    d.moving = true;
    faceToward(d, hdx, hdy);
    const step = d.speed * 0.5 * dt; // saunter home, no need to rush
    const nx = d.x + (hdx / homeDist) * step;
    const ny = d.y + (hdy / homeDist) * step;
    if (canMoveTo(nx, d.y, d.id, d.radius, d.terrainRadius)) d.x = nx;
    if (canMoveTo(d.x, ny, d.id, d.radius, d.terrainRadius)) d.y = ny;
  } else {
    d.moving = false;
    d.dir = "down"; // face outward from the cave, watching the entrance
  }
}

module.exports = {
  Dragon,
  MAX_HP,
  AGGRO_RANGE,
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE,
  DAMAGE,
  RADIUS,
  HIT_RADIUS,
  TERRAIN_RADIUS,
  ATTACK_KINDS,
  updateDragon,
};
