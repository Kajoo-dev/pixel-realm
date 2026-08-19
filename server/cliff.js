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
  return {
    width: CLIFF_WIDTH,
    groundY: CLIFF_GROUND_Y,
    spawn: { x: 3, y: CLIFF_GROUND_Y },
    exitZoneX: CLIFF_EXIT_ZONE_X,
    // Two small dragon NPCs waiting on the ledge -- touching either one
    // triggers the flying minigame.
    dragonSpots: [
      { x: CLIFF_WIDTH * 0.55, y: CLIFF_GROUND_Y },
      { x: CLIFF_WIDTH * 0.8, y: CLIFF_GROUND_Y },
    ],
  };
}

module.exports = {
  generateCliffLevel,
  CLIFF_WIDTH,
  CLIFF_GROUND_Y,
  CLIFF_DRAGON_TOUCH_RADIUS,
};
