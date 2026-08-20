// Regression test for the flying-minigame's giant dragon boss finale (see
// server/flying.js's header comment and the "waves" -> "bossIntro" -> "boss"
// -> "bossDying" -> "woosh" phase state machine in server/index.js's tick
// loop):
//   - the wave timer ending starts a scripted "bossIntro" beat (screech +
//     enemies-vanish/fireballs-cleared), THEN clears the small dragons and
//     spawns the giant "Dragon King" boss once BOSS_INTRO_MS elapses
//   - the boss fires 10-fireball cone volleys aimed at the player
//   - touching the boss still deals contact damage
//   - it takes exactly 100 player-fireball hits to kill it (doubled HP per a
//     later balance request)
//   - death clears its attack, fires flying_boss_died, then the player
//     wooshes off and lands back in the tavern
//
// Binds its own port in-process (same rationale as tools/flying_redo_test.js
// and tools/cavern_pit_test.js) so this test can drive the real tick loop
// and real enterFlying()/exitFlyingToTavern() code paths rather than
// reimplementing any of it.
const { io } = require("socket.io-client");
const flyingModule = require("../server/flying.js");
const srv = require("../server/index.js");

const PORT = 3925;
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

// Fast-forwards a fresh flying instance straight to the boss phase by
// backdating fs.startedAt past DURATION_MS, then waiting for the tick loop
// to run the "waves" -> "bossIntro" transition, plus the full bossIntro
// beat, plus a real tick for "bossIntro" -> "boss" itself.
async function forceBossPhase(player) {
  srv.enterFlying(player, Date.now());
  player.flying.startedAt = Date.now() - flyingModule.DURATION_MS - 100;
  await sleep(flyingModule.BOSS_INTRO_MS + 200);
}

