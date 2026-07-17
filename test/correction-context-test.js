const assert = require("assert");
const { looksLikeCorrection, shouldPromoteToReplace, formatLastLogContext, matchRows } = require("../src/correctionContext.js");

const cake = [{ id: 12, food_name: "Cake slice", quantity: 1, kcal: 220, protein: 3, is_estimate: true }];
const breakfast = [
  { id: 1, food_name: "Roti / Chapati", quantity: 2, kcal: 178, protein: 5, is_estimate: false },
  { id: 2, food_name: "Dal Tadka", quantity: 1, kcal: 180, protein: 10, is_estimate: false },
];

assert(looksLikeCorrection("cake slice was 150 kcal, 5g protein"));
assert(looksLikeCorrection("Chicken breast was 50g"));
assert(looksLikeCorrection("I had 3 of them"));
assert(!looksLikeCorrection("I had 3 eggs and toast"));

assert(shouldPromoteToReplace({ intent: "log", items: [{ food_name: "cake slice", stated_kcal: 150 }] }, "cake slice was 150 kcal", cake));
assert(shouldPromoteToReplace({ intent: "log", items: [{ food_name: null, stated_kcal: 150 }] }, "it was 150 kcal", cake));
assert(!shouldPromoteToReplace({ intent: "log", items: [{ food_name: "banana", stated_kcal: 100 }] }, "banana was 100 kcal", cake));
assert(!shouldPromoteToReplace({ intent: "log", items: [{ food_name: "roti", stated_kcal: 90 }] }, "roti was 90 kcal", []));

const context = formatLastLogContext(breakfast);
assert(context.includes("Roti / Chapati ×2"));
assert(context.includes("Dal Tadka"));

const multiItemBatch = [
  { id: 1, food_name: "150g Chicken Breast", matched_db_id: 68 },
  { id: 2, food_name: "Roti / Chapati", matched_db_id: 1 },
  { id: 3, food_name: "Bhel Puri", matched_db_id: 59 },
];
const [matchedChicken] = matchRows(multiItemBatch, [{ food_name: null, matched_db_id: 68 }]);
assert.strictEqual(matchedChicken.id, 1);

// Regression: the model may return food_name null for a named correction of an
// estimated food. The raw user message must still target Cake slice safely.
const cakeBatch = [
  { id: 11, food_name: "Cake slice", matched_db_id: null },
  { id: 12, food_name: "Roti / Chapati", matched_db_id: 1 },
  { id: 13, food_name: "Dal Tadka", matched_db_id: 17 },
  { id: 14, food_name: "Chai (with milk)", matched_db_id: 12 },
];
const [matchedCake] = matchRows(cakeBatch, [{ food_name: null, matched_db_id: null }], "Cake slice was 150 cals, 5g protein");
assert.strictEqual(matchedCake.id, 11);
const [ambiguousPronoun] = matchRows(cakeBatch, [{ food_name: null, matched_db_id: null }], "it was 150 cals");
assert.strictEqual(ambiguousPronoun, null);
console.log("Correction context tests: passed (10 cases)");
