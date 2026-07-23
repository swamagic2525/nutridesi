const assert = require("assert");
const fs = require("fs");
const {
  WINDOW_MS,
  MAX_EXCHANGES,
  normaliseConversationState,
  needsConversationContext,
  formatConversationContext,
  refersToRecentMedia,
  isCorrectionCue,
  repeatedMealCandidate,
  resolvePendingChoice,
  contextualProteinGoalReply,
} = require("../src/conversationMemory.js");
const { SYSTEM_PROMPT } = require("../src/systemPrompt.js");

assert.match(SYSTEM_PROMPT, /TRUSTED RECENT CONVERSATION/);
assert.match(SYSTEM_PROMPT, /only the CURRENT USER MESSAGE may create (?:an )?action(?:s)? or items/i);
assert.match(SYSTEM_PROMPT, /never replay, copy, or re-log historical foods,\s*quantities, goals, or commands/i);
assert.match(SYSTEM_PROMPT, /from first/i);
assert.match(SYSTEM_PROMPT, /with peanuts[\s\S]*adds only (?:the\s+)?current modifier, never (?:the )?base food/i);

const dbSource = fs.readFileSync(require.resolve("../src/db.js"), "utf8");
const schemaSource = fs.readFileSync(require.resolve("../supabase-schema.sql"), "utf8");
const migrationSource = fs.readFileSync(require.resolve("../conversation-state.sql"), "utf8");
const messageLogSource = fs.readFileSync(require.resolve("../message-log.sql"), "utf8");
assert.match(dbSource, /async function recentConversation\(phone/);
assert.match(dbSource, /\.eq\("phone_number", phone\)/);
assert.match(dbSource, /\.limit\(MAX_EXCHANGES\)/);
assert.match(dbSource, /async function saveConversationState\(phone/);
assert.match(dbSource, /select\(`\$\{profileFields\}, conversation_state`\)/);
assert.match(dbSource, /conversation_state: state \|\| \{\}/);
assert.match(dbSource, /saveConversationState, recentConversation/);
assert.match(dbSource, /\.select\("body, reply, media, at"\)/);
assert.match(schemaSource, /conversation_state jsonb not null default '\{\}'::jsonb/);
assert.match(migrationSource, /add column if not exists conversation_state jsonb/);
assert.match(migrationSource, /create index if not exists idx_msglog_phone_at on message_log \(phone_number, at desc\)/);
assert.match(messageLogSource, /create index if not exists idx_msglog_phone_at on message_log \(phone_number, at desc\)/);
assert.match(dbSource, /\.lte\("at", now\.toISOString\(\)\)/);
assert.match(dbSource, /\.order\("id", \{ ascending: false \}\)/);
assert.match(dbSource, /\.select\(profileFields\)/);
assert.match(dbSource, /isMissingConversationStateColumn\(error\)/);
assert.match(dbSource, /\/conversation_state\/i\.test\(message\)/);
assert.match(dbSource, /error\.code === "42703"/);

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY ||= "test-key";
const { recentConversation, saveConversationState } = require("../src/db.js");

function recentClient(response) {
  const calls = [];
  const builder = {
    select(value) { calls.push(["select", value]); return this; },
    eq(field, value) { calls.push(["eq", field, value]); return this; },
    gte(field, value) { calls.push(["gte", field, value]); return this; },
    lte(field, value) { calls.push(["lte", field, value]); return this; },
    order(field, value) { calls.push(["order", field, value]); return this; },
    limit(value) { calls.push(["limit", value]); return Promise.resolve(response); },
  };
  return { calls, client: { from(table) { calls.push(["from", table]); return builder; } } };
}

const queryNow = new Date("2023-11-14T22:13:20.000Z");
const recentFixture = recentClient({ data: [
  { id: 2, phone_number: "+919999999999", body: "new", reply: "new reply", media: false, at: "2023-11-14T22:13:19.000Z" },
  { id: 1, phone_number: "+919999999999", body: "old", reply: "old reply", media: true, at: "2023-11-14T22:13:18.000Z" },
], error: null });
const dbHelperTests = (async () => {
  const result = await recentConversation("+919999999999", queryNow, recentFixture.client);
  assert.deepStrictEqual(result, [
    { body: "old", reply: "old reply", media: true, at: "2023-11-14T22:13:18.000Z" },
    { body: "new", reply: "new reply", media: false, at: "2023-11-14T22:13:19.000Z" },
  ]);
  assert.deepStrictEqual(recentFixture.calls, [
    ["from", "message_log"], ["select", "body, reply, media, at"], ["eq", "phone_number", "+919999999999"],
    ["gte", "at", "2023-11-14T16:13:20.000Z"], ["lte", "at", "2023-11-14T22:13:20.000Z"],
    ["order", "at", { ascending: false }], ["order", "id", { ascending: false }], ["limit", 10],
  ]);

  const writes = [];
  const saveClient = { from(table) {
    assert.strictEqual(table, "users");
    return { upsert(payload, options) {
      writes.push([payload, options]);
      return Promise.resolve({ error: null });
    } };
  } };
  assert.strictEqual(await saveConversationState("+919999999999", { awaiting: "corrected_meal" }, saveClient), true);
  assert.deepStrictEqual(writes, [[
    { phone_number: "+919999999999", conversation_state: { awaiting: "corrected_meal" } },
    { onConflict: "phone_number" },
  ]]);

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const failedRecent = recentClient({ data: null, error: { message: "query failed" } });
    assert.deepStrictEqual(await recentConversation("+919999999999", queryNow, failedRecent.client), []);
    assert.deepStrictEqual(await recentConversation("+919999999999", new Date("invalid"), {
      from() { throw new Error("must not query"); },
    }), []);
    assert.strictEqual(await saveConversationState("+919999999999", null, { from() {
      return { upsert() { return Promise.resolve({ error: { message: "write failed" } }); } };
    } }), false);
  } finally {
    console.error = originalConsoleError;
  }
})();

const now = 1_700_000_000_000;
const futureIso = new Date(now + 1).toISOString();
assert.strictEqual(WINDOW_MS, 6 * 60 * 60 * 1000);
assert.strictEqual(MAX_EXCHANGES, 10);

assert.deepStrictEqual(normaliseConversationState({
  awaiting: "corrected_meal", expiresAt: futureIso,
}, now), { awaiting: "corrected_meal", expiresAt: futureIso });
assert.deepStrictEqual(normaliseConversationState({
  awaiting: "repeat_meal_choice", expiresAt: futureIso,
}, now), { awaiting: "repeat_meal_choice", expiresAt: futureIso });
assert.deepStrictEqual(normaliseConversationState({ awaiting: "wrong", expiresAt: futureIso }, now), {});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: new Date(now).toISOString() }, now), {});
assert.deepStrictEqual(normaliseConversationState(null, now), {});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: "2023-11-14T22:13:20Z" }, now), {});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: "2023-02-29T22:13:20Z" }, now), {});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: "2026-04-31T22:13:20Z" }, now), {});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: "2026-01-01T24:00:00Z" }, now), {});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: "2023-11-14T22:13:20.001+00:00" }, now), {
  awaiting: "corrected_meal", expiresAt: futureIso,
});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: "2023-11-15T03:43:20.001+05:30" }, now), {
  awaiting: "corrected_meal", expiresAt: futureIso,
});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: futureIso }, Symbol("now")), {});
assert.deepStrictEqual(normaliseConversationState(Symbol("state"), now), {});

