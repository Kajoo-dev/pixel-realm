// Visual smoke test for the tavern patrons + party gating (task #58):
// confirms the bar starts EMPTY (only Dante, standing still) before the
// dragon-flight minigame has been completed, then (via the debugForceTavernParty
// test hook, since driving a full flying-minigame completion here would be
// heavy) confirms the full 16-patron crowd + Dante dancing renders without
// errors, screenshotting both states so they can be checked by eye. The real
// server-side spawn/race-split/one-way-latch logic is covered thoroughly by
// tools/tavern_npc_test.js (in-process, against the real startTavernParty) --
// this test is about the CLIENT rendering (nametag/speech bubble/arm-wave/
// party lights) staying crash-free and looking right.
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

  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#enter-btn", { timeout: 10000 });
  await page.fill("#name-input", "TavernNpcVisual");
  await page.click("#enter-btn");
  await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });

  await page.waitForFunction(() => window.__gameDebug.getTavernNpcs().length > 0, { timeout: 5000 });
  const before = await page.evaluate(() => window.__gameDebug.getTavernNpcs());
  console.log("tavern NPCs before the party:", before.length, before.map((n) => `${n.race}_${n.color}${n.big ? "(big)" : ""}${n.dancing ? "[dancing]" : ""}`));
  if (before.length !== 1) throw new Error(`FAIL: expected just Dante (1 NPC) before the party starts, got ${before.length}`);
  const dante = before[0];
  if (!dante.big) throw new Error("FAIL: the sole pre-party NPC should be the big NPC (Dante)");
  if (dante.dancing) throw new Error("FAIL: Dante should NOT be dancing before the party starts");
  console.log("PASS: bar starts empty except for Dante, standing still.");

  await page.waitForTimeout(400); // let his idle-intro speech bubble render at least once
  await saveCanvasPng(page, "/tmp/tavern_before_party.png");
  console.log("Screenshot saved: tavern before the party (empty bar, Dante + intro bubble)");

  // Force the party state (16 patrons + Dante dancing) and grab a screenshot
  // AND the post-force NPC list in one atomic evaluate -- see
  // debugForceTavernParty's doc comment for why the state-forcing, the
  // draw, and reading the result all need to happen in the same synchronous
  // task (a real incoming "state"/"tavern_npcs" broadcast can otherwise land
  // between two separate evaluate() round-trips and wipe the client-only
  // fake patrons before the second one reads them back -- a real observed
  // flake, not hypothetical, when the two were split into separate calls).
  const { dataUrl, after } = await page.evaluate(() => {
    window.__gameDebug.debugForceTavernParty();
    window.__gameDebug.forceDrawNow();
    return {
      dataUrl: document.querySelector("canvas").toDataURL(),
      after: window.__gameDebug.getTavernNpcs(),
    };
  });
  fs.writeFileSync("/tmp/tavern_party.png", Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));

  console.log("tavern NPCs after forcing the party:", after.length);
  if (after.length !== 17) throw new Error(`FAIL: expected 17 tavern NPCs (16 patrons + Dante) after the party starts, got ${after.length}`);
  const danceAfter = after.find((n) => n.big);
  if (!danceAfter || !danceAfter.dancing) throw new Error("FAIL: Dante should be dancing once the party starts");
  console.log("PASS: full 16-patron crowd + dancing Dante render without errors.");
  console.log("Screenshot saved: tavern party (16 patrons, Dante dancing, nametag/bubble/arm-wave/lights)");

  console.log("\nConsole/page errors seen:", errors.length ? errors : "none");
  await browser.close();
  if (errors.length) { console.log("FAIL: console/page errors were logged"); process.exit(1); }
  console.log("\nALL TAVERN NPC VISUAL CHECKS PASSED.");
  process.exit(0);
})().catch((err) => { console.error("FAIL:", err); process.exit(1); });
