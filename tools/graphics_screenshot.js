const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  await page.goto("http://localhost:3000/");
  await page.fill("#name-input", "Alice");
  await page.click('.swatch[data-color="red"]');
  await page.click("#enter-btn");
  await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });

  // Walk toward the trees near spawn (west along the path, then look
  // around) so the screenshot actually has trees/rocks/water in frame.
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(1500);
  await page.keyboard.up("KeyA");
  await page.waitForTimeout(300);

  await page.screenshot({ path: "/tmp/view_graphics_1.png" });

  // Force a bird to spawn immediately for the screenshot instead of
  // waiting out the random ~20-40s timer.
  await page.evaluate(() => window.__gameDebug.forceSpawnBird());
  await page.waitForTimeout(2200);
  await page.screenshot({ path: "/tmp/view_graphics_bird.png" });

  console.log("bird count:", await page.evaluate(() => window.__gameDebug.getBirdCount()));
  console.log("console/page errors:", errors.length ? errors : "none");

  await browser.close();
})();
