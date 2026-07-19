const assert = require("assert");
const { guardItems, extractGroups } = require("../src/proteinGuard.js");

// --- extractGroups: Hinglish synonyms collapse into one protein group ---
assert.deepStrictEqual([...extractGroups("chicken paratha")], ["chicken"]);
assert.deepStrictEqual([...extractGroups("murgh biryani")], ["chicken"]);
assert.deepStrictEqual([...extractGroups("anda bhurji")], ["egg"]);
assert.deepStrictEqual([...extractGroups("keema pav")], ["keema"]);
assert.deepStrictEqual([...extractGroups("plain dal tadka")], []);
// word boundaries: "eggplant" must NOT read as egg
assert.deepStrictEqual([...extractGroups("eggplant curry")], []);

// --- guardItems: cross-protein matches trip, legitimate matches don't ---
// Incident class: non-veg food matched to a veg DB item (id 3 = Paratha (Stuffed), veg)
let items = [{ food_name: "fish paratha", matched_db_id: 3, quantity: 1 }];
let tripped = guardItems(items);
assert.strictEqual(tripped.length, 1);
assert.strictEqual(items[0].matched_db_id, null);
assert.strictEqual(items[0].match_type, "none");
assert.strictEqual(items[0].protein_guard, true);

// Wrong protein: mutton biryani matched to id 8 = Biryani (Chicken)
items = [{ food_name: "mutton biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);
assert.strictEqual(items[0].matched_db_id, null);

// Correct protein match: no trip
items = [{ food_name: "chicken biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);
assert.strictEqual(items[0].matched_db_id, 8);

// Hinglish synonym on both sides: murgh == chicken, no trip
items = [{ food_name: "murgh biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);

// Veg food matched to veg item: no protein words anywhere, no trip
items = [{ food_name: "aloo paratha", matched_db_id: 3, quantity: 2 }];
assert.strictEqual(guardItems(items).length, 0);

// Veg-default policy (2026-07-19): bare "biryani" is an alias of Biryani (Veg)
// id 9, NOT of Chicken Biryani. Matched to 9 -> no trip; matched to 8 -> the
// reverse rule trips it (no alias of 8 appears in the user's words).
items = [{ food_name: "biryani", matched_db_id: 9, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);
items = [{ food_name: "biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);
assert.strictEqual(items[0].matched_db_id, null);

// Deliberate non-veg default kept by alias containment: bare "bhurji" IS an
// alias of Egg Bhurji (150), so no trip
items = [{ food_name: "bhurji", matched_db_id: 150, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);

// Explicit veg words clash with a non-veg DB item
items = [{ food_name: "veg biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);

// Reverse direction: bare "paratha" wrongly matched to id 183 = Chicken Paratha
// (no alias of 183 appears in the user's words) -> trip
items = [{ food_name: "paratha", matched_db_id: 183, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);

// Correct curated non-veg match survives: chicken paratha -> id 183
items = [{ food_name: "chicken paratha", matched_db_id: 183, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);

// Safety: null food_name (correction flows) and unmatched items are skipped
items = [
  { food_name: null, matched_db_id: 68, quantity: 1 },
  { food_name: "random unknown", matched_db_id: null, quantity: 1 },
];
assert.strictEqual(guardItems(items).length, 0);
assert.strictEqual(items[0].matched_db_id, 68);

// Multi-item: only the offending item trips
items = [
  { food_name: "2 roti", matched_db_id: 1, quantity: 2 },
  { food_name: "prawn curry", matched_db_id: 24, quantity: 1 }, // 24 = Chicken Curry
];
tripped = guardItems(items);
assert.strictEqual(tripped.length, 1);
assert.strictEqual(items[0].matched_db_id, 1);
assert.strictEqual(items[1].matched_db_id, null);

console.log("protein-guard-test: all passed");
