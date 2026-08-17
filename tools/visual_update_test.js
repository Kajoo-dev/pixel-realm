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
  await page.screenshot({ path: "/tmp/v2_login.png" });

  await page.click('.race-option[data-race="human"]');
  await page.click('.swatch[data-color="teal"]');
  await page.fill("#name-input", "Scout");
  await page.click("#enter-btn");
  await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "/tmp/v2_ingame_spawn.png" });

  // Sword swing visual + audio trigger.
  await page.evaluate(() => window.__gameDebug.forceAttack(0));
  await page.waitForTimeout(90);
  await page.screenshot({ path: "/tmp/v2_sword_swing.png" });

  // Move the player around briefly to trigger footstep sfx + tree rendering
  // across a wider area, then screenshot again.
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1500);
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/v2_after_walk.png" });

  const monsterCount = await page.evaluate(() => window.__gameDebug.getMonsterCount());
  const monsterIds = await page.evaluate(() => window.__gameDebug.getMonsterIds());
  console.log("monster count:", monsterCount, "ids:", monsterIds.slice(0, 5));

  console.log("console/page errors:", errors.length ? errors : "none");
  console.log("failed network requests:", failedRequests.length ? failedRequests : "none");

  await browser.close();
})();
