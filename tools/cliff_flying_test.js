// Tests for the post-boss cliff area (server/cliff.js) and the personal
// flying minigame (server/flying.js): door-gated entry into the cliff once
// the boss is dead, walking back out, touching a dragon NPC to launch
// flying, the flying arena's movement clamp, and the timer-driven return to
// the tavern. Same "exercise the real server/index.js code path" approach as
// the other cavern_*_test.js files.
const flyingModule = require("../server/flying.js");
const {
  Player, cavernLevel, cliffLevel, cavernMonsters, killCavernMonster,
  checkAreaTransition, enterCliff, exitCliff, enterFlying, exitFlyingToTavern,
} = require("../server/index.js");

const TICK_MS = 50;
const dt = TICK_MS / 1000;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

function freshPlayer(area, x, y) {
  const p = new Player("cliff-test-" + Math.random(), "Tester", "red", "human");
  p.area = area;
  p.x = x; p.y = y;
  p.input = { up: false, down: false, left: false, right: false };
  return p;
}

// Kill the real boss instance once, up front, so the door is open for every
// test below (mirrors what cavern_boss_test.js already verifies in
// isolation -- this file assumes that mechanic works and just needs the
// door OPEN to test what's on the other side of it).
{
  const boss = [...cavernMonsters.values()].find((m) => m.type === "boss_goblin");
  check(!!boss, "the boss exists at startup (precondition for the rest of this file)");
  if (boss && !boss.dead) killCavernMonster(boss, Date.now());
}

// --- Test 1: walking to the cavern's boss door enters the cliff -----------
{
  const p = freshPlayer("cavern", cavernLevel.nextDoorX - 0.3, cavernLevel.groundY);
  checkAreaTransition(p);
  check(p.area === "cliff", `walking up to the open boss door transitions into the cliff area (area=${p.area})`);
  check(p.x === cliffLevel.spawn.x && p.y === cliffLevel.spawn.y, `lands exactly at the cliff's spawn point (${p.x},${p.y} vs ${cliffLevel.spawn.x},${cliffLevel.spawn.y})`);
}

// --- Test 2: walking back to the cliff's entrance edge returns to the
//     cavern's boss arena -----------------------------------------------
{
  const p = freshPlayer("cliff", cliffLevel.exitZoneX - 0.1, cliffLevel.groundY);
  checkAreaTransition(p);
  check(p.area === "cavern", `walking back to the cliff's entrance returns to the cavern (area=${p.area})`);
  check(p.x < cavernLevel.nextDoorX, "arrival point in the cavern is clear of the door trigger (no ping-pong)");
}

// --- Test 3: cliff horizontal movement is flat, no gravity ----------------
{
  const p = freshPlayer("cliff", 5, cliffLevel.groundY);
  p.input.right = true;
  for (let i = 0; i < 20; i++) p.applyCliffInput(dt);
  check(p.x > 5, `walking right moves the player along the ledge (x=${p.x})`);
  check(p.y === cliffLevel.groundY, `y never leaves the fixed ground line (y=${p.y})`);
  check(p.grounded === true, "always reports grounded (no jump/gravity system on the cliff)");

  const pRight = freshPlayer("cliff", cliffLevel.width - 1, cliffLevel.groundY);
  pRight.input.right = true;
  for (let i = 0; i < 40; i++) pRight.applyCliffInput(dt);
  check(pRight.x <= cliffLevel.width - 0.5 + 1e-9, `clamps at the cliff's right bound (x=${pRight.x})`);
}

// --- Test 4: touching a dragon NPC launches the flying minigame -----------
{
  const spot = cliffLevel.dragonSpots[0];
  const p = freshPlayer("cliff", spot.x, spot.y);
  checkAreaTransition(p);
  check(p.area === "flying", `touching a dragon spot transitions into flying (area=${p.area})`);
  check(!!p.flying, "player.flying instance state is set");
  check(Array.isArray(p.flying.enemies) && p.flying.enemies.length === 0, "flying instance starts with no enemies yet");
  check(p.x === flyingModule.ARENA_W / 2 && p.y === flyingModule.ARENA_H - 2, `lands centered near the bottom of the flying arena (${p.x},${p.y})`);
}

// --- Test 5: flying movement is clamped to the arena, on both axes --------
{
  const p = freshPlayer("flying", flyingModule.ARENA_W / 2, flyingModule.ARENA_H - 2);
  p.flying = flyingModule.newFlyingState(Date.now());
  p.input = { up: true, down: false, left: true, right: false };
  for (let i = 0; i < 200; i++) p.applyFlyingInput(dt);
  check(Math.abs(p.x - flyingModule.PLAYER_PAD) < 1e-6, `clamps at the left edge (x=${p.x}, pad=${flyingModule.PLAYER_PAD})`);
  check(Math.abs(p.y - flyingModule.PLAYER_PAD) < 1e-6, `clamps at the top edge (y=${p.y}, pad=${flyingModule.PLAYER_PAD})`);

  p.input = { up: false, down: true, left: false, right: true };
  for (let i = 0; i < 200; i++) p.applyFlyingInput(dt);
  check(Math.abs(p.x - (flyingModule.ARENA_W - flyingModule.PLAYER_PAD)) < 1e-6, `clamps at the right edge (x=${p.x})`);
  check(Math.abs(p.y - (flyingModule.ARENA_H - flyingModule.PLAYER_PAD)) < 1e-6, `clamps at the bottom edge (y=${p.y})`);
}

// --- Test 6: exitFlyingToTavern (the minigame's timer-driven end) lands
//     the player in the tavern and clears their flying state -------------
{
  const p = freshPlayer("flying", 5, 5);
  p.flying = flyingModule.newFlyingState(Date.now());
  exitFlyingToTavern(p, Date.now());
  check(p.area === "tavern", `ends in the tavern (area=${p.area})`);
  check(p.flying === null, "flying instance state is cleared");
}

console.log(failures === 0 ? "\nALL CLIFF/FLYING CHECKS PASSED." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
