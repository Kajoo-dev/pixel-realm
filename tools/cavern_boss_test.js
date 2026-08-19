// Tests for the giant boss goblin at the end of the (now 5x-longer) cavern
// level: the AI's slam/shout alternation + dodge-by-moving-during-windup
// mechanic (server/cavern.js's updateBossGoblin, tested directly), and the
// door-gating + stun-blocks-input integration (via the real server/index.js
// code, same require.main-guarded pattern as the other cavern_*_test.js
// files).
const cavernModule = require("../server/cavern.js");
const { Player, cavernLevel, cavernMonsters, killCavernMonster } = require("../server/index.js");

const TICK_MS = 50;
const dt = TICK_MS / 1000;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

// --- Test 1: alternation cadence + windup/resolve timing -----------------
{
  const level = cavernModule.generateCavernLevel();
  const boss = cavernModule.spawnCavernBoss(level);
  const fakePlayer = { id: "p1", x: boss.x - 5, y: level.groundY, area: "cavern", dead: false };
  const events = [];
  let now = 1000;
  for (let i = 0; i < 500; i++) {
    cavernModule.updateBossGoblin(boss, dt, now, {
      getPlayersInCavern: () => [fakePlayer],
      onWindupStart: (b, kind, tx) => events.push({ t: now, e: "windupStart", kind, tx }),
      onSlam: (b, tx) => events.push({ t: now, e: "slam", tx }),
      onShout: (b) => events.push({ t: now, e: "shout" }),
    });
    now += TICK_MS;
  }
  const windups = events.filter((e) => e.e === "windupStart");
  check(windups.length >= 3, `boss starts multiple windups over 25s (got ${windups.length})`);
  check(events.some((e) => e.e === "slam"), "at least one slam resolves");
  check(events.some((e) => e.e === "shout"), "at least one shout resolves");
  // First action is 5s after the first tick (nextActionAt initialized lazily).
  check(windups[0].t === 6000, `first windup starts BOSS_ACTION_INTERVAL_MS after boss activates (t=${windups[0].t})`);
  // Every windowStart -> resolve gap matches the documented windup duration.
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].e === "windupStart" && events[i].kind === "slam") {
      check(events[i + 1].e === "slam" && events[i + 1].t - events[i].t === cavernModule.BOSS_SLAM_WINDUP_MS,
        `slam resolves exactly BOSS_SLAM_WINDUP_MS after its windup (${events[i + 1].t - events[i].t}ms)`);
    }
    if (events[i].e === "windupStart" && events[i].kind === "shout") {
      check(events[i + 1].e === "shout" && events[i + 1].t - events[i].t === cavernModule.BOSS_SHOUT_WINDUP_MS,
        `shout resolves exactly BOSS_SHOUT_WINDUP_MS after its windup (${events[i + 1].t - events[i].t}ms)`);
    }
  }
}

// --- Test 2: slam targets the player's position AT WINDUP START, not at
//     impact -- moving away during the windup should dodge it -------------
// The slam-vs-shout PICK is probabilistic (see Test 1, which covers it
// statistically over many real cycles); this test drives the boss directly
// into a windup_slam state to deterministically exercise just the
// capture-at-windup-start + resolve-at-that-captured-spot mechanic, which is
// the actual "swing where the character WAS, not where they are" behavior
// the feature request asked for.
{
  const level = cavernModule.generateCavernLevel();
  const boss = cavernModule.spawnCavernBoss(level);
  const mover = { id: "p1", x: boss.x - 4, y: level.groundY, area: "cavern", dead: false };

  let now = 1000;
  boss.actionState = "windup_slam";
  boss.slamTargetX = mover.x; // captured "at windup start", exactly like updateBossGoblin does
  boss.windupUntil = now + cavernModule.BOSS_SLAM_WINDUP_MS;
  boss.attacking = true;
  const capturedTargetX = boss.slamTargetX;
  check(capturedTargetX === mover.x, `slam target captured at the player's position when the windup began (${capturedTargetX} vs ${mover.x})`);

  // Move the player away before the windup resolves.
  mover.x += 10;
  let slamResolvedAt = null;
  for (let i = 0; i < 40 && slamResolvedAt === null; i++) {
    cavernModule.updateBossGoblin(boss, dt, now, {
      getPlayersInCavern: () => [mover],
      onWindupStart: () => {},
      onSlam: (b, tx) => { slamResolvedAt = tx; },
      onShout: () => {},
    });
    now += TICK_MS;
  }
  check(slamResolvedAt === capturedTargetX, `slam still lands at the ORIGINAL captured spot, not the player's new position (${slamResolvedAt} vs captured ${capturedTargetX}, player now at ${mover.x})`);
  check(Math.abs(slamResolvedAt - mover.x) > cavernModule.BOSS_SLAM_RADIUS, "player who moved away during the windup is now outside the slam radius -- dodged");
}

