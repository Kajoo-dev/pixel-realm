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
  tavern_wall: 10,
  tavern_floor: 11,
};

const BLOCKED = new Set([
  TILE_IDS.water,
  TILE_IDS.tree,
  TILE_IDS.rock,
  TILE_IDS.fence,
  TILE_IDS.cave_wall,
  TILE_IDS.tavern_wall,
]);

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
  const caveCenter = {
    x: (caveX0 + caveX1) / 2,
    y: (caveY0 + caveY1) / 2,
  };

  // Carve a small tavern building into the world, a little southwest of the
  // spawn plaza (offset far enough that its footprint doesn't touch the
  // plaza's fence ring). Walled (tavern_wall) with a single-tile door gap
  // (tavern_floor, walkable) in the south wall -- this is purely the
  // OUTSIDE shell players see/approach; the interior itself is a separate
  // small map from generateTavernMap() below, entered via an area
  // transition when the player reaches this door tile.
  const tavernW = 7, tavernH = 6;
  const tavernX0 = Math.max(2, plazaX - 13);
  const tavernY0 = Math.min(height - tavernH - 2, plazaY + 5);
  const tavernX1 = tavernX0 + tavernW - 1;
  const tavernY1 = tavernY0 + tavernH - 1;
  const tavernDoorX = tavernX0 + Math.floor(tavernW / 2);

  for (let y = tavernY0; y <= tavernY1; y++) {
    for (let x = tavernX0; x <= tavernX1; x++) {
      const onBorder = x === tavernX0 || x === tavernX1 || y === tavernY0 || y === tavernY1;
      const isDoor = y === tavernY1 && x === tavernDoorX;
      grid[y][x] = onBorder && !isDoor ? TILE_IDS.tavern_wall : TILE_IDS.tavern_floor;
    }
  }
  // Clear a small approach apron south of the door so it never opens onto a
  // tree/rock/fence.
  for (let y = tavernY1 + 1; y <= Math.min(height - 2, tavernY1 + 3); y++) {
    for (let x = tavernDoorX - 2; x <= tavernDoorX + 2; x++) {
      if (x < 1 || x >= width - 1) continue;
      const t = grid[y][x];
      if (t === TILE_IDS.tree || t === TILE_IDS.rock || t === TILE_IDS.fence) grid[y][x] = TILE_IDS.grass;
    }
  }
  const tavernDoorTile = { x: tavernDoorX, y: tavernY1 };
  // Where a player appears in the outside world right after walking out of
  // the tavern -- a couple tiles south of the door, clear of the door's own
  // "step inside" trigger zone so the two transitions don't ping-pong.
  const tavernOutsideSpawn = { x: tavernDoorX + 0.5, y: tavernY1 + 2.5 };

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
    caveCenter,
    tavernDoorTile,
    tavernOutsideSpawn,
  };
}

// The tavern interior: a bordered room (tavern_wall) with a single door gap
// (tavern_floor, walkable) at the bottom-center -- the "single exit at the
// bottom of the screen". The client renders this room as one painted
// background image rather than a tile mosaic (see public/js/game.js), so
// the room is sized square (matching that artwork's aspect ratio) and large
// enough that the image doesn't need to be squashed or heavily downscaled
// to fill it. Furniture collision (the bar counter and every table) is
// carved out directly as fractional (0..1) boxes matched against that
// artwork, independent of the tile grid underneath. Separate coordinate
// space from the outside world map; players are moved between the two by
// an area transition rather than sharing one grid.
function generateTavernMap(width = 26, height = 26) {
  const grid = Array.from({ length: height }, () => new Array(width).fill(TILE_IDS.tavern_floor));
  const doorX = Math.floor(width / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onBorder = x === 0 || x === width - 1 || y === 0 || y === height - 1;
      const isDoor = y === height - 1 && x === doorX;
      if (onBorder && !isDoor) grid[y][x] = TILE_IDS.tavern_wall;
    }
  }

  const collision = grid.map((row) => row.map((t) => (BLOCKED.has(t) ? 1 : 0)));

  // Block out furniture footprints as fractions of the room, located by
  // eye (and confirmed by pixel-scanning) against the painted artwork.
  const blockFrac = (x0f, y0f, x1f, y1f) => {
    const x0 = Math.max(1, Math.floor(x0f * width));
    const x1 = Math.min(width - 2, Math.ceil(x1f * width));
    const y0 = Math.max(1, Math.floor(y0f * height));
    const y1 = Math.min(height - 2, Math.ceil(y1f * height));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) collision[y][x] = 1;
    }
  };

  // Sized to each table's own footprint (a fixed half-extent around its
  // already-located candle point) rather than the generous crop margins
  // used to find those candles -- wide margins would touch/merge adjacent
  // tables into one solid mass with no floor left to walk between them.
  blockFrac(0.045, 0.02, 0.955, 0.30);   // bar counter + shelving/fireplace along the back wall
  blockFrac(0.1596, 0.3764, 0.2596, 0.4534); // table -- top-left
  blockFrac(0.7055, 0.3659, 0.8055, 0.4429); // table -- top-right
  blockFrac(0.1538, 0.5548, 0.2538, 0.6318); // table -- mid-left
  blockFrac(0.7006, 0.5213, 0.8006, 0.5983); // table -- mid-right
  blockFrac(0.4365, 0.4042, 0.5211, 0.4888); // table -- center, on the rug
  blockFrac(0.1806, 0.7032, 0.2806, 0.7802); // table -- bottom-left
  blockFrac(0.4386, 0.6296, 0.5386, 0.7066); // table -- bottom-center (in front of the door)
  blockFrac(0.6615, 0.6955, 0.7615, 0.7725); // table -- bottom-right

  // Spawn sits in the clear gap between the bottom-center table and the
  // door's exit-trigger zone, on the door's column.
  const spawn = { x: doorX + 0.5, y: height - 3.5 };
  const doorTile = { x: doorX, y: height - 1 };

  // Purely decorative (non-blocking) props -- only used if the client ever
  // falls back to tile rendering because the painted background failed to
  // load, so exact placement isn't critical.
  const decor = {
    barrels: [
      { x: width * 0.08, y: height * 0.08 },
      { x: width * 0.92, y: height * 0.08 },
      { x: width * 0.08, y: height * 0.85 },
    ],
    lights: [
      { x: doorX + 0.5, y: height - 0.5 }, // glow at the door itself
      { x: width * 0.08, y: height * 0.15 },
      { x: width * 0.92, y: height * 0.15 },
    ],
  };

  return { width, height, grid, collision, doorTile, spawn, decor };
}

module.exports = { generateMap, generateTavernMap, TILE_IDS, BLOCKED };
