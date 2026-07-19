const assert = require("assert");
const { contextGuard, contentTokens } = require("../src/contextGuard.js");

// contentTokens strips filler words and bare numbers
assert.deepStrictEqual(contentTokens("2 garam roti"), ["roti"]);
assert.deepStrictEqual(contentTokens("ghar ka methi puri"), ["methi", "puri"]);

// --- Rung 1: a full-phrase alias of another curated food wins (silent rematch) ---
let items = [{ food_name: "sev puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 61); // Sev Puri, not plain Puri
assert.strictEqual(items[0].alias_arbitrated, true);

items = [{ food_name: "pani puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 60);

items = [{ food_name: "chole bhature", matched_db_id: 19, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 67);

// The original incident, now fixed deterministically (183 = curated Chicken Paratha)
items = [{ food_name: "chicken paratha", matched_db_id: 3, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 183);

// Correct match is a no-op
items = [{ food_name: "sev puri", matched_db_id: 61, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 61);
assert.strictEqual(items[0].alias_arbitrated, undefined);

// Multi-word alias of the matched food itself - no rematch, no flags
items = [{ food_name: "puri bhaji", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 4);
assert.strictEqual(items[0].compound_suspect, undefined);
assert.strictEqual(items[0].coverage_suspect, undefined);

// Word-order variant covered by an alias stays quiet ("makhani dal" is an alias of 18)
items = [{ food_name: "makhani dal", matched_db_id: 18, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 18);
assert.strictEqual(items[0].coverage_suspect, undefined);

// --- Rung 2: two disjoint aliases = compound dish - flag, don't guess which half wins ---
items = [{ food_name: "chole puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 4); // untouched until INDB evidence
assert.strictEqual(items[0].compound_suspect, true);

// --- Rung 3: leftover content word the matched food's corpus can't explain ---
items = [{ food_name: "methi puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 4); // untouched until INDB evidence
assert.deepStrictEqual(items[0].coverage_suspect, ["methi"]);

// Filler never trips coverage
items = [{ food_name: "garam roti", matched_db_id: 1, quantity: 2 }];
contextGuard(items);
assert.strictEqual(items[0].coverage_suspect, undefined);

// Unmatched and null-name items are skipped entirely
items = [
  { food_name: null, matched_db_id: 68, quantity: 1 },
  { food_name: "mystery dish", matched_db_id: null, quantity: 1 },
];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 68);
assert.strictEqual(items[1].coverage_suspect, undefined);

console.log("context-guard-test: all passed");
