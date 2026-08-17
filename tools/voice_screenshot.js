const { chromium } = require("playwright");

const FAKE_MEDIA_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: FAKE_MEDIA_ARGS });
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 900, height: 600 } });
  const page = await context.newPage();
  await page.goto("http://localhost:3000/");
  await page.fill("#name-input", "Alice");
  await page.click('.swatch[data-color="red"]');
  await page.click("#enter-btn");
  await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  await page.waitForTimeout(1500); // let mic status settle to "live"
  await page.screenshot({ path: "/tmp/view_voice_widget.png" });
  await browser.close();
})();
