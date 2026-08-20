// The cliff area reached through the door the giant boss goblin unlocks at
// the end of the cavern depths: a short walkable ledge overlooking a
// crevasse, with a faded, distant view of the starting village behind it
// (purely a client-side painted backdrop -- no server-side geometry for it)
// and two small dragon NPCs. Walking up and touching a dragon launches the
// flying shooter minigame (see server/flying.js + index.js's enterFlying).
//
// Deliberately the same lightweight side-view foot-position convention as
// the cavern (x = horizontal position, y = a fixed ground line) but with NO
// gravity/jumping at all -- it's just a flat ledge to walk along, so
// Player.applyCliffInput (see index.js) is pure horizontal movement.

const CLIFF_WIDTH = 26; // tiles
const CLIFF_GROUND_Y = 12; // fixed foot-position y, arbitrary (no other tiers)
const CLIFF_EXIT_ZONE_X = 1.5; // walking back near here returns to the cavern's boss arena
const CLIFF_DRAGON_TOUCH_RADIUS = 1.1; // tiles

function generateCliffLevel() {
  const dragonSpots = [
    { x: CLIFF_WIDTH * 0.55, y: CLIFF_GROUND_Y },
    { x: CLIFF_WIDTH * 0.8, y: CLIFF_GROUND_Y },
  ];
  // "Put a bunch of barrels of booze next to the dragons on the cliff edge,
  // make sure they don't have collision" -- purely decorative positions;
  // applyCliffInput (index.js) is pure horizontal movement with no
  // decor/entity collision at all on this level, so "no collision" falls
  // out for free here, same as the cavern's torches/crystals decor.
  // Clustered just behind (lower x than) the first dragon spot, out of the
  // way of the touch-to-launch radius around each dragon.
  const barrelClusterX = dragonSpots[0].x - 2.4;
  const barrels = [
    { x: barrelClusterX, y: CLIFF_GROUND_Y },
    { x: barrelClusterX + 0.75, y: CLIFF_GROUND_Y },
    { x: barrelClusterX + 0.3, y: CLIFF_GROUND_Y - 0.55 }, // stacked on top
    { x: barrelClusterX + 1.5, y: CLIFF_GROUND_Y },
  ];
  // Moved further left than the barrel cluster itself -- the sign board is
  // rendered a full 6 tiles wide (SIGN_BOOZE_W, centered on this x), so the
  // original -1.1 offset put its right edge well past the barrels,
  // covering them up. -3.6 clears the whole cluster (barrelClusterX to
  // +1.5) with room to spare.
  const sign = { x: barrelClusterX - 3.6, y: CLIFF_GROUND_Y, text: "Goblin Booze, do not touch!" };

  return {
    width: CLIFF_WIDTH,
    groundY: CLIFF_GROUND_Y,
    spawn: { x: 3, y: CLIFF_GROUND_Y },
    exitZoneX: CLIFF_EXIT_ZONE_X,
    // Two small dragon NPCs waiting on the ledge -- touching either one
    // triggers the flying minigame.
    dragonSpots,
    barrels,
    sign,
  };
}

module.exports = {
  generateCliffLevel,
  CLIFF_WIDTH,
  CLIFF_GROUND_Y,
  CLIFF_DRAGON_TOUCH_RADIUS,
};
