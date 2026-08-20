// Regression test for per-area respawn behavior: dying in the general cave
// side-scroller respawns at its start, dying specifically inside the giant
// boss goblin's arena respawns right before that arena's door instead of
// all the way back at the cave entrance, dying during the dragon flight
// restarts that same encounter, and dying anywhere else (outside/tavern/
// cliff) keeps the previous graveyard-area behavior. See server/index.js's
// respawn block in the main tick loop.
//
// Binds its own port in-process (same rationale as tools/flying_redo_test.js
// -- .listen() is guarded by require.main === module) so this test can hand-
// set player.dead/deadAt/area/x directly and observe the real tick loop's
// respawn logic run against them.
const { io } = require("socket.io-client");
const srv = require("../server/index.js");

const PORT = 3922;
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

// Forces a player into a dead state at a given area/position and waits for
// the real respawn tick to fire, then returns the post-respawn player.
async function killAndWaitForRespawn(player) {
  player.dead = true;
  player.deadAt = Date.now();
  await sleep(3600); // PLAYER_RESPAWN_DELAY_MS (3000) + a tick or two of slack
  return player;
}

(async () => {
  await new Promise((resolve) => srv.server.listen(PORT, resolve));

  // --- Case 1: died in the general cave (before the boss arena) ------------
  {
    const { socket, ack } = await connect("RespawnCave");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    player.x = srv.cavernLevel.bossArenaStart - 20; // well before the arena
    player.y = srv.cavernLevel.groundY;
    await killAndWaitForRespawn(player);
    check(!player.dead, "player is alive again after the respawn delay (general cave death)");
    check(player.area === "cavern", `respawns back in the cavern (got area=${player.area})`);
    check(Math.abs(player.x - srv.cavernLevel.spawn.x) < 0.5, `respawns at the cave's start (x=${player.x}, expected ~${srv.cavernLevel.spawn.x})`);
    socket.disconnect();
  }

  // --- Case 2: died inside the boss arena -----------------------------------
  {
    const { socket, ack } = await connect("RespawnBoss");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    player.x = srv.cavernLevel.bossArenaStart + 4; // inside the arena
    player.y = srv.cavernLevel.groundY;
    await killAndWaitForRespawn(player);
    check(!player.dead, "player is alive again after the respawn delay (boss death)");
    check(player.area === "cavern", `respawns back in the cavern (got area=${player.area})`);
    check(
      player.x < srv.cavernLevel.bossArenaStart && player.x > srv.cavernLevel.bossArenaStart - 10,
      `respawns just before the boss arena, not all the way at the cave start (x=${player.x}, bossArenaStart=${srv.cavernLevel.bossArenaStart})`
    );
    socket.disconnect();
  }

  // --- Case 3: died mid dragon-flight ----------------------------------------
  {
    const { socket, ack } = await connect("RespawnFlying");
    const player = srv.players.get(ack.you.id);
    srv.enterFlying(player, Date.now());
    const flyingInstanceBefore = player.flying;
    await killAndWaitForRespawn(player);
    check(!player.dead, "player is alive again after the respawn delay (flying death)");
    check(player.area === "flying", `respawns back into the dragon flight (got area=${player.area})`);
    check(!!player.flying && player.flying !== flyingInstanceBefore, "a fresh flying instance was started (not the stale dead one)");
    check(player.hp === player.maxHp, "player is topped back up to full hp");
    socket.disconnect();
  }

  // --- Case 4: died in the outside world -- unchanged graveyard behavior ---
  {
    const { socket, ack } = await connect("RespawnOutside");
    const player = srv.players.get(ack.you.id);
    player.area = "outside";
    player.x = 5; player.y = 5; // arbitrary, away from the graveyard
    await killAndWaitForRespawn(player);
    check(!player.dead, "player is alive again after the respawn delay (outside death)");
    check(player.area === "outside", `respawns in the outside world (got area=${player.area})`);
    const g = srv.world.graveyard.spawn;
    check(Math.abs(player.x - g.x) < 3 && Math.abs(player.y - g.y) < 3, `respawns near the graveyard, not the cave (x=${player.x}, y=${player.y}, graveyard=${JSON.stringify(g)})`);
    socket.disconnect();
  }

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL PER-AREA RESPAWN CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
