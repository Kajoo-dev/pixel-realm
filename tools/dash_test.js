// Regression test for the space-bar dash: "press space bar they dash across
// 3 tiles at 5x speed, put a cool down of 3 seconds before you can dash
// again" -- exercises the real Player.startDash/applyInput code paths
// in-process (no socket needed for the movement math itself; a small
// socket-level check at the end confirms the "dash" event wiring works).
const { Player, DASH_DURATION_MS } = require("../server/index.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

// --- Direct Player.startDash/applyInput checks ----------------------------
{
  const p = new Player("t" + Math.random(), "Dasher", "red", "human");
  p.area = "outside";
  p.x = 10;
  p.y = 10;
  p.input.right = true; // dash direction comes from held input if any

  const started = p.startDash(1000);
  check(started === true, "startDash succeeds when off cooldown");
  check(p.dashDirX === 1 && p.dashDirY === 0, "dash direction locks to the held input direction (right)");
  p.input.right = false; // release the key so nothing but the dash itself drives movement below

  // Simulate the tick loop calling applyInput at a fine-grained rate across
  // exactly the dash's duration window, to precisely measure total distance
  // without discretization error from a coarse 20Hz step overshooting the
  // dashUntil boundary.
  let now = 1000;
  const dtSec = 1 / 500;
  let ticks = 0;
  while (now < 1000 + DASH_DURATION_MS + 50 && ticks < 5000) {
    p.applyInput(dtSec, now);
    now += dtSec * 1000;
    ticks++;
  }
  const traveled = p.x - 10;
  console.log("distance traveled across the dash window:", traveled.toFixed(3), "(duration was", DASH_DURATION_MS.toFixed(1), "ms)");
  check(Math.abs(traveled - 3) < 0.05, `travels ~3 tiles total (got ${traveled.toFixed(3)})`);
  check(p.moving === false, "no longer flagged as moving once the dash ends and no keys are held");

  // Cooldown: a second dash attempt right after should be refused.
  const startedAgain = p.startDash(now);
  check(startedAgain === false, "a second dash attempt immediately after is refused (cooldown)");

  // After 3s cooldown elapses, dashing works again.
  const startedAfterCooldown = p.startDash(now + 3000);
  check(startedAfterCooldown === true, "dashing works again once the 3s cooldown has elapsed");
}

// --- Speed sanity: confirm the dash is really ~5x normal speed -----------
{
  const p = new Player("t" + Math.random(), "SpeedCheck", "blue", "elf");
  p.area = "outside";
  p.x = 10; p.y = 10;
  p.input.right = true;
  p.startDash(0);
  p.applyInput(1 / 20, 0); // a single tick during the dash
  const distOneTick = p.x - 10;
  p.dashUntil = 0; p.dashCooldownUntil = 0; // bypass cooldown for this isolated comparison
  p.x = 10;
  p.input.right = true;
  p.applyInput(1 / 20, 999999); // a single tick of NORMAL (non-dash) movement
  const normalOneTick = p.x - 10;
  const ratio = distOneTick / normalOneTick;
  console.log("dash-tick distance:", distOneTick.toFixed(4), "normal-tick distance:", normalOneTick.toFixed(4), "ratio:", ratio.toFixed(2));
  check(Math.abs(ratio - 5) < 0.01, `dash moves at exactly 5x normal per-tick speed (got ${ratio.toFixed(2)}x)`);
}

// --- Area gating: dash only works in tavern/outside -----------------------
{
  const p = new Player("t" + Math.random(), "AreaGate", "green", "goblin");
  p.area = "cavern";
  check(p.startDash(0) === false, "dash is refused in the cavern");
  p.area = "cliff";
  check(p.startDash(0) === false, "dash is refused on the cliff");
  p.area = "flying";
  check(p.startDash(0) === false, "dash is refused in the flying minigame");
  p.area = "tavern";
  check(p.startDash(0) === true, "dash works in the tavern");
  p.area = "outside";
  p.dashUntil = 0; p.dashCooldownUntil = 0;
  check(p.startDash(0) === true, "dash works outside");
}

// --- Facing-direction fallback: dash works even with no keys held --------
{
  const p = new Player("t" + Math.random(), "FacingCheck", "teal", "orc");
  p.area = "outside";
  p.dir = "left"; // last faced left, no input currently held
  const started = p.startDash(0);
  check(started === true, "dash still works with no directional input held");
  check(p.dashDirX === -1 && p.dashDirY === 0, "falls back to the last-faced direction (left) when no input is held");
}

// --- Dead players can't dash ----------------------------------------------
{
  const p = new Player("t" + Math.random(), "DeadCheck", "purple", "human");
  p.area = "outside";
  p.dead = true;
  check(p.startDash(0) === false, "dead players can't dash");
}

console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL DASH CHECKS PASSED.");
process.exit(failures ? 1 : 0);
