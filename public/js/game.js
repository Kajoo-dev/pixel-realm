(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const TILE = 16;              // native tile px in the sheet
  const RENDER_SCALE = 2;       // nominal on-screen scale factor (small/default windows)
  const RTILE = TILE * RENDER_SCALE; // nominal on-screen tile size in px
  const MAX_VISIBLE_TILES = 40; // hard viewport cap: never show more than this many tiles across

  // Race character sprites: taller-than-one-tile canvas, feet anchored to
  // the bottom row (same pattern as the tree/bird overlay sprites) so each
  // race can have a genuinely different on-screen height.
  const CHAR_NATIVE_W = 20, CHAR_NATIVE_H = 26, FRAMES = 3;
  const DIR_ROW = { down: 0, left: 1, right: 2, up: 3 };
  const RACES = ["human", "elf", "orc", "goblin"];

  // Monster sprites: flat 16x16, 2-frame walk cycle.
  const MONSTER_CW = 16, MONSTER_CH = 16, MONSTER_FRAMES = 2;

  const SPEED = 4.5;            // tiles/sec, must match server
  const PLAYER_RADIUS = 0.32;
  const PLAYER_ENTITY_RADIUS = 0.29; // must match server's ENTITY_RADIUS -- our own half-width for entity-vs-entity separation
  const ANIM_FPS = 6;
  const DASH_TRAIL_FADE_MS = 350; // how long each sampled mirage-trail copy takes to fully fade out
  const REMOTE_LERP = 0.35;     // smoothing factor per frame for remote players/monsters
  const LOCAL_CORRECT_LERP = 0.15;
  const NEARBY_FULL_OPACITY_DISTANCE = 15; // tiles: nearby-card stays fully opaque up to here
  let effRTile = RTILE;         // actual on-screen tile size, clamped so no more than
                                 // MAX_VISIBLE_TILES are ever visible in either dimension

  // Tile id this cell holds in map.grid -- must match TILE_IDS in
  // server/map.js. Only "tree" needs a client-side id since it's the one
  // tile type rendered as an animated overlay sprite instead of a flat
  // tileset blit (see drawTreeAt).
  const TILE_ID_WATER = 3;
  const TILE_ID_TREE = 5;
  // tileset.png strip indices for the 3 animated water shimmer frames
  // (see tools/gen_assets.py TILE_ORDER); cycled purely client-side so
  // the server's map grid never needs to know about the animation. Indices
  // 8/9 are the cave floor/wall tiles, 10/11 are the tavern wall/floor
  // tiles, and 12/13 are the outside tavern building's roof/roof-edge
  // tiles, so the two extra shimmer frames now live at 14/15.
  const WATER_FRAME_TILE_INDEX = [3, 14, 15];
  const WATER_FRAME_MS = 550;
  const NUM_GROUND_TILE_IDS = 14; // grass..tavern_roof_edge (0-13) -- real map tile ids, used for edge-blend color sampling

  // Standalone tree overlay sprite (native px, before effRTile scaling).
  // 4 side-by-side variants in trees.png; a tile's variant is picked
  // deterministically from a hash of its (row, col) so it's stable but varied.
  const TREE_NATIVE_W = 18, TREE_NATIVE_H = 32, TREE_VARIANTS = 4;
  // Bird sprite: 2 flap frames side by side in the sheet.
  const BIRD_NATIVE_W = 12, BIRD_NATIVE_H = 10;

  // Sword sprite: pivots around the hilt (native px coords) when swung.
  // Slightly smaller than the source art, and swung from an offset "hand"
  // position (see drawSwordSwing) instead of dead-center on the character.
  const SWORD_NATIVE_W = 24, SWORD_NATIVE_H = 8;
  const SWORD_PIVOT_X = 2, SWORD_PIVOT_Y = 4;
  const SWORD_SCALE = 0.82;
  const SWING_MS = 220;             // visual swing duration
  const SWING_ARC_RAD = (100 * Math.PI) / 180; // sweeps from -arc/2 to +arc/2 around the aim angle

  // Bow sprite: held/nocked with a quick draw-pulse (scale flash) instead of
  // an arc swing when the player's active weapon is the bow.
  const BOW_NATIVE_W = 20, BOW_NATIVE_H = 24;
  const BOW_PIVOT_X = 10, BOW_PIVOT_Y = 12;
  const BOW_SCALE = 0.9;

  // Arrow projectile sprite: points right by default, pivot at center.
  const ARROW_NATIVE_W = 16, ARROW_NATIVE_H = 6;

  // Tavern furniture decor sprites, generated in the same pixel-art style as
  // the rest of the game (tools/gen_assets.py). Flame-anchor offsets are the
  // sprite-local pixel coords of each item's candle/hearth flame, used to
  // position the flicker glow relative to each decor item's world position.
  const TABLE_RECT_W = 30, TABLE_RECT_H = 22, TABLE_RECT_FLAME = { x: 15, y: 7 };
  const TABLE_ROUND_W = 26, TABLE_ROUND_H = 24, TABLE_ROUND_FLAME = { x: 13, y: 1 };
  const FIREPLACE_W = 30, FIREPLACE_H = 36, FIREPLACE_FLAME = { x: 15, y: 20 };
  const BAR_UNIT_W = TILE, BAR_UNIT_H = 30; // repeatable 1-tile-wide segment, tiled across the bar span
  const SIGN_W = 84, SIGN_H = 30;
  const SIGN_BOOZE_W = 96, SIGN_BOOZE_H = 40;
  const SIGN_ROOF_W = 74, SIGN_ROOF_H = 30;
  const TREASURE_W = 18, TREASURE_H = 14;
  const HEADSTONE_W = 16, HEADSTONE_H = 22;

  const WATER_SPEED_MULT = 0.5; // must match server

  // Dragon-death fire hazard: touching it ignites the player (see
  // player.burning), who burns down over FIRE_BURN_MS -- purely visual
  // timing constants here, actual damage/timing is server-authoritative.
  const FIRE_HAZARD_RADIUS_VISUAL = 1.1;

  // Edge-dither tile blend mask (see tools/gen_assets.py edge_dither_mask.png):
  // a small alpha-only strip tinted per-neighboring-tile-color at load time
  // and stamped along tile borders so the ground doesn't read as a hard grid.
  const EDGE_W = TILE, EDGE_H = 6;

  // Dragon boss sprites: much larger than the small monsters, 4 tiles wide
  // by ~3 tiles high, with 3 separate 2-frame sheets (walk / claw / fire)
  // selected per-frame based on its current action.
  const DRAGON_CW = 88, DRAGON_CH = 68, DRAGON_FRAMES = 2;
  const DRAGON_ATTACK_ANIM_MS = 450; // just under the server's 500ms attack cooldown

  // --- Cavern depths (side-scroller through the cave's back door) --------
  // Player rendering in the cavern/cliff side-scrollers now reuses the
  // top-down charSprites sheet directly (see drawCavernPlayer) instead of a
  // dedicated profile-view sheet, so there's no separate player-sprite
  // layout to track here anymore.
  const CAVERN_SWING_MS = 260; // sword/bow 2-frame windup+strike anim duration
  // Widened from 20 -- the old canvas was too narrow to fit a clearly-visible
  // sword swing during the "attack" pose without the blade tip clipping off
  // the edge (see draw_goblin_frame in tools/gen_assets.py). cx there stays
  // at CW/2-1 so the walk/idle silhouette's foot-anchor offset is unchanged;
  // this just adds symmetric breathing room around it for the longer blade.
  const CAVERN_ENEMY_CW = 44, CAVERN_ENEMY_CH = 24;
  const CAVERN_ENEMY_ACTIONS = ["walk", "attack"];
  const CAVERN_PLATFORM_NATIVE_W = 16, CAVERN_PLATFORM_NATIVE_H = 10;
  const CAVERN_DOOR_NATIVE_W = 18, CAVERN_DOOR_NATIVE_H = 26;
  const CAVERN_HSPEED = 5; // tiles/sec, must match server's CAVERN_HSPEED
  // Giant boss goblin -- must match BOSS_CW/BOSS_CH/BOSS_ACTIONS/BOSS_FRAME_COUNTS
  // in tools/gen_assets.py.
  const BOSS_CW = 176, BOSS_CH = 240;
  const BOSS_ACTIONS = ["idle", "windup", "slam", "shout", "stomp"];
  const BOSS_FRAME_COUNTS = { idle: 2, windup: 2, slam: 2, shout: 2, stomp: 2 };
  // Fire bat -- must match BAT_CW/BAT_CH/BAT_FRAMES in tools/gen_assets.py.
  const BAT_CW = 22, BAT_CH = 16;
  const STUN_ICON_BOB_MS = 900;
  const BOSS_STUN_MS = 3000; // must match cavernModule.BOSS_STUN_MS on the server
  const BOSS_SLAM_RADIUS = 3.5; // tiles -- must match cavernModule.BOSS_SLAM_RADIUS
  const BOSS_STOMP_RANGE = 2.6; // tiles -- must match cavernModule.BOSS_STOMP_RANGE

  // --- Cliff area (post-boss) + flying minigame ---------------------------
  const FLYING_ARENA_W = 16, FLYING_ARENA_H = 10; // must match flyingModule.ARENA_W/H
  const FLYING_PLAYER_PAD = 0.7; // must match flyingModule.PLAYER_PAD
  const FLYING_ENEMY_SIZE = 22; // px, rendered at cavern-enemy-ish scale
  const FLYING_FIRE_SIZE = 10;

  // ---------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------
  const MUSIC_TRACKS = ["music_adventure1", "music_adventure2", "music_adventure3"];
  const TAVERN_MUSIC_TRACK = "music_tavern";
  const PARTY_MUSIC_TRACK = "music_party"; // upbeat cue once Dante starts dancing (booze delivered)
  const COMBAT_MUSIC_TRACK = "music_combat"; // fast-paced cue while the dragon/Goblin King boss is aggro'd
  const MUSIC_VOLUME = 0.32;
  const SWOOSH_VOLUME = 0.5;
  const FOOTSTEP_VOLUME = 0.22;
  const CLANG_VOLUME = 0.6;
  const DRAGON_ROAR_VOLUME = 0.7; // not distance-attenuated -- reads as an epic, everywhere-audible cue
  const FOOTSTEP_INTERVAL_MS = 300; // roughly one tiny "tip-toe" tap per step cycle
  const SFX_MAX_DISTANCE = 16; // tiles: remote sword/footstep sfx fade out past this range
  const LEVEL_UP_VOLUME = 0.8; // not distance-attenuated -- it's always about you
  const CLUNK_VOLUME = 0.45;
  const WOOSH_VOLUME = 0.55; // giant boss club swinging through the air
  const THUD_VOLUME = 0.75; // giant boss club hitting the ground
  const SCREAM_VOLUME = 0.7; // giant boss's scream/stun attack
  const SCREECH_VOLUME = 0.85; // not distance-attenuated -- the boss's death cry, everywhere-audible

  // Smoke death-poof: 4-frame expanding puff.
  const SMOKE_SIZE = 20, SMOKE_FRAMES = 4, SMOKE_TOTAL_MS = 650;
  const DEATH_FX_MS = 650;

  const PLAYER_MAX_HP = 10;
  const MONSTER_MAX_HP = 3;

  const COLOR_HEX = {
    red: "#d6403a", blue: "#3a6cd6", green: "#429e54", yellow: "#deb630",
    purple: "#8c46be", teal: "#30aaaa", orange: "#e67e22", pink: "#e66ea0",
  };
  const COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];

  const RACE_LABELS = { human: "Human", elf: "Elf", orc: "Orc", goblin: "Goblin" };

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------
  const canvas = document.getElementById("game-canvas");
  const ctx = canvas.getContext("2d");
  const loginOverlay = document.getElementById("login-overlay");
  const nameInput = document.getElementById("name-input");
  const swatchesEl = document.getElementById("swatches");
  const raceSelectEl = document.getElementById("race-select");
  const enterBtn = document.getElementById("enter-btn");
  const loginError = document.getElementById("login-error");
  const loginStatus = document.getElementById("login-status");
  const hud = document.getElementById("hud");
  const playerCountEl = document.getElementById("player-count");
  const chatLog = document.getElementById("chat-log");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const chatHint = document.getElementById("chat-hint");
  const voiceWidget = document.getElementById("voice-widget");
  const micToggle = document.getElementById("mic-toggle");
  const musicToggle = document.getElementById("music-toggle");
  const volumeWidget = document.getElementById("volume-widget");
  const musicVolumeSlider = document.getElementById("music-volume-slider");
  const sfxVolumeSlider = document.getElementById("sfx-volume-slider");
  const voiceStatus = document.getElementById("voice-status");
  const voiceSubstatus = document.getElementById("voice-substatus");
  const nearbyPanel = document.getElementById("nearby-panel");
  const deathBanner = document.getElementById("death-banner");
  const selfPortrait = document.getElementById("self-portrait");
  const selfAvatar = document.getElementById("self-avatar");
  const selfNameEl = document.getElementById("self-name");
  const selfLevelBadge = document.getElementById("self-level-badge");
  const selfHpFill = document.getElementById("self-hp-fill");
  const selfXpFill = document.getElementById("self-xp-fill");
  const nearbyRightStack = document.getElementById("nearby-right-stack");
  const weaponToggle = document.getElementById("weapon-toggle");
  const weaponSwordBtn = document.getElementById("weapon-sword-btn");
  const weaponBowBtn = document.getElementById("weapon-bow-btn");

  let selectedColor = "blue";
  COLORS.forEach((c) => {
    const el = document.createElement("div");
    el.className = "swatch" + (c === selectedColor ? " selected" : "");
    el.style.background = COLOR_HEX[c];
    el.dataset.color = c;
    el.addEventListener("click", () => {
      selectedColor = c;
      [...swatchesEl.children].forEach((s) => s.classList.toggle("selected", s === el));
    });
    swatchesEl.appendChild(el);
  });

  let selectedRace = "human";
  RACES.forEach((r) => {
    const el = document.createElement("div");
    el.className = "race-option" + (r === selectedRace ? " selected" : "");
    el.dataset.race = r;
    const img = document.createElement("img");
    img.src = `/assets/race_portrait_${r}.png`;
    img.alt = RACE_LABELS[r];
    img.draggable = false;
    const label = document.createElement("div");
    label.className = "race-label";
    label.textContent = RACE_LABELS[r];
    el.appendChild(img);
    el.appendChild(label);
    el.addEventListener("click", () => {
      selectedRace = r;
      [...raceSelectEl.children].forEach((s) => s.classList.toggle("selected", s === el));
    });
    raceSelectEl.appendChild(el);
  });

  // ---------------------------------------------------------------------
  // Networking state
  // ---------------------------------------------------------------------
  let socket = null;
  let myId = null;
  let worldMap = null; // { width, height, grid, collision, tavernDoorTile, caveBackDoorTile } -- the outside world
  let tavernMap = null; // { width, height, grid, collision, doorTile, decor } -- the tavern interior
  let cavernMap = null; // { width, groundY, tierY, platforms, spawn, exitZoneX } -- the side-scroller level
  let caveBackDoorTile = null; // {x,y} -- convenience copy of worldMap.caveBackDoorTile
  let caveSideDoorTile = null; // {x,y} -- convenience copy of worldMap.caveSideDoorTile
  let myArea = "tavern"; // "tavern" | "outside" | "cavern" -- which map/coordinate space I'm currently in
  function activeMap() { return myArea === "tavern" ? tavernMap : worldMap; }
  let swordState = { held: false, holderId: null, x: 0, y: 0 }; // the shared flaming sword item
  let bowState = { held: false, holderId: null, x: 0, y: 0 }; // the shared golden bow item
  let caveSealed = true; // whether the dragon's cave MAIN entrance is currently blocked off
  // The west side door AND the back door (into the cavern depths) are both
  // separate, one-way latches -- each opens once the dragon first dies and
  // never reseals, unlike caveSealed (the main entrance) above.
  let caveSideDoorOpened = false;
  let caveBackDoorOpened = false;
  let caveEntranceTiles = []; // [{x,y}] -- outside-world tiles the barrier renders over while sealed
  let caveTreasure = []; // [{x,y,variant}] -- purely decorative gold piles inside the cave
  let graveyardHeadstones = []; // [{x,y,variant}] -- purely decorative headstones at the death-respawn graveyard
  let tavernRoofSign = null; // {x,y} -- purely decorative "Dirtywood" sign above the outside tavern building's roof
  const fireHazards = []; // [{x,y,expiresAt}] -- dragon-death fire patches, outside world only
  const projectiles = new Map(); // id -> {id,x,y,angle} -- arrows currently in flight
  const cavernMonsters = new Map(); // id -> {type,tier,x,y,renderX,renderY,...} -- goblins/trolls in the cavern
  const cavernProjectiles = new Map(); // id -> {id,x,y,angle} -- cavern arrows (player- or troll-fired)
  const cavernDeathFx = []; // [{x,y,startTime}] -- simple death poofs for cavern monsters
  const cavernFallingSpikes = new Map(); // id -> {id,x,y,renderY,telegraphing} -- ceiling spikes, see cavern_falling_spikes
  const cavernSpikeImpactFx = []; // [{x,y,startTime}] -- brief dust puff where a falling spike lands
  // Current boss telegraph, if any -- set by cavern_boss_windup, cleared once
  // the windup resolves (cavern_boss_slam/cavern_boss_shout) or a fresh one
  // starts. Drives the warning-zone/screen-tint rendering in drawCavern.
  let cavernBossTelegraph = null; // { kind: "slam"|"shout", targetX, startTime, windupMs }
  let cavernBossFlashUntil = 0; // brief flash on slam impact / shout release
  let cavernBossFlashKind = null; // "slam" | "shout" -- which flash is currently active
  let cavernBossSpeech = null; // { text, until } -- random taunt bubble, see cavern_boss_taunt
  const cavernBoneFx = []; // { x, y, startTime } -- big bone pile dropped where the boss died
  let cliffMap = null; // { width, groundY, spawn, exitZoneX, dragonSpots } -- the post-boss cliff area
  // Flying minigame -- a PERSONAL instance, server-pushed only to this
  // client's own socket (see server/flying.js's header comment), so this
  // state is authoritative for "me" only, never for other players.
  let flyingActive = false;
  let flyingDurationMs = 75000;
  let flyingTimeLeftMs = 0;
  const flyingEnemies = new Map(); // id -> {id,x,y,hp,maxHp,renderX,renderY}
  const flyingProjectiles = new Map(); // id -> {id,x,y} -- player fireballs
  const flyingEnemyProjectiles = new Map(); // id -> {id,x,y} -- enemy fireballs (bullet-hell) / boss cone-spray fireballs
  const flyingDeathFx = []; // [{x,y,startTime}]

  // --- Giant dragon boss finale (see server/flying.js's header comment) ---
  // "waves" (the timed survival wave, existing behavior) -> "boss" (the
  // giant dragon fight) -> "bossDying" (fire/smoke explosion beat) ->
  // "woosh" (player dragon flies off screen) -> back to "waves" on the next
  // fresh run, or the player lands in the tavern.
  let flyingPhase = "waves";
  let flyingBoss = null; // {x,y,renderX,renderY,hp,maxHp,beamSweeping} while phase === "boss"
  let flyingBossDeathFx = null; // {x,y,startTime} -- big fire+smoke explosion
  // "Make all the enemy dragons disappear into clouds of smoke before
  // revealing the dragon king boss" -- snapshotted enemy positions (from
  // flying_boss_intro_start) that fade into smoke client-side during the
  // "bossIntro" phase. [{x,y,startTime}]
  let flyingBossIntroFx = [];
  const FLYING_BOSS_INTRO_MS = 2600; // mirrors server/flying.js's BOSS_INTRO_MS
  const FLYING_BOSS_WOOSH_MS = 1300; // mirrors server/flying.js's BOSS_WOOSH_MS -- purely cosmetic if it drifts slightly
  const FLYING_BOSS_DEATH_FX_MS = 3200; // mirrors server/flying.js's BOSS_DEATH_FX_MS
  // Fire-beam sweep telegraph -- {dir, x, startTime, telegraphMs} while the
  // boss is winding up a beam pass but hasn't started sweeping yet (see
  // "flying_boss_beam_start"/"flying_boss_beam_end"). Once sweeping starts,
  // the actual lethal beam is drawn straight off flyingBoss.x/beamSweeping
  // (the server already tracks the boss's position to the beam), so this is
  // ONLY used for the pre-sweep warning visual.
  let flyingBeamTelegraph = null;
  const FLYING_BEAM_WIDTH_TILES = 1.0; // mirrors server/flying.js's BOSS_BEAM_WIDTH (half-width)
  let flyingWooshStartTime = 0;
  let flyingWooshStartX = 0, flyingWooshStartY = 0;
  let cavernDoorOpen = false; // whether the boss-arena exit door has unlocked
  const charSprites = {}; // "race_color" -> Image
  const monsterSprites = {}; // type -> Image
  let tilesetImg = new Image();
  let treesImg = new Image();
  let birdImg = new Image();
  let swordImg = new Image();
  let flamingSwordImg = new Image();
  let barrelImg = new Image();
  let smokeImg = new Image();
  let edgeMaskImg = new Image();
  let dragonWalkImg = new Image();
  let dragonClawImg = new Image();
  let dragonFireImg = new Image();
  let tableRectImg = new Image();
  let tableRoundImg = new Image();
  let fireplaceImg = new Image();
  let barUnitImg = new Image();
  let signImg = new Image();
  let signBoozeImg = new Image(); // "Goblin Booze, do not touch!" -- posted next to the cliff barrels
  let signTavernRoofImg = new Image(); // "Dirtywood" -- hangs above the outside tavern building's roof
  const treasureImgs = [new Image(), new Image(), new Image()];
  const headstoneImgs = [new Image(), new Image(), new Image()];
  let bowImg = new Image();
  let arrowImg = new Image();
  const cavernGoblinFireImgs = { 1: new Image(), 2: new Image(), 3: new Image() }; // shade -> Image
  let cavernTrollImg = new Image();
  let cavernFireBatImg = new Image();
  let cavernTorchImg = new Image();
  let cavernStalactiteImg = new Image();
  let cavernCrystalImg = new Image();
  let cavernPlatformImg = new Image();
  let cavernBgImg = new Image();
  let cavernDoorImg = new Image();
  let cavernBossImg = new Image();
  let cliffBgImg = new Image();
  let tilesetReady = false;
  const edgeTintCanvases = {}; // tile id -> offscreen canvas, built once the tileset image is loaded
  let edgeTintsReady = false;

  /** id -> { name, color, race, x, y, dir, moving, hp, maxHp, dead,
   *          renderX, renderY, targetX, targetY, animT, swingAngle, swingStart } */
  const players = new Map();
  /** id -> { type, x, y, dir, moving, hp, maxHp, renderX, renderY, targetX,
   *          targetY, animT, attackFlashUntil } */
  const monsters = new Map();
  /** id -> { race, color, x, y, dir, moving, big, dancing, renderX, renderY,
   *          targetX, targetY, animT } -- purely decorative tavern patrons,
   *   see server/tavernNpcs.js. Always kept up to date regardless of the
   *   local player's current area; only rendered while myArea === "tavern". */
  const tavernNpcs = new Map();
  /** transient death-poof/flip effects: { type|null (monster) or color/race (player),
   *   isPlayer, x, y, dir, startTime } */
  const deathFx = [];

  const input = { up: false, down: false, left: false, right: false };
  let lastSentInput = "";
  let lastCamX = 0, lastCamY = 0;
  let iAmDead = false;

  function preloadAll() {
    const colorsAndRaces = [];
    RACES.forEach((r) => COLORS.forEach((c) => colorsAndRaces.push([r, c])));
    const monsterTypes = ["rat", "bat", "spider"];
    let remaining = colorsAndRaces.length + monsterTypes.length + 22 + 9 + 4 + 3 + 1 + 1 + 1;
    return new Promise((resolve) => {
      const done = () => { remaining -= 1; if (remaining <= 0) resolve(); };
      tilesetImg.onload = done;
      tilesetImg.onerror = done;
      tilesetImg.src = "/assets/tileset.png";
      treesImg.onload = done; treesImg.onerror = done; treesImg.src = "/assets/trees.png";
      birdImg.onload = done; birdImg.onerror = done; birdImg.src = "/assets/bird.png";
      swordImg.onload = done; swordImg.onerror = done; swordImg.src = "/assets/sword.png";
      flamingSwordImg.onload = done; flamingSwordImg.onerror = done; flamingSwordImg.src = "/assets/flaming_sword.png";
      barrelImg.onload = done; barrelImg.onerror = done; barrelImg.src = "/assets/barrel.png";
      smokeImg.onload = done; smokeImg.onerror = done; smokeImg.src = "/assets/smoke.png";
      edgeMaskImg.onload = done; edgeMaskImg.onerror = done; edgeMaskImg.src = "/assets/edge_dither_mask.png";
      dragonWalkImg.onload = done; dragonWalkImg.onerror = done; dragonWalkImg.src = "/assets/dragon_walk.png";
      dragonClawImg.onload = done; dragonClawImg.onerror = done; dragonClawImg.src = "/assets/dragon_claw.png";
      dragonFireImg.onload = done; dragonFireImg.onerror = done; dragonFireImg.src = "/assets/dragon_fire.png";
      tableRectImg.onload = done; tableRectImg.onerror = done; tableRectImg.src = "/assets/table_rect.png";
      tableRoundImg.onload = done; tableRoundImg.onerror = done; tableRoundImg.src = "/assets/table_round.png";
      fireplaceImg.onload = done; fireplaceImg.onerror = done; fireplaceImg.src = "/assets/fireplace.png";
      barUnitImg.onload = done; barUnitImg.onerror = done; barUnitImg.src = "/assets/bar_unit.png";
      signImg.onload = done; signImg.onerror = done; signImg.src = "/assets/sign_dirtywood.png";
      signBoozeImg.onload = done; signBoozeImg.onerror = done; signBoozeImg.src = "/assets/sign_booze.png";
      signTavernRoofImg.onload = done; signTavernRoofImg.onerror = done; signTavernRoofImg.src = "/assets/sign_tavern_roof.png";
      bowImg.onload = done; bowImg.onerror = done; bowImg.src = "/assets/bow_gold.png";
      arrowImg.onload = done; arrowImg.onerror = done; arrowImg.src = "/assets/arrow.png";
      treasureImgs.forEach((img, i) => {
        img.onload = done; img.onerror = done; img.src = `/assets/treasure_${i}.png`;
      });
      headstoneImgs.forEach((img, i) => {
        img.onload = done; img.onerror = done; img.src = `/assets/headstone_${i}.png`;
      });
      [1, 2, 3].forEach((shade) => {
        const img = cavernGoblinFireImgs[shade];
        img.onload = done; img.onerror = done; img.src = `/assets/cavern_goblin_fire${shade}.png`;
      });
      cavernTrollImg.onload = done; cavernTrollImg.onerror = done; cavernTrollImg.src = "/assets/cavern_troll.png";
      cavernFireBatImg.onload = done; cavernFireBatImg.onerror = done; cavernFireBatImg.src = "/assets/cavern_fire_bat.png";
      cavernTorchImg.onload = done; cavernTorchImg.onerror = done; cavernTorchImg.src = "/assets/cavern_torch.png";
      cavernStalactiteImg.onload = done; cavernStalactiteImg.onerror = done; cavernStalactiteImg.src = "/assets/cavern_stalactite.png";
      cavernCrystalImg.onload = done; cavernCrystalImg.onerror = done; cavernCrystalImg.src = "/assets/cavern_crystal.png";
      cavernPlatformImg.onload = done; cavernPlatformImg.onerror = done; cavernPlatformImg.src = "/assets/cavern_platform.png";
      cavernBgImg.onload = done; cavernBgImg.onerror = done; cavernBgImg.src = "/assets/cavern_bg.png";
      cavernDoorImg.onload = done; cavernDoorImg.onerror = done; cavernDoorImg.src = "/assets/cavern_door.png";
      cavernBossImg.onload = done; cavernBossImg.onerror = done; cavernBossImg.src = "/assets/cavern_boss.png";
      cliffBgImg.onload = done; cliffBgImg.onerror = done; cliffBgImg.src = "/assets/cliff_bg.png";
      colorsAndRaces.forEach(([race, color]) => {
        const img = new Image();
        img.onload = done; img.onerror = done;
        img.src = `/assets/race_${race}_${color}.png`;
        charSprites[`${race}_${color}`] = img;
      });
      // Dedicated fire-goblin variant (red armor AND red skin, not just a
      // player-selectable goblin+red combo) -- see drawFireGoblinMonster.
      {
        const img = new Image();
        img.onload = done; img.onerror = done;
        img.src = "/assets/race_goblin_fire.png";
        charSprites["goblin_fire"] = img;
      }
      // Dedicated bald sprite for Dante (the big tavern NPC) -- see
      // drawTavernNpc. Not a player-selectable combo (a human+pink player
      // still gets normal hair).
      {
        const img = new Image();
        img.onload = done; img.onerror = done;
        img.src = "/assets/race_human_bald_pink.png";
        charSprites["human_bald_pink"] = img;
      }
      monsterTypes.forEach((t) => {
        const img = new Image();
        img.onload = done; img.onerror = done;
        img.src = `/assets/monster_${t}.png`;
        monsterSprites[t] = img;
      });
    });
  }

  // Builds one tinted copy of the edge-dither mask per ground tile id, so
  // borders can be "colored" with whichever tile they're fading toward
  // without needing per-pair baked art. Called once both the tileset (to
  // sample average tile colors from) and the mask image itself have loaded.
  function buildEdgeTints() {
    if (edgeTintsReady) return;
    if (!tilesetImg.complete || tilesetImg.naturalWidth === 0) return;
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = TILE; sampleCanvas.height = TILE;
    const sctx = sampleCanvas.getContext("2d");
    for (let id = 0; id < NUM_GROUND_TILE_IDS; id++) {
      sctx.clearRect(0, 0, TILE, TILE);
      sctx.drawImage(tilesetImg, id * TILE, 0, TILE, TILE, 0, 0, TILE, TILE);
      const data = sctx.getImageData(0, 0, TILE, TILE).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);

      const tinted = document.createElement("canvas");
      tinted.width = EDGE_W; tinted.height = EDGE_H;
      const tctx = tinted.getContext("2d");
      tctx.fillStyle = `rgb(${r},${g},${b})`;
      tctx.fillRect(0, 0, EDGE_W, EDGE_H);
      tctx.globalCompositeOperation = "destination-in";
      if (edgeMaskImg.complete && edgeMaskImg.naturalWidth > 0) {
        tctx.drawImage(edgeMaskImg, 0, 0, EDGE_W, EDGE_H);
      }
      edgeTintCanvases[id] = tinted;
    }
    edgeTintsReady = true;
  }
  // Portraits (used in the race picker) load immediately, independent of
  // the join flow, so the character-select screen looks right right away.
  preloadAll();

  // ---------------------------------------------------------------------
  // Login flow
  // ---------------------------------------------------------------------
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") enterBtn.click();
  });

  enterBtn.addEventListener("click", async () => {
    const name = (nameInput.value || "Wanderer").trim().slice(0, 16);
    loginError.textContent = "";
    enterBtn.disabled = true;

    // Clean up any previous connection attempt before starting a new one.
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    let settled = false;
    let slowHintTimer = null;
    let failTimer = null;

    // Free-tier hosts often spin down when idle; the first connection can
    // take 30-50s to wake the server back up. Let the user know instead of
    // leaving them staring at "Connecting…" with no explanation.
    loginStatus.textContent = "Connecting…";
    slowHintTimer = setTimeout(() => {
      if (!settled) loginStatus.textContent = "Still connecting… the server may be waking up from sleep, this can take up to a minute.";
    }, 6000);
    failTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      loginStatus.textContent = "";
      loginError.textContent = "Taking too long to connect. Check your connection and try again.";
      enterBtn.disabled = false;
      if (socket) { socket.removeAllListeners(); socket.disconnect(); }
    }, 45000);

    // Default transports (polling first, upgrading to websocket) are the
    // most compatible option across hosting proxies/load balancers.
    socket = io({ reconnectionAttempts: 5 });

    socket.on("connect_error", (err) => {
      if (settled) return;
      loginStatus.textContent = "";
      loginError.textContent = "Couldn't reach the server, retrying… (" + (err && err.message ? err.message : "connection error") + ")";
    });

    socket.on("connect", () => {
      if (settled) return;
      socket.emit("join", { name, color: selectedColor, race: selectedRace }, async (init) => {
        if (settled) return;
        settled = true;
        clearTimeout(slowHintTimer);
        clearTimeout(failTimer);

        myId = init.you.id;
        worldMap = init.map;
        tavernMap = init.tavernMap;
        cavernMap = init.cavernMap || null;
        cavernDoorOpen = !!(cavernMap && cavernMap.bossDefeated);
        cavernBossTelegraph = null;
        cliffMap = init.cliffMap || null;
        flyingActive = false;
        flyingEnemies.clear();
        flyingProjectiles.clear();
        flyingEnemyProjectiles.clear();
        flyingDeathFx.length = 0;
        caveBackDoorTile = (init.map && init.map.caveBackDoorTile) || null;
        caveSideDoorTile = (init.map && init.map.caveSideDoorTile) || null;
        myArea = init.you.area || "tavern";
        swordState = init.swordState || swordState;
        bowState = init.bowState || bowState;
        caveSealed = init.caveSealed !== undefined ? init.caveSealed : caveSealed;
        caveSideDoorOpened = !!init.caveSideDoorOpened;
        caveBackDoorOpened = !!init.caveBackDoorOpened;
        caveEntranceTiles = init.caveEntranceTiles || [];
        caveTreasure = init.caveTreasure || [];
        graveyardHeadstones = init.graveyardHeadstones || [];
        tavernRoofSign = init.tavernRoofSign || null;
        fireHazards.length = 0;
        (init.fireHazards || []).forEach((f) => fireHazards.push(f));
        projectiles.clear();
        cavernMonsters.clear();
        cavernProjectiles.clear();
        cavernDeathFx.length = 0;
        cavernFallingSpikes.clear();
        cavernSpikeImpactFx.length = 0;
        iAmDead = false;
        deathBanner.classList.add("hidden");
        players.clear();
        monsters.clear();
        init.players.forEach((p) => addOrUpdatePlayer(p, true));
        (init.monsters || []).forEach((m) => addOrUpdateMonster(m, true));
        (init.cavernMonsters || []).forEach((m) => addOrUpdateCavernMonster(m, true));

        // Register voice signaling handlers immediately (synchronously),
        // before awaiting anything else. If we waited until after sprite
        // loading, a peer who joined moments earlier could send their
        // WebRTC offer before we're listening for it, and it would be
        // silently lost. See voice.js for the rest of the race-avoidance.
        voiceWidget.classList.remove("hidden");
        VoiceChat.init({
          socket,
          myId,
          distanceFn: (id) => {
            const me = players.get(myId);
            const other = players.get(id);
            if (!me || !other || other.area !== me.area) return null;
            return Math.hypot(me.renderX - other.renderX, me.renderY - other.renderY);
          },
          statusCb: onVoiceStatus,
        });

        await preloadAll();
        tilesetReady = true;
        buildEdgeTints();

        loginOverlay.classList.add("hidden");
        hud.classList.remove("hidden");
        chatLog.classList.remove("hidden");
        chatForm.classList.remove("hidden");
        chatHint.classList.remove("hidden");
        volumeWidget.classList.remove("hidden");
        if (selfPortrait) selfPortrait.classList.remove("hidden");

        // Kick off background music now, inside the same user-gesture call
        // stack as the "Enter World" click, so the browser's autoplay
        // policy allows it without an extra prompt.
        startBackgroundMusic();

        resizeCanvas();
        requestAnimationFrame(loop);
      });
    });

    socket.on("player_joined", (p) => {
      addOrUpdatePlayer(p, true);
      addChatLine(null, `${p.name} joined the world`, true);
      updateCount();
    });

    socket.on("player_left", (id) => {
      const p = players.get(id);
      if (p) addChatLine(null, `${p.name} left the world`, true);
      players.delete(id);
      updateCount();
    });

    socket.on("state", (list) => {
      list.forEach((p) => addOrUpdatePlayer(p, false));
      updateCount();
    });

    socket.on("monsters", (list) => {
      const seen = new Set();
      list.forEach((m) => { addOrUpdateMonster(m, false); seen.add(m.id); });
      for (const id of [...monsters.keys()]) {
        if (!seen.has(id)) monsters.delete(id); // died between broadcasts / despawned
      }
    });

    socket.on("tavern_npcs", (list) => {
      const seen = new Set();
      list.forEach((n) => { addOrUpdateTavernNpc(n, false); seen.add(n.id); });
      for (const id of [...tavernNpcs.keys()]) {
        if (!seen.has(id)) tavernNpcs.delete(id); // shouldn't normally happen -- patrons never despawn
      }
    });

    socket.on("monster_spawned", (m) => addOrUpdateMonster(m, true));

    socket.on("monster_died", (info) => {
      const m = monsters.get(info.id);
      const dir = m ? m.dir : "down";
      deathFx.push({ isPlayer: false, type: info.type, x: info.x, y: info.y, dir, startTime: performance.now() });
      monsters.delete(info.id);
    });

    socket.on("monster_attack", (info) => {
      const m = monsters.get(info.id);
      if (m) {
        m.attackFlashUntil = performance.now() + 180;
        if (m.type === "dragon" && info.kind) {
          m.attackKind = info.kind;
          m.attackAnimStart = performance.now();
        }
        // Every 3rd dragon attack roars -- an epic, everywhere-audible cue
        // rather than a small positional effect, so it's not distance-faded.
        if (m.type === "dragon" && info.roar) playSfx("dragon_roar", DRAGON_ROAR_VOLUME);
      }
      const target = players.get(info.targetId);
      if (target) target.hitFlashUntil = performance.now() + 180;
    });

    // A sword swing that actually landed on an enemy -- distinct from the
    // always-fires player_attack swing animation event.
    socket.on("sword_hit", (info) => {
      playSfx("clang", distanceVolume({ renderX: info.x, renderY: info.y }, CLANG_VOLUME));
    });

    socket.on("sword_state", (state) => {
      swordState = state;
    });

    socket.on("bow_state", (state) => {
      bowState = state;
    });

    socket.on("level_up", () => {
      playSfx("level_up", LEVEL_UP_VOLUME);
    });

    socket.on("cave_gate", (info) => {
      caveSealed = !!(info && info.sealed);
    });

    socket.on("cave_side_gate", (info) => {
      caveSideDoorOpened = !!(info && info.opened);
    });

    socket.on("cave_back_gate", (info) => {
      caveBackDoorOpened = !!(info && info.opened);
    });

    socket.on("fire_spawned", (hazard) => {
      fireHazards.push(hazard);
    });

    socket.on("fire_expired", (info) => {
      for (let i = fireHazards.length - 1; i >= 0; i--) {
        if (Math.abs(fireHazards[i].x - info.x) < 0.01 && Math.abs(fireHazards[i].y - info.y) < 0.01) {
          fireHazards.splice(i, 1);
        }
      }
    });

    socket.on("arrows", (list) => {
      const seen = new Set();
      list.forEach((a) => {
        projectiles.set(a.id, a);
        seen.add(a.id);
      });
      for (const id of [...projectiles.keys()]) {
        if (!seen.has(id)) projectiles.delete(id);
      }
    });

    socket.on("arrow_hit", (info) => {
      // The server doesn't include the arrow's id in this event (just its
      // final resting spot), and it stops broadcasting the "arrows" list
      // entirely once none remain in flight -- so without this, the last
      // arrow's sprite could freeze on screen forever. Delete whichever
      // in-flight arrow is closest to the reported hit point instead.
      let closestId = null, closestDist = Infinity;
      for (const [id, a] of projectiles) {
        const d = Math.hypot(a.x - info.x, a.y - info.y);
        if (d < closestDist) { closestDist = d; closestId = id; }
      }
      if (closestId !== null && closestDist < 1) projectiles.delete(closestId);
      if (info.monster) playSfx("clang", distanceVolume({ renderX: info.x, renderY: info.y }, CLANG_VOLUME));
      else playSfx("clunk", distanceVolume({ renderX: info.x, renderY: info.y }, CLUNK_VOLUME));
    });

    // --- Cavern depths: entirely separate event stream from the outside
    // world's monsters/projectiles above (see server/cavern.js's header). --
    socket.on("cavern_monsters", (list) => {
      const seen = new Set();
      list.forEach((m) => { addOrUpdateCavernMonster(m, false); seen.add(m.id); });
      for (const id of [...cavernMonsters.keys()]) {
        if (!seen.has(id)) cavernMonsters.delete(id);
      }
    });

    socket.on("cavern_monster_spawned", (m) => addOrUpdateCavernMonster(m, true));

    socket.on("cavern_monster_died", (info) => {
      cavernDeathFx.push({ x: info.x, y: info.y, startTime: performance.now(), big: info.type === "boss_goblin" });
      cavernMonsters.delete(info.id);
      if (info.type === "boss_goblin") {
        playSfx("screech", SCREECH_VOLUME);
        // Layout randomized ONCE here (not per-frame in the draw function --
        // that would make the pile flicker/reshuffle every frame instead of
        // looking like a stable pile of bones).
        cavernBoneFx.push({
          x: info.x,
          y: info.y,
          bones: Array.from({ length: 6 }, () => ({
            ang: Math.random() * Math.PI, lenFrac: 0.5 + Math.random() * 0.5,
            oxFrac: (Math.random() - 0.5) * 1.3, oyFrac: -Math.random() * 0.25,
          })),
          skulls: Array.from({ length: 2 }, () => ({
            oxFrac: (Math.random() - 0.5) * 1.1, oyFrac: -Math.random() * 0.15,
          })),
        });
        cavernBossSpeech = null;
      }
    });

    socket.on("cavern_monster_attack", (info) => {
      const m = cavernMonsters.get(info.id);
      if (m) m.attackFlashUntil = performance.now() + 180;
      const target = players.get(info.targetId);
      if (target) target.hitFlashUntil = performance.now() + 180;
    });

    socket.on("cavern_sword_hit", (info) => {
      playSfx("clang", distanceVolume({ renderX: info.x, renderY: info.y }, CLANG_VOLUME));
    });

    socket.on("cavern_arrows", (list) => {
      const seen = new Set();
      list.forEach((a) => { cavernProjectiles.set(a.id, a); seen.add(a.id); });
      for (const id of [...cavernProjectiles.keys()]) {
        if (!seen.has(id)) cavernProjectiles.delete(id);
      }
    });

    socket.on("cavern_arrow_hit", (info) => {
      let closestId = null, closestDist = Infinity;
      for (const [id, a] of cavernProjectiles) {
        const d = Math.hypot(a.x - info.x, a.y - info.y);
        if (d < closestDist) { closestDist = d; closestId = id; }
      }
      if (closestId !== null && closestDist < 1) cavernProjectiles.delete(closestId);
      playSfx("clang", distanceVolume({ renderX: info.x, renderY: info.y }, CLANG_VOLUME));
      // Flash the player who was actually hit -- previously missing here
      // (every other player-damage source in the game does this: see
      // monster_attack/cavern_monster_attack above), so a cavern arrow
      // landing on a player applied real server-side damage with zero
      // visual feedback, reading as "the arrow just passed through and did
      // nothing." Monsters never get a hit-flash anywhere in this game
      // (sword_hit/cavern_sword_hit only play a clang sound), so there's no
      // equivalent to add for the "monster" hitType.
      if (info.hitType === "player" && info.targetId) {
        const target = players.get(info.targetId);
        if (target) target.hitFlashUntil = performance.now() + 180;
      }
    });

    // Ceiling spikes -- see server/index.js's tick loop. This is an
    // authoritative full-state snapshot (same add/update convention as
    // cavern_arrows above), but deliberately NEVER used to delete a spike by
    // diffing against `seen`: the server only broadcasts this event while at
    // least one spike is active, so the tick where the LAST spike disappears
    // sends no broadcast at all, and a diff-on-absence approach would leave
    // it stuck forever. Removal is explicit instead -- see
    // cavern_spike_hit/cavern_spike_landed below.
    socket.on("cavern_falling_spikes", (list) => {
      list.forEach((s) => {
        let sp = cavernFallingSpikes.get(s.id);
        if (!sp) { sp = { renderY: s.y }; cavernFallingSpikes.set(s.id, sp); }
        sp.id = s.id; sp.x = s.x; sp.y = s.y; sp.telegraphing = s.telegraphing;
      });
    });

    socket.on("cavern_spike_hit", (info) => {
      cavernFallingSpikes.delete(info.id);
      cavernSpikeImpactFx.push({ x: info.x, y: info.y, startTime: performance.now() });
      const target = players.get(info.targetId);
      if (target) target.hitFlashUntil = performance.now() + 180;
      playSfx("thud", THUD_VOLUME);
    });

    socket.on("cavern_spike_landed", (info) => {
      cavernFallingSpikes.delete(info.id);
      cavernSpikeImpactFx.push({ x: info.x, y: info.y, startTime: performance.now() });
      playSfx("thud", THUD_VOLUME * 0.6);
    });

    // --- Giant boss goblin: telegraphed slam/shout -------------------------
    // The windup event is the dodge window: the danger zone (slam) or a
    // level-wide red tint (shout) shows immediately so players have the full
    // windup duration to react before cavern_boss_slam/cavern_boss_shout
    // actually resolves the hit/stun.
    socket.on("cavern_boss_windup", (info) => {
      cavernBossTelegraph = {
        kind: info.kind,
        targetX: info.targetX,
        startTime: performance.now(),
        windupMs: info.windupMs,
      };
      if (info.kind === "shout") playSfx("dragon_roar", DRAGON_ROAR_VOLUME * 0.7);
    });

    socket.on("cavern_boss_slam", (info) => {
      cavernBossTelegraph = null;
      cavernBossFlashUntil = performance.now() + 220;
      cavernBossFlashKind = "slam";
      // Woosh as the club swings through the air, thud a beat later as it
      // actually hits the ground -- these two events fire back to back
      // server-side (the windup->impact transition is instantaneous), so
      // the thud is staggered with a short client-local delay to read as
      // two distinct sounds rather than one.
      playSfx("woosh", WOOSH_VOLUME);
      setTimeout(() => playSfx("thud", THUD_VOLUME), 150);
      if (info.hitPlayerIds && info.hitPlayerIds.includes(myId)) {
        const me = players.get(myId);
        if (me) me.hitFlashUntil = performance.now() + 250;
      }
    });

    socket.on("cavern_boss_shout", (info) => {
      cavernBossTelegraph = null;
      cavernBossFlashUntil = performance.now() + 220;
      cavernBossFlashKind = "shout";
      playSfx("scream", SCREAM_VOLUME);
      const now = performance.now();
      (info.stunnedPlayerIds || []).forEach((id) => {
        const p = players.get(id);
        if (p) p.stunVisualUntil = now + BOSS_STUN_MS;
      });
    });

    socket.on("cavern_boss_stomp", (info) => {
      cavernBossTelegraph = null;
      cavernBossFlashUntil = performance.now() + 220;
      cavernBossFlashKind = "stomp";
      playSfx("thud", THUD_VOLUME * 1.3);
      if (info.hitPlayerIds && info.hitPlayerIds.includes(myId)) {
        const me = players.get(myId);
        if (me) me.hitFlashUntil = performance.now() + 250;
      }
    });

    socket.on("cavern_boss_taunt", (info) => {
      cavernBossSpeech = { text: info.text, until: performance.now() + 3600 };
    });

    socket.on("cavern_boss_defeated", () => {
      cavernDoorOpen = true;
      cavernBossTelegraph = null;
    });

    // --- Flying minigame: a personal instance, so these only ever describe
    // MY OWN run (see server/flying.js's header comment). ---
    socket.on("flying_start", (info) => {
      flyingActive = true;
      flyingDurationMs = info.durationMs || flyingDurationMs;
      flyingTimeLeftMs = flyingDurationMs;
      flyingEnemies.clear();
      flyingProjectiles.clear();
      flyingEnemyProjectiles.clear();
      flyingDeathFx.length = 0;
      flyingPhase = "waves";
      flyingBoss = null;
      flyingBossDeathFx = null;
      flyingBeamTelegraph = null;
      flyingBossIntroFx = [];
    });

    // "When the final dragon appears, play a dragon screech sound that
    // stuns all players and enemy dragons on screen (make their fireballs
    // disappear so they don't kill the player while stunned), then make
    // all the enemy dragons disappear into clouds of smoke before
    // revealing the dragon king boss." The server has already cleared its
    // own fs.enemies/projectiles by the time this fires; the enemy
    // positions are snapshotted here purely so the client can fade them
    // into smoke at their last spot instead of just vanishing instantly.
    socket.on("flying_boss_intro_start", (info) => {
      flyingPhase = "bossIntro";
      const startTime = performance.now();
      flyingBossIntroFx = (info.enemies || []).map((e) => ({ x: e.x, y: e.y, startTime }));
      flyingEnemies.clear();
      flyingProjectiles.clear();
      flyingEnemyProjectiles.clear();
      playSfx("screech", SCREECH_VOLUME);
      const me = players.get(myId);
      if (me) me.stunVisualUntil = startTime + (info.introMs || FLYING_BOSS_INTRO_MS);
    });

    // "make all the dragons on the map disappear then have a giant dragon
    // appear" -- the small wave dragons are already gone server-side by the
    // time this fires (see index.js's tick loop), so just swap the local
    // phase/boss state and clear anything stray left over client-side.
    socket.on("flying_boss_start", (info) => {
      flyingPhase = "boss";
      flyingEnemies.clear();
      flyingEnemyProjectiles.clear();
      flyingBoss = { x: info.x, y: info.y, renderX: info.x, renderY: info.y, hp: info.hp, maxHp: info.maxHp };
      playSfx("dragon_roar", DRAGON_ROAR_VOLUME);
    });

    socket.on("flying_boss_state", (s) => {
      if (flyingBoss) {
        flyingBoss.x = s.boss.x; flyingBoss.y = s.boss.y;
        flyingBoss.hp = s.boss.hp; flyingBoss.maxHp = s.boss.maxHp;
        flyingBoss.beamSweeping = !!s.boss.beamSweeping;
      }
      const seenP = new Set();
      (s.projectiles || []).forEach((p) => { flyingProjectiles.set(p.id, p); seenP.add(p.id); });
      for (const id of [...flyingProjectiles.keys()]) if (!seenP.has(id)) flyingProjectiles.delete(id);

      const seenEP = new Set();
      (s.enemyProjectiles || []).forEach((p) => { flyingEnemyProjectiles.set(p.id, p); seenEP.add(p.id); });
      for (const id of [...flyingEnemyProjectiles.keys()]) if (!seenEP.has(id)) flyingEnemyProjectiles.delete(id);
    });

    // New boss attack: "make him do a fire beam in a straight line that
    // moves with him as he strafes left and right, he can only make one
    // pass to the left or right while the beam is active though, the player
    // needs to stay ahead of it to avoid it." The start event gives the
    // pre-sweep warning window; the actual damaging beam is drawn straight
    // off flyingBoss.x/beamSweeping once flying_boss_state reports sweeping.
    socket.on("flying_boss_beam_start", (info) => {
      flyingBeamTelegraph = { dir: info.dir, x: info.x, startTime: performance.now(), telegraphMs: info.telegraphMs };
      playSfx("woosh", WOOSH_VOLUME);
    });

    socket.on("flying_boss_beam_end", () => {
      flyingBeamTelegraph = null;
    });

    // "When it dies make it explode with fire and smoke" -- a big fx at the
    // boss's last position; the giant dragon itself stops being drawn (its
    // cone-spray fireballs are already cleared server-side).
    socket.on("flying_boss_died", (info) => {
      flyingPhase = "bossDying";
      flyingBossDeathFx = { x: info.x, y: info.y, startTime: performance.now() };
      flyingBoss = null;
      flyingEnemyProjectiles.clear();
      flyingBeamTelegraph = null;
      playSfx("screech", SCREECH_VOLUME);
      // "I want a text bubble to appear over the player character that says
      // 'We did it! Let's get back to Dirtywood!!' then fly off and
      // transition to the tavern like normal" -- covers the whole
      // bossDying (explosion) + woosh (fly-off) sequence so it's visible
      // right up until the cut to the tavern, same bounded-window pattern
      // as the cliff-arrival speech bubble.
      const me = players.get(myId);
      if (me) me.flyingVictoryBubbleUntil = performance.now() + FLYING_BOSS_DEATH_FX_MS + FLYING_BOSS_WOOSH_MS + 400;
    });

    // "make the player dragon woosh off the screen then transition to the
    // tavern" -- captures the player's current render position as the
    // tween's start point (see predictFlyingLocal's "woosh" branch).
    socket.on("flying_woosh_start", () => {
      flyingPhase = "woosh";
      flyingWooshStartTime = performance.now();
      const me = players.get(myId);
      flyingWooshStartX = me ? me.renderX : FLYING_ARENA_W / 2;
      flyingWooshStartY = me ? me.renderY : FLYING_ARENA_H / 2;
      playSfx("woosh", WOOSH_VOLUME);
    });

    socket.on("flying_state", (s) => {
      flyingTimeLeftMs = s.timeLeftMs;
      const seenE = new Set();
      (s.enemies || []).forEach((e) => {
        let ex = flyingEnemies.get(e.id);
        if (!ex) { ex = { renderX: e.x, renderY: e.y, animT: 0 }; flyingEnemies.set(e.id, ex); }
        ex.id = e.id; ex.x = e.x; ex.y = e.y; ex.hp = e.hp; ex.maxHp = e.maxHp;
        seenE.add(e.id);
      });
      for (const id of [...flyingEnemies.keys()]) if (!seenE.has(id)) flyingEnemies.delete(id);

      const seenP = new Set();
      (s.projectiles || []).forEach((p) => {
        flyingProjectiles.set(p.id, p);
        seenP.add(p.id);
      });
      for (const id of [...flyingProjectiles.keys()]) if (!seenP.has(id)) flyingProjectiles.delete(id);

      const seenEP = new Set();
      (s.enemyProjectiles || []).forEach((p) => {
        flyingEnemyProjectiles.set(p.id, p);
        seenEP.add(p.id);
      });
      for (const id of [...flyingEnemyProjectiles.keys()]) if (!seenEP.has(id)) flyingEnemyProjectiles.delete(id);
    });

    socket.on("flying_hit", () => {
      const me = players.get(myId);
      if (me) me.hitFlashUntil = performance.now() + 180;
    });

    socket.on("flying_enemy_died", (info) => {
      flyingDeathFx.push({ x: info.x, y: info.y, startTime: performance.now() });
      flyingEnemies.delete(info.id);
      playSfx("clang", CLANG_VOLUME * 0.7);
    });

    socket.on("flying_end", () => {
      flyingActive = false;
      flyingEnemies.clear();
      flyingProjectiles.clear();
      flyingEnemyProjectiles.clear();
      flyingPhase = "waves";
      flyingBoss = null;
      flyingBossDeathFx = null;
      flyingBeamTelegraph = null;
      flyingBossIntroFx = [];
    });

    socket.on("player_attack", (info) => {
      const p = players.get(info.id);
      if (!p) return;
      p.swingAngle = info.angle;
      p.swingStart = performance.now();
      // Our own swing already played its swoosh instantly on click (see the
      // mousedown handler below) -- only other players' swings need it here,
      // and only if they're in the same area as us.
      if (info.id !== myId && p.area === myArea) playSwooshFor(p);
    });

    // Space-bar dash in the tavern/outside world -- broadcast to everyone
    // (not just the dasher) so remote clients can render the fading mirage
    // trail behind ANY dashing player, not only the local one. Purely
    // drives the client-only trail visual (see drawPlayer's dashActiveUntil/
    // dashTrail handling); the actual movement is server-authoritative.
    socket.on("player_dash", (info) => {
      const p = players.get(info.id);
      if (!p) return;
      p.dashActiveUntil = performance.now() + info.durationMs;
    });

    socket.on("player_died", (info) => {
      const p = players.get(info.id);
      if (p) p.dead = true;
      if (info.id === myId) {
        iAmDead = true;
        deathBanner.classList.remove("hidden");
      }
    });

    socket.on("player_respawned", (p) => {
      addOrUpdatePlayer(p, true);
      if (p.id === myId) {
        iAmDead = false;
        deathBanner.classList.add("hidden");
      }
    });

    socket.on("chat", (msg) => addChatLine(msg.name, msg.text, false));

    socket.on("disconnect", () => {
      loginOverlay.classList.remove("hidden");
      hud.classList.add("hidden");
      voiceWidget.classList.add("hidden");
      volumeWidget.classList.add("hidden");
      deathBanner.classList.add("hidden");
      nearbyPanel.innerHTML = "";
      nearbyCards.clear();
      if (selfPortrait) selfPortrait.classList.add("hidden");
      if (nearbyRightStack) nearbyRightStack.innerHTML = "";
      rightStackCards.clear();
      if (weaponToggle) weaponToggle.classList.add("hidden");
      fireHazards.length = 0;
      projectiles.clear();
      cavernMonsters.clear();
      cavernProjectiles.clear();
      cavernDeathFx.length = 0;
      cavernFallingSpikes.clear();
      cavernSpikeImpactFx.length = 0;
      caveSealed = true;
      loginStatus.textContent = "";
      loginError.textContent = "Disconnected from server.";
      enterBtn.disabled = false;
      bgMusicEl.removeEventListener("ended", playNextMusicTrack);
      bgMusicEl.pause();
    });
  });

  function addOrUpdatePlayer(p, snap) {
    let e = players.get(p.id);
    const isNew = !e;
    if (!e) {
      e = { renderX: p.x, renderY: p.y, animT: 0, swingAngle: 0, swingStart: -99999, hitFlashUntil: 0, nextFootstepAt: 0, area: p.area, stunVisualUntil: 0 };
      players.set(p.id, e);
    }
    const areaChanged = !isNew && e.area !== p.area;
    e.name = p.name;
    e.color = p.color;
    e.race = p.race || "human";
    e.area = p.area;
    e.dir = p.dir;
    e.moving = p.moving;
    e.hp = typeof p.hp === "number" ? p.hp : PLAYER_MAX_HP;
    e.maxHp = typeof p.maxHp === "number" ? p.maxHp : PLAYER_MAX_HP;
    e.dead = !!p.dead;
    e.hasFlamingSword = !!p.hasFlamingSword;
    e.hasBow = !!p.hasBow;
    e.activeWeapon = p.activeWeapon || "sword";
    e.level = typeof p.level === "number" ? p.level : 1;
    e.xp = typeof p.xp === "number" ? p.xp : 0;
    e.dmgMultiplier = typeof p.dmgMultiplier === "number" ? p.dmgMultiplier : 1;
    e.burning = !!p.burning;
    e.crouching = !!p.crouching;
    e.grounded = p.grounded === undefined ? true : !!p.grounded;
    e.targetX = p.x;
    e.targetY = p.y;
    // Area transitions teleport between two entirely different coordinate
    // spaces (tavern grid vs. outside world grid) -- always snap on one,
    // never lerp across them, or the entity would appear to fly across the
    // whole map for a frame.
    if (snap || areaChanged) { e.renderX = p.x; e.renderY = p.y; }
    if (p.id === myId && areaChanged) {
      myArea = p.area;
      // Always land on the new area's normal music -- combat music (if any)
      // only resumes once refreshCombatMusic notices a live aggro'd boss in
      // the new area, so this avoids an extra immediate re-trigger.
      combatMusicActive = false;
      refreshMusicForArea();
      // "When you first appear on the cliff edge..." -- a one-shot, bounded
      // speech bubble (see drawCavernPlayer) stamped the instant we arrive.
      if (p.area === "cliff") e.cliffArrivalBubbleUntil = performance.now() + 6000;
      // "The celebration in the tavern at the end needs to be bigger, make
      // fireworks explode across the screen for a few seconds as soon as
      // you enter" -- a bounded fireworks show, on top of the existing
      // ambient party lights, kicked off the instant you walk in (or
      // re-enter) while the party is already underway. See
      // drawTavernFireworks/tavernFireworksUntil.
      if (p.area === "tavern" && isTavernPartyActive()) {
        tavernFireworksUntil = performance.now() + TAVERN_FIREWORKS_SHOW_MS;
        tavernNextFireworkAt = 0; // spawn the first burst on the very next draw tick
        playSfx("level_up", LEVEL_UP_VOLUME * 0.8);
      }
    }
  }

  function addOrUpdateMonster(m, snap) {
    let e = monsters.get(m.id);
    if (!e) {
      e = { renderX: m.x, renderY: m.y, animT: 0, attackFlashUntil: 0, attackKind: null, attackAnimStart: 0, nextFootstepAt: 0 };
      monsters.set(m.id, e);
    }
    e.type = m.type;
    e.dir = m.dir;
    e.moving = m.moving;
    e.hp = m.hp;
    e.maxHp = m.maxHp;
    e.radius = typeof m.radius === "number" ? m.radius : undefined;
    // Dragon only -- drives the dynamic combat-music switch (see
    // refreshCombatMusic). Must be explicitly copied here, same bug class as
    // the boss's actionState fix: a field present in the broadcast payload
    // but never copied into the local entity silently never takes effect.
    e.aggro = !!m.aggro;
    e.targetX = m.x;
    e.targetY = m.y;
    if (snap) { e.renderX = m.x; e.renderY = m.y; }
  }

  function addOrUpdateCavernMonster(m, snap) {
    let e = cavernMonsters.get(m.id);
    if (!e) {
      e = { renderX: m.x, renderY: m.y, animT: 0, attackFlashUntil: 0 };
      cavernMonsters.set(m.id, e);
    }
    e.type = m.type;
    e.tier = m.tier;
    e.dir = m.dir;
    e.moving = m.moving;
    e.attacking = !!m.attacking;
    e.hp = m.hp;
    e.maxHp = m.maxHp;
    e.shade = m.shade || 1;
    // Giant boss only -- drives drawCavernBoss's pose selection (this was
    // previously never copied from the broadcast, so the boss's long
    // windup pose -- the one actually holding the club up -- never showed;
    // only the brief 220ms slam-impact flash pose ever rendered).
    e.actionState = m.actionState;
    e.slamTargetX = m.slamTargetX;
    // Goblin King only -- drives the dynamic combat-music switch, same as
    // the dragon's aggro flag above.
    e.aggro = !!m.aggro;
    // Fire bat only -- drives drawFireBat's dive/flyoff pose+tilt. Same bug
    // class as actionState above: must be explicitly copied here or the
    // client-side entity silently never reflects the server's real state.
    e.batState = m.batState;
    e.targetX = m.x;
    e.targetY = m.y;
    if (snap) { e.renderX = m.x; e.renderY = m.y; }
  }

  function addOrUpdateTavernNpc(n, snap) {
    let e = tavernNpcs.get(n.id);
    if (!e) {
      e = { renderX: n.x, renderY: n.y, animT: 0 };
      tavernNpcs.set(n.id, e);
    }
    e.race = n.race;
    e.color = n.color;
    e.dir = n.dir;
    e.moving = n.moving;
    e.big = !!n.big;
    const wasDancing = e.dancing;
    e.dancing = !!n.dancing;
    // Rising edge only: stamps the moment Dante starts dancing, so
    // drawTavernNpc can show his "you got the booze" outro bubble for a
    // bounded window afterward rather than forever.
    if (e.big && e.dancing && !wasDancing) e.dancingSince = performance.now();
    e.targetX = n.x;
    e.targetY = n.y;
    if (snap) { e.renderX = n.x; e.renderY = n.y; }
  }

  function updateCount() {
    playerCountEl.textContent = String(players.size);
  }

  // ---------------------------------------------------------------------
  // Sound effects + background music. Short one-shot sfx (sword swoosh,
  // footsteps) are played by spinning up a fresh Audio() instance per
  // trigger so overlapping plays don't cut each other off; background music
  // reuses a single persistent element so it can loop/advance in place.
  // ---------------------------------------------------------------------
  let musicMuted = false;
  let sfxMuted = false;
  // Two-slider volume model: each factor (0..1) scales its whole sound
  // category, on top of the individual per-effect base volumes below.
  // Defaults match the sliders' initial HTML values (10 / 10).
  let musicVolumeFactor = 0.1;
  let sfxVolumeFactor = 0.1;
  const bgMusicEl = new Audio();
  bgMusicEl.volume = MUSIC_VOLUME * musicVolumeFactor;
  let lastMusicTrack = -1;

  function pickNextTrack() {
    if (MUSIC_TRACKS.length === 1) return 0;
    let idx;
    do { idx = Math.floor(Math.random() * MUSIC_TRACKS.length); } while (idx === lastMusicTrack);
    return idx;
  }

  function playNextMusicTrack() {
    lastMusicTrack = pickNextTrack();
    bgMusicEl.loop = false;
    bgMusicEl.src = `/assets/audio/${MUSIC_TRACKS[lastMusicTrack]}.mp3`;
    if (!musicMuted) bgMusicEl.play().catch(() => {});
  }

  // Cheerful, looping tavern theme while indoors -- distinct from the
  // randomized outdoor adventure-track rotation. Swaps to the upbeat party
  // track instead once the party has kicked off (see isTavernPartyActive).
  function playTavernMusic() {
    tavernPartyMusicActive = isTavernPartyActive();
    bgMusicEl.removeEventListener("ended", playNextMusicTrack);
    bgMusicEl.loop = true;
    bgMusicEl.src = `/assets/audio/${tavernPartyMusicActive ? PARTY_MUSIC_TRACK : TAVERN_MUSIC_TRACK}.mp3`;
    if (!musicMuted) bgMusicEl.play().catch(() => {});
  }

  function playOutsideMusic() {
    bgMusicEl.removeEventListener("ended", playNextMusicTrack); // avoid stacking duplicate listeners
    bgMusicEl.addEventListener("ended", playNextMusicTrack);
    playNextMusicTrack();
  }

  // Switches the background music to match whichever area I'm currently in
  // -- called once on login and again every time an area transition lands.
  function refreshMusicForArea() {
    if (myArea === "tavern") playTavernMusic();
    else playOutsideMusic();
  }

  function startBackgroundMusic() {
    refreshMusicForArea();
  }

  // True while the dragon (outside world), the Goblin King boss (cavern), or
  // the Dragon King boss (flying minigame) is actively aggro'd/active on
  // someone -- drives the fast-paced combat music swap below. Only checks
  // the entities relevant to the area I'm actually in right now. "Play boss
  // music for all boss fights - first dragon, goblin king, then dragon
  // king": the first two already worked via this same function; the flying
  // branch below is what newly wires up the Dragon King fight.
  function isAnyBossAggro() {
    if (myArea === "outside") {
      for (const m of monsters.values()) {
        if (m.type === "dragon" && m.aggro) return true;
      }
    } else if (myArea === "cavern") {
      for (const m of cavernMonsters.values()) {
        if (m.type === "boss_goblin" && m.aggro) return true;
      }
    } else if (myArea === "flying") {
      if (flyingPhase === "boss" || flyingPhase === "bossDying") return true;
    }
    return false;
  }

  // True once Dante (the big NPC) starts dancing -- the client-side signal
  // that the tavern party has kicked off (see server/index.js's
  // startTavernParty). Drives the music swap below plus the flashing-lights
  // render pass in drawTavernParty.
  function isTavernPartyActive() {
    for (const n of tavernNpcs.values()) {
      if (n.big && n.dancing) return true;
    }
    return false;
  }

  let tavernPartyMusicActive = false;

  // Checked every frame (see loop()), same shape as refreshCombatMusic --
  // swaps to the upbeat party loop the instant the party starts, and (in
  // the unlikely event the player leaves before/without the party state
  // ever having been observed) falls back to the plain tavern loop.
  function refreshTavernPartyMusic() {
    if (myArea !== "tavern") return;
    const shouldBeParty = isTavernPartyActive();
    if (shouldBeParty === tavernPartyMusicActive) return;
    tavernPartyMusicActive = shouldBeParty;
    playTavernMusic();
  }

  let combatMusicActive = false;

  // Checked every frame (see loop()) rather than driven by a discrete
  // server event, since aggro can flip due to either side moving, not just
  // a single attack/kill moment. Swaps to the fast combat loop the instant
  // a relevant boss goes aggro, and back to the area's normal music the
  // instant it's no longer aggro'd on anyone.
  function refreshCombatMusic() {
    const shouldBeCombat = isAnyBossAggro();
    if (shouldBeCombat === combatMusicActive) return;
    combatMusicActive = shouldBeCombat;
    if (combatMusicActive) {
      bgMusicEl.removeEventListener("ended", playNextMusicTrack);
      bgMusicEl.loop = true;
      bgMusicEl.src = `/assets/audio/${COMBAT_MUSIC_TRACK}.mp3`;
      if (!musicMuted) bgMusicEl.play().catch(() => {});
    } else {
      refreshMusicForArea();
    }
  }

  musicToggle.addEventListener("click", () => {
    musicMuted = !musicMuted;
    musicToggle.classList.toggle("muted", musicMuted);
    if (musicMuted) bgMusicEl.pause();
    else bgMusicEl.play().catch(() => {});
  });

  musicVolumeSlider.addEventListener("input", () => {
    musicVolumeFactor = Number(musicVolumeSlider.value) / 100;
    bgMusicEl.volume = MUSIC_VOLUME * musicVolumeFactor;
  });
  sfxVolumeSlider.addEventListener("input", () => {
    sfxVolumeFactor = Number(sfxVolumeSlider.value) / 100;
  });

  function playSfx(name, volume) {
    const v = volume * sfxVolumeFactor;
    if (sfxMuted || v <= 0.01) return;
    const a = new Audio(`/assets/audio/${name}.mp3`);
    a.volume = Math.max(0, Math.min(1, v));
    a.play().catch(() => {});
  }

  // Distance-attenuated volume for another entity's sfx relative to me (1.0
  // if it's me, fading to 0 past SFX_MAX_DISTANCE for everyone else).
  function distanceVolume(entity, baseVolume) {
    const me = players.get(myId);
    if (!me || entity === me) return baseVolume;
    const dist = Math.hypot(me.renderX - entity.renderX, me.renderY - entity.renderY);
    if (dist >= SFX_MAX_DISTANCE) return 0;
    return baseVolume * Math.max(0, 1 - dist / SFX_MAX_DISTANCE);
  }

  function playSwooshFor(p) {
    playSfx("swoosh", distanceVolume(p, SWOOSH_VOLUME));
  }

  const FOOTSTEP_SOUNDS = ["footstep1", "footstep2"];
  let footstepToggle = 0;

  // Periodic "tip-toe" footstep taps for anyone currently moving -- our own
  // player and every other player we can see, each throttled independently
  // so a crowd of moving players doesn't turn into noise mush.
  function updateFootstepAudio(now) {
    for (const p of players.values()) {
      if (!p.moving || p.dead || p.area !== myArea) continue;
      if (now < (p.nextFootstepAt || 0)) continue;
      p.nextFootstepAt = now + FOOTSTEP_INTERVAL_MS;
      footstepToggle = 1 - footstepToggle;
      playSfx(FOOTSTEP_SOUNDS[footstepToggle], distanceVolume(p, FOOTSTEP_VOLUME));
    }
  }

  // ---------------------------------------------------------------------
  // Voice chat (proximity, always-on mic by default)
  // ---------------------------------------------------------------------
  function onVoiceStatus(status) {
    if (status.state === "requesting") {
      voiceStatus.firstChild.textContent = "Voice: requesting mic…";
      micToggle.classList.remove("muted", "unavailable");
    } else if (status.state === "ready") {
      voiceStatus.firstChild.textContent = "Voice: live";
      micToggle.classList.remove("unavailable");
    } else if (status.state === "denied") {
      voiceStatus.firstChild.textContent = "Voice: mic blocked";
      voiceSubstatus.textContent = "You can still hear others, but they can't hear you.";
      micToggle.classList.add("unavailable");
      micToggle.title = "Microphone access was denied/unavailable";
    }
  }

  micToggle.addEventListener("click", () => {
    if (!VoiceChat.hasMic()) return; // nothing to toggle if we never got a mic
    const nowEnabled = !VoiceChat.isMicEnabled();
    VoiceChat.setMicEnabled(nowEnabled);
    micToggle.classList.toggle("muted", !nowEnabled);
    micToggle.textContent = nowEnabled ? "🎤" : "🔇";
  });

  // Weapon toggle: only meaningful once the bow's been picked up (see
  // updateNearbyPanel, which shows/hides this button); the server itself
  // guards against selecting "bow" without actually holding it.
  if (weaponSwordBtn) {
    weaponSwordBtn.addEventListener("click", () => {
      if (socket) socket.emit("select_weapon", { weapon: "sword" });
    });
  }
  if (weaponBowBtn) {
    weaponBowBtn.addEventListener("click", () => {
      if (socket) socket.emit("select_weapon", { weapon: "bow" });
    });
  }

  // Lightweight periodic refresh of the "N nearby" substatus line.
  setInterval(() => {
    if (voiceWidget.classList.contains("hidden")) return;
    if (!VoiceChat.hasMic() && VoiceChat.peerCount() === 0) return;
    const n = VoiceChat.audiblePeerCount();
    voiceSubstatus.textContent = n > 0 ? `${n} nearby audible` : "no one in range";
  }, 1000);

  // ---------------------------------------------------------------------
  // Nearby players panel (left side): a card per player within voice
  // range, showing their avatar/color/race/name. Cards fade out over the
  // last 5 tiles before the cutoff (20% more transparent per tile from
  // tile 16 through 20), then disappear entirely past the cutoff.
  // ---------------------------------------------------------------------
  const nearbyCards = new Map(); // id -> HTMLElement
  let selfAvatarCache = null; // cache key "race_color" to avoid re-setting CSS every frame
  const rightStackCards = new Map(); // id -> HTMLElement (right-side stacked mini-portraits)

  function avatarStyle(race, color) {
    // Crop the idle "down" frame (frame index 1 of 3) out of the
    // race_<race>_<color>.png spritesheet, scaled up to the 32px display size.
    const scale = 32 / CHAR_NATIVE_W;
    const frameX = 1 * CHAR_NATIVE_W * scale;
    const sheetW = CHAR_NATIVE_W * FRAMES * scale;
    const sheetH = CHAR_NATIVE_H * 4 * scale;
    return `background-image:url(/assets/race_${race}_${color}.png);` +
      `background-position:-${frameX}px 0px;` +
      `background-size:${sheetW}px ${sheetH}px;`;
  }

  function updateNearbyPanel() {
    const me = players.get(myId);
    if (!me) return;
    const maxDist = (typeof VoiceChat !== "undefined" && VoiceChat.getMaxDistance) ? VoiceChat.getMaxDistance() : 20;

    const visible = [];
    for (const [id, p] of players) {
      if (id === myId || p.area !== me.area) continue;
      const dist = Math.hypot(me.renderX - p.renderX, me.renderY - p.renderY);
      if (dist > maxDist) continue;
      visible.push({ id, p, dist });
    }
    visible.sort((a, b) => a.dist - b.dist);

    const seen = new Set();
    for (const { id, p, dist } of visible) {
      seen.add(id);
      let card = nearbyCards.get(id);
      if (!card) {
        card = document.createElement("div");
        card.className = "nearby-card";
        const avatar = document.createElement("div");
        avatar.className = "nearby-avatar";
        const nameWrap = document.createElement("div");
        nameWrap.className = "nearby-textwrap";
        const nameRow = document.createElement("div");
        const name = document.createElement("span");
        name.className = "nearby-name";
        const level = document.createElement("span");
        level.className = "nearby-level";
        nameRow.appendChild(name);
        nameRow.appendChild(level);
        const race = document.createElement("div");
        race.className = "nearby-race";
        nameWrap.appendChild(nameRow);
        nameWrap.appendChild(race);
        card.appendChild(avatar);
        card.appendChild(nameWrap);
        card._avatarEl = avatar;
        card._raceEl = race;
        card._levelEl = level;
        nearbyCards.set(id, card);
      }
      if (card._raceCache !== `${p.race}_${p.color}`) {
        card._avatarEl.style.cssText = avatarStyle(p.race, p.color);
        card._raceCache = `${p.race}_${p.color}`;
      }
      card.style.setProperty("--pcolor", COLOR_HEX[p.color] || "#c49a2a");
      card.querySelector(".nearby-name").textContent = p.name;
      card._levelEl.textContent = "Lv." + (p.level || 1);
      card._raceEl.textContent = RACE_LABELS[p.race] || "";
      card.style.opacity = String(
        dist <= NEARBY_FULL_OPACITY_DISTANCE
          ? 1
          : Math.max(0, 1 - (dist - NEARBY_FULL_OPACITY_DISTANCE) * 0.2)
      );
      if (card.parentNode !== nearbyPanel) nearbyPanel.appendChild(card);
    }

    // Reorder DOM to match sorted (closest-first) order.
    visible.forEach(({ id }) => nearbyPanel.appendChild(nearbyCards.get(id)));

    // Remove cards for players no longer in range (or who left).
    for (const [id, card] of nearbyCards) {
      if (!seen.has(id)) {
        if (card.parentNode) card.parentNode.removeChild(card);
        nearbyCards.delete(id);
      }
    }

    // Right side: my own portrait (avatar, level, HP/XP bars) with every
    // nearby player's mini-portrait stacked underneath, reusing the same
    // in-range list already computed above.
    if (selfPortrait) {
      if (selfAvatarCache !== `${me.race}_${me.color}`) {
        selfAvatar.style.cssText = avatarStyle(me.race, me.color);
        selfAvatarCache = `${me.race}_${me.color}`;
      }
      selfPortrait.style.setProperty("--pcolor", COLOR_HEX[me.color] || "#c49a2a");
      selfNameEl.textContent = me.name || "";
      selfLevelBadge.textContent = "Lv." + (me.level || 1);
      const hpFrac = me.maxHp ? Math.max(0, Math.min(1, me.hp / me.maxHp)) : 0;
      selfHpFill.style.width = (hpFrac * 100).toFixed(0) + "%";
      selfXpFill.style.width = (Math.max(0, Math.min(1, me.xp || 0)) * 100).toFixed(0) + "%";
    }

    if (nearbyRightStack) {
      const seenRight = new Set();
      for (const { id, p, dist } of visible) {
        seenRight.add(id);
        let card = rightStackCards.get(id);
        if (!card) {
          card = document.createElement("div");
          card.className = "right-stack-card";
          const avatar = document.createElement("div");
          avatar.className = "right-stack-avatar";
          const name = document.createElement("span");
          name.className = "right-stack-name";
          const level = document.createElement("span");
          level.className = "right-stack-level";
          card.appendChild(avatar);
          card.appendChild(name);
          card.appendChild(level);
          card._avatarEl = avatar;
          card._nameEl = name;
          card._levelEl = level;
          rightStackCards.set(id, card);
        }
        if (card._raceCache !== `${p.race}_${p.color}`) {
          card._avatarEl.style.cssText = avatarStyle(p.race, p.color);
          card._raceCache = `${p.race}_${p.color}`;
        }
        card.style.setProperty("--pcolor", COLOR_HEX[p.color] || "#c49a2a");
        card._nameEl.textContent = p.name;
        card._levelEl.textContent = "Lv." + (p.level || 1);
        card.style.opacity = String(
          dist <= NEARBY_FULL_OPACITY_DISTANCE ? 1 : Math.max(0, 1 - (dist - NEARBY_FULL_OPACITY_DISTANCE) * 0.2)
        );
        if (card.parentNode !== nearbyRightStack) nearbyRightStack.appendChild(card);
      }
      visible.forEach(({ id }) => nearbyRightStack.appendChild(rightStackCards.get(id)));
      for (const [id, card] of rightStackCards) {
        if (!seenRight.has(id)) {
          if (card.parentNode) card.parentNode.removeChild(card);
          rightStackCards.delete(id);
        }
      }
    }

    // Weapon toggle: only shown once the bow's been picked up (the sword is
    // always implicitly available as the default).
    if (weaponToggle) {
      weaponToggle.classList.toggle("hidden", !me.hasBow);
      weaponSwordBtn.classList.toggle("selected", me.activeWeapon !== "bow");
      weaponBowBtn.classList.toggle("selected", me.activeWeapon === "bow");
    }
  }

  setInterval(updateNearbyPanel, 150);

  // ---------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------
  function addChatLine(name, text, isSystem) {
    const div = document.createElement("div");
    if (isSystem) {
      div.style.color = "#9fb0d0";
      div.style.fontStyle = "italic";
      div.textContent = text;
    } else {
      div.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
    }
    chatLog.appendChild(div);
    while (chatLog.children.length > 6) chatLog.removeChild(chatLog.firstChild);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text && socket) socket.emit("chat", text);
    chatInput.value = "";
    chatInput.blur();
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") chatInput.blur();
    e.stopPropagation();
  });

  // ---------------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------------
  const KEY_MAP = {
    KeyW: "up", ArrowUp: "up",
    KeyS: "down", ArrowDown: "down",
    KeyA: "left", ArrowLeft: "left",
    KeyD: "right", ArrowRight: "right",
  };

  function isChatFocused() { return document.activeElement === chatInput; }

  window.addEventListener("keydown", (e) => {
    if (!loginOverlay.classList.contains("hidden")) return; // still on login screen
    if (e.key === "Enter" && !isChatFocused()) {
      chatInput.focus();
      e.preventDefault();
      return;
    }
    if (isChatFocused()) return;
    // Space bar: jump in the cavern, dash in the tavern/outside world, shoot
    // in the flying minigame -- server ignores whichever event doesn't apply
    // to the player's current area anyway, but only sending the one that's
    // actually relevant avoids e.g. queuing up a jump the moment you step
    // back outside. Holding S (down/crouch) at the moment of a jump drops
    // you through a one-way platform instead -- see the "down" flag already
    // sent via the regular input object below, no separate crouch event
    // needed.
    if (e.code === "Space") {
      e.preventDefault();
      if (!socket) return;
      if (myArea === "flying") socket.emit("fly_shoot");
      else if (myArea === "tavern" || myArea === "outside") { if (!e.repeat) socket.emit("dash"); }
      else if (!e.repeat) socket.emit("jump");
      return;
    }
    const dir = KEY_MAP[e.code];
    if (dir) { input[dir] = true; sendInputIfChanged(); e.preventDefault(); }
  });
  window.addEventListener("keyup", (e) => {
    if (isChatFocused()) return;
    const dir = KEY_MAP[e.code];
    if (dir) { input[dir] = false; sendInputIfChanged(); }
  });
  window.addEventListener("blur", () => {
    input.up = input.down = input.left = input.right = false;
    sendInputIfChanged();
  });

  function sendInputIfChanged() {
    const key = `${+input.up}${+input.down}${+input.left}${+input.right}`;
    if (key === lastSentInput || !socket) return;
    lastSentInput = key;
    socket.emit("input", { ...input });
  }

  // ---------------------------------------------------------------------
  // Mouse attack: swing the sword toward the cursor on click.
  // ---------------------------------------------------------------------
  let mouseClientX = 0, mouseClientY = 0;
  window.addEventListener("mousemove", (e) => {
    mouseClientX = e.clientX;
    mouseClientY = e.clientY;
  });

  function dirFromAngleClient(angle) {
    const deg = ((angle * 180) / Math.PI + 360) % 360;
    if (deg >= 315 || deg < 45) return "right";
    if (deg >= 45 && deg < 135) return "down";
    if (deg >= 135 && deg < 225) return "left";
    return "up";
  }

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left click only
    if (!socket || !myId) return;
    if (!loginOverlay.classList.contains("hidden")) return; // still on login screen
    const me = players.get(myId);
    if (!me || me.dead) return;
    // Flying minigame: "make mouse clicks shoot fireballs from the player
    // dragon in the direction of the mouse cursor" -- a separate screen
    // transform from the outside world (see drawFlying's flyingOffX/
    // flyingOffY/flyingScale), so this branches before the sword-swing logic
    // below rather than sharing its effRTile/camX/camY math.
    if (myArea === "flying") {
      const arenaMouseX = (mouseClientX - flyingOffX) / flyingScale;
      const arenaMouseY = (mouseClientY - flyingOffY) / flyingScale;
      const angle = Math.atan2(arenaMouseY - me.renderY, arenaMouseX - me.renderX);
      socket.emit("fly_shoot", { angle });
      return;
    }
    const worldMouseX = (mouseClientX + lastCamX) / effRTile;
    const worldMouseY = (mouseClientY + lastCamY) / effRTile;
    const angle = Math.atan2(worldMouseY - me.renderY, worldMouseX - me.renderX);
    me.swingAngle = angle;
    me.swingStart = performance.now();
    me.dir = dirFromAngleClient(angle);
    playSwooshFor(me);
    socket.emit("attack", { angle });
  });

  // ---------------------------------------------------------------------
  // Local prediction (mirrors server movement/collision rules, including
  // entity-vs-entity separation so we don't visually clip through other
  // players/monsters before the server correction arrives).
  // ---------------------------------------------------------------------
  function isBlocked(tx, ty) {
    const map = activeMap();
    if (!map) return true;
    if (tx < 0 || ty < 0 || ty >= map.height || tx >= map.width) return true;
    return map.collision[ty][tx] === 1;
  }
  function canStandOnTerrain(x, y) {
    const r = PLAYER_RADIUS;
    return (
      !isBlocked(Math.floor(x - r), Math.floor(y - r)) &&
      !isBlocked(Math.floor(x + r), Math.floor(y - r)) &&
      !isBlocked(Math.floor(x - r), Math.floor(y + r)) &&
      !isBlocked(Math.floor(x + r), Math.floor(y + r))
    );
  }
  function canStandAt(x, y) {
    if (!canStandOnTerrain(x, y)) return false;
    for (const [id, p] of players) {
      if (id === myId || p.dead || p.area !== myArea) continue;
      const required = PLAYER_ENTITY_RADIUS + (p.radius || PLAYER_ENTITY_RADIUS);
      if (Math.hypot(p.renderX - x, p.renderY - y) < required) return false;
    }
    if (myArea === "outside") {
      for (const m of monsters.values()) {
        const required = PLAYER_ENTITY_RADIUS + (m.radius || PLAYER_ENTITY_RADIUS);
        if (Math.hypot(m.renderX - x, m.renderY - y) < required) return false;
      }
    }
    return true;
  }

  // Side-scroller: horizontal movement is predicted locally for a snappy
  // feel (no terrain collision to speak of, just world-edge clamping);
  // vertical position (gravity/jump/platform-landing) is NOT duplicated
  // client-side -- it follows the server's authoritative y via a fairly
  // tight lerp instead, since re-deriving the exact same landing physics
  // here would risk subtly diverging from the real server behavior.
  function predictCavernLocal(me, dt) {
    if (me.dead || iAmDead) { me.moving = false; return; }
    const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    me.moving = dx !== 0;
    if (dx !== 0) me.dir = dx > 0 ? "right" : "left";
    if (cavernMap) {
      me.renderX = Math.max(0.5, Math.min(cavernMap.width - 0.5, me.renderX + dx * CAVERN_HSPEED * dt));
    }
    if (typeof me.targetY === "number") {
      const distY = Math.abs(me.targetY - me.renderY);
      if (distY > 3) me.renderY = me.targetY;
      else me.renderY += (me.targetY - me.renderY) * 0.45;
    }
    if (typeof me.targetX === "number") {
      const distX = Math.abs(me.targetX - me.renderX);
      if (distX > 3) me.renderX = me.targetX;
      else me.renderX += (me.targetX - me.renderX) * 0.2;
    }
  }

  function predictCliffLocal(me, dt) {
    if (me.dead || iAmDead) { me.moving = false; return; }
    const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    me.moving = dx !== 0;
    if (dx !== 0) me.dir = dx > 0 ? "right" : "left";
    if (cliffMap) {
      me.renderX = Math.max(0.5, Math.min(cliffMap.width - 0.5, me.renderX + dx * CAVERN_HSPEED * dt));
      me.renderY = cliffMap.groundY;
    }
    if (typeof me.targetX === "number") {
      const distX = Math.abs(me.targetX - me.renderX);
      if (distX > 3) me.renderX = me.targetX;
      else me.renderX += (me.targetX - me.renderX) * 0.2;
    }
  }

  function predictFlyingLocal(me, dt) {
    if (me.dead || iAmDead) { me.moving = false; return; }
    // Scripted cutscene beats take over movement entirely -- see the
    // "flying_boss_died"/"flying_woosh_start" handlers above.
    if (flyingPhase === "bossIntro") { me.moving = false; return; } // "stuns all players" during the screech/smoke intro
    if (flyingPhase === "bossDying") { me.moving = false; return; } // hold position through the explosion
    if (flyingPhase === "woosh") {
      // "make the player dragon woosh off the screen" -- ease-in tween from
      // wherever the dragon was standing when the boss died, off past the
      // top-right corner of the arena (draw naturally clips it once it's
      // outside the canvas -- no explicit fade needed).
      const t = Math.min(1, (performance.now() - flyingWooshStartTime) / FLYING_BOSS_WOOSH_MS);
      const ease = t * t;
      me.renderX = flyingWooshStartX + (FLYING_ARENA_W + 6 - flyingWooshStartX) * ease;
      me.renderY = flyingWooshStartY - (flyingWooshStartY + 6) * ease;
      me.moving = true;
      me.dir = "right";
      return;
    }
    let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    const moving = dx !== 0 || dy !== 0;
    me.moving = moving;
    if (moving) {
      if (dx !== 0 && dy !== 0) { const inv = 1 / Math.SQRT2; dx *= inv; dy *= inv; }
      if (Math.abs(dx) > Math.abs(dy)) me.dir = dx > 0 ? "right" : "left";
      else if (dy !== 0) me.dir = dy > 0 ? "down" : "up";
      const step = CAVERN_HSPEED * dt;
      me.renderX = Math.max(FLYING_PLAYER_PAD, Math.min(FLYING_ARENA_W - FLYING_PLAYER_PAD, me.renderX + dx * step));
      me.renderY = Math.max(FLYING_PLAYER_PAD, Math.min(FLYING_ARENA_H - FLYING_PLAYER_PAD, me.renderY + dy * step));
    }
    if (typeof me.targetX === "number") {
      const dist = Math.hypot(me.targetX - me.renderX, me.targetY - me.renderY);
      if (dist > 3) { me.renderX = me.targetX; me.renderY = me.targetY; }
      else {
        me.renderX += (me.targetX - me.renderX) * 0.2;
        me.renderY += (me.targetY - me.renderY) * 0.2;
      }
    }
  }

  function predictLocal(dt) {
    const me = players.get(myId);
    if (!me) return;
    if (myArea === "cavern") { predictCavernLocal(me, dt); return; }
    if (myArea === "cliff") { predictCliffLocal(me, dt); return; }
    if (myArea === "flying") { predictFlyingLocal(me, dt); return; }
    if (me.dead || iAmDead) { me.moving = false; return; }
    let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    const moving = dx !== 0 || dy !== 0;
    me.moving = moving;
    if (moving) {
      if (dx !== 0 && dy !== 0) { const inv = 1 / Math.SQRT2; dx *= inv; dy *= inv; }
      if (Math.abs(dx) > Math.abs(dy)) me.dir = dx > 0 ? "right" : "left";
      else if (dy !== 0) me.dir = dy > 0 ? "down" : "up";

      // Mirrors the server's water-tile slowdown so the client doesn't
      // predict ahead of the authoritative position and then visibly snap
      // back every time a player wades into/out of water.
      const map = activeMap();
      const tileRow = myArea === "outside" && map ? map.grid[Math.floor(me.renderY)] : null;
      const inWater = !!(tileRow && tileRow[Math.floor(me.renderX)] === TILE_ID_WATER);
      const step = SPEED * (inWater ? WATER_SPEED_MULT : 1) * dt;
      const nx = me.renderX + dx * step;
      const ny = me.renderY + dy * step;
      if (canStandAt(nx, me.renderY)) me.renderX = nx;
      if (canStandAt(me.renderX, ny)) me.renderY = ny;
    }
    // Gently reconcile toward server-confirmed position to avoid drift.
    if (typeof me.targetX === "number") {
      const dist = Math.hypot(me.targetX - me.renderX, me.targetY - me.renderY);
      if (dist > 2.5) {
        me.renderX = me.targetX; me.renderY = me.targetY;
      } else if (dist > 0.05) {
        me.renderX += (me.targetX - me.renderX) * LOCAL_CORRECT_LERP;
        me.renderY += (me.targetY - me.renderY) * LOCAL_CORRECT_LERP;
      }
    }
  }

  function updateRemote() {
    for (const [id, p] of players) {
      if (id === myId) continue;
      p.renderX += (p.targetX - p.renderX) * REMOTE_LERP;
      p.renderY += (p.targetY - p.renderY) * REMOTE_LERP;
    }
    for (const m of monsters.values()) {
      m.renderX += (m.targetX - m.renderX) * REMOTE_LERP;
      m.renderY += (m.targetY - m.renderY) * REMOTE_LERP;
    }
    for (const m of cavernMonsters.values()) {
      m.renderX += (m.targetX - m.renderX) * REMOTE_LERP;
      m.renderY += (m.targetY - m.renderY) * REMOTE_LERP;
    }
    for (const e of flyingEnemies.values()) {
      e.renderX += (e.x - e.renderX) * REMOTE_LERP;
      e.renderY += (e.y - e.renderY) * REMOTE_LERP;
    }
    if (flyingBoss) {
      flyingBoss.renderX += (flyingBoss.x - flyingBoss.renderX) * REMOTE_LERP;
      flyingBoss.renderY += (flyingBoss.y - flyingBoss.renderY) * REMOTE_LERP;
    }
    for (const n of tavernNpcs.values()) {
      n.renderX += (n.targetX - n.renderX) * REMOTE_LERP;
      n.renderY += (n.targetY - n.renderY) * REMOTE_LERP;
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // Zoom in (larger px/tile) as needed so a big window/monitor never
    // reveals more than MAX_VISIBLE_TILES tiles in either dimension.
    // Small windows keep the nominal tile size (never zooms out below it).
    effRTile = Math.max(RTILE, canvas.width / MAX_VISIBLE_TILES, canvas.height / MAX_VISIBLE_TILES);
  }
  window.addEventListener("resize", resizeCanvas);

  function draw(now) {
    ctx.imageSmoothingEnabled = false;
    if (myArea === "cavern") { drawCavern(now); return; }
    if (myArea === "cliff") { drawCliff(now); return; }
    if (myArea === "flying") { drawFlying(now); return; }
    ctx.fillStyle = "#16233a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const map = activeMap();
    if (!map || !tilesetReady) return;

    const me = players.get(myId);
    const camX = me ? me.renderX * effRTile - canvas.width / 2 : 0;
    const camY = me ? me.renderY * effRTile - canvas.height / 2 : 0;
    lastCamX = camX; lastCamY = camY;

    const startCol = Math.max(0, Math.floor(camX / effRTile) - 1);
    const endCol = Math.min(map.width - 1, Math.ceil((camX + canvas.width) / effRTile) + 1);
    const startRow = Math.max(0, Math.floor(camY / effRTile) - 1);
    const endRow = Math.min(map.height - 1, Math.ceil((camY + canvas.height) / effRTile) + 1);

    const waterFrameIdx = WATER_FRAME_TILE_INDEX[Math.floor(now / WATER_FRAME_MS) % WATER_FRAME_TILE_INDEX.length];
    const treeCells = [];

    // Precompute exact shared pixel boundaries for every visible column/row
    // so adjacent tiles butt up perfectly. Rounding each tile's position
    // AND size independently (Math.round(col*effRTile-camX) plus a
    // separate effRTile width) can leave a sub-pixel gap between one tile's
    // right edge and the next tile's left edge at certain zoom levels --
    // with pixelated rendering that gap shows through as a thin dark seam
    // (the canvas's background fill) between every tile. Deriving each
    // tile's width/height from the DIFFERENCE of two already-rounded
    // boundary positions guarantees no gap or overlap is possible.
    const colEdges = [];
    for (let col = startCol; col <= endCol + 1; col++) colEdges.push(Math.round(col * effRTile - camX));
    const rowEdges = [];
    for (let row = startRow; row <= endRow + 1; row++) rowEdges.push(Math.round(row * effRTile - camY));

    for (let row = startRow; row <= endRow; row++) {
      const dy = rowEdges[row - startRow];
      const dh = rowEdges[row - startRow + 1] - dy;
      for (let col = startCol; col <= endCol; col++) {
        const tIdx = map.grid[row][col];
        const drawIdx = tIdx === TILE_ID_WATER ? waterFrameIdx : tIdx;
        const sx = drawIdx * TILE;
        const dx = colEdges[col - startCol];
        const dw = colEdges[col - startCol + 1] - dx;
        ctx.drawImage(tilesetImg, sx, 0, TILE, TILE, dx, dy, dw, dh);
        if (tIdx === TILE_ID_TREE) treeCells.push({ row, col });
      }
    }

    // Second ground pass: soften the hard tile grid by fading each tile's
    // neighbor color a little way in across any border where the tile type
    // actually changes, using pre-tinted copies of the edge-dither mask.
    if (edgeTintsReady) {
      for (let row = startRow; row <= endRow; row++) {
        const dy = rowEdges[row - startRow];
        const dh = rowEdges[row - startRow + 1] - dy;
        for (let col = startCol; col <= endCol; col++) {
          const tIdx = map.grid[row][col];
          const dx = colEdges[col - startCol];
          const dw = colEdges[col - startCol + 1] - dx;
          if (row > 0) {
            const n = map.grid[row - 1][col];
            if (n !== tIdx) stampEdgeBlend(n, dx, dy, dw, dh, "up");
          }
          if (row < map.height - 1) {
            const n = map.grid[row + 1][col];
            if (n !== tIdx) stampEdgeBlend(n, dx, dy, dw, dh, "down");
          }
          if (col > 0) {
            const n = map.grid[row][col - 1];
            if (n !== tIdx) stampEdgeBlend(n, dx, dy, dw, dh, "left");
          }
          if (col < map.width - 1) {
            const n = map.grid[row][col + 1];
            if (n !== tIdx) stampEdgeBlend(n, dx, dy, dw, dh, "right");
          }
        }
      }
    }

    // The cave-entrance barrier (while the dragon's still alive) renders as
    // a static blocker right after the ground, same layer as the walls it's
    // standing in for -- it never needs to Y-sort against characters.
    drawCaveGateBarrier(camX, camY);

    // Warm light glows (tavern lanterns/door, or the tavern building's door
    // seen from outside) render under everything else -- a soft backdrop
    // rather than an occluding sprite.
    drawAreaLightGlows(camX, camY, now);

    // Trees overflow upward past their own tile and characters vary in
    // height, so everything that can occlude / be occluded gets merged
    // into one Y-sorted pass keyed on each thing's "ground" position.
    const visiblePlayers = [...players.values()].filter((p) => p.area === myArea);
    const visibleMonsters = myArea === "outside" ? [...monsters.values()] : [];
    const visibleTavernNpcs = myArea === "tavern" ? [...tavernNpcs.values()] : [];
    const drawables = [
      ...treeCells.map((t) => ({ kind: "tree", sortY: t.row + 1, row: t.row, col: t.col })),
      ...visiblePlayers.map((p) => ({ kind: "player", sortY: p.renderY, p })),
      ...visibleMonsters.map((m) => ({ kind: "monster", sortY: m.renderY, m })),
      ...visibleTavernNpcs.map((n) => ({ kind: "tavernnpc", sortY: n.renderY, n })),
      ...deathFx.map((fx) => ({ kind: "deathfx", sortY: fx.y, fx })),
    ];
    if (myArea === "tavern" && tavernMap && tavernMap.decor) {
      const decor = tavernMap.decor;
      decor.barrels.forEach((b) => drawables.push({ kind: "barrel", sortY: b.y, b }));
      decor.tables.forEach((t) => drawables.push({ kind: "table", sortY: t.y, t }));
      drawables.push({ kind: "fireplace", sortY: decor.fireplace.y, pt: decor.fireplace });
      drawables.push({ kind: "sign", sortY: decor.sign.y, pt: decor.sign });
      for (let col = decor.bar.x0; col <= decor.bar.x1; col++) {
        drawables.push({ kind: "barunit", sortY: decor.bar.row + 1, col, row: decor.bar.row });
      }
    }
    if (myArea === "outside" && !swordState.held) {
      drawables.push({ kind: "sworditem", sortY: swordState.y });
    }
    if (myArea === "outside" && !bowState.held) {
      drawables.push({ kind: "bowitem", sortY: bowState.y });
    }
    if (myArea === "outside") {
      caveTreasure.forEach((tr) => drawables.push({ kind: "treasure", sortY: tr.y, tr }));
      graveyardHeadstones.forEach((hs) => drawables.push({ kind: "headstone", sortY: hs.y, hs }));
      fireHazards.forEach((f) => drawables.push({ kind: "fire", sortY: f.y, f }));
      projectiles.forEach((a) => drawables.push({ kind: "arrow", sortY: a.y, a }));
      if (tavernRoofSign) drawables.push({ kind: "tavernroofsign", sortY: tavernRoofSign.y, pt: tavernRoofSign });
    }
    drawables.sort((a, b) => a.sortY - b.sortY);
    for (const item of drawables) {
      if (item.kind === "tree") drawTreeAt(item.col, item.row, camX, camY, now);
      else if (item.kind === "player") drawPlayer(item.p, camX, camY, now);
      else if (item.kind === "monster") drawMonster(item.m, camX, camY, now);
      else if (item.kind === "tavernnpc") drawTavernNpc(item.n, camX, camY, now);
      else if (item.kind === "barrel") drawBarrelAt(item.b, camX, camY);
      else if (item.kind === "sworditem") drawGroundFlamingSword(camX, camY, now);
      else if (item.kind === "bowitem") drawGroundBow(camX, camY, now);
      else if (item.kind === "table") drawTableAt(item.t, camX, camY, now);
      else if (item.kind === "fireplace") drawFireplaceAt(item.pt, camX, camY);
      else if (item.kind === "sign") drawSignAt(item.pt, camX, camY);
      else if (item.kind === "barunit") drawBarUnitAt(item.col, item.row, camX, camY);
      else if (item.kind === "treasure") drawTreasureAt(item.tr, camX, camY);
      else if (item.kind === "headstone") drawHeadstoneAt(item.hs, camX, camY);
      else if (item.kind === "fire") drawFireHazardAt(item.f, camX, camY, now);
      else if (item.kind === "arrow") drawArrowAt(item.a, camX, camY);
      else if (item.kind === "tavernroofsign") drawTavernRoofSignAt(item.pt, camX, camY);
      else drawDeathFx(item.fx, camX, camY, now);
    }

    // Prune finished death effects after drawing this frame.
    for (let i = deathFx.length - 1; i >= 0; i--) {
      if (now - deathFx[i].startTime > DEATH_FX_MS) deathFx.splice(i, 1);
    }

    updateBirds(now, camX, camY);
    drawBirds(camX, camY);

    if (myArea === "tavern" && isTavernPartyActive()) drawTavernPartyLights(now);
    if (myArea === "tavern" && now < tavernFireworksUntil) drawTavernFireworks(now);
  }

  // "Fireworks explode across the screen for a few seconds as soon as you
  // enter" the tavern during the party -- layered on top of the existing
  // ambient party lights (drawTavernPartyLights), a burst of new firework
  // explosions spawns at random screen positions every couple hundred ms
  // for TAVERN_FIREWORKS_SHOW_MS, each one a short-lived radiating shower of
  // particles with a little gravity droop, purely canvas-drawn (no new
  // sprite assets needed, same spirit as the party lights).
  let tavernFireworksUntil = 0;
  let tavernNextFireworkAt = 0;
  const tavernFireworkBursts = []; // {x,y,startTime,color}
  const TAVERN_FIREWORKS_SHOW_MS = 4500;
  const TAVERN_FIREWORK_INTERVAL_MIN_MS = 220;
  const TAVERN_FIREWORK_INTERVAL_MAX_MS = 450;
  const TAVERN_FIREWORK_BURST_MS = 900;
  const TAVERN_FIREWORK_COLORS = ["#ff5050", "#4fa8ff", "#ffd23c", "#7dff6e", "#dd6bff", "#ff9f40", "#4ff0e0"];

  function drawTavernFireworks(now) {
    if (now >= tavernNextFireworkAt) {
      tavernFireworkBursts.push({
        x: canvas.width * 0.12 + Math.random() * canvas.width * 0.76,
        y: canvas.height * 0.1 + Math.random() * canvas.height * 0.4,
        startTime: now,
        color: TAVERN_FIREWORK_COLORS[Math.floor(Math.random() * TAVERN_FIREWORK_COLORS.length)],
      });
      tavernNextFireworkAt = now + TAVERN_FIREWORK_INTERVAL_MIN_MS + Math.random() * (TAVERN_FIREWORK_INTERVAL_MAX_MS - TAVERN_FIREWORK_INTERVAL_MIN_MS);
    }
    for (let i = tavernFireworkBursts.length - 1; i >= 0; i--) {
      const b = tavernFireworkBursts[i];
      const age = now - b.startTime;
      if (age > TAVERN_FIREWORK_BURST_MS) { tavernFireworkBursts.splice(i, 1); continue; }
      drawTavernFireworkBurst(b, age / TAVERN_FIREWORK_BURST_MS);
    }
  }

  function drawTavernFireworkBurst(b, t) {
    const particleCount = 16;
    const maxDist = Math.min(canvas.width, canvas.height) * 0.16;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < particleCount; i++) {
      const ang = (i / particleCount) * Math.PI * 2 + (b.startTime % 1); // slight per-burst rotation variety
      const dist = t * maxDist;
      const px = b.x + Math.cos(ang) * dist;
      const py = b.y + Math.sin(ang) * dist + t * t * maxDist * 0.4; // gentle gravity droop
      const alpha = Math.max(0, 1 - t * t);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1, 3.2 - t * 2), 0, Math.PI * 2);
      ctx.fill();
    }
    // Bright flash core right at the burst's origin, quickly fading -- reads
    // as the initial "pop" before the particles have visibly spread.
    if (t < 0.3) {
      ctx.globalAlpha = (1 - t / 0.3) * 0.8;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // A handful of big, softly-pulsing colored spotlights swept across the
  // whole screen in a "lighter" composite -- reads as a cheap, obviously
  // festive disco/party-light effect once the tavern party kicks off,
  // without needing any new sprite assets.
  const PARTY_LIGHT_COLORS = ["255,80,80", "80,150,255", "120,255,120", "255,210,60", "220,90,255"];
  function drawTavernPartyLights(now) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const R = Math.max(canvas.width, canvas.height) * 0.55;
    for (let i = 0; i < PARTY_LIGHT_COLORS.length; i++) {
      const speed = 900 + i * 130;
      const phase = (i / PARTY_LIGHT_COLORS.length) * Math.PI * 2;
      const ang = now / speed + phase;
      const lx = cx + Math.cos(ang) * R * 0.45;
      const ly = cy + Math.sin(ang * 0.8) * R * 0.35;
      const pulse = 0.16 + 0.1 * Math.abs(Math.sin(now / 260 + phase));
      const grad = ctx.createRadialGradient(lx, ly, 0, lx, ly, R * 0.5);
      grad.addColorStop(0, `rgba(${PARTY_LIGHT_COLORS[i]},${pulse})`);
      grad.addColorStop(1, `rgba(${PARTY_LIGHT_COLORS[i]},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
  }

  // Soft warm radial glow -- used both for the tavern's interior
  // lanterns/door light and for the tavern building's door as seen from
  // outside, so the entrance reads as an obvious, lit "come in" spot.
  function drawGlowAt(worldX, worldY, camX, camY, radiusTiles, alpha) {
    const cx = worldX * effRTile - camX;
    const cy = worldY * effRTile - camY;
    const r = radiusTiles * effRTile;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(255, 214, 130, ${alpha})`);
    grad.addColorStop(1, "rgba(255, 214, 130, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Every candle-on-a-table plus the fireplace get a warm flicker glow,
  // positioned from each decor item's own world coordinates plus the
  // sprite-local flame-anchor pixel offset baked in by tools/gen_assets.py
  // (so the glow always lines up with the drawn flame even as the sprite's
  // world position/scale changes).
  function tableFlameWorld(t) {
    const isRound = t.shape === "round";
    const w = isRound ? TABLE_ROUND_W : TABLE_RECT_W;
    const h = isRound ? TABLE_ROUND_H : TABLE_RECT_H;
    const flame = isRound ? TABLE_ROUND_FLAME : TABLE_RECT_FLAME;
    return {
      x: t.x - w / 2 / TILE + flame.x / TILE,
      y: t.y - h / 2 / TILE + flame.y / TILE,
    };
  }

  function drawAreaLightGlows(camX, camY, now) {
    if (myArea === "tavern" && tavernMap && tavernMap.decor) {
      const decor = tavernMap.decor;
      const fp = decor.fireplace;
      const fireFlicker = Math.sin(now / 90) * 0.15;
      drawGlowAt(fp.x, fp.y, camX, camY, 1.6, 0.55 + fireFlicker);
      decor.tables.forEach((t, i) => {
        const flame = tableFlameWorld(t);
        const flicker = Math.sin(now / (90 + i * 13) + i * 1.7) * 0.12;
        drawGlowAt(flame.x, flame.y, camX, camY, 0.6, 0.42 + flicker);
      });
    } else if (myArea === "outside" && worldMap && worldMap.tavernDoorTile) {
      const d = worldMap.tavernDoorTile;
      drawGlowAt(d.x + 0.5, d.y + 0.5, camX, camY, 2.6, 0.4);
    }
  }

  function drawBarrelAt(b, camX, camY) {
    if (!barrelImg.complete || barrelImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = 16 * scale, dispH = 16 * scale;
    const footX = Math.round(b.x * effRTile - camX);
    const footY = Math.round(b.y * effRTile - camY);
    drawGroundShadow(footX, footY + dispH * 0.3, effRTile * 0.28, effRTile * 0.12);
    ctx.drawImage(barrelImg, 0, 0, 16, 16, Math.round(footX - dispW / 2), Math.round(footY - dispH / 2), dispW, dispH);
  }

  // Tavern furniture: tables (round or rect), fireplace, bar counter run
  // (tiled from a single repeatable segment), and the hanging sign -- all
  // decor sprites rather than baked tile grid, so they can sit at the
  // fractional layout positions computed in server/map.js.
  function drawTableAt(t, camX, camY) {
    if (!tilesetReady) return;
    const isRound = t.shape === "round";
    const img = isRound ? tableRoundImg : tableRectImg;
    if (!img.complete || img.naturalWidth === 0) return;
    const w = isRound ? TABLE_ROUND_W : TABLE_RECT_W;
    const h = isRound ? TABLE_ROUND_H : TABLE_RECT_H;
    const scale = effRTile / TILE;
    const dispW = w * scale, dispH = h * scale;
    const footX = Math.round(t.x * effRTile - camX);
    const footY = Math.round(t.y * effRTile - camY);
    drawGroundShadow(footX, footY + dispH * 0.32, effRTile * 0.5, effRTile * 0.18);
    ctx.drawImage(img, 0, 0, w, h, Math.round(footX - dispW / 2), Math.round(footY - dispH / 2), dispW, dispH);
  }

  function drawFireplaceAt(pt, camX, camY) {
    if (!fireplaceImg.complete || fireplaceImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = FIREPLACE_W * scale, dispH = FIREPLACE_H * scale;
    // pt is the flame anchor point; back out the sprite's top-left so the
    // baked flame offset lands exactly on pt.
    const screenX = Math.round(pt.x * effRTile - camX - FIREPLACE_FLAME.x * scale);
    const screenY = Math.round(pt.y * effRTile - camY - FIREPLACE_FLAME.y * scale);
    ctx.drawImage(fireplaceImg, 0, 0, FIREPLACE_W, FIREPLACE_H, screenX, screenY, dispW, dispH);
  }

  function drawSignAt(pt, camX, camY) {
    if (!signImg.complete || signImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = SIGN_W * scale, dispH = SIGN_H * scale;
    const cx = Math.round(pt.x * effRTile - camX);
    const cy = Math.round(pt.y * effRTile - camY);
    ctx.drawImage(signImg, 0, 0, SIGN_W, SIGN_H, Math.round(cx - dispW / 2), Math.round(cy - dispH / 2), dispW, dispH);
  }

  // "A sign on the top saying Dirtywood" -- the outside tavern building's
  // roof sign (see world.tavernRoofSign in server/map.js). pt.y already
  // sits just above the roof-edge row (see the -0.15 offset server-side),
  // so this anchors the sign's BOTTOM (where its support posts meet the
  // roof) at pt rather than centering it like drawSignAt's interior sign.
  function drawTavernRoofSignAt(pt, camX, camY) {
    if (!signTavernRoofImg.complete || signTavernRoofImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = SIGN_ROOF_W * scale, dispH = SIGN_ROOF_H * scale;
    const footX = Math.round(pt.x * effRTile - camX);
    const footY = Math.round(pt.y * effRTile - camY);
    ctx.drawImage(signTavernRoofImg, 0, 0, SIGN_ROOF_W, SIGN_ROOF_H, Math.round(footX - dispW / 2), Math.round(footY - dispH), dispW, dispH);
  }

  // The "Goblin Booze, do not touch!" warning sign posted next to the
  // cliff's barrel cluster -- same generic world-to-screen placement math
  // as drawSignAt, just its own (wider, warning-red) sprite and planted at
  // ground level via a post rather than hung at head height.
  function drawBoozeSignAt(pt, camX, camY) {
    if (!signBoozeImg.complete || signBoozeImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = SIGN_BOOZE_W * scale, dispH = SIGN_BOOZE_H * scale;
    const footX = Math.round(pt.x * effRTile - camX);
    const footY = Math.round(pt.y * effRTile - camY);
    ctx.drawImage(signBoozeImg, 0, 0, SIGN_BOOZE_W, SIGN_BOOZE_H, Math.round(footX - dispW / 2), Math.round(footY - dispH), dispW, dispH);
  }

  function drawBarUnitAt(col, row, camX, camY) {
    if (!barUnitImg.complete || barUnitImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = effRTile, dispH = BAR_UNIT_H * scale;
    const baseX = Math.round(col * effRTile + effRTile / 2 - camX);
    const baseY = Math.round((row + 1) * effRTile - camY);
    ctx.drawImage(barUnitImg, 0, 0, BAR_UNIT_W, BAR_UNIT_H, Math.round(baseX - dispW / 2), Math.round(baseY - dispH), dispW, dispH);
  }

  // Purely aesthetic gold/gem piles scattered around the dragon's cave --
  // nothing here is pickable, they're just set dressing.
  function drawTreasureAt(tr, camX, camY) {
    const img = treasureImgs[tr.variant] || treasureImgs[0];
    if (!img.complete || img.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = TREASURE_W * scale, dispH = TREASURE_H * scale;
    const cx = Math.round(tr.x * effRTile - camX);
    const cy = Math.round(tr.y * effRTile - camY);
    ctx.drawImage(img, 0, 0, TREASURE_W, TREASURE_H, Math.round(cx - dispW / 2), Math.round(cy - dispH / 2), dispW, dispH);
  }

  // Purely aesthetic headstones scattered around the outside-world graveyard
  // respawn area -- no collision, just set dressing (see drawTreasureAt above
  // for the identical pattern).
  function drawHeadstoneAt(hs, camX, camY) {
    const img = headstoneImgs[hs.variant] || headstoneImgs[0];
    if (!img.complete || img.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = HEADSTONE_W * scale, dispH = HEADSTONE_H * scale;
    const footX = Math.round(hs.x * effRTile - camX);
    const footY = Math.round(hs.y * effRTile - camY);
    ctx.drawImage(img, 0, 0, HEADSTONE_W, HEADSTONE_H, Math.round(footX - dispW / 2), Math.round(footY - dispH), dispW, dispH);
  }

  // Draws a single rough wooden/rock barrier tile -- shared by the main
  // entrance/back-door gate (caveSealed) and the west side door (its own
  // separate, one-way caveSideDoorOpened latch).
  function drawGateBarrierTile(t, camX, camY) {
    const dx = Math.round(t.x * effRTile - camX);
    const dy = Math.round(t.y * effRTile - camY);
    if (dx + effRTile < 0 || dy + effRTile < 0 || dx > canvas.width || dy > canvas.height) return;
    ctx.save();
    ctx.fillStyle = "rgba(58,42,30,0.9)";
    ctx.fillRect(dx, dy, effRTile, effRTile);
    ctx.strokeStyle = "rgba(20,14,10,0.9)";
    ctx.lineWidth = Math.max(1, effRTile * 0.06);
    ctx.beginPath();
    ctx.moveTo(dx + effRTile * 0.08, dy + effRTile * 0.08);
    ctx.lineTo(dx + effRTile * 0.92, dy + effRTile * 0.92);
    ctx.moveTo(dx + effRTile * 0.92, dy + effRTile * 0.08);
    ctx.lineTo(dx + effRTile * 0.08, dy + effRTile * 0.92);
    ctx.stroke();
    ctx.restore();
  }

  // Sealed cave entrance: a rough wooden/rock barrier stamped over the main
  // entrance tiles while the dragon guarding it is still alive.
  function drawCaveGateBarrier(camX, camY) {
    if (myArea !== "outside") return;
    if (caveSealed) {
      for (const t of caveEntranceTiles) drawGateBarrierTile(t, camX, camY);
    }
    // The west side door AND the back door (into the cavern depths) are
    // both one-way latches: closed until the dragon's first death, then
    // open forever -- independent of caveSealed's per-dragon-lifecycle
    // toggle on the main entrance (see server/index.js's
    // openCaveSideDoorOnce/openCaveBackDoorOnce).
    if (!caveSideDoorOpened && caveSideDoorTile) drawGateBarrierTile(caveSideDoorTile, camX, camY);
    if (!caveBackDoorOpened && caveBackDoorTile) drawGateBarrierTile(caveBackDoorTile, camX, camY);
  }

  // Procedural flame shape shared by dragon-death fire hazards and the
  // small flame overlay drawn at a burning player's feet -- no baked sprite,
  // just a swaying gradient teardrop so it reads as fire at any scale.
  // `phase` offsets one instance's flicker timing from another's (used by
  // drawFireHazardAt below to draw several overlapping tongues that don't
  // all flicker in lockstep) -- defaults to 0 for every other caller.
  function drawFlameShape(cx, cy, scale, now, phase) {
    const t = now + (phase || 0);
    // Two mismatched-frequency sines beating against each other reads as an
    // irregular flicker rather than a single smooth "breathing" pulse.
    const flicker = Math.sin(t / 70) * 0.5 + Math.sin(t / 43) * 0.3 + Math.sin(t / 131) * 0.2;
    const sway = (Math.sin(t / 260) + Math.sin(t / 97) * 0.5) * scale * 0.06;
    const baseR = scale * (0.32 + flicker * 0.08);
    const height = scale * (0.56 + flicker * 0.14);
    ctx.save();
    ctx.translate(cx, cy);
    const grad = ctx.createLinearGradient(0, scale * 0.28, 0, -height);
    grad.addColorStop(0, "rgba(150,15,5,0.95)");
    grad.addColorStop(0.35, "rgba(230,90,15,0.95)");
    grad.addColorStop(0.7, "rgba(255,170,40,0.95)");
    grad.addColorStop(1, "rgba(255,235,120,0.92)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, scale * 0.3);
    ctx.quadraticCurveTo(baseR, 0, sway * 0.7, -height);
    ctx.quadraticCurveTo(-baseR * 0.35, -scale * 0.2, -baseR * 0.9, scale * 0.1);
    ctx.quadraticCurveTo(-baseR * 0.5, scale * 0.26, 0, scale * 0.3);
    ctx.fill();
    ctx.restore();
  }

  // Cheap deterministic hash -- gives every fire hazard its own stable but
  // "random-looking" set of flame-tongue/ember offsets from its (x,y)
  // position alone, so the layout never reshuffles/flickers frame to frame
  // (same pattern as the boss's bone-pile fx: randomness computed as a pure
  // function of stable inputs, not re-rolled per draw call).
  function fireHazardHash(x, y, salt) {
    const v = Math.sin((x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453) * 43758.5453;
    return v - Math.floor(v);
  }

  // A proper flickering campfire: several overlapping flame tongues at
  // slightly different offsets/scales/phases, plus a handful of rising
  // embers -- "needs to look like flickering flames", not one static shape.
  function drawFireHazardAt(f, camX, camY, now) {
    const cx = Math.round(f.x * effRTile - camX);
    const cy = Math.round(f.y * effRTile - camY);
    drawGlowAt(f.x, f.y, camX, camY, 1.9, 0.55 + Math.sin(now / 110) * 0.2);

    const tongues = [
      { dx: -0.28, scale: 0.85, salt: 1 },
      { dx: 0.05, scale: 1.05, salt: 2 },
      { dx: 0.32, scale: 0.75, salt: 3 },
    ];
    for (const tg of tongues) {
      const phase = fireHazardHash(f.x, f.y, tg.salt) * 4000;
      drawFlameShape(cx + tg.dx * effRTile, cy, effRTile * tg.scale, now, phase);
    }

    const emberCount = 4;
    for (let i = 0; i < emberCount; i++) {
      const seed = fireHazardHash(f.x, f.y, 10 + i);
      const period = 1100 + seed * 500;
      const tphase = (now + seed * 5000) % period;
      const frac = tphase / period;
      const alpha = Math.sin(frac * Math.PI) * 0.85;
      if (alpha <= 0.02) continue;
      const ex = cx + (seed - 0.5) * effRTile * 0.7;
      const ey = cy - frac * effRTile * 1.4 - effRTile * 0.1;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(255, ${160 + Math.floor(seed * 60)}, 60, ${alpha})`;
      ctx.beginPath();
      ctx.arc(ex, ey, Math.max(1, effRTile * 0.035), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawArrowAt(a, camX, camY) {
    if (!arrowImg.complete || arrowImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = ARROW_NATIVE_W * scale, dispH = ARROW_NATIVE_H * scale;
    const cx = Math.round(a.x * effRTile - camX);
    const cy = Math.round(a.y * effRTile - camY);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a.angle);
    ctx.drawImage(arrowImg, -dispW / 2, -dispH / 2, dispW, dispH);
    ctx.restore();
  }

  // The golden bow sitting in the cave, waiting to be picked up -- same
  // bob+glow treatment as the flaming sword.
  function drawGroundBow(camX, camY, now) {
    if (!bowImg.complete || bowImg.naturalWidth === 0) return;
    const scale = (effRTile / TILE) * BOW_SCALE;
    const dispW = BOW_NATIVE_W * scale, dispH = BOW_NATIVE_H * scale;
    const bob = Math.sin(now / 420) * effRTile * 0.06;
    const footX = Math.round(bowState.x * effRTile - camX);
    const footY = Math.round(bowState.y * effRTile - camY + bob);
    drawGlowAt(bowState.x, bowState.y, camX, camY, 1.3, 0.5 + Math.sin(now / 200) * 0.15);
    drawGroundShadow(footX, footY + dispH * 0.3, effRTile * 0.26, effRTile * 0.11);
    ctx.save();
    ctx.translate(footX, footY);
    ctx.rotate(Math.PI / 8);
    ctx.drawImage(bowImg, -dispW / 2, -dispH / 2, dispW, dispH);
    ctx.restore();
  }

  // The flaming sword sitting in the cave, waiting to be picked up: drawn
  // laid flat with a gentle bob + flicker so it reads as an interactive
  // treasure rather than just more ground clutter.
  function drawGroundFlamingSword(camX, camY, now) {
    if (!flamingSwordImg.complete || flamingSwordImg.naturalWidth === 0) return;
    const scale = (effRTile / TILE) * SWORD_SCALE;
    const dispW = SWORD_NATIVE_W * scale;
    const dispH = SWORD_NATIVE_H * scale;
    const bob = Math.sin(now / 400) * effRTile * 0.06;
    const footX = Math.round(swordState.x * effRTile - camX);
    const footY = Math.round(swordState.y * effRTile - camY + bob);
    drawGlowAt(swordState.x, swordState.y, camX, camY, 1.4, 0.5 + Math.sin(now / 220) * 0.15);
    drawGroundShadow(footX, footY + dispH * 0.3, effRTile * 0.3, effRTile * 0.12);
    ctx.save();
    ctx.translate(footX, footY);
    ctx.rotate(Math.PI / 5);
    ctx.drawImage(flamingSwordImg, -dispW / 2, -dispH / 2, dispW, dispH);
    ctx.restore();
  }

  // Stamps a tinted copy of the edge-dither mask along one side of a tile,
  // fading from strong right at that edge to nothing a little way in --
  // giving the impression the neighboring (differently-typed) tile bleeds
  // in a bit instead of stopping at a hard grid line. `edge` is which side
  // of the (dx,dy)-sized tile to fade in from ("up"/"down"/"left"/"right"),
  // using an affine transform per side so the same square source mask can
  // be reused for all four orientations.
  function stampEdgeBlend(neighborTileId, dx, dy, w, h, edge) {
    const img = edgeTintCanvases[neighborTileId];
    if (!img) return;
    // "along" (the strip's length) uses this tile's actual rendered
    // width/height so it lines up exactly with the tile boundary computed
    // in draw(); "depth" (how far the fade reaches into the tile) is
    // derived from the overall zoom factor rather than the tile's own
    // width/height, since those can differ from each other by a stray
    // pixel from rounding and that shouldn't visibly skew the fade depth.
    const depth = effRTile * (EDGE_H / EDGE_W);
    ctx.save();
    if (edge === "up") { ctx.setTransform(1, 0, 0, 1, dx, dy); ctx.drawImage(img, 0, 0, EDGE_W, EDGE_H, 0, 0, w, depth); }
    else if (edge === "down") { ctx.setTransform(1, 0, 0, -1, dx, dy + h); ctx.drawImage(img, 0, 0, EDGE_W, EDGE_H, 0, 0, w, depth); }
    else if (edge === "left") { ctx.setTransform(0, 1, 1, 0, dx, dy); ctx.drawImage(img, 0, 0, EDGE_W, EDGE_H, 0, 0, h, depth); }
    else { ctx.setTransform(0, 1, -1, 0, dx + w, dy); ctx.drawImage(img, 0, 0, EDGE_W, EDGE_H, 0, 0, h, depth); }
    ctx.restore();
  }

  function drawTreeAt(col, row, camX, camY, now) {
    const baseX = Math.round(col * effRTile + effRTile / 2 - camX);
    const baseY = Math.round((row + 1) * effRTile - camY);
    // Deterministic per-tree phase (not random per-frame) so a given tree
    // always sways the same way, just offset from its neighbors.
    const phase = ((col * 13 + row * 7) % 17) / 17 * Math.PI * 2;
    const sway = Math.sin(now / 900 + phase) * 0.09;
    // Deterministic variant pick, decorrelated from the sway phase hash
    // above so neighboring trees don't always share both look and motion.
    const variant = (Math.abs(col * 31 + row * 17) % TREE_VARIANTS + TREE_VARIANTS) % TREE_VARIANTS;

    const dispW = effRTile * (TREE_NATIVE_W / TILE);
    const dispH = effRTile * (TREE_NATIVE_H / TILE);

    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.transform(1, 0, sway, 1, 0, 0); // shear around the trunk base = wind bend
    ctx.drawImage(treesImg, variant * TREE_NATIVE_W, 0, TREE_NATIVE_W, TREE_NATIVE_H, -dispW / 2, -dispH, dispW, dispH);
    ctx.restore();
  }

  function drawGroundShadow(footX, footY, rx, ry) {
    ctx.save();
    ctx.fillStyle = "rgba(10, 15, 10, 0.35)";
    ctx.beginPath();
    ctx.ellipse(footX, footY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawHealthBar(centerX, topY, hp, maxHp, widthPx, alwaysShow) {
    // Small monsters only show a bar once damaged (keeps the world
    // uncluttered); the dragon boss always shows its bar so players can
    // track the fight against its 100hp pool from the moment they engage.
    if (hp >= maxHp && !alwaysShow) return;
    const h = Math.max(3, Math.round(widthPx * 0.14));
    const x = Math.round(centerX - widthPx / 2);
    const y = Math.round(topY);
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    ctx.fillStyle = "rgba(10,10,12,0.75)";
    ctx.fillRect(x - 1, y - 1, widthPx + 2, h + 2);
    ctx.fillStyle = "#4a1414";
    ctx.fillRect(x, y, widthPx, h);
    ctx.fillStyle = frac > 0.5 ? "#4caf50" : frac > 0.25 ? "#d6a92a" : "#c9403a";
    ctx.fillRect(x, y, Math.round(widthPx * frac), h);
  }

  // Generic canvas-drawn speech bubble, positioned with its bottom-center
  // tail at (centerX, bottomY) -- i.e. call with bottomY = just above
  // whatever's already drawn there (name tag, health bar). Wraps long text
  // across multiple lines so long dialogue doesn't run off screen.
  function drawSpeechBubble(centerX, bottomY, text) {
    const maxWidth = 220;
    const lineHeight = 15;
    const padX = 10, padY = 8;
    ctx.save();
    ctx.font = "12px -apple-system, sans-serif";
    ctx.textAlign = "left";

    // Word-wrap into lines that fit maxWidth.
    const words = String(text).split(" ");
    const lines = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);

    const boxW = Math.min(maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width))) + padX * 2;
    const boxH = lines.length * lineHeight + padY * 2;
    const boxX = Math.round(centerX - boxW / 2);
    const boxY = Math.round(bottomY - boxH - 10);

    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(20,20,24,0.8)";
    ctx.lineWidth = 1.5;
    const r = 7;
    ctx.beginPath();
    ctx.moveTo(boxX + r, boxY);
    ctx.lineTo(boxX + boxW - r, boxY);
    ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + r, r);
    ctx.lineTo(boxX + boxW, boxY + boxH - r);
    ctx.arcTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH, r);
    ctx.lineTo(boxX + boxW / 2 + 7, boxY + boxH);
    ctx.lineTo(boxX + boxW / 2, boxY + boxH + 8); // tail pointing down at the speaker
    ctx.lineTo(boxX + boxW / 2 - 7, boxY + boxH);
    ctx.lineTo(boxX + r, boxY + boxH);
    ctx.arcTo(boxX, boxY + boxH, boxX, boxY + boxH - r, r);
    ctx.lineTo(boxX, boxY + r);
    ctx.arcTo(boxX, boxY, boxX + r, boxY, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#1a1a22";
    lines.forEach((l, i) => {
      const lw = ctx.measureText(l).width;
      ctx.fillText(l, Math.round(centerX - lw / 2), Math.round(boxY + padY + (i + 1) * lineHeight - 4));
    });
    ctx.restore();
  }

  function drawPlayer(p, camX, camY, now) {
    const img = charSprites[`${p.race}_${p.color}`] || charSprites["human_blue"];
    const dispW = effRTile * (CHAR_NATIVE_W / TILE);
    const dispH = effRTile * (CHAR_NATIVE_H / TILE);
    const footX = Math.round(p.renderX * effRTile - camX);
    const footY = Math.round(p.renderY * effRTile - camY + effRTile * 0.32);
    const screenX = Math.round(footX - dispW / 2);
    const screenY = Math.round(footY - dispH);

    drawGroundShadow(footX, footY - effRTile * 0.06, effRTile * 0.32, effRTile * 0.13);

    if (p.dead) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#cfe0ff";
      ctx.fillText("respawning…", footX, footY - dispH - 6);
      ctx.restore();
      return;
    }

    if (img && img.complete && img.naturalWidth > 0) {
      const row = DIR_ROW[p.dir] ?? 0;
      let frame = 1; // idle/neutral frame
      if (p.moving) {
        p.animT = (p.animT || 0) + 1;
        frame = Math.floor(p.animT / (60 / ANIM_FPS / 2)) % FRAMES;
      } else {
        p.animT = 0;
      }
      const sx = frame * CHAR_NATIVE_W;
      const sy = row * CHAR_NATIVE_H;

      // Dash mirage trail ("add a trail of faded mirage of the character
      // behind them when dashing") -- purely client-side: sample WORLD
      // position (p.renderX/renderY, NOT screen-space footX/footY) each
      // frame while actively dashing (the window comes from the server's
      // "player_dash" broadcast, so this works for every dashing player,
      // not just yourself), then draw fading translucent copies of this
      // same live sprite frame at each recent sample's screen position
      // RECOMPUTED against the current camera, oldest/faintest first so the
      // real current sprite paints over them last. World coords matter here
      // specifically because the camera is centered exactly on the local
      // player every frame (see camX/camY above) -- footX/footY for "me" is
      // therefore constant regardless of movement, which would collapse
      // every trail sample onto the same spot; re-deriving screen position
      // from world coords against the current camera is what makes the
      // trail actually fall BEHIND as the camera tracks you forward.
      if (p.dashActiveUntil && now < p.dashActiveUntil) {
        p.dashTrail = p.dashTrail || [];
        p.dashTrail.push({ wx: p.renderX, wy: p.renderY, t: now });
      }
      if (p.dashTrail && p.dashTrail.length) {
        p.dashTrail = p.dashTrail.filter((s) => now - s.t < DASH_TRAIL_FADE_MS);
        for (const s of p.dashTrail) {
          const alpha = Math.max(0, 1 - (now - s.t) / DASH_TRAIL_FADE_MS) * 0.35;
          if (alpha <= 0.01) continue;
          const sFootX = Math.round(s.wx * effRTile - camX);
          const sFootY = Math.round(s.wy * effRTile - camY + effRTile * 0.32);
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.drawImage(
            img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H,
            Math.round(sFootX - dispW / 2), Math.round(sFootY - dispH), Math.round(dispW), Math.round(dispH)
          );
          ctx.restore();
        }
      }

      if (p.hitFlashUntil && now < p.hitFlashUntil) {
        ctx.save();
        ctx.filter = "brightness(1.8) saturate(0.4)";
        ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H, screenX, screenY, dispW, dispH);
        ctx.restore();
      } else if (p.burning) {
        ctx.save();
        ctx.filter = "brightness(1.3) saturate(1.4) hue-rotate(-15deg)";
        ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H, screenX, screenY, dispW, dispH);
        ctx.restore();
      } else {
        ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H, screenX, screenY, dispW, dispH);
      }
    }

    // Burning: a dragon-death fire hazard is currently cooking this player
    // down to 0 HP -- a small flame lick at their feet makes it obvious why
    // their health is draining even after they've stepped away from the fire.
    if (p.burning) {
      drawFlameShape(footX, footY - effRTile * 0.05, effRTile * 0.55, now);
    }

    drawWeaponSwing(p, footX, footY - dispH * 0.42, now);

    // Health bar just above the head, name tag above that.
    const barW = Math.round(effRTile * 0.7);
    drawHealthBar(footX, screenY - 10, p.hp, p.maxHp, barW);

    const label = p.name + (p.id === myId ? " (you)" : "");
    ctx.font = "bold 12px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const tagY = screenY - 14;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(8,12,20,0.55)";
    ctx.fillRect(footX - w / 2 - 5, tagY - 13, w + 10, 17);
    ctx.fillStyle = p.id === myId ? "#f4d35e" : "#e8eefc";
    ctx.fillText(label, footX, tagY);
  }

  // Purely decorative tavern patrons -- reuses the exact same playable-race
  // charSprites as drawPlayer (just no name tag/health bar/weapon swing,
  // since these are never combatants). The oversized "dancer" is rendered at
  // a much larger scale with a continuous client-local side-to-side sway +
  // vertical bob layered on top of its (server-authoritative but stationary)
  // position; the server only drives its walk-cycle animation by flipping
  // `dir` on a timer (see server/tavernNpcs.js) -- the sway/bob/scale here
  // are purely a client rendering flourish, not part of its real position.
  // "The patrons need to be jumping for joy every once in a while, it's a
  // big party" -- a purely client-side periodic hop for the regular
  // (non-Dante) wandering patrons, only while the party is active, mirroring
  // how Dante's own dance sway/bob/arm-wave is layered on top of his
  // server-authoritative position rather than server-driven. Each patron's
  // hop timing is independently randomized (armed with a random initial
  // delay the first time it's seen mid-party, then re-randomized after every
  // hop) so the crowd reads as organically celebrating rather than bouncing
  // in lockstep.
  const PATRON_JUMP_MIN_INTERVAL_MS = 3000;
  const PATRON_JUMP_MAX_INTERVAL_MS = 8000;
  const PATRON_JUMP_DURATION_MS = 420;
  const PATRON_JUMP_HEIGHT_FRAC = 0.3;

  function updatePatronJumpBob(n, now) {
    if (!isTavernPartyActive()) {
      n.jumpStartTime = null;
      return 0;
    }
    if (n.jumpStartTime) {
      const t = (now - n.jumpStartTime) / PATRON_JUMP_DURATION_MS;
      if (t >= 1) {
        n.jumpStartTime = null;
        n.nextJumpAt = now + PATRON_JUMP_MIN_INTERVAL_MS + Math.random() * (PATRON_JUMP_MAX_INTERVAL_MS - PATRON_JUMP_MIN_INTERVAL_MS);
        return 0;
      }
      // A single symmetric up-and-down hop (sine arc peaks mid-jump).
      return -Math.sin(t * Math.PI) * effRTile * PATRON_JUMP_HEIGHT_FRAC;
    }
    if (!n.nextJumpAt) {
      // First frame seen while the party is active -- stagger the initial
      // delay so newly-joined-mid-party patrons don't all hop in sync.
      n.nextJumpAt = now + Math.random() * PATRON_JUMP_MAX_INTERVAL_MS;
    } else if (now >= n.nextJumpAt) {
      n.jumpStartTime = now;
    }
    return 0;
  }

  // Draws one CHAR_NATIVE_W x CHAR_NATIVE_H sprite frame with the two
  // baked-in arm slivers carved out (left column x=[5,7), right column
  // x=[13,15), y=[13,19) to cover both the bob=0 and bob=1 walk-cycle
  // frames -- see draw_race_frame's arm_top/arm_bottom math in
  // tools/gen_assets.py, direction-invariant since arms are drawn
  // identically for every facing row). Used ONLY for Dante while dancing,
  // so his own procedural wave-arm overlay (drawDanteArmWave) is the single
  // pair of arms visible instead of layering on top of the sprite's normal
  // baked-in ones. Draws the rest of the frame (head/torso/legs) in slices
  // around the two gaps rather than compositing a patch, so there's no
  // color-matching guesswork -- the gaps are simply left transparent, which
  // reads fine since the overlay arms cover that screen area anyway.
  const ARM_GAP_X_L = 5, ARM_GAP_X_R = 13, ARM_GAP_W = 2;
  const ARM_GAP_Y = 13, ARM_GAP_H = 6;
  function drawCharSpriteNoArms(img, sx, sy, screenX, screenY, dispW, dispH) {
    const scaleX = dispW / CHAR_NATIVE_W;
    const scaleY = dispH / CHAR_NATIVE_H;
    // Band above the arms (head + shoulders).
    ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, ARM_GAP_Y, screenX, screenY, dispW, ARM_GAP_Y * scaleY);
    // Band below the arms (legs/feet).
    const belowY = ARM_GAP_Y + ARM_GAP_H;
    ctx.drawImage(
      img, sx, sy + belowY, CHAR_NATIVE_W, CHAR_NATIVE_H - belowY,
      screenX, screenY + belowY * scaleY, dispW, (CHAR_NATIVE_H - belowY) * scaleY
    );
    // Arm-height band, minus the two arm columns: left-of-gap, torso
    // between the gaps, right-of-gap.
    const rGapEnd = ARM_GAP_X_R + ARM_GAP_W;
    ctx.drawImage(
      img, sx, sy + ARM_GAP_Y, ARM_GAP_X_L, ARM_GAP_H,
      screenX, screenY + ARM_GAP_Y * scaleY, ARM_GAP_X_L * scaleX, ARM_GAP_H * scaleY
    );
    ctx.drawImage(
      img, sx + ARM_GAP_X_L + ARM_GAP_W, sy + ARM_GAP_Y, ARM_GAP_X_R - (ARM_GAP_X_L + ARM_GAP_W), ARM_GAP_H,
      screenX + (ARM_GAP_X_L + ARM_GAP_W) * scaleX, screenY + ARM_GAP_Y * scaleY,
      (ARM_GAP_X_R - (ARM_GAP_X_L + ARM_GAP_W)) * scaleX, ARM_GAP_H * scaleY
    );
    ctx.drawImage(
      img, sx + rGapEnd, sy + ARM_GAP_Y, CHAR_NATIVE_W - rGapEnd, ARM_GAP_H,
      screenX + rGapEnd * scaleX, screenY + ARM_GAP_Y * scaleY, (CHAR_NATIVE_W - rGapEnd) * scaleX, ARM_GAP_H * scaleY
    );
  }

  function drawTavernNpc(n, camX, camY, now) {
    // Dante ("make Dante bald, no hair on his head") gets his own dedicated
    // bald sprite rather than the shared human_pink one, so a real player
    // who picks human+pink for themselves still has normal hair.
    const img = n.big
      ? (charSprites["human_bald_pink"] || charSprites[`${n.race}_${n.color}`])
      : (charSprites[`${n.race}_${n.color}`] || charSprites["human_blue"]);
    const scale = n.big ? 2.2 : 1;
    const dispW = effRTile * (CHAR_NATIVE_W / TILE) * scale;
    const dispH = effRTile * (CHAR_NATIVE_H / TILE) * scale;

    let swayX = 0, bobY = 0;
    if (n.dancing) {
      swayX = Math.sin(now / 260) * effRTile * 0.5;
      bobY = -Math.abs(Math.sin(now / 180)) * effRTile * 0.18;
    }
    if (!n.big) {
      bobY += updatePatronJumpBob(n, now);
    }

    const footX = Math.round(n.renderX * effRTile - camX + swayX);
    const footY = Math.round(n.renderY * effRTile - camY + effRTile * 0.32 + bobY);
    const screenX = Math.round(footX - dispW / 2);
    const screenY = Math.round(footY - dispH);

    drawGroundShadow(footX, footY - effRTile * 0.06, effRTile * 0.32 * scale, effRTile * 0.13 * scale);

    if (img && img.complete && img.naturalWidth > 0) {
      const row = DIR_ROW[n.dir] ?? 0;
      let frame = 1;
      if (n.moving) {
        n.animT = (n.animT || 0) + 1;
        frame = Math.floor(n.animT / (60 / ANIM_FPS / 2)) % FRAMES;
      } else {
        n.animT = 0;
      }
      const sx = frame * CHAR_NATIVE_W;
      const sy = row * CHAR_NATIVE_H;
      if (n.big && n.dancing) {
        // "Dante's arms are still weird at the end, his arms are at his
        // side but also a 2nd pair of arms are waving" -- his baked-in
        // walk-cycle sprite (drawn here) has its own pair of arms flanking
        // the torso, which naturally swing as part of the normal gait while
        // he "walks" left/right to fake the dance step, WHILE
        // drawDanteArmWave (below) simultaneously overlays a second,
        // independent pair of procedural waving arms cropped from the same
        // sprite. That's the two visible pairs of arms the report
        // describes. Fix: carve the baked-in arm slivers (see
        // DANTE_ARM_SRC_* below -- direction-invariant, so this applies no
        // matter which way he's currently facing) out of the base sprite
        // draw while dancing, so only the single procedural overlay pair is
        // ever visible.
        drawCharSpriteNoArms(img, sx, sy, screenX, screenY, dispW, dispH);
      } else {
        ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H, screenX, screenY, dispW, dispH);
      }
    }

    // Dante-only extras: nametag, contextual speech bubble, and (once
    // dancing) a procedural arm-wave layered on top of the walk-cycle
    // sprite -- everything else in the tavern crowd is purely decorative
    // and gets none of this.
    if (n.big) {
      ctx.font = "bold 12px -apple-system, sans-serif";
      ctx.textAlign = "center";
      const label = "Dante";
      const tagY = screenY - 6;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(8,12,20,0.55)";
      ctx.fillRect(footX - tw / 2 - 5, tagY - 13, tw + 10, 17);
      ctx.fillStyle = "#ffe9a8";
      ctx.fillText(label, footX, tagY);

      if (n.dancing) {
        drawDanteArmWave(footX, screenY, dispW, dispH, now, img);
        if (n.dancingSince && now - n.dancingSince < DANTE_OUTRO_MS) {
          drawSpeechBubble(footX, screenY - 20, DANTE_OUTRO_TEXT);
        }
      } else {
        drawSpeechBubble(footX, screenY - 20, DANTE_INTRO_TEXT);
      }
    }
  }

  const DANTE_INTRO_TEXT = "We're out of booze! Go steal some from the Goblin King and save Dirtywood!";
  const DANTE_OUTRO_TEXT = "You got the booze and saved Dirtywood!!";
  const DANTE_OUTRO_MS = 12000;
  const DANTE_ARM_FLIP_MS = 260; // fast, energetic wave -- distinct from the slower DANCE_FLIP_MS body sway
  // Dante's actual sprite sheet (race_human_pink.png, via draw_race_frame in
  // tools/gen_assets.py) draws each bare arm as a tiny 2x5 native-px skin-
  // colored sliver flanking the torso -- see RACE_PROFILES.human
  // (torso_w=3, torso_h=7, leg_h=7) and CHAR_NATIVE_H=26: arm_top =
  // torso_top+1 = 13, arm_bottom = torso_bottom-1 = 17, at frame=1 (the
  // bob=0 "center" walk-cycle frame, to avoid the stride bob's vertical
  // jitter). Cropped straight from the loaded sprite image and stretched
  // along the swing direction below -- "make sure you're using the
  // character model arms" instead of a hand-drawn vector line that doesn't
  // match the sprite's own pixel-art arm color/shape.
  const DANTE_ARM_SRC_X_L = 5, DANTE_ARM_SRC_X_R = 13;
  const DANTE_ARM_SRC_Y = DIR_ROW.down * CHAR_NATIVE_H + 13;
  const DANTE_ARM_SRC_W = 2, DANTE_ARM_SRC_H = 5;
  const DANTE_ARM_FRAME_X = 1 * CHAR_NATIVE_W; // frame 1 = the center/bob=0 walk-cycle frame

  // Two short arms swinging up over Dante's head while he dances -- his
  // actual sprite/animation frames don't have a dedicated wave pose, so the
  // SWING (shoulder anchor, length, angle) is still a client rendering
  // flourish layered on top (same spirit as the sway/bob already applied to
  // his position above), but each arm is drawn using a real crop of his own
  // sprite (see DANTE_ARM_SRC_* above) stretched/rotated to point along the
  // swing, rather than a generic stroked line -- so it reads as an actual
  // limb of his model instead of a disjointed floating stick.
  function drawDanteArmWave(footX, screenY, dispW, dispH, now, img) {
    const shoulderY = screenY + dispH * 0.28;
    const armLen = dispH * 0.32;
    const spread = dispW * 0.32;
    const armThick = Math.max(3, dispW * 0.09);
    const phase = now / DANTE_ARM_FLIP_MS;
    const hasSprite = img && img.complete && img.naturalWidth > 0;
    ctx.save();
    for (const side of [-1, 1]) {
      const wave = Math.sin(phase + (side === -1 ? 0 : Math.PI * 0.6));
      const shoulderX = footX + side * spread;
      const handX = shoulderX + side * armLen * 0.35;
      const handY = shoulderY - armLen * (0.55 + 0.45 * wave);
      if (hasSprite) {
        const dx = handX - shoulderX, dy = handY - shoulderY;
        const len = Math.max(2, Math.hypot(dx, dy));
        const angle = Math.atan2(dy, dx);
        const srcX = side === -1 ? DANTE_ARM_SRC_X_L : DANTE_ARM_SRC_X_R;
        ctx.save();
        ctx.translate(shoulderX, shoulderY);
        ctx.rotate(angle - Math.PI / 2); // local +y (the crop's shoulder->hand axis) now points toward the hand
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          img, DANTE_ARM_FRAME_X + srcX, DANTE_ARM_SRC_Y, DANTE_ARM_SRC_W, DANTE_ARM_SRC_H,
          Math.round(-armThick / 2), 0, Math.round(armThick), Math.round(len)
        );
        ctx.restore();
      } else {
        // Sprite not loaded yet -- a plain stroke so SOME arm still renders.
        ctx.strokeStyle = "#f2c99a";
        ctx.lineWidth = armThick;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(shoulderX, shoulderY);
        ctx.lineTo(handX, handY);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Dispatches to the melee arc-swing or the bow draw-pulse depending on
  // which weapon this entity currently has active (defaults to sword for
  // remote entities we haven't received a weapon field for yet).
  function drawWeaponSwing(entity, centerX, centerY, now) {
    if (entity.activeWeapon === "bow" && entity.hasBow) {
      drawBowPulse(entity, centerX, centerY, now);
    } else {
      drawSwordSwing(entity, centerX, centerY, now);
    }
  }

  // A quick nock-and-release pulse (brief outward scale bump) rather than an
  // arc swing -- the bow itself doesn't swing, the arrow flying out (see
  // drawArrowAt) is what actually reads as "shooting".
  function drawBowPulse(entity, centerX, centerY, now) {
    if (!bowImg.complete || bowImg.naturalWidth === 0) return;
    const t = now - entity.swingStart;
    if (t < 0 || t > SWING_MS) return;
    const progress = t / SWING_MS; // 0..1
    const pulse = Math.sin(progress * Math.PI); // 0 -> 1 -> 0

    const scale = (effRTile / TILE) * BOW_SCALE * (1 + pulse * 0.25);
    const dispW = BOW_NATIVE_W * scale;
    const dispH = BOW_NATIVE_H * scale;
    const pivotOffsetX = BOW_PIVOT_X * scale;
    const pivotOffsetY = BOW_PIVOT_Y * scale;

    const handForward = effRTile * 0.14;
    const handSide = effRTile * 0.16;
    const angle = entity.swingAngle;
    const sideAngle = angle + Math.PI / 2;
    const pivotX = centerX + Math.cos(angle) * handForward + Math.cos(sideAngle) * handSide;
    const pivotY = centerY + Math.sin(angle) * handForward + Math.sin(sideAngle) * handSide;

    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle + Math.PI / 2);
    const glowR = dispW * 0.7;
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
    grad.addColorStop(0, `rgba(255, 210, 90, ${0.5 + pulse * 0.3})`);
    grad.addColorStop(1, "rgba(255, 210, 90, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.drawImage(bowImg, -pivotOffsetX, -pivotOffsetY, dispW, dispH);
    ctx.restore();
  }

  function drawSwordSwing(entity, centerX, centerY, now) {
    const img = entity.hasFlamingSword ? flamingSwordImg : swordImg;
    if (!img.complete || img.naturalWidth === 0) return;
    const t = now - entity.swingStart;
    if (t < 0 || t > SWING_MS) return;
    const progress = t / SWING_MS; // 0..1
    const currentAngle = entity.swingAngle - SWING_ARC_RAD / 2 + SWING_ARC_RAD * progress;

    const scale = effRTile / TILE;
    const dispW = SWORD_NATIVE_W * scale * SWORD_SCALE;
    const dispH = SWORD_NATIVE_H * scale * SWORD_SCALE;
    const pivotOffsetX = SWORD_PIVOT_X * scale * SWORD_SCALE;
    const pivotOffsetY = SWORD_PIVOT_Y * scale * SWORD_SCALE;

    // Anchor the swing at roughly the hand, not the character's center:
    // offset a bit forward along the swing direction and out to the side,
    // where an extended sword arm would actually be.
    const handForward = effRTile * 0.14;
    const handSide = effRTile * 0.16;
    const sideAngle = entity.swingAngle + Math.PI / 2;
    const pivotX = centerX + Math.cos(entity.swingAngle) * handForward + Math.cos(sideAngle) * handSide;
    const pivotY = centerY + Math.sin(entity.swingAngle) * handForward + Math.sin(sideAngle) * handSide;

    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(currentAngle);
    if (entity.hasFlamingSword) {
      // Warm flicker glow centered on the blade while it swings.
      const glowCx = -pivotOffsetX + dispW / 2;
      const glowCy = -pivotOffsetY + dispH / 2;
      const glowR = dispW * 0.6;
      const glowAlpha = 0.55 + Math.sin(now / 80) * 0.15;
      const grad = ctx.createRadialGradient(glowCx, glowCy, 0, glowCx, glowCy, glowR);
      grad.addColorStop(0, `rgba(255, 150, 40, ${glowAlpha})`);
      grad.addColorStop(1, "rgba(255, 150, 40, 0)");
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(glowCx, glowCy, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.drawImage(img, -pivotOffsetX, -pivotOffsetY, dispW, dispH);
    ctx.restore();
  }

  // Fire goblins guarding the cave treasure: rendered with a dedicated
  // "goblin_fire" sprite (red armor AND a fiery red skin tone -- see
  // RACE_PROFILES["goblin_fire"] in tools/gen_assets.py) using the same
  // 4-direction/3-frame convention as players, rather than the flat
  // rat/bat/spider monster sprite sheet. Deliberately its own sprite sheet
  // rather than reusing charSprites["goblin_red"] (a real player-selectable
  // goblin+red combo): the regular goblin's big green head/skin dominates
  // the tiny sprite regardless of armor tint, so a plain armor recolor
  // barely reads as "red" -- the fire goblins need their skin recolored
  // too, which a shared player-customization sprite can't do without also
  // changing what a player who picks goblin+red looks like.
  function drawFireGoblinMonster(m, camX, camY, now) {
    const img = charSprites["goblin_fire"];
    const dispW = effRTile * (CHAR_NATIVE_W / TILE);
    const dispH = effRTile * (CHAR_NATIVE_H / TILE);
    const footX = Math.round(m.renderX * effRTile - camX);
    const footY = Math.round(m.renderY * effRTile - camY + effRTile * 0.28);
    const screenX = Math.round(footX - dispW / 2);
    const screenY = Math.round(footY - dispH);

    drawGroundShadow(footX, footY - effRTile * 0.05, effRTile * 0.3, effRTile * 0.12);

    if (img && img.complete && img.naturalWidth > 0) {
      const row = DIR_ROW[m.dir] ?? 0;
      let frame = 1;
      if (m.moving) {
        m.animT = (m.animT || 0) + 1;
        frame = Math.floor(m.animT / (60 / ANIM_FPS / 2)) % FRAMES;
      } else {
        m.animT = 0;
      }
      const sx = frame * CHAR_NATIVE_W;
      const sy = row * CHAR_NATIVE_H;
      const flashing = m.attackFlashUntil && now < m.attackFlashUntil;
      ctx.save();
      if (flashing) ctx.filter = "brightness(1.6) saturate(1.6)";
      ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H, screenX, screenY, dispW, dispH);
      ctx.restore();
    }

    const barW = Math.round(effRTile * 0.6);
    drawHealthBar(footX, screenY - 8, m.hp, m.maxHp, barW);
    ctx.font = "bold 11px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ff6a3a";
    ctx.fillText("Fire Goblin", footX, screenY - 14);
  }

  function drawMonster(m, camX, camY, now) {
    if (m.type === "dragon") { drawDragon(m, camX, camY, now); return; }
    if (m.type === "fire_goblin") { drawFireGoblinMonster(m, camX, camY, now); return; }
    const img = monsterSprites[m.type];
    const scale = effRTile / TILE;
    const dispW = MONSTER_CW * scale;
    const dispH = MONSTER_CH * scale;
    const footX = Math.round(m.renderX * effRTile - camX);
    const footY = Math.round(m.renderY * effRTile - camY + effRTile * 0.18);
    const screenX = Math.round(footX - dispW / 2);
    const screenY = Math.round(footY - dispH);

    drawGroundShadow(footX, footY - effRTile * 0.04, effRTile * 0.26, effRTile * 0.1);

    if (img && img.complete && img.naturalWidth > 0) {
      const row = DIR_ROW[m.dir] ?? 0;
      let frame = 0;
      if (m.moving) {
        m.animT = (m.animT || 0) + 1;
        frame = Math.floor(m.animT / (60 / ANIM_FPS / 2)) % MONSTER_FRAMES;
      } else {
        m.animT = 0;
      }
      const sx = frame * MONSTER_CW;
      const sy = row * MONSTER_CH;
      const flashing = m.attackFlashUntil && now < m.attackFlashUntil;
      if (flashing) {
        ctx.save();
        ctx.filter = "brightness(1.6) saturate(1.6)";
        ctx.drawImage(img, sx, sy, MONSTER_CW, MONSTER_CH, screenX, screenY, dispW, dispH);
        ctx.restore();
      } else {
        ctx.drawImage(img, sx, sy, MONSTER_CW, MONSTER_CH, screenX, screenY, dispW, dispH);
      }
    }

    const barW = Math.round(effRTile * 0.55);
    drawHealthBar(footX, screenY - 8, m.hp, m.maxHp, barW);
  }

  // The dragon boss: much larger than the small monsters, and switches
  // between 3 separate spritesheets (walk / claw-swipe / fire-breath)
  // depending on what it's currently doing, rather than one sheet with a
  // "hit flash" filter like the small monsters use.
  function drawDragon(m, camX, camY, now) {
    const scale = effRTile / TILE;
    const dispW = DRAGON_CW * scale;
    const dispH = DRAGON_CH * scale;
    const footX = Math.round(m.renderX * effRTile - camX);
    const footY = Math.round(m.renderY * effRTile - camY + effRTile * 0.55);
    const screenX = Math.round(footX - dispW / 2);
    const screenY = Math.round(footY - dispH);

    drawGroundShadow(footX, footY - effRTile * 0.1, effRTile * 1.5, effRTile * 0.55);

    let img = dragonWalkImg;
    let frame = 0;
    const inAttackAnim = m.attackKind && now - (m.attackAnimStart || 0) < DRAGON_ATTACK_ANIM_MS;
    if (inAttackAnim) {
      img = m.attackKind === "fire" ? dragonFireImg : dragonClawImg;
      const t = (now - m.attackAnimStart) / DRAGON_ATTACK_ANIM_MS;
      frame = t < 0.4 ? 0 : 1;
    } else if (m.moving) {
      m.animT = (m.animT || 0) + 1;
      frame = Math.floor(m.animT / (60 / ANIM_FPS / 2)) % DRAGON_FRAMES;
    } else {
      m.animT = 0;
    }

    if (img && img.complete && img.naturalWidth > 0) {
      const row = DIR_ROW[m.dir] ?? 0;
      const sx = frame * DRAGON_CW;
      const sy = row * DRAGON_CH;
      const flashing = m.attackFlashUntil && now < m.attackFlashUntil && !inAttackAnim;
      if (flashing) {
        ctx.save();
        ctx.filter = "brightness(1.5) saturate(1.4)";
        ctx.drawImage(img, sx, sy, DRAGON_CW, DRAGON_CH, screenX, screenY, dispW, dispH);
        ctx.restore();
      } else {
        ctx.drawImage(img, sx, sy, DRAGON_CW, DRAGON_CH, screenX, screenY, dispW, dispH);
      }
    }

    const barW = Math.round(effRTile * 1.9);
    drawHealthBar(footX, screenY - 14, m.hp, m.maxHp, barW, true);

    ctx.font = "bold 13px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const label = "Small Dragon";
    const tagY = screenY - 18;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(60,10,10,0.6)";
    ctx.fillRect(footX - w / 2 - 6, tagY - 14, w + 12, 18);
    ctx.fillStyle = "#ffb347";
    ctx.fillText(label, footX, tagY);
  }

  function drawDeathFx(fx, camX, camY, now) {
    const t = now - fx.startTime;
    const progress = Math.max(0, Math.min(1, t / DEATH_FX_MS));
    const scale = effRTile / TILE;

    const footX = Math.round(fx.x * effRTile - camX);
    const footY = Math.round(fx.y * effRTile - camY + effRTile * 0.18);

    // The flipped, shrinking creature corpse for the first ~half of the effect.
    if (progress < 0.7) {
      const img = monsterSprites[fx.type];
      if (img && img.complete && img.naturalWidth > 0) {
        const row = DIR_ROW[fx.dir] ?? 0;
        const dispW = MONSTER_CW * scale;
        const dispH = MONSTER_CH * scale;
        const shrink = 1 - progress * 0.5;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - progress / 0.7);
        ctx.translate(footX, footY - dispH / 2);
        ctx.rotate(Math.PI); // flipped upside down
        ctx.scale(shrink, shrink);
        ctx.drawImage(img, 0, row * MONSTER_CH, MONSTER_CW, MONSTER_CH, -dispW / 2, -dispH / 2, dispW, dispH);
        ctx.restore();
      }
    }

    // Smoke puff cloud, cycling through its 4 baked frames.
    if (smokeImg.complete && smokeImg.naturalWidth > 0) {
      const frame = Math.min(SMOKE_FRAMES - 1, Math.floor(progress * SMOKE_FRAMES));
      const dispS = SMOKE_SIZE * scale * 2.3;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - progress * 0.85);
      ctx.drawImage(smokeImg, frame * SMOKE_SIZE, 0, SMOKE_SIZE, SMOKE_SIZE,
        footX - dispS / 2, footY - dispS * 0.75, dispS, dispS);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------
  // Ambient wildlife: occasional birds fly across the visible sky. Purely
  // decorative/client-local -- not synced between players, each person
  // just sees their own occasional bird.
  // ---------------------------------------------------------------------
  const birds = [];
  let nextBirdAt = performance.now() + 4000 + Math.random() * 8000;

  function maybeSpawnBird(now, camX, camY) {
    if (now < nextBirdAt) return;
    nextBirdAt = now + 18000 + Math.random() * 20000; // next one in ~18-38s
    const goingRight = Math.random() < 0.5;
    const viewTopTile = camY / effRTile;
    const viewLeftTile = camX / effRTile;
    const viewWTiles = canvas.width / effRTile;
    const viewHTiles = canvas.height / effRTile;
    const y = viewTopTile + viewHTiles * (0.1 + Math.random() * 0.35); // upper sky band
    birds.push({
      x: goingRight ? viewLeftTile - 3 : viewLeftTile + viewWTiles + 3,
      y,
      vx: (goingRight ? 1 : -1) * (2.2 + Math.random() * 1.2),
      bornAt: now,
      wobblePhase: Math.random() * Math.PI * 2,
    });
  }

  function updateBirds(now, camX, camY) {
    maybeSpawnBird(now, camX, camY);
    const viewLeftTile = camX / effRTile - 5;
    const viewRightTile = (camX + canvas.width) / effRTile + 5;
    for (let i = birds.length - 1; i >= 0; i--) {
      const b = birds[i];
      const dt = Math.min(0.1, (now - (b.lastT || now)) / 1000);
      b.lastT = now;
      b.x += b.vx * dt;
      if (b.x < viewLeftTile || b.x > viewRightTile) birds.splice(i, 1);
    }
  }

  function drawBirds(camX, camY) {
    if (!birdImg.complete || birdImg.naturalWidth === 0) return;
    const dispW = effRTile * (BIRD_NATIVE_W / TILE);
    const dispH = effRTile * (BIRD_NATIVE_H / TILE);
    for (const b of birds) {
      const flapFrame = Math.floor(performance.now() / 160) % 2;
      const bob = Math.sin(performance.now() / 260 + b.wobblePhase) * effRTile * 0.15;
      const screenX = Math.round(b.x * effRTile - camX - dispW / 2);
      const screenY = Math.round(b.y * effRTile - camY - dispH / 2 + bob);
      ctx.save();
      if (b.vx < 0) {
        // flip horizontally when flying left
        ctx.translate(screenX + dispW / 2, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(birdImg, flapFrame * BIRD_NATIVE_W, 0, BIRD_NATIVE_W, BIRD_NATIVE_H, -dispW / 2, screenY, dispW, dispH);
      } else {
        ctx.drawImage(birdImg, flapFrame * BIRD_NATIVE_W, 0, BIRD_NATIVE_W, BIRD_NATIVE_H, screenX, screenY, dispW, dispH);
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------
  // Cavern depths (side-scroller) rendering -- entirely separate draw path
  // from the top-down tile-grid renderer above: a horizontal side-scroll
  // camera (fixed vertical framing, since the whole level is only ever 3
  // tiers tall) over a tiled dark-cave background, one-way platform ledges,
  // a solid ground floor, and profile-view player/goblin/troll sprites.
  // ---------------------------------------------------------------------
  // Purely cosmetic background scatter (wall torches / ceiling stalactites /
  // glowing crystal clusters) -- see cavern.js's generateCavernLevel for the
  // deterministic layout. No collision, drawn once per item, behind
  // everything else (platforms/players/monsters) since it's wall/ceiling
  // dressing, not level geometry.
  function drawCavernDecor(camX, camY) {
    if (!cavernMap || !cavernMap.decor) return;
    const scale = effRTile / TILE;
    for (const d of cavernMap.decor) {
      const dx = d.x * effRTile - camX;
      if (dx < -80 || dx > canvas.width + 80) continue;
      const dy = d.y * effRTile - camY;
      if (d.type === "torch") {
        drawGlowAt(d.x, d.y - 0.6, camX, camY, 2.2, 0.35);
        if (cavernTorchImg.complete && cavernTorchImg.naturalWidth > 0) {
          const w = 14 * scale, h = 26 * scale;
          ctx.drawImage(cavernTorchImg, 0, 0, 14, 26, Math.round(dx - w / 2), Math.round(dy - h), Math.round(w), Math.round(h));
        }
      } else if (d.type === "stalactite") {
        if (cavernStalactiteImg.complete && cavernStalactiteImg.naturalWidth > 0) {
          const w = 16 * scale, h = 30 * scale;
          ctx.drawImage(cavernStalactiteImg, 0, 0, 16, 30, Math.round(dx - w / 2), Math.round(dy), Math.round(w), Math.round(h));
        }
      } else if (d.type === "crystal") {
        const gr = effRTile * 0.8;
        const grad = ctx.createRadialGradient(dx, dy, 0, dx, dy, gr);
        grad.addColorStop(0, "rgba(150, 120, 255, 0.3)");
        grad.addColorStop(1, "rgba(150, 120, 255, 0)");
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(dx, dy, gr, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (cavernCrystalImg.complete && cavernCrystalImg.naturalWidth > 0) {
          const w = 20 * scale, h = 22 * scale;
          ctx.drawImage(cavernCrystalImg, 0, 0, 20, 22, Math.round(dx - w / 2), Math.round(dy - h), Math.round(w), Math.round(h));
        }
      }
    }
  }

  function drawCavernPlatformSeg(p, camX, camY) {
    const y = Math.round(p.y * effRTile - camY);
    if (y + effRTile < 0 || y > canvas.height) return;
    const h = effRTile * (CAVERN_PLATFORM_NATIVE_H / CAVERN_PLATFORM_NATIVE_W);
    const ready = cavernPlatformImg.complete && cavernPlatformImg.naturalWidth > 0;
    const xStart = Math.floor(p.x0);
    const xEnd = Math.ceil(p.x1);
    for (let tx = xStart; tx < xEnd; tx++) {
      const segX0 = Math.max(p.x0, tx);
      const segX1 = Math.min(p.x1, tx + 1);
      if (segX1 <= segX0) continue;
      const dx = Math.round(segX0 * effRTile - camX);
      const dw = Math.round((segX1 - segX0) * effRTile) + 1;
      if (dx + dw < 0 || dx > canvas.width) continue;
      if (ready) {
        ctx.drawImage(cavernPlatformImg, 0, 0, CAVERN_PLATFORM_NATIVE_W, CAVERN_PLATFORM_NATIVE_H, dx, y, dw, h);
      } else {
        ctx.fillStyle = "#5a5460";
        ctx.fillRect(dx, y, dw, h);
      }
    }
  }

  function isCavernTileOverPit(tx) {
    const pits = cavernMap.pits;
    if (!pits) return false;
    // Center of this ground tile -- matches the server's own isOverPit
    // check (server/cavern.js), which tests the player's center x.
    const cx = tx + 0.5;
    return pits.some((p) => cx > p.x0 && cx < p.x1);
  }

  function drawCavernGroundStrip(camX, camY) {
    const y = Math.round(cavernMap.groundY * effRTile - camY);
    ctx.fillStyle = "#181220";
    ctx.fillRect(0, y, canvas.width, Math.max(0, canvas.height - y));
    const h = effRTile * (CAVERN_PLATFORM_NATIVE_H / CAVERN_PLATFORM_NATIVE_W);
    const ready = cavernPlatformImg.complete && cavernPlatformImg.naturalWidth > 0;
    const startTx = Math.max(0, Math.floor(camX / effRTile) - 1);
    const endTx = Math.min(cavernMap.width, Math.ceil((camX + canvas.width) / effRTile) + 1);
    for (let tx = startTx; tx < endTx; tx++) {
      const dx = Math.round(tx * effRTile - camX);
      if (isCavernTileOverPit(tx)) continue; // no ground strip here -- see drawCavernPits for the hole+spikes
      if (ready) {
        ctx.drawImage(cavernPlatformImg, 0, 0, CAVERN_PLATFORM_NATIVE_W, CAVERN_PLATFORM_NATIVE_H, dx, y, effRTile + 1, h);
      }
    }
  }

  // "Add a bunch of pits with spikes at the bottom that will kill the
  // player if he falls in" -- a dark hole punched into the ground strip
  // (drawCavernGroundStrip skips the solid-floor texture over these same
  // x-ranges) with a row of jagged metal spikes glinting at the bottom, at
  // roughly the depth the server actually kills the player (PIT_KILL_DEPTH
  // tiles below the ground line -- see server/cavern.js's isOverPit +
  // index.js's applyCavernInput).
  const CAVERN_PIT_KILL_DEPTH = 4; // keep in sync with server/cavern.js's PIT_KILL_DEPTH
  function drawCavernPits(camX, camY) {
    if (!cavernMap.pits || !cavernMap.pits.length) return;
    const groundYpx = cavernMap.groundY * effRTile - camY;
    const spikeYpx = (cavernMap.groundY + CAVERN_PIT_KILL_DEPTH) * effRTile - camY;
    for (const p of cavernMap.pits) {
      const dx0 = Math.round(p.x0 * effRTile - camX);
      const dx1 = Math.round(p.x1 * effRTile - camX);
      if (dx1 < 0 || dx0 > canvas.width) continue;
      const w = dx1 - dx0;

      // Hole interior: dark gradient fading to black with depth, distinct
      // from the flat "#181220" backdrop so it visibly reads as an opening.
      const grad = ctx.createLinearGradient(0, groundYpx, 0, spikeYpx + effRTile * 0.6);
      grad.addColorStop(0, "#050308");
      grad.addColorStop(1, "#000000");
      ctx.fillStyle = grad;
      ctx.fillRect(dx0, Math.round(groundYpx), w, Math.round(spikeYpx + effRTile * 0.6 - groundYpx));

      // Lip shading so the pit's edge reads as a real gap in the floor
      // rather than just a color change.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(dx0, Math.round(groundYpx), Math.max(2, effRTile * 0.08), Math.round(effRTile * 0.5));
      ctx.fillRect(dx1 - Math.max(2, effRTile * 0.08), Math.round(groundYpx), Math.max(2, effRTile * 0.08), Math.round(effRTile * 0.5));

      // Spikes: a row of jagged gray-silver triangles right at the kill
      // depth, close enough together to read as "don't fall here."
      const spikeW = effRTile * 0.45;
      const spikeH = effRTile * 0.55;
      let sx = dx0 + spikeW * 0.3;
      let i = 0;
      while (sx < dx1 - spikeW * 0.3) {
        const jitter = ((i * 37) % 5) - 2; // small deterministic height variation, no per-frame flicker
        const baseY = spikeYpx + effRTile * 0.35;
        ctx.beginPath();
        ctx.moveTo(sx, baseY);
        ctx.lineTo(sx + spikeW / 2, baseY - spikeH - jitter);
        ctx.lineTo(sx + spikeW, baseY);
        ctx.closePath();
        const spikeGrad = ctx.createLinearGradient(sx, baseY - spikeH, sx, baseY);
        spikeGrad.addColorStop(0, "#e8e8ee");
        spikeGrad.addColorStop(1, "#6a6a76");
        ctx.fillStyle = spikeGrad;
        ctx.fill();
        ctx.strokeStyle = "#2a2a30";
        ctx.lineWidth = 1;
        ctx.stroke();
        sx += spikeW * 0.85;
        i++;
      }
    }
  }

  // "Add a ceiling in the side scroller area, about 10 tiles high" -- a dark
  // rock band from the top of the world down to cavernMap.ceilingY, with a
  // jagged stalactite silhouette along its bottom edge. Deterministic
  // per-tile jitter (same "pure function of stable inputs" convention as the
  // pit spikes' height variation), not per-frame randomized.
  function drawCavernCeiling(camX, camY) {
    if (cavernMap.ceilingY === undefined) return;
    const ceilingYpx = Math.round(cavernMap.ceilingY * effRTile - camY);
    if (ceilingYpx > canvas.height || ceilingYpx < -effRTile) return;
    ctx.fillStyle = "#120c18";
    ctx.fillRect(0, 0, canvas.width, Math.max(0, ceilingYpx));
    const startTx = Math.max(0, Math.floor(camX / effRTile) - 1);
    const endTx = Math.min(cavernMap.width, Math.ceil((camX + canvas.width) / effRTile) + 1);
    ctx.fillStyle = "#1c1422";
    for (let tx = startTx; tx < endTx; tx++) {
      const dx = Math.round(tx * effRTile - camX);
      const jitter = (tx * 53) % 7;
      const toothH = effRTile * (0.3 + jitter * 0.04);
      ctx.beginPath();
      ctx.moveTo(dx, ceilingYpx);
      ctx.lineTo(dx + effRTile * 0.5, ceilingYpx + toothH);
      ctx.lineTo(dx + effRTile, ceilingYpx);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Ceiling spikes -- "random spikes that drop down in a straight line to
  // hit the player, if it hits them they die instantly." While telegraphing
  // (see server/index.js's SPIKE_TELEGRAPH_MS), just a pulsing warning
  // shadow on the ground below where it's about to fall, giving the player
  // a beat to react; once it starts falling, a downward-pointing spike (same
  // palette as the ground pit spikes for visual consistency) tracks straight
  // down from the ceiling to the ground.
  function drawCavernFallingSpike(sp, camX, camY, now) {
    const dx = Math.round(sp.x * effRTile - camX);
    if (dx < -effRTile || dx > canvas.width + effRTile) return;
    if (sp.telegraphing) {
      const groundYpx = Math.round(cavernMap.groundY * effRTile - camY);
      const pulse = 0.35 + 0.3 * Math.sin(now / 60);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.fillStyle = "#ff3020";
      ctx.beginPath();
      ctx.ellipse(dx, groundYpx, effRTile * 0.32, effRTile * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    const spikeYpx = Math.round(sp.y * effRTile - camY);
    const w = effRTile * 0.5, h = effRTile * 0.9;
    ctx.beginPath();
    ctx.moveTo(dx - w / 2, spikeYpx - h);
    ctx.lineTo(dx, spikeYpx);
    ctx.lineTo(dx + w / 2, spikeYpx - h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(dx, spikeYpx - h, dx, spikeYpx);
    grad.addColorStop(0, "#6a6a76");
    grad.addColorStop(1, "#e8e8ee");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "#2a2a30";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Brief dust puff where a falling spike hits a player or the ground.
  const SPIKE_IMPACT_FX_MS = 300;
  function drawCavernSpikeImpactFx(fx, camX, camY, now) {
    const frac = (now - fx.startTime) / SPIKE_IMPACT_FX_MS;
    const dx = Math.round(fx.x * effRTile - camX);
    const dy = Math.round(fx.y * effRTile - camY);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - frac);
    ctx.fillStyle = "#9a8f8f";
    ctx.beginPath();
    ctx.ellipse(dx, dy, effRTile * (0.15 + frac * 0.35), effRTile * (0.08 + frac * 0.12), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCavernDoorMarker(camX, camY) {
    if (!cavernDoorImg.complete || cavernDoorImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const w = CAVERN_DOOR_NATIVE_W * scale;
    const h = CAVERN_DOOR_NATIVE_H * scale;
    const footX = Math.round((cavernMap.exitZoneX + 0.5) * effRTile - camX);
    const footY = Math.round(cavernMap.groundY * effRTile - camY);
    ctx.drawImage(
      cavernDoorImg, 0, 0, CAVERN_DOOR_NATIVE_W, CAVERN_DOOR_NATIVE_H,
      Math.round(footX - w / 2), Math.round(footY - h), Math.round(w), Math.round(h)
    );
  }

  // The door at the far end of the boss arena -- present the whole time (the
  // giant boss's death "opens" it, per the request), but dimmed/locked-looking
  // until cavernDoorOpen flips true, then given a warm glow so it reads as
  // newly unsealed.
  function drawCavernNextDoorMarker(camX, camY) {
    if (!cavernDoorImg.complete || cavernDoorImg.naturalWidth === 0) return;
    if (!cavernMap || cavernMap.nextDoorX === undefined) return;
    const scale = effRTile / TILE;
    const w = CAVERN_DOOR_NATIVE_W * scale * 1.4; // a little larger -- this is the "next level" door
    const h = CAVERN_DOOR_NATIVE_H * scale * 1.4;
    const footX = Math.round((cavernMap.nextDoorX + 0.5) * effRTile - camX);
    const footY = Math.round(cavernMap.groundY * effRTile - camY);
    if (footX < -w || footX > canvas.width + w) return;

    if (cavernDoorOpen) {
      ctx.save();
      ctx.globalAlpha = 0.3 + 0.15 * Math.sin(performance.now() / 300);
      ctx.fillStyle = "#ffe27a";
      ctx.beginPath();
      ctx.ellipse(footX, footY - h / 2, w * 0.85, h * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    if (!cavernDoorOpen) ctx.filter = "brightness(0.4) saturate(0.4)";
    ctx.drawImage(
      cavernDoorImg, 0, 0, CAVERN_DOOR_NATIVE_W, CAVERN_DOOR_NATIVE_H,
      Math.round(footX - w / 2), Math.round(footY - h), Math.round(w), Math.round(h)
    );
    ctx.restore();
  }

  // "The player character models still aren't accurate in the side
  // scroller, use the character models from the first part of the game for
  // the side scroller part" / "only use the original character models for
  // the side scroller, don't use any character models that were generated
  // later" -- draws with the exact same top-down race sprite sheet
  // (charSprites, from race_<race>_<color>.png) as the outside world's
  // drawPlayer, instead of the separately-generated side-view sheet
  // (cavernPlayerImgs, from cavern_player_<race>_<color>.png / draw_cavern_
  // frame in tools/gen_assets.py) previously used here. That separate sheet
  // was generated well after the original top-down one and is exactly what
  // "generated later" refers to -- ditching it also removes a whole class of
  // race/color-mapping bugs, since there's now only ONE set of race images
  // to keep in sync anywhere in the codebase. The sheet's left/right rows
  // are already a side-on pose (this is a top-down game, so walking left/
  // right already reads side-view), which lines up naturally with a
  // side-scroller. drawCavernPlayer is shared between the cavern depths
  // level and the cliff-approach area -- both are side-scrollers, so both
  // benefit here.
  function drawCavernPlayer(p, camX, camY, now) {
    const img = charSprites[`${p.race}_${p.color}`] || charSprites["human_blue"];
    const scale = effRTile / TILE;
    const dispW = CHAR_NATIVE_W * scale;
    const dispH = CHAR_NATIVE_H * scale;
    const footX = Math.round(p.renderX * effRTile - camX);
    const footY = Math.round(p.renderY * effRTile - camY);

    drawGroundShadow(footX, footY - 2, effRTile * 0.3, effRTile * 0.11);

    if (p.dead) {
      ctx.save();
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#cfe0ff";
      ctx.globalAlpha = 0.75;
      ctx.fillText("respawning…", footX, footY - dispH - 6);
      ctx.restore();
      return;
    }

    // Only left/right rows make sense for a side-scroller's horizontal-only
    // movement -- a player can arrive here still facing up/down from the
    // outside world (dir isn't reset on the cavern/cliff area transition),
    // so fall back to whichever horizontal facing they last actually had
    // (defaulting right) rather than showing a front/back-facing pose.
    const facingDir = (p.dir === "left" || p.dir === "right") ? p.dir : (p.lastCavernDir || "right");
    p.lastCavernDir = facingDir;
    const row = DIR_ROW[facingDir];

    const attackT = now - (p.swingStart || -99999);
    const inAttackAnim = attackT >= 0 && attackT < CAVERN_SWING_MS;
    let frame = 1; // idle/neutral frame -- also used mid-air and mid-attack (the
    // swing itself is a separate overlay below, same as the outside world)
    if (p.grounded && p.moving && !inAttackAnim) {
      p.animT = (p.animT || 0) + 1;
      frame = Math.floor(p.animT / (60 / ANIM_FPS / 2)) % FRAMES;
    } else {
      p.animT = 0;
    }
    const sx = frame * CHAR_NATIVE_W;
    const sy = row * CHAR_NATIVE_H;

    // No dedicated crouch pose in this sheet -- a slight vertical squash
    // reads as crouching well enough at this pixel-art scale.
    const drawH = p.crouching && p.grounded ? dispH * 0.78 : dispH;

    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      if (p.hitFlashUntil && now < p.hitFlashUntil) ctx.filter = "brightness(1.8) saturate(0.4)";
      else if (p.burning) ctx.filter = "brightness(1.3) saturate(1.4) hue-rotate(-15deg)";
      ctx.drawImage(
        img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H,
        Math.round(footX - dispW / 2), Math.round(footY - drawH), Math.round(dispW), Math.round(drawH)
      );
      ctx.restore();
    }

    if (p.burning) drawFlameShape(footX, footY - effRTile * 0.05, effRTile * 0.5, now);

    // Weapon swing overlay -- the same drawWeaponSwing used in the outside
    // world. Cavern/cliff melee attacks already send a real atan2 angle
    // toward the target in the server's "player_attack" broadcast (see
    // socket.on("attack") in server/index.js, which emits it unconditionally
    // before branching on area), so this just works instead of needing a
    // baked-in attack pose row.
    drawWeaponSwing(p, footX, footY - drawH * 0.42, now);

    const barW = Math.round(effRTile * 0.7);
    drawHealthBar(footX, footY - dispH - 10, p.hp, p.maxHp, barW);

    const label = p.name + (p.id === myId ? " (you)" : "");
    ctx.font = "bold 12px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const tagY = footY - dispH - 14;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(8,12,20,0.55)";
    ctx.fillRect(footX - w / 2 - 5, tagY - 13, w + 10, 17);
    ctx.fillStyle = p.id === myId ? "#f4d35e" : "#e8eefc";
    ctx.fillText(label, footX, tagY);

    // Stun indicator -- three small orbiting dots above the head, driven by
    // a client-local timer set on receiving cavern_boss_shout (see socket
    // handler) rather than the server's stunnedUntil epoch, since that's a
    // Date.now()-based value not comparable to this client's performance.now().
    if (p.stunVisualUntil && now < p.stunVisualUntil) {
      const scx = footX, scy = tagY - 16;
      const t = now / 160;
      for (let i = 0; i < 3; i++) {
        const ang = t + (i * Math.PI * 2) / 3;
        const ox = Math.cos(ang) * 9;
        const oy = Math.sin(ang) * 3.5;
        ctx.beginPath();
        ctx.fillStyle = "#ffe066";
        ctx.arc(scx + ox, scy + oy, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // "When you first appear on the cliff edge make the player character
    // say..." -- a bounded-window speech bubble stamped client-side the
    // moment the local player's area transitions to "cliff" (see
    // addOrUpdatePlayer's areaChanged handling). drawCavernPlayer is shared
    // between the cavern and the cliff, but this field is only ever set on
    // a cliff arrival, so it naturally never fires in the cavern.
    if (p.cliffArrivalBubbleUntil && now < p.cliffArrivalBubbleUntil) {
      drawSpeechBubble(footX, tagY - 20, "We got the booze! Let's get this back to Dirtywood!");
    }
  }

  function drawCavernMonster(m, camX, camY, now) {
    if (m.type === "boss_goblin") { drawCavernBoss(m, camX, camY, now); return; }
    if (m.type === "fire_bat") { drawFireBat(m, camX, camY, now); return; }
    // Enemy-model unification: every non-boss, non-bat cave enemy (goblin,
    // troll alike) renders as the same red-shaded goblin sprite family --
    // "use the goblin character as the enemy model inside the cave, don't
    // use any other models".
    const img = cavernGoblinFireImgs[m.shade] || cavernGoblinFireImgs[1];
    const scale = effRTile / TILE;
    const dispW = CAVERN_ENEMY_CW * scale;
    const dispH = CAVERN_ENEMY_CH * scale;
    const footX = Math.round(m.renderX * effRTile - camX);
    const footY = Math.round(m.renderY * effRTile - camY);

    drawGroundShadow(footX, footY - 1, effRTile * 0.24, effRTile * 0.09);

    let action = "walk", frame = 0;
    if (m.attacking || m.moving) {
      m.animT = (m.animT || 0) + 1;
      frame = Math.floor(m.animT / (60 / ANIM_FPS / 2)) % 2;
      if (m.attacking) action = "attack";
    } else {
      m.animT = 0;
    }
    const row = CAVERN_ENEMY_ACTIONS.indexOf(action);
    const sx = frame * CAVERN_ENEMY_CW;
    const sy = row * CAVERN_ENEMY_CH;

    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      if (m.dir === "left") {
        ctx.translate(footX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-footX, 0);
      }
      if (m.attackFlashUntil && now < m.attackFlashUntil) ctx.filter = "brightness(1.8) saturate(0.4)";
      ctx.drawImage(
        img, sx, sy, CAVERN_ENEMY_CW, CAVERN_ENEMY_CH,
        Math.round(footX - dispW / 2), Math.round(footY - dispH), Math.round(dispW), Math.round(dispH)
      );
      ctx.restore();
    }
    drawHealthBar(footX, footY - dispH - 8, m.hp, m.maxHp, Math.round(effRTile * 0.6));
  }

  // The giant boss goblin: same footX/footY foot-position convention as
  // every other cavern entity, just ~8x the scale. Pose is driven by the
  // server's actionState (idle / windup_slam / windup_shout), plus a brief
  // client-local "impact" pose swap (slam/shout art) right when the attack
  // actually resolves, driven by cavernBossFlashUntil/cavernBossFlashKind.
  function drawCavernBoss(m, camX, camY, now) {
    const scale = effRTile / TILE;
    const dispW = BOSS_CW * scale;
    const dispH = BOSS_CH * scale;
    const footX = Math.round(m.renderX * effRTile - camX);
    const footY = Math.round(m.renderY * effRTile - camY);

    drawGroundShadow(footX, footY - 2, effRTile * 1.7, effRTile * 0.55);

    let pose = "idle";
    if (m.actionState === "windup_slam") pose = "windup";
    else if (m.actionState === "windup_shout") pose = "shout";
    else if (m.actionState === "windup_stomp") pose = "stomp";
    else if (now < cavernBossFlashUntil) {
      pose = cavernBossFlashKind === "shout" ? "shout" : cavernBossFlashKind === "stomp" ? "stomp" : "slam";
    }

    m.animT = (m.animT || 0) + 1;
    const frameCount = BOSS_FRAME_COUNTS[pose] || 1;
    const frame = Math.floor(m.animT / (60 / ANIM_FPS / 2)) % frameCount;
    const row = BOSS_ACTIONS.indexOf(pose);
    const sx = frame * BOSS_CW;
    const sy = row * BOSS_CH;

    if (cavernBossImg.complete && cavernBossImg.naturalWidth > 0) {
      ctx.save();
      if (m.dir === "left") {
        ctx.translate(footX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-footX, 0);
      }
      if (now < cavernBossFlashUntil) ctx.filter = "brightness(1.6) saturate(1.3)";
      ctx.drawImage(
        cavernBossImg, sx, sy, BOSS_CW, BOSS_CH,
        Math.round(footX - dispW / 2), Math.round(footY - dispH), Math.round(dispW), Math.round(dispH)
      );
      ctx.restore();
    }

    const barW = Math.round(effRTile * 3.4);
    drawHealthBar(footX, footY - dispH - 16, m.hp, m.maxHp, barW);

    const label = "Goblin King";
    ctx.font = "bold 14px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const tagY = footY - dispH - 24;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(8,12,20,0.6)";
    ctx.fillRect(footX - w / 2 - 6, tagY - 15, w + 12, 19);
    ctx.fillStyle = "#ffb199";
    ctx.fillText(label, footX, tagY);

    if (cavernBossSpeech && now < cavernBossSpeech.until) {
      drawSpeechBubble(footX, tagY - 20, cavernBossSpeech.text);
    }
  }

  // Fire bat: red/glowing, swoops down at the player then either hits or
  // flies off past the screen edge -- see cavern.js's updateFireBat for the
  // batState machine ("idle" | "diving" | "flyoff") this pose reacts to.
  function drawFireBat(m, camX, camY, now) {
    const scale = effRTile / TILE;
    const dispW = BAT_CW * scale * 1.3;
    const dispH = BAT_CH * scale * 1.3;
    const cx = Math.round(m.renderX * effRTile - camX);
    const cy = Math.round(m.renderY * effRTile - camY);

    // Warm red glow so it reads as "glowing" even over the dark background.
    const gcx = cx, gcy = cy;
    const gr = effRTile * 0.9;
    const grad = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, gr);
    grad.addColorStop(0, "rgba(255, 60, 40, 0.45)");
    grad.addColorStop(1, "rgba(255, 60, 40, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gcx, gcy, gr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    m.animT = (m.animT || 0) + 1;
    const frame = Math.floor(m.animT / (60 / ANIM_FPS / 3)) % 2; // fast wing flap
    const sx = frame * BAT_CW;

    // Tilt into the dive direction so a swoop actually reads as a swoop.
    let angle = 0;
    if (m.batState === "diving" || m.batState === "flyoff") {
      const dx = m.diveDirX || 0, dy = m.diveDirY || 0;
      if (dx || dy) angle = Math.atan2(dy, dx) * 0.5;
    }

    if (cavernFireBatImg.complete && cavernFireBatImg.naturalWidth > 0) {
      ctx.save();
      ctx.translate(cx, cy);
      if (m.dir === "left") ctx.scale(-1, 1);
      ctx.rotate(m.dir === "left" ? -angle : angle);
      ctx.drawImage(
        cavernFireBatImg, sx, 0, BAT_CW, BAT_CH,
        Math.round(-dispW / 2), Math.round(-dispH / 2), Math.round(dispW), Math.round(dispH)
      );
      ctx.restore();
    }
  }

  function drawCavernArrowAt(a, camX, camY) {
    if (!arrowImg.complete || arrowImg.naturalWidth === 0) return;
    const scale = effRTile / TILE;
    const dispW = ARROW_NATIVE_W * scale;
    const dispH = ARROW_NATIVE_H * scale;
    const cx = Math.round(a.x * effRTile - camX);
    const cy = Math.round(a.y * effRTile - camY);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a.angle);
    ctx.drawImage(arrowImg, -dispW / 2, -dispH / 2, dispW, dispH);
    ctx.restore();
  }

  function drawCavernDeathFxAt(fx, camX, camY, now) {
    if (!smokeImg.complete || smokeImg.naturalWidth === 0) return;
    const t = now - fx.startTime;
    const frame = Math.max(0, Math.min(SMOKE_FRAMES - 1, Math.floor((t / SMOKE_TOTAL_MS) * SMOKE_FRAMES)));
    const scale = effRTile / TILE;
    const dispSize = SMOKE_SIZE * scale * (fx.big ? 2.2 : 1);
    const cx = Math.round(fx.x * effRTile - camX);
    const cy = Math.round(fx.y * effRTile - camY - dispSize * 0.3);
    // A giant boss gets a small cluster of puffs at staggered offsets instead
    // of one puff, so the death reads as proportionally big rather than a
    // regular-monster-sized wisp swallowed by the giant sprite that just stood
    // there.
    const offsets = fx.big
      ? [[0, 0], [-dispSize * 0.5, -dispSize * 0.35], [dispSize * 0.5, -dispSize * 0.2], [-dispSize * 0.2, dispSize * 0.3]]
      : [[0, 0]];
    for (const [ox, oy] of offsets) {
      ctx.drawImage(
        smokeImg, frame * SMOKE_SIZE, 0, SMOKE_SIZE, SMOKE_SIZE,
        Math.round(cx + ox - dispSize / 2), Math.round(cy + oy - dispSize / 2), Math.round(dispSize), Math.round(dispSize)
      );
    }
  }

  // Permanent, purely-decorative pile of big bones left where the Goblin
  // King died -- procedurally drawn (no sprite needed), no collision, the
  // player walks straight through it. Layout (bones/skulls arrays) is
  // randomized once when the pile is created (see cavern_monster_died) and
  // stored on the fx object, so it stays stable across frames instead of
  // reshuffling every draw.
  function drawCavernBonesAt(b, camX, camY) {
    const cx = Math.round(b.x * effRTile - camX);
    const groundY = Math.round(b.y * effRTile - camY);
    ctx.save();
    drawGroundShadow(cx, groundY - 2, effRTile * 1.6, effRTile * 0.5);
    const boneColor = "#e8dfc8", boneShade = "#b6ab8e";
    for (const bone of b.bones) {
      const len = effRTile * bone.lenFrac;
      const ox = bone.oxFrac * effRTile;
      const oy = bone.oyFrac * effRTile;
      const x1 = cx + ox - Math.cos(bone.ang) * len * 0.5;
      const y1 = groundY + oy - Math.sin(bone.ang) * len * 0.25;
      const x2 = cx + ox + Math.cos(bone.ang) * len * 0.5;
      const y2 = groundY + oy + Math.sin(bone.ang) * len * 0.25;
      ctx.strokeStyle = boneShade;
      ctx.lineWidth = Math.max(3, effRTile * 0.12);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.strokeStyle = boneColor;
      ctx.lineWidth = Math.max(2, effRTile * 0.08);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.fillStyle = boneColor;
      [[x1, y1], [x2, y2]].forEach(([kx, ky]) => {
        ctx.beginPath(); ctx.arc(kx, ky, effRTile * 0.09, 0, Math.PI * 2); ctx.fill();
      });
    }
    // a couple of skull-like ovals for scale/readability
    for (const skull of b.skulls) {
      const sx = cx + skull.oxFrac * effRTile, sy = groundY + skull.oyFrac * effRTile;
      const r = effRTile * 0.28;
      ctx.fillStyle = boneColor;
      ctx.beginPath(); ctx.ellipse(sx, sy, r, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#3a342a";
      ctx.beginPath(); ctx.arc(sx - r * 0.35, sy, r * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + r * 0.35, sy, r * 0.16, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawCavern(now) {
    ctx.fillStyle = "#0a0810";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!cavernMap || !tilesetReady) return;

    const me = players.get(myId);
    const rawCamX = me ? me.renderX * effRTile - canvas.width / 2 : 0;
    const maxCamX = Math.max(0, cavernMap.width * effRTile - canvas.width);
    const camX = Math.max(0, Math.min(maxCamX, rawCamX));
    // Fixed vertical framing (not player-following) -- the level is only
    // ever ~4-5 tiles tall (3 tiers + a little headroom), so anchoring the
    // ground floor a couple tiles above the bottom of the screen keeps every
    // tier comfortably in view at all times without any vertical camera
    // jitter from jumping.
    const camY = Math.max(0, (cavernMap.groundY + 2.5) * effRTile - canvas.height);
    lastCamX = camX; lastCamY = camY;

    if (cavernBgImg.complete && cavernBgImg.naturalWidth > 0) {
      const bgSize = effRTile;
      const startCol = Math.floor(camX / bgSize);
      const endCol = Math.ceil((camX + canvas.width) / bgSize);
      const startRow = Math.floor(camY / bgSize);
      const endRow = Math.ceil((camY + canvas.height) / bgSize);
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          const dx = Math.round(col * bgSize - camX);
          const dy = Math.round(row * bgSize - camY);
          ctx.drawImage(cavernBgImg, 0, 0, TILE, TILE, dx, dy, bgSize + 1, bgSize + 1);
        }
      }
    }

    drawCavernCeiling(camX, camY);
    drawCavernDecor(camX, camY);
    drawCavernDoorMarker(camX, camY);
    drawCavernNextDoorMarker(camX, camY);
    for (const p of cavernMap.platforms) drawCavernPlatformSeg(p, camX, camY);
    drawCavernGroundStrip(camX, camY);
    drawCavernPits(camX, camY);

    for (let i = cavernDeathFx.length - 1; i >= 0; i--) {
      if (now - cavernDeathFx[i].startTime > SMOKE_TOTAL_MS) cavernDeathFx.splice(i, 1);
    }

    const drawables = [];
    for (const p of players.values()) {
      if (p.area === "cavern") drawables.push({ kind: "player", p, y: p.renderY });
    }
    for (const m of cavernMonsters.values()) drawables.push({ kind: "monster", m, y: m.renderY });
    for (const fx of cavernDeathFx) drawables.push({ kind: "fx", fx, y: fx.y });
    for (const b of cavernBoneFx) drawables.push({ kind: "bones", b, y: b.y - 0.01 }); // just under anything standing on the same spot
    drawables.sort((a, b) => a.y - b.y);
    for (const item of drawables) {
      if (item.kind === "player") drawCavernPlayer(item.p, camX, camY, now);
      else if (item.kind === "monster") drawCavernMonster(item.m, camX, camY, now);
      else if (item.kind === "bones") drawCavernBonesAt(item.b, camX, camY);
      else drawCavernDeathFxAt(item.fx, camX, camY, now);
    }

    for (const a of cavernProjectiles.values()) drawCavernArrowAt(a, camX, camY);

    for (const sp of cavernFallingSpikes.values()) drawCavernFallingSpike(sp, camX, camY, now);
    for (let i = cavernSpikeImpactFx.length - 1; i >= 0; i--) {
      if (now - cavernSpikeImpactFx[i].startTime > SPIKE_IMPACT_FX_MS) { cavernSpikeImpactFx.splice(i, 1); continue; }
      drawCavernSpikeImpactFx(cavernSpikeImpactFx[i], camX, camY, now);
    }

    // Boss attack telegraphs -- the whole point is giving players the full
    // windup window to see and react, so these render clearly above
    // everything else drawn so far.
    if (cavernBossTelegraph) {
      const elapsed = now - cavernBossTelegraph.startTime;
      const frac = Math.max(0, Math.min(1, elapsed / (cavernBossTelegraph.windupMs || 1)));
      if (cavernBossTelegraph.kind === "slam") {
        const cx = Math.round(cavernBossTelegraph.targetX * effRTile - camX);
        const groundYpx = Math.round(cavernMap.groundY * effRTile - camY);
        const halfW = BOSS_SLAM_RADIUS * effRTile;
        const zoneTop = groundYpx - effRTile * 3.4;
        const zoneH = effRTile * 3.6;
        const pulse = 0.3 + 0.25 * Math.sin(now / 90);
        ctx.save();
        ctx.globalAlpha = 0.2 + 0.35 * frac;
        ctx.fillStyle = `rgba(255, 60, 40, ${pulse.toFixed(2)})`;
        ctx.fillRect(Math.round(cx - halfW), zoneTop, Math.round(halfW * 2), zoneH);
        ctx.restore();
        ctx.save();
        ctx.font = "bold 16px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffdc70";
        ctx.fillText("!", cx, zoneTop - 6);
        ctx.restore();
      } else if (cavernBossTelegraph.kind === "stomp") {
        // A tight ground-hugging ring right at his feet -- short fuse, small
        // footprint, unlike the slam's wide AOE column.
        const cx = Math.round(cavernBossTelegraph.targetX * effRTile - camX);
        const groundYpx = Math.round(cavernMap.groundY * effRTile - camY);
        const halfW = BOSS_STOMP_RANGE * effRTile;
        const pulse = 0.35 + 0.3 * Math.sin(now / 70);
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.4 * frac;
        ctx.fillStyle = `rgba(255, 140, 30, ${pulse.toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse(cx, groundYpx, halfW, effRTile * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalAlpha = 0.1 + 0.25 * frac;
        ctx.fillStyle = "#ff2a20";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
    }
    if (now < cavernBossFlashUntil) {
      const remain = (cavernBossFlashUntil - now) / 220;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.4 * remain);
      ctx.fillStyle = cavernBossFlashKind === "shout" ? "#ff4030" : cavernBossFlashKind === "stomp" ? "#ffb020" : "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }

  // A small idle dragon NPC standing on the cliff -- reuses the boss
  // dragon's own walk sheet (already tested art), just scaled way down and
  // given a gentle glow so it reads as "touch me" without needing any new
  // art generated.
  function drawCliffDragonNpc(spot, camX, camY, now) {
    if (!dragonWalkImg.complete || dragonWalkImg.naturalWidth === 0) return;
    const scale = (effRTile / TILE) * 0.42;
    const dispW = DRAGON_CW * scale;
    const dispH = DRAGON_CH * scale;
    const footX = Math.round(spot.x * effRTile - camX);
    const footY = Math.round(spot.y * effRTile - camY);
    drawGroundShadow(footX, footY - 2, effRTile * 0.5, effRTile * 0.18);
    const bob = Math.sin(now / 500 + spot.x) * 2;
    const frame = Math.floor(now / 260) % DRAGON_FRAMES;
    ctx.drawImage(
      dragonWalkImg, frame * DRAGON_CW, DIR_ROW.down * DRAGON_CH, DRAGON_CW, DRAGON_CH,
      Math.round(footX - dispW / 2), Math.round(footY - dispH + bob), Math.round(dispW), Math.round(dispH)
    );
    ctx.save();
    ctx.globalAlpha = 0.18 + 0.12 * Math.sin(now / 260);
    ctx.fillStyle = "#ffd27a";
    ctx.beginPath();
    ctx.ellipse(footX, footY - 2, dispW * 0.55, dispH * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The post-boss cliff: a short walkable ledge, a faded distant panorama of
  // the starting village behind it, a dark crevasse dropping away below, and
  // the two dragon NPCs. Same side-view foot-position camera convention as
  // drawCavern, just without the platforms/monsters.
  function drawCliff(now) {
    ctx.fillStyle = "#2a2c3c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!cliffMap) return;

    const me = players.get(myId);
    const rawCamX = me ? me.renderX * effRTile - canvas.width / 2 : 0;
    const maxCamX = Math.max(0, cliffMap.width * effRTile - canvas.width);
    const camX = Math.max(0, Math.min(maxCamX, rawCamX));
    const camY = Math.max(0, (cliffMap.groundY + 2.5) * effRTile - canvas.height);
    lastCamX = camX; lastCamY = camY;

    if (cliffBgImg.complete && cliffBgImg.naturalWidth > 0) {
      const bgW = canvas.width * 1.4;
      const parallaxX = camX * 0.15;
      const bx = -(parallaxX % bgW);
      for (let x = bx - bgW; x < canvas.width + bgW; x += bgW) {
        ctx.drawImage(
          cliffBgImg, 0, 0, cliffBgImg.naturalWidth, cliffBgImg.naturalHeight,
          Math.round(x), 0, Math.round(bgW), canvas.height
        );
      }
    }

    const groundYpx = Math.round(cliffMap.groundY * effRTile - camY);

    const grad = ctx.createLinearGradient(0, groundYpx, 0, canvas.height);
    grad.addColorStop(0, "rgba(10,8,14,0.85)");
    grad.addColorStop(1, "rgba(2,2,4,1)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, groundYpx, canvas.width, Math.max(0, canvas.height - groundYpx));

    const h = Math.round(effRTile * (CAVERN_PLATFORM_NATIVE_H / CAVERN_PLATFORM_NATIVE_W));
    const ready = cavernPlatformImg.complete && cavernPlatformImg.naturalWidth > 0;
    const startTx = Math.max(0, Math.floor(camX / effRTile) - 1);
    const endTx = Math.min(cliffMap.width, Math.ceil((camX + canvas.width) / effRTile) + 1);
    for (let tx = startTx; tx < endTx; tx++) {
      const dx = Math.round(tx * effRTile - camX);
      if (ready) {
        ctx.drawImage(cavernPlatformImg, 0, 0, CAVERN_PLATFORM_NATIVE_W, CAVERN_PLATFORM_NATIVE_H, dx, groundYpx, effRTile + 1, h);
      } else {
        ctx.fillStyle = "#5a5460";
        ctx.fillRect(dx, groundYpx, effRTile + 1, h);
      }
    }
    ctx.fillStyle = "#3a3640";
    ctx.fillRect(0, groundYpx + h, canvas.width, Math.round(effRTile * 0.6));

    for (const spot of cliffMap.dragonSpots) drawCliffDragonNpc(spot, camX, camY, now);

    // Booze barrels + warning sign next to the dragons -- reuses the
    // tavern's generic barrel sprite (drawBarrelAt's world-to-screen math
    // is identical regardless of top-down vs. side-view camera) and no
    // collision is checked anywhere on this level (see cliff.js), so
    // walking through them just works for free.
    if (cliffMap.barrels) cliffMap.barrels.forEach((b) => drawBarrelAt(b, camX, camY));
    if (cliffMap.sign) drawBoozeSignAt(cliffMap.sign, camX, camY);

    const drawables = [];
    for (const p of players.values()) {
      if (p.area === "cliff") drawables.push({ p, y: p.renderY });
    }
    drawables.sort((a, b) => a.y - b.y);
    for (const item of drawables) drawCavernPlayer(item.p, camX, camY, now);
  }

  // --- Flying minigame -----------------------------------------------------
  // A fixed-camera arena (not a scrolling world) -- see server/flying.js's
  // header comment for why this is a personal instance. toScreen maps arena
  // tile coordinates to canvas pixels; the whole arena is scaled to fit with
  // a small margin regardless of window size.
  // Enemy dragon sprite, pre-tinted red/orange ONCE into an offscreen
  // canvas rather than every frame -- `ctx.filter` (hue-rotate/saturate) on
  // every drawImage call, for every enemy, every frame was the actual cause
  // of "laggy and unplayable with 4+ dragons on screen": CSS canvas filters
  // are not cheap, and this was paying that cost per-enemy per-frame. Same
  // "build once, draw many" pattern as buildEdgeTints above.
  let dragonEnemyTintCanvas = null;
  function getDragonEnemyTintImg() {
    if (dragonEnemyTintCanvas) return dragonEnemyTintCanvas;
    if (!dragonWalkImg.complete || dragonWalkImg.naturalWidth === 0) return null;
    const off = document.createElement("canvas");
    off.width = dragonWalkImg.naturalWidth;
    off.height = dragonWalkImg.naturalHeight;
    const octx = off.getContext("2d");
    octx.filter = "hue-rotate(-25deg) saturate(1.7) brightness(0.9)";
    octx.drawImage(dragonWalkImg, 0, 0);
    dragonEnemyTintCanvas = off;
    return off;
  }

  // The giant boss dragon's own tint -- darker and more saturated than the
  // regular wave enemies' red/orange so it reads as a distinct, more
  // menacing "final boss" silhouette even before its much larger size
  // registers. Same "build once, draw many" pattern as above.
  let dragonBossTintCanvas = null;
  function getDragonBossTintImg() {
    if (dragonBossTintCanvas) return dragonBossTintCanvas;
    if (!dragonWalkImg.complete || dragonWalkImg.naturalWidth === 0) return null;
    const off = document.createElement("canvas");
    off.width = dragonWalkImg.naturalWidth;
    off.height = dragonWalkImg.naturalHeight;
    const octx = off.getContext("2d");
    octx.filter = "hue-rotate(-45deg) saturate(2.2) brightness(0.55) contrast(1.3)";
    octx.drawImage(dragonWalkImg, 0, 0);
    dragonBossTintCanvas = off;
    return off;
  }

  // "Give it the same tileset as the first part of the game outside of the
  // tavern" -- tiles the real overworld grass tiles across the fixed arena
  // instead of a distinct sky-gradient backdrop, so the minigame reads as
  // the same 2D pixel game rather than a different genre bolted on.
  const FLYING_GROUND_SCROLL_TILES_PER_SEC = 1.1; // "make it look like the ground below is scrolling down"

  function drawFlyingGround(now, offX, offY, scale) {
    ctx.fillStyle = "#16240f";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (tilesetImg.complete && tilesetImg.naturalWidth > 0) {
      // "Make it look like the ground below is scrolling down to give the
      // feeling that the dragon is flying across the land" -- the tile grid
      // continuously scrolls downward in screen space; the world-space row
      // index used for the deterministic grass2-variant sprinkle advances in
      // lockstep with the whole-tile part of the scroll, so the sprinkle
      // pattern itself scrolls smoothly and seamlessly rather than just a
      // flat color sliding under a static texture.
      ctx.save();
      ctx.beginPath();
      ctx.rect(offX, offY, FLYING_ARENA_W * scale, FLYING_ARENA_H * scale);
      ctx.clip();
      const scrollTiles = (now / 1000) * FLYING_GROUND_SCROLL_TILES_PER_SEC;
      const rowOffset = Math.floor(scrollTiles);
      const fracOffset = scrollTiles - rowOffset;
      for (let row = -1; row <= FLYING_ARENA_H; row++) {
        const rowY = row + fracOffset;
        const dy = Math.round(offY + rowY * scale);
        const dh = Math.round(offY + (rowY + 1) * scale) - dy;
        const worldRow = row + rowOffset;
        for (let col = 0; col < FLYING_ARENA_W; col++) {
          // Deterministic (not Math.random()) sprinkle of the grass2 variant
          // for a little texture, stable frame to frame (aside from scrolling).
          const variant = (col * 7 + worldRow * 13) % 5 === 0 ? 1 : 0;
          const dx = Math.round(offX + col * scale);
          const dw = Math.round(offX + (col + 1) * scale) - dx;
          ctx.drawImage(tilesetImg, variant * TILE, 0, TILE, TILE, dx, dy, dw, dh);
        }
      }
      ctx.restore();
    }
    // A few slow drifting cloud-shadows for a subtle sense of altitude/motion
    // -- cheap (plain fills, no filters), kept subtle so the tileset reads
    // through clearly.
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#04140a";
    const t = now / 1000;
    for (let i = 0; i < 6; i++) {
      const cx = ((i * 137) % (FLYING_ARENA_W + 4)) - 2;
      const speed = 0.5 + (i % 3) * 0.2;
      const cy = ((t * speed + i * 2.3) % (FLYING_ARENA_H + 4)) - 2;
      const sx = offX + cx * scale, sy = offY + cy * scale;
      ctx.beginPath();
      ctx.ellipse(sx, sy, scale * 1.4, scale * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // A small rider sprite (the player's own selected race/color, or a goblin
  // for enemy dragons -- "make it look like the player is riding the
  // dragon" / "make it look like the goblins are riding the enemy dragons,
  // use their race models") seated on the dragon's back.
  function drawDragonRider(sx, sy, dispW, dispH, race, color) {
    const img = charSprites[`${race}_${color}`] || charSprites["human_blue"];
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const riderW = dispW * 0.32;
    const riderH = riderW * (CHAR_NATIVE_H / CHAR_NATIVE_W);
    const rx = Math.round(sx - riderW / 2);
    const ry = Math.round(sy - dispH * 0.16 - riderH);
    ctx.drawImage(
      img, 0, DIR_ROW.down * CHAR_NATIVE_H, CHAR_NATIVE_W, CHAR_NATIVE_H,
      rx, ry, Math.round(riderW), Math.round(riderH)
    );
  }

  // Stable (not Math.random()) per-enemy color pick, purely from its own id
  // string, so a given enemy's goblin rider color never reshuffles frame to
  // frame.
  function colorForFlyingId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function drawFlyingEnemy(e, toScreen, scale, now) {
    const [sx, sy] = toScreen(e.renderX, e.renderY);
    // `scale` here is screen-px-PER-ARENA-TILE (see drawFlying), not the
    // native-sprite-px-to-screen-px factor used elsewhere (effRTile/TILE)
    // -- so sizes are expressed directly in tile units, not DRAGON_CW*scale.
    const dispW = 1.7 * scale;
    const dispH = dispW * (DRAGON_CH / DRAGON_CW);
    const img = getDragonEnemyTintImg();
    if (img) {
      const frame = Math.floor(now / 220) % DRAGON_FRAMES;
      ctx.drawImage(
        img, frame * DRAGON_CW, DIR_ROW.down * DRAGON_CH, DRAGON_CW, DRAGON_CH,
        Math.round(sx - dispW / 2), Math.round(sy - dispH / 2), Math.round(dispW), Math.round(dispH)
      );
    }
    drawDragonRider(sx, sy, dispW, dispH, "goblin", colorForFlyingId(e.id));
    ctx.save();
    ctx.fillStyle = "#c84020";
    ctx.beginPath();
    ctx.arc(sx, sy - dispH * 0.2, Math.max(2, dispW * 0.14), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    drawHealthBar(sx, Math.round(sy - dispH / 2 - 8), e.hp, e.maxHp, Math.round(dispW * 0.9));
  }

  function drawFlyingPlayerDragon(me, toScreen, scale, now) {
    const [sx, sy] = toScreen(me.renderX, me.renderY);
    // Same tile-unit sizing as drawFlyingEnemy -- see its comment.
    const dispW = 2.0 * scale;
    const dispH = dispW * (DRAGON_CH / DRAGON_CW);
    if (dragonWalkImg.complete && dragonWalkImg.naturalWidth > 0) {
      ctx.save();
      if (me.hitFlashUntil && now < me.hitFlashUntil) ctx.filter = "brightness(1.8) saturate(0.4)";
      const frame = me.moving ? Math.floor(now / 160) % DRAGON_FRAMES : 0;
      ctx.drawImage(
        dragonWalkImg, frame * DRAGON_CW, DIR_ROW.up * DRAGON_CH, DRAGON_CW, DRAGON_CH,
        Math.round(sx - dispW / 2), Math.round(sy - dispH / 2), Math.round(dispW), Math.round(dispH)
      );
      ctx.restore();
    }
    drawDragonRider(sx, sy, dispW, dispH, me.race, me.color);
    drawHealthBar(sx, Math.round(sy - dispH / 2 - 10), me.hp, me.maxHp, Math.round(dispW));

    // Stun indicator -- same "three orbiting dots" convention as drawPlayer's
    // (cavern boss shout stun), reused here so the Dragon King's intro
    // screech-stun (see flying_boss_intro_start) is actually visible during
    // the flying minigame too, not just on the ground.
    if (me.stunVisualUntil && now < me.stunVisualUntil) {
      const scx = sx, scy = Math.round(sy - dispH / 2 - 18);
      const t = now / 160;
      for (let i = 0; i < 3; i++) {
        const ang = t + (i * Math.PI * 2) / 3;
        const ox = Math.cos(ang) * 9;
        const oy = Math.sin(ang) * 3.5;
        ctx.beginPath();
        ctx.fillStyle = "#ffe066";
        ctx.arc(scx + ox, scy + oy, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (me.flyingVictoryBubbleUntil && now < me.flyingVictoryBubbleUntil) {
      drawSpeechBubble(sx, Math.round(sy - dispH / 2 - 14), "We did it! Let's get back to Dirtywood!!");
    }
  }

  function drawFlyingProjectile(pr, toScreen, scale) {
    const [sx, sy] = toScreen(pr.x, pr.y);
    ctx.save();
    ctx.fillStyle = "#ff8a2a";
    ctx.beginPath();
    ctx.ellipse(sx, sy, Math.max(2, scale * 0.16), Math.max(3, scale * 0.28), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Enemy (bullet-hell) fireballs -- a distinct, more menacing color scheme
  // (deep red core, dark outer glow) so they read as clearly different from
  // (and more dangerous-looking than) the player's own orange fireballs.
  function drawFlyingEnemyProjectile(pr, toScreen, scale) {
    const [sx, sy] = toScreen(pr.x, pr.y);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, scale * 0.32);
    grad.addColorStop(0, "rgba(255,210,120,0.95)");
    grad.addColorStop(0.5, "rgba(220,40,30,0.85)");
    grad.addColorStop(1, "rgba(120,10,20,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, scale * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "#3a0508";
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(2, scale * 0.12), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFlyingDeathFx(fx, toScreen, scale, now) {
    if (!smokeImg.complete || smokeImg.naturalWidth === 0) return;
    const t = now - fx.startTime;
    const frame = Math.max(0, Math.min(SMOKE_FRAMES - 1, Math.floor((t / SMOKE_TOTAL_MS) * SMOKE_FRAMES)));
    const [sx, sy] = toScreen(fx.x, fx.y);
    // Same tile-unit sizing as drawFlyingEnemy/drawFlyingPlayerDragon -- see
    // their comments. `scale` is screen-px-per-ARENA-TILE here, not the
    // native-sprite-px-to-screen-px factor used elsewhere.
    const dispSize = 1.4 * scale;
    ctx.drawImage(
      smokeImg, frame * SMOKE_SIZE, 0, SMOKE_SIZE, SMOKE_SIZE,
      Math.round(sx - dispSize / 2), Math.round(sy - dispSize / 2), Math.round(dispSize), Math.round(dispSize)
    );
  }

  // "Make all the enemy dragons disappear into clouds of smoke before
  // revealing the dragon king boss." fx is a snapshotted {x,y,startTime}
  // (see the flying_boss_intro_start handler) -- draws a smoke puff at the
  // enemy's last known position that grows and fades over FLYING_BOSS_INTRO_MS,
  // looping the smoke spritesheet's frames a couple times over that longer
  // duration (the sheet itself is authored for the shorter SMOKE_TOTAL_MS
  // single-death-poof case) and fading opacity out over the back half.
  function drawFlyingBossIntroFx(fx, toScreen, scale, now) {
    if (!smokeImg.complete || smokeImg.naturalWidth === 0) return;
    const t = now - fx.startTime;
    const loopT = t % SMOKE_TOTAL_MS;
    const frame = Math.max(0, Math.min(SMOKE_FRAMES - 1, Math.floor((loopT / SMOKE_TOTAL_MS) * SMOKE_FRAMES)));
    const [sx, sy] = toScreen(fx.x, fx.y);
    const growT = Math.min(1, t / (SMOKE_TOTAL_MS * 0.6));
    const fadeStart = FLYING_BOSS_INTRO_MS * 0.55;
    const alpha = t <= fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (FLYING_BOSS_INTRO_MS - fadeStart));
    const dispSize = 1.4 * scale * (1 + growT * 0.6);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(
      smokeImg, frame * SMOKE_SIZE, 0, SMOKE_SIZE, SMOKE_SIZE,
      Math.round(sx - dispSize / 2), Math.round(sy - dispSize / 2), Math.round(dispSize), Math.round(dispSize)
    );
    ctx.restore();
  }

  // A small pixel-art gold crown, planted on the Dragon King's head --
  // "remove the goblin on top of the final dragon, give the dragon a
  // golden crown". Purely canvas primitives, same "small vector shape"
  // convention as the health bars/speech bubbles rather than a baked
  // sprite, since it only ever appears on this one boss.
  function drawDragonKingCrown(sx, sy, dispW, dispH) {
    const crownW = dispW * 0.22;
    const crownH = crownW * 0.6;
    const cx = sx;
    const cy = sy - dispH * 0.34;
    ctx.save();
    ctx.fillStyle = "#ffd23c";
    ctx.strokeStyle = "#9a6a10";
    ctx.lineWidth = Math.max(1, crownW * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx - crownW / 2, cy + crownH / 2);
    ctx.lineTo(cx - crownW / 2, cy - crownH * 0.1);
    ctx.lineTo(cx - crownW / 4, cy + crownH * 0.15);
    ctx.lineTo(cx, cy - crownH * 0.5);
    ctx.lineTo(cx + crownW / 4, cy + crownH * 0.15);
    ctx.lineTo(cx + crownW / 2, cy - crownH * 0.1);
    ctx.lineTo(cx + crownW / 2, cy + crownH / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d8304a";
    ctx.beginPath();
    ctx.arc(cx, cy - crownH * 0.15, Math.max(1, crownW * 0.08), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The giant boss dragon -- same tile-unit sizing convention as
  // drawFlyingEnemy (`scale` is screen-px-per-ARENA-TILE), just much
  // bigger and drawn with the darker boss tint, plus a prominent top-screen
  // health bar in addition to the small overhead one so its (now 100hp)
  // pool reads clearly at a glance during the fight. No goblin rider (see
  // drawDragonKingCrown above) and a floating "Dragon King" nametag instead
  // -- "remove the goblin on top of the final dragon, give the dragon a
  // golden crown and a floating name of 'Dragon King'".
  function drawFlyingBoss(boss, toScreen, scale, now) {
    const [sx, sy] = toScreen(boss.renderX, boss.renderY);
    const dispW = 5.2 * scale;
    const dispH = dispW * (DRAGON_CH / DRAGON_CW);
    const img = getDragonBossTintImg();
    if (img) {
      const frame = Math.floor(now / 260) % DRAGON_FRAMES;
      ctx.drawImage(
        img, frame * DRAGON_CW, DIR_ROW.down * DRAGON_CH, DRAGON_CW, DRAGON_CH,
        Math.round(sx - dispW / 2), Math.round(sy - dispH / 2), Math.round(dispW), Math.round(dispH)
      );
    }
    drawDragonKingCrown(sx, sy, dispW, dispH);

    ctx.font = "bold 15px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const label = "Dragon King";
    const tagY = Math.round(sy - dispH / 2 - 30);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(60,40,10,0.65)";
    ctx.fillRect(Math.round(sx - tw / 2 - 8), tagY - 16, Math.round(tw + 16), 20);
    ctx.fillStyle = "#ffd75e";
    ctx.fillText(label, sx, tagY);

    drawHealthBar(sx, Math.round(sy - dispH / 2 - 10), boss.hp, boss.maxHp, Math.round(dispW * 0.7), true);
  }

  // Fire-beam sweep: a full-height warning line during the telegraph
  // window, then a full-height lethal fire column tracking the boss's own x
  // while it's actually sweeping. "The player needs to stay ahead of it to
  // avoid it" -- drawn edge-to-edge (arena top to bottom) so it's
  // unambiguous which side is safe.
  function drawFlyingBeamTelegraph(tel, toScreen, scale, now) {
    const elapsed = now - tel.startTime;
    const frac = Math.max(0, Math.min(1, elapsed / (tel.telegraphMs || 1)));
    const [sx, syTop] = toScreen(tel.x, 0);
    const [, syBot] = toScreen(tel.x, FLYING_ARENA_H);
    const halfW = FLYING_BEAM_WIDTH_TILES * scale;
    const pulse = 0.25 + 0.25 * Math.sin(now / 80);
    ctx.save();
    ctx.globalAlpha = 0.15 + 0.35 * frac;
    ctx.fillStyle = `rgba(255, 140, 40, ${pulse.toFixed(2)})`;
    ctx.fillRect(Math.round(sx - halfW), syTop, Math.round(halfW * 2), syBot - syTop);
    ctx.restore();
    ctx.save();
    ctx.font = "bold 18px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffdc70";
    ctx.fillText(tel.dir === 1 ? "▶" : "◀", sx, syTop + 22);
    ctx.restore();
  }

  function drawFlyingBeamSweep(boss, toScreen, scale, now) {
    const [sx, syTop] = toScreen(boss.renderX, 0);
    const [, syBot] = toScreen(boss.renderX, FLYING_ARENA_H);
    const halfW = FLYING_BEAM_WIDTH_TILES * scale;
    const flicker = 0.75 + 0.2 * Math.sin(now / 45);
    ctx.save();
    ctx.globalAlpha = flicker;
    const grad = ctx.createLinearGradient(sx - halfW, 0, sx + halfW, 0);
    grad.addColorStop(0, "rgba(255,90,20,0.15)");
    grad.addColorStop(0.5, "rgba(255,220,140,0.9)");
    grad.addColorStop(1, "rgba(255,90,20,0.15)");
    ctx.fillStyle = grad;
    ctx.fillRect(Math.round(sx - halfW), syTop, Math.round(halfW * 2), syBot - syTop);
    ctx.restore();
  }

  // "When it dies make it explode with fire and smoke" -- several
  // overlapping giant flame tongues (reusing drawFlameShape, same shape
  // used by the outside-world dragon-death fire hazards) plus a handful of
  // staggered, oversized smoke puffs, all fading out over
  // FLYING_BOSS_DEATH_FX_MS.
  function drawFlyingBossDeathFx(fx, toScreen, scale, now) {
    const t = now - fx.startTime;
    const frac = Math.max(0, Math.min(1, t / FLYING_BOSS_DEATH_FX_MS));
    const [sx, sy] = toScreen(fx.x, fx.y);
    const fadeOut = frac > 0.6 ? 1 - (frac - 0.6) / 0.4 : 1;

    ctx.save();
    ctx.globalAlpha = Math.max(0, fadeOut);
    for (let i = 0; i < 5; i++) {
      const ox = ((i - 2) * 0.5) * scale;
      drawFlameShape(sx + ox, sy + scale * 0.3, scale * 2.4, now, i * 340);
    }
    ctx.restore();

    if (smokeImg.complete && smokeImg.naturalWidth > 0) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, fadeOut) * 0.9;
      for (let i = 0; i < 4; i++) {
        const puffPhase = i * 160;
        const puffT = Math.max(0, t - puffPhase);
        const frame = Math.max(0, Math.min(SMOKE_FRAMES - 1, Math.floor((puffT / SMOKE_TOTAL_MS) * SMOKE_FRAMES) % SMOKE_FRAMES));
        const puffX = sx + Math.sin(i * 2.1) * scale * 1.6;
        const puffY = sy - scale * 0.4 - frac * scale * 1.8 - i * scale * 0.3;
        const dispSize = (2.4 + i * 0.5) * scale;
        ctx.drawImage(
          smokeImg, frame * SMOKE_SIZE, 0, SMOKE_SIZE, SMOKE_SIZE,
          Math.round(puffX - dispSize / 2), Math.round(puffY - dispSize / 2), Math.round(dispSize), Math.round(dispSize)
        );
      }
      ctx.restore();
    }
  }

  // Screen-space arena transform, stashed each frame so the mousedown
  // handler (outside drawFlying) can invert a click back to an arena-space
  // aim angle without duplicating this math.
  let flyingOffX = 0, flyingOffY = 0, flyingScale = 1;

  function drawFlying(now) {
    const scale = Math.min(canvas.width / (FLYING_ARENA_W + 1), canvas.height / (FLYING_ARENA_H + 1));
    const offX = (canvas.width - FLYING_ARENA_W * scale) / 2;
    const offY = (canvas.height - FLYING_ARENA_H * scale) / 2;
    flyingOffX = offX; flyingOffY = offY; flyingScale = scale;
    const toScreen = (x, y) => [Math.round(offX + x * scale), Math.round(offY + y * scale)];

    drawFlyingGround(now, offX, offY, scale);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.strokeRect(offX, offY, FLYING_ARENA_W * scale, FLYING_ARENA_H * scale);
    ctx.restore();

    for (const e of flyingEnemies.values()) drawFlyingEnemy(e, toScreen, scale, now);
    for (let i = flyingBossIntroFx.length - 1; i >= 0; i--) {
      if (now - flyingBossIntroFx[i].startTime > FLYING_BOSS_INTRO_MS) { flyingBossIntroFx.splice(i, 1); continue; }
      drawFlyingBossIntroFx(flyingBossIntroFx[i], toScreen, scale, now);
    }
    if (flyingBeamTelegraph) drawFlyingBeamTelegraph(flyingBeamTelegraph, toScreen, scale, now);
    if (flyingBoss && flyingBoss.beamSweeping) drawFlyingBeamSweep(flyingBoss, toScreen, scale, now);
    if (flyingBoss) drawFlyingBoss(flyingBoss, toScreen, scale, now);

    const me = players.get(myId);
    if (me) drawFlyingPlayerDragon(me, toScreen, scale, now);

    for (const pr of flyingProjectiles.values()) drawFlyingProjectile(pr, toScreen, scale);
    for (const pr of flyingEnemyProjectiles.values()) drawFlyingEnemyProjectile(pr, toScreen, scale);

    for (let i = flyingDeathFx.length - 1; i >= 0; i--) {
      if (now - flyingDeathFx[i].startTime > SMOKE_TOTAL_MS) { flyingDeathFx.splice(i, 1); continue; }
      drawFlyingDeathFx(flyingDeathFx[i], toScreen, scale, now);
    }
    if (flyingBossDeathFx) {
      if (now - flyingBossDeathFx.startTime > FLYING_BOSS_DEATH_FX_MS) flyingBossDeathFx = null;
      else drawFlyingBossDeathFx(flyingBossDeathFx, toScreen, scale, now);
    }

    ctx.save();
    ctx.font = "bold 15px -apple-system, sans-serif";
    ctx.textAlign = "center";
    // The top banner reads differently per phase -- see server/flying.js's
    // header comment for the full "waves" -> "boss" -> "bossDying" ->
    // "woosh" sequence.
    let label, hint;
    if (flyingPhase === "bossIntro") {
      label = "A screech echoes...";
      hint = "";
    } else if (flyingPhase === "boss") {
      label = "DRAGON KING";
      hint = "Shoot it down!";
    } else if (flyingPhase === "bossDying") {
      label = "The dragon falls!";
      hint = "";
    } else if (flyingPhase === "woosh") {
      label = "Heading back to the tavern...";
      hint = "";
    } else {
      label = `Fly! ${Math.max(0, Math.ceil(flyingTimeLeftMs / 1000))}s`;
      hint = "Click to shoot";
    }
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(8,12,20,0.55)";
    ctx.fillRect(canvas.width / 2 - w / 2 - 10, 10, w + 20, 26);
    ctx.fillStyle = flyingPhase === "boss" ? "#ff8a6a" : "#ffe9a8";
    ctx.fillText(label, canvas.width / 2, 28);

    if (hint) {
      ctx.font = "12px -apple-system, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillText(hint, canvas.width / 2, 46);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------
  let lastT = performance.now();
  function loop(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    predictLocal(dt);
    updateRemote();
    draw(t);
    updateFootstepAudio(t);
    refreshCombatMusic();
    refreshTavernPartyMusic();
    requestAnimationFrame(loop);
  }

  // Exposed for automated testing/debugging only.
  window.__gameDebug = {
    getEffRTile: () => effRTile,
    getVisibleTiles: () => ({ w: canvas.width / effRTile, h: canvas.height / effRTile }),
    getNearbyCards: () => Array.from(nearbyPanel.children).map((c) => ({
      name: c.querySelector(".nearby-name").textContent,
      race: c.querySelector(".nearby-race").textContent,
      opacity: c.style.opacity,
    })),
    getPlayerPos: (id) => {
      const p = players.get(id);
      return p ? { x: p.renderX, y: p.renderY } : null;
    },
    // Testing only: inspect a player's client-side dash-trail state.
    getPlayerDashInfo: (id) => {
      const p = players.get(id);
      return p ? { dashActiveUntil: p.dashActiveUntil || 0, trailLen: (p.dashTrail || []).length, x: p.renderX, y: p.renderY } : null;
    },
    getMyId: () => myId,
    getMyArea: () => myArea,
    getBirdCount: () => birds.length,
    forceSpawnBird: () => { nextBirdAt = 0; },
    getPlayerHp: (id) => { const p = players.get(id); return p ? { hp: p.hp, maxHp: p.maxHp, dead: p.dead } : null; },
    getMonsterCount: () => monsters.size,
    getMonster: (id) => { const m = monsters.get(id); return m ? { ...m } : null; },
    getMonsterIds: () => [...monsters.keys()],
    getTavernNpcs: () => [...tavernNpcs.values()].map((n) => ({ ...n })),
    // Testing only: force each flying-boss-finale phase locally so its
    // rendering (giant dragon, explosion fx, woosh tween) can be
    // screenshotted without playing through the full wave-survival timer +
    // 50-hit fight for real. See the "flying_boss_start"/"flying_boss_died"/
    // "flying_woosh_start" handlers above for what a real transition does.
    getFlyingPhase: () => flyingPhase,
    getFlyingBoss: () => (flyingBoss ? { ...flyingBoss } : null),
    debugForceFlyingBoss: (x, y, hp, maxHp) => {
      flyingPhase = "boss";
      flyingEnemies.clear();
      flyingEnemyProjectiles.clear();
      flyingBoss = {
        x: x ?? FLYING_ARENA_W / 2, y: y ?? 1.7,
        renderX: x ?? FLYING_ARENA_W / 2, renderY: y ?? 1.7,
        hp: hp ?? 50, maxHp: maxHp ?? 50,
      };
    },
    debugForceFlyingBeam: (dir, x, sweeping) => {
      if (sweeping) {
        flyingBeamTelegraph = null;
        if (flyingBoss) { flyingBoss.x = x; flyingBoss.beamSweeping = true; }
      } else {
        flyingBeamTelegraph = { dir, x, startTime: performance.now(), telegraphMs: 900 };
      }
    },
    debugForceFlyingBossDying: (x, y) => {
      flyingPhase = "bossDying";
      flyingBossDeathFx = { x: x ?? FLYING_ARENA_W / 2, y: y ?? 1.7, startTime: performance.now() };
      flyingBoss = null;
      const me = players.get(myId);
      if (me) me.flyingVictoryBubbleUntil = performance.now() + FLYING_BOSS_DEATH_FX_MS + FLYING_BOSS_WOOSH_MS + 400;
    },
    debugForceFlyingWoosh: () => {
      flyingPhase = "woosh";
      flyingWooshStartTime = performance.now();
      const me = players.get(myId);
      flyingWooshStartX = me ? me.renderX : FLYING_ARENA_W / 2;
      flyingWooshStartY = me ? me.renderY : FLYING_ARENA_H / 2;
    },
    // Testing only: fakes the tavern party (16 patrons + Dante dancing)
    // client-side, without waiting on a real flying-minigame completion.
    // Purely a client-local injection into the same tavernNpcs Map the real
    // "tavern_npcs" broadcast populates -- the next real broadcast from the
    // server (still just Dante, since this doesn't touch server state) will
    // wipe the fake patrons again, so callers must screenshot/inspect within
    // the same synchronous task as this call (see forceDrawNow's doc comment
    // for why -- same server-snapback race).
    debugForceTavernParty: () => {
      const RACES = ["human", "elf", "orc", "goblin"];
      const COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];
      for (const n of tavernNpcs.values()) {
        if (n.big) { n.dancing = true; n.dancingSince = performance.now(); }
      }
      const cx = tavernMap ? tavernMap.width / 2 : 13;
      const cy = tavernMap ? tavernMap.height / 2 : 10;
      for (let i = 0; i < 16; i++) {
        const id = "debugPatron" + i;
        const angle = (i / 16) * Math.PI * 2;
        tavernNpcs.set(id, {
          renderX: cx + Math.cos(angle) * 5,
          renderY: cy + Math.sin(angle) * 3,
          race: RACES[i % RACES.length],
          color: COLORS[i % COLORS.length],
          dir: "down",
          moving: false,
          big: false,
          dancing: false,
          animT: 0,
        });
      }
    },
    // Testing only: force every regular (non-Dante) patron to start their
    // "jumping for joy" hop right now, so the visual can be screenshotted
    // without waiting out the randomized per-patron interval.
    debugForceAllPatronsJump: () => {
      const now = performance.now();
      for (const n of tavernNpcs.values()) {
        if (!n.big) { n.jumpStartTime = now; n.nextJumpAt = now; }
      }
    },
    forceAttack: (angle) => {
      const me = players.get(myId);
      if (!me || !socket) return;
      me.swingAngle = angle;
      me.swingStart = performance.now();
      socket.emit("attack", { angle });
    },
    setRace: (r) => {
      const el = [...raceSelectEl.children].find((c) => c.dataset.race === r);
      if (el) el.click();
    },
    getSelectedRace: () => selectedRace,
    getDeathFxCount: () => deathFx.length,
    getPlayerLevel: (id) => { const p = players.get(id); return p ? p.level : null; },
    getMyLevel: () => { const p = players.get(myId); return p ? p.level : null; },
    isCaveSealed: () => caveSealed,
    getArrowCount: () => projectiles.size,
    getFireHazardCount: () => fireHazards.length,
    // Testing only: fake a dragon-death fire hazard without waiting on a
    // real dragon kill, so the flame rendering can be screenshotted.
    debugSpawnFireHazard: (x, y) => { fireHazards.push({ x, y, expiresAt: performance.now() + 60000 }); },
    getBowState: () => ({ ...bowState }),
    getSwordState: () => ({ ...swordState }),
    isBurning: (id) => { const p = players.get(id); return p ? !!p.burning : null; },
    setWeapon: (w) => { if (socket) socket.emit("select_weapon", { weapon: w }); },
    getCavernMonsterCount: () => cavernMonsters.size,
    getCavernArrowCount: () => cavernProjectiles.size,
    isGrounded: (id) => { const p = players.get(id || myId); return p ? !!p.grounded : null; },
    isCrouching: (id) => { const p = players.get(id || myId); return p ? !!p.crouching : null; },
    jump: () => { if (socket) socket.emit("jump"); },
    getCavernMap: () => cavernMap,
    getCaveSideDoorTile: () => caveSideDoorTile,
    isCaveSideDoorOpened: () => caveSideDoorOpened,
    isCaveBackDoorOpened: () => caveBackDoorOpened,
    getMusicSrc: () => bgMusicEl.src,
    isCombatMusicActive: () => combatMusicActive,
    // Testing only: synchronously invoke refreshCombatMusic() outside the
    // rAF loop, same rationale as forceDrawNow -- avoids a real incoming
    // server "state" broadcast (which continuously reasserts the actual
    // server-side area) snapping myArea back before a real animation frame
    // gets a chance to run it.
    debugRefreshCombatMusic: () => { refreshCombatMusic(); },
    // Testing only: force-switch the render/predict area without a real
    // server-side transition, so the cavern's visuals can be screenshotted
    // without needing to actually kill the dragon first.
    forceArea: (a) => { myArea = a; const me = players.get(myId); if (me) me.area = a; },
    // Testing only: fakes the "just arrived on the cliff" speech bubble
    // (normally stamped by addOrUpdatePlayer's areaChanged detection on a
    // real server-driven transition) without needing to actually walk
    // through the whole boss fight -- see drawCavernPlayer's
    // cliffArrivalBubbleUntil check.
    debugForceCliffArrivalBubble: () => {
      const me = players.get(myId);
      if (!me) return false;
      me.cliffArrivalBubbleUntil = performance.now() + 6000;
      return true;
    },
    // Testing only: fires the tavern-entrance fireworks show without
    // needing a real area-change transition to trigger it.
    debugForceTavernFireworks: () => {
      tavernFireworksUntil = performance.now() + TAVERN_FIREWORKS_SHOW_MS;
      tavernNextFireworkAt = 0;
    },
    // Testing only: injects a fake ceiling spike (telegraphing or actively
    // falling) directly into the client's render map, so its rendering can
    // be screenshotted on demand without waiting on the real Math.random()
    // spawn timer.
    debugForceCavernSpike: (id, x, y, telegraphing) => {
      cavernFallingSpikes.set(id, { id, x, y, telegraphing: !!telegraphing });
    },
    // Testing only: injects a fake cavern goblin/troll directly into the
    // client's render map, so a specific pose (e.g. mid sword-swing) can be
    // screenshotted on demand without waiting on the real AI to aggro.
    debugForceCavernMonster: (id, type, x, y, dir, attacking) => {
      cavernMonsters.set(id, {
        id, type, x, y, renderX: x, renderY: y, tier: 0, dir: dir || "right",
        moving: false, attacking: !!attacking, hp: 4, maxHp: 4, shade: 1, animT: 0, attackFlashUntil: 0,
      });
    },
    // Testing only: injects/updates a tavern NPC (e.g. Dante, big=true) via
    // the real addOrUpdateTavernNpc code path, so his dancing pose (arm-wave
    // overlay etc.) can be screenshotted on demand without needing to
    // actually finish the dragon-flight minigame first.
    debugForceTavernNpc: (n) => { addOrUpdateTavernNpc(n, true); },
    // Testing only: teleport the local render position (camera-follow areas
    // use this to frame a screenshot without a real server-side move).
    forcePosition: (x, y) => {
      const me = players.get(myId);
      if (!me) return;
      me.renderX = x; me.renderY = y; me.targetX = x; me.targetY = y; me.x = x; me.y = y;
    },
    // Testing only: synchronously invoke draw() outside the rAF loop, so a
    // forceArea()+forcePosition()+forceDrawNow() sequence in one JS task
    // can't be interrupted mid-way by an incoming server "state" broadcast
    // (which would otherwise snap the forced position back to the real one
    // before the next real animation frame paints) -- see
    // tools/boss_cliff_flying_visual_test.js for why this is needed.
    forceDrawNow: () => { draw(performance.now()); },
    getCliffMap: () => cliffMap,
    getCaveBackDoorTile: () => caveBackDoorTile,
    getMyArea: () => myArea,
    // Testing only: force the local player's grounded/crouching pose so
    // drawCavernPlayer's jump/crouch rows can be screenshotted on demand
    // without needing a real jump/crouch-timed input.
    debugForcePose: (grounded, crouching) => {
      const me = players.get(myId);
      if (!me) return false;
      if (grounded !== undefined) me.grounded = grounded;
      if (crouching !== undefined) me.crouching = crouching;
      return true;
    },
    getBossState: () => {
      for (const m of cavernMonsters.values()) if (m.type === "boss_goblin") return { ...m };
      return null;
    },
    // Testing only: force the boss's client-side actionState so its
    // windup/slam/shout poses (normally only visible for the real windup
    // duration or a brief impact flash) can be screenshotted on demand.
    debugForceBossPose: (actionState) => {
      for (const m of cavernMonsters.values()) {
        if (m.type === "boss_goblin") { m.actionState = actionState; return true; }
      }
      return false;
    },
    // Testing only: fake a boss taunt speech bubble / bone pile without
    // waiting on the real windup timer or a real kill.
    debugSetBossSpeech: (text) => { cavernBossSpeech = { text, until: performance.now() + 8000 }; },
    debugSpawnBones: (x, y) => {
      cavernBoneFx.push({
        x, y,
        bones: Array.from({ length: 6 }, () => ({
          ang: Math.random() * Math.PI, lenFrac: 0.5 + Math.random() * 0.5,
          oxFrac: (Math.random() - 0.5) * 1.3, oyFrac: -Math.random() * 0.25,
        })),
        skulls: Array.from({ length: 2 }, () => ({
          oxFrac: (Math.random() - 0.5) * 1.1, oyFrac: -Math.random() * 0.15,
        })),
      });
    },
    // Testing only: fake a cave monster (e.g. a fire bat) at a given spot
    // without waiting on a real server spawn, so its rendering can be
    // screenshotted on demand.
    debugSpawnCavernMonster: (type, x, y, extra) => {
      const id = `__debug_${type}_${Math.floor(x)}_${Math.floor(y)}`;
      addOrUpdateCavernMonster({ id, type, x, y, dir: "right", moving: false, hp: 5, maxHp: 5, shade: 1, ...extra }, true);
      return id;
    },
    // Testing only: same idea, for an outside-world monster (e.g. the dragon).
    debugSpawnMonster: (type, x, y, extra) => {
      const id = `__debug_${type}_${Math.floor(x)}_${Math.floor(y)}`;
      addOrUpdateMonster({ id, type, x, y, dir: "right", moving: false, hp: 5, maxHp: 5, ...extra }, true);
      return id;
    },
    // Testing only: fake a couple of flying-minigame enemies/projectiles so
    // the arena's rendering can be screenshotted without needing a real
    // server-driven wave.
    debugSeedFlyingState: () => {
      flyingActive = true;
      flyingTimeLeftMs = 42000;
      flyingEnemies.set("dbg1", { id: "dbg1", x: 5, y: 3, renderX: 5, renderY: 3, hp: 2, maxHp: 3 });
      flyingEnemies.set("dbg2", { id: "dbg2", x: 10, y: 2, renderX: 10, renderY: 2, hp: 3, maxHp: 3 });
      flyingProjectiles.set("dbgp1", { id: "dbgp1", x: 8, y: 6 });
      flyingEnemyProjectiles.set("dbgep1", { id: "dbgep1", x: 6, y: 5 });
      flyingEnemyProjectiles.set("dbgep2", { id: "dbgep2", x: 11, y: 4 });
    },
    // Testing only: seed N enemies + a bunch of projectiles for a perf
    // stress test (the "4+ dragons laggy" report this redo fixed).
    debugSeedFlyingStress: (n) => {
      flyingActive = true;
      flyingTimeLeftMs = 42000;
      for (let i = 0; i < n; i++) {
        const x = 1 + (i % 8) * 1.8, y = 1 + Math.floor(i / 8) * 2;
        flyingEnemies.set(`stress${i}`, { id: `stress${i}`, x, y, renderX: x, renderY: y, hp: 2, maxHp: 3 });
      }
      for (let i = 0; i < n * 2; i++) {
        flyingProjectiles.set(`stressp${i}`, { id: `stressp${i}`, x: (i % 16), y: (i % 10) });
        flyingEnemyProjectiles.set(`stressep${i}`, { id: `stressep${i}`, x: (i % 16), y: 9 - (i % 10) });
      }
    },
    // Testing only: force the "bossIntro" beat (screech/stun + enemies
    // smoking away, see flying_boss_intro_start) so it can be screenshotted
    // without playing through a full wave-survival timer for real.
    debugForceFlyingBossIntro: () => {
      flyingActive = true;
      flyingPhase = "bossIntro";
      flyingBoss = null; // not revealed yet at this point in the real sequence
      const startTime = performance.now();
      flyingBossIntroFx = [
        { x: 4, y: 3, startTime },
        { x: 9, y: 2, startTime },
        { x: 12, y: 6, startTime },
      ];
      flyingEnemies.clear();
      flyingProjectiles.clear();
      flyingEnemyProjectiles.clear();
      const me = players.get(myId);
      if (me) me.stunVisualUntil = startTime + FLYING_BOSS_INTRO_MS;
    },
  };
})();
