// Regression test for "keep the player's selected race/color model in the
// cave side-scroller" (task #50, re-verified after a user report that it
// "still isn't using the correct player models"): joins as each of the 4
// races through the real login UI, forces into the cavern, and asserts the
// rendered pixels actually differ race-to-race (not just filename
// bookkeeping) -- catches both a wrong-lookup regression AND an
// art-generation regression where every race secretly renders identically.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const races = ["human", "elf", "orc", "goblin"];
  const shots = {};
  let failures = 0;
  function check(cond, msg) {
    if (cond) console.log("PASS:", msg);
    else { console.log("FAIL:", msg); failures++; }
  }

  for (const race of races) {
    const page = await browser.newPage({ viewport: { width: 300, height: 200 } });
    await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#enter-btn", { timeout: 10000 });
    // Real UI clicks (not debug hooks) so this also exercises the actual
    // login flow the user goes through.
    await page.click(`.race-option[data-race="${race}"]`);
    await page.click('.swatch[data-color="red"]');
    await page.fill("#name-input", "CavernRace_" + race);
    await page.click("#enter-btn");
    await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
    await page.waitForTimeout(300);

    const dataUrl = await page.evaluate(() => {
      window.__gameDebug.forceArea("cavern");
      window.__gameDebug.forcePosition(10, 20);
      window.__gameDebug.forceDrawNow();
      // Crop tightly around the player's own sprite (centered on the forced
      // position) so the fingerprint isn't diluted by identical background
      // tiles/torches.
      const canvas = document.querySelector("canvas");
      const cx = canvas.width / 2, cy = canvas.height / 2;
      const crop = document.createElement("canvas");
      crop.width = 40; crop.height = 60;
      crop.getContext("2d").drawImage(canvas, cx - 20, cy - 55, 40, 60, 0, 0, 40, 60);
      return crop.toDataURL();
    });
    shots[race] = dataUrl;
    await page.close();
  }

  // Every pair of races must render visibly different cropped sprites.
  for (let i = 0; i < races.length; i++) {
    for (let j = i + 1; j < races.length; j++) {
      const a = races[i], b = races[j];
      check(shots[a] !== shots[b], `${a} and ${b} render visibly different cavern sprites`);
    }
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL CAVERN RACE MODEL CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})();
