// Opt-in daily summary — the product's only return trigger.
//
// Measured 31 Jul: 74.5% of all returns happen the next day and 87.6% within
// two, so the habit is decided inside a ~48h window. Nothing in the product
// acted inside it: there was no scheduler, no outbound job, and every return
// was self-initiated. This is that mechanism.
//
// Product rules this must respect (CLAUDE.md):
//   - Opt-in only. Never message someone who didn't ask.
//   - The user sets the time ("remind me at 9pm").
//   - One message a day, at most.
//
// Everything here is pure so it can be tested without a clock, a database or
// a network. Sending lives in scripts/daily-summary.js.

const IST_OFFSET_MIN = 5 * 60 + 30;

// Wall-clock date and time in IST for an instant.
function istParts(now = new Date()) {
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + IST_OFFSET_MIN * 60000);
  const pad = n => String(n).padStart(2, "0");
  return {
    date: `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())}`,
    minutes: ist.getHours() * 60 + ist.getMinutes(),
    hhmm: `${pad(ist.getHours())}:${pad(ist.getMinutes())}`,
  };
}

const toMinutes = hhmm => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

// "9pm" / "9:30 pm" / "21:00" / "9" -> "21:00". Returns null when the text
// doesn't carry a usable time, so the caller can ask rather than guess.
function normaliseTime(raw) {
  const s = String(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (min > 59) return null;
  if (suffix === "pm" && h < 12) h += 12;
  else if (suffix === "am" && h === 12) h = 0;
  // No am/pm: read 1-11 as evening. A daily food summary is an end-of-day
  // artifact — "remind me at 9" means 9pm — and the PRD's own example is 9pm.
  // 12 and 13+ are already unambiguous.
  else if (!suffix && h >= 1 && h <= 11) h += 12;
  if (h > 23) return null;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(min)}`;
}

// Detects the opt-in / opt-out request. Deterministic: a reminder that fires at
// the wrong hour, or one the user never asked for, is worse than none.
function parseReminderRequest(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!s) return null;

  const mentionsReminder = /\b(remind|reminder|reminders|daily summary|summary|nudge)\b/.test(s);
  if (!mentionsReminder) return null;

  if (/\b(stop|off|cancel|disable|remove|no more|don'?t|dont|band karo|nahi chahiye)\b/.test(s)) {
    return { action: "off" };
  }
  // Only treat it as a set when a time is actually present — "send me a summary"
  // is a request for today's totals, not a schedule.
  if (!/\d/.test(s)) return null;
  const at = /\b(?:at|by|around|@)\s*(.+)$/.exec(s);
  const time = normaliseTime(at ? at[1] : s);
  return time ? { action: "set", time } : null;
}

// Whether a user is due right now. Guards:
//   - one per IST day (lastSent)
//   - only inside a grace window after the target time, so a server that was
//     down overnight doesn't fire yesterday's 9pm reminder at 6am
const GRACE_MIN = 90;
function isDue(user, now = new Date(), graceMin = GRACE_MIN) {
  const target = toMinutes(user && user.daily_summary_time);
  if (target == null) return false; // not opted in
  const { date, minutes } = istParts(now);
  if (user.daily_summary_last_sent === date) return false;
  return minutes >= target && minutes < target + graceMin;
}

// WhatsApp only allows free-form outbound within 24h of the user's last
// inbound message. Outside that it needs an approved template, which the
// Sandbox does not have — so we skip rather than fail. This is also why the
// reminder reinforces an existing habit and cannot win back the long-lapsed.
const SESSION_MS = 24 * 60 * 60 * 1000;
function withinSessionWindow(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) return false;
  const t = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age < SESSION_MS;
}

const fmt = n => Math.round(Number(n) || 0).toLocaleString("en-IN");

// The summary itself. Two shapes: a recap when they logged, a short nudge when
// they didn't. Both end with the opt-out, because a reminder you can't stop is
// spam however it started.
function summaryBody(totals, profile, opts = {}) {
  const logged = Number(totals && totals.kcal) > 0;
  const goalKcal = Number(profile && profile.goal_kcal) > 0 ? Number(profile.goal_kcal) : null;
  const goalProtein = Number(profile && profile.goal_protein) > 0 ? Number(profile.goal_protein) : null;
  const name = profile && profile.name ? `${String(profile.name).trim().split(/\s+/)[0]}, ` : "";

  if (!logged) {
    return `\u{1F319} ${name}nothing logged today yet.\n\n`
      + "Even one line helps — \"2 roti and dal\" is enough.\n\n"
      + "_Reply \"stop reminders\" to turn this off._";
  }

  let progress;
  if (goalKcal && goalProtein) {
    const kcalLeft = goalKcal - Number(totals.kcal);
    const pLeft = goalProtein - Number(totals.protein);
    progress = `\u{1F525} *${fmt(totals.kcal)} / ${fmt(goalKcal)} kcal · `
      + `${fmt(totals.protein)} / ${fmt(goalProtein)}g protein*\n`
      + (kcalLeft > 0 || pLeft > 0
        ? `_${fmt(Math.max(kcalLeft, 0))} kcal, ${fmt(Math.max(pLeft, 0))}g protein left_`
        : "_Both targets met today \u{1F44F}_");
  } else {
    progress = `\u{1F525} *${fmt(totals.kcal)} kcal · ${fmt(totals.protein)}g protein* today`;
  }

  const itemCount = Number(opts.itemCount) || 0;
  const tail = itemCount
    ? `\n\n_${itemCount} item${itemCount === 1 ? "" : "s"} logged. Reply "today" for the full list._`
    : "";

  return `\u{1F319} ${name}here's your day.\n\n${progress}${tail}\n\n`
    + "_Reply \"stop reminders\" to turn this off._";
}

function confirmSetReply(time) {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const pretty = m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
  return `\u{23F0} Daily summary set for *${pretty}*. I'll send your totals once a day — `
    + "and only if you've messaged me in the last 24 hours, so it never turns up out of the blue.\n\n"
    + "_Reply \"stop reminders\" anytime._";
}

const CONFIRM_OFF_REPLY = "\u{1F515} Daily summary off. Say \"remind me at 9pm\" whenever you want it back.";

module.exports = {
  parseReminderRequest,
  normaliseTime,
  isDue,
  withinSessionWindow,
  summaryBody,
  confirmSetReply,
  CONFIRM_OFF_REPLY,
  istParts,
  GRACE_MIN,
  SESSION_MS,
};
