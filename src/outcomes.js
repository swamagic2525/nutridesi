// Bad-outcome instrumentation.
//
// The gap this closes: there was no way to see a user hit a wrong match and
// quietly give up. Failures were visible one message at a time in the log, but
// nothing connected a bad moment to what the user did next — which is the only
// thing that says whether it cost anything.
//
// Deliberately a CLASSIFIER over message_log rather than a new events table
// with write paths threaded through handleMessage:
//   - no new writes in the hot path, so instrumentation can't break logging
//   - it works retroactively over all existing history, not just from today
//   - the reply text already encodes the outcome; the bot says what it did
// The one thing it cannot see directly is a confidently WRONG match, because
// that reply looks successful. Those surface through the correction linkage
// below: a log immediately followed by a correction is the fingerprint.
//
// Pure functions only — no clock, no database. scripts/outcome-report.js runs it.

const OUTCOME = Object.freeze({
  LOGGED: "logged",
  UNDO: "undo",
  QUERY: "query",
  TDEE: "tdee",
  GOAL_SET: "goal_set",
  REMINDER_SET: "reminder_set",
  WELCOME: "welcome",
  ACK: "ack",
  PROFILE: "profile",

  // Bad outcomes, in rough order of how much they cost the user.
  EMPTY: "empty_reply",
  PARSE_FAIL: "parse_failure",
  CORRECTION_ABORT: "correction_abort",
  CORRECTION_MISS: "correction_miss",
  ASKED_FOOD_NAME: "asked_food_name",
  PLACEHOLDER: "placeholder",
  MEDIA_REJECT: "media_reject",
  RATE_LIMIT: "rate_limited",
  STATE_EXPIRED: "state_expired",

  OTHER: "other",
});

const BAD = new Set([
  OUTCOME.EMPTY, OUTCOME.PARSE_FAIL, OUTCOME.CORRECTION_ABORT,
  OUTCOME.CORRECTION_MISS, OUTCOME.ASKED_FOOD_NAME, OUTCOME.PLACEHOLDER,
  OUTCOME.MEDIA_REJECT, OUTCOME.STATE_EXPIRED,
]);
// Rate limiting is the system working as intended, not a failure of the product.
const isBadOutcome = o => BAD.has(o);

const txt = v => String(v == null ? "" : v);

