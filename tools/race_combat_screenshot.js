const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(400); // let portraits load
  await page.screenshot({ path: "/tmp/view_login_dirtywood.png" });

  // Pick orc + purple, then enter world.
  await page.click('.race-option[data-race="orc"]');
  await page.click('.swatch[data-color="purple"]');
  await page.fill("#name-input", "Grognak");
  await page.click("#enter-btn");
  await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/view_ingame_orc.png" });

  const raceInPayload = await page.evaluate(() => window.__gameDebug.getSelectedRace());
  console.log("selected race sent:", raceInPayload);

  const hp = await page.evaluate(() => window.__gameDebug.getPlayerHp(window.__gameDebug.getMyId()));
  console.log("player hp:", JSON.stringify(hp));

  const monsterCount = await page.evaluate(() => window.__gameDebug.getMonsterCount());
  console.log("visible/tracked monster count:", monsterCount);

  // Force-attack toward a fixed angle to visually confirm the sword swing renders.
  await page.evaluate(() => window.__gameDebug.forceAttack(0));
  await page.waitForTimeout(90);
  await page.screenshot({ path: "/tmp/view_sword_swing.png" });

  console.log("console/page errors:", errors.length ? errors : "none");
  await browser.close();
})();
