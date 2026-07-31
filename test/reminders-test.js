// Opt-in daily summary. This is the only message NutriDesi ever sends first,
// so the guardrails matter more than the feature: messaging someone who didn't
// ask, or messaging them repeatedly, is worse than never sending at all.
const assert = require("assert");
const {
  parseReminderRequest, normaliseTime, isDue, withinSessionWindow,
  summaryBody, confirmSetReply, CONFIRM_OFF_REPLY, istParts, GRACE_MIN, SESSION_MS,
} = require("../src/reminders.js");

// --- time parsing ---
assert.strictEqual(normaliseTime("9pm"), "21:00");
assert.strictEqual(normaliseTime("9 pm"), "21:00");
assert.strictEqual(normaliseTime("9:30pm"), "21:30");
assert.strictEqual(normaliseTime("21:00"), "21:00");
assert.strictEqual(normaliseTime("8am"), "08:00");
assert.strictEqual(normaliseTime("12am"), "00:00");
assert.strictEqual(normaliseTime("12pm"), "12:00");
// A bare small number means evening — nobody asks for a 9am food summary.
assert.strictEqual(normaliseTime("9"), "21:00");
assert.strictEqual(normaliseTime("10"), "22:00", "bare 1-11 reads as evening");
assert.strictEqual(normaliseTime("12"), "12:00", "12 is unambiguous");
assert.strictEqual(normaliseTime("25:00"), null);
assert.strictEqual(normaliseTime("9:70pm"), null);
assert.strictEqual(normaliseTime("banana"), null);

// --- opt-in / opt-out detection ---
assert.deepStrictEqual(parseReminderRequest("remind me at 9pm"), { action: "set", time: "21:00" });
assert.deepStrictEqual(parseReminderRequest("Remind me at 8:30 pm"), { action: "set", time: "20:30" });
assert.deepStrictEqual(parseReminderRequest("daily summary at 10pm"), { action: "set", time: "22:00" });
assert.deepStrictEqual(parseReminderRequest("stop reminders"), { action: "off" });
assert.deepStrictEqual(parseReminderRequest("turn off the daily summary"), { action: "off" });
assert.deepStrictEqual(parseReminderRequest("no more reminders"), { action: "off" });

// Must not hijack ordinary messages — this runs before the parser.
assert.strictEqual(parseReminderRequest("2 roti and dal"), null);
assert.strictEqual(parseReminderRequest("what did i eat today"), null);
assert.strictEqual(parseReminderRequest("i had 2 eggs at 9pm"), null, "a meal with a time is not an opt-in");
assert.strictEqual(parseReminderRequest("send me a summary"), null, "no time given -> not a schedule");
assert.strictEqual(parseReminderRequest(""), null);

// --- isDue: at most one per IST day, inside a grace window ---
// 2026-07-31T15:35Z == 21:05 IST
const at2105 = new Date("2026-07-31T15:35:00Z");
assert.strictEqual(istParts(at2105).hhmm, "21:05", "IST conversion");

const sub = extra => ({ daily_summary_time: "21:00", daily_summary_last_sent: null, ...extra });
assert.strictEqual(isDue(sub(), at2105), true, "due 5 min after the target");
assert.strictEqual(isDue(sub({ daily_summary_last_sent: "2026-07-31" }), at2105), false,
  "never twice in one IST day");
assert.strictEqual(isDue(sub({ daily_summary_last_sent: "2026-07-30" }), at2105), true,
  "yesterday's send does not block today");
assert.strictEqual(isDue(sub({ daily_summary_time: null }), at2105), false, "not opted in");
assert.strictEqual(isDue({}, at2105), false);
assert.strictEqual(isDue(null, at2105), false);

// Before the target time.
assert.strictEqual(isDue(sub(), new Date("2026-07-31T15:25:00Z")), false, "20:55 IST is too early");

// Long after: a server down overnight must not fire yesterday's 9pm at 06:00.
assert.strictEqual(isDue(sub(), new Date("2026-08-01T00:30:00Z")), false,
  "06:00 IST next morning is outside the grace window");
// Just inside / just outside the grace boundary.
const graceEdgeIn = new Date(at2105.getTime() - 5 * 60000 + (GRACE_MIN - 1) * 60000);
assert.strictEqual(isDue(sub(), graceEdgeIn), true, "inside the grace window");
const graceEdgeOut = new Date(at2105.getTime() - 5 * 60000 + GRACE_MIN * 60000);
assert.strictEqual(isDue(sub(), graceEdgeOut), false, "one minute past it");

// --- WhatsApp 24h session window ---
const now = new Date("2026-07-31T12:00:00Z");
assert.strictEqual(withinSessionWindow(new Date(now - 60 * 60000).toISOString(), now), true, "1h ago");
assert.strictEqual(withinSessionWindow(new Date(now - (SESSION_MS - 60000)).toISOString(), now), true, "just inside");
assert.strictEqual(withinSessionWindow(new Date(now - SESSION_MS).toISOString(), now), false, "exactly 24h");
assert.strictEqual(withinSessionWindow(new Date(now - 3 * SESSION_MS).toISOString(), now), false, "3 days");
assert.strictEqual(withinSessionWindow(null, now), false, "never messaged");
assert.strictEqual(withinSessionWindow("not a date", now), false);

// --- summary copy ---
const totals = { kcal: 1450, protein: 82 };
const withGoal = summaryBody(totals, { name: "Priya", goal_kcal: 2000, goal_protein: 120 }, { itemCount: 5 });
assert.match(withGoal, /Priya/);
assert.match(withGoal, /1,450 \/ 2,000 kcal/);
assert.match(withGoal, /82 \/ 120g protein/);
assert.match(withGoal, /550 kcal, 38g protein left/);
assert.match(withGoal, /5 items logged/);
assert.match(withGoal, /stop reminders/, "every send carries the opt-out");

const noGoal = summaryBody(totals, { name: null }, { itemCount: 2 });
assert.match(noGoal, /1,450 kcal · 82g protein/);
assert.doesNotMatch(noGoal, /\//, "no goal -> no progress fraction");
assert.match(noGoal, /stop reminders/);

const met = summaryBody({ kcal: 2100, protein: 130 }, { goal_kcal: 2000, goal_protein: 120 });
assert.match(met, /Both targets met/);

const nothing = summaryBody({ kcal: 0, protein: 0 }, { name: "Rahul" });
assert.match(nothing, /nothing logged today/);
assert.match(nothing, /Rahul/);
assert.match(nothing, /stop reminders/);

// A first name only — never the full signup name.
assert.match(summaryBody(totals, { name: "Priya Sharma", goal_kcal: 2000, goal_protein: 120 }), /Priya,/);
assert.doesNotMatch(summaryBody(totals, { name: "Priya Sharma", goal_kcal: 2000, goal_protein: 120 }), /Sharma/);

assert.match(confirmSetReply("21:00"), /9pm/);
assert.match(confirmSetReply("20:30"), /8:30pm/);
assert.match(confirmSetReply("08:00"), /8am/);
assert.match(confirmSetReply("21:00"), /24 hours/, "sets the expectation about the session window");
assert.match(CONFIRM_OFF_REPLY, /off/i);

console.log("reminders-test: all passed");
