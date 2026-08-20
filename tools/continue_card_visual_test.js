// Visual + interaction smoke test for the entry screen's "Continue as X"
// card (see checkSavedCharacter/getOrCreatePlayerId in game.js and the
// /api/character/:id route in index.js):
//   - a browser with NO saved playerId sees the normal fresh-character form
//   - a browser with a saved character sees the "Continue as X" card
//     (portrait/name/level), pre-populated, form hidden
//   - "Start a new character instead" swaps to the form (pre-filled)
//   - "Continue my saved character instead" swaps back
//   - clicking Continue actually joins as the saved character (name/level
//     restored, no login-overlay error)
const { chromium } = require("playwright");
const { io } = require("socket.io-client");
const fs = require("fs");

const URL = "http://localhost:3000";
let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}

function seedCharacter(playerId, name, color, race, killMult) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ["polling", "websocket"] });
    const timeout = setTimeout(() => reject(new Error("seed join timeout")), 8000);
    socket.on("connect", () => {
      socket.emit("join", { playerId, name, color, race }, () => {
        clearTimeout(timeout);
        setTimeout(() => { socket.disconnect(); resolve(); }, 400); // let the disconnect-flush save land
      });
    });
    socket.on("connect_error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

(async () => {
  const savedPlayerId = "visual-" + Date.now();
  await seedCharacter(savedPlayerId, "Zoraltha", "purple", "elf");
  console.log("PASS: seeded a saved character server-side for the visual test.");

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

  // --- Case 1: no saved playerId -> normal fresh-character form. --------
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#enter-btn", { timeout: 10000 });
    await page.waitForTimeout(500); // let checkSavedCharacter's fetch resolve
    const continueHidden = await page.evaluate(() => document.getElementById("continue-card").classList.contains("hidden"));
    const formHidden = await page.evaluate(() => document.getElementById("new-character-form").classList.contains("hidden"));
    check(continueHidden, "no saved character -> continue-card stays hidden");
    check(!formHidden, "no saved character -> new-character-form is visible");
    await page.screenshot({ path: "/tmp/continue_case1_fresh.png" });
    await page.close();
  }

  // --- Case 2: a saved playerId in localStorage -> Continue card shown,
  // populated, form hidden. ------------------------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    // Seed localStorage BEFORE any page script runs, via an init script.
    await page.addInitScript((id) => { localStorage.setItem("pixelRealmPlayerId", id); }, savedPlayerId);
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    // #enter-btn itself may legitimately be hidden here (the continue-card
    // is expected to be shown instead) -- wait on the overlay itself.
    await page.waitForSelector("#login-overlay", { timeout: 10000 });
    await page.waitForTimeout(600); // let checkSavedCharacter's fetch resolve

    const state = await page.evaluate(() => ({
      continueHidden: document.getElementById("continue-card").classList.contains("hidden"),
      formHidden: document.getElementById("new-character-form").classList.contains("hidden"),
      name: document.getElementById("continue-name").textContent,
      sub: document.getElementById("continue-sub").textContent,
      avatarBg: document.getElementById("continue-avatar").style.backgroundImage,
    }));
    console.log("continue-card state:", state);
    check(!state.continueHidden, "saved character -> continue-card is visible");
    check(state.formHidden, "saved character -> new-character-form is hidden");
    check(state.name === "Zoraltha", `continue-card shows the saved name (got "${state.name}")`);
    check(state.sub.includes("Elf") && state.sub.includes("1"), `continue-card shows race + level (got "${state.sub}")`);
    check(state.avatarBg.includes("race_elf_purple.png"), `continue-avatar uses the saved race/color sprite (got "${state.avatarBg}")`);
    await page.screenshot({ path: "/tmp/continue_case2_populated.png" });

    // --- Toggle: "Start a new character instead" -> form shown, pre-filled.
    await page.click("#new-character-link");
    await page.waitForTimeout(150);
    const toggled = await page.evaluate(() => ({
      continueHidden: document.getElementById("continue-card").classList.contains("hidden"),
      formHidden: document.getElementById("new-character-form").classList.contains("hidden"),
      nameValue: document.getElementById("name-input").value,
      backLinkHidden: document.getElementById("back-to-continue-link").classList.contains("hidden"),
    }));
    check(toggled.continueHidden, "\"Start a new character instead\" hides the continue-card");
    check(!toggled.formHidden, "\"Start a new character instead\" shows the form");
    check(toggled.nameValue === "Zoraltha", `the fresh-character form is pre-filled with the saved name (got "${toggled.nameValue}")`);
    check(!toggled.backLinkHidden, "a \"back to continue\" link appears once toggled away");
    await page.screenshot({ path: "/tmp/continue_case3_toggled_to_form.png" });

    // --- Toggle back. -------------------------------------------------
    await page.click("#back-to-continue-link");
    await page.waitForTimeout(150);
    const toggledBack = await page.evaluate(() => ({
      continueHidden: document.getElementById("continue-card").classList.contains("hidden"),
      formHidden: document.getElementById("new-character-form").classList.contains("hidden"),
    }));
    check(!toggledBack.continueHidden, "toggling back re-shows the continue-card");
    check(toggledBack.formHidden, "toggling back re-hides the form");

    // --- Actually click Continue and confirm it joins as the saved
    // character (this exercises the real doJoin/continueSaved path end to
    // end through the browser, not just the HTTP display endpoint). -------
    await page.click("#continue-btn");
    await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
    const joined = await page.evaluate(() => {
      const me = window.__gameDebug ? window.__gameDebug.getPlayerHp(window.__gameDebug.getMyId()) : null;
      return {
        loginHidden: document.getElementById("login-overlay").classList.contains("hidden"),
        errorText: document.getElementById("login-error").textContent,
        selfName: document.getElementById("self-name").textContent,
        selfLevel: document.getElementById("self-level-badge").textContent,
      };
    });
    console.log("post-continue join state:", joined);
    check(joined.loginHidden, "clicking Continue actually joins (login overlay hides)");
    check(!joined.errorText, `no login error after continuing (got "${joined.errorText}")`);
    check(joined.selfName === "Zoraltha", `the in-game self-portrait shows the restored name (got "${joined.selfName}")`);
    check(joined.selfLevel === "Lv.1", `the in-game self-portrait shows the restored level (got "${joined.selfLevel}")`);
    await page.screenshot({ path: "/tmp/continue_case4_joined.png" });
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S).` : "\nALL CONTINUE-CARD VISUAL/INTERACTION CHECKS PASSED.");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error("FAIL:", err); process.exit(1); });
