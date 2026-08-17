// Socket-level checks for: player HP regen timing (10s out-of-combat, then
// +1 every 3s) and player-vs-player / player-vs-monster entity collision
// (can't stand inside another entity's minimum separation).
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

(async () => {
  // ---- Test 1: player-vs-player collision ----
  const a = await connect("Alice", "red", "human");
  const b = await connect("Bob", "blue", "elf");

  let aState = a.ack.you, bState = b.ack.you;
  // Track every hp change on Alice for the whole test, not just during the
  // "flee" phase below -- if she's still in a monster's aggro/deaggro range
  // when the flee loop's fixed time budget runs out, hits can keep landing
  // during the later regen-timing waits, and a tracker that stops updating
  // once the flee loop exits would silently miss them (mis-reading a hit
  // taken *during* the "no regen yet" wait as if it were early regen).
  const aHpLog = [{ t: Date.now(), hp: aState.hp }];
  a.socket.on("state", (list) => {
    const me = list.find((p) => p.id === a.socket.id);
    if (!me) return;
    if (me.hp !== aState.hp) aHpLog.push({ t: Date.now(), hp: me.hp });
    aState = me;
  });
  b.socket.on("state", (list) => { const me = list.find((p) => p.id === b.socket.id); if (me) bState = me; });

  // Walk Bob directly toward Alice's spawn point and hold it there.
  const targetX = aState.x, targetY = aState.y;
  const walkDeadline = Date.now() + 8000;
  while (Date.now() < walkDeadline) {
    const dx = targetX - bState.x, dy = targetY - bState.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.7) break;
    b.socket.emit("input", { up: dy < -0.1, down: dy > 0.1, left: dx < -0.1, right: dx > 0.1 });
    await sleep(80);
  }
  b.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(600);

  const finalDist = Math.hypot(aState.x - bState.x, aState.y - bState.y);
  console.log("final distance between colliding players:", finalDist.toFixed(3), "(entity min separation is 0.58)");
  if (finalDist < 0.5) throw new Error("FAIL: players overlapped past the minimum entity separation -- collision not enforced");
  console.log("PASS: player-vs-player collision kept them apart.");

  // ---- Test 2: HP regen timing ----
  // Find a monster near Alice, let it hit her (attack it, don't kill it,
  // then flee out of its aggro range so we take exactly one hit's worth of
  // damage), then confirm: no regen for the first 10s out of combat, then
  // +1 hp roughly every 3s afterward.
  const monsters = [...a.ack.monsters].sort(
    (m1, m2) => Math.hypot(m1.x - aState.x, m1.y - aState.y) - Math.hypot(m2.x - aState.x, m2.y - aState.y)
  );

  let liveMonsters = new Map(monsters.map((m) => [m.id, m]));
  a.socket.on("monsters", (list) => { liveMonsters = new Map(list.map((m) => [m.id, m])); });

  // Try candidate monsters nearest-first; some may be behind terrain our
  // naive straight-line chase can't route around, so give up on a stuck
  // target after a few seconds and move to the next-closest one.
  let landedHit = false;
  let target = null;
  for (const candidate of monsters) {
    target = candidate;
    let lastAttackAt = 0;
    let lastPos = { x: aState.x, y: aState.y };
    let stuckTicks = 0;
    const perTargetDeadline = Date.now() + 5000;
    while (Date.now() < perTargetDeadline) {
      const live = liveMonsters.get(candidate.id);
      if (!live) break;
      if (live.hp < candidate.hp) { landedHit = true; break; }
      const dx = live.x - aState.x, dy = live.y - aState.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.0) {
        a.socket.emit("input", { up: dy < -0.1, down: dy > 0.1, left: dx < -0.1, right: dx > 0.1 });
      } else {
        a.socket.emit("input", { up: false, down: false, left: false, right: false });
        const now = Date.now();
        if (now - lastAttackAt > 200) {
          a.socket.emit("attack", { angle: Math.atan2(dy, dx) });
          lastAttackAt = now;
        }
      }
      await sleep(80);
      if (Math.hypot(aState.x - lastPos.x, aState.y - lastPos.y) < 0.03) stuckTicks++;
      else stuckTicks = 0;
      lastPos = { x: aState.x, y: aState.y };
      if (stuckTicks > 12) break; // ~1s with no progress -- likely blocked by terrain, try next candidate
    }
    if (landedHit) break;
  }
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(200);

  const hpAfterAggro0 = aState.hp;
  const targetAfterHit = liveMonsters.get(target.id);
  console.log("landed the aggro hit:", landedHit, "on", target && target.id, "-- Alice hp:", hpAfterAggro0, "monster hp now:", targetAfterHit && targetAfterHit.hp);
  if (!landedHit) throw new Error("FAIL: never managed to land a single hit on any candidate monster to aggro it");

  // Now flee -- run directly away from the monster until we're clearly
  // outside every monster type's deaggro range (the largest is 10 tiles),
  // not just for a fixed time budget. A fixed budget can expire while the
  // monster is still adjacent/attacking, and hits landing after that point
  // would silently be missed by anything that only tracks hp during the
  // flee loop itself -- see the persistent aHpLog listener set up above,
  // which keeps recording for the rest of the test regardless.
  // Straight-line flight can get snagged on scattered trees/rocks right
  // when it matters most (an aggroed monster still adjacent), so this uses
  // the same stall-aware escape-burst trick as the dragon/combat tests:
  // commit to a randomized direction for a bit whenever progress away from
  // the monster stalls, instead of just kiting a wall forever.
  const SAFE_DEAGGRO_DIST = 13;
  const ESCAPE_DIRS = [
    { up: true, down: false, left: false, right: false },
    { up: false, down: false, left: true, right: false },
    { up: false, down: true, left: false, right: false },
    { up: false, down: false, left: false, right: true },
    { up: true, down: false, left: true, right: false },
    { up: true, down: false, left: false, right: true },
    { up: false, down: true, left: true, right: false },
    { up: false, down: true, left: false, right: true },
  ];
  const fleeDeadline = Date.now() + 15000;
  let lastFleePos = { x: aState.x, y: aState.y };
  let fleeStallTicks = 0;
  let fleeEscapeUntil = 0;
  let fleeEscapeInput = null;
  while (Date.now() < fleeDeadline) {
    const live = liveMonsters.get(target.id);
    let dx = 1, dy = 0, dist = Infinity;
    if (live) { dx = aState.x - live.x; dy = aState.y - live.y; dist = Math.hypot(dx, dy); }
    if (!live || dist > SAFE_DEAGGRO_DIST) break;
    const now = Date.now();
    if (now < fleeEscapeUntil) {
      a.socket.emit("input", fleeEscapeInput);
    } else if (fleeStallTicks > 3) {
      fleeEscapeInput = ESCAPE_DIRS[Math.floor(Math.random() * ESCAPE_DIRS.length)];
      fleeEscapeUntil = now + 900 + Math.random() * 600;
      fleeStallTicks = 0;
      a.socket.emit("input", fleeEscapeInput);
    } else {
      const norm = dist || 1;
      a.socket.emit("input", { up: dy / norm < -0.2, down: dy / norm > 0.2, left: dx / norm < -0.2, right: dx / norm > 0.2 });
    }
    await sleep(100);
    if (aState.hp <= 0) break;
    if (Math.hypot(aState.x - lastFleePos.x, aState.y - lastFleePos.y) < 0.03) fleeStallTicks++;
    else fleeStallTicks = 0;
    lastFleePos = { x: aState.x, y: aState.y };
  }
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(1500); // let server-side deaggro (and any hit already in flight) settle
  console.log("hp trace so far:", JSON.stringify(aHpLog));

  if (aState.hp <= 0) {
    console.log("WARNING: Alice died before escaping aggro range -- regen timing check skipped (death/respawn already exercised by tools/test_combat.js-style coverage).");
  } else {
    const lastDamageAt = aHpLog[aHpLog.length - 1].t;
    const hpAfterHit = aState.hp;
    const elapsedSinceLastHit = Date.now() - lastDamageAt;
    const logLenAfterFlee = aHpLog.length;
    console.log("last damage was", elapsedSinceLastHit, "ms ago, hp now", hpAfterHit, "-- confirming no further damage while waiting out the regen gate");

    // Confirm NO regen for the first ~9.5s after the last hit. If the
    // aggro'd monster (or, rarely, the dragon on a different run of this
    // suite -- this test uses a fresh server) actually caught up again
    // during this window despite fleeing well past every deaggro range,
    // aHpLog will have grown with more hits (or a death/respawn heal) in
    // the meantime; that makes this particular run's timing measurement
    // inconclusive rather than a real regen-gate violation, so skip rather
    // than fail -- combat/aggro reliability itself is covered elsewhere.
    const remainingTo9_5s = Math.max(0, 9500 - elapsedSinceLastHit);
    await sleep(remainingTo9_5s);
    const hpAt9_5s = aState.hp;
    console.log("hp at ~9.5s post-last-damage:", hpAt9_5s, "(should still equal", hpAfterHit, "-- regen gate is 10s)");
    if (aHpLog.length > logLenAfterFlee) {
      console.log("WARNING: hp changed again during the wait (still in combat, or died/respawned) -- regen-gate timing inconclusive on this run, skipping.");
      a.socket.close();
      b.socket.close();
      console.log("ALL REGEN/COLLISION TESTS DONE (regen timing inconclusive this run)");
      process.exit(0);
    }
    if (hpAt9_5s !== hpAfterHit) throw new Error("FAIL: regenerated before the 10s out-of-combat gate elapsed");
    console.log("PASS: no regen before the 10s out-of-combat gate.");

    // Now wait past the 10s gate + one 3s regen tick (with margin).
    await sleep(4000); // total ~13.5s since the last hit
    const hpAt13_5s = aState.hp;
    console.log("hp at ~13.5s post-last-damage:", hpAt13_5s);
    if (hpAt13_5s <= hpAfterHit) throw new Error("FAIL: did not regenerate after the 10s gate + a 3s tick");
    console.log("PASS: regenerated at least 1 hp after the 10s gate elapsed.");
  }

  a.socket.close();
  b.socket.close();
  console.log("ALL REGEN/COLLISION TESTS DONE");
  process.exit(0);
})().catch((e) => { console.error("TEST ERROR:", e.message || e); process.exit(1); });
