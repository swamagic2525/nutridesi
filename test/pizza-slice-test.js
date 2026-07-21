// Deterministic pizza-slice pin (no LLM). "2 slices pizza" must not log whole
// pizzas after bare "pizza" was remapped to a whole-pizza SKU.
const assert = require("assert");
const parser = require("../src/parser.js");

// pinPizzaSlices isn't exported; exercise it through the module's regex + a
// hand-built parse object by re-requiring the internal via a tiny shim.
// Simplest: replicate the contract by calling parseMeal's helper indirectly is
// overkill — instead assert the observable rule on a stubbed parsed object.
const { pinPizzaSlices } = require("../src/parser.js");

function run(raw, items) { return pinPizzaSlices(raw, { items }).items; }

// "slices pizza" adjacency -> whole-pizza id 307 becomes slice id 95
let r = run("2 slices pizza", [{ food_name: "pizza", matched_db_id: 307, quantity: 2 }]);
assert.strictEqual(r[0].matched_db_id, 95, "2 slices pizza should be per-slice (95)");

r = run("2 slices of pizza", [{ food_name: "pizza", matched_db_id: 310, quantity: 2 }]);
assert.strictEqual(r[0].matched_db_id, 95, "slices of pizza should be per-slice even for cheese burst");

// A whole pizza with "slices" referring to a DIFFERENT food must NOT remap.
r = run("1 pizza and 2 slices of cake", [
  { food_name: "pizza", matched_db_id: 307, quantity: 1 },
  { food_name: "cake", matched_db_id: null, quantity: 2 },
]);
assert.strictEqual(r[0].matched_db_id, 307, "whole pizza must stay whole when slices refer to cake");

// No "slice" word -> untouched.
r = run("1 regular pizza", [{ food_name: "pizza", matched_db_id: 307, quantity: 1 }]);
assert.strictEqual(r[0].matched_db_id, 307, "whole pizza stays whole with no slice word");

console.log("pizza-slice-test: all passed");

// Size default: generic medium (312) downgrades to regular (307) with no size word;
// stays medium when the user says "medium".
r = run("1 pizza", [{ food_name: "pizza", matched_db_id: 312, quantity: 1 }]);
assert.strictEqual(r[0].matched_db_id, 307, "bare pizza should default to regular, not medium");
r = run("1 medium pizza", [{ food_name: "pizza", matched_db_id: 312, quantity: 1 }]);
assert.strictEqual(r[0].matched_db_id, 312, "explicit medium stays medium");
console.log("pizza-slice-test: size-default cases passed");
