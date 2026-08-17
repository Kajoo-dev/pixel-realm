const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/view_login.png" });
  await browser.close();
})();
