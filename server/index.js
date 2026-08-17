const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { generateMap } = require("./map");
const monsters = require("./monsters");

const PORT = process.env.PORT || 3000;
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const SPEED_TILES_PER_SEC = 4.5;
const PLAYER_RADIUS = 0.32; // terrain-collision half-width, in tiles
const ENTITY_MIN_SEPARATION = 0.58; // players/monsters can't stand closer than this
const MAX_NAME_LEN = 16;
const COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];
const RACES = ["human", "elf", "orc", "goblin"];

const PLAYER_MAX_HP = 10;
const PLAYER_ATTACK_MIN_INTERVAL_MS = 150; // anti-spam floor, well under any real click rate
const PLAYER_ATTACK_RANGE = 1.3;
const PLAYER_ATTACK_ARC_RAD = (110 * Math.PI) / 180;
const REGEN_OUT_OF_COMBAT_MS = 10000;
const REGEN_INTERVAL_MS = 3000;
const PLAYER_RESPAWN_DELAY_MS = 3000;

const MONSTER_COUNT = 10;
const MONSTER_RESPAWN_DELAY_MS = 20000;

const world = generateMap(60, 42, 1337);

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

function isBlocked(tx, ty) {
  if (tx < 0 || ty < 0 || ty >= world.height || tx >= world.width) return true;
  return world.collision[ty][tx] === 1;
}

function canStandOnTerrain(x, y, radius) {
  const corners = [
    [x - radius, y - radius],
    [x + radius, y - radius],
    [x - radius, y + radius],
    [x + radius, y + radius],
  ];
  for (const [cx, cy] of corners) {
    if (isBlocked(Math.floor(cx), Math.floor(cy))) return false;
  }
  return true;
}

/** Terrain + other-entity collision, used by both players and monsters.
 * excludeId keeps an entity from colliding with itself. */
function canMoveTo(x, y, excludeId) {
  if (!canStandOnTerrain(x, y, PLAYER_RADIUS)) return false;
  for (const p of players.values()) {
    if (p.id === excludeId || p.dead) continue;
    if (Math.hypot(p.x - x, p.y - y) < ENTITY_MIN_SEPARATION) return false;
  }
  for (const m of activeMonsters.values()) {
    if (m.id === excludeId || m.dead) continue;
    if (Math.hypot(m.x - x, m.y - y) < ENTITY_MIN_SEPARATION) return false;
  }
  return true;
}

function findOpenSpawn() {
  const { x, y } = world.spawn;
  if (canMoveTo(x + 0.5, y + 0.5, null)) return { x: x + 0.5, y: y + 0.5 };
  for (let r = 1; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx + 0.5;
        const ny = y + dy + 0.5;
        if (canMoveTo(nx, ny, null)) return { x: nx, y: ny };
      }
    }
  }
  return { x: x + 0.5, y: y + 0.5 };
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
    const spawn = findOpenSpawn();
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

    const step = SPEED_TILES_PER_SEC * dt;
    const nx = this.x + dx * step;
    const ny = this.y + dy * step;

    if (canMoveTo(nx, this.y, this.id)) this.x = nx;
    if (canMoveTo(this.x, ny, this.id)) this.y = ny;
  }

  takeDamage(amount, now) {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this.lastCombatAt = now;
    this.lastRegenAt = now;
    if (this.hp <= 0) {
      this.dead = true;
      this.deadAt = now;
      io.emit("player_died", { id: this.id });
    }
  }

  publicState() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      race: this.race,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      dir: this.dir,
      moving: this.moving,
      hp: this.hp,
      maxHp: this.maxHp,
      dead: this.dead,
    };
  }
}

function scheduleMonsterRespawn(type, now) {
  respawnQueue.push({ type, at: now + MONSTER_RESPAWN_DELAY_MS });
}

function spawnMonster(type) {
  const spot = monsters.findSpawnSpot(world, Array.from(activeMonsters.values()), canMoveTo);
  if (!spot) return null;
  const m = new monsters.Monster(type, spot.x, spot.y);
  activeMonsters.set(m.id, m);
  io.emit("monster_spawned", m.publicState());
  return m;
}

for (const m of monsters.spawnInitialMonsters(world, canMoveTo, MONSTER_COUNT)) {
  activeMonsters.set(m.id, m);
}

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
        },
        players: Array.from(players.values()).map((p) => p.publicState()),
        monsters: Array.from(activeMonsters.values()).map((m) => m.publicState()),
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

    io.emit("player_attack", { id: player.id, angle });

    for (const m of activeMonsters.values()) {
      if (m.dead) continue;
      const dx = m.x - player.x;
      const dy = m.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > PLAYER_ATTACK_RANGE) continue;
      const targetAngle = Math.atan2(dy, dx);
      if (Math.abs(normalizeAngle(targetAngle - angle)) > PLAYER_ATTACK_ARC_RAD / 2) continue;

      m.hp -= 1;
      m.aggroTarget = player.id;
      if (m.hp <= 0) {
        m.dead = true;
        io.emit("monster_died", { id: m.id, x: m.x, y: m.y, type: m.type });
        activeMonsters.delete(m.id);
        scheduleMonsterRespawn(m.type, now);
      }
      break; // one target per swing keeps combat readable
    }
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
    player.applyInput(dt);

    // Regen: only once you've been out of combat for a while, then a
    // trickle every few seconds.
    if (!player.dead && player.hp < player.maxHp && now - player.lastCombatAt >= REGEN_OUT_OF_COMBAT_MS) {
      if (now - player.lastRegenAt >= REGEN_INTERVAL_MS) {
        player.hp = Math.min(player.maxHp, player.hp + 1);
        player.lastRegenAt = now;
      }
    }

    if (player.dead && now - player.deadAt >= PLAYER_RESPAWN_DELAY_MS) {
      const spawn = findOpenSpawn();
      player.x = spawn.x;
      player.y = spawn.y;
      player.hp = player.maxHp;
      player.dead = false;
      player.lastCombatAt = now;
      player.lastRegenAt = now;
      io.emit("player_respawned", player.publicState());
    }
  }

  const getPlayer = (id) => players.get(id) || null;
  const onMonsterAttack = (m, target) => {
    target.takeDamage(1, now);
    io.emit("monster_attack", { id: m.id, targetId: target.id });
  };
  for (const m of activeMonsters.values()) {
    monsters.updateMonster(m, dt, now, { canMoveTo, getPlayer, onAttack: onMonsterAttack });
  }

  for (let i = respawnQueue.length - 1; i >= 0; i--) {
    if (now >= respawnQueue[i].at) {
      const { type } = respawnQueue[i];
      respawnQueue.splice(i, 1);
      spawnMonster(type);
    }
  }

  if (players.size > 0) {
    io.emit("state", Array.from(players.values()).map((p) => p.publicState()));
    io.emit("monsters", Array.from(activeMonsters.values()).map((m) => m.publicState()));
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Pixel Realm server listening on port ${PORT}`);
});
