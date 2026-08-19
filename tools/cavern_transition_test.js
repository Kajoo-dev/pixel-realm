// Direct integration test of the real door-transition wiring (checkAreaTransition,
// enterCavern/exitCavern, setCaveSealed) added to server/index.js for the
// cavern depths side-scroller -- run against the actual server code via
// require(), not a hand-copied reimplementation. Deliberately does NOT
// attempt a live dragon kill to unseal the cave through real combat (100 HP
// vs. a 10 HP player is a long, respawn-heavy fight not suited to a quick
// automated pass -- same reasoning tools/test_new_features.js documented
// earlier this session); instead drives setCaveSealed directly, which is
// exactly what a dragon death does server-side anyway.
const { Player, cavernLevel, world, checkAreaTransition, setCaveSealed, enterCavern, exitCavern } = require("../server/index.js");

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

// --- Unsealing (what a dragon death does) opens the back door ------------
setCaveSealed(false);
check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 0, "back door tile becomes walkable once unsealed");

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

// --- Re-sealing (dragon respawn) blocks the back door again --------------
setCaveSealed(true);
{
  check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 1, "back door tile is blocked again once re-sealed");
  const p = freshOutsidePlayer(world.caveBackDoorTile.x + 0.5, world.caveBackDoorTile.y + 0.5);
  checkAreaTransition(p);
  check(p.area === "outside", "standing on the back door tile after re-sealing does NOT transition into the cavern");
}

console.log(failures === 0 ? "\nALL CAVERN TRANSITION CHECKS PASSED." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
