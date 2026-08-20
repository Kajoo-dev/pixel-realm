// Direct integration test of the real door-transition wiring (checkAreaTransition,
// enterCavern/exitCavern) added to server/index.js for the cavern depths
// side-scroller -- run against the actual server code via require(), not a
// hand-copied reimplementation.
//
// NOTE: the back door's seal/unseal mechanics used to mirror the main
// entrance 1:1 (both driven by setCaveSealed), which is what this file
// originally drove directly to simulate "what a dragon death does". A later
// request ("make the door that unlocks inside the cavern stay unlocked if
// the dragon dies, just like the side door") turned the back door into a
// one-way latch independent of setCaveSealed/the main entrance -- see
// openCaveBackDoorOnce() in server/index.js and tools/cave_back_door_test.js
// (which owns the latch-specific regression coverage, including the "stays
// open even after a fresh dragon respawns and reseals the main entrance"
// case). This file now opens the back door the same real way a dragon death
// does -- via killMonster() -- rather than the no-longer-accurate
// setCaveSealed(false), and no longer expects it to reseal.
const { Player, cavernLevel, world, checkAreaTransition, enterCavern, exitCavern, activeMonsters, killMonster } = require("../server/index.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

function freshOutsidePlayer(x, y) {
  const p = new Player("t" + Math.random(), "Tester", "red", "human");
  p.area = "outside";
  p.x = x;
  p.y = y;
  return p;
}

// --- Back door is blocked while the cave is sealed -----------------------
{
  check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 1, "back door tile is blocked in the collision grid while sealed (initial state)");
  const p = freshOutsidePlayer(world.caveBackDoorTile.x + 0.5, world.caveBackDoorTile.y + 0.5);
  checkAreaTransition(p);
  check(p.area === "outside", "standing on the back door tile while sealed does NOT transition into the cavern");
}

// --- Killing the dragon (the real trigger) opens the back door -----------
{
  const dragon = Array.from(activeMonsters.values()).find((m) => m.type === "dragon");
  check(!!dragon, "a live dragon exists at startup (precondition)");
  killMonster(dragon, Date.now());
}
check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 0, "back door tile becomes walkable once the dragon dies");

// --- Walking up to the (now open) back door enters the cavern ------------
{
  const p = freshOutsidePlayer(world.caveBackDoorTile.x + 0.5, world.caveBackDoorTile.y + 0.5);
  checkAreaTransition(p);
  check(p.area === "cavern", "standing on the unsealed back door tile transitions into the cavern");
  check(p.x === cavernLevel.spawn.x && p.y === cavernLevel.spawn.y, `lands exactly at the cavern's spawn point (${p.x},${p.y} vs ${cavernLevel.spawn.x},${cavernLevel.spawn.y})`);
  check(p.grounded === true && p.groundedTier === 0, "spawns already grounded on the ground floor (tier 0)");
}

// --- Weapon state carries over into the cavern (no reset) ----------------
{
  const p = freshOutsidePlayer(world.caveBackDoorTile.x + 0.5, world.caveBackDoorTile.y + 0.5);
  p.hasBow = true;
  p.activeWeapon = "bow";
  p.hasFlamingSword = true;
  checkAreaTransition(p);
  check(p.area === "cavern", "transitions into the cavern with the bow/sword already held");
  check(p.hasBow === true && p.activeWeapon === "bow" && p.hasFlamingSword === true, "weapon state (bow/sword) is untouched by entering the cavern");
}

// --- Walking to the level's exit zone returns to the cave interior -------
{
  const p = new Player("t" + Math.random(), "Tester", "blue", "human");
  enterCavern(p);
  check(p.area === "cavern", "sanity: enterCavern sets area to cavern");
  p.x = cavernLevel.exitZoneX - 0.1; // just inside the exit trigger
  checkAreaTransition(p);
  check(p.area === "outside", "walking into the exit zone returns to the outside/cave-interior area");
  const backDx = p.x - (world.caveBackDoorTile.x + 0.5);
  const backDy = p.y - (world.caveBackDoorTile.y + 0.5);
  const distFromDoor = Math.hypot(backDx, backDy);
  check(distFromDoor > 0.9, `arrival point is far enough from the door trigger to avoid ping-ponging back in (dist=${distFromDoor.toFixed(2)})`);
}

// --- The back door is a one-way latch: it stays open even once a fresh
// dragon spawns (full "stays open across respawn" coverage lives in
// tools/cave_back_door_test.js; this is just a sanity check that THIS
// file's own dragon-kill-triggered open doesn't regress on a respawn). ----
{
  const freshDragon = { id: "dragon_test_fresh_" + Math.random(), type: "dragon", x: world.caveCenter.x, y: world.caveCenter.y };
  activeMonsters.set(freshDragon.id, freshDragon);
  check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 0, "back door tile stays walkable even after a fresh dragon spawns (one-way latch)");
  const p = freshOutsidePlayer(world.caveBackDoorTile.x + 0.5, world.caveBackDoorTile.y + 0.5);
  checkAreaTransition(p);
  check(p.area === "cavern", "standing on the back door tile still transitions into the cavern after a fresh dragon spawns");
}

console.log(failures === 0 ? "\nALL CAVERN TRANSITION CHECKS PASSED." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
