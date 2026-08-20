// Regression test for the batch-6 flying-minigame changes:
// - "halfway through the enemy dragons start shooting 2 fireballs that
//   spread out a little bit" (server/flying.js's ENEMY_FIRE_SPREAD_RAD +
//   the "waves" phase tick in server/index.js)
// - "the [boss beam] fires off more often but only shoots across 75% of
//   the screen" (BOSS_BEAM_INTERVAL_*_MS lowered + BOSS_BEAM_SWEEP_FRACTION)
// - "a little bit more of a pause before the final dragon dies before the
//   player whooshes away" (BOSS_DEATH_FX_MS raised from 1800 to 3200)
//
// Same "hand-built state, exercise the real per-tick logic in-process"
// approach as tools/flying_redo_test.js / tools/flying_boss_beam_test.js.
const { io } = require("socket.io-client");
const flyingModule = require("../server/flying.js");
const srv = require("../server/index.js");
const assert = require("assert");

const PORT = 3931;
const URL = `http://localhost:${PORT}`;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ["polling", "websocket"] });
    const timeout = setTimeout(() => reject(new Error("join timeout")), 8000);
    socket.on("connect", () => {
      socket.emit("join", { name, color: "blue", race: "human" }, (ack) => {
        clearTimeout(timeout);
        resolve({ socket, ack });
      });
    });
    socket.on("connect_error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

(async () => {
  await new Promise((resolve) => srv.server.listen(PORT, resolve));

  check(flyingModule.BOSS_DEATH_FX_MS === 3200, `BOSS_DEATH_FX_MS was raised to give more time to read the victory bubble (got ${flyingModule.BOSS_DEATH_FX_MS})`);
  check(flyingModule.BOSS_BEAM_SWEEP_FRACTION === 0.75, `boss beam only sweeps 75% of the arena width (got ${flyingModule.BOSS_BEAM_SWEEP_FRACTION})`);
  check(flyingModule.BOSS_BEAM_INTERVAL_MAX_MS < 6500, `boss beam fires more often than the original 6.5-9.5s window (max=${flyingModule.BOSS_BEAM_INTERVAL_MAX_MS})`);

  // --- Before the halfway point, a due enemy still fires exactly ONE
  // aimed fireball (unchanged early-game behavior). -----------------------
  {
    const { socket, ack } = await connect("PreHalfway");
    const player = srv.players.get(ack.you.id);
    const now = Date.now();
    srv.enterFlying(player, now);
    player.flying.startedAt = now; // elapsed ~0, well before DURATION_MS/2
    player.flying.enemies.push({
      id: "e1", x: player.x + 2, y: player.y, hp: 99, maxHp: 99,
      lastAttackAt: 0, nextFireAt: now - 1,
    });
    await sleep(150);
    check(player.flying.enemyProjectiles.length === 1, `pre-halfway: exactly one fireball fired (got ${player.flying.enemyProjectiles.length})`);
    socket.disconnect();
  }

  // --- Past the halfway point, a due enemy fires TWO fireballs fanned
  // around the aimed-at-cast-time angle. -----------------------------------
  {
    const { socket, ack } = await connect("PostHalfway");
    const player = srv.players.get(ack.you.id);
    const now = Date.now();
    srv.enterFlying(player, now);
    // Backdate startedAt so elapsed is comfortably past DURATION_MS/2.
    player.flying.startedAt = now - (flyingModule.DURATION_MS / 2 + 500);
    player.x = 5; player.y = 5;
    player.flying.enemies.push({
      id: "e2", x: player.x + 3, y: player.y, hp: 99, maxHp: 99,
      lastAttackAt: 0, nextFireAt: now - 1,
    });
    await sleep(150);
    const projs = player.flying.enemyProjectiles;
    check(projs.length === 2, `post-halfway: exactly two fireballs fired (got ${projs.length})`);
    if (projs.length === 2) {
      const a1 = Math.atan2(projs[0].vy, projs[0].vx);
      const a2 = Math.atan2(projs[1].vy, projs[1].vx);
      let diff = a1 - a2;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // normalize into [-pi, pi]
      const spread = Math.abs(diff);
      check(Math.abs(spread - flyingModule.ENEMY_FIRE_SPREAD_RAD) < 1e-6, `the two shots are separated by exactly ENEMY_FIRE_SPREAD_RAD (got ${spread.toFixed(4)})`);
      const speed1 = Math.hypot(projs[0].vx, projs[0].vy);
      const speed2 = Math.hypot(projs[1].vx, projs[1].vy);
      check(Math.abs(speed1 - flyingModule.ENEMY_FIRE_SPEED) < 1e-6 && Math.abs(speed2 - flyingModule.ENEMY_FIRE_SPEED) < 1e-6, "both shots still travel at ENEMY_FIRE_SPEED");
    }
    socket.disconnect();
  }

  // --- Boss beam sweep only covers BOSS_BEAM_SWEEP_FRACTION of the arena,
  // not the full width -- confirm the boss stops well short of the true
  // far edge once the pass completes. --------------------------------------
  {
    const { socket, ack } = await connect("BeamWidthCheck");
    const player = srv.players.get(ack.you.id);
    const now = Date.now();
    player.area = "flying";
    player.maxHp = 999; player.hp = 999;
    player.flying = flyingModule.newFlyingState(now);
    player.flying.phase = "boss";
    player.flying.boss = flyingModule.newBossState(now);
    player.flying.boss.nextFireAt = now + 999999;
    player.flying.boss.nextBeamAt = now; // due immediately
    // Keep the player far from the beam's path so this check is purely
    // about the sweep's travel distance, not the hit-detection logic
    // (already covered by tools/flying_boss_beam_test.js).
    player.x = flyingModule.ARENA_W / 2;
    player.y = flyingModule.ARENA_H - flyingModule.PLAYER_PAD;

    let endedX = null;
    let startedDir = null;
    socket.on("flying_boss_beam_start", (info) => { startedDir = info.dir; });
    socket.on("flying_boss_beam_end", () => { endedX = player.flying.boss.x; });

    const deadline = Date.now() + flyingModule.BOSS_BEAM_TELEGRAPH_MS + (flyingModule.ARENA_W / flyingModule.BOSS_BEAM_STRAFE_SPEED) * 1000 + 2000;
    while (Date.now() < deadline && endedX === null) await sleep(50);

    assert.ok(endedX !== null, "the beam pass completed within the expected window");
    const fullTravel = flyingModule.ARENA_W - flyingModule.PLAYER_PAD * 2;
    const expectedEndX = startedDir === 1
      ? flyingModule.PLAYER_PAD + fullTravel * flyingModule.BOSS_BEAM_SWEEP_FRACTION
      : (flyingModule.ARENA_W - flyingModule.PLAYER_PAD) - fullTravel * flyingModule.BOSS_BEAM_SWEEP_FRACTION;
    // Tolerance accounts for one tick's worth of strafe movement
    // (BOSS_BEAM_STRAFE_SPEED * TICK_MS) overshooting the exact endX before
    // the reachedEnd check fires on the next tick.
    check(Math.abs(endedX - expectedEndX) < 0.25, `the sweep stops at 75% of the full travel, not the true far edge (endedX=${endedX.toFixed(2)}, expected=${expectedEndX.toFixed(2)})`);
    const trueFarEdge = startedDir === 1 ? flyingModule.ARENA_W - flyingModule.PLAYER_PAD : flyingModule.PLAYER_PAD;
    check(Math.abs(endedX - trueFarEdge) > 1.0, `stops well short of the true far edge, leaving a safe strip to run to (endedX=${endedX.toFixed(2)}, trueFarEdge=${trueFarEdge})`);
    socket.disconnect();
  }

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL FLYING BATCH-6 CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
