// Regression test for "have creatures give 4x more exp per kill" --
// LEVEL_XP_PER_KILL_BASE was bumped from 0.10 to 0.40 in server/index.js.
// Player.grantXp is the single choke point every kill path (outside
// monsters, the dragon, fire goblins, cavern goblins/troll, the cavern
// boss) funnels through, so this checks it directly rather than driving a
// full socket-level chase-and-kill (which is flaky/slow and, per earlier
// investigation, also complicated by players spawning in the tavern first).
const { Player } = require("../server/index.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

const p = new Player("t" + Math.random(), "Tester", "red", "human");
check(p.xp === 0 && p.level === 1, "starts at 0 xp, level 1");

p.grantXp(Date.now());
check(Math.abs(p.xp - 0.4) < 1e-9, `a level-1 kill grants 0.4 xp (4x the original 0.1), got ${p.xp}`);

// A cavern-goblin-style multiplier still stacks correctly on top of the new
// base -- 0.4 * 10 = 4.0 total xp granted, which (since leveling consumes
// exactly 1.0 xp per level, see Player.grantXp's loop) should land the
// player at level 5 (4 full level-ups) with 0 xp remaining.
const p2 = new Player("t" + Math.random(), "Tester2", "blue", "elf");
p2.grantXp(Date.now(), 10); // e.g. GOBLIN_XP_MULT
check(p2.level === 5, `a 10x-multiplier kill (0.4*10=4.0 total xp) levels the player up 4 times to level 5, got level ${p2.level}`);
check(Math.abs(p2.xp - 0) < 1e-9, `no leftover xp after the level-ups exactly consume the 4.0 granted, got ${p2.xp}`);

console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL XP MULTIPLIER CHECKS PASSED.");
process.exit(failures ? 1 : 0);
