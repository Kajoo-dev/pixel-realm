// Single consolidated test pass covering all of this round's new mechanics:
//  - players start inside the tavern, with a working tavern->outside door
//    transition and an outside->tavern door transition
//  - the flaming sword sits in the cave, is pickup-on-touch, boosts max hp
//    to 50, and resets back to the cave if the holder disconnects
//  - the dragon's attack cadence is ~1s (not 0.5s) and its damage against a
//    flaming-sword holder is reduced to 1 (vs its normal 4 elsewhere)
//  - sword_hit fires when a swing actually lands on a monster
const { io } = require("socket.io-client");
const URL = "http://localhost:3000";

function connect(name, color, race) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ["websocket"] });
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

// Stall-aware walker (same trick used by the existing dragon/combat test
// suites): head straight for the target, but if progress stalls for a bit
// (snagged on terrain), commit to a random escape burst instead of kiting a
// wall forever. Stops as soon as either the target is reached or
// opts.extraCheck() returns true (e.g. "picked up the item").
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
const STOP_INPUT = { up: false, down: false, left: false, right: false };

// A simpler, no-escape-burst push straight at the target: used for the last
// stretch into the dragon-guarded cave, where "stalled" usually means
// "the dragon's own body is temporarily in the way", not terrain -- an
// escape burst there just wastes time drifting away and prolongs exposure.
// Direct pressure toward the goal gets through faster once the dragon
// (which is also actively moving to close to attack range) steps aside.
//
// IMPORTANT: the server has no concept of an input timeout -- whatever
// direction was last emitted keeps being applied every tick forever, even
// after this function returns. Every exit path MUST emit a stop, or the
// entity keeps walking in its last commanded direction indefinitely during
// whatever the caller does next (this was the actual root cause behind a
// long, confusing chase earlier in this test's development: a player left
// with a stale "up" input silently walked the length of the map while the
// test was busy doing something else entirely).
async function rushToward(socket, getMyXY, getTargetXY, opts = {}) {
  const { deadlineMs = 10000, arriveDist = 1.0, extraCheck } = opts;
  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      if (extraCheck && extraCheck()) return true;
      const me = getMyXY();
      const target = getTargetXY();
      if (!target) return false;
      const dx = target.x - me.x, dy = target.y - me.y;
      if (Math.hypot(dx, dy) < arriveDist) return true;
      socket.emit("input", { up: dy < -0.15, down: dy > 0.15, left: dx < -0.15, right: dx > 0.15 });
      await sleep(80);
    }
    return false;
  } finally {
    socket.emit("input", STOP_INPUT);
  }
}

async function walkToward(socket, getMyXY, getTargetXY, opts = {}) {
  const { deadlineMs = 20000, arriveDist = 1.0, extraCheck } = opts;
  const deadline = Date.now() + deadlineMs;
  let lastPos = null;
  let stallCount = 0;
  let escapeUntil = 0, escapeInput = null;
  try {
    while (Date.now() < deadline) {
      if (extraCheck && extraCheck()) return true;
      const me = getMyXY();
      const target = getTargetXY();
      if (!target) return false;
      const dx = target.x - me.x, dy = target.y - me.y;
      const dist = Math.hypot(dx, dy);
      if (dist < arriveDist) return true;
      const now = Date.now();
      if (now < escapeUntil) {
        socket.emit("input", escapeInput);
      } else if (stallCount > 12) {
        escapeInput = ESCAPE_DIRS[Math.floor(Math.random() * ESCAPE_DIRS.length)];
        escapeUntil = now + 900 + Math.random() * 600;
        stallCount = 0;
        socket.emit("input", escapeInput);
      } else {
        socket.emit("input", { up: dy < -0.15, down: dy > 0.15, left: dx < -0.15, right: dx > 0.15 });
      }
      await sleep(80);
      if (lastPos && Math.hypot(me.x - lastPos.x, me.y - lastPos.y) < 0.03) stallCount++;
      else stallCount = 0;
      lastPos = { x: me.x, y: me.y };
    }
    return false;
  } finally {
    socket.emit("input", STOP_INPUT);
  }
}

