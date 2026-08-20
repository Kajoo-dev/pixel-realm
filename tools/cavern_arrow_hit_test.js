// Regression test for a user report: "the arrows from the enemy goblins in
// the side scroller can hit the player, they seemed to just pass through
// and do no damage." Root-caused to two compounding bugs, both fixed here:
//   1. TROLL_ARROW_DAMAGE (server/cavern.js) was left at its original
//      pre-balance-pass value of 1 when melee GOBLIN_DAMAGE got its 5->50
//      (10x) bump -- 1 damage against a 10-max-hp player is nearly
//      imperceptible.
//   2. The "cavern_arrow_hit" socket event (server/index.js) never included
//      a targetId, so game.js's handler had no way to set hitFlashUntil on
//      the player that got hit -- EVERY other player-damage source in the
//      game (monster_attack, cavern_monster_attack, boss shout/slam, dragon
//      fire) flashes the target; arrow hits alone did not, so even a
//      correctly-applied hit produced zero visual feedback.
// Binds its own port in-process (same rationale as tools/flying_redo_test.js
// -- .listen() is guarded by require.main === module, so requiring index.js
// here never double-binds the real dev server's port, and this test needs
// direct access to the live `players`/`cavernMonsters` maps after emitting
// real socket events).
const { io } = require("socket.io-client");
const cavernModule = require("../server/cavern.js");
const srv = require("../server/index.js");

const PORT = 3921;
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

  // --- The damage constant itself is meaningfully bumped -------------------
  check(cavernModule.TROLL_ARROW_DAMAGE >= 10, `troll arrow damage is a real hit, not the old imperceptible 1 (got ${cavernModule.TROLL_ARROW_DAMAGE})`);

  // --- Live: a real troll's arrow actually damages a real player, and the
  // hit event carries a targetId the client can use for hit-flash ----------
  const { socket, ack } = await connect("ArrowHitCheck", "orange", "human");
  const player = srv.players.get(ack.you.id);

  srv.enterCavern(player);
  await sleep(50);

  let troll = null;
  for (const m of srv.cavernMonsters.values()) {
    if (m.type === "troll" && !m.dead) { troll = m; break; }
  }
  check(!!troll, "a live troll (ranged enemy) exists in the cavern to test against");
  if (!troll) { socket.close(); process.exit(1); }

  let hp = player.hp;
  let died = false;
  let sawTargetId = false;
  socket.on("state", (list) => {
    const me = list.find((p) => p.id === socket.id);
    if (me) hp = me.hp;
  });
  socket.on("player_died", (info) => { if (info.id === socket.id) died = true; });
  socket.on("cavern_arrow_hit", (info) => {
    if (info.hitType === "player" && info.targetId === player.id) sawTargetId = true;
  });

  const startHp = player.hp;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && hp >= startHp && !died) {
    // Hold the player directly in the troll's line of fire -- no input is
    // sent, so nothing else moves it.
    player.x = troll.x - 3;
    player.y = troll.y;
    await sleep(100);
  }

  console.log("start hp:", startHp, "final hp:", hp, "died:", died);
  check(died || hp < startHp, "player actually loses hp from a real cavern arrow hit (was previously registering, just imperceptibly)");
  check(sawTargetId, "cavern_arrow_hit for a player hit includes targetId (drives the client's hit-flash)");

  socket.disconnect();
  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL CAVERN ARROW HIT CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
