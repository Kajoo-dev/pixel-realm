// Visual smoke test for the cavern depths side-scroller client rendering:
// log in, force the client into the cavern area (via the test-only
// __gameDebug.forceArea hook, since actually killing the dragon live is a
// long respawn-heavy fight this session has already decided to avoid --
// see tools/cavern_transition_test.js), place the player at the entrance,
// and a goblin/troll nearby, then screenshot + check for console errors.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  page.on("requestfailed", (req) => {
    if (req.url().includes("/assets/cavern")) errors.push(`FAILED REQUEST: ${req.url()} -- ${req.failure() && req.failure().errorText}`);
  });

  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#enter-btn", { timeout: 10000 });
  await page.fill("#name-input", "CavernVisual");
  await page.click("#enter-btn");
  await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
  await page.waitForTimeout(800);

  const cavernMap = await page.evaluate(() => window.__gameDebug.getCavernMap());
  console.log("cavernMap loaded client-side:", !!cavernMap, cavernMap && cavernMap.platforms.length, "platforms");
  if (!cavernMap) throw new Error("FAIL: cavernMap was not populated client-side from the join ack");
  console.log("PASS: cavernMap populated client-side.");

  // Force into the cavern, standing near the entrance. The server keeps
  // broadcasting the player's REAL area ("tavern", since we never did an
  // actual server-side transition) every tick, and addOrUpdatePlayer syncs
  // myArea from that broadcast -- so a one-off forceArea() call gets
  // stomped back within ~50ms. Keep re-forcing it on an interval for the
  // duration of this visual-only test instead.
  await page.evaluate(() => {
    // Force every animation frame (not setInterval) so it always wins the
    // race against the server's ~50ms "state" broadcasts, which otherwise
    // flip myArea back to "tavern" (the player's real, unchanged area)
    // moments after each forceArea() call.
    function pump() { window.__gameDebug.forceArea("cavern"); window.__cavernForceRaf = requestAnimationFrame(pump); }
    pump();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/cavern_entrance.png" });
  console.log("Screenshot saved: cavern entrance");

  // Move right and jump a few times to pass near platforms/goblins/trolls,
  // then screenshot mid-level too.
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(600);
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1200);
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/cavern_midlevel.png" });
  console.log("Screenshot saved: cavern mid-level");

  // Crouch + jump (drop-through) and a sword swing, for the animation rows.
  await page.keyboard.down("KeyS");
  await page.waitForTimeout(100);
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  await page.keyboard.up("KeyS");
  await page.mouse.click(700, 400);
  await page.waitForTimeout(150);
  await page.screenshot({ path: "/tmp/cavern_action.png" });
  console.log("Screenshot saved: cavern action (swing)");

  const grounded = await page.evaluate(() => window.__gameDebug.isGrounded());
  console.log("grounded state after moving around:", grounded);

  if (errors.length) {
    console.log("CONSOLE/REQUEST ERRORS:", errors);
    throw new Error("FAIL: console or asset-request errors were logged: " + errors.join(" | "));
  }
  console.log("PASS: no console errors or failed cavern asset requests.");

  console.log("\nALL CAVERN VISUAL CHECKS COMPLETE.");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
