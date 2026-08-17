// Verifies proximity voice chat: two simulated clients (fake mic/audio
// devices) connect, establish a WebRTC peer connection to each other,
// and the received-audio volume falls as they move apart and recovers
// as they move back together.
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

  const errors = [];
  async function newPage(label) {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`[${label}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`[${label}] pageerror: ${err.message}`));
    await page.goto("http://localhost:3000/");
    return page;
  }

  async function enterWorld(page, name, color) {
    await page.fill("#name-input", name);
    await page.click(`.swatch[data-color="${color}"]`);
    await page.click("#enter-btn");
    await page.waitForFunction(() => document.getElementById("login-overlay").classList.contains("hidden"), { timeout: 8000 });
  }

  console.log("Launching Alice and Bob with fake mic/audio devices...");
  const alice = await newPage("Alice");
  await enterWorld(alice, "Alice", "red");
  const bob = await newPage("Bob");
  await enterWorld(bob, "Bob", "teal");

  console.log("Waiting for WebRTC peer connection to establish...");
  let connected = false;
  for (let i = 0; i < 20; i++) {
    const info = await alice.evaluate(() => window.VoiceChat.debugInfo());
    if (info.length && info[0].connectionState === "connected") { connected = true; break; }
    await alice.waitForTimeout(500);
  }
  console.log(connected ? "PASS: peer connection established." : "FAIL: peer connection never reached 'connected'.");

  const closeInfo = await alice.evaluate(() => window.VoiceChat.debugInfo());
  console.log("At spawn (both near center), Alice's view of Bob:", JSON.stringify(closeInfo));
  const closeVolumeOk = closeInfo.length && closeInfo[0].volume > 0.85 && !closeInfo[0].muted;
  console.log(closeVolumeOk ? "PASS: volume near-full at close range." : "FAIL: expected volume close to 1 near spawn.");

  console.log("Moving Bob away (holding right ~4s)...");
  await bob.keyboard.down("KeyD");
  await bob.waitForTimeout(4000);
  await bob.keyboard.up("KeyD");
  await bob.waitForTimeout(500); // let the volume loop (150ms) catch up

  const farInfo = await alice.evaluate(() => window.VoiceChat.debugInfo());
  console.log("After moving apart, Alice's view of Bob:", JSON.stringify(farInfo));
  const farVolumeOk = farInfo.length && farInfo[0].volume <= 0.05 && farInfo[0].muted;
  console.log(farVolumeOk ? "PASS: volume drops to (near) zero and mutes past range." : "FAIL: expected volume ~0 and muted at distance.");

  console.log("Moving Bob back (holding left ~4s)...");
  await bob.keyboard.down("KeyA");
  await bob.waitForTimeout(4000);
  await bob.keyboard.up("KeyA");
  await bob.waitForTimeout(500);

  const backInfo = await alice.evaluate(() => window.VoiceChat.debugInfo());
  console.log("After moving back, Alice's view of Bob:", JSON.stringify(backInfo));
  const backVolumeOk = backInfo.length && backInfo[0].volume > 0.5;
  console.log(backVolumeOk ? "PASS: volume recovers on return." : "FAIL: expected volume to recover when close again.");

  console.log("Console/page errors:", errors.length ? errors : "none");

  const allPass = connected && closeVolumeOk && farVolumeOk && backVolumeOk;
  await browser.close();
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