const active = { awaiting: "corrected_meal", expiresAt: futureIso };
assert.strictEqual(needsConversationContext("anything", active, now), true);
assert.strictEqual(needsConversationContext("", {}, now), false);
assert.strictEqual(needsConversationContext("same one", {}, now), true);
assert.strictEqual(needsConversationContext("I meant lunch", {}, now), true);
assert.strictEqual(needsConversationContext("without sugar", {}, now), true);
assert.strictEqual(needsConversationContext("this much", {}, now), true);
assert.strictEqual(needsConversationContext("review it", {}, now), true);
assert.strictEqual(needsConversationContext("breakfast was poha", {}, now), true);
assert.strictEqual(needsConversationContext("breakfast", {}, now), false);
assert.strictEqual(needsConversationContext("2 eggs", {}, now), false);
assert.strictEqual(needsConversationContext("one banana", {}, now), false);
assert.strictEqual(needsConversationContext("hello there", {}, now), false);
assert.strictEqual(needsConversationContext("half bowl", {}, now), true);
assert.strictEqual(needsConversationContext("kg", {}, now), true);
assert.strictEqual(needsConversationContext("kilograms", {}, now), true);
assert.strictEqual(needsConversationContext("lbs", {}, now), true);
assert.strictEqual(needsConversationContext("2 roti and dal", {}, now), false);

const exchanges = Array.from({ length: 12 }, (_, index) => ({
  body: `meal ${index} ${"x".repeat(350)}`,
  reply: `reply ${index} ${"y".repeat(550)}`,
  phone_number: "+919999999999",
  media: index === 11,
  at: futureIso,
}));
exchanges[11].body = "";
const context = formatConversationContext(exchanges);
assert.match(context, /TRUSTED RECENT CONVERSATION.*read-only/i);
assert.match(context, /only for resolving CURRENT USER MESSAGE/i);
assert.match(context, /Only the current message may create actions or items/i);
assert.match(context, /never replay historical foods, quantities, goals, or commands/i);
assert.doesNotMatch(context, /USER: meal [01] x|9999999999/);
assert.match(context, /USER: \[media without text\]/);
assert.match(context, /NUTRIDESI: reply 11/);
assert.ok(context.split("\n").filter(line => line.startsWith("USER:")).every(line => line.length <= 306));
assert.ok(context.split("\n").filter(line => line.startsWith("NUTRIDESI:")).every(line => line.length <= 512));
assert.strictEqual(formatConversationContext([]), "");