(async () => {
  await new Promise((resolve) => srv.server.listen(PORT, resolve));

  check(flyingModule.BOSS_MAX_HP === 100, `BOSS_MAX_HP is 100 (got ${flyingModule.BOSS_MAX_HP})`);
  check(flyingModule.BOSS_CONE_COUNT === 10, `BOSS_CONE_COUNT is 10 (got ${flyingModule.BOSS_CONE_COUNT})`);

  // --- Case 1: wave timer ending starts the scripted bossIntro beat (which
  // clears the small dragons/fireballs immediately), then spawns the giant
  // boss once it elapses, which then opens fire with real 10-fireball cone
  // volleys. ------------------------------------------------------------
  {
    const { socket, ack } = await connect("BossPhaseCheck");
    const player = srv.players.get(ack.you.id);
    srv.enterFlying(player, Date.now());
    // Seed a couple of fake wave enemies so we can confirm they vanish.
    player.flying.enemies.push({ id: "fake1", x: 5, y: 5, hp: 3, maxHp: 3, lastAttackAt: 0, nextFireAt: Date.now() + 99999 });
    player.flying.enemies.push({ id: "fake2", x: 8, y: 3, hp: 3, maxHp: 3, lastAttackAt: 0, nextFireAt: Date.now() + 99999 });
    player.flying.startedAt = Date.now() - flyingModule.DURATION_MS - 100;

    let introInfo = null;
    socket.on("flying_boss_intro_start", (info) => { introInfo = info; });
    let bossStartInfo = null;
    socket.on("flying_boss_start", (info) => { bossStartInfo = info; });
    let firstVolley = null;
    socket.on("flying_boss_state", (s) => {
      if (!firstVolley && s.enemyProjectiles && s.enemyProjectiles.length > 0) firstVolley = s.enemyProjectiles;
    });

    await sleep(150);
    check(!!introInfo, "flying_boss_intro_start fired once the wave timer elapsed");
    check(player.flying.phase === "bossIntro", `player.flying.phase is "bossIntro" (got ${player.flying.phase})`);
    check(player.flying.enemies.length === 0, "the small wave dragons are cleared as soon as the intro starts");
    check(!bossStartInfo, "flying_boss_start has NOT fired yet -- the boss reveal waits for the intro beat");

    await sleep(flyingModule.BOSS_INTRO_MS + 150);
    check(!!bossStartInfo, "flying_boss_start fired once the bossIntro beat elapsed");
    check(player.flying.phase === "boss", `player.flying.phase is "boss" (got ${player.flying.phase})`);
    check(!!player.flying.boss && player.flying.boss.hp === 100, `the boss spawns with 100 hp (got ${player.flying.boss && player.flying.boss.hp})`);

    // Wait through the appear-grace period + up to the max fire interval for
    // a real cone volley to fire.
    await sleep(flyingModule.BOSS_APPEAR_GRACE_MS + flyingModule.BOSS_FIRE_INTERVAL_MAX_MS + 200);
    check(!!firstVolley, "the boss fired at least one cone volley");
    if (firstVolley) {
      check(firstVolley.length === 10, `a cone volley launches exactly 10 fireballs (got ${firstVolley.length})`);
    }
    socket.disconnect();
  }

  // --- Case 2: touching the giant dragon's body still deals contact damage.
  {
    const { socket, ack } = await connect("BossContactCheck");
    const player = srv.players.get(ack.you.id);
    await forceBossPhase(player);
    check(player.flying.phase === "boss", "reached the boss phase for the contact check");
    // Large hp buffer so the contact hit (and any stray cone-volley hits
    // during the wait below) can't kill/respawn the player mid-check.
    player.hp = player.maxHp = 1000;
    const boss = player.flying.boss;
    player.x = boss.x;
    player.y = boss.y;
    const hpBefore = player.hp;
    await sleep(150);
    check(player.hp < hpBefore, `standing on the boss dealt contact damage (hp ${hpBefore} -> ${player.hp})`);
    socket.disconnect();
  }

  // --- Case 3: exactly 100 hits kill it, then it explodes, wooshes, and the
  // player lands back in the tavern. -----------------------------------
  {
    const { socket, ack } = await connect("BossKillCheck");
    const player = srv.players.get(ack.you.id);
    await forceBossPhase(player);
    // Keep the player far from the boss so cone volleys/contact damage
    // can't kill it mid-test and trigger an unrelated respawn.
    player.hp = player.maxHp = 1000;
    player.x = 1; player.y = flyingModule.ARENA_H - 1;

    let bossDiedInfo = null;
    socket.on("flying_boss_died", (info) => { bossDiedInfo = info; });

    const boss = player.flying.boss;
    // Wait for each hit's hp decrement to actually land before firing the
    // next one, rather than assuming a fixed sleep is longer than one tick
    // -- with 99 hits needed (doubled from the original 49 per the HP
    // change above), a flat per-push sleep only slightly longer than
    // TICK_MS left enough cumulative scheduling jitter across ~5.5s of
    // real time for two pushes to occasionally land in the same tick and
    // silently lose a hit.
    for (let i = 0; i < 99; i++) {
      const hpBefore = player.flying.boss.hp;
      player.flying.projectiles.push({ id: "t" + i, x: boss.x, y: boss.y, vx: 0, vy: 0 });
      const deadline = Date.now() + 2000;
      while (player.flying.boss && player.flying.boss.hp === hpBefore && Date.now() < deadline) {
        await sleep(10);
      }
    }
    check(player.flying.phase === "boss", `still alive after 99 hits (phase=${player.flying.phase}, boss.hp=${player.flying.boss && player.flying.boss.hp})`);
    check(player.flying.boss && player.flying.boss.hp === 1, `boss has exactly 1 hp left after 99 hits (got ${player.flying.boss && player.flying.boss.hp})`);

    player.flying.projectiles.push({ id: "t99", x: boss.x, y: boss.y, vx: 0, vy: 0 });
    await sleep(80);

    check(player.flying.phase === "bossDying", `the 100th hit killed it (phase=${player.flying.phase})`);
    check(!!bossDiedInfo, "flying_boss_died fired on the killing blow");
    check(player.flying.enemyProjectiles.length === 0, "the cone-spray attack stops immediately on death");

    await sleep(flyingModule.BOSS_DEATH_FX_MS + 100);
    check(player.flying.phase === "woosh", `moves to the woosh phase after the death fx beat (phase=${player.flying.phase})`);

    await sleep(flyingModule.BOSS_WOOSH_MS + 300);
    check(player.area === "tavern", `lands back in the tavern once the woosh finishes (area=${player.area})`);
    check(player.flying === null, "the flying instance is torn down after returning to the tavern");
    socket.disconnect();
  }

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL FLYING BOSS FINALE CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
