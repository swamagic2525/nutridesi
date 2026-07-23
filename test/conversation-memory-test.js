const assert = require("assert");
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

const now = 1_700_000_000_000;
assert.strictEqual(WINDOW_MS, 6 * 60 * 60 * 1000);
assert.strictEqual(MAX_EXCHANGES, 10);

assert.deepStrictEqual(normaliseConversationState({
  awaiting: "corrected_meal", expiresAt: now + 1,
}, now), { awaiting: "corrected_meal", expiresAt: now + 1 });
assert.deepStrictEqual(normaliseConversationState({
  awaiting: "repeat_meal_choice", expiresAt: now + 1,
}, now), { awaiting: "repeat_meal_choice", expiresAt: now + 1 });
assert.deepStrictEqual(normaliseConversationState({ awaiting: "wrong", expiresAt: now + 1 }, now), {});
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: now }, now), {});
assert.deepStrictEqual(normaliseConversationState(null, now), {});

const active = { awaiting: "corrected_meal", expiresAt: now + 1 };
assert.strictEqual(needsConversationContext("anything", active, now), true);
assert.strictEqual(needsConversationContext("", {}, now), false);
assert.strictEqual(needsConversationContext("same one", {}, now), true);
assert.strictEqual(needsConversationContext("actually meant lunch", {}, now), true);
assert.strictEqual(needsConversationContext("without sugar", {}, now), true);
assert.strictEqual(needsConversationContext("this much", {}, now), true);
assert.strictEqual(needsConversationContext("review it", {}, now), true);
assert.strictEqual(needsConversationContext("breakfast was poha", {}, now), true);
assert.strictEqual(needsConversationContext("2 roti and dal", {}, now), false);

const exchanges = Array.from({ length: 12 }, (_, index) => ({
  inbound: `meal ${index} ${"x".repeat(350)}`,
  reply: `reply ${index} ${"y".repeat(550)}`,
  phone: "+919999999999",
  media: index === 11,
}));
exchanges[11].inbound = "";
const context = formatConversationContext(exchanges);
assert.match(context, /trusted, read-only/i);
assert.doesNotMatch(context, /USER: meal [01] x|9999999999/);
assert.match(context, /USER: \[media without text\]/);
assert.match(context, /NUTRIDESI: reply 11/);
assert.ok(context.split("\n").filter(line => line.startsWith("USER:")).every(line => line.length <= 306));
assert.ok(context.split("\n").filter(line => line.startsWith("NUTRIDESI:")).every(line => line.length <= 512));

assert.strictEqual(refersToRecentMedia("what is this?", exchanges), true);
assert.strictEqual(refersToRecentMedia("what is this?", [{ inbound: "photo", reply: "ok" }]), false);
assert.strictEqual(isCorrectionCue("I m telling from first, it was poha"), true);
assert.strictEqual(isCorrectionCue("i'm telling you from the first one"), true);
assert.strictEqual(isCorrectionCue("2 roti and dal"), false);

const logged = [{ inbound: "2 idli sambhar coconut chutney", reply: "✅ Logged: breakfast" }];
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", logged), true);
assert.strictEqual(repeatedMealCandidate("idli sambhar", logged), false);
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", [{ inbound: "idli", reply: "Not logged" }]), false);

const pending = { awaiting: "repeat_meal_choice", expiresAt: now + 1 };
assert.strictEqual(resolvePendingChoice("correct the first one", pending, now), "correction");
assert.strictEqual(resolvePendingChoice("log another meal", pending, now), "new");
assert.strictEqual(resolvePendingChoice("yes", pending, now), null);
assert.strictEqual(resolvePendingChoice("new meal", null, now), null);

const proteinReply = contextualProteinGoalReply("protein for this calorie goal?", { calorie_goal: 1800 });
assert.match(proteinReply, /1,800 kcal/);
assert.match(proteinReply, /weight.*kg.*fat loss.*maintenance/i);
assert.strictEqual(contextualProteinGoalReply("protein in dal?", { calorie_goal: 1800 }), null);
assert.strictEqual(contextualProteinGoalReply("protein for this goal?", { calorie_goal: 1800, protein_goal: 100 }), null);
assert.strictEqual(contextualProteinGoalReply(null, null), null);

console.log("conversation-memory-test: all passed");
