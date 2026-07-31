// Bad-outcome classifier. This decides what counts as a failure, so a
// misclassification here quietly distorts every retention number built on it.
const assert = require("assert");
const {
  OUTCOME, isBadOutcome, classifyOutcome, followUp,
  looksLikeCorrectionAttempt, analyseUser, summarise,
} = require("../src/outcomes.js");

// --- classification: real reply shapes taken from production copy ---
assert.strictEqual(classifyOutcome("✅ Logged\n1. *Roti* ×2 — 178 kcal"), OUTCOME.LOGGED);
assert.strictEqual(classifyOutcome("Couldn't read that one 😅 mind sending it again?"), OUTCOME.PARSE_FAIL);
assert.strictEqual(classifyOutcome("I couldn't safely connect that correction to the recent log, so nothing changed."), OUTCOME.CORRECTION_ABORT);
assert.strictEqual(classifyOutcome("Couldn't pin down \"Papad\" in today's log — nothing changed."), OUTCOME.CORRECTION_MISS);
assert.strictEqual(classifyOutcome("Couldn't find \"mayonnaise\" in today's log — nothing removed."), OUTCOME.CORRECTION_MISS);
assert.strictEqual(classifyOutcome("What did you eat? Send me a food name and I'll log it 🙂"), OUTCOME.ASKED_FOOD_NAME);
assert.strictEqual(classifyOutcome("📸 I can't read photos, screenshots or voice notes yet"), OUTCOME.MEDIA_REJECT);
assert.strictEqual(classifyOutcome("That pending update was for a previous day, so nothing was changed."), OUTCOME.STATE_EXPIRED);
assert.strictEqual(classifyOutcome("Whoa, that's a lot of messages! Take a short break"), OUTCOME.RATE_LIMIT);
assert.strictEqual(classifyOutcome(""), OUTCOME.EMPTY);
assert.strictEqual(classifyOutcome(null), OUTCOME.EMPTY);
assert.strictEqual(classifyOutcome("   "), OUTCOME.EMPTY);

assert.strictEqual(classifyOutcome("🎯 Daily goal set: *2,450 kcal · 160g protein* (fat loss)."), OUTCOME.GOAL_SET);
assert.strictEqual(classifyOutcome("⏰ Daily summary set for *9pm*."), OUTCOME.REMINDER_SET);
assert.strictEqual(classifyOutcome("🔥 *Your estimated daily calories*\n\n*Maintenance:* ~2,700 kcal/day"), OUTCOME.TDEE);
assert.strictEqual(classifyOutcome("↩️ Removed:\n1. Roti"), OUTCOME.UNDO);
assert.strictEqual(classifyOutcome("🙌 Anytime! Text me your next meal whenever you eat."), OUTCOME.ACK);
assert.strictEqual(classifyOutcome("Got it, Priya 🎯"), OUTCOME.PROFILE);

// Specific failures must beat the generic success match. A placeholder reply
// begins with "Logged" but is a Tier-4 dead end, not a real result.
assert.strictEqual(
  classifyOutcome("✅ Logged: meal — 300 kcal (placeholder). Try again with more detail anytime."),
  OUTCOME.PLACEHOLDER,
  "a placeholder is not a successful log"
);

// --- which of those count against us ---
assert.ok(isBadOutcome(OUTCOME.PARSE_FAIL));
assert.ok(isBadOutcome(OUTCOME.ASKED_FOOD_NAME));
assert.ok(isBadOutcome(OUTCOME.CORRECTION_ABORT));
assert.ok(isBadOutcome(OUTCOME.PLACEHOLDER));
assert.ok(isBadOutcome(OUTCOME.EMPTY));
assert.ok(!isBadOutcome(OUTCOME.LOGGED));
assert.ok(!isBadOutcome(OUTCOME.UNDO));
assert.ok(!isBadOutcome(OUTCOME.GOAL_SET));
// Rate limiting is the guard working, not the product failing the user.
assert.ok(!isBadOutcome(OUTCOME.RATE_LIMIT), "rate limiting is intended behaviour");

// --- what happened next ---
const t = (min) => new Date(Date.UTC(2026, 6, 31, 10, min)).toISOString();
const ex = (reply, at, body = "x") => ({ body, reply, at });

assert.strictEqual(
  followUp([ex("What did you eat?", t(0)), ex("✅ Logged\n1. *Roti*", t(2))], 0),
  "recovered", "a good outcome soon after is a recovery");