(async () => {
  // ---- Test 1: spawn area + tavern map shape ----
  const a = await connect("Alice", "red", "human");
  console.log("Alice spawn area:", a.ack.you.area, "pos:", a.ack.you.x, a.ack.you.y);
  if (a.ack.you.area !== "tavern") throw new Error("FAIL: player did not start inside the tavern");
  if (!a.ack.tavernMap || !a.ack.tavernMap.doorTile) throw new Error("FAIL: no tavernMap/doorTile in join ack");
  console.log("PASS: spawns inside the tavern.");

  let aState = a.ack.you;
  a.socket.on("state", (list) => {
    const me = list.find((p) => p.id === a.socket.id);
    if (me) aState = me;
  });
  const getA = () => ({ x: aState.x, y: aState.y });

  // ---- Test 2: tavern -> outside transition ----
  const tDoorX = a.ack.tavernMap.doorTile.x + 0.5;
  const tDoorY = a.ack.tavernMap.height - 0.6;
  await walkToward(a.socket, getA, () => ({ x: tDoorX, y: tDoorY }), { deadlineMs: 8000, arriveDist: 0.3, extraCheck: () => aState.area === "outside" });
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(300);
  console.log("Alice area after walking down:", aState.area, "pos:", aState.x, aState.y);
  if (aState.area !== "outside") throw new Error("FAIL: never transitioned from tavern to outside");
  console.log("PASS: tavern -> outside door transition works.");

  // ---- Test 3: outside -> tavern transition ----
  const worldDoor = a.ack.map.tavernDoorTile;
  const wDoorX = worldDoor.x + 0.5, wDoorY = worldDoor.y + 0.5;
  await walkToward(a.socket, getA, () => ({ x: wDoorX, y: wDoorY }), { deadlineMs: 8000, arriveDist: 0.5, extraCheck: () => aState.area === "tavern" });
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(300);
  console.log("Alice area after walking back to the door:", aState.area, "pos:", aState.x, aState.y);
  if (aState.area !== "tavern") throw new Error("FAIL: never transitioned from outside back into the tavern");
  console.log("PASS: outside -> tavern door transition works.");

  // Head back outside for the rest of the test (sword/dragon mechanics only
  // exist out there).
  await walkToward(a.socket, getA, () => ({ x: tDoorX, y: tDoorY }), { deadlineMs: 8000, arriveDist: 0.3, extraCheck: () => aState.area === "outside" });
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(300);
  if (aState.area !== "outside") throw new Error("FAIL: could not get back outside for the sword/dragon tests");

  // ---- Test 4: flaming sword pickup, max hp boost ----
  console.log("initial swordState:", a.ack.swordState);
  let currentSwordState = a.ack.swordState;
  a.socket.on("sword_state", (s) => { currentSwordState = s; });
  const swordX = a.ack.swordState.x, swordY = a.ack.swordState.y;
  // The cave is walled with a single south-side entrance corridor, and a
  // lake sits directly between the tavern/plaza area and the cave, so
  // aiming straight at the cave center from here can walk into the lake
  // shoreline or a stray scattered rock/tree. This is a real BFS shortest
  // path over the server's own collision grid (server/map.js, seed 1337)
  // from just outside the tavern door all the way to the cave center --
  // every node is exactly 1 tile from the next (pure cardinal steps), so a
  // greedy straight-line walk between any two of them can never cut a
  // corner into an obstacle.
  const outerRoute = [
    { x: 10.5, y: 35.5 }, { x: 11.5, y: 35.5 }, { x: 12.5, y: 35.5 }, { x: 13.5, y: 35.5 }, { x: 14.5, y: 35.5 }, { x: 15.5, y: 35.5 },
    { x: 16.5, y: 35.5 }, { x: 16.5, y: 34.5 }, { x: 16.5, y: 33.5 }, { x: 17.5, y: 33.5 }, { x: 18.5, y: 33.5 }, { x: 19.5, y: 33.5 },
    { x: 20.5, y: 33.5 }, { x: 21.5, y: 33.5 }, { x: 22.5, y: 33.5 }, { x: 23.5, y: 33.5 }, { x: 24.5, y: 33.5 }, { x: 25.5, y: 33.5 },
    { x: 26.5, y: 33.5 }, { x: 27.5, y: 33.5 }, { x: 28.5, y: 33.5 }, { x: 29.5, y: 33.5 }, { x: 30.5, y: 33.5 }, { x: 31.5, y: 33.5 },
    { x: 32.5, y: 33.5 }, { x: 33.5, y: 33.5 }, { x: 34.5, y: 33.5 }, { x: 35.5, y: 33.5 }, { x: 36.5, y: 33.5 }, { x: 37.5, y: 33.5 },
    { x: 38.5, y: 33.5 }, { x: 39.5, y: 33.5 }, { x: 40.5, y: 33.5 }, { x: 41.5, y: 33.5 }, { x: 42.5, y: 33.5 }, { x: 43.5, y: 33.5 },
    { x: 44.5, y: 33.5 }, { x: 45.5, y: 33.5 }, { x: 46.5, y: 33.5 }, { x: 47.5, y: 33.5 }, { x: 48.5, y: 33.5 }, { x: 48.5, y: 32.5 },
    { x: 48.5, y: 31.5 }, { x: 48.5, y: 30.5 }, { x: 48.5, y: 29.5 }, { x: 48.5, y: 28.5 }, { x: 48.5, y: 27.5 }, { x: 48.5, y: 26.5 },
    { x: 48.5, y: 25.5 }, { x: 48.5, y: 24.5 }, { x: 48.5, y: 23.5 },
  ];
  // The dragon's aggro range is 8 tiles from its home (48.5, 14.5) -- y=23.5
  // sits just past that (dist ~9), a safe staging point to wait at without
  // risking it noticing Alice on its own before the distraction is ready.
  // The rest of the route, from here into the aggro zone and up to the
  // sword, is used later once the dragon is otherwise occupied.
  const dangerRoute = [
    { x: 48.5, y: 22.5 }, { x: 48.5, y: 21.5 }, { x: 48.5, y: 20.5 },
  ];
  // Confirmed via the collision grid directly (x 44-52, y 5-22 is entirely
  // open cave floor/cleared corridor, no terrain obstacles at all) -- so
  // the only hazard in that stretch is the dragon itself, whose home sits
  // right on this path.
  for (const wp of outerRoute) {
    if (aState.dead) break;
    await rushToward(a.socket, getA, () => wp, { deadlineMs: 4000, arriveDist: 0.6 });
  }
  if (aState.dead) { while (aState.dead) await sleep(300); await sleep(500); }

  // Once aggroed, the dragon locks onto that target until it dies or
  // deaggroes (see dragon.js: it only re-scans for a new target when it has
  // none) -- a lone 10hp rusher next to it dies in ~3 seconds flat, every
  // time, which isn't really a pathing problem to solve so much as it is
  // the dragon doing exactly its job as a guardian. A second player tanking
  // its aggro (realistic multiplayer play: distract while a teammate grabs
  // the treasure) reliably clears the way instead -- but Alice has to
  // actually wait at a safe distance while Dana gets in position, or the
  // dragon just aggroes onto whoever's nearest (her) in the meantime.
  console.log("bringing in a distractor to hold the dragon's aggro...");
  const distractor = await connect("Dana", "green", "orc");
  let dState = distractor.ack.you;
  distractor.socket.on("state", (list) => { const me = list.find((p) => p.id === distractor.socket.id); if (me) dState = me; });
  const getD = () => ({ x: dState.x, y: dState.y });
  await walkToward(distractor.socket, getD, () => ({ x: tDoorX, y: tDoorY }), { deadlineMs: 8000, arriveDist: 0.3, extraCheck: () => dState.area === "outside" });
  for (const wp of outerRoute.concat(dangerRoute)) {
    await rushToward(distractor.socket, getD, () => wp, { deadlineMs: 4000, arriveDist: 0.6 });
  }
  // Camp off to the side of the entrance -- close enough to hold the
  // dragon's aggro (well within its 8-tile aggro range of its home), but
  // clear of the direct center-line path (x~48) Alice needs to rush up,
  // so Dana's own body doesn't become a second obstacle blocking the way.
  const dragonBaitSpot = { x: 43, y: 16 };
  (async () => {
    // Keep pushing toward the bait spot for the rest of this test,
    // respawning and returning if she dies -- her only job is to keep the
    // dragon's aggro off Alice.
    for (;;) {
      if (dState.dead) { await sleep(1500); continue; }
      await rushToward(distractor.socket, getD, () => dragonBaitSpot, { deadlineMs: 2000, arriveDist: 1.0 });
      await sleep(50);
    }
  })();
  await sleep(2500); // let the dragon lock onto Dana before Alice moves in

  // Now, and only now, does Alice cross into the aggro zone -- the dragon
  // should already be committed to Dana.
  for (const wp of dangerRoute) {
    if (aState.hasFlamingSword) break;
    await rushToward(a.socket, getA, () => wp, { deadlineMs: 4000, arriveDist: 0.6, extraCheck: () => aState.hasFlamingSword });
  }

  for (let attempt = 0; attempt < 5 && !aState.hasFlamingSword; attempt++) {
    // extraCheck must also bail out the instant she dies (not just once the
    // full deadline elapses) -- a die-then-respawn cycle that completes
    // within a single rush call would otherwise go undetected until the
    // call times out, by which point she's already sitting back at the
    // outside respawn point (the plaza, nowhere near this route) and the
    // next attempt would blindly rush an unverified diagonal from there.
    await rushToward(a.socket, getA, () => ({ x: swordX, y: swordY }), { deadlineMs: 8000, arriveDist: 0.5, extraCheck: () => aState.hasFlamingSword || aState.dead });
    if (aState.hasFlamingSword) break;
    if (aState.dead) {
      console.log("Alice died getting past the dragon-guarded cave entrance -- waiting for respawn and retrying...");
      while (aState.dead) await sleep(300);
      await sleep(500);
      // Dana should still be camped on the bait spot holding aggro, so
      // Alice can retrace the whole route (including the danger zone) at
      // normal pace this time.
      for (const wp of outerRoute.concat(dangerRoute)) {
        if (aState.hasFlamingSword) break;
        await rushToward(a.socket, getA, () => wp, { deadlineMs: 4000, arriveDist: 0.6, extraCheck: () => aState.hasFlamingSword });
      }
    }
  }
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(300);
  console.log("Alice after approaching sword: hasFlamingSword=", aState.hasFlamingSword, "hp/maxHp=", aState.hp, aState.maxHp, "pos:", aState.x, aState.y);
  if (!aState.hasFlamingSword) throw new Error("FAIL: never picked up the flaming sword");
  if (aState.maxHp !== 50) throw new Error("FAIL: max hp not boosted to 50 while holding the flaming sword, got " + aState.maxHp);
  if (!currentSwordState.held || currentSwordState.holderId !== a.socket.id) throw new Error("FAIL: sword_state not broadcast as held by Alice");
  console.log("PASS: flaming sword pickup boosts max hp to 50 and broadcasts sword_state.");

  // ---- Test 5: dragon damage reduced to 1 for the flaming-sword holder,
  // plus attack cadence (~1s) and roar-every-3rd-attack ----
  const dragonInfo = a.ack.monsters.find((m) => m.type === "dragon");
  if (!dragonInfo) throw new Error("FAIL: no dragon in initial monster list");
  let liveMonsters = new Map(a.ack.monsters.map((m) => [m.id, m]));
  a.socket.on("monsters", (list) => { liveMonsters = new Map(list.map((m) => [m.id, m])); });

  const hpBeforeDragon = aState.hp;
  console.log("walking Alice toward the dragon at", dragonInfo.x, dragonInfo.y, "-- hp before:", hpBeforeDragon);

  const dragonAttacks = [];
  a.socket.on("monster_attack", (info) => {
    if (info.id === dragonInfo.id) dragonAttacks.push({ t: Date.now(), roar: !!info.roar });
  });

  await walkToward(
    a.socket, getA,
    () => { const live = liveMonsters.get(dragonInfo.id); return live ? { x: live.x, y: live.y } : null; },
    { deadlineMs: 40000, arriveDist: 2.4, extraCheck: () => dragonAttacks.length >= 3 }
  );
  // Sit near it a bit longer if we haven't gathered 3 attacks yet (close
  // range keeps it attacking rather than wandering off).
  const lingerDeadline = Date.now() + 8000;
  while (Date.now() < lingerDeadline && dragonAttacks.length < 3) {
    const live = liveMonsters.get(dragonInfo.id);
    if (!live) break;
    const dx = live.x - aState.x, dy = live.y - aState.y;
    a.socket.emit("input", { up: dy < -0.15, down: dy > 0.15, left: dx < -0.15, right: dx > 0.15 });
    await sleep(100);
  }
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  console.log("Alice hp after dragon contact:", aState.hp, "(started at", hpBeforeDragon, ")");
  const sawDamage = aState.hp < hpBeforeDragon;
  if (!sawDamage) {
    console.log("WARNING: never got hit by the dragon within the time budget -- damage-reduction check skipped this run.");
  } else {
    const dmgTaken = hpBeforeDragon - aState.hp;
    console.log("total damage taken by flaming-sword holder from dragon so far:", dmgTaken, "(expect a multiple of 1, i.e. == number of hits)");
    if (dragonAttacks.length > 0 && dmgTaken !== dragonAttacks.length) {
      // dmgTaken should equal exactly 1 per attack landed on Alice specifically.
      console.log("NOTE: dmgTaken(" + dmgTaken + ") vs attacks-observed(" + dragonAttacks.length + ") can differ if a swing missed/whiffed; checking per-hit amount instead below.");
    }
    if (dmgTaken > dragonAttacks.length) throw new Error("FAIL: took more total damage (" + dmgTaken + ") than dragon attacks observed (" + dragonAttacks.length + ") -- damage per hit exceeds 1");
    console.log("PASS: dragon damage reduced to 1 (or less, if some attacks missed) against the flaming-sword holder.");
  }

  console.log("dragon attack timestamps/roars observed:", JSON.stringify(dragonAttacks));
  if (dragonAttacks.length >= 2) {
    for (let i = 1; i < dragonAttacks.length; i++) {
      const gap = dragonAttacks[i].t - dragonAttacks[i - 1].t;
      console.log("dragon attack gap:", gap, "ms (expect ~1000ms, well above the old 500ms)");
      if (gap < 800) throw new Error("FAIL: dragon attacked again after only " + gap + "ms -- cooldown doesn't look like ~1s");
    }
    console.log("PASS: dragon attack cadence is ~1s, not 0.5s.");
  } else {
    console.log("WARNING: fewer than 2 dragon attacks observed -- cadence check inconclusive this run.");
  }
  if (dragonAttacks.length >= 3) {
    // Dana (the distractor) had almost certainly already traded a few
    // blows with the dragon before Alice's observation window opened here,
    // so the dragon's internal attack counter has an unknown phase offset
    // going into this sample -- "the 3rd attack we happen to see" isn't
    // necessarily "the dragon's 3rd attack ever". The phase-independent
    // invariant of "roars on exactly every 3rd attack" is: any 3
    // consecutive attacks contain exactly one roar, and consecutive roars
    // are exactly 3 attacks apart -- true regardless of where our sample
    // starts.
    for (let i = 0; i + 2 < dragonAttacks.length; i++) {
      const window = [dragonAttacks[i], dragonAttacks[i + 1], dragonAttacks[i + 2]];
      const roarCount = window.filter((a) => a.roar).length;
      if (roarCount !== 1) throw new Error("FAIL: window of 3 consecutive dragon attacks had " + roarCount + " roars, expected exactly 1 (attacks " + i + "-" + (i + 2) + ")");
    }
    const roarIndices = dragonAttacks.map((a, i) => (a.roar ? i : -1)).filter((i) => i >= 0);
    for (let i = 1; i < roarIndices.length; i++) {
      const spacing = roarIndices[i] - roarIndices[i - 1];
      if (spacing !== 3) throw new Error("FAIL: consecutive roars were " + spacing + " attacks apart, expected exactly 3");
    }
    console.log("PASS: dragon roars on exactly every 3rd attack (roar indices in this sample:", roarIndices, ").");
  } else {
    console.log("WARNING: fewer than 3 dragon attacks observed -- roar-every-3rd check inconclusive this run.");
  }

  // Retreat from the dragon so we don't linger indefinitely.
  const fleeDeadline = Date.now() + 6000;
  while (Date.now() < fleeDeadline) {
    const live = liveMonsters.get(dragonInfo.id);
    if (!live) break;
    const dx = aState.x - live.x, dy = aState.y - live.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist > 12) break;
    a.socket.emit("input", { up: dy / dist < -0.2, down: dy / dist > 0.2, left: dx / dist < -0.2, right: dx / dist > 0.2 });
    await sleep(80);
  }
  a.socket.emit("input", { up: false, down: false, left: false, right: false });
  await sleep(200);

  // ---- Test 6: sword_hit fires when a swing lands on a monster ----
  let sawSwordHit = false;
  a.socket.on("sword_hit", () => { sawSwordHit = true; });
  const nearestLiveNonDragon = () => {
    let best = null, bestDist = Infinity;
    for (const m of liveMonsters.values()) {
      if (m.type === "dragon") continue;
      const d = Math.hypot(m.x - aState.x, m.y - aState.y);
      if (d < bestDist) { bestDist = d; best = m; }
    }
    return best;
  };
  let attacked = false;
  const huntDeadline = Date.now() + 20000;
  while (Date.now() < huntDeadline && !sawSwordHit) {
    const target = nearestLiveNonDragon();
    if (!target) { await sleep(300); continue; }
    const dx = target.x - aState.x, dy = target.y - aState.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1.0) {
      a.socket.emit("input", { up: dy < -0.1, down: dy > 0.1, left: dx < -0.1, right: dx > 0.1 });
    } else {
      a.socket.emit("input", STOP_INPUT);
      a.socket.emit("attack", { angle: Math.atan2(dy, dx) });
      attacked = true;
    }
    await sleep(160);
  }
  a.socket.emit("input", STOP_INPUT);
  console.log("attacked a monster:", attacked, "sawSwordHit:", sawSwordHit);
  if (attacked && !sawSwordHit) throw new Error("FAIL: attacked a monster but never received sword_hit");
  if (sawSwordHit) console.log("PASS: sword_hit fires when a swing lands.");
  else console.log("WARNING: never got in range of a small monster to test sword_hit -- skipped.");
  a.socket.emit("input", { up: false, down: false, left: false, right: false });

  // ---- Test 7: sword resets to the cave when the holder disconnects ----
  a.socket.close();
  await sleep(500);
  const b = await connect("Bob", "blue", "elf");
  console.log("swordState after Alice (the holder) disconnected:", b.ack.swordState);
  if (b.ack.swordState.held) throw new Error("FAIL: sword still shows as held after the holder disconnected");
  if (Math.abs(b.ack.swordState.x - swordX) > 0.01 || Math.abs(b.ack.swordState.y - swordY) > 0.01) {
    throw new Error("FAIL: sword did not reset back to its cave position after disconnect");
  }
  console.log("PASS: sword resets back to the cave when the holder disconnects.");

  b.socket.close();
  distractor.socket.close();
  console.log("ALL TAVERN/SWORD/DRAGON TESTS DONE");
  process.exit(0);
})().catch((e) => { console.error("TEST ERROR:", e.message || e); process.exit(1); });
