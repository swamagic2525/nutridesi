// Watchdog: run by launchd every 5 minutes. Checks the bot is reachable from
// the internet; WhatsApp-alerts Swapnil on failure. Supports both Twilio
// (sandbox) and Meta Cloud API (WABA) for sending alerts — uses whichever
// is configured. Max one alert per hour per problem.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");

const PUBLIC_URL = process.env.PUBLIC_URL;
const ALERT_PHONE = process.env.ALERT_PHONE;
const STATE = "/tmp/nutridesi-healthcheck-state.json";
const COOLDOWN_MS = 60 * 60 * 1000;

const useMeta = !!(process.env.META_WA_TOKEN && process.env.META_WA_PHONE_NUMBER_ID);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
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
  if (state[key] && Date.now() - state[key] < COOLDOWN_MS) return;
  state[key] = Date.now();
  fs.writeFileSync(STATE, JSON.stringify(state));
  try {
    if (useMeta) {
      await alertViaMeta(text);
    } else {
      await alertViaTwilio(text);
    }
    console.log(new Date().toISOString(), "ALERT SENT:", text);
  } catch (e) {
    console.error(new Date().toISOString(), "alert send failed:", e.message);
  }
}

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
      const b = await client.balance.fetch();
      if (Number(b.balance) < 5) {
        await alert("balance", `⚠️ Twilio balance low: $${Number(b.balance).toFixed(2)}. Top up before replies start failing.`);
      }
    } catch (e) {
      console.error("balance check failed:", e.message);
    }
  }
})();
