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
  // 8/9 are the cave floor/wall tiles and 10/11 are the tavern wall/floor
  // tiles, so the two extra shimmer frames live at 12/13.
  const WATER_FRAME_TILE_INDEX = [3, 12, 13];
  const WATER_FRAME_MS = 550;
  const NUM_GROUND_TILE_IDS = 12; // grass..tavern_floor (0-11) -- real map tile ids, used for edge-blend color sampling

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

  // Edge-dither tile blend mask (see tools/gen_assets.py edge_dither_mask.png):
  // a small alpha-only strip tinted per-neighboring-tile-color at load time
  // and stamped along tile borders so the ground doesn't read as a hard grid.
  const EDGE_W = TILE, EDGE_H = 6;

  // Dragon boss sprites: much larger than the small monsters, 4 tiles wide
  // by ~3 tiles high, with 3 separate 2-frame sheets (walk / claw / fire)
  // selected per-frame based on its current action.
  const DRAGON_CW = 88, DRAGON_CH = 68, DRAGON_FRAMES = 2;
  const DRAGON_ATTACK_ANIM_MS = 450; // just under the server's 500ms attack cooldown

  // ---------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------
  const MUSIC_TRACKS = ["music_adventure1", "music_adventure2", "music_adventure3"];
  const TAVERN_MUSIC_TRACK = "music_tavern";
  const MUSIC_VOLUME = 0.32;
  const SWOOSH_VOLUME = 0.5;
  const FOOTSTEP_VOLUME = 0.22;
  const CLANG_VOLUME = 0.6;
  const DRAGON_ROAR_VOLUME = 0.7; // not distance-attenuated -- reads as an epic, everywhere-audible cue
  const FOOTSTEP_INTERVAL_MS = 300; // roughly one tiny "tip-toe" tap per step cycle
  const SFX_MAX_DISTANCE = 16; // tiles: remote sword/footstep sfx fade out past this range

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
  let worldMap = null; // { width, height, grid, collision, tavernDoorTile } -- the outside world
  let tavernMap = null; // { width, height, grid, collision, doorTile, decor } -- the tavern interior
  let myArea = "tavern"; // "tavern" | "outside" -- which map/coordinate space I'm currently in
  function activeMap() { return myArea === "tavern" ? tavernMap : worldMap; }
  let swordState = { held: false, holderId: null, x: 0, y: 0 }; // the shared flaming sword item
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
  let tilesetReady = false;
  const edgeTintCanvases = {}; // tile id -> offscreen canvas, built once the tileset image is loaded
  let edgeTintsReady = false;

  /** id -> { name, color, race, x, y, dir, moving, hp, maxHp, dead,
   *          renderX, renderY, targetX, targetY, animT, swingAngle, swingStart } */
  const players = new Map();
  /** id -> { type, x, y, dir, moving, hp, maxHp, renderX, renderY, targetX,
   *          targetY, animT, attackFlashUntil } */
  const monsters = new Map();
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
    let remaining = colorsAndRaces.length + monsterTypes.length + 11;
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
      colorsAndRaces.forEach(([race, color]) => {
        const img = new Image();
        img.onload = done; img.onerror = done;
        img.src = `/assets/race_${race}_${color}.png`;
        charSprites[`${race}_${color}`] = img;
      });
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
        myArea = init.you.area || "tavern";
        swordState = init.swordState || swordState;
        iAmDead = false;
        deathBanner.classList.add("hidden");
        players.clear();
        monsters.clear();
        init.players.forEach((p) => addOrUpdatePlayer(p, true));
        (init.monsters || []).forEach((m) => addOrUpdateMonster(m, true));

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
      e = { renderX: p.x, renderY: p.y, animT: 0, swingAngle: 0, swingStart: -99999, hitFlashUntil: 0, nextFootstepAt: 0, area: p.area };
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
    e.targetX = p.x;
    e.targetY = p.y;
    // Area transitions teleport between two entirely different coordinate
    // spaces (tavern grid vs. outside world grid) -- always snap on one,
    // never lerp across them, or the entity would appear to fly across the
    // whole map for a frame.
    if (snap || areaChanged) { e.renderX = p.x; e.renderY = p.y; }
    if (p.id === myId && areaChanged) {
      myArea = p.area;
      refreshMusicForArea();
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
    e.targetX = m.x;
    e.targetY = m.y;
    if (snap) { e.renderX = m.x; e.renderY = m.y; }
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
  // Defaults match the sliders' initial HTML values (70 / 80).
  let musicVolumeFactor = 0.7;
  let sfxVolumeFactor = 0.8;
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
  // randomized outdoor adventure-track rotation.
  function playTavernMusic() {
    bgMusicEl.removeEventListener("ended", playNextMusicTrack);
    bgMusicEl.loop = true;
    bgMusicEl.src = `/assets/audio/${TAVERN_MUSIC_TRACK}.mp3`;
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
        const name = document.createElement("div");
        name.className = "nearby-name";
        const race = document.createElement("div");
        race.className = "nearby-race";
        nameWrap.appendChild(name);
        nameWrap.appendChild(race);
        card.appendChild(avatar);
        card.appendChild(nameWrap);
        card._avatarEl = avatar;
        card._raceEl = race;
        nearbyCards.set(id, card);
      }
      if (card._raceCache !== `${p.race}_${p.color}`) {
        card._avatarEl.style.cssText = avatarStyle(p.race, p.color);
        card._raceCache = `${p.race}_${p.color}`;
      }
      card.style.setProperty("--pcolor", COLOR_HEX[p.color] || "#c49a2a");
      card.querySelector(".nearby-name").textContent = p.name;
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

  function predictLocal(dt) {
    const me = players.get(myId);
    if (!me) return;
    if (me.dead || iAmDead) { me.moving = false; return; }
    let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    const moving = dx !== 0 || dy !== 0;
    me.moving = moving;
    if (moving) {
      if (dx !== 0 && dy !== 0) { const inv = 1 / Math.SQRT2; dx *= inv; dy *= inv; }
      if (Math.abs(dx) > Math.abs(dy)) me.dir = dx > 0 ? "right" : "left";
      else if (dy !== 0) me.dir = dy > 0 ? "down" : "up";

      const step = SPEED * dt;
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

    // Warm light glows (tavern lanterns/door, or the tavern building's door
    // seen from outside) render under everything else -- a soft backdrop
    // rather than an occluding sprite.
    drawAreaLightGlows(camX, camY);

    // Trees overflow upward past their own tile and characters vary in
    // height, so everything that can occlude / be occluded gets merged
    // into one Y-sorted pass keyed on each thing's "ground" position.
    const visiblePlayers = [...players.values()].filter((p) => p.area === myArea);
    const visibleMonsters = myArea === "outside" ? [...monsters.values()] : [];
    const drawables = [
      ...treeCells.map((t) => ({ kind: "tree", sortY: t.row + 1, row: t.row, col: t.col })),
      ...visiblePlayers.map((p) => ({ kind: "player", sortY: p.renderY, p })),
      ...visibleMonsters.map((m) => ({ kind: "monster", sortY: m.renderY, m })),
      ...deathFx.map((fx) => ({ kind: "deathfx", sortY: fx.y, fx })),
    ];
    if (myArea === "tavern" && tavernMap && tavernMap.decor) {
      tavernMap.decor.barrels.forEach((b) => drawables.push({ kind: "barrel", sortY: b.y, b }));
    }
    if (myArea === "outside" && !swordState.held) {
      drawables.push({ kind: "sworditem", sortY: swordState.y });
    }
    drawables.sort((a, b) => a.sortY - b.sortY);
    for (const item of drawables) {
      if (item.kind === "tree") drawTreeAt(item.col, item.row, camX, camY, now);
      else if (item.kind === "player") drawPlayer(item.p, camX, camY, now);
      else if (item.kind === "monster") drawMonster(item.m, camX, camY, now);
      else if (item.kind === "barrel") drawBarrelAt(item.b, camX, camY);
      else if (item.kind === "sworditem") drawGroundFlamingSword(camX, camY, now);
      else drawDeathFx(item.fx, camX, camY, now);
    }

    // Prune finished death effects after drawing this frame.
    for (let i = deathFx.length - 1; i >= 0; i--) {
      if (now - deathFx[i].startTime > DEATH_FX_MS) deathFx.splice(i, 1);
    }

    updateBirds(now, camX, camY);
    drawBirds(camX, camY);
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

  function drawAreaLightGlows(camX, camY) {
    if (myArea === "tavern" && tavernMap && tavernMap.decor) {
      tavernMap.decor.lights.forEach((l) => drawGlowAt(l.x, l.y, camX, camY, 1.3, 0.45));
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

      if (p.hitFlashUntil && now < p.hitFlashUntil) {
        ctx.save();
        ctx.filter = "brightness(1.8) saturate(0.4)";
        ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H, screenX, screenY, dispW, dispH);
        ctx.restore();
      } else {
        ctx.drawImage(img, sx, sy, CHAR_NATIVE_W, CHAR_NATIVE_H, screenX, screenY, dispW, dispH);
      }
    }

    drawSwordSwing(p, footX, footY - dispH * 0.42, now);

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

  function drawMonster(m, camX, camY, now) {
    if (m.type === "dragon") { drawDragon(m, camX, camY, now); return; }
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
    const label = "Dragon";
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
    getMyId: () => myId,
    getMyArea: () => myArea,
    getBirdCount: () => birds.length,
    forceSpawnBird: () => { nextBirdAt = 0; },
    getPlayerHp: (id) => { const p = players.get(id); return p ? { hp: p.hp, maxHp: p.maxHp, dead: p.dead } : null; },
    getMonsterCount: () => monsters.size,
    getMonster: (id) => { const m = monsters.get(id); return m ? { ...m } : null; },
    getMonsterIds: () => [...monsters.keys()],
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
  };
})();
