const assert = require("assert");
const { looksLikeCorrection, shouldPromoteToReplace, formatLastLogContext } = require("../src/correctionContext.js");

const cake = [{ id: 12, food_name: "Cake slice", quantity: 1, kcal: 220, protein: 3, is_estimate: true }];
const breakfast = [
  { id: 1, food_name: "Roti / Chapati", quantity: 2, kcal: 178, protein: 5, is_estimate: false },
  { id: 2, food_name: "Dal Tadka", quantity: 1, kcal: 180, protein: 10, is_estimate: false },
];

assert(looksLikeCorrection("cake slice was 150 kcal, 5g protein"));
assert(looksLikeCorrection("I had 3 of them"));
assert(!looksLikeCorrection("I had 3 eggs and toast"));

assert(shouldPromoteToReplace({ intent: "log", items: [{ food_name: "cake slice", stated_kcal: 150 }] }, "cake slice was 150 kcal", cake));
assert(shouldPromoteToReplace({ intent: "log", items: [{ food_name: null, stated_kcal: 150 }] }, "it was 150 kcal", cake));
assert(!shouldPromoteToReplace({ intent: "log", items: [{ food_name: "banana", stated_kcal: 100 }] }, "banana was 100 kcal", cake));
assert(!shouldPromoteToReplace({ intent: "log", items: [{ food_name: "roti", stated_kcal: 90 }] }, "roti was 90 kcal", []));

const context = formatLastLogContext(breakfast);
assert(context.includes("Roti / Chapati ×2"));
assert(context.includes("Dal Tadka"));
console.log("Correction context tests: passed (6 cases)");
