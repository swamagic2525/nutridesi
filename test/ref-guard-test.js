require("dotenv").config();
const assert = require("assert");
const { extractGroups } = require("../src/proteinGuard.js");
const { resolveRows, resolveItem, applyStatedNutrition, acceptableRef, applyReference } = require("../src/db.js");

assert.strictEqual(typeof resolveItem, "function", "stated-basis scaling is testable as pure logic");
const corrected75g = resolveItem({
  food_name: "Yogabar High Protein Oats (Dark Chocolate)", matched_db_id: 134,
  grams: 75, portion_unit: "g", quantity: 1,
  stated_protein: 26, stated_basis_amount: 100, stated_basis_unit: "g",
});
assert.strictEqual(corrected75g.protein, 19.5, "26g/100g deterministically becomes 19.5g at 75g");
assert.strictEqual(corrected75g.portionAmount, 75);
assert.strictEqual(corrected75g.portionUnit, "g");

const correctedMilk = resolveItem({
  food_name: "Milk (Full Fat)", matched_db_id: 34,
  grams: 350, portion_unit: "ml", quantity: 1,
  stated_kcal: 217, stated_protein: 12,
  stated_basis_amount: 350, stated_basis_unit: "ml",
});
assert.strictEqual(correctedMilk.kcal, 217);
assert.strictEqual(correctedMilk.protein, 12);
assert.strictEqual(correctedMilk.unit, "350ml");

const correctedScoops = resolveItem({
  food_name: "Protein Shake", matched_db_id: 58, quantity: 2,
  stated_protein: 30, stated_basis_amount: 1, stated_basis_unit: "scoop",
});
assert.strictEqual(correctedScoops.protein, 60, "30g per scoop scales to two scoops");

// A weighed branded item must keep its consumed amount when the reference tier
// supplies per-100g nutrition. The old path replaced 75g with one opaque
// serving, which made later correction memories impossible to scale.
assert.strictEqual(typeof applyReference, "function", "applyReference is testable as pure resolution logic");
const weightedReference = {
  food_code: "AIS0129",
  food_name: "Yogabar High Protein Oats (Dark Chocolate)",
  serving_unit: "serving", serving_kcal: 202, serving_protein: 15,
  serving_carbs: 30, serving_fat: 5, serving_fibre: 4,
  kcal_100g: 404, protein_100g: 30, carbs_100g: 60, fat_100g: 10, fibre_100g: 8,
};
const weightedRow = {
  food_name: "75g yogabar oats", quantity: 1, unit: "75g",
  portionAmount: 75, portionUnit: "g", kcal: 250, protein: 10,
  carbs: 20, fat: 5, fiber: 2,
};
applyReference(weightedRow, weightedReference, { trusted: true });
assert.strictEqual(weightedRow.unit, "75g");
assert.strictEqual(weightedRow.food_name, "75g Yogabar High Protein Oats (Dark Chocolate)");
assert.strictEqual(weightedRow.kcal, 303);
assert.strictEqual(weightedRow.protein, 22.5);

// Resolution order matters: catalog/reference first, user correction second.
// Otherwise a stated protein skips the branded catalog and its remaining fields
// are permanently labelled as an LLM estimate.
assert.strictEqual(typeof applyStatedNutrition, "function");
applyStatedNutrition({
  stated_protein: 26, stated_basis_amount: 100, stated_basis_unit: "g",
  grams: 75, portion_unit: "g", inherited_total_kcal: 999,
}, weightedRow);
assert.strictEqual(weightedRow.protein, 19.5);
assert.strictEqual(weightedRow.kcal, 303);
assert.notStrictEqual(weightedRow.kcal, 999,
  "an old estimate never replaces a catalog calorie value while being labelled catalog");
assert.strictEqual(weightedRow.sourceKind, "reference");
assert.strictEqual(weightedRow.sourceRef, "AIS0129");

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

  // --- User-stated macros survive suspect arbitration ---
  // 2026-08-01, real user: they logged Yogabar oats and replied "Oats have 26g
  // protein, not 15". The bot answered "🔄 Corrected:" and showed 15g — the
  // unchanged value — so they had to send "you did not correct it" to be
  // believed, three days running.
  //
  // resolveItem applied the stated 26 correctly. Suspect arbitration then ran
  // afterwards (contextGuard flags this name compound_suspect) and
  // applyReference overwrote the macros wholesale, restoring 15. The primary
  // reference path and the gap trail both skip `r.stated` rows; arbitration was
  // the outlier. CLAUDE.md: user-stated macros override everything.
  for (const id of [null, 134]) {
    const stated = await resolveRows({ items: [{
      food_name: "Yogabar High Protein Oats (Dark Chocolate)",
      stated_protein: 26, stated_kcal: 202, quantity: 1, matched_db_id: id,
    }] });
    assert.strictEqual(stated[0].protein, 26,
      `stated protein must survive arbitration (matched_db_id=${id})`);
  }

  console.log("ref-guard-test: grams + generic-term guards passed");
})().catch(e => { console.error(e); process.exit(1); });
