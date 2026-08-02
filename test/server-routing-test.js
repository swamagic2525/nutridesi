// Behavioural routing tests for handleMessage.
//
// server.js used to be untestable: it called app.listen() at module load, so
// the only way to check routing order was to read the file as text and regex
// it. That breaks on a harmless rename and passes when the call sits in dead
// code. app.listen is now behind `require.main === module`, so the module can
// be require()d here with Supabase and the LLM stubbed out, and the ordering
// asserted by what actually happens.
//
// Only the I/O boundary is stubbed — src/db.js and src/parser.js. tdee.js,
// conversationMemory.js and correctionContext.js run for real.

const assert = require("assert");

// --- Stub the I/O modules before server.js is loaded ---------------------
// require.cache is keyed by resolved path, and "./src/db.js" from server.js
// resolves to the same file as "../src/db.js" from here.
function stubModule(relPath, exports) {
  const filename = require.resolve(relPath);
  require.cache[filename] = {
    id: filename, filename, path: require("path").dirname(filename),
    loaded: true, exports, children: [], paths: [],
  };
}

const calls = [];
const record = (name, value) => (...args) => { calls.push({ name, args }); return value; };
const recordAsync = (name, value) => async (...args) => { calls.push({ name, args }); return value; };
const called = (name) => calls.filter(c => c.name === name).length;

// Test-controlled state, reset per case.
let profileFixture = {};
let parseFixture = { intent: "chitchat", chitchat_reply: "hi" };
let historyFixture = [];
let logMealError = null;
let todaySeqsFixture = [];
let deleteBySeqFixture = [];
let rowsBySeqFixture = [];

stubModule("../src/db.js", {
  supabase: {},
  getProfile: async () => profileFixture,
  // These two write back into the fixture, because multi-turn flows (TDEE ->
  // goal) reload the profile on the next message and must see what the
  // previous turn stored. A write-only stub would silently break the loop.
  saveTdeeProfile: async (...args) => {
    calls.push({ name: "saveTdeeProfile", args });
    profileFixture = { ...profileFixture, tdee_profile: args[1] };
    return true;
  },
  saveProfile: async (...args) => {
    calls.push({ name: "saveProfile", args });
    profileFixture = { ...profileFixture, ...(args[1] || {}) };
    return true;
  },
  ensureUser: recordAsync("ensureUser", false),
  logMeal: async (...args) => {
    calls.push({ name: "logMeal", args });
    if (logMealError) throw logMealError;
    return {
      rows: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 }, isNewUser: false,
    };
  },
  resolveRows: recordAsync("resolveRows", []),
  todayTotal: recordAsync("todayTotal", { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0, meals: [] }),
  todayItems: recordAsync("todayItems", []),
  todaySeqs: async (...args) => { calls.push({ name: "todaySeqs", args }); return todaySeqsFixture; },
  itemsBySeq: recordAsync("itemsBySeq", []),
  deleteBySeq: async (...args) => { calls.push({ name: "deleteBySeq", args }); return deleteBySeqFixture; },
  deleteLastLog: recordAsync("deleteLastLog", []),
  deleteAllToday: recordAsync("deleteAllToday", []),
  deleteMatchingLastLog: recordAsync("deleteMatchingLastLog", { deleted: [] }),
  deleteLogRowsByExactIds: recordAsync("deleteLogRowsByExactIds", []),
  logRowsByExactIds: recordAsync("logRowsByExactIds", []),
  lastLogBatch: recordAsync("lastLogBatch", []),
  // Find-only target lookups + the atomic replacement, used by the four
  // correction routes since the delete moved inside the transaction.
  rowsBySeq: async (...args) => { calls.push({ name: "rowsBySeq", args }); return rowsBySeqFixture; },
  matchLastLogTargets: recordAsync("matchLastLogTargets", null),
  lastLogTargets: recordAsync("lastLogTargets", null),
  replaceMealAtomic: recordAsync("replaceMealAtomic", {
    rows: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0, meals: [] },
  }),
  prepareMealRows: recordAsync("prepareMealRows", []),
  dayReport: recordAsync("dayReport", { meals: [], total: {} }),
  bumpNudge: recordAsync("bumpNudge", 0),
  setSummaryTime: recordAsync("setSummaryTime", true),
  summarySubscribers: recordAsync("summarySubscribers", { error: null, rows: [] }),
  claimSummarySend: recordAsync("claimSummarySend", true),
  lastInboundAt: recordAsync("lastInboundAt", null),
  recentConversation: async (...args) => { calls.push({ name: "recentConversation", args }); return historyFixture; },
  saveConversationState: recordAsync("saveConversationState", true),
  claimConversationState: recordAsync("claimConversationState", true),
  clearConversationStateIfUnchanged: recordAsync("clearConversationStateIfUnchanged", true),
});

