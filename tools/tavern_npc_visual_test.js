// Visual smoke test for the tavern patrons (task #47): confirms they arrive
// client-side via the "tavern_npcs" broadcast and screenshots the tavern
// (the player's default starting area, no forceArea needed) so the wandering
// crowd + oversized dancer can be checked by eye.
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
  const npcs = await page.evaluate(() => window.__gameDebug.getTavernNpcs());
  console.log("tavern NPCs seen client-side:", npcs.length, npcs.map((n) => `${n.race}_${n.color}${n.big ? "(big)" : ""}`));
  if (npcs.length !== 7) throw new Error(`FAIL: expected 7 tavern NPCs (6 patrons + 1 dancer), got ${npcs.length}`);
  const dancer = npcs.find((n) => n.big);
  if (!dancer) throw new Error("FAIL: no oversized dancer NPC found client-side");
  console.log("PASS: dancer present client-side:", dancer.race, dancer.color);

  await page.waitForTimeout(1200); // let a couple of dance flips + a bit of patron wandering happen
  await saveCanvasPng(page, "/tmp/tavern_npcs.png");
  console.log("Screenshot saved: tavern with patrons + dancer");

  console.log("\nConsole/page errors seen:", errors.length ? errors : "none");
  await browser.close();
  if (errors.length) { console.log("FAIL: console/page errors were logged"); process.exit(1); }
  console.log("\nALL TAVERN NPC VISUAL CHECKS PASSED.");
  process.exit(0);
})().catch((err) => { console.error("FAIL:", err); process.exit(1); });