assert.strictEqual(refersToRecentMedia("what is this?", exchanges), true);
assert.strictEqual(refersToRecentMedia("what is this?", [{ body: "photo", reply: "ok" }]), false);
assert.strictEqual(refersToRecentMedia("what is this?", [{ body: "photo", reply: "ok", media: "false" }]), false);
assert.strictEqual(isCorrectionCue("I m telling from first, it was poha"), true);
assert.strictEqual(isCorrectionCue("i'm telling you from the first one"), true);
assert.strictEqual(isCorrectionCue("I am saying it was earlier meal"), true);
assert.strictEqual(isCorrectionCue("actually meant poha"), true);
assert.strictEqual(isCorrectionCue("actually I meant poha"), true);
assert.strictEqual(isCorrectionCue("actually, it was poha"), false);
assert.strictEqual(isCorrectionCue("actually, how much protein?"), false);
assert.strictEqual(isCorrectionCue("is this correct?"), false);
assert.strictEqual(isCorrectionCue("not a correction, log another meal"), false);
assert.strictEqual(isCorrectionCue("don't correct it, this is a new meal"), false);
assert.strictEqual(isCorrectionCue("did you apply my correction?"), false);
assert.strictEqual(isCorrectionCue("is this corrected?"), false);
assert.strictEqual(isCorrectionCue("2 roti and dal"), false);

const logged = [{ body: "2 idli sambhar coconut chutney", reply: "✅ Logged: breakfast" }];
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", logged), true);
assert.strictEqual(repeatedMealCandidate("idli sambhar", logged), false);
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", [{ body: "idli", reply: "Not logged" }]), false);
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", [{ body: "breakfast oats milk banana almonds", reply: "✅ Logged: breakfast" }]), false);
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney dosa pasta pizza burger", logged), false);
const anonymizedBreakfast = [{
  body: "rolled oats low fat milk yogabar protein powder mango",
  reply: "✅ Logged: breakfast",
}];
assert.strictEqual(repeatedMealCandidate("rolled oats low fat milk yogabar protein powder mango", anonymizedBreakfast), true);

const pending = { awaiting: "repeat_meal_choice", expiresAt: futureIso };
assert.strictEqual(resolvePendingChoice("correct the first one", pending, now), "correction");
assert.strictEqual(resolvePendingChoice("log another meal", pending, now), "new");
assert.strictEqual(resolvePendingChoice("correction", pending, now), "correction");
assert.strictEqual(resolvePendingChoice("new meal", pending, now), "new");
assert.strictEqual(resolvePendingChoice("correction.", pending, now), "correction");
assert.strictEqual(resolvePendingChoice("new meal!", pending, now), "new");
assert.strictEqual(resolvePendingChoice("correction?", pending, now), null);
assert.strictEqual(resolvePendingChoice("don't correct it, this is a new meal", pending, now), null);
assert.strictEqual(resolvePendingChoice("not a correction, log another meal", pending, now), null);
assert.strictEqual(resolvePendingChoice("correct it and log a new meal", pending, now), null);
assert.strictEqual(resolvePendingChoice("yes", pending, now), null);
assert.strictEqual(resolvePendingChoice("new meal", null, now), null);

const proteinReply = contextualProteinGoalReply("protein for this calorie goal?", { calorie_goal: 1800 });
assert.match(proteinReply, /1,800 kcal/);
assert.match(proteinReply, /weight.*kg.*fat loss.*maintenance/i);
assert.strictEqual(contextualProteinGoalReply("protein in dal?", { calorie_goal: 1800 }), null);
assert.strictEqual(contextualProteinGoalReply("protein for this goal?", { calorie_goal: 1800, protein_goal: 100 }), null);
assert.strictEqual(contextualProteinGoalReply(null, null), null);
assert.doesNotThrow(() => {
  const throwing = { toString() { throw new Error("nope"); } };
  needsConversationContext(throwing, throwing, now);
  formatConversationContext([throwing]);
  refersToRecentMedia(throwing, [throwing]);
  isCorrectionCue(throwing);
  repeatedMealCandidate(throwing, [throwing]);
  resolvePendingChoice(throwing, throwing, now);
  contextualProteinGoalReply(throwing, throwing);
});

dbHelperTests.then(() => console.log("conversation-memory-test: all passed"))
  .catch(error => { console.error(error); process.exitCode = 1; });