stubModule("../src/parser.js", {
  parseMeal: async (...args) => { calls.push({ name: "parseMeal", args }); return parseFixture; },
  preprocess: (s) => s,
  pinPizzaSlices: (x) => x,
  askLLM: async () => "",
  PROVIDER: "stub",
  CHAIN: ["stub"],
});

const { handleMessage, handleMessageOnce, duplicateReplay, rememberBody, DUP_WINDOW_MS } = require("../server.js");
assert.strictEqual(typeof handleMessage, "function", "server.js must export handleMessage");
assert.strictEqual(typeof handleMessageOnce, "function", "server.js must export handleMessageOnce");

// A phone per case: rate limiting is in-memory and per-number.
let phoneSeq = 0;
function reset(profile, parsed, history) {
  calls.length = 0;
  profileFixture = profile || {};
  parseFixture = parsed || { intent: "chitchat", chitchat_reply: "hi" };
  historyFixture = history || [];
  logMealError = null;
  todaySeqsFixture = [];
  deleteBySeqFixture = [];
  rowsBySeqFixture = [];
  return `+00000001${String(phoneSeq++).padStart(2, "0")}`;
}

// A conversation state that survives normaliseConversationState: it validates
// awaiting, a future ISO expiry, a real UUID nonce, non-empty integer target
// ids, and a targetDate equal to today's IST date. A bare { awaiting } is
// rejected as expired, so fixtures must be built properly.
const { istDateForTimestamp } = require("../src/conversationMemory.js");
const { randomUUID } = require("crypto");
const conversationState = (awaiting, extra = {}) => ({
  awaiting,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  nonce: randomUUID(),
  targetLogIds: [101],
  targetDate: istDateForTimestamp(Date.now()),
  ...extra,
});

// Mid-collection: everything but activity level is known.
const midCollection = () => ({
  tdee_profile: {
    phase: "collecting", age: 31, formula: "male",
    heightCm: 175, weightKg: 80, activity: null,
    pendingWeightValue: null, invalidAttempts: 0,
    confirmedSignature: null, bmr: null, tdee: null, calculatedAt: null,
  },
  conversation_state: {},
});

