// Regression test for the cave's ceiling + falling spikes (see
// server/index.js's tick loop and server/cavern.js's CEILING_Y): "add a
// ceiling in the side scroller area, about 10 tiles high, and have random
// spikes that drop down in a straight line to hit the player, if it hits
// them they die instantly."
//
// Binds its own port in-process (same rationale as other tools/*_test.js
// files) so this test can drive the real tick loop against directly-
// injected srv.cavernFallingSpikes entries and observe the real hit/kill
// logic, plus confirm the real Math.random()-driven spawn path actually
// produces spikes near a live player.
const { io } = require("socket.io-client");
const cavernModule = require("../server/cavern.js");
const srv = require("../server/index.js");

const PORT = 3927;
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

  check(cavernModule.CEILING_Y === srv.cavernLevel.groundY - 10, `ceiling sits exactly 10 tiles above the ground (ceilingY=${cavernModule.CEILING_Y}, groundY=${srv.cavernLevel.groundY})`);
  check(srv.CAVERN_MONSTER_RESPAWN_MS >= 45000, `cavern monster respawn timer was increased from its original 15s (got ${srv.CAVERN_MONSTER_RESPAWN_MS}ms)`);

  // --- Case 1: a spike that reaches a standing player kills them instantly.
  {
    const { socket, ack } = await connect("SpikeHitCheck");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    player.x = 40;
    player.y = srv.cavernLevel.groundY;
    player.grounded = true;

    let died = false;
    socket.on("player_died", (info) => { if (info.id === socket.id) died = true; });

    const id = "test_spike_hit";
    srv.cavernFallingSpikes.set(id, { id, x: player.x, y: cavernModule.CEILING_Y, telegraphUntil: Date.now() - 1 }); // no telegraph delay -- falls immediately

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !died) await sleep(50);

    check(died, "a falling spike that reaches the player's position kills them instantly");
    socket.disconnect();
  }

  // --- Case 2: still telegraphing (hasn't started falling yet) does NOT hit,
  // even positioned exactly on the player. ------------------------------
  {
    const { socket, ack } = await connect("SpikeTelegraphCheck");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    player.x = 45;
    player.y = srv.cavernLevel.groundY;
    player.grounded = true;

    let died = false;
    socket.on("player_died", (info) => { if (info.id === socket.id) died = true; });

    const id = "test_spike_telegraph";
    srv.cavernFallingSpikes.set(id, { id, x: player.x, y: cavernModule.CEILING_Y, telegraphUntil: Date.now() + 5000 }); // long telegraph -- should not fall/hit within this check's window

    await sleep(600);
    check(!died, "a spike still telegraphing (hasn't started falling) does not hit the player");
    check(srv.cavernFallingSpikes.get(id).y === cavernModule.CEILING_Y, "a telegraphing spike hasn't moved from the ceiling yet");
    srv.cavernFallingSpikes.delete(id); // cleanup so it doesn't bleed into later checks
    socket.disconnect();
  }

  // --- Case 3: a spike well clear of the player (different x) never hits
  // them, and eventually lands and is removed. --------------------------
  {
    const { socket, ack } = await connect("SpikeMissCheck");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    player.x = 60;
    player.y = srv.cavernLevel.groundY;
    player.grounded = true;

    let died = false;
    socket.on("player_died", (info) => { if (info.id === socket.id) died = true; });

    const id = "test_spike_miss";
    srv.cavernFallingSpikes.set(id, { id, x: player.x + 5, y: cavernModule.CEILING_Y, telegraphUntil: Date.now() - 1 });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && srv.cavernFallingSpikes.has(id)) await sleep(50);

    check(!died, "a spike falling well clear of the player's x never hits them");
    check(!srv.cavernFallingSpikes.has(id), "the spike is removed once it lands on the ground");
    socket.disconnect();
  }

  // --- Case 4: the real spawn path (Math.random()-driven, same convention
  // as the fire bats) actually produces spikes near a live player, and never
  // inside the boss arena. -----------------------------------------------
  {
    const { socket, ack } = await connect("SpikeSpawnCheck");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    player.x = 80;
    player.y = srv.cavernLevel.groundY;
    player.grounded = true;

    let sawSpike = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !sawSpike) {
      if (srv.cavernFallingSpikes.size > 0) sawSpike = true;
      await sleep(100);
    }
    check(sawSpike, "the real Math.random()-driven spawn path produces at least one spike within a few seconds of a player being in the cavern");
    check(
      Array.from(srv.cavernFallingSpikes.values()).every((s) => s.x < srv.cavernLevel.bossArenaStart - 5),
      "no spike spawns inside (or right at the edge of) the boss arena"
    );
    socket.disconnect();
  }

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL CAVERN FALLING SPIKE CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
