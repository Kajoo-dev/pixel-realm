const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  const errors = [];
  async function newPage(label) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`[${label}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`[${label}] pageerror: ${err.message}`));
    await page.goto("http://localhost:3000/");
    return page;
  }

  const pageA = await newPage("A");
  await pageA.fill("#name-input", "Alice");
  await pageA.click('.swatch[data-color="red"]');
  await pageA.click("#enter-btn");
  await pageA.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 5000 });
  await pageA.waitForTimeout(300);

  const pageB = await newPage("B");
  await pageB.fill("#name-input", "Bob");
  await pageB.click('.swatch[data-color="teal"]');
  await pageB.click("#enter-btn");
  await pageB.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 5000 });
  await pageB.waitForTimeout(300);

  // Move Alice right + down for a bit so she's visibly walking/animated.
  await pageA.keyboard.down("KeyD");
  await pageA.keyboard.down("KeyS");
  await pageA.waitForTimeout(900);
  await pageA.keyboard.up("KeyD");
  await pageA.keyboard.up("KeyS");
  await pageA.waitForTimeout(400);

  await pageA.screenshot({ path: "/tmp/view_alice.png" });
  await pageB.screenshot({ path: "/tmp/view_bob.png" });

  // Check player count HUD on both.
  const countA = await pageA.textContent("#player-count");
  const countB = await pageB.textContent("#player-count");
  console.log("Player count seen by Alice:", countA);
  console.log("Player count seen by Bob:", countB);

  // Send a chat message from Bob, verify Alice receives it.
  await pageB.click("#chat-input");
  await pageB.fill("#chat-input", "hello from bob");
  await pageB.press("#chat-input", "Enter");
  await pageA.waitForTimeout(300);
  const chatText = await pageA.textContent("#chat-log");
  console.log("Alice chat log contains bob's message:", chatText.includes("hello from bob"));

  await pageA.screenshot({ path: "/tmp/view_alice_chat.png" });

  console.log("Console/page errors:", errors.length ? errors : "none");

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
