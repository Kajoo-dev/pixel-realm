// Tests for the decorative tavern patrons (server/tavernNpcs.js), exercised
// through the real spawn/update wiring in server/index.js rather than a
// hand-copied reimplementation -- same approach as the other server-logic
// test files in this directory.
const tavernNpcModule = require("../server/tavernNpcs.js");
const {
  tavern, tavernNpcs, tavernPatrons, tavernDancer,
  startTavernParty, isTavernPartyStarted,
} = require("../server/index.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

// --- Test 1: the bar starts EMPTY -- only Dante (the dancer) is present ---
// before the tavern party has been triggered ("keep the bar empty before
// then", per the spec).
check(isTavernPartyStarted() === false, "tavern party has not started yet at module load");
check(tavernPatrons.length === 0, `bar starts with zero wandering patrons (got ${tavernPatrons.length})`);
check(tavernNpcs.length === 1, `tavernNpcs is just the dancer before the party starts (${tavernNpcs.length})`);
check(!!tavernDancer && tavernDancer.big === true && tavernDancer.dancing === false, "Dante starts big but NOT dancing (stands still at the bar)");

// --- Test 2: the dancer sits up near the bar, at room-center x ------------
{
  const d = tavernDancer;
  check(Math.abs(d.x - tavern.width / 2) < 0.6, `dancer is horizontally centered (x=${d.x}, center=${tavern.width / 2})`);
  check(d.y < tavern.height * 0.3, `dancer sits up near the top of the room / bar band (y=${d.y})`);
}

// --- Test 3: startTavernParty populates the bar with a 16-patron crowd,
// split equally 4-per-race, and starts Dante dancing. It's a one-way latch
// -- calling it twice must not double-spawn.
{
  const before = Date.now();
  startTavernParty(before);
  check(isTavernPartyStarted() === true, "isTavernPartyStarted() reflects the latch after triggering");
  check(tavernPatrons.length === 16, `startTavernParty spawns 16 patrons (got ${tavernPatrons.length})`);
  check(tavernNpcs.length === 17, `tavernNpcs now holds 16 patrons + the dancer (got ${tavernNpcs.length})`);
  check(tavernDancer.dancing === true, "Dante starts dancing once the party begins");

  const counts = {};
  for (const n of tavernPatrons) counts[n.race] = (counts[n.race] || 0) + 1;
  const allFour = tavernNpcModule.RACES.every((r) => counts[r] === 4);
  check(allFour, `patrons split exactly 4-per-race across all 4 races (got ${JSON.stringify(counts)})`);
  check(tavernPatrons.every((n) => !n.big && !n.dancing), "no wandering patron is flagged big/dancing");

  // Calling it again must be a no-op (one-way latch).
  startTavernParty(Date.now());
  check(tavernPatrons.length === 16, "calling startTavernParty a second time does not double-spawn patrons");
}

// --- Test 4: every spawned patron starts on valid, open tavern floor ------
{
  const collision = tavern.collision;
  const onOpenFloor = (n) => {
    const tx = Math.floor(n.x);
    const ty = Math.floor(n.y);
    return ty >= 0 && ty < tavern.height && tx >= 0 && tx < tavern.width && collision[ty][tx] !== 1;
  };
  check(tavernPatrons.every(onOpenFloor), "every patron spawns on open (non-collision) tavern floor");
}

// --- Test 5: patrons use varied color combos (not all identical) ----------
{
  const combos = new Set(tavernPatrons.map((n) => `${n.race}_${n.color}`));
  check(combos.size > 1, `patrons use more than one race/color combo (got ${combos.size} distinct)`);
}

// --- Test 6: updateTavernNpc moves a wandering patron over time -----------
{
  const canStandAlways = () => true;
  const npc = new tavernNpcModule.TavernNpc(5, 5, "human", "red");
  const startX = npc.x, startY = npc.y;
  let moved = false;
  for (let i = 0; i < 400; i++) {
    tavernNpcModule.updateTavernNpc(npc, 0.05, i * 50, canStandAlways);
    if (Math.hypot(npc.x - startX, npc.y - startY) > 0.05) { moved = true; break; }
  }
  check(moved, "a wandering patron actually moves from its spawn point over time");
}

// --- Test 7: a stationary (non-dancing) big NPC never moves or animates ---
{
  const canStandAlways = () => true;
  const npc = new tavernNpcModule.TavernNpc(10, 3, "human", "pink", { big: true });
  const startX = npc.x, startY = npc.y;
  for (let i = 0; i < 40; i++) tavernNpcModule.updateTavernNpc(npc, 0.05, i * 100, canStandAlways);
  check(npc.x === startX && npc.y === startY, "a non-dancing big NPC never leaves its spot");
  check(npc.moving === false, "a non-dancing big NPC reports not-moving (stands still)");
}

// --- Test 8: updateTavernNpc never moves a dancing big NPC, only flips
// facing -- and it never falls into the wander-goal branch.
{
  const canStandAlways = () => true;
  const npc = new tavernNpcModule.TavernNpc(10, 3, "human", "pink", { big: true, dancing: true });
  const startX = npc.x, startY = npc.y;
  const seenDirs = new Set();
  for (let i = 0; i < 40; i++) {
    tavernNpcModule.updateTavernNpc(npc, 0.05, i * 100, canStandAlways);
    seenDirs.add(npc.dir);
  }
  check(npc.x === startX && npc.y === startY, "the dancer never leaves its spot");
  check(npc.moving === true, "the dancer always reports moving (drives the client's continuous animation)");
  check(seenDirs.size > 1, `the dancer flips facing direction over time (saw: ${[...seenDirs].join(",")})`);
}

// --- Test 9: a blocked wander goal is abandoned, not walked into ----------
{
  // canStand rejects everything -- the NPC should never actually move even
  // though it keeps trying to pick new wander goals.
  const canStandNever = () => false;
  const npc = new tavernNpcModule.TavernNpc(5, 5, "human", "blue");
  const startX = npc.x, startY = npc.y;
  for (let i = 0; i < 200; i++) tavernNpcModule.updateTavernNpc(npc, 0.05, i * 50, canStandNever);
  check(npc.x === startX && npc.y === startY, "a patron surrounded by unwalkable terrain never actually moves");
}

console.log(failures === 0 ? "\nALL TAVERN NPC CHECKS PASSED." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
