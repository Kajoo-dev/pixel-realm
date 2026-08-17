(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const TILE = 16;              // native tile px in the sheet
  const RENDER_SCALE = 2;       // on-screen scale factor
  const RTILE = TILE * RENDER_SCALE;
  const CHAR_W = 16, CHAR_H = 16, FRAMES = 3;
  const DIR_ROW = { down: 0, left: 1, right: 2, up: 3 };
  const SPEED = 4.5;            // tiles/sec, must match server
  const PLAYER_RADIUS = 0.32;
  const ANIM_FPS = 6;
  const REMOTE_LERP = 0.35;     // smoothing factor per frame for remote players
  const LOCAL_CORRECT_LERP = 0.15;

  const COLOR_HEX = {
    red: "#d6403a", blue: "#3a6cd6", green: "#429e54", yellow: "#deb630",
    purple: "#8c46be", teal: "#30aaaa", orange: "#e67e22", pink: "#e66ea0",
  };

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------
  const canvas = document.getElementById("game-canvas");
  const ctx = canvas.getContext("2d");
  const loginOverlay = document.getElementById("login-overlay");
  const nameInput = document.getElementById("name-input");
  const swatchesEl = document.getElementById("swatches");
  const enterBtn = document.getElementById("enter-btn");
  const loginError = document.getElementById("login-error");
  const loginStatus = document.getElementById("login-status");
  const hud = document.getElementById("hud");
  const playerCountEl = document.getElementById("player-count");
  const chatLog = document.getElementById("chat-log");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const chatHint = document.getElementById("chat-hint");

  let selectedColor = "blue";
  const COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];
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

  // ---------------------------------------------------------------------
  // Networking state
  // ---------------------------------------------------------------------
  let socket = null;
  let myId = null;
  let map = null; // { width, height, grid, collision }
  const sprites = {}; // color -> Image
  let tilesetImg = new Image();
  let tilesetReady = false;

  /** id -> { name, color, x, y, dir, moving, renderX, renderY, targetX, targetY } */
  const players = new Map();

  const input = { up: false, down: false, left: false, right: false };
  let lastSentInput = "";

  function preloadSprites(colors) {
    let remaining = colors.length + 1;
    return new Promise((resolve) => {
      const done = () => { remaining -= 1; if (remaining <= 0) resolve(); };
      tilesetImg.onload = done;
      tilesetImg.onerror = done;
      tilesetImg.src = "/assets/tileset.png";
      colors.forEach((c) => {
        const img = new Image();
        img.onload = done;
        img.onerror = done;
        img.src = `/assets/char_${c}.png`;
        sprites[c] = img;
      });
    });
  }

  // ---------------------------------------------------------------------
  // Login flow
  // ---------------------------------------------------------------------
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") enterBtn.click();
  });

  enterBtn.addEventListener("click", async () => {
    const name = (nameInput.value || "Wanderer").trim().slice(0, 16);
    loginError.textContent = "";
    loginStatus.textContent = "Connecting…";
    enterBtn.disabled = true;

    socket = io({ transports: ["websocket", "polling"] });

    socket.on("connect_error", () => {
      loginStatus.textContent = "";
      loginError.textContent = "Couldn't reach the server. Retrying…";
      enterBtn.disabled = false;
    });

    socket.on("connect", () => {
      socket.emit("join", { name, color: selectedColor }, async (init) => {
        myId = init.you.id;
        map = init.map;
        await preloadSprites(init.colors || COLORS);
        tilesetReady = true;

        players.clear();
        init.players.forEach((p) => addOrUpdatePlayer(p, true));

        loginOverlay.classList.add("hidden");
        hud.classList.remove("hidden");
        chatLog.classList.remove("hidden");
        chatForm.classList.remove("hidden");
        chatHint.classList.remove("hidden");

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

    socket.on("chat", (msg) => addChatLine(msg.name, msg.text, false));

    socket.on("disconnect", () => {
      loginOverlay.classList.remove("hidden");
      hud.classList.add("hidden");
      loginStatus.textContent = "";
      loginError.textContent = "Disconnected from server.";
      enterBtn.disabled = false;
    });
  });

  function addOrUpdatePlayer(p, snap) {
    let e = players.get(p.id);
    if (!e) {
      e = { renderX: p.x, renderY: p.y, animT: 0 };
      players.set(p.id, e);
    }
    e.name = p.name;
    e.color = p.color;
    e.dir = p.dir;
    e.moving = p.moving;
    e.targetX = p.x;
    e.targetY = p.y;
    if (snap) { e.renderX = p.x; e.renderY = p.y; }
  }

  function updateCount() {
    playerCountEl.textContent = String(players.size);
  }

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
  // Local prediction (mirrors server movement/collision rules)
  // ---------------------------------------------------------------------
  function isBlocked(tx, ty) {
    if (!map) return true;
    if (tx < 0 || ty < 0 || ty >= map.height || tx >= map.width) return true;
    return map.collision[ty][tx] === 1;
  }
  function canStandAt(x, y) {
    const r = PLAYER_RADIUS;
    return (
      !isBlocked(Math.floor(x - r), Math.floor(y - r)) &&
      !isBlocked(Math.floor(x + r), Math.floor(y - r)) &&
      !isBlocked(Math.floor(x - r), Math.floor(y + r)) &&
      !isBlocked(Math.floor(x + r), Math.floor(y + r))
    );
  }

  function predictLocal(dt) {
    const me = players.get(myId);
    if (!me) return;
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
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resizeCanvas);

  function draw() {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#16233a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!map || !tilesetReady) return;

    const me = players.get(myId);
    const camX = me ? me.renderX * RTILE - canvas.width / 2 : 0;
    const camY = me ? me.renderY * RTILE - canvas.height / 2 : 0;

    const startCol = Math.max(0, Math.floor(camX / RTILE) - 1);
    const endCol = Math.min(map.width - 1, Math.ceil((camX + canvas.width) / RTILE) + 1);
    const startRow = Math.max(0, Math.floor(camY / RTILE) - 1);
    const endRow = Math.min(map.height - 1, Math.ceil((camY + canvas.height) / RTILE) + 1);

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const tIdx = map.grid[row][col];
        const sx = tIdx * TILE;
        const dx = Math.round(col * RTILE - camX);
        const dy = Math.round(row * RTILE - camY);
        ctx.drawImage(tilesetImg, sx, 0, TILE, TILE, dx, dy, RTILE, RTILE);
      }
    }

    // Sort players by Y for correct draw order (further back drawn first).
    const list = [...players.values()].sort((a, b) => a.renderY - b.renderY);
    for (const p of list) {
      drawPlayer(p, camX, camY);
    }
  }

  function drawPlayer(p, camX, camY) {
    const img = sprites[p.color] || sprites.blue;
    if (!img) return;
    const row = DIR_ROW[p.dir] ?? 0;
    let frame = 1; // idle/neutral frame
    if (p.moving) {
      p.animT = (p.animT || 0) + 1;
      frame = Math.floor(p.animT / (60 / ANIM_FPS / 2)) % FRAMES;
    } else {
      p.animT = 0;
    }
    const sx = frame * CHAR_W;
    const sy = row * CHAR_H;

    const screenX = Math.round(p.renderX * RTILE - camX - RTILE / 2);
    const screenY = Math.round(p.renderY * RTILE - camY - RTILE / 2 - RTILE * 0.15);

    ctx.drawImage(img, sx, sy, CHAR_W, CHAR_H, screenX, screenY, RTILE, RTILE);

    // Name tag
    const label = p.name + (p.id === myId ? " (you)" : "");
    ctx.font = "bold 12px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const tagX = screenX + RTILE / 2;
    const tagY = screenY - 6;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(8,12,20,0.55)";
    ctx.fillRect(tagX - w / 2 - 5, tagY - 13, w + 10, 17);
    ctx.fillStyle = p.id === myId ? "#f4d35e" : "#e8eefc";
    ctx.fillText(label, tagX, tagY);
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
    draw();
    requestAnimationFrame(loop);
  }
})();