(async () => {
  // 1. TDEE runs BEFORE parseMeal. A bare "3" mid-collection is an activity
  //    level, not food. If the TDEE block were moved below parseMeal, the LLM
  //    would be asked to parse "3" as a meal.
  let phone = reset(midCollection());
  let reply = await handleMessage(phone, "3");
  assert.match(reply, /Maintenance/, "bare '3' mid-collection completes TDEE");
  assert.match(reply, /2,700 kcal/, "and uses the collected values");
  assert.strictEqual(called("parseMeal"), 0, "parseMeal must NOT run when TDEE claims the message");
  assert.ok(called("saveTdeeProfile") > 0, "completed state is persisted");

  // 2. An explicit TDEE request is claimed before parsing too.
  phone = reset({ tdee_profile: {}, conversation_state: {} });
  reply = await handleMessage(phone, "what is my TDEE?");
  assert.match(reply, /Age.*Male\/Female.*Height.*Weight/s);
  assert.strictEqual(called("parseMeal"), 0, "explicit TDEE request never reaches the parser");

  // 3. Passthrough: with TDEE inactive, a food message DOES reach the parser.
  //    Guards against a TDEE block that swallows everything.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  await handleMessage(phone, "2 roti and dal");
  assert.strictEqual(called("parseMeal"), 1, "normal food still routes to the parser");

  // 4. Intent preemption: food sent mid-collection abandons TDEE AND keeps
  //    routing, so the meal is still logged. Both halves matter — a version
  //    that returned early here would silently drop the user's food.
  phone = reset(midCollection(),
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  await handleMessage(phone, "2 roti and dal");
  assert.ok(called("saveTdeeProfile") > 0, "abandoned TDEE state is persisted");
  assert.strictEqual(called("parseMeal"), 1, "and the message continues to the parser");

  // 4b. A normal log is not successful until Supabase accepts it. The old
  //     fire-and-forget path could reply "Logged" while the insert failed.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  logMealError = new Error("insert rejected");
  reply = await handleMessage(phone, "2 roti");
  assert.match(reply, /nothing was logged/i, "a rejected insert is reported truthfully");
  assert.doesNotMatch(reply, /^✅\s*logged/i, "a rejected insert never claims success");
  const failedLog = calls.find(c => c.name === "logMeal");
  assert.strictEqual(failedLog.args[2].awaitInsert, true,
    "ordinary logs must await Supabase before replying");

  // Numbered replacement must not delete before it knows the replacement saved.
  // It used to deleteBySeq and THEN insert, so a failure between the two erased
  // the original; the removal now happens inside replaceMealAtomic's single
  // transaction, and the route only LOOKS the target up beforehand.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "rice", quantity: 1, unit: "bowl" }] });
  todaySeqsFixture = [2];
  rowsBySeqFixture = [{ id: 22, day_seq: 2, food_name: "Roti", kcal: 90 }];
  await handleMessage(phone, "replace 2 with rice");
  assert.strictEqual(called("deleteBySeq"), 0,
    "the target must NOT be deleted outside the transaction");
  const numbered = calls.find(c => c.name === "replaceMealAtomic");
  assert.ok(numbered, "numbered replacement goes through the atomic path");
  assert.deepStrictEqual(numbered.args[2], [22], "and passes the located target id");

  // 4c. Explicit recovery language outranks a mistaken LLM correction intent.
  //     The user said the earlier meal was correct and they were ADDING a
  //     shake; treating this as replace_last compounds the original error.
  phone = reset({ tdee_profile: {}, conversation_state: {} }, {
    intent: "replace_last",
    items: [{ food_name: "Protein Shake", quantity: 1, unit: "scoop", stated_protein: 20 }],
  });
  reply = await handleMessage(
    phone,
    "No no, you did not have to change the earlier one, it was correct, I was adding protein shake",
  );
  const recoveredLog = calls.find(c => c.name === "logMeal");
  assert.ok(recoveredLog, "the shake is logged as an addition");
  assert.strictEqual(recoveredLog.args[1].intent, "log");
  assert.strictEqual(called("deleteMatchingLastLog"), 0, "the earlier meal is untouched");

  // 4d. Pasting NutriDesi's own receipt is context, never a second meal. The
  //     old 300-character guard scolded the user before recognizing it.
  phone = reset({ tdee_profile: {}, conversation_state: {} });
  const pastedReceipt = "✅ Logged\n1. *Whole masoor* — 185 kcal\n2. *Tofu* — 122 kcal\n"
    + "🔥 1,355 kcal · 124g protein\n".padEnd(360, "context ");
  reply = await handleMessage(phone, pastedReceipt);
  assert.match(reply, /I can see the earlier log/i);
  assert.strictEqual(called("parseMeal"), 0, "our own receipt is never parsed as food");
  assert.strictEqual(called("logMeal"), 0, "our own receipt is never logged again");

  // A detailed but bounded meal remains usable instead of being rejected at
  // the old 300-character ceiling.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "mixed meal", quantity: 1, unit: "meal" }] });
  const detailedMeal = ("2 roti, dal, rice, paneer, salad and curd. ").repeat(12).slice(0, 500);
  await handleMessage(phone, detailedMeal);
  assert.strictEqual(called("parseMeal"), 1, "a bounded detailed meal reaches the parser");

  phone = reset({ tdee_profile: {}, conversation_state: {} });
  reply = await handleMessage(phone, "food ".repeat(241));
  assert.match(reply, /last instruction|food and portion/i);
  assert.strictEqual(called("parseMeal"), 0, "over-limit input performs no parse or write");
  assert.strictEqual(called("logMeal"), 0);

  // 5. The semantic branch is reachable: when the parser classifies a message
  //    as calculate_tdee, it must produce the TDEE prompt rather than falling
  //    through to query/log handling or a generic fallback.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "calculate_tdee" });
  reply = await handleMessage(phone, "how many calories should i be eating daily");
  assert.strictEqual(called("parseMeal"), 1, "this phrasing goes through the parser");
  assert.match(reply, /Age.*Male\/Female.*Height.*Weight/s, "calculate_tdee reaches TDEE, not query/log");
  assert.ok(called("saveTdeeProfile") > 0);
  assert.strictEqual(called("dayReport"), 0, "must not be answered as a day query");

  // 6. The semantic branch is gated on the intent, not on the wording. The
  //    same phrasing classified as a query must NOT be pulled into TDEE.
  //    (forcedIntent / expectedCorrectedMeal precedence is a local derived
  //    from conversation state, so it is covered directly in tdee-test.js
  //    against shouldRouteSemanticTdee rather than simulated here.)
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "query", query_reply: "You've had 1,200 kcal today." });
  reply = await handleMessage(phone, "how many calories should i be eating daily");
  assert.doesNotMatch(String(reply), /Male\/Female.*Height/s, "a query intent must not enter TDEE");
  assert.strictEqual(called("saveTdeeProfile"), 0, "and must not touch the TDEE profile");

  // --- Conversation-memory routing -------------------------------------
  // These replace source-order assertions in conversation-memory-test.js.
  // Position in the file proved one string preceded another; these prove the
  // precedence rule those positions were implementing.

  // 7. History is loaded ONLY when the message needs it. A self-contained meal
  //    must not pay for a Supabase round-trip or drag prior turns into the
  //    prompt (which is also the injection surface).
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  await handleMessage(phone, "2 roti and dal");
  assert.strictEqual(called("recentConversation"), 0, "self-contained meal loads no history");

  // ...and IS loaded for an anaphoric follow-up.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "poha", quantity: 1, unit: "bowl" }] });
  await handleMessage(phone, "same again");
  assert.strictEqual(called("recentConversation"), 1, "'same again' loads history");

  // 8. A pending corrected_meal prompt forces history regardless of wording,
  //    so the correction resolves against what was actually logged.
  phone = reset({ tdee_profile: {}, conversation_state: conversationState("corrected_meal") },
    { intent: "log", items: [{ food_name: "rajma", quantity: 1, unit: "bowl" }] });
  await handleMessage(phone, "rajma");
  assert.strictEqual(called("recentConversation"), 1, "a pending correction always loads history");

  // 8b. A state whose targetDate is not today's IST date is cancelled rather
  //     than applied — yesterday's pending correction must not mutate today.
  phone = reset(
    { tdee_profile: {}, conversation_state: conversationState("corrected_meal", { targetDate: "2020-01-01" }) },
    { intent: "log", items: [{ food_name: "rajma", quantity: 1, unit: "bowl" }] }
  );
  const staleReply = await handleMessage(phone, "rajma");
  // Assert the specific cancellation copy. `claimConversationState was called`
  // is too weak — the ordinary correction path claims state too, so that
  // assertion passes even with the stale-date guard removed.
  assert.match(String(staleReply), /previous day|expired or was already handled/,
    "a state targeting another day is cancelled, not applied");
  assert.strictEqual(called("parseMeal"), 0, "and does not fall through to parsing");

  // 9. When history is loaded it reaches the parser as a quoted envelope, and
  //    the parser is called with it — not before it is built. The envelope is
  //    the prompt-injection boundary, so its presence is the security-relevant
  //    property, not the line number of formatConversationContext.
  phone = reset(
    { tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "poha", quantity: 1, unit: "bowl" }] },
    [{ body: "poha", reply: "Logged poha — 160 kcal", media: false, at: new Date().toISOString() }]
  );
  await handleMessage(phone, "same again");
  const parseCall = calls.find(c => c.name === "parseMeal");
  assert.ok(parseCall, "parser ran");
  const contextArg = JSON.stringify(parseCall.args[1] || "");
  assert.match(contextArg, /APP-PROVIDED RECENT CONVERSATION/,
    "history reaches the parser inside the quoted envelope");
  assert.match(contextArg, /poha/, "and carries the actual prior turn");

  // 10. Media routing preempts parsing: a bare "what is this?" after a
  //     caption-less photo is answered deterministically, with no LLM call.
  phone = reset(
    { tdee_profile: {}, conversation_state: {} },
    { intent: "chitchat", chitchat_reply: "hi" },
    [{ body: "", reply: "", media: true, at: new Date().toISOString() }]
  );
  // Not "what is this?" — that matches the help/"what is nutridesi" regex and
  // returns the welcome blurb before media routing is ever reached.
  const mediaReply = await handleMessage(phone, "check this photo");
  // Assert the specific media copy. "a non-empty reply came back" is too weak:
  // with media routing disabled the message still gets answered further down
  // the chain, so that assertion passes while the routing is broken.
  assert.match(String(mediaReply), /can't inspect the photo/,
    "a follow-up to a caption-less photo gets the deterministic media reply");
  assert.strictEqual(called("parseMeal"), 0, "and never reaches the parser");

  // 11. The contextual protein-goal reply short-circuits before parsing, for a
  //     user who has a calorie goal but no protein goal.
  phone = reset(
    { tdee_profile: {}, conversation_state: {}, goal_kcal: 1800, goal_protein: null },
    { intent: "chitchat", chitchat_reply: "hi" }
  );
  const proteinReply = await handleMessage(phone, "what protein should i eat for this goal");
  assert.match(String(proteinReply), /protein target/, "protein-goal reply is returned");
  assert.strictEqual(called("parseMeal"), 0, "and it short-circuits before the parser");

  // --- Duplicate-message guard ------------------------------------------
  // Measured 29 Jul: 12 duplicate rows across 12 users silently doubled their
  // day totals. The guard must kill that WITHOUT breaking legitimate repeats.

  // 12. An identical meal resent inside the window logs once, not twice.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  const first = await handleMessageOnce(phone, "2 roti and dal");
  assert.match(first, /Logged/, "first send logs");
  const secondCalls = (calls.length = 0, await handleMessageOnce(phone, "2 roti and dal"));
  assert.match(secondCalls, /already logged, nothing added/i, "the resend is flagged as a duplicate");
  assert.strictEqual(called("logMeal"), 0, "and writes NO second row");
  assert.strictEqual(called("parseMeal"), 0, "and does not even reach the parser");

  // 13. Whitespace/case variations of the same message are still duplicates —
  //     WhatsApp clients and copy-paste introduce these.
  calls.length = 0;
  const variant = await handleMessageOnce(phone, "  2 Roti  and   dal ");
  assert.match(variant, /already logged, nothing added/i, "normalised match still dedupes");
  assert.strictEqual(called("logMeal"), 0);

  // 14. A DIFFERENT meal from the same user is unaffected.
  calls.length = 0;
  const other = await handleMessageOnce(phone, "1 bowl poha");
  assert.doesNotMatch(other, /already logged, nothing added/i, "a different meal is not a duplicate");
  assert.strictEqual(called("parseMeal"), 1, "and is parsed normally");

  // 15. The SAME text from a DIFFERENT user is not a duplicate — the key is
  //     per-phone, or one user's meal would suppress another's.
  const otherPhone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  const across = await handleMessageOnce(otherPhone, "2 roti and dal");
  assert.match(across, /Logged/, "another user's identical text logs normally");
  assert.doesNotMatch(across, /already logged, nothing added/i);

  // 16. Repeats whose first reply was NOT a log must still be processed. This
  //     is the guard on the guard: "yes"/"3"/"kg" legitimately recur as answers
  //     to different prompts, and replaying a stale answer would be its own bug.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "chitchat", chitchat_reply: "Sure — what did you have?" });
  await handleMessageOnce(phone, "yes");
  calls.length = 0;
  const repeatedYes = await handleMessageOnce(phone, "yes");
  assert.doesNotMatch(repeatedYes, /already logged, nothing added/i,
    "a repeated non-logging message is NOT suppressed");
  assert.strictEqual(called("parseMeal"), 1, "it is processed again, as it must be");

  // 17. Consecutive TDEE answers are untouched — a user mid-collection can send
  //     "3" for activity after "3" meant something else earlier.
  phone = reset(midCollection());
  const tdeeDone = await handleMessageOnce(phone, "3");
  assert.match(tdeeDone, /Maintenance/, "TDEE completes");
  calls.length = 0;
  const tdeeAgain = await handleMessageOnce(phone, "3");
  assert.doesNotMatch(tdeeAgain, /already logged, nothing added/i,
    "a repeated TDEE answer is not treated as a duplicate log");

  // 18. Two caption-less photos in a row are two real messages. Their bodies
  //     are empty, and an empty body is never remembered, so they cannot
  //     collide — no media special-case needed in the guard.
  phone = reset({ tdee_profile: {}, conversation_state: {} });
  const photo1 = await handleMessageOnce(phone, "", { media: true });
  calls.length = 0;
  const photo2 = await handleMessageOnce(phone, "", { media: true });
  assert.doesNotMatch(String(photo2), /already logged, nothing added/i,
    "a second photo is not a duplicate");
  assert.strictEqual(photo1, photo2, "both get the same media reply, via the normal path");

  // 18b. A *captioned* photo resent within the window IS a duplicate — the
  //      caption is the body, and resending it would double-log like any text.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  await handleMessageOnce(phone, "2 roti and dal", { media: true });
  calls.length = 0;
  const capAgain = await handleMessageOnce(phone, "2 roti and dal", { media: true });
  assert.match(capAgain, /already logged, nothing added/i, "resent captioned photo dedupes");
  assert.strictEqual(called("logMeal"), 0, "and writes no second row");

  // 18c. The TDEE goal loop actually PERSISTS. The calculator used to compute
  //      the numbers, show them, and drop them — tdee_profile was written,
  //      goal_kcal/goal_protein never were. Goal-setters return at ~2x, so the
  //      write is the whole point of the feature.
  phone = reset({ tdee_profile: {}, conversation_state: {} });
  let r = await handleMessageOnce(phone, "calculate my calories age 31 male 175 cm 80 kg activity 3");
  assert.match(r, /Want me to track against one of these/, "the result offers a goal");
  calls.length = 0;
  r = await handleMessageOnce(phone, "fat loss");
  assert.match(r, /Daily goal set/, "choosing one confirms");

  const saved = calls.find(c => c.name === "saveProfile");
  assert.ok(saved, "saveProfile was called — the goal is persisted, not just displayed");
  assert.strictEqual(saved.args[1].goal_kcal, 2450);
  assert.strictEqual(saved.args[1].goal_protein, 160);
  assert.ok(calls.find(c => c.name === "saveTdeeProfile"), "and the tdee profile is still stored");

  // 18d. Skipping writes no goal.
  phone = reset({ tdee_profile: {}, conversation_state: {} });
  await handleMessageOnce(phone, "calculate my calories age 31 male 175 cm 80 kg activity 3");
  calls.length = 0;
  r = await handleMessageOnce(phone, "skip");
  assert.strictEqual(called("saveProfile"), 0, "skip persists no goal");

  // 18e. Sending a meal instead of answering logs the meal — the optional
  //      question must not deadlock the conversation.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "roti", quantity: 2, unit: "piece" }] });
  await handleMessageOnce(phone, "calculate my calories age 31 male 175 cm 80 kg activity 3");
  calls.length = 0;
  r = await handleMessageOnce(phone, "2 roti and dal");
  assert.strictEqual(called("parseMeal"), 1, "the meal reaches the parser");
  assert.strictEqual(called("saveProfile"), 0, "and sets no goal");
  assert.match(r, /Logged/, "and is logged");

  // 18f. The reminder opt-in routes before the parser — "remind me at 9pm"
  //      must never be read as a meal — and persists the time.
  phone = reset({ tdee_profile: {}, conversation_state: {} });
  r = await handleMessageOnce(phone, "remind me at 9pm");
  assert.match(r, /Daily summary set/, "opt-in is confirmed");
  assert.match(r, /9pm/);
  assert.strictEqual(called("parseMeal"), 0, "and never reaches the parser");
  const setTime = calls.find(c => c.name === "setSummaryTime");
  assert.ok(setTime, "the time is persisted");
  assert.strictEqual(setTime.args[1], "21:00");

  // 18g. Opting out clears it.
  phone = reset({ tdee_profile: {}, conversation_state: {} });
  r = await handleMessageOnce(phone, "stop reminders");
  assert.match(r, /off/i);
  const cleared = calls.find(c => c.name === "setSummaryTime");
  assert.ok(cleared && cleared.args[1] === null, "the time is cleared, not left set");

  // 18h. A meal that merely mentions a time is still a meal.
  phone = reset({ tdee_profile: {}, conversation_state: {} },
    { intent: "log", items: [{ food_name: "eggs", quantity: 2, unit: "piece" }] });
  r = await handleMessageOnce(phone, "i had 2 eggs at 9pm");
  assert.strictEqual(called("setSummaryTime"), 0, "no reminder is set");
  assert.strictEqual(called("parseMeal"), 1, "it is parsed as food");

  // 19. The window actually expires. Driven through duplicateReplay/rememberBody
  //     with an injected clock, because a test never waits 90 seconds — without
  //     this, removing the expiry check passes everything above.
  {
    const t0 = 1_800_000_000_000;
    const p = "+0000000199";
    rememberBody(p, "2 roti and dal", "✅ Logged\n1. *Roti* ×2 — 178 kcal", t0);
    assert.ok(duplicateReplay(p, "2 roti and dal", t0 + 1_000),
      "still a duplicate 1s later");
    assert.ok(duplicateReplay(p, "2 roti and dal", t0 + DUP_WINDOW_MS - 1),
      "still a duplicate just inside the window");
    assert.strictEqual(duplicateReplay(p, "2 roti and dal", t0 + DUP_WINDOW_MS), null,
      "NOT a duplicate once the window elapses — the same meal later is a real second helping");
    assert.strictEqual(duplicateReplay(p, "2 roti and dal", t0 + 6 * 60 * 60 * 1000), null,
      "and certainly not hours later");

    // A remembered non-logging reply never replays, whatever the timing.
    rememberBody(p, "yes", "Sure — what did you have?", t0);
    assert.strictEqual(duplicateReplay(p, "yes", t0 + 1_000), null,
      "a non-logging reply is never replayed");
  }

  console.log("server-routing-test: all passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
