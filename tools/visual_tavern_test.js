const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  const failedRequests = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  page.on("requestfailed", (req) => failedRequests.push(req.url() + " -- " + (req.failure() && req.failure().errorText)));
  page.on("response", (res) => { if (res.status() >= 400) failedRequests.push(res.url() + " -- HTTP " + res.status()); });

  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(400);

  await page.click('.race-option[data-race="human"]');
  await page.click('.swatch[data-color="orange"]');
  await page.fill("#name-input", "Visual");
  await page.click("#enter-btn");
  await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "/tmp/tavern_spawn.png" });
  console.log("captured tavern spawn screenshot");

  // Volume sliders visible
  const slidersVisible = await page.evaluate(() => {
    const w = document.getElementById("volume-widget");
    return w && !w.classList.contains("hidden");
  });
  console.log("volume sliders visible:", slidersVisible);

  // Move the slider and confirm the JS state updates (no crash).
  await page.evaluate(() => {
    const s = document.getElementById("music-volume-slider");
    s.value = 30;
    s.dispatchEvent(new Event("input"));
  });
  await page.waitForTimeout(100);

  // Walk down and out the tavern door.
  await page.keyboard.down("KeyS");
  await page.waitForTimeout(2500);
  await page.keyboard.up("KeyS");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/tavern_exit_outside.png" });
  const areaAfterExit = await page.evaluate(() => window.__gameDebug.getMyArea ? window.__gameDebug.getMyArea() : "unknown");
  console.log("area after walking out:", areaAfterExit);

  // Ground tile seam check: walk around a bit on open grass and screenshot closely.
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1500);
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/outside_ground_tiles.png" });

  console.log("console/page errors:", errors.length ? errors : "none");
  console.log("failed network requests:", failedRequests.length ? failedRequests : "none");

  await browser.close();
})();
