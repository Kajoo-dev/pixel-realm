const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto("http://localhost:3000/");
    return page;
  }
  async function enterWorld(page, name, color) {
    await page.fill("#name-input", name);
    await page.click(`.swatch[data-color="${color}"]`);
    await page.click("#enter-btn");
    await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  }

  const alice = await newPage();
  await enterWorld(alice, "Alice", "red");
  const bob = await newPage();
  await enterWorld(bob, "Bob", "teal");
  await alice.waitForTimeout(1000);
  await alice.screenshot({ path: "/tmp/view_ornate_card.png" });
  await browser.close();
})();
