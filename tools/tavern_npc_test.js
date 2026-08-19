// Tests for the decorative tavern patrons (server/tavernNpcs.js), exercised
// through the real spawn/update wiring in server/index.js rather than a
// hand-copied reimplementation -- same approach as the other server-logic
// test files in this directory.
const tavernNpcModule = require("../server/tavernNpcs.js");
const { tavern, tavernNpcs, tavernPatrons, tavernDancer } = require("../server/index.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

// --- Test 1: the expected patron count spawned, plus exactly one dancer ---
check(tavernPatrons.length === 6, `spawned 6 wandering patrons (got ${tavernPatrons.length})`);
check(tavernNpcs.length === tavernPatrons.length + 1, `tavernNpcs combines patrons + the dancer (${tavernNpcs.length})`);
check(!!tavernDancer && tavernDancer.big === true && tavernDancer.dancing === true, "the dancer is flagged big + dancing");
check(tavernPatrons.every((n) => !n.big && !n.dancing), "no wandering patron is flagged big/dancing");

// --- Test 2: every spawned patron starts on valid, open tavern floor ------
{
  const collision = tavern.collision;
  const onOpenFloor = (n) => {
    const tx = Math.floor(n.x);
    const ty = Math.floor(n.y);
    return ty >= 0 && ty < tavern.height && tx >= 0 && tx < tavern.width && collision[ty][tx] !== 1;
  };
  check(tavernPatrons.every(onOpenFloor), "every patron spawns on open (non-collision) tavern floor");
}

// --- Test 3: patrons use varied race/color combos (not all identical) ----
{
  const combos = new Set(tavernPatrons.map((n) => `${n.race}_${n.color}`));
  check(combos.size > 1, `patrons use more than one race/color combo (got ${combos.size} distinct)`);
}

// --- Test 4: the dancer sits up near the bar, at room-center x ------------
{
  const d = tavernDancer;
  check(Math.abs(d.x - tavern.width / 2) < 0.6, `dancer is horizontally centered (x=${d.x}, center=${tavern.width / 2})`);
  check(d.y < tavern.height * 0.3, `dancer sits up near the top of the room / bar band (y=${d.y})`);
}

// --- Test 5: updateTavernNpc moves a wandering patron over time -----------
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

// --- Test 6: updateTavernNpc never moves a dancing NPC, only flips facing -
{
  const canStandAlways = () => true;
  const npc = new tavernNpcModule.TavernNpc(10, 3, "human", "pink", { big: true });
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

// --- Test 7: a blocked wander goal is abandoned, not walked into ----------
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
