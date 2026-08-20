// Regression test for the cave doors' unlock behavior after a later
// request: "make the door that unlocks inside the cavern stay unlocked if
// the dragon dies, just like the side door". Previously the back door (into
// the cavern depths side-scroller) resealed/unsealed in lockstep with the
// main entrance on every dragon lifecycle (alive vs dead) -- so a fresh
// dragon respawning while someone was already past it would lock it again.
// Now it's a one-way latch, same as the west side door: opens once on the
// dragon's first death and stays open forever, independent of the main
// entrance re-sealing around subsequent dragon respawns.
//
// Binds its own port in-process (same rationale as other tools/*_test.js
// files) so this test can drive real killMonster()/setCaveSealed() code
// paths rather than reimplementing any of it.
const srv = require("../server/index.js");

const PORT = 3926;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await new Promise((resolve) => srv.server.listen(PORT, resolve));

  const world = srv.world;
  check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 1, "back door starts blocked while the dragon is alive");
  check(!srv.isCaveBackDoorOpened(), "caveBackDoorOpened starts false");

  const dragon = Array.from(srv.activeMonsters.values()).find((m) => m.type === "dragon");
  check(!!dragon, "a live dragon exists at startup (precondition)");

  // Kill it -- both one-way latches (side + back door) should open
  // immediately (set synchronously inside killMonster), and the main
  // entrance should unseal on the next tick (driven by the dragonAlive
  // check in the tick loop).
  srv.killMonster(dragon, Date.now());
  check(srv.isCaveBackDoorOpened(), "caveBackDoorOpened flips true the instant the dragon dies");
  check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 0, "back door tile is unblocked the instant the dragon dies");
  check(srv.isCaveSideDoorOpened(), "the side door still opens too (unchanged behavior)");

  await sleep(150); // let a tick run so setCaveSealed(dragonAlive=false) applies to the main entrance

  // Simulate a fresh dragon having respawned (the real scheduleDragonRespawn
  // timer is minutes long -- just drop a fresh dragon-typed monster into the
  // same activeMonsters map the tick loop's dragonAlive check reads, same
  // "exercise the real code path against directly-injected state" approach
  // used by other tools/*_test.js files).
  const freshDragon = { id: "dragon_test_fresh", type: "dragon", x: world.caveCenter.x, y: world.caveCenter.y };
  srv.activeMonsters.set(freshDragon.id, freshDragon);
  await sleep(150); // let a tick run so setCaveSealed(dragonAlive=true) reseals the main entrance

  check(world.collision[world.caveEntranceTiles[0].y][world.caveEntranceTiles[0].x] === 1, "the main entrance reseals once a fresh dragon is alive again");
  check(srv.isCaveBackDoorOpened(), "caveBackDoorOpened is STILL true after the fresh dragon respawns (one-way latch)");
  check(world.collision[world.caveBackDoorTile.y][world.caveBackDoorTile.x] === 0, "the back door tile stays unblocked even though the main entrance resealed");
  check(srv.isCaveSideDoorOpened(), "the side door also stays open (unchanged behavior, same latch pattern)");
  check(world.collision[world.caveSideDoorTile.y][world.caveSideDoorTile.x] === 0, "the side door tile stays unblocked too");

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL CAVE BACK DOOR LATCH CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