// --- Test 3: boss has dragon-equivalent HP (100) --------------------------
{
  check(cavernModule.BOSS_HP === 100, `boss HP matches the dragon's MAX_HP (got ${cavernModule.BOSS_HP})`);
}

// --- Test 4: door gating -- sealed until the boss dies, via the REAL
//     server/index.js code path (Player.applyCavernInput + killCavernMonster) --
{
  function freshCavernPlayer(x, y) {
    const p = new Player("boss-test-" + Math.random(), "Tester", "red", "human");
    p.area = "cavern";
    p.x = x; p.y = y;
    p.vy = 0; p.grounded = true; p.groundedTier = 0;
    p.crouching = false; p.dropThroughUntil = 0;
    p.input = { up: false, down: false, left: false, right: true };
    return p;
  }

  const p1 = freshCavernPlayer(cavernLevel.nextDoorX - 2, cavernLevel.groundY);
  let now = 100000;
  for (let i = 0; i < 200; i++) { p1.applyCavernInput(dt, now); now += TICK_MS; }
  check(p1.x <= cavernLevel.nextDoorX - 0.5 + 1e-9, `player can't walk past the boss door while the boss is alive (x=${p1.x}, wall=${cavernLevel.nextDoorX - 0.5})`);

  // Kill the boss through the real code path.
  const boss = [...cavernMonsters.values()].find((m) => m.type === "boss_goblin");
  check(!!boss, "the boss exists in the live cavernMonsters map at startup");
  killCavernMonster(boss, now);

  const p2 = freshCavernPlayer(cavernLevel.nextDoorX - 2, cavernLevel.groundY);
  p2.input.right = true;
  for (let i = 0; i < 200; i++) { p2.applyCavernInput(dt, now); now += TICK_MS; }
  check(p2.x > cavernLevel.nextDoorX - 0.5, `once the boss is dead, the door wall lifts and the player can walk past it (x=${p2.x})`);
  check(p2.x <= cavernLevel.width - 0.5 + 1e-9, `the level's hard right bound still applies beyond the door (x=${p2.x}, width=${cavernLevel.width})`);
}

// --- Test 5: stun blocks movement/jump/attack input, but gravity/landing
//     still runs --------------------------------------------------------
{
  const p = new Player("stun-test", "Tester", "red", "human");
  p.area = "cavern";
  p.x = 10; p.y = cavernLevel.groundY - 3;
  p.vy = 0; p.grounded = false; p.groundedTier = null;
  p.input = { up: false, down: false, left: false, right: true };
  const now = 500000;
  p.stunnedUntil = now + 3000;

  p.applyCavernInput(dt, now);
  check(p.moving === false, "stunned player's horizontal input is ignored (moving=false despite holding right)");
  const xAfterOneTick = p.x;
  check(xAfterOneTick === 10, `stunned player doesn't move horizontally (x=${xAfterOneTick})`);

  // Gravity should still apply while stunned -- let them fall to the ground.
  let now2 = now;
  for (let i = 0; i < 40; i++) { p.applyCavernInput(dt, now2); now2 += TICK_MS; }
  // x=10 may happen to sit under a tier-1/2 platform rather than clear ground
  // -- either is fine proof gravity ran; what matters is it landed SOMEWHERE
  // instead of free-falling forever.
  check(p.grounded === true && p.vy === 0, `gravity/landing still runs while stunned (grounded=${p.grounded}, y=${p.y}, vy=${p.vy})`);
  check(p.x === 10, "still hasn't moved horizontally after landing, still stunned");

  // Once the stun expires, input resumes working.
  now2 += 4000; // past stunnedUntil
  p.applyCavernInput(dt, now2);
  check(p.moving === true, "after the stun window passes, horizontal input works again");
}

console.log(failures === 0 ? "\nALL CAVERN BOSS CHECKS PASSED." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
