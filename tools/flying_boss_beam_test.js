// Regression test for the flying-minigame boss's new fire-beam attack (see
// server/flying.js's BOSS_BEAM_* constants and the tick loop's boss-phase
// handling in server/index.js): "Add a new attack for the boss at the end
// of the dragon flight, make him do a fire beam in a straight line that
// moves with him as he strafes left and right, he can only make one pass to
// the left or right while the beam is active though, the player needs to
// stay ahead of it to avoid it."
//
// Binds its own port in-process (same rationale as other tools/*_test.js
// files) so this test can drive the real tick loop against a directly
// constructed boss-phase flying instance.
const { io } = require("socket.io-client");
const flyingModule = require("../server/flying.js");
const srv = require("../server/index.js");

const PORT = 3929;
const URL = `http://localhost:${PORT}`;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ["polling", "websocket"] });
    const timeout = setTimeout(() => reject(new Error("join timeout")), 8000);
    socket.on("connect", () => {
      socket.emit("join", { name, color: "blue", race: "human" }, (ack) => {
        clearTimeout(timeout);
        resolve({ socket, ack });
      });
    });
    socket.on("connect_error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

(async () => {
  await new Promise((resolve) => srv.server.listen(PORT, resolve));

  // --- Case 1: the beam telegraphs, then sweeps in ONE direction, then
  // turns off once it reaches the far edge -- never both a cone-spray and a
  // beam active at once. -----------------------------------------------
  {
    const { socket, ack } = await connect("BeamLifecycle");
    const player = srv.players.get(ack.you.id);
    const now = Date.now();
    player.area = "flying";
    player.x = flyingModule.ARENA_W / 2;
    player.y = flyingModule.ARENA_H / 2;
    // Tanky on purpose -- the sweep crosses the player's x at some point in
    // this check, and this test cares about the beam's own lifecycle
    // (telegraph -> sweep -> end), not about dying to it (that's covered
    // separately in case 2 below).
    player.maxHp = 999;
    player.hp = 999;
    player.flying = flyingModule.newFlyingState(now);
    player.flying.phase = "boss";
    player.flying.boss = flyingModule.newBossState(now);
    player.flying.boss.nextFireAt = now + 999999; // isolate the beam -- don't let cone-spray fire during this check
    player.flying.boss.nextBeamAt = now; // due immediately

    let sawStart = false, sawEnd = false, startedDir = null;
    socket.on("flying_boss_beam_start", (info) => { sawStart = true; startedDir = info.dir; });
    socket.on("flying_boss_beam_end", () => { sawEnd = true; });

    await sleep(150);
    check(sawStart, "a due beam attack fires the flying_boss_beam_start event");
    check(!!player.flying.boss.beam, "boss.beam is populated once triggered");
    check(player.flying.boss.beam.sweeping === false, "the beam starts in telegraph (not yet sweeping)");
    const expectedStartX = startedDir === 1 ? flyingModule.PLAYER_PAD : flyingModule.ARENA_W - flyingModule.PLAYER_PAD;
    check(Math.abs(player.flying.boss.x - expectedStartX) < 0.01, `the boss immediately snaps to the sweep's starting edge (dir=${startedDir}, x=${player.flying.boss.x})`);

    // Wait through the telegraph -- should flip to sweeping.
    const sweepDeadline = Date.now() + flyingModule.BOSS_BEAM_TELEGRAPH_MS + 400;
    while (Date.now() < sweepDeadline && !(player.flying.boss.beam && player.flying.boss.beam.sweeping)) await sleep(50);
    check(player.flying.boss.beam && player.flying.boss.beam.sweeping, "the beam transitions from telegraph to sweeping");

    // Confirm the boss's x is actually moving in the announced direction.
    const xAtSweepStart = player.flying.boss.x;
    await sleep(300);
    const movedCorrectDir = startedDir === 1
      ? player.flying.boss.x > xAtSweepStart
      : player.flying.boss.x < xAtSweepStart;
    check(movedCorrectDir, `the boss strafes in the single announced direction while sweeping (dir=${startedDir})`);

    // Let the full sweep finish (worst case ~ARENA_W / BOSS_BEAM_STRAFE_SPEED seconds).
    const fullSweepDeadline = Date.now() + (flyingModule.ARENA_W / flyingModule.BOSS_BEAM_STRAFE_SPEED) * 1000 + 1500;
    while (Date.now() < fullSweepDeadline && !sawEnd) await sleep(100);
    check(sawEnd, "the beam sends flying_boss_beam_end once it reaches the far edge");
    check(player.flying.boss.beam === null, "boss.beam is cleared once the pass completes");
    check(player.flying.boss.nextBeamAt > Date.now(), "a fresh cooldown is scheduled before the next beam pass");
    socket.disconnect();
  }

  // --- Case 2: standing in the beam's path while it sweeps takes damage;
  // staying clear (ahead of it, on the side it hasn't reached) never does. --
  {
    const { socket, ack } = await connect("BeamHitCheck");
    const player = srv.players.get(ack.you.id);
    const now = Date.now();
    player.area = "flying";
    player.hp = player.maxHp;
    player.flying = flyingModule.newFlyingState(now);
    player.flying.phase = "boss";
    player.flying.boss = flyingModule.newBossState(now);
    player.flying.boss.nextFireAt = now + 999999;
    // Force a sweep moving right (dir=1) starting from the left edge, and
    // stand the player right on the starting edge so the beam reaches them
    // almost immediately once sweeping begins.
    player.flying.boss.x = flyingModule.PLAYER_PAD;
    player.flying.boss.beam = { dir: 1, telegraphUntil: now - 1, sweeping: false, lastHitAt: 0 };
    player.flying.boss.nextBeamAt = now + 999999; // already mid-attack, don't retrigger
    player.x = flyingModule.PLAYER_PAD;
    player.y = flyingModule.ARENA_H / 2;

    const hpBefore = player.hp;
    await sleep(400);
    check(player.hp < hpBefore, "standing in the beam's starting path takes damage once it starts sweeping");
    socket.disconnect();
  }

  {
    const { socket, ack } = await connect("BeamMissCheck");
    const player = srv.players.get(ack.you.id);
    const now = Date.now();
    player.area = "flying";
    player.hp = player.maxHp;
    player.flying = flyingModule.newFlyingState(now);
    player.flying.phase = "boss";
    player.flying.boss = flyingModule.newBossState(now);
    player.flying.boss.nextFireAt = now + 999999;
    player.flying.boss.x = flyingModule.PLAYER_PAD;
    player.flying.boss.beam = { dir: 1, telegraphUntil: now - 1, sweeping: false, lastHitAt: 0 };
    player.flying.boss.nextBeamAt = now + 999999;
    // Player stays clear across the arena (ahead of a rightward sweep,
    // beyond the beam's half-width) the whole time.
    player.x = flyingModule.ARENA_W - flyingModule.PLAYER_PAD;
    player.y = flyingModule.ARENA_H / 2;

    const hpBefore = player.hp;
    await sleep(500);
    check(player.hp === hpBefore, "staying well clear of the beam's current position never takes damage");
    socket.disconnect();
  }

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL FLYING BOSS BEAM CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
