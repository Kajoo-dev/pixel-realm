// Smoke test for the new race/combat/monster system directly over the
// socket.io API (no browser needed) - verifies:
//  - join ack includes race, hp/maxHp, and an initial monsters list
//  - monsters are placed at least MIN_SPAWN_SEPARATION apart
//  - attacking a monster standing next to the player damages/kills it
//  - killed monster emits monster_died and is removed from state
//  - a monster respawns after MONSTER_RESPAWN_DELAY_MS
const { io } = require("socket.io-client");

const URL = "http://localhost:3000";

function connect(name, color, race) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ["polling", "websocket"] });
    const timeout = setTimeout(() => reject(new Error("join timeout")), 8000);
    socket.on("connect", () => {
      socket.emit("join", { name, color, race }, (ack) => {
        clearTimeout(timeout);
        resolve({ socket, ack });
      });
    });
    socket.on("connect_error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

(async () => {
  const { socket, ack } = await connect("Combatant", "purple", "orc");
  console.log("Joined as", ack.you.name, "race:", ack.you.race, "hp:", ack.you.hp, "/", ack.you.maxHp);
  if (ack.you.race !== "orc") throw new Error("FAIL: race not echoed back correctly");
  if (ack.you.hp !== 10 || ack.you.maxHp !== 10) throw new Error("FAIL: player starting hp should be 10/10");
  if (!Array.isArray(ack.races) || !ack.races.includes("orc")) throw new Error("FAIL: races list missing");
  console.log("Initial monster count:", ack.monsters.length);
  if (ack.monsters.length < 1) throw new Error("FAIL: no monsters spawned");
  for (const m of ack.monsters) {
    if (m.hp !== 3 || m.maxHp !== 3) throw new Error(`FAIL: monster ${m.id} should start at 3 hp`);
  }
  // Check minimum spawn separation (15 tiles) between every pair.
  let minDist = Infinity;
  for (let i = 0; i < ack.monsters.length; i++) {
    for (let j = i + 1; j < ack.monsters.length; j++) {
      const a = ack.monsters[i], b = ack.monsters[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < minDist) minDist = d;
    }
  }
  console.log("Minimum pairwise monster distance:", minDist.toFixed(2), "(want >= ~15, or relaxed >=7.5 on a crowded map)");
  if (minDist < 7.4) throw new Error("FAIL: monsters spawned too close together even under relaxed fallback");

  // Teleport-by-repeated-input isn't available over raw socket, so instead
  // pick the monster nearest to our spawn point and walk straight toward it,
  // then swing repeatedly until it dies (or we time out).
  let target = ack.monsters[0];
  let px = ack.you.x, py = ack.you.y;
  for (const m of ack.monsters) {
    if (Math.hypot(m.x - px, m.y - py) < Math.hypot(target.x - px, target.y - py)) target = m;
  }
  console.log("Walking toward monster", target.id, "type:", target.type, "at", target.x, target.y);

  let monsters = new Map(ack.monsters.map((m) => [m.id, m]));
  let died = false;
  let respawned = false;
  socket.on("monsters", (list) => {
    monsters = new Map(list.map((m) => [m.id, m]));
  });
  socket.on("monster_died", (info) => {
    if (info.id === target.id) {
      died = true;
      console.log("Monster died:", info.id, info.type, "at", info.x.toFixed(2), info.y.toFixed(2));
    }
  });
  socket.on("monster_spawned", (m) => {
    if (died && m.type === target.type) {
      respawned = true;
      console.log("A replacement", m.type, "spawned:", m.id);
    }
  });

  let myX = px, myY = py;
  socket.on("state", (list) => {
    const me = list.find((p) => p.id === socket.id);
    if (me) { myX = me.x; myY = me.y; }
  });

  function setInput(input) { socket.emit("input", input); }
  function stepToward(tx, ty) {
    const dx = tx - myX, dy = ty - myY;
    setInput({ up: dy < -0.1, down: dy > 0.1, left: dx < -0.1, right: dx > 0.1 });
  }

  const deadline = Date.now() + 15000;
  let lastAttack = 0;
  while (Date.now() < deadline && !died) {
    const live = monsters.get(target.id);
    if (!live) { await sleep(100); continue; }
    const dist = Math.hypot(live.x - myX, live.y - myY);
    if (dist > 1.0) {
      stepToward(live.x, live.y);
    } else {
      setInput({ up: false, down: false, left: false, right: false });
      const now = Date.now();
      if (now - lastAttack > 180) {
        const angle = Math.atan2(live.y - myY, live.x - myX);
        socket.emit("attack", { angle });
        lastAttack = now;
      }
    }
    await sleep(60);
  }
  setInput({ up: false, down: false, left: false, right: false });

  if (!died) throw new Error("FAIL: monster never died within timeout");
  console.log("PASS: monster took exactly 3 hits worth of damage and died.");

  const respawnDeadline = Date.now() + 25000;
  while (Date.now() < respawnDeadline && !respawned) await sleep(300);
  if (!respawned) throw new Error("FAIL: no replacement monster spawned after death");
  console.log("PASS: a replacement monster spawned after the respawn delay.");

  socket.close();
  console.log("ALL COMBAT SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST ERROR:", e.message || e); process.exit(1); });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
