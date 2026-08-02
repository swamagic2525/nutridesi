const assert = require("assert");

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY ||= "test-key";

const { toUserLogInsertRow, toCorrectionMemoryInsertRow } = require("../src/db.js");

const saved = toUserLogInsertRow({
  phone_number: "+000000000001",
  food_name: "Test oats",
  matched_db_id: 134,
  quantity: 1,
  unit: "serving",
  kcal: 202,
  protein: 26,
  carbs: 30,
  fat: 5,
  fiber: 4,
  meal_time: "breakfast",
  is_estimate: false,
  date: "2026-08-01",
  day_seq: 1,
  stated: true,
  userSaid: "oats",
  assumed: false,
  portionNote: "test",
  refVerified: true,
  rerankMatched: true,
  memoryApplied: true,
  memoryName: "oats",
});

assert.deepStrictEqual(Object.keys(saved).sort(), [
  "carbs", "date", "day_seq", "fat", "fiber", "food_name", "is_estimate",
  "kcal", "matched_db_id", "meal_time", "phone_number", "protein",
  "quantity", "unit",
].sort());
assert.strictEqual(saved.rerankMatched, undefined);
assert.strictEqual(saved.memoryApplied, undefined);

assert.strictEqual(typeof toCorrectionMemoryInsertRow, "function");
const memorySaved = toCorrectionMemoryInsertRow({
  phone_number: "+000000000001", food_key: "chocolate dark high oats protein yogabar",
  food_name: "Yogabar High Protein Oats (Dark Chocolate)",
  protein_per_unit: 19.5, kcal_per_unit: 303, unit: "75g",
  basis_amount: 100, basis_unit: "g", protein_per_basis: 26,
  protein_provenance: "user_confirmed", kcal_per_basis: 404,
  kcal_provenance: "catalog", source_assertion: "26g protein per 100g",
  source_kind: "reference", source_ref: "AIS0129", status: "active",
  memoryApplied: true, portionAmount: 75, rawMessage: "private message",
});
assert.strictEqual(memorySaved.memoryApplied, undefined);
assert.strictEqual(memorySaved.rawMessage, undefined);
assert.strictEqual(memorySaved.portionAmount, undefined);
assert.strictEqual(memorySaved.protein_provenance, "user_confirmed");
assert.strictEqual(memorySaved.source_assertion, "26g protein per 100g");

console.log("db-insert-shape-test: passed");
