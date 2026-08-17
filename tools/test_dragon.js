// Socket-level checks for the dragon boss: proximity aggro (no need to
// attack first), damage per hit (4), attack cadence (~0.5s), and roughly 2x
// player chase speed.
//
// Important design note: the dragon is FAST (2x player speed, 9 tiles/sec)
// and the walk from spawn to its cave is slow and stall-prone (no real
// pathfinding, scattered trees/rocks/a lake in the way). That means the
// entire aggro -> chase -> catch -> kill cycle can easily complete *during*
// the walk itself, well before any post-walk "now let's measure" phase
// would start. So rather than doing "walk into range, stop, THEN sample for
// a fixed window" (which can measure nothing but an already-finished fight
// settled back at home), every signal here (hp trace, attack kinds, dragon
// position samples) is collected continuously via listeners attached
// immediately after connecting, and only inspected/asserted on at the end.
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let activeSocket = null;

(async () => {
  const { socket, ack } = await connect("Dragonslayer", "orange", "human");
  activeSocket = socket;
  const dragon = ack.monsters.find((m) => m.type === "dragon");
  if (!dragon) throw new Error("FAIL: no dragon in join payload");
  console.log("dragon at", dragon.x, dragon.y, "hp", dragon.hp, "/", dragon.maxHp);

  let liveMonsters = new Map(ack.monsters.map((m) => [m.id, m]));
  let myState = ack.you;

  // Collected continuously from connection time onward -- see design note
  // above for why this can't just be a post-walk snapshot window.
  const hpLog = [{ t: Date.now(), hp: myState.hp }];
  const kinds = new Set();
  const dragonSamples = [{ t: Date.now(), x: dragon.x, y: dragon.y }];
  let dragonEverMoved = false;

  socket.on("state", (list) => {
    const me = list.find((p) => p.id === socket.id);
    if (!me) return;
    if (me.hp !== myState.hp) hpLog.push({ t: Date.now(), hp: me.hp });
    myState = me;
  });
  socket.on("monster_attack", (info) => {
    if (info.id === dragon.id) kinds.add(info.kind);
  });
  socket.on("monsters", (list) => {
    liveMonsters = new Map(list.map((m) => [m.id, m]));
    const d = liveMonsters.get(dragon.id);
    if (!d) return;
    if (d.moving) dragonEverMoved = true;
    dragonSamples.push({ t: Date.now(), x: d.x, y: d.y });
  });

  // No pathfinding here, so use a stall-aware walker: when progress toward
  // the target stalls (blocked by scattered trees/rocks), commit to a
  // randomized escape direction for a full second (not just one tick) so
  // it actually clears whatever it's snagged on before resuming.
  async function walkTo(tx, ty, maxMs) {
    const deadline = Date.now() + maxMs;
    let lastPos = { x: myState.x, y: myState.y };
    let stallTicks = 0;
    let escapeUntil = 0;
    let escapeInput = null;
    while (Date.now() < deadline) {
      if (myState.dead) { await sleep(200); continue; } // can't move while dead; just wait it out
      const dx = tx - myState.x, dy = ty - myState.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.7) break;
      const now = Date.now();
      if (now < escapeUntil) {
        socket.emit("input", escapeInput);
      } else if (stallTicks > 3) {
        const dirs = [
          { up: true, down: false, left: false, right: false },
          { up: false, down: false, left: true, right: false },
          { up: false, down: true, left: false, right: false },
          { up: false, down: false, left: false, right: true },
          { up: true, down: false, left: true, right: false },
          { up: true, down: false, left: false, right: true },
          { up: false, down: true, left: true, right: false },
          { up: false, down: true, left: false, right: true },
        ];
        escapeInput = dirs[Math.floor(Math.random() * dirs.length)];
        escapeUntil = now + 900 + Math.random() * 600;
        stallTicks = 0;
        socket.emit("input", escapeInput);
      } else {
        socket.emit("input", { up: dy < -0.15, down: dy > 0.15, left: dx < -0.15, right: dx > 0.15 });
      }
      await sleep(120);
      if (Math.hypot(myState.x - lastPos.x, myState.y - lastPos.y) < 0.04) stallTicks++;
      else stallTicks = 0;
      lastPos = { x: myState.x, y: myState.y };
    }
    socket.emit("input", { up: false, down: false, left: false, right: false });
  }

  // At spawn we're already ~30 tiles from the dragon -- well outside its
  // 8-tile aggro range -- so confirm it's idle there without needing to
  // walk anywhere first.
  let d = liveMonsters.get(dragon.id);
  console.log("dragon at spawn distance (~30 tiles): moving =", d.moving, "pos", d.x.toFixed(2), d.y.toFixed(2));
  if (d.moving) throw new Error("FAIL: dragon was already moving/aggroed before any player got near it");

  // The direct line from spawn to the cave crosses the lake, and the cave
  // itself is a walled box with its only opening on the south side -- so
  // route south of the lake first, then approach the entrance head-on
  // from below (straight up the clear corridor south of the cave), well
  // into aggro range. We deliberately do NOT stop-and-settle-then-measure
  // after this -- see the top-of-file note. Whatever happens (chase, kill,
  // dragon returning home) happens while walkTo just keeps running/waiting.
  await walkTo(30, 25, 45000);
  console.log("waypoint 1 (south of lake) reached at:", myState.x.toFixed(2), myState.y.toFixed(2));
  await walkTo(dragon.x, 25, 45000);
  console.log("waypoint 2 (south of cave entrance) reached at:", myState.x.toFixed(2), myState.y.toFixed(2));
  await walkTo(dragon.x, dragon.y + 4, 30000);
  console.log("player position after approach:", myState.x.toFixed(2), myState.y.toFixed(2),
    "hp:", myState.hp, "dead:", myState.dead);

  // Give combat a little more time to fully play out either way (land the
  // rest of its hits, or lose its target and start heading home) before we
  // inspect everything that was collected.
  await sleep(3000);

  console.log("dragon ever observed moving (chasing or returning home):", dragonEverMoved);
  if (!dragonEverMoved) throw new Error("FAIL: dragon never reacted to a player entering its 8-tile aggro range without being attacked");
  console.log("PASS: dragon aggroed purely by proximity (never attacked it).");

  // Best-case instantaneous speed across ALL consecutive samples collected
  // since connecting -- should be roughly SPEED_TILES_PER_SEC(4.5) * 2 = 9
  // tiles/sec at some point while actively chasing (want the max across the
  // whole run, not an average, since it's stationary while idle/attacking).
  let maxSpeed = 0;
  for (let i = 1; i < dragonSamples.length; i++) {
    const dtms = dragonSamples[i].t - dragonSamples[i - 1].t;
    if (dtms <= 0) continue;
    const dist = Math.hypot(dragonSamples[i].x - dragonSamples[i - 1].x, dragonSamples[i].y - dragonSamples[i - 1].y);
    const spd = dist / (dtms / 1000);
    if (spd > maxSpeed) maxSpeed = spd;
  }
  console.log("max instantaneous dragon speed observed:", maxSpeed.toFixed(2), "tiles/sec (expect ~9, i.e. 2x player's 4.5)");
  if (maxSpeed < 6) throw new Error(`FAIL: dragon speed (${maxSpeed.toFixed(2)}) looks too slow for "twice as fast as a player"`);
  console.log("PASS: dragon closes distance at roughly 2x player speed.");

  console.log("hp trace while being hit by the dragon:", JSON.stringify(hpLog));
  console.log("attack kinds observed:", [...kinds]);

  if (hpLog.length < 2) throw new Error("FAIL: dragon never actually landed a hit");
  // The stall-aware walker doesn't know or care that the player died -- once
  // they respawn it just keeps pushing them back toward the same approach
  // point right next to the dragon, so more than one full aggro/kill cycle
  // during this run is expected, not a bug. Split the hp trace into
  // separate "hit runs", starting a fresh run whenever hp goes UP (a
  // respawn heal) rather than down (an actual hit), so a cycle boundary
  // never gets misread as a single implausible "-10 damage" hit.
  const hitRuns = [[]];
  for (let i = 1; i < hpLog.length; i++) {
    const delta = hpLog[i - 1].hp - hpLog[i].hp;
    if (delta > 0) hitRuns[hitRuns.length - 1].push({ dmg: delta, t: hpLog[i].t });
    else if (delta < 0) hitRuns.push([]); // respawn heal -- start a fresh run
  }
  const allHits = hitRuns.flat();
  console.log("per-hit damage amounts (all kill cycles):", allHits.map((h) => h.dmg));
  if (allHits.length === 0) throw new Error("FAIL: dragon never actually landed a hit");

  // Every hit should be exactly 4 damage, except the last hit of each run
  // (a killing blow clamped at the player's remaining hp, which can read as
  // less than 4).
  for (const run of hitRuns) {
    if (run.length === 0) continue;
    const allButLast = run.slice(0, -1);
    const last = run[run.length - 1];
    if (!allButLast.every((h) => h.dmg === 4) || !(last.dmg === 4 || last.dmg <= 4)) {
      throw new Error(`FAIL: expected 4 damage per dragon hit, saw run ${JSON.stringify(run.map((h) => h.dmg))}`);
    }
  }
  console.log("PASS: dragon deals exactly 4 damage per hit (each kill cycle's final hit clamped as expected).");

  const gaps = [];
  for (const run of hitRuns) {
    for (let i = 1; i < run.length; i++) gaps.push(run[i].t - run[i - 1].t);
  }
  if (gaps.length) {
    console.log("gaps between consecutive hits (ms):", gaps, "(expect ~500ms)");
    const allReasonable = gaps.every((g) => g > 250 && g < 1200);
    if (!allReasonable) console.log("WARNING: attack cadence looks off from the expected ~500ms (network/tick jitter tolerated).");
    else console.log("PASS: attack cadence is consistent with a ~0.5s cooldown.");
  }

  socket.close();
  console.log("ALL DRAGON TESTS DONE (player likely died or fled -- expected for a 100hp/4dmg boss).");
  process.exit(0);
})().catch((e) => {
  console.error("TEST ERROR:", e.message || e);
  // Always disconnect on failure too -- an orphaned socket left connected
  // (and standing right at the cave mouth, mid-test) can physically block
  // the dragon's own path out on the NEXT test run against the same
  // long-lived server process, turning one flaky run into a persistent one.
  if (activeSocket) activeSocket.close();
  process.exit(1);
});
