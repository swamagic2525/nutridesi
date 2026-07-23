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
assert.deepStrictEqual(normaliseConversationState({ awaiting: "corrected_meal", expiresAt: "2023-11-14T22:13:20.001+00:00" }, now), {});
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
assert.strictEqual(isCorrectionCue("actually, it was poha"), false);
assert.strictEqual(isCorrectionCue("is this correct?"), false);
assert.strictEqual(isCorrectionCue("2 roti and dal"), false);

const logged = [{ body: "2 idli sambhar coconut chutney", reply: "✅ Logged: breakfast" }];
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", logged), true);
assert.strictEqual(repeatedMealCandidate("idli sambhar", logged), false);
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", [{ body: "idli", reply: "Not logged" }]), false);
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney", [{ body: "breakfast oats milk banana almonds", reply: "✅ Logged: breakfast" }]), false);
assert.strictEqual(repeatedMealCandidate("idli sambhar coconut chutney dosa pasta pizza burger", logged), false);

const pending = { awaiting: "repeat_meal_choice", expiresAt: futureIso };
assert.strictEqual(resolvePendingChoice("correct the first one", pending, now), "correction");
assert.strictEqual(resolvePendingChoice("log another meal", pending, now), "new");
assert.strictEqual(resolvePendingChoice("correction", pending, now), "correction");
assert.strictEqual(resolvePendingChoice("new meal", pending, now), "new");
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

console.log("conversation-memory-test: all passed");
