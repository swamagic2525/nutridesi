// Unit shapes for correction-target alignment (matchRows). Every shape comes
// from a real incident in docs/correction-incidents.md — run after any change
// to src/correctionContext.js:  node test/correction-test.js

const assert = require("assert");
const { matchRows } = require("../src/correctionContext.js");

const bare = [{ food_name: null, stated_kcal: 200 }];
let n = 0;
const t = (name, rows, hints, raw, expect) => {
  const got = matchRows(rows, hints, raw);
  const target = got[0] ? got[0].food_name : null;
  assert.strictEqual(target, expect, `${name}: got ${target}, expected ${expect}`);
  n++;
};

// Class A — Priyanka 2026-07-19: bare "it was 200 cal" targets the sole
// uncurated item, even when it is gram-prefixed (parser grams leak).
t("bare-it: sole uncurated gram row", [
  { id: 1, food_name: "Masala Dosa", matched_db_id: 15, is_estimate: false },
  { id: 2, food_name: "Sambar", matched_db_id: 16, is_estimate: false },
  { id: 3, food_name: "30g Wholetruth cold coffee whey protein", matched_db_id: null, is_estimate: true },
  { id: 4, food_name: "30g Milk (Full Fat)", matched_db_id: 34, is_estimate: true },
  { id: 5, food_name: "Chai (with milk)", matched_db_id: 31, is_estimate: false },
], bare, "It was 200 calories and 36 gm protein", "30g Wholetruth cold coffee whey protein");

// Class A — all-curated batch: sole non-gram estimate wins; user-weighed
// gram rows are never correction targets.
t("bare-it: sole non-gram estimate", [
  { id: 1, food_name: "Masala Dosa", matched_db_id: 15, is_estimate: false },
  { id: 2, food_name: "Protein Shake", matched_db_id: 58, is_estimate: true },
  { id: 3, food_name: "30g Milk (Full Fat)", matched_db_id: 34, is_estimate: true },
], bare, "It was 200 calories", "Protein Shake");

// Genuinely ambiguous (two estimates) must refuse, not guess.
t("bare-it: two estimates refuse", [
  { id: 1, food_name: "Protein Shake", matched_db_id: 58, is_estimate: true },
  { id: 2, food_name: "Palak Paneer", matched_db_id: 27, is_estimate: true },
], bare, "It was 200 calories", null);

// Named hints keep exact-word alignment.
t("named hint word overlap", [
  { id: 1, food_name: "Roti / Chapati", matched_db_id: 1, is_estimate: false },
  { id: 2, food_name: "Dal Tadka", matched_db_id: 17, is_estimate: false },
], [{ food_name: "dal" }], "dal was 120", "Dal Tadka");

// Class B — •5400 2026-07-15: brand rename with ZERO word overlap against the
// row name ("MB biozyme whey isolate" vs "Protein Shake") targets the sole
// estimate instead of dead-ending (old code deleted all five items).
t("rename: zero-overlap brand -> sole estimate", [
  { id: 1, food_name: "Protein Shake", matched_db_id: 58, is_estimate: true },
  { id: 2, food_name: "Poha", matched_db_id: 12, is_estimate: false },
  { id: 3, food_name: "Peanuts", matched_db_id: 159, is_estimate: false },
  { id: 4, food_name: "Egg Whites", matched_db_id: 71, is_estimate: false },
  { id: 5, food_name: "Egg (Fried/Half Fry)", matched_db_id: 133, is_estimate: false },
], [{ food_name: "muscle blaze biozyme whey isolate", stated_protein: 27 }],
  "It was muscle blaze biozyme whey isolate. That has 27 grams of protein", "Protein Shake");

// Class B — •2531 2026-07-13: renaming one item must not consume siblings.
t("rename: overlap targets only the named row", [
  { id: 1, food_name: "Black Coffee", matched_db_id: 117, is_estimate: false },
  { id: 2, food_name: "Chia Seeds", matched_db_id: 119, is_estimate: true },
], [{ food_name: "coffee with skimmed milk" }], "Cup of Coffee wasnt black", "Black Coffee");

// Atomicity: with two unmatched hints and one flagged row, the second hint
// stays null so deleteMatchingLastLog refuses rather than half-editing.
const two = matchRows([
  { id: 1, food_name: "Protein Shake", matched_db_id: 58, is_estimate: true },
  { id: 2, food_name: "Poha", matched_db_id: 12, is_estimate: false },
], [{ food_name: "brand x" }, { food_name: "brand y" }], "brand x 100 cal brand y 200 cal");
assert.strictEqual(two[0] && two[0].food_name, "Protein Shake");
assert.strictEqual(two[1], null);
n++;

console.log(`correction-test: ${n} shapes passed`);
