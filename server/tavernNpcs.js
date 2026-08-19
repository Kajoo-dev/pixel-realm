// Purely decorative tavern patrons: NPCs that idle-wander the tavern floor
// using the same home+wanderGoal random-walk shape as monsters.js's idle
// wander (minus aggro/attack -- these never fight, and are never a combat
// target). They deliberately have NO collision against players or each
// other (per the spec: "no collision with players/each other") -- players
// and other NPCs simply pass through them -- but they DO still respect the
// room's static walls/table/bar collision via the same canStandOnTerrain
// check everything else moving in the tavern uses, so they don't visibly
// clip through furniture.
//
// The oversized "dancer" is a special case of the same class: it never
// wanders (home == its fixed spot at the top of the bar) and instead just
// flips its facing direction on a timer so the client's existing walk-cycle
// animation reads as a continuous side-to-side dance -- the actual side-to-
// side sway/scale is applied purely client-side (see drawTavernNpc in
// game.js), this module only owns its authoritative position/facing.
const RACES = ["human", "elf", "orc", "goblin"];
const COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];

const NPC_SPEED = 1.1;
const WANDER_RADIUS = 3.2;
const WANDER_PAUSE_MIN_MS = 1500;
const WANDER_PAUSE_MAX_MS = 4000;
const DANCE_FLIP_MS = 650;

let nextNpcId = 1;

class TavernNpc {
  constructor(x, y, race, color, opts = {}) {
    this.id = "tnpc" + nextNpcId++;
    this.x = x;
    this.y = y;
    this.homeX = x;
    this.homeY = y;
    this.race = race;
    this.color = color;
    this.dir = "down";
    this.moving = false;
    this.wanderGoal = null;
    this.pausedUntil = 0;
    this.big = !!opts.big;
    this.dancing = !!opts.big;
    this.nextFlipAt = 0;
  }

  publicState() {
    return {
      id: this.id,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      race: this.race,
      color: this.color,
      dir: this.dir,
      moving: this.moving,
      big: this.big,
      dancing: this.dancing,
    };
  }
}

function updateTavernNpc(npc, dt, now, canStand) {
  if (npc.dancing) {
    // Stationary performer: just alternates facing so the client's existing
    // walk-cycle frames read as continuous dancing, combined with a
    // client-local sine bob/sway for the rest of the motion.
    npc.moving = true;
    if (now >= npc.nextFlipAt) {
      npc.dir = npc.dir === "left" ? "right" : "left";
      npc.nextFlipAt = now + DANCE_FLIP_MS;
    }
    return;
  }

  if (npc.wanderGoal) {
    const dx = npc.wanderGoal.x - npc.x;
    const dy = npc.wanderGoal.y - npc.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.1) {
      npc.wanderGoal = null;
      npc.moving = false;
      npc.pausedUntil = now + WANDER_PAUSE_MIN_MS + Math.random() * (WANDER_PAUSE_MAX_MS - WANDER_PAUSE_MIN_MS);
    } else {
      const step = Math.min(dist, NPC_SPEED * dt);
      const nx = npc.x + (dx / dist) * step;
      const ny = npc.y + (dy / dist) * step;
      if (canStand(nx, ny)) {
        npc.x = nx;
        npc.y = ny;
        npc.moving = true;
        npc.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      } else {
        // Blocked (furniture edge) -- give up on this goal rather than
        // grinding against the obstacle; a fresh goal gets picked shortly.
        npc.wanderGoal = null;
        npc.moving = false;
        npc.pausedUntil = now + 300;
      }
    }
  } else if (now >= npc.pausedUntil) {
    const ang = Math.random() * Math.PI * 2;
    const r = WANDER_RADIUS * (0.35 + Math.random() * 0.65);
    const gx = npc.homeX + Math.cos(ang) * r;
    const gy = npc.homeY + Math.sin(ang) * r;
    if (canStand(gx, gy)) npc.wanderGoal = { x: gx, y: gy };
    else npc.pausedUntil = now + 500; // retry soon with a new random angle
  }
}

// Scatters `count` wandering patrons across the tavern's open floor, using
// `canStand(x, y)` (a terrain-only check, no entity collision) to keep them
// off walls/tables/the bar counter, and a light minimum-spacing check so they
// don't all spawn stacked on the same tile.
function spawnPatrons(tavernMap, canStand, count) {
  const npcs = [];
  const width = tavernMap.width;
  const height = tavernMap.height;
  let attempts = 0;
  while (npcs.length < count && attempts < count * 300) {
    attempts++;
    const x = 1.5 + Math.random() * (width - 3);
    const y = 1.5 + Math.random() * (height - 3);
    if (!canStand(x, y)) continue;
    if (npcs.some((n) => Math.hypot(n.x - x, n.y - y) < 1.5)) continue;
    const race = RACES[Math.floor(Math.random() * RACES.length)];
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    npcs.push(new TavernNpc(x, y, race, color));
  }
  return npcs;
}

// The oversized dancer stands right at the front edge of the bar counter
// band, top-center of the room, so it reads as performing up on the bar top
// rather than blending into the wandering crowd below.
function spawnDancer(tavernMap) {
  const x = tavernMap.width / 2;
  const y = Math.round(0.16 * tavernMap.height);
  return new TavernNpc(x, y, "human", "pink", { big: true });
}

module.exports = { TavernNpc, updateTavernNpc, spawnPatrons, spawnDancer, RACES, COLORS };
