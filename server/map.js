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
};

const BLOCKED = new Set([TILE_IDS.water, TILE_IDS.tree, TILE_IDS.rock, TILE_IDS.fence]);

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
  };
}

module.exports = { generateMap, TILE_IDS, BLOCKED };
