const assert = require("assert");

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY ||= "test-key";

const { toUserLogInsertRow } = require("../src/db.js");

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

console.log("db-insert-shape-test: passed");
