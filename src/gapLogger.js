// Every food the curated DB couldn't serve is a candidate for Tier 1 promotion.
// Appends to evals/db-gaps.jsonl (gitignored - raw user text) and alerts the
// developer on WhatsApp, throttled to one alert per food per day.
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "evals", "db-gaps.jsonl");

const alerted = new Map(); // food (lowercase) -> YYYY-MM-DD last alerted

function logGapEvent({ food, reason, source, served_as, kcal }) {
  const entry = { ts: new Date().toISOString(), food, reason, source, served_as, kcal };
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch (_) {}
  try { maybeAlert(entry); } catch (_) {}
}

function maybeAlert(entry) {
  const key = String(entry.food).toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  if (alerted.get(key) === today) return;
  alerted.set(key, today);
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const to = process.env.ALERT_PHONE;
  if (!sid || !tok || !to) return;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || "+14155238886"}`;
  const body = entry.source === "indb"
    ? `\u{1F50D} DB gap: "${entry.food}" served from INDB as "${entry.served_as}" (${entry.kcal} kcal, ${entry.reason}). Review evals/db-gaps.jsonl to promote to Tier 1.`
    : entry.source === "curated_kept"
      ? `\u{1F914} DB gap: "${entry.food}" kept on curated "${entry.served_as}" (${entry.kcal} kcal, ${entry.reason}) - no better INDB hit. Check whether a new curated entry is needed.`
      : `\u{26A0}\u{FE0F} DB gap: "${entry.food}" served as LLM estimate (${entry.kcal} kcal, ${entry.reason}). No INDB hit - consider adding to foods.js.`;
  require("twilio")(sid, tok).messages.create({ from, to: `whatsapp:${to}`, body })
    .catch(err => console.error("gap alert failed:", err.message));
}

module.exports = { logGapEvent };
