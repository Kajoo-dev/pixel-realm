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
  a.socket.on("state", (list) => { const me = list.find((p) => p.id === a.socket.id); if (me) aState = me; });
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

  // Now flee -- run directly away from the monster for several seconds so
  // it loses aggro (its deaggro range is 8-10 tiles) instead of continuing
  // to whittle Alice down to 0. Track hp the whole time so we know exactly
  // when the last hit landed, however many that ends up being.
  const hitLog = []; // { t, hp }
  let lastHp = aState.hp;
  hitLog.push({ t: Date.now(), hp: lastHp });
  const fleeDeadline = Date.now() + 6000;
  while (Date.now() < fleeDeadline) {
    const live = liveMonsters.get(target.id);
    let dx = 1, dy = 0;
    if (live) { dx = aState.x - live.x; dy = aState.y - live.y; }
    const norm = Math.hypot(dx, dy) || 1;
    dx /= norm; dy /= norm;
    a.socket.emit("input", { up: dy < -0.2, down: dy > 0.2, left: dx < -0.2, right: dx > 0.2 });
    await sleep(100);
    if (aState.hp !== lastHp) { lastHp = aState.hp; hitLog.push({ t: Date.now(), hp: lastHp }); }
    if (aState.hp <= 0) break;
  }
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  console.log("hp trace during flee:", JSON.stringify(hitLog));

  if (aState.hp <= 0) {
    console.log("WARNING: Alice died before escaping aggro range -- regen timing check skipped (death/respawn already exercised by tools/test_combat.js-style coverage).");
  } else {
    const lastDamageAt = hitLog[hitLog.length - 1].t;
    const hpAfterHit = aState.hp;
    const elapsedSinceLastHit = Date.now() - lastDamageAt;
    console.log("last damage was", elapsedSinceLastHit, "ms ago, hp now", hpAfterHit, "-- confirming no further damage while waiting out the regen gate");

    // Confirm NO regen for the first ~9.5s after the last hit.
    const remainingTo9_5s = Math.max(0, 9500 - elapsedSinceLastHit);
    await sleep(remainingTo9_5s);
    const hpAt9_5s = aState.hp;
    console.log("hp at ~9.5s post-last-damage:", hpAt9_5s, "(should still equal", hpAfterHit, "-- regen gate is 10s)");
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
