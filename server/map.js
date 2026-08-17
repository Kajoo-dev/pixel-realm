// Procedural world map generation for Pixel Realm.
// Produces a grid of tile indices (matching public/assets/tileset.png
// tile order) plus a matching collision grid. Deterministic seed so the
// world layout is stable across server restarts.

const TILE_IDS = {
  grass: 0,
  grass2: 1,
  path: 2,
  water: 3,
  sand: 4,
  tree: 5,
  rock: 6,
  fence: 7,
  cave_floor: 8,
  cave_wall: 9,
};

const BLOCKED = new Set([TILE_IDS.water, TILE_IDS.tree, TILE_IDS.rock, TILE_IDS.fence, TILE_IDS.cave_wall]);

// Small deterministic PRNG (mulberry32) so the map is reproducible.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMap(width = 60, height = 42, seed = 1337) {
  const rand = mulberry32(seed);
  const grid = Array.from({ length: height }, () => new Array(width).fill(TILE_IDS.grass));

  // Sprinkle grass2 (flower) variant tiles.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rand() < 0.06) grid[y][x] = TILE_IDS.grass2;
    }
  }

  // Carve a lake (a few overlapping blobs) roughly in one quadrant.
  const lakeCenters = [
    { cx: Math.floor(width * 0.72), cy: Math.floor(height * 0.28), r: 6 },
    { cx: Math.floor(width * 0.78), cy: Math.floor(height * 0.34), r: 4 },
  ];
  for (const { cx, cy, r } of lakeCenters) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
        const d = Math.hypot(x - cx, y - cy) + (rand() - 0.5) * 1.6;
        if (d <= r) grid[y][x] = TILE_IDS.water;
        else if (d <= r + 1.2) grid[y][x] = TILE_IDS.sand;
      }
    }
  }

  // A winding dirt path from the west edge to the spawn plaza.
  let px = 2;
  let py = Math.floor(height * 0.55);
  const plazaX = Math.floor(width * 0.32);
  while (px < plazaX) {
    grid[py][px] = TILE_IDS.path;
    if (rand() < 0.35 && py > 2) py -= 1;
    else if (rand() < 0.35 && py < height - 3) py += 1;
    px += 1;
    grid[py][px] = TILE_IDS.path;
  }

  // A small spawn plaza (open grass, fenced ring) around the path end.
  const plazaY = py;
  for (let y = plazaY - 4; y <= plazaY + 4; y++) {
    for (let x = plazaX - 4; x <= plazaX + 4; x++) {
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
      const onRing = Math.max(Math.abs(x - plazaX), Math.abs(y - plazaY)) === 4;
      if (onRing && rand() < 0.7) grid[y][x] = TILE_IDS.fence;
      else if (!onRing) grid[y][x] = grid[y][x] === TILE_IDS.grass2 ? TILE_IDS.grass2 : TILE_IDS.path;
    }
  }
  // leave gaps in the fence ring so it's enterable
  grid[plazaY - 4][plazaX] = TILE_IDS.path;
  grid[plazaY + 4][plazaX] = TILE_IDS.path;
  grid[plazaY][plazaX - 4] = TILE_IDS.path;
  grid[plazaY][plazaX + 4] = TILE_IDS.path;

  // Scatter trees and rocks across open grass, avoiding the plaza/path/lake.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const t = grid[y][x];
      if (t !== TILE_IDS.grass && t !== TILE_IDS.grass2) continue;
      const nearPlaza = Math.abs(x - plazaX) < 6 && Math.abs(y - plazaY) < 6;
      if (nearPlaza) continue;
      const r = rand();
      if (r < 0.05) grid[y][x] = TILE_IDS.tree;
      else if (r < 0.065) grid[y][x] = TILE_IDS.rock;
    }
  }

  // Carve a large dragon cave into the top-right corner: a walled cavern
  // (cave_wall border, cave_floor interior) with a gap in the south wall
  // as the entrance, connecting straight out into open grass. Carved after
  // the lake/tree/rock passes so it cleanly overrides anything already
  // placed there.
  const caveW = 19, caveH = 13;
  const caveX1 = width - 3;
  const caveX0 = caveX1 - caveW + 1;
  const caveY0 = 1;
  const caveY1 = caveY0 + caveH - 1;
  // Wide enough for the dragon's own bulk (terrain-collision radius ~1.5
  // tiles) to actually walk through with room to spare, not just a player.
  const entranceW = 7;
  const entranceX0 = caveX0 + Math.floor((caveW - entranceW) / 2);

  for (let y = caveY0; y <= caveY1; y++) {
    for (let x = caveX0; x <= caveX1; x++) {
      const onBorder = x === caveX0 || x === caveX1 || y === caveY0 || y === caveY1;
      const inEntranceGap = y === caveY1 && x >= entranceX0 && x < entranceX0 + entranceW;
      grid[y][x] = onBorder && !inEntranceGap ? TILE_IDS.cave_wall : TILE_IDS.cave_floor;
    }
  }
  // A clear approach corridor stretching out from the entrance -- deep
  // enough to punch all the way through the lake that sits just south of
  // the cave, so the entrance never opens onto open water. Clears trees,
  // rocks, sand, AND water (unlike the small decorative aprons elsewhere).
  for (let y = caveY1 + 1; y <= Math.min(height - 2, caveY1 + 10); y++) {
    for (let x = entranceX0 - 2; x <= entranceX0 + entranceW + 1; x++) {
      if (x < 1 || x >= width - 1) continue;
      const t = grid[y][x];
      if (t === TILE_IDS.tree || t === TILE_IDS.rock || t === TILE_IDS.sand || t === TILE_IDS.water) {
        grid[y][x] = TILE_IDS.grass;
      }
    }
  }
  const caveEntrance = {
    x: entranceX0 + entranceW / 2,
    y: caveY1 + 1.5,
  };

  // Border the whole map with trees so players can't walk off the edge.
  for (let x = 0; x < width; x++) {
    grid[0][x] = TILE_IDS.tree;
    grid[height - 1][x] = TILE_IDS.tree;
  }
  for (let y = 0; y < height; y++) {
    grid[y][0] = TILE_IDS.tree;
    grid[y][width - 1] = TILE_IDS.tree;
  }

  const collision = grid.map((row) => row.map((t) => (BLOCKED.has(t) ? 1 : 0)));

  return {
    width,
    height,
    grid,
    collision,
    spawn: { x: plazaX, y: plazaY },
    caveEntrance,
  };
}

module.exports = { generateMap, TILE_IDS, BLOCKED };
