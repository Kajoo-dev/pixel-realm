const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { generateMap } = require("./map");

const PORT = process.env.PORT || 3000;
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const SPEED_TILES_PER_SEC = 4.5;
const PLAYER_RADIUS = 0.32; // collision half-width, in tiles
const MAX_NAME_LEN = 16;
const COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];

const world = generateMap(60, 42, 1337);

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, Player>} */
const players = new Map();

function isBlocked(tx, ty) {
  if (tx < 0 || ty < 0 || ty >= world.height || tx >= world.width) return true;
  return world.collision[ty][tx] === 1;
}

function canStandAt(x, y) {
  const corners = [
    [x - PLAYER_RADIUS, y - PLAYER_RADIUS],
    [x + PLAYER_RADIUS, y - PLAYER_RADIUS],
    [x - PLAYER_RADIUS, y + PLAYER_RADIUS],
    [x + PLAYER_RADIUS, y + PLAYER_RADIUS],
  ];
  for (const [cx, cy] of corners) {
    if (isBlocked(Math.floor(cx), Math.floor(cy))) return false;
  }
  return true;
}

function findOpenSpawn() {
  const { x, y } = world.spawn;
  if (canStandAt(x + 0.5, y + 0.5)) return { x: x + 0.5, y: y + 0.5 };
  for (let r = 1; r < 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx + 0.5;
        const ny = y + dy + 0.5;
        if (canStandAt(nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return { x: x + 0.5, y: y + 0.5 };
}

function sanitizeName(raw) {
  const s = String(raw || "").replace(/[^\w \-'.]/g, "").trim().slice(0, MAX_NAME_LEN);
  return s.length ? s : "Wanderer";
}

class Player {
  constructor(id, name, color) {
    this.id = id;
    this.name = sanitizeName(name);
    this.color = COLORS.includes(color) ? color : COLORS[Math.floor(Math.random() * COLORS.length)];
    const spawn = findOpenSpawn();
    this.x = spawn.x;
    this.y = spawn.y;
    this.dir = "down";
    this.moving = false;
    this.input = { up: false, down: false, left: false, right: false };
  }

  applyInput(dt) {
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

    if (canStandAt(nx, this.y)) this.x = nx;
    if (canStandAt(this.x, ny)) this.y = ny;
  }

  publicState() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      dir: this.dir,
      moving: this.moving,
    };
  }
}

io.on("connection", (socket) => {
  socket.on("join", (payload, ack) => {
    if (players.has(socket.id)) return;
    const player = new Player(socket.id, payload && payload.name, payload && payload.color);
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
        colors: COLORS,
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

  socket.on("chat", (text) => {
    const player = players.get(socket.id);
    if (!player) return;
    const clean = String(text || "").slice(0, 140).trim();
    if (!clean) return;
    io.emit("chat", { id: player.id, name: player.name, text: clean, t: Date.now() });
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
  }

  if (players.size > 0) {
    io.emit(
      "state",
      Array.from(players.values()).map((p) => p.publicState())
    );
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Pixel Realm server listening on port ${PORT}`);
});
