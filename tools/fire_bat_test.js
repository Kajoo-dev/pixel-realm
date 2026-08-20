// Regression test for "make the bats that spawn in the side scroller spawn
// at the top of the cave ceiling then swoop down on you" -- exercises the
// real spawnFireBat/updateFireBat code paths from server/cavern.js
// directly (in-process), plus a light live-server check that a missed dive
// falling well past the ground floor actually gets cleaned up by the tick
// loop's widened out-of-bounds check (server/index.js).
const cavernModule = require("../server/cavern.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

const level = cavernModule.generateCavernLevel();

// --- Spawns right at the ceiling, not at the old mid-air height -----------
{
  const bat = cavernModule.spawnFireBat(level, 50);
  console.log("spawned fire_bat at y =", bat.y, "(CEILING_Y =", cavernModule.CEILING_Y, ")");
  check(bat.y > cavernModule.CEILING_Y && bat.y < cavernModule.CEILING_Y + 2, `spawns just below the ceiling (got y=${bat.y})`);
  check(bat.batState === "idle", "starts idle (perched)");
}

// --- Detects and swoops down on a player far below, purely by horizontal
// proximity (the old radial-range check would never have caught this --
// vertical gap alone from the ceiling to the ground tier exceeds the old
// 7-tile radius). ------------------------------------------------------
{
  const bat = cavernModule.spawnFireBat(level, 50);
  const playersInCavern = [{ x: 50.5, y: level.groundY, area: "cavern", dead: false }]; // almost directly below, ground tier
  cavernModule.updateFireBat(bat, 1 / 20, 1000, {
    getPlayersInCavern: () => playersInCavern,
    onAttack: () => {},
  });
  check(bat.batState === "diving", `swoops into "diving" for a player almost directly below on the ground tier (batState=${bat.batState})`);
}

// --- Does NOT trigger for a player far outside the horizontal detection
// window, even though (with the old idle height) a player at this exact
// offset would previously have been well within radial range. ------------
{
  const bat = cavernModule.spawnFireBat(level, 50);
  const playersInCavern = [{ x: 50 + 20, y: level.groundY, area: "cavern", dead: false }]; // way off to the side
  cavernModule.updateFireBat(bat, 1 / 20, 1000, {
    getPlayersInCavern: () => playersInCavern,
    onAttack: () => {},
  });
  check(bat.batState === "idle", `stays idle for a player far outside the horizontal detection window (batState=${bat.batState})`);
}

// --- A successful dive still hits/pops exactly as before ------------------
{
  const bat = cavernModule.spawnFireBat(level, 50);
  const target = { x: 50, y: level.groundY, area: "cavern", dead: false, takeDamage() {} };
  cavernModule.updateFireBat(bat, 1 / 20, 1000, { getPlayersInCavern: () => [target], onAttack: () => {} });
  check(bat.batState === "diving", "began diving toward the ground-tier target");
  let hit = false;
  for (let i = 0; i < 200 && !bat.dead; i++) {
    cavernModule.updateFireBat(bat, 1 / 20, 1000 + i * 50, {
      getPlayersInCavern: () => [target],
      onAttack: (b, t) => { hit = true; },
    });
  }
  check(hit, "the swoop eventually connects and calls onAttack");
  check(bat.dead === true, "the bat pops on a successful hit");
}

// --- Live-server check: a missed swoop that falls well past the ground
// floor actually gets cleaned up by the tick loop's widened out-of-bounds
// check (server/index.js), instead of falling forever below the visible
// level. Binds its own port in-process (same rationale as other
// tools/*_test.js files) so this drives the REAL tick loop. -------------
(async () => {
  const srv = require("../server/index.js");
  const PORT = 3930;
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  await new Promise((resolve) => srv.server.listen(PORT, resolve));

  const bat = new cavernModule.CavernMonster("fire_bat", 50, level.groundY + 3, 0, 0, level.bossArenaStart);
  bat.batState = "flyoff";
  bat.diveDirX = 0.02; // near-vertical miss -- barely any horizontal drift
  bat.diveDirY = 1; // straight down, past the floor
  srv.cavernMonsters.set(bat.id, bat);

  await sleep(400); // several ticks at 20Hz -- plenty of time to fall well past groundY+5
  const stillPresent = srv.cavernMonsters.has(bat.id);
  console.log("bat.y after falling:", bat.y, "still in cavernMonsters:", stillPresent);
  check(!stillPresent, "a missed swoop falling straight down past the ground floor gets cleaned up (doesn't fall forever)");

  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL FIRE BAT CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
