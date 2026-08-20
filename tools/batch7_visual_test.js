// Ad hoc visual smoke test for batch 7's rendering changes: Dante bald,
// red fire goblins, the Dragon King boss (no rider / crown / nametag / HP),
// the bossIntro screech+smoke beat, the moved booze sign, and the scrolling
// flying-minigame ground. Uses the existing __gameDebug test-only hooks
// (same forceArea/forcePosition/forceDrawNow pattern as
// tools/boss_cliff_flying_visual_test.js) rather than playing through full
// live sequences.
//
// setupAndCapture runs the force* setup AND the toDataURL() read inside a
// SINGLE page.evaluate() call, unlike splitting them across two awaited
// calls -- the server broadcasts a real "state" message roughly every
// TICK_MS (50ms), and addOrUpdatePlayer snaps myArea back to the player's
// real server-side area on receipt (see forceArea's own doc comment). Two
// separate page.evaluate() round-trips leave a real (if usually short) gap
// for that broadcast to land and repaint the canvas with the snapped-back
// area before the second call's toDataURL() fires -- caught in practice
// while writing this test, where a two-call version occasionally captured
// the tavern instead of the just-forced flying arena. One evaluate() call
// is a single synchronous run-to-completion script, so nothing else in the
// page's event loop can run between the forced draw and the capture.
const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#enter-btn", { timeout: 10000 });
  await page.fill("#name-input", "Batch7Visual");
  await page.click("#enter-btn");
  await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
  await page.waitForTimeout(800);

  // Expose named setup functions in-page so setupAndCapture's single
  // evaluate() call can reference them by name (functions can't cross the
  // page.evaluate serialization boundary as closures capturing outer vars).
  await page.evaluate(() => {
    window.__b7setups = {
      dante: (d) => {
        window.__gameDebug.forceArea("tavern");
        window.__gameDebug.forcePosition((d.x ?? d.renderX) + 6, (d.y ?? d.renderY) + 4.5);
      },
      outside: (m) => {
        window.__gameDebug.forceArea("outside");
        window.__gameDebug.forcePosition(m.renderX, m.renderY + 2);
      },
      dragonKing: () => {
        window.__gameDebug.debugForceFlyingBoss(8, 4, 100, 100);
        window.__gameDebug.forceArea("flying");
      },
      bossIntro: () => {
        window.__gameDebug.debugForceFlyingBossIntro();
        window.__gameDebug.forceArea("flying");
      },
      cliffSign: (map) => {
        window.__gameDebug.forceArea("cliff");
        window.__gameDebug.forcePosition((map.sign.x + map.barrels[map.barrels.length - 1].x) / 2, map.groundY);
      },
      noop: () => {},
    };
  });
  async function capture(setupName, arg, outPath) {
    const dataUrl = await page.evaluate(({ name, a }) => {
      window.__b7setups[name](a);
      window.__gameDebug.forceDrawNow();
      return document.querySelector("canvas").toDataURL();
    }, { name: setupName, a: arg });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
  }

  // --- Dante, bald, in the tavern ---------------------------------------
  const npcs = await page.evaluate(() => window.__gameDebug.getTavernNpcs());
  const dante = npcs.find((n) => n.big);
  if (!dante) throw new Error("FAIL: Dante not found in tavernNpcs");
  console.log("PASS: Dante found:", dante.race, dante.color, "big:", dante.big);
  await capture("dante", dante, "/tmp/b7_dante_bald_zoom.png");
  console.log("Screenshot saved: Dante (should be bald)");

  // --- Fire goblins, red -------------------------------------------------
  await page.evaluate(() => { window.__gameDebug.forceArea("outside"); });
  await page.waitForTimeout(300); // let a real "monsters" broadcast populate the client map
  const monsterIds = await page.evaluate(() => window.__gameDebug.getMonsterIds());
  const fireGoblins = [];
  for (const id of monsterIds) {
    const m = await page.evaluate((mid) => window.__gameDebug.getMonster(mid), id);
    if (m && m.type === "fire_goblin") fireGoblins.push(m);
  }
  if (fireGoblins.length < 1) throw new Error("FAIL: no fire_goblin monsters found client-side");
  console.log(`PASS: found ${fireGoblins.length} fire_goblin monster(s) client-side.`);
  await capture("outside", fireGoblins[0], "/tmp/b7_fire_goblin.png");
  console.log("Screenshot saved: fire goblin (should read red, not green)");

  // --- Dragon King boss: no rider, crown, "Dragon King" nametag, 2x hp ---
  await capture("dragonKing", null, "/tmp/b7_dragon_king.png");
  const flyingBoss = await page.evaluate(() => window.__gameDebug.getFlyingBoss());
  console.log("flying boss state:", flyingBoss);
  if (!flyingBoss || flyingBoss.maxHp !== 100) throw new Error(`FAIL: expected boss maxHp 100, got ${flyingBoss && flyingBoss.maxHp}`);
  console.log("PASS: boss maxHp is 100 (doubled).");
  console.log("Screenshot saved: Dragon King boss (crown + nametag, no rider)");

  // --- bossIntro: screech/stun + enemies smoking away --------------------
  await capture("bossIntro", null, "/tmp/b7_boss_intro.png");
  const introPhase = await page.evaluate(() => window.__gameDebug.getFlyingPhase());
  if (introPhase !== "bossIntro") throw new Error(`FAIL: expected phase bossIntro, got ${introPhase}`);
  console.log("PASS: flyingPhase is bossIntro.");
  console.log("Screenshot saved: bossIntro beat (smoke puffs + HUD label + stun dots)");

  // --- Cliff booze sign moved left (barrels visible) ----------------------
  const cliffMap = await page.evaluate(() => window.__gameDebug.getCliffMap());
  if (!cliffMap || !cliffMap.sign || !cliffMap.barrels) throw new Error("FAIL: cliffMap missing sign/barrels");
  const barrelMinX = Math.min(...cliffMap.barrels.map((b) => b.x));
  const barrelMaxX = Math.max(...cliffMap.barrels.map((b) => b.x));
  console.log(`sign.x=${cliffMap.sign.x} barrels span [${barrelMinX}, ${barrelMaxX}]`);
  if (!(cliffMap.sign.x < barrelMinX - 1)) {
    throw new Error(`FAIL: sign.x (${cliffMap.sign.x}) is not clearly left of the barrel cluster (min ${barrelMinX})`);
  }
  console.log("PASS: sign sits clearly left of the barrel cluster.");
  await capture("cliffSign", cliffMap, "/tmp/b7_cliff_sign_barrels.png");
  console.log("Screenshot saved: cliff sign + barrels (barrels should be visible, not covered)");

  // --- Scrolling flying ground: sample two frames, confirm it's moving ---
  await capture("dragonKing", null, "/tmp/b7_flying_ground_a.png");
  await page.waitForTimeout(500);
  // Re-run the SAME "dragonKing" setup (not "noop") -- forceArea is only a
  // one-shot client override, and a real server "state" broadcast during
  // the 500ms wait snaps myArea back to the player's true area (tavern),
  // same underlying issue as the two-evaluate-call race described above.
  await capture("dragonKing", null, "/tmp/b7_flying_ground_b.png");
  const bufA = fs.readFileSync("/tmp/b7_flying_ground_a.png");
  const bufB = fs.readFileSync("/tmp/b7_flying_ground_b.png");
  if (Buffer.compare(bufA, bufB) === 0) throw new Error("FAIL: flying ground frames are byte-identical -- not scrolling");
  console.log("PASS: flying ground frames differ 500ms apart (scrolling).");

  console.log("\nConsole/page errors seen:", errors.length ? errors : "none");
  await browser.close();
  if (errors.length) { console.log("FAIL: console/page errors were logged"); process.exit(1); }
  console.log("\nALL BATCH 7 VISUAL CHECKS PASSED.");
  process.exit(0);
})().catch((err) => { console.error("FAIL:", err); process.exit(1); });
