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

stubModule("../src/db.js", {
  supabase: {},
  getProfile: async () => profileFixture,
  saveTdeeProfile: recordAsync("saveTdeeProfile", true),
  saveProfile: recordAsync("saveProfile", true),
  ensureUser: recordAsync("ensureUser", false),
  logMeal: recordAsync("logMeal", {
    rows: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 }, isNewUser: false,
  }),
  resolveRows: recordAsync("resolveRows", []),
  todayTotal: recordAsync("todayTotal", { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0, meals: [] }),
  todayItems: recordAsync("todayItems", []),
  todaySeqs: recordAsync("todaySeqs", []),
  itemsBySeq: recordAsync("itemsBySeq", []),
  deleteBySeq: recordAsync("deleteBySeq", []),
  deleteLastLog: recordAsync("deleteLastLog", []),
  deleteAllToday: recordAsync("deleteAllToday", []),
  deleteMatchingLastLog: recordAsync("deleteMatchingLastLog", { deleted: [] }),
  deleteLogRowsByExactIds: recordAsync("deleteLogRowsByExactIds", []),
  logRowsByExactIds: recordAsync("logRowsByExactIds", []),
  lastLogBatch: recordAsync("lastLogBatch", []),
  dayReport: recordAsync("dayReport", { meals: [], total: {} }),
  bumpNudge: recordAsync("bumpNudge", 0),
  recentConversation: recordAsync("recentConversation", []),
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

const { handleMessage } = require("../server.js");
assert.strictEqual(typeof handleMessage, "function", "server.js must export handleMessage");

// A phone per case: rate limiting is in-memory and per-number.
let phoneSeq = 0;
function reset(profile, parsed) {
  calls.length = 0;
  profileFixture = profile || {};
  parseFixture = parsed || { intent: "chitchat", chitchat_reply: "hi" };
  return `+00000001${String(phoneSeq++).padStart(2, "0")}`;
}

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

  console.log("server-routing-test: all passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
