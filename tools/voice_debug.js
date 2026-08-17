const { chromium } = require("playwright");

const FAKE_MEDIA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: FAKE_MEDIA_ARGS,
  });

  async function newPage(label) {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    page.on("console", (msg) => console.log(`[${label} console:${msg.type()}]`, msg.text()));
    page.on("pageerror", (err) => console.log(`[${label} pageerror]`, err.message));
    await page.goto("http://localhost:3000/");
    return page;
  }

  async function enterWorld(page, name, color) {
    await page.fill("#name-input", name);
    await page.click(`.swatch[data-color="${color}"]`);
    await page.click("#enter-btn");
    await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  }

  const alice = await newPage("Alice");
  await enterWorld(alice, "Alice", "red");
  const bob = await newPage("Bob");
  await enterWorld(bob, "Bob", "teal");

  await alice.waitForTimeout(3000);

  const aliceInfo = await alice.evaluate(() => window.VoiceChat.debugInfo());
  const bobInfo = await bob.evaluate(() => window.VoiceChat.debugInfo());
  console.log("Alice debugInfo:", JSON.stringify(aliceInfo, null, 2));
  console.log("Bob debugInfo:", JSON.stringify(bobInfo, null, 2));

  const aliceHasMic = await alice.evaluate(() => window.VoiceChat.hasMic());
  const bobHasMic = await bob.evaluate(() => window.VoiceChat.hasMic());
  console.log("Alice hasMic:", aliceHasMic, "Bob hasMic:", bobHasMic);

  await browser.close();
})();
