const { chromium } = require("playwright");
const FAKE_MEDIA_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: FAKE_MEDIA_ARGS });

  async function newPage(vp) {
    const context = await browser.newContext({ permissions: ["microphone"], viewport: vp || { width: 900, height: 600 } });
    const page = await context.newPage();
    await page.goto("http://localhost:3000/");
    return page;
  }
  async function enterWorld(page, name, color) {
    await page.fill("#name-input", name);
    await page.click(`.swatch[data-color="${color}"]`);
    await page.click("#enter-btn");
    await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  }

  const alice = await newPage();
  await enterWorld(alice, "Alice", "red");
  const bob = await newPage();
  await enterWorld(bob, "Bob", "teal");
  const carol = await newPage();
  await enterWorld(carol, "Carol", "purple");
  await alice.waitForTimeout(1000);

  // Move Carol out ~16-17 tiles so her card shows the fade effect while
  // Bob's stays fully opaque up close. Nudge diagonally partway through
  // in case a tree/rock blocks a straight line.
  await carol.keyboard.down("KeyD");
  await carol.waitForTimeout(1800);
  await carol.keyboard.up("KeyD");
  await carol.keyboard.down("KeyS");
  await carol.waitForTimeout(400);
  await carol.keyboard.up("KeyS");
  await carol.keyboard.down("KeyD");
  await carol.waitForTimeout(1800);
  await carol.keyboard.up("KeyD");
  await alice.waitForTimeout(600);
  const carolId = await carol.evaluate(() => window.__gameDebug.getMyId());
  console.log("Carol pos:", await carol.evaluate((id) => window.__gameDebug.getPlayerPos(id), carolId));

  await alice.screenshot({ path: "/tmp/view_nearby_panel.png" });
  console.log("cards:", JSON.stringify(await alice.evaluate(() => window.__gameDebug.getNearbyCards())));

  await browser.close();
})();
