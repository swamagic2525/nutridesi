// Watchdog: run by launchd every 5 minutes. Checks the bot is reachable from
// the internet and Twilio balance isn't running dry; WhatsApp-alerts Swapnil
// on failure. Alerts via Twilio's API directly, so they work even when the
// tunnel/server is what's down. Max one alert per hour per problem.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");

const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PUBLIC_URL = process.env.PUBLIC_URL || "https://carless-dining-croak.ngrok-free.dev";
const ALERT_TO = `whatsapp:${process.env.ALERT_PHONE}`;
const ALERT_FROM = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || "+14155238886"}`;
const STATE = "/tmp/nutridesi-healthcheck-state.json";
const COOLDOWN_MS = 60 * 60 * 1000;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}

async function alert(key, text) {
  const state = loadState();
  if (state[key] && Date.now() - state[key] < COOLDOWN_MS) return;
  state[key] = Date.now();
  fs.writeFileSync(STATE, JSON.stringify(state));
  try {
    await client.messages.create({ from: ALERT_FROM, to: ALERT_TO, body: text });
    console.log(new Date().toISOString(), "ALERT SENT:", text);
  } catch (e) {
    console.error(new Date().toISOString(), "alert send failed:", e.message);
  }
}

(async () => {
  // 1. Is the bot reachable from the internet (tunnel + server)?
  let ok = false;
  try {
    const r = await fetch(PUBLIC_URL, { signal: AbortSignal.timeout(10000) });
    ok = r.ok;
  } catch {}
  if (!ok) {
    await alert("down", "🚨 NutriDesi is unreachable from the internet — tunnel or server is down on the Mac Mini. Users are getting silence.");
  } else {
    console.log(new Date().toISOString(), "healthcheck ok");
  }

  // 2. Twilio balance running low?
  try {
    const b = await client.balance.fetch();
    if (Number(b.balance) < 5) {
      await alert("balance", `⚠️ Twilio balance low: $${Number(b.balance).toFixed(2)}. Top up before replies start failing.`);
    }
  } catch (e) {
    console.error("balance check failed:", e.message);
  }
})();
