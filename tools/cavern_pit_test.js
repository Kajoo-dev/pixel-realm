// Regression test for "add pits with spikes in the cave side-scroller that
// kill the player if he falls in, you have to jump over them" -- validates
// the pit-generation shape (jumpable widths, kept out of the boss arena/
// entrance) and, live against the real server, that walking straight into a
// pit without jumping is fatal while jumping over one is safe.
//
// Binds its own port in-process (same rationale as tools/flying_redo_test.js)
// so this test can drive real applyCavernInput ticks via actual "input"
// socket events and observe the real hp/death outcome.
const { io } = require("socket.io-client");
const cavernModule = require("../server/cavern.js");
const srv = require("../server/index.js");

const PORT = 3923;
const URL = `http://localhost:${PORT}`;
const TICK_MS = 50;
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

  // --- Shape checks on the real generated level -----------------------------
  const level = srv.cavernLevel;
  check(Array.isArray(level.pits) && level.pits.length > 0, `cavern level has pits generated (got ${level.pits && level.pits.length})`);
  const MAX_SAME_TIER_GAP = 3.0; // mirrors cavern.js's own documented jumpable-gap margin
  check(level.pits.every((p) => p.x1 - p.x0 <= MAX_SAME_TIER_GAP), "every pit is within the same jumpable-gap margin used for platform tiers");
  check(level.pits.every((p) => p.x1 < level.bossArenaStart), "no pit reaches into the boss arena");
  check(level.pits.every((p) => p.x0 > 8), "no pit sits right at the entrance");

  // Cavern monsters (goblins/trolls) are placed by the same seeded PRNG
  // stream as the pits and can end up right next to one -- e.g. a troll at
  // x~19.19 sits almost exactly on pit[0]'s edge (x0~19.16) -- plus fire
  // bats spawn on their own periodic timer (every 6-14s, see index.js's
  // nextFireBatSpawnAt) that isn't bounded by this test's live-check
  // wall-clock window, so a bat can appear mid-check even after an initial
  // clear. Either source of incidental combat damage can kill the test
  // player before the pit mechanic itself is exercised, producing a
  // false-positive "died" (or, if it happens to land near the survival
  // check instead, masking a false-negative). Clearing nearby monsters up
  // front narrows the first-order risk; giving the player a huge hp buffer
  // closes the rest of it -- the pit's own kill (takeDamage(hp+1), always
  // exactly lethal regardless of current hp) still kills through it, while
  // no incidental hit from a stray monster can get through in the ~2s a
  // check runs for.
  function clearMonstersNear(x, radius) {
    for (const [id, m] of srv.cavernMonsters.entries()) {
      if (Math.abs(m.x - x) < radius) srv.cavernMonsters.delete(id);
    }
  }

  // --- Live: walking straight into a pit (no jump) is fatal -----------------
  {
    const { socket, ack } = await connect("PitFallCheck");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    const pit = level.pits[0];
    clearMonstersNear((pit.x0 + pit.x1) / 2, 15);
    player.hp = player.maxHp = 1000; // see the comment above -- immune to incidental combat, not to the pit's own kill
    player.x = pit.x0 - 0.3; // right at the pit's edge
    player.y = level.groundY;
    player.grounded = true;
    player.vy = 0;

    let died = false;
    socket.on("player_died", (info) => { if (info.id === socket.id) died = true; });

    socket.emit("input", { left: false, right: true, up: false, down: false });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !died) await sleep(TICK_MS);
    socket.emit("input", { left: false, right: false, up: false, down: false });

    check(died, "walking straight into a pit (no jump) kills the player");
    socket.disconnect();
  }

  // --- Live: jumping over the same pit survives ------------------------------
  {
    const { socket, ack } = await connect("PitJumpCheck");
    const player = srv.players.get(ack.you.id);
    srv.enterCavern(player);
    const pit = level.pits[0];
    clearMonstersNear((pit.x0 + pit.x1) / 2, 15);
    player.hp = player.maxHp = 1000; // see the comment above -- immune to incidental combat, not to the pit's own kill
    player.x = pit.x0 - 1.5; // a short run-up before the pit
    player.y = level.groundY;
    player.grounded = true;
    player.vy = 0;

    let died = false;
    socket.on("player_died", (info) => { if (info.id === socket.id) died = true; });

    socket.emit("input", { left: false, right: true, up: false, down: false });
    await sleep(150); // build a little run-up speed first
    socket.emit("jump");
    await sleep(1400); // clear the pit's width at CAVERN_HSPEED with the jump arc
    socket.emit("input", { left: false, right: false, up: false, down: false });
    await sleep(300);

    console.log("post-jump player x:", player.x, "pit:", pit, "died:", died);
    check(!died, "jumping over the pit does NOT kill the player");
    check(player.x > pit.x1, `player actually cleared the pit (x=${player.x}, pit.x1=${pit.x1})`);
    socket.disconnect();
  }

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL CAVERN PIT CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