// Order matters: the first match wins, so the specific failures are tested
// before the generic "Logged" success.
function classifyOutcome(reply, body = "") {
  const r = txt(reply);
  if (!r.trim()) return OUTCOME.EMPTY;

  if (/Couldn'?t read that one/i.test(r)) return OUTCOME.PARSE_FAIL;
  if (/couldn'?t safely connect/i.test(r)) return OUTCOME.CORRECTION_ABORT;
  if (/Couldn'?t (pin down|find)/i.test(r)) return OUTCOME.CORRECTION_MISS;
  if (/What did you eat|need a food name/i.test(r)) return OUTCOME.ASKED_FOOD_NAME;
  if (/300 kcal \(placeholder\)|placeholder/i.test(r)) return OUTCOME.PLACEHOLDER;
  if (/can'?t (read photos|inspect the photo)/i.test(r)) return OUTCOME.MEDIA_REJECT;
  if (/that'?s a lot of messages|That'?s a long one/i.test(r)) return OUTCOME.RATE_LIMIT;
  if (/pending update (was for a previous day|expired)/i.test(r)) return OUTCOME.STATE_EXPIRED;

  if (/^\u{21A9}\u{FE0F}?\s*Removed|^\u{21A9}|Removed:|Undone/iu.test(r)) return OUTCOME.UNDO;
  if (/Daily goal set/i.test(r)) return OUTCOME.GOAL_SET;
  if (/Daily summary (set|off)/i.test(r)) return OUTCOME.REMINDER_SET;
  if (/estimated daily calories|Maintenance:\*/i.test(r)) return OUTCOME.TDEE;
  if (/^✅\s*Logged/i.test(r.trim())) return OUTCOME.LOGGED;
  if (/full-time PM|Bigger version in ~30 days|Just tell me what you ate/i.test(r)) return OUTCOME.WELCOME;
  if (/^(Got it|Updated)/i.test(r.trim())) return OUTCOME.PROFILE;
  if (/Anytime!/i.test(r)) return OUTCOME.ACK;
  if (/Your day so far|\u{1F9FE}|kcal.*today/iu.test(r)) return OUTCOME.QUERY;
  return OUTCOME.OTHER;
}

// Did the user come back after this exchange, and did things go better?
//   recovered  - messaged again within the window and got a good outcome
//   retried    - messaged again but hit another bad outcome
//   abandoned  - never messaged again at all
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;

function followUp(exchanges, index, windowMs = RECOVERY_WINDOW_MS) {
  const cur = exchanges[index];
  const next = exchanges[index + 1];
  if (!next) return "abandoned";
  const gap = new Date(next.at).getTime() - new Date(cur.at).getTime();
  if (!Number.isFinite(gap) || gap > windowMs) return "abandoned_session";
  return isBadOutcome(classifyOutcome(next.reply, next.body)) ? "retried" : "recovered";
}

// A confidently wrong match looks like a success, so it can only be inferred:
// a log followed closely by a correction attempt.
const CORRECTION_SHAPE = /^(no|nope|actually|it was|that was|sorry|i meant|not )|wrong|galat/i;
function looksLikeCorrectionAttempt(body) {
  return CORRECTION_SHAPE.test(txt(body).trim());
}

// exchanges: [{ phone_number, body, reply, at }] for ONE user, oldest first.
function analyseUser(exchanges) {
  const rows = (exchanges || []).slice().sort((a, b) => txt(a.at).localeCompare(txt(b.at)));
  const out = {
    messages: rows.length,
    bad: 0,
    byOutcome: {},
    recovered: 0,
    retried: 0,
    abandoned: 0,
    silentWrongMatch: 0,
    lastOutcome: null,
    endedOnBad: false,
  };
  rows.forEach((row, i) => {
    const o = classifyOutcome(row.reply, row.body);
    out.byOutcome[o] = (out.byOutcome[o] || 0) + 1;
    if (isBadOutcome(o)) {
      out.bad++;
      const f = followUp(rows, i);
      if (f === "recovered") out.recovered++;
      else if (f === "retried") out.retried++;
      else out.abandoned++;
    } else if (o === OUTCOME.LOGGED) {
      const next = rows[i + 1];
      if (next && looksLikeCorrectionAttempt(next.body)) out.silentWrongMatch++;
    }
    if (i === rows.length - 1) {
      out.lastOutcome = o;
      out.endedOnBad = isBadOutcome(o);
    }
  });
  return out;
}

// The headline question: do users who hit a bad outcome leave more often?
//
// The naive split — bad-outcome users vs everyone else — is confounded, and
// badly enough to invert the answer. Hitting a failure requires sending
// several messages, so the "clean run" group fills up with one-and-done users
// who never sent enough to hit anything. Run raw on 30 days of real data it
// reported bad-outcome users churning 23.7 points LESS, which is an artefact
// of exposure, not a finding.
//
// So compare within message-count bands: among users who engaged a similar
// amount, did hitting a failure cost anything? Still correlational, but the
// dominant confound is controlled.
const BANDS = [
  { label: "2-4 msgs", min: 2, max: 4 },
  { label: "5-9 msgs", min: 5, max: 9 },
  { label: "10+ msgs", min: 10, max: Infinity },
];

function churnOf(group) {
  if (!group.length) return { n: 0, churnRate: null, endedOnBad: 0 };
  const churned = group.filter(u => u.activeDays <= 1).length;
  return {
    n: group.length,
    churnRate: Math.round((1000 * churned) / group.length) / 10,
    endedOnBad: group.filter(u => u.endedOnBad).length,
  };
}

function cohortComparison(perUser) {
  const users = Object.values(perUser || {});
  const bands = BANDS.map(({ label, min, max }) => {
    const inBand = users.filter(u => u.messages >= min && u.messages <= max);
    const bad = churnOf(inBand.filter(u => u.bad > 0));
    const clean = churnOf(inBand.filter(u => u.bad === 0));
    const delta = (bad.churnRate != null && clean.churnRate != null)
      ? Math.round((bad.churnRate - clean.churnRate) * 10) / 10
      : null;
    return { label, bad, clean, delta };
  });

  // Kept for reference, explicitly labelled as the confounded view so nobody
  // quotes it by accident.
  const naive = {
    hitBadOutcome: churnOf(users.filter(u => u.bad > 0)),
    cleanRun: churnOf(users.filter(u => u.bad === 0)),
    confounded: true,
  };

  // A cleaner signal that needs no matching: of users who DID hit a failure,
  // how many had it as the very last thing that happened to them?
  const hitBad = users.filter(u => u.bad > 0);
  const endedOnBadRate = hitBad.length
    ? Math.round((1000 * hitBad.filter(u => u.endedOnBad).length) / hitBad.length) / 10
    : null;

  return { bands, naive, endedOnBadRate };
}

function summarise(perUser) {
  const users = Object.values(perUser || {});
  const totals = { messages: 0, bad: 0, recovered: 0, retried: 0, abandoned: 0, silentWrongMatch: 0 };
  const byOutcome = {};
  for (const u of users) {
    for (const k of Object.keys(totals)) totals[k] += u[k] || 0;
    for (const [o, n] of Object.entries(u.byOutcome || {})) byOutcome[o] = (byOutcome[o] || 0) + n;
  }
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);
  return {
    users: users.length,
    ...totals,
    badRate: pct(totals.bad, totals.messages),
    recoveryRate: pct(totals.recovered, totals.bad),
    abandonRate: pct(totals.abandoned, totals.bad),
    byOutcome,
    cohorts: cohortComparison(perUser),
  };
}

module.exports = {
  OUTCOME, BAD, isBadOutcome, classifyOutcome, followUp,
  looksLikeCorrectionAttempt, analyseUser, summarise, cohortComparison,
  RECOVERY_WINDOW_MS,
};
