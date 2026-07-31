// Sends the opt-in daily summary. Run by launchd every 5 minutes.
//
// This is the product's only outbound message and its only return trigger.
// 74.5% of returns happen the next day and 87.6% within two, so the habit is
// decided in a ~48h window that nothing previously acted inside.
//
// It is a background job, which the architecture note in CLAUDE.md otherwise
// rules out. That rule is about the *message pipeline* staying one synchronous
// webhook; a scheduled send cannot be. Kept as a separate launchd job rather
// than a timer inside server.js so the webhook process stays single-purpose
// and server.js stays require()-able by tests.
//
// Guardrails, in order of how badly each would fail:
//   1. Opt-in only — never message someone who didn't ask.
//   2. The send is claimed before dispatch, so a crash costs one missed day
//      rather than a loop that messages someone repeatedly.
//   3. Only inside WhatsApp's 24h window; outside it we skip rather than fail.
//   4. Only within a grace window after the target time, so a server that was
//      down overnight doesn't fire yesterday's 9pm reminder at 6am.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  summarySubscribers, claimSummarySend, lastInboundAt, dayReport, getProfile,
} = require("../src/db.js");
const { isDue, withinSessionWindow, summaryBody, istParts } = require("../src/reminders.js");

const DRY_RUN = process.argv.includes("--dry-run");
const maskPhone = p => String(p || "").replace(/^(\+\d{2})\d+(\d{4})$/, "$1••••••$2");
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function send(phone, body) {
  if (process.env.META_WA_TOKEN && process.env.META_WA_PHONE_NUMBER_ID) {
    const { sendMessage } = require("../src/meta.js");
    return sendMessage(phone, body);
  }
  const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || "+14155238886"}`;
  return client.messages.create({ from, to: `whatsapp:${phone}`, body });
}

(async () => {
  const now = new Date();
  const { date } = istParts(now);

  const { error, rows } = await summarySubscribers();
  if (error) {
    // Without daily_summary_last_sent there is no way to guarantee one send per
    // day. Refuse to run rather than risk messaging people repeatedly.
    log(`ABORT: cannot read subscribers (${error}). Apply daily-summary.sql first.`);
    process.exit(1);
  }
  if (!rows.length) return log("no subscribers");

  const due = rows.filter(u => isDue(u, now));
  log(`subscribers=${rows.length} due=${due.length} istDate=${date}`);

  for (const user of due) {
    const phone = user.phone_number;
    try {
      // WhatsApp free-form outbound is only allowed within 24h of their last
      // inbound. Outside it a template is required, which the Sandbox has none
      // of — so this reinforces an existing habit and cannot win back the
      // long-lapsed. Checked before claiming so a skipped day can retry later.
      const lastIn = await lastInboundAt(phone);
      if (!withinSessionWindow(lastIn, now)) {
        log(`skip ${maskPhone(phone)} — outside the 24h session window`);
        continue;
      }

      const report = await dayReport(phone, 0);
      const profile = await getProfile(phone);
      const itemCount = (report.meals || []).reduce((n, m) => n + (m.items || []).length, 0);
      const body = summaryBody(report.totals, profile, { itemCount });

      if (DRY_RUN) {
        log(`DRY-RUN would send to ${maskPhone(phone)}:\n${body}\n`);
        continue;
      }

      // Claim first: a failure after this costs one missed day. The reverse
      // order risks messaging someone over and over, which for an opt-in
      // nudge is the one unforgivable outcome.
      if (!await claimSummarySend(phone, date)) {
        log(`skip ${maskPhone(phone)} — already sent today`);
        continue;
      }
      await send(phone, body);
      log(`sent ${maskPhone(phone)} (${itemCount} items)`);
    } catch (e) {
      log(`FAILED ${maskPhone(phone)}: ${e.message}`);
    }
  }
})().catch(e => { log("daily-summary crashed:", e.message); process.exit(1); });
