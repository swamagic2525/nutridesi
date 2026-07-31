// Watchdog: run by launchd every 5 minutes. Checks the bot is reachable from
// the internet; WhatsApp-alerts Swapnil on failure. Supports both Twilio
// (sandbox) and Meta Cloud API (WABA) for sending alerts — uses whichever
// is configured. Max one alert per hour per problem.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const PUBLIC_URL = process.env.PUBLIC_URL;
const ALERT_PHONE = process.env.ALERT_PHONE;
const STATE = "/tmp/nutridesi-healthcheck-state.json";
const COOLDOWN_MS = 60 * 60 * 1000;
// The local fallback is noisier by design, so it repeats sooner than the
// remote one — an ongoing outage should keep nagging.
const LOCAL_COOLDOWN_MS = 15 * 60 * 1000;
const LOCAL_ALERT_LOG = path.join(os.homedir(), "Library", "Logs", "nutridesi-alerts.log");
// Nothing here may hang: launchd reruns this every 5 minutes, and a stuck
// instance means no checks at all. Observed 31 Jul — a DNS failure left the
// script wedged and the log had a 62-minute hole.
const SEND_TIMEOUT_MS = 20 * 1000;
const HARD_EXIT_MS = 90 * 1000;

const useMeta = !!(process.env.META_WA_TOKEN && process.env.META_WA_PHONE_NUMBER_ID);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch (e) {
    console.error("healthcheck: state write failed:", e.message);
  }
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (t.unref) t.unref();
  }),
]);

// Alert path of last resort. Every remote channel needs DNS and internet —
// precisely what dies in the outage this watchdog exists to catch. On 31 Jul
// the tunnel was down for 78 minutes and both alert attempts failed with
// ENOTFOUND, so nothing surfaced until a user noticed. This writes locally
// instead: a durable log line plus a desktop notification with a sound.
function localAlert(key, text) {
  const line = `${new Date().toISOString()} [${key}] ${text}`;
  try {
    fs.appendFileSync(LOCAL_ALERT_LOG, line + "\n");
  } catch (e) {
    console.error("healthcheck: local alert log failed:", e.message);
  }
  try {
    execFileSync("osascript", ["-e",
      `display notification ${JSON.stringify(text)} with title "NutriDesi ALERT" sound name "Basso"`,
    ], { timeout: 5000, stdio: "ignore" });
  } catch (e) {
    console.error("healthcheck: desktop notification failed:", e.message);
  }
  console.error(new Date().toISOString(), "LOCAL ALERT:", text);
}

async function alertViaMeta(text) {
  const phoneId = process.env.META_WA_PHONE_NUMBER_ID;
  const token = process.env.META_WA_TOKEN;
  const to = ALERT_PHONE.replace("+", "");
  const resp = await fetch(`https://graph.facebook.com/v23.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Graph API ${resp.status}: ${body}`);
  }
}

async function alertViaTwilio(text) {
  const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const alertFrom = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || "+14155238886"}`;
  await client.messages.create({ from: alertFrom, to: `whatsapp:${ALERT_PHONE}`, body: text });
}

async function alert(key, text) {
  const state = loadState();
  const now = Date.now();
  // Cooldown applies to a *delivered* remote alert. It used to be stamped
  // before the send was attempted and never rolled back, so one failed send
  // silenced the next hour of retries — the failure mode made itself worse.
  if (state[key] && now - state[key] < COOLDOWN_MS) return;

  let delivered = false;
  try {
    await withTimeout(useMeta ? alertViaMeta(text) : alertViaTwilio(text),
      SEND_TIMEOUT_MS, "alert send");
    state[key] = now;
    delivered = true;
    console.log(new Date().toISOString(), "ALERT SENT:", text);
  } catch (e) {
    console.error(new Date().toISOString(), "alert send failed:", e.message);
  }

  // Remote is unreachable — fall back to something that cannot be.
  if (!delivered) {
    const localKey = `${key}:local`;
    if (!(state[localKey] && now - state[localKey] < LOCAL_COOLDOWN_MS)) {
      localAlert(key, text);
      state[localKey] = now;
    }
  }
  saveState(state);
}

// Backstop: if anything below wedges anyway, die rather than occupy the slot.
const hardExit = setTimeout(() => {
  console.error(new Date().toISOString(), `healthcheck: exceeded ${HARD_EXIT_MS}ms, exiting`);
  process.exit(1);
}, HARD_EXIT_MS);
if (hardExit.unref) hardExit.unref();

(async () => {
  let ok = false;
  try {
    const r = await fetch(PUBLIC_URL, { signal: AbortSignal.timeout(10000) });
    ok = r.ok;
  } catch {}
  if (!ok) {
    await alert("down", "\u{1F6A8} NutriDesi is unreachable from the internet — tunnel or server is down on the Mac Mini. Users are getting silence.");
  } else {
    console.log(new Date().toISOString(), "healthcheck ok");
  }

  if (!useMeta && process.env.TWILIO_ACCOUNT_SID) {
    try {
      const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const b = await withTimeout(client.balance.fetch(), SEND_TIMEOUT_MS, "balance fetch");
      if (Number(b.balance) < 5) {
        await alert("balance", `⚠️ Twilio balance low: $${Number(b.balance).toFixed(2)}. Top up before replies start failing.`);
      }
    } catch (e) {
      console.error("balance check failed:", e.message);
    }
  }
  clearTimeout(hardExit);
})();
