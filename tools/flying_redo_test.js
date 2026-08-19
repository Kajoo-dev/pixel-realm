// Checks for the redone flying minigame (server/flying.js + its index.js
// integration): the spawn ramp genuinely speeds up over time, the 5x damage
// constants, mouse-aim fireballs actually travel toward the requested angle
// (not just straight up), and enemies eventually fire back (bullet-hell).
//
// Binds its OWN port in-process (server.listen() is guarded by
// require.main === module in index.js, so requiring it here doesn't
// double-bind the real dev server's port) rather than connecting to an
// already-running dev server on 3000 -- that matters here because this test
// needs to inspect the live player.flying object after emitting real socket
// events, and two separate `node` processes never share the same in-memory
// `players` Map.
const { io } = require("socket.io-client");
const flyingModule = require("../server/flying.js");
const srv = require("../server/index.js");
const assert = require("assert");

const PORT = 3910;
const URL = `http://localhost:${PORT}`;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  await new Promise((resolve) => srv.server.listen(PORT, resolve));

  // --- spawnIntervalAt genuinely ramps down over elapsed time -----------
  {
    const early = flyingModule.spawnIntervalAt(0);
    const late = flyingModule.spawnIntervalAt(flyingModule.DURATION_MS);
    const mid = flyingModule.spawnIntervalAt(flyingModule.DURATION_MS / 2);
    check(early === flyingModule.ENEMY_SPAWN_INTERVAL_START_MS, `spawn interval starts slow (${early}ms)`);
    check(late === flyingModule.ENEMY_SPAWN_INTERVAL_END_MS, `spawn interval ends fast (${late}ms)`);
    check(mid < early && mid > late, `spawn interval is strictly decreasing partway through (${mid}ms)`);
  }

  // --- 5x contact/fire damage constants ----------------------------------
  check(flyingModule.ENEMY_CONTACT_DAMAGE === 5, `enemy contact damage is 5x the original 1 (got ${flyingModule.ENEMY_CONTACT_DAMAGE})`);
  check(flyingModule.ENEMY_FIRE_DAMAGE === flyingModule.ENEMY_CONTACT_DAMAGE, "enemy fireball damage matches contact damage");

  // --- Live: mouse-aim fireball travels toward the requested angle -------
  {
    const { socket, ack } = await connect("FlyRedoCheck", "orange", "human");
    const player = srv.players.get(ack.you.id);
    assert.ok(player, "joined player exists in the live players map");

    srv.enterFlying(player, Date.now());
    await sleep(100); // let the join settle

    const angle = Math.PI / 4; // down-right
    socket.emit("fly_shoot", { angle });
    await sleep(150); // one server tick+ for the handler to run

    const proj = player.flying.projectiles[player.flying.projectiles.length - 1];
    assert.ok(proj, "a projectile was pushed after emitting fly_shoot with an angle");
    check(proj.vx > 0 && proj.vy > 0, `projectile velocity matches the aimed angle (vx=${proj.vx.toFixed(2)}, vy=${proj.vy.toFixed(2)})`);
    check(Math.abs(Math.hypot(proj.vx, proj.vy) - flyingModule.FIRE_SPEED) < 1e-6, "projectile speed matches FIRE_SPEED regardless of angle");

    // Default (angle omitted) still fires straight up, for the space-bar
    // fallback.
    await sleep(300); // clear FIRE_COOLDOWN_MS
    socket.emit("fly_shoot", {});
    await sleep(150);
    const proj2 = player.flying.projectiles[player.flying.projectiles.length - 1];
    check(proj2 && Math.abs(proj2.vx) < 1e-6 && proj2.vy < 0, "omitting the angle still fires straight up (space-bar fallback)");

    // --- Enemies eventually fire back (bullet-hell) ----------------------
    // Force an enemy into the instance directly (same "hand-built state,
    // exercise the real per-tick logic" approach as cavern_boss_test.js)
    // with nextFireAt already due, then wait a tick for index.js's flying
    // block to process it.
    player.flying.enemies.push({
      id: "test-enemy-1", x: player.x + 2, y: player.y, hp: 99, maxHp: 99,
      lastAttackAt: 0, nextFireAt: Date.now() - 1,
    });
    await sleep(150);
    check(player.flying.enemyProjectiles.length > 0, `an enemy with a due nextFireAt actually fires (got ${player.flying.enemyProjectiles.length} enemy projectiles)`);

    socket.disconnect();
  }

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL FLYING REDO CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})();
