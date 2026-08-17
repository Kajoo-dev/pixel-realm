// Confirms tree sway and water shimmer actually change over time (not
// just present in a single static frame) by diffing canvas pixel data
// from the same screen region at two different moments.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto("http://localhost:3000/");
  await page.fill("#name-input", "Alice");
  await page.click('.swatch[data-color="red"]');
  await page.click("#enter-btn");
  await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  await page.waitForTimeout(500);

  // Walk toward the tree cluster west of spawn so trees are on-screen.
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(1500);
  await page.keyboard.up("KeyA");
  await page.waitForTimeout(300);

  async function grabCanvasHash() {
    return page.evaluate(() => {
      const canvas = document.getElementById("game-canvas");
      // Sample the full canvas as a small downscaled snapshot for a cheap diff.
      const off = document.createElement("canvas");
      off.width = 200; off.height = 140;
      const octx = off.getContext("2d");
      octx.drawImage(canvas, 0, 0, off.width, off.height);
      return octx.getImageData(0, 0, off.width, off.height).data.join(",");
    });
  }

  const frame1 = await grabCanvasHash();
  await page.waitForTimeout(900); // roughly one tree-sway period
  const frame2 = await grabCanvasHash();
  await page.waitForTimeout(900);
  const frame3 = await grabCanvasHash();

  const diff12 = frame1 !== frame2;
  const diff23 = frame2 !== frame3;
  console.log("Frame 1 vs 2 differ:", diff12);
  console.log("Frame 2 vs 3 differ:", diff23);
  console.log(diff12 && diff23 ? "PASS: scene visibly animates over time (tree sway / water shimmer / bird)." : "FAIL: no visible change between frames.");

  await browser.close();
  process.exit(diff12 && diff23 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
