require("dotenv").config();
const assert = require("assert");
const { extractGroups } = require("../src/proteinGuard.js");
const { resolveRows, acceptableRef } = require("../src/db.js");

// --- Negation blindness (2026-07-20: "2 eggs" -> 988 kcal of mayonnaise) ---
assert.deepStrictEqual([...extractGroups("Mayonnaise without eggs")], [],
  "a recipe that excludes eggs is not an egg food");
assert.deepStrictEqual([...extractGroups("eggless cake")], []);
assert.deepStrictEqual([...extractGroups("egg-free mayo")], []);
assert.deepStrictEqual([...extractGroups("chicken-free nuggets")], []);
// Real mentions still register
assert.deepStrictEqual([...extractGroups("2 eggs")], ["egg"]);
assert.deepStrictEqual([...extractGroups("egg bhurji")], ["egg"]);
assert.deepStrictEqual([...extractGroups("butter chicken")], ["chicken"]);

// --- INDB acceptance: negation and runaway specificity ---
assert.strictEqual(acceptableRef("eggs", "Mayonnaise without eggs"), false);
assert.strictEqual(acceptableRef("sabji", "Okra/Lady's fingers fry (Bhindi sabzi/sabji/subji)"), false);
// Legitimate hits still pass
assert.strictEqual(acceptableRef("dhansak", "Dhansak (vegetarian)"), true);
assert.strictEqual(acceptableRef("mutton biryani", "Mutton biryani/biriyani"), true);
assert.strictEqual(acceptableRef("aloo paratha", "Potato parantha/paratha (Aloo ka parantha/paratha)"), true);
assert.strictEqual(acceptableRef("", "Anything"), false);

// --- Macro profiles for unknown foods ---
(async () => {
  let rows = await resolveRows({ items: [
    { food_name: "munch chocolate", matched_db_id: null, quantity: 1, est_kcal: 120 },
  ] });
  assert.ok(rows[0].protein < 3, `chocolate protein should be tiny, got ${rows[0].protein}g`);

  rows = await resolveRows({ items: [
    { food_name: "mutton curry", matched_db_id: null, quantity: 1, est_kcal: 350 },
  ] });
  assert.ok(rows[0].protein > 20, `meat dish protein should be high, got ${rows[0].protein}g`);

  // --- Exact-alias rescue keeps "eggs" off the fuzzy path entirely ---
  rows = await resolveRows({ items: [
    { food_name: "eggs", matched_db_id: null, quantity: 2, match_type: "none" },
  ] });
  assert.strictEqual(rows[0].matched_db_id, 43, "bare 'eggs' resolves to the curated egg entry");
  assert.strictEqual(rows[0].kcal, 140);

  // The full incident message, end to end
  rows = await resolveRows({ items: [
    { food_name: "maggie", matched_db_id: 94, quantity: 1, match_type: "direct" },
    { food_name: "eggs", matched_db_id: null, quantity: 2, match_type: "none" },
  ] });
  assert.ok(rows.every(r => r.kcal < 400), `no absurd totals, got ${rows.map(r => r.kcal)}`);
  assert.ok(!/mayonnaise/i.test(rows.map(r => r.food_name).join(" ")), "mayonnaise must not appear");

  console.log("ref-guard-test: all passed");
})().catch(e => { console.error(e); process.exit(1); });

// Arbitration path must apply the same acceptance rules as the primary path
// ("sabji" was overriding Mixed Veg Sabzi with a specific bhindi fry).
(async () => {
  const { resolveRows } = require("../src/db.js");
  const rows = await resolveRows({ items: [
    { food_name: "sabji", matched_db_id: 29, quantity: 1, match_type: "category" },
  ] });
  assert.strictEqual(rows[0].matched_db_id, 29, "curated Mixed Veg Sabzi stands");
  assert.ok(!/okra/i.test(rows[0].food_name), "no specific bhindi recipe override");
  console.log("ref-guard-test: arbitration guard passed");
})().catch(e => { console.error(e); process.exit(1); });

// Weight-based unknown foods must use per-100g, not a 150g "serving" assumption
// (50g chocos logged 63 kcal against a real ~187).
(async () => {
  const { resolveRows } = require("../src/db.js");
  let rows = await resolveRows({ items: [
    { food_name: "chocos", matched_db_id: null, grams: 50, quantity: 1, est_kcal: 190, est_kcal_100g: 373 },
  ] });
  assert.strictEqual(rows[0].kcal, 187, `50g at 373/100g should be 187, got ${rows[0].kcal}`);

  // Falls back to the old serving math when the model gives no per-100g figure
  rows = await resolveRows({ items: [
    { food_name: "mystery snack", matched_db_id: null, grams: 150, quantity: 1, est_kcal: 200 },
  ] });
  assert.strictEqual(rows[0].kcal, 200);

  // Generic category words are an assumption, shown to the user
  rows = await resolveRows({ items: [
    { food_name: "sabji", matched_db_id: 29, quantity: 1, match_type: "direct" },
  ] });
  assert.strictEqual(rows[0].matched_db_id, 29);
  assert.strictEqual(rows[0].assumed, true, "generic 'sabji' must surface the assumption");

  // A specific dish stays silent
  rows = await resolveRows({ items: [
    { food_name: "palak sabzi", matched_db_id: 182, quantity: 1, match_type: "direct" },
  ] });
  assert.strictEqual(rows[0].assumed, false, "a specific dish needs no confession");

  console.log("ref-guard-test: grams + generic-term guards passed");
})().catch(e => { console.error(e); process.exit(1); });
