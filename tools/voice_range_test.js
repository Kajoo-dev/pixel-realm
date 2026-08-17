// Verifies: (1) voice volume is full out to 10 tiles, falls off linearly
// to 0 at 20 tiles; (2) the nearby-players panel shows/fades/hides in
// sync with that same 20-tile range; (3) the viewport never shows more
// than 40 tiles across regardless of window size.
const { chromium } = require("playwright");

const FAKE_MEDIA_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: FAKE_MEDIA_ARGS });

  async function newPage(label, viewport) {
    const context = await browser.newContext({ permissions: ["microphone"], viewport: viewport || { width: 900, height: 600 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log(`[${label} pageerror]`, err.message));
    await page.goto("http://localhost:3000/");
    return page;
  }
  async function enterWorld(page, name, color) {
    await page.fill("#name-input", name);
    await page.click(`.swatch[data-color="${color}"]`);
    await page.click("#enter-btn");
    await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  }
  async function moveFor(page, key, ms) {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    await page.waitForTimeout(400); // let volume/panel loops (150ms) catch up
  }

  // Static obstacles (trees/rocks) can stall a straight-line walk. Nudge
  // through by alternating the primary direction with a perpendicular
  // tap whenever progress stalls, until the player's own distance from
  // their start point reaches targetTiles (or we give up after maxMs).
  async function moveUntilDistance(page, primaryKey, perpKey, targetTiles, maxMs) {
    const myId = await page.evaluate(() => window.__gameDebug.getMyId());
    const start = await page.evaluate((id) => window.__gameDebug.getPlayerPos(id), myId);
    const t0 = Date.now();
    let lastDist = 0;
    let stallTicks = 0;
    while (Date.now() - t0 < maxMs) {
      await page.keyboard.down(primaryKey);
      await page.waitForTimeout(400);
      await page.keyboard.up(primaryKey);
      const pos = await page.evaluate((id) => window.__gameDebug.getPlayerPos(id), myId);
      const dist = Math.hypot(pos.x - start.x, pos.y - start.y);
      if (dist >= targetTiles) return dist;
      if (dist - lastDist < 0.3) {
        stallTicks += 1;
        if (stallTicks >= 2) {
          // Stuck against an obstacle: nudge sideways then resume.
          await page.keyboard.down(perpKey);
          await page.waitForTimeout(300);
          await page.keyboard.up(perpKey);
          stallTicks = 0;
        }
      } else {
        stallTicks = 0;
      }
      lastDist = dist;
    }
    const finalPos = await page.evaluate((id) => window.__gameDebug.getPlayerPos(id), myId);
    return Math.hypot(finalPos.x - start.x, finalPos.y - start.y);
  }

  let allPass = true;
  function check(label, cond) {
    console.log((cond ? "PASS" : "FAIL") + ": " + label);
    if (!cond) allPass = false;
  }

  // --- View cap test (single client, huge viewport) ---
  console.log("\n=== View distance cap ===");
  const wide = await newPage("Wide", { width: 3840, height: 2160 });
  await enterWorld(wide, "Widey", "orange");
  await wide.waitForTimeout(300);
  const bigTiles = await wide.evaluate(() => window.__gameDebug.getVisibleTiles());
  console.log("At 3840x2160, visible tiles:", JSON.stringify(bigTiles));
  check("visible tiles capped at 40 wide on a huge monitor", bigTiles.w <= 40.01);
  check("visible tiles capped at 40 tall on a huge monitor", bigTiles.h <= 40.01);

  const small = await newPage("Small", { width: 900, height: 600 });
  await enterWorld(small, "Smally", "pink");
  await small.waitForTimeout(300);
  const smallTiles = await small.evaluate(() => window.__gameDebug.getVisibleTiles());
  console.log("At 900x600, visible tiles:", JSON.stringify(smallTiles));
  check("small window still well under the cap (nominal zoom preserved)", smallTiles.w < 30);

  // Disconnect the view-cap clients so they don't linger in the world and
  // contaminate the voice/nearby-panel test below (which assumes exactly
  // one other player: Bob).
  await wide.context().close();
  await small.context().close();

  // --- Voice range + nearby panel test (two clients, normal viewport) ---
  console.log("\n=== Voice range + nearby panel ===");
  const alice = await newPage("Alice");
  await enterWorld(alice, "Alice", "red");
  const bob = await newPage("Bob");
  await enterWorld(bob, "Bob", "teal");
  await alice.waitForTimeout(1500);

  let info = await alice.evaluate(() => window.VoiceChat.debugInfo());
  check("at spawn (~0 tiles), volume is full", info.length && info[0].volume >= 0.99);
  let cards = await alice.evaluate(() => window.__gameDebug.getNearbyCards());
  console.log("Nearby cards at spawn:", JSON.stringify(cards));
  check("nearby card visible at spawn with full opacity", cards.length === 1 && cards[0].name === "Bob" && Number(cards[0].opacity) >= 0.99);

  // Move Bob out to roughly the middle of the falloff zone (~15 tiles from spawn).
  console.log("Moving Bob ~15 tiles away...");
  let traveled = await moveUntilDistance(bob, "KeyD", "KeyS", 15, 15000);
  await alice.waitForTimeout(400);
  console.log("Bob traveled ~", traveled.toFixed(1), "tiles");
  info = await alice.evaluate(() => window.VoiceChat.debugInfo());
  console.log("Volume at ~15 tiles:", info[0] && info[0].volume);
  check("volume partially attenuated in the 10-20 tile falloff zone", info.length && info[0].volume > 0.05 && info[0].volume < 0.95);
  cards = await alice.evaluate(() => window.__gameDebug.getNearbyCards());
  console.log("Nearby cards at ~15 tiles:", JSON.stringify(cards));
  check("nearby card still present around ~15 tiles", cards.length === 1);

  // Move Bob well past 20 tiles.
  console.log("Moving Bob further, past 22 tiles total...");
  traveled = await moveUntilDistance(bob, "KeyD", "KeyS", 22, 15000);
  await alice.waitForTimeout(400);
  console.log("Bob traveled ~", traveled.toFixed(1), "tiles");
  info = await alice.evaluate(() => window.VoiceChat.debugInfo());
  console.log("Volume past 20 tiles:", info[0] && info[0].volume);
  check("volume is 0/muted past 20 tiles", info.length && info[0].volume === 0 && info[0].muted);
  cards = await alice.evaluate(() => window.__gameDebug.getNearbyCards());
  console.log("Nearby cards past 20 tiles:", JSON.stringify(cards));
  check("nearby card is gone past 20 tiles", cards.length === 0);

  // Move Bob back close (walk left toward Alice's position, which hasn't moved).
  console.log("Moving Bob back close...");
  const bobId = await bob.evaluate(() => window.__gameDebug.getMyId());
  const aliceId = await alice.evaluate(() => window.__gameDebug.getMyId());
  const aliceHome = await alice.evaluate((id) => window.__gameDebug.getPlayerPos(id), aliceId);
  let stall = 0, lastD = 999;
  for (let i = 0; i < 25; i++) {
    await bob.keyboard.down("KeyA");
    await bob.waitForTimeout(400);
    await bob.keyboard.up("KeyA");
    const pos = await bob.evaluate((id) => window.__gameDebug.getPlayerPos(id), bobId);
    const d = Math.hypot(pos.x - aliceHome.x, pos.y - aliceHome.y);
    if (d < 8) break;
    if (Math.abs(d - lastD) < 0.3) {
      stall += 1;
      if (stall >= 2) {
        await bob.keyboard.down("KeyS");
        await bob.waitForTimeout(300);
        await bob.keyboard.up("KeyS");
        stall = 0;
      }
    } else {
      stall = 0;
    }
    lastD = d;
  }
  await alice.waitForTimeout(400);
  info = await alice.evaluate(() => window.VoiceChat.debugInfo());
  console.log("Volume after returning:", info[0] && info[0].volume);
  check("volume recovers to full when back within 10 tiles", info.length && info[0].volume >= 0.9);
  cards = await alice.evaluate(() => window.__gameDebug.getNearbyCards());
  check("nearby card reappears with high opacity when close again", cards.length === 1 && Number(cards[0].opacity) >= 0.9);

  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
