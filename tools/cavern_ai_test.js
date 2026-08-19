// Direct unit test of the goblin (melee) and troll (ranged) AI functions in
// server/cavern.js -- pure functions, testable without spinning up the
// server. Confirms: a goblin picks up aggro on a nearby same-tier player,
// chases toward them clamped to its platform bounds, and attacks once in
// range; a troll picks up aggro across tiers (within LOS tolerance) and
// fires a burst of arrows via onRangedShot.
const cavern = require("../server/cavern.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

const dt = 0.05;

// --- Goblin: chase + attack ------------------------------------------
{
  const g = new cavern.CavernMonster("goblin", 10, 18.2, 1, 5, 15);
  const player = { x: 13, y: 18.2, dead: false, area: "cavern" };
  let attacked = false;
  const opts = {
    getPlayersOnTier: (tier) => (tier === 1 ? [player] : []),
    onAttack: (goblin, target) => { attacked = true; },
  };
  // Run enough ticks to close the ~3-tile gap and land an attack.
  let now = 1000;
  for (let i = 0; i < 200; i++) {
    cavern.updateGoblin(g, dt, now, opts);
    now += 50;
    if (attacked) break;
  }
  check(g.aggroTarget === player, "goblin picks up aggro on a same-tier player within range");
  check(attacked, "goblin eventually attacks once in range");
  check(g.x >= g.x0 && g.x <= g.x1, `goblin stays clamped to its platform bounds (x=${g.x}, [${g.x0},${g.x1}])`);
}

// --- Goblin: does not aggro a player on a different tier ---------------
{
  const g = new cavern.CavernMonster("goblin", 10, 18.2, 1, 5, 15);
  const opts = {
    getPlayersOnTier: (tier) => [], // no players report as "on this tier"
    onAttack: () => { throw new Error("should not attack"); },
  };
  cavern.updateGoblin(g, dt, 1000, opts);
  check(g.aggroTarget === null, "goblin does not aggro when no player is on its tier");
}

// --- Troll: cross-tier LOS aggro + burst fire ---------------------------
{
  const t = new cavern.CavernMonster("troll", 20, 16.4, 2, 15, 25);
  const player = { x: 22, y: 18.2, dead: false, area: "cavern" }; // one tier below, within LOS tolerance
  const shots = [];
  const opts = {
    getPlayersInLOS: (y, tolerance) => (Math.abs(player.y - y) <= tolerance ? [player] : []),
    onRangedShot: (troll, target, shotIndex, shotCount) => shots.push({ shotIndex, shotCount }),
  };
  let now = 2000;
  for (let i = 0; i < 60; i++) {
    cavern.updateTroll(t, dt, now, opts);
    now += 50;
    if (shots.length) break;
  }
  check(t.aggroTarget === player, "troll picks up aggro across tiers within LOS tolerance");
  check(shots.length >= 1, `troll fires at least one shot (got ${shots.length})`);
  check(shots.every((s) => s.shotCount >= 1 && s.shotCount <= 3), "each volley is 1-3 arrows");
}

// --- Troll: does not aggro far outside LOS tolerance --------------------
{
  const t = new cavern.CavernMonster("troll", 20, 16.4, 2, 15, 25);
  const opts = {
    getPlayersInLOS: () => [], // nothing visible
    onRangedShot: () => { throw new Error("should not shoot"); },
  };
  cavern.updateTroll(t, dt, 2000, opts);
  check(t.aggroTarget === null, "troll does not aggro when nothing is in LOS");
}

console.log(failures === 0 ? "\nALL CAVERN AI CHECKS PASSED." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
