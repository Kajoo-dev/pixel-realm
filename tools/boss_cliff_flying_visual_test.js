// Visual smoke test for the three newest rendering paths: the giant boss
// goblin (cavern), the post-boss cliff area, and the flying minigame arena.
// Uses the existing __gameDebug.forceArea/forcePosition/forceDrawNow
// test-only hooks (same forceArea pattern as tools/cavern_visual_test.js,
// extended with a synchronous forceDrawNow so the forced state can't be
// stomped mid-way by one of the server's own ~20Hz "state" broadcasts --
// see the hook's comment in game.js) rather than actually fighting through
// the whole level live. Checks console/pageerror/asset 404s and saves
// screenshots for a manual look.
//
// Screenshots are captured via canvas.toDataURL() (read synchronously,
// in-page) rather than page.screenshot() (an async CDP round-trip). The
// latter was found to be racy here: even right after forceDrawNow() paints
// the forced area synchronously, page.screenshot()'s own async compositor
// capture can land AFTER the game's normal rAF loop has already redrawn one
// more frame using a since-snapped-back myArea (the server's next "state"
// broadcast reports the player's real, unchanged area and snaps myArea back
// via addOrUpdatePlayer -- see forceArea's comment). toDataURL() reads
// whatever is on the canvas bitmap at the exact moment it's called, with no
// such gap, so it reliably reflects the just-forced draw.
const { chromium } = require("playwright");
const fs = require("fs");

async function saveCanvasPng(page, outPath) {
  const dataUrl = await page.evaluate(() => document.querySelector("canvas").toDataURL());
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  page.on("requestfailed", (req) => {
    if (req.url().includes("/assets/cavern_boss") || req.url().includes("/assets/cliff_bg")) {
      errors.push(`FAILED REQUEST: ${req.url()} -- ${req.failure() && req.failure().errorText}`);
    }
  });

  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#enter-btn", { timeout: 10000 });
  await page.fill("#name-input", "BossCliffFlyVisual");
  await page.click("#enter-btn");
  await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
  await page.waitForTimeout(800);

  // --- Boss render, in the cavern, framed on the real live boss instance --
  const bossState = await page.evaluate(() => window.__gameDebug.getBossState());
  console.log("boss state from live server:", bossState);
  if (!bossState) throw new Error("FAIL: no boss_goblin found in cavernMonsters -- boss did not spawn");
  console.log("PASS: boss instance exists server-side with hp", bossState.hp, "/", bossState.maxHp);

  await page.evaluate((boss) => {
    // getBossState() reads the client's own cavernMonsters entry, which
    // stores render-interpolated renderX/renderY (+ targetX/targetY), not
    // raw x/y -- see addOrUpdateCavernMonster.
    window.__gameDebug.forceArea("cavern");
    window.__gameDebug.forcePosition(boss.renderX - 3, boss.renderY);
    window.__gameDebug.forceDrawNow();
  }, bossState);
  await saveCanvasPng(page, "/tmp/boss_live.png");
  console.log("Screenshot saved: boss live render");

  // --- Cliff area -----------------------------------------------------------
  const cliffMap = await page.evaluate(() => window.__gameDebug.getCliffMap());
  console.log("cliffMap loaded client-side:", !!cliffMap, cliffMap);
  if (!cliffMap) throw new Error("FAIL: cliffMap was not populated client-side from the join ack");
  console.log("PASS: cliffMap populated client-side.");

  if (!cliffMap.barrels || cliffMap.barrels.length < 1) throw new Error("FAIL: no booze barrels in cliffMap");
  if (!cliffMap.sign || !cliffMap.sign.text) throw new Error("FAIL: no booze warning sign in cliffMap");
  console.log("PASS: cliffMap includes booze barrels + warning sign:", cliffMap.sign.text);

  await page.evaluate((map) => {
    window.__gameDebug.forceArea("cliff");
    window.__gameDebug.forcePosition(map.sign.x, map.groundY);
    // "When you first appear on the cliff edge..." arrival speech bubble --
    // see debugForceCliffArrivalBubble's doc comment.
    window.__gameDebug.debugForceCliffArrivalBubble();
    window.__gameDebug.forceDrawNow();
  }, cliffMap);
  await saveCanvasPng(page, "/tmp/cliff_area.png");
  console.log("Screenshot saved: cliff area (booze barrels + sign + arrival speech bubble)");

  // --- Flying minigame arena -------------------------------------------------
  await page.evaluate(() => {
    window.__gameDebug.debugSeedFlyingState();
    window.__gameDebug.forceArea("flying");
    window.__gameDebug.forceDrawNow();
  });
  await saveCanvasPng(page, "/tmp/flying_arena.png");
  console.log("Screenshot saved: flying minigame arena");

  console.log("\nConsole/page errors seen:", errors.length ? errors : "none");
  await browser.close();
  if (errors.length) { console.log("FAIL: console/page errors were logged"); process.exit(1); }
  console.log("\nALL BOSS/CLIFF/FLYING VISUAL CHECKS PASSED.");
  process.exit(0);
})().catch((err) => { console.error("FAIL:", err); process.exit(1); });
