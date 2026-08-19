// Direct unit test of Player.applyCavernInput's platformer physics --
// landing on the ground floor, landing on a one-way tier platform, and
// crouch+jump dropping through a platform -- run against the REAL server
// code (via require, guarded by require.main so it doesn't bind the port a
// second time), not a hand-copied reimplementation.
const { Player, cavernLevel } = require("../server/index.js");

const TICK_MS = 50;
const dt = TICK_MS / 1000;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

function freshCavernPlayer(x, y) {
  const p = new Player("test" + Math.random(), "Tester", "red", "human");
  p.area = "cavern";
  p.x = x;
  p.y = y;
  p.vy = 0;
  p.grounded = false;
  p.groundedTier = null;
  p.crouching = false;
  p.dropThroughUntil = 0;
  p.input = { up: false, down: false, left: false, right: false };
  return p;
}

function tick(p, now, n = 1) {
  for (let i = 0; i < n; i++) p.applyCavernInput(dt, now + i * TICK_MS);
}

// --- Test 1: falling from directly above open ground (no platform in the
//     way at any tier) lands on the ground floor -------------------------
{
  // Find an x with no tier-1 or tier-2 platform overlapping it at all, so
  // this is a clean "nothing to land on until the ground" test.
  let clearX = null;
  for (let x = 1; x < cavernLevel.width - 1; x += 0.5) {
    const blocked = cavernLevel.platforms.some((pl) => x > pl.x0 && x < pl.x1);
    if (!blocked) { clearX = x; break; }
  }
  check(clearX !== null, `found an x with no platform overhead to test pure ground-fall (x=${clearX})`);
  const p = freshCavernPlayer(clearX, cavernLevel.groundY - 5);
  tick(p, 1000, 60); // 3s of falling, plenty of time
  check(p.grounded === true && p.groundedTier === 0, `falls and lands on ground floor (y=${p.y}, grounded=${p.grounded}, tier=${p.groundedTier})`);
  check(Math.abs(p.y - cavernLevel.groundY) < 0.01, `settles exactly at groundY (${p.y} vs ${cavernLevel.groundY})`);
}

// --- Test 2: jumping under a tier-1 platform segment lands on it --------
{
  const plat = cavernLevel.platforms.find((pl) => pl.tier === 1);
  const midX = (plat.x0 + plat.x1) / 2;
  const p = freshCavernPlayer(midX, cavernLevel.groundY);
  p.grounded = true;
  p.groundedTier = 0;
  // Simulate a jump impulse (same as the "jump" socket handler does).
  p.vy = -11.5;
  p.grounded = false;
  p.groundedTier = null;
  tick(p, 2000, 40); // 2s -- plenty to reach apex and come back down
  check(p.grounded === true && p.groundedTier === 1, `jump from ground lands on tier-1 platform (y=${p.y}, tier=${p.groundedTier})`);
  check(Math.abs(p.y - plat.y) < 0.01, `settles exactly at the platform's y (${p.y} vs ${plat.y})`);
}

// --- Test 3: crouch + jump while grounded on tier 1 drops through to ----
//     ground (the "S + space" drop-through mechanic)
{
  const plat = cavernLevel.platforms.find((pl) => pl.tier === 1);
  const midX = (plat.x0 + plat.x1) / 2;
  const p = freshCavernPlayer(midX, plat.y);
  p.grounded = true;
  p.groundedTier = 1;
  p.crouching = true;
  // Simulate the "jump" handler's drop-through branch.
  const now0 = 3000;
  p.dropThroughUntil = now0 + 350;
  p.vy = 3;
  p.grounded = false;
  p.groundedTier = null;
  tick(p, now0, 30); // 1.5s
  check(p.grounded === true && p.groundedTier === 0, `crouch+jump drops through tier-1 onto the ground (y=${p.y}, tier=${p.groundedTier})`);
}

// --- Test 4: a normal jump (not crouching) from tier 1 does NOT fall ----
//     through tier 1 itself (sanity: only intentional drop-through skips
//     one-way collision, not every jump)
{
  const plat = cavernLevel.platforms.find((pl) => pl.tier === 1);
  const midX = (plat.x0 + plat.x1) / 2;
  const p = freshCavernPlayer(midX, plat.y);
  p.grounded = true;
  p.groundedTier = 1;
  p.crouching = false;
  p.vy = -11.5; // normal jump impulse
  p.grounded = false;
  p.groundedTier = null;
  tick(p, 4000, 40); // 2s, full arc
  check(p.grounded === true && p.groundedTier === 1, `plain jump from tier-1 lands back on tier-1, doesn't fall through (tier=${p.groundedTier})`);
}

// --- Test 5: jumping in a GAP under tier 1 (no platform there) falls all
//     the way to the ground, not stuck floating ------------------------
{
  // Find an x that's in a gap between two tier-1 segments.
  const tier1 = cavernLevel.platforms.filter((pl) => pl.tier === 1).sort((a, b) => a.x0 - b.x0);
  const gapX = (tier1[0].x1 + tier1[1].x0) / 2;
  const p = freshCavernPlayer(gapX, cavernLevel.groundY);
  p.grounded = true;
  p.groundedTier = 0;
  p.vy = -11.5;
  p.grounded = false;
  p.groundedTier = null;
  tick(p, 5000, 40);
  check(p.grounded === true && p.groundedTier === 0, `jump in a tier-1 gap falls back to ground, not stuck (tier=${p.groundedTier}, y=${p.y})`);
}

// --- Test 6: horizontal movement + world bounds clamp -------------------
{
  const p = freshCavernPlayer(1, cavernLevel.groundY);
  p.grounded = true;
  p.groundedTier = 0;
  p.input.left = true;
  tick(p, 6000, 20);
  check(p.x >= 0.5 && p.x <= 1, `walking left clamps at the level's left bound (x=${p.x})`);
}

console.log(failures === 0 ? "\nALL CAVERN PHYSICS CHECKS PASSED." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
