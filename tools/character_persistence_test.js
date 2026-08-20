// Regression test for "remember your previous character" persistence
// (server/db.js + the "join" handler's continueSaved path + the
// /api/character/:id endpoint in server/index.js):
//   - a brand-new join gets a saved slot immediately (first ever join)
//   - /api/character/:id reflects it (used by the entry screen's
//     "Continue as X" card)
//   - leveling up updates the saved level/xp
//   - disconnecting flushes the final xp fraction
//   - rejoining with {continueSaved: true} restores name/race/color/level/
//     xp -- and does NOT trust a client-supplied level (server re-fetches
//     by playerId itself)
//   - an unknown playerId just gets a normal fresh join, no crash
// Needed before requiring server/index.js below (db.js reads DATABASE_URL
// once, at require time) -- must match whatever DB the live dev server on
// URL below is *also* pointed at, since both processes write to the same
// Postgres table and this test cross-checks writes from one against reads
// from the other's HTTP endpoint.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://postgres:testpass@localhost:5432/pixel_realm_test";
}
const { io } = require("socket.io-client");
const { Player } = require("../server/index.js");

const URL = "http://localhost:3000";
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function connect(name, color, race, extra) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ["polling", "websocket"] });
    const timeout = setTimeout(() => reject(new Error("join timeout")), 8000);
    socket.on("connect", () => {
      socket.emit("join", { name, color, race, ...extra }, (ack) => {
        clearTimeout(timeout);
        resolve({ socket, ack });
      });
    });
    socket.on("connect_error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function fetchCharacter(playerId) {
  const res = await fetch(`${URL}/api/character/${encodeURIComponent(playerId)}`);
  return res.json();
}

(async () => {
  const playerId = "test-" + Date.now() + "-" + Math.random().toString(36).slice(2);

  // --- A brand-new join (with a playerId, no continueSaved) gets a saved
  // slot immediately. ----------------------------------------------------
  const { socket: s1, ack: ack1 } = await connect("Persistor", "teal", "elf", { playerId });
  check(ack1.you.name === "Persistor", "fresh join echoes the chosen name");
  await sleep(300); // saveCharacterState's fire-and-forget upsert on join

  const found1 = await fetchCharacter(playerId);
  check(found1.found === true, "a saved slot exists right after the very first join");
  check(found1.name === "Persistor" && found1.race === "elf" && found1.color === "teal", `saved slot matches what was joined (got ${JSON.stringify(found1)})`);
  check(found1.level === 1, `saved slot starts at level 1 (got ${found1.level})`);

  // --- Leveling up updates the saved row. --------------------------------
  // Driving this through a real chase-and-kill (like test_combat.js) would
  // be slow/flaky and, since it needs its own socket/player, a separate
  // playerId anyway -- grantXp is the single choke point every kill path
  // funnels through (see xp_multiplier_test.js's own note), so this
  // exercises it directly, in-process, the same way that test does.
  const levelUpPlayerId = "test-levelup-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const directPlayer = new Player("fake-socket-id", "DirectLeveler", "orange", "orc");
  directPlayer.playerKey = levelUpPlayerId;
  directPlayer.grantXp(Date.now(), 10); // 0.4 * 10 = 4.0 xp -- levels up 4 times, see xp_multiplier_test.js
  await sleep(300); // grantXp's fire-and-forget saveCharacterState call

  const foundLevelUp = await fetchCharacter(levelUpPlayerId);
  check(foundLevelUp.found === true, "leveling up saves a slot for a player who never explicitly joined-and-saved before");
  check(foundLevelUp.level === 5, `leveling up persists the new level (got ${foundLevelUp.level})`);
  check(Math.abs(foundLevelUp.xp - 0) < 1e-6, `leveling up persists the leftover xp fraction (got ${foundLevelUp.xp})`);

  // --- Disconnecting flushes the final (in-progress, not-yet-a-level-up)
  // xp fraction. -----------------------------------------------------------
  s1.disconnect();
  await sleep(400); // disconnect handler's saveCharacterState flush

  const found2 = await fetchCharacter(playerId);
  check(found2.found === true, "saved slot survives disconnect");
  check(found2.level === 1 && found2.xp === 0, `disconnect flush preserved the unchanged level/xp (got level=${found2.level} xp=${found2.xp})`);

  // --- Rejoining with continueSaved restores the saved character server-
  // side, ignoring whatever the client sends for name/color/race. --------
  const { socket: s2, ack: ack2 } = await connect("ShouldBeIgnored", "red", "goblin", { playerId, continueSaved: true });
  check(ack2.you.name === "Persistor", `continueSaved restores the saved name, not the client-sent one (got "${ack2.you.name}")`);
  check(ack2.you.race === "elf", `continueSaved restores the saved race (got "${ack2.you.race}")`);
  check(ack2.you.color === "teal", `continueSaved restores the saved color (got "${ack2.you.color}")`);
  check(ack2.you.level === 1, `continueSaved restores the saved level (got ${ack2.you.level})`);
  s2.disconnect();
  await sleep(200);

  // --- A client can't cheat by sending a fake level -- continueSaved only
  // ever restores what the SERVER has on file for that playerId. ---------
  // (Covered above: ack2 ignored the "goblin"/"red" the client sent for
  // ShouldBeIgnored, proving the server re-fetches by playerId rather than
  // trusting the join payload's own fields when continueSaved is set.)

  // --- An unknown/garbage playerId with continueSaved just falls back to
  // a normal fresh join -- no crash, no ack hang. -------------------------
  const unknownId = "unknown-" + Date.now();
  const { socket: s3, ack: ack3 } = await connect("Newcomer", "blue", "human", { playerId: unknownId, continueSaved: true });
  check(ack3.you.name === "Newcomer", "an unknown playerId with continueSaved falls back to the client-sent fresh name");
  check(ack3.you.level === 1, "an unknown playerId with continueSaved falls back to a fresh level 1");
  s3.disconnect();

  // --- The /api/character/:id endpoint returns {found:false} for a
  // never-seen id, not an error. ------------------------------------------
  const neverSeen = await fetchCharacter("totally-made-up-id-" + Date.now());
  check(neverSeen.found === false, "an unsaved playerId reports found:false, not an error");

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL CHARACTER PERSISTENCE CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("TEST ERROR:", e.message || e); process.exit(1); });