assert.strictEqual(
  followUp([ex("What did you eat?", t(0)), ex("What did you eat?", t(2))], 0),
  "retried", "another failure is not a recovery");
assert.strictEqual(
  followUp([ex("What did you eat?", t(0))], 0),
  "abandoned", "no next message at all");
assert.strictEqual(
  followUp([ex("What did you eat?", t(0)), ex("✅ Logged", t(120))], 0),
  "abandoned_session", "returning hours later is not recovering from this moment");

assert.ok(looksLikeCorrectionAttempt("no it was paneer"));
assert.ok(looksLikeCorrectionAttempt("actually 2 roti"));
assert.ok(looksLikeCorrectionAttempt("that was wrong"));
assert.ok(!looksLikeCorrectionAttempt("2 roti and dal"));
assert.ok(!looksLikeCorrectionAttempt(""));

// --- per-user roll-up ---
const user = analyseUser([
  ex("✅ Logged\n1. *Roti*", t(0), "2 roti"),
  ex("✅ Logged\n1. *Paneer*", t(1), "no it was paneer"), // correction after a log
  ex("What did you eat?", t(5), "yes"),
  ex("✅ Logged\n1. *Dal*", t(6), "dal"),
  ex("Couldn't read that one 😅", t(20), "..."),
]);
assert.strictEqual(user.messages, 5);
assert.strictEqual(user.bad, 2, "asked_food_name + parse_failure");
assert.strictEqual(user.recovered, 1, "the first bad one was followed by a good log");
assert.strictEqual(user.abandoned, 1, "the last bad one ended the conversation");
assert.strictEqual(user.silentWrongMatch, 1, "a log followed by a correction attempt");
assert.strictEqual(user.lastOutcome, OUTCOME.PARSE_FAIL);
assert.strictEqual(user.endedOnBad, true);

// Order is normalised, so out-of-order rows don't corrupt the sequence.
const shuffled = analyseUser([
  ex("Couldn't read that one 😅", t(20)),
  ex("✅ Logged", t(0)),
]);
assert.strictEqual(shuffled.lastOutcome, OUTCOME.PARSE_FAIL, "sorted by timestamp, not input order");

assert.deepStrictEqual(analyseUser([]).byOutcome, {});
assert.strictEqual(analyseUser(null).messages, 0);

// --- aggregate + cohort split ---
const s = summarise({
  a: { ...user, activeDays: 1 },
  b: { messages: 3, bad: 0, byOutcome: { logged: 3 }, recovered: 0, retried: 0,
       abandoned: 0, silentWrongMatch: 0, endedOnBad: false, activeDays: 4 },
});
assert.strictEqual(s.users, 2);
assert.strictEqual(s.bad, 2);
assert.strictEqual(s.badRate, 25, "2 bad of 8 messages");
assert.strictEqual(s.recoveryRate, 50);
// The unmatched split is kept but flagged, because on real data it inverts:
// hitting a failure requires enough messages to hit one, so "clean run" fills
// with one-and-done users. Verified on 30 days of production data.
assert.strictEqual(s.cohorts.naive.confounded, true, "the raw split is labelled confounded");
assert.strictEqual(s.cohorts.naive.hitBadOutcome.n, 1);
assert.strictEqual(s.cohorts.naive.cleanRun.n, 1);

// The matched view compares like with like. Both fixtures sit in the 2-4 band.
const band = s.cohorts.bands.find(b => b.label === "2-4 msgs");
assert.ok(band, "bands are produced");
assert.strictEqual(band.bad.n, 0, "the 5-message user is not in the 2-4 band");
assert.strictEqual(band.clean.n, 1);

const band5 = s.cohorts.bands.find(b => b.label === "5-9 msgs");
assert.strictEqual(band5.bad.n, 1, "the 5-message user lands here");
assert.strictEqual(band5.bad.churnRate, 100);

// Needs no matching: of users who hit a failure, how many ended on one.
assert.strictEqual(s.cohorts.endedOnBadRate, 100);

// Empty input must not divide by zero.
const empty = summarise({});
assert.strictEqual(empty.users, 0);
assert.strictEqual(empty.badRate, 0);
assert.strictEqual(empty.recoveryRate, 0);

console.log("outcomes-test: all passed");
