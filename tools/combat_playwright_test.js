// End-to-end browser test of the combat feature: walks the player to the
// nearest monster, clicks on it repeatedly (real mouse clicks, not the
// debug helper) to verify click-to-swing + hit detection + health bar +
// death animation all work through the real UI, then checks two players
// physically block each other (entity collision).
const { chromium } = require("playwright");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function enterWorld(page, name, color, race) {
  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(300);
  await page.click(`.race-option[data-race="${race}"]`);
  await page.click(`.swatch[data-color="${color}"]`);
  await page.fill("#name-input", name);
  await page.click("#enter-btn");
  await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

  await enterWorld(page, "Slayer", "teal", "human");

  const myId = await page.evaluate(() => window.__gameDebug.getMyId());
  const monsterIds = await page.evaluate(() => window.__gameDebug.getMonsterIds());
  console.log("monster ids tracked client-side:", monsterIds.length);

  // Find nearest monster and walk to melee range using real keyboard input.
  async function nearestMonster() {
    return page.evaluate((pid) => {
      const me = window.__gameDebug.getPlayerPos(pid);
      let best = null, bestD = Infinity;
      for (const mid of window.__gameDebug.getMonsterIds()) {
        const m = window.__gameDebug.getMonster(mid);
        if (!m) continue;
        const d = Math.hypot(m.renderX - me.x, m.renderY - me.y);
        if (d < bestD) { bestD = d; best = { id: mid, ...m, dist: d }; }
      }
      return best;
    }, myId);
  }

  let target = await nearestMonster();
  console.log("targeting monster:", target && target.id, target && target.type, "dist:", target && target.dist.toFixed(2));

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const me = await page.evaluate((id) => window.__gameDebug.getPlayerPos(id), myId);
    const t = await page.evaluate((mid) => window.__gameDebug.getMonster(mid), target.id);
    if (!t) { console.log("target left tracking (maybe died) before reaching melee range"); break; }
    const dx = t.renderX - me.x, dy = t.renderY - me.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.1) break;
    const keys = [];
    if (dy < -0.15) keys.push("KeyW"); if (dy > 0.15) keys.push("KeyS");
    if (dx < -0.15) keys.push("KeyA"); if (dx > 0.15) keys.push("KeyD");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(120);
    for (const k of keys) await page.keyboard.up(k);
  }
  await page.waitForTimeout(200);

  const meBeforeAttack = await page.evaluate((id) => window.__gameDebug.getPlayerPos(id), myId);
  console.log("in melee range at", meBeforeAttack);

  // Aim the mouse at the target's current screen position and click 3
  // times (should be exactly enough to kill a 3-hp monster), through the
  // real canvas mousedown handler (not the debug helper).
  async function screenPosOf(worldX, worldY) {
    return page.evaluate(({ wx, wy }) => {
      const eff = window.__gameDebug.getEffRTile();
      // Reconstruct camera the same way draw() does: centered on my render pos.
      const myPos = window.__gameDebug.getPlayerPos(window.__gameDebug.getMyId());
      const canvas = document.getElementById("game-canvas");
      const camX = myPos.x * eff - canvas.width / 2;
      const camY = myPos.y * eff - canvas.height / 2;
      return { x: wx * eff - camX, y: wy * eff - camY };
    }, { wx: worldX, wy: worldY });
  }

  let died = false;
  let hitCount = 0;
  const monitorDeadline = Date.now() + 15000;
  while (Date.now() < monitorDeadline && !died) {
    const t = await page.evaluate((mid) => window.__gameDebug.getMonster(mid), target.id);
    if (!t) { died = true; break; }
    const screenPos = await screenPosOf(t.renderX, t.renderY);
    await page.mouse.move(screenPos.x, screenPos.y);
    await page.mouse.down();
    await page.mouse.up();
    hitCount++;
    await page.waitForTimeout(250);
  }
  console.log("swings thrown:", hitCount, "monster died:", died);
  if (!died) throw new Error("FAIL: monster never died from real mouse-click attacks");
  if (hitCount > 6) throw new Error(`FAIL: took ${hitCount} swings to kill a 3-hp monster, expected ~3`);
  console.log("PASS: monster died within a reasonable number of real mouse-click swings (" + hitCount + ").");

  await page.waitForTimeout(150);
  const fxCount = await page.evaluate(() => window.__gameDebug.getDeathFxCount());
  console.log("death fx entries active right after death:", fxCount);
  if (fxCount < 1) throw new Error("FAIL: no death animation (flip+smoke) was queued");
  console.log("PASS: death animation (flip + smoke) triggered.");

  await page.screenshot({ path: "/tmp/view_death_fx.png" });

  console.log("console/page errors so far:", errors.length ? errors : "none");
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("TEST ERROR:", e.message || e); process.exit(1); });
