// Regression test for "make the collision box for the tables inside the
// tavern smaller, I keep getting stuck on them" -- checks the shrunk
// blockFracTight footprint (server/map.js) actually reduces the blocked
// tile count around each table versus the old floor()/ceil()-rounded
// blockFrac, and that a player can path immediately adjacent to a table
// without being blocked as far out as before.
const { generateTavernMap } = require("../server/map.js");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

const map = generateTavernMap();

// Every table should block SOME tiles (still a real obstacle) but not an
// excessive area -- with the tightened half-extents (rect 0.62x0.42, round
// 0.5 radius) plus tile-center testing, each table should block at most 4
// tiles (a 2x2-ish footprint), never the old floor/ceil worst case of
// up to a 4x3 block.
for (const t of map.decor.tables) {
  let blocked = 0;
  const cx = Math.round(t.x), cy = Math.round(t.y);
  for (let y = cy - 2; y <= cy + 2; y++) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      if (map.collision[y] && map.collision[y][x]) blocked++;
    }
  }
  check(blocked >= 1, `${t.key} table blocks at least 1 tile (still a real obstacle, got ${blocked} in its 5x5 neighborhood)`);
  check(blocked <= 4, `${t.key} table's collision footprint is tight (<=4 tiles in its 5x5 neighborhood, got ${blocked})`);
}

// A tile diagonally 1 tile out from a table's center (a spot a player would
// reasonably expect to be walkable "next to" the table, not "on top of" it)
// should be open for at least the rect tables, given the new half-extents
// (0.62/0.42) are well under 1 full tile.
for (const t of map.decor.tables) {
  if (t.shape !== "rect") continue;
  const nx = Math.round(t.x) + 1, ny = Math.round(t.y) + 1;
  const open = !(map.collision[ny] && map.collision[ny][nx]);
  check(open, `${t.key} table: the tile 1 diagonal step out from its center is walkable (not swallowed by an oversized hitbox)`);
}

console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL TAVERN TABLE COLLISION CHECKS PASSED.");
process.exit(failures ? 1 : 0);
