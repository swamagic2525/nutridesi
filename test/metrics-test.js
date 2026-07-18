const assert = require("assert");
const { buildMetrics, normalizeFoodName } = require("../src/metrics.js");

const now = new Date("2026-07-18T12:00:00.000Z");
const users = [
  { phone_number: "+911", created_at: "2026-07-11T08:00:00Z", goal_protein: 120 },
  { phone_number: "+912", created_at: "2026-07-15T08:00:00Z", goal_protein: null },
  { phone_number: "+000test", created_at: "2026-07-11T08:00:00Z", goal_protein: 100 },
];
const logs = [
  { phone_number: "+911", date: "2026-07-11", food_name: "100g Chicken Curry", matched_db_id: null, is_estimate: true },
  { phone_number: "+911", date: "2026-07-12", food_name: "100g Chicken Curry", matched_db_id: null, is_estimate: true },
  { phone_number: "+911", date: "2026-07-14", food_name: "Chicken curry", matched_db_id: null, is_estimate: false },
  { phone_number: "+911", date: "2026-07-18", food_name: "Roti", matched_db_id: 1, is_estimate: false },
  { phone_number: "+912", date: "2026-07-16", food_name: "Dal", matched_db_id: 17, is_estimate: false },
  { phone_number: "+000test", date: "2026-07-18", food_name: "Test", matched_db_id: null, is_estimate: true },
];
const metrics = buildMetrics(users, logs, now);

assert.strictEqual(metrics.totalUsers, 2);
assert.strictEqual(metrics.activeToday, 1);
assert.strictEqual(metrics.d7.rate, 100);
assert.strictEqual(metrics.goalAdoption.rate, 50);
assert.strictEqual(metrics.topUncurated[0].foodName, "chicken curry");
assert.strictEqual(metrics.topUncurated[0].count, 2);
assert.strictEqual(metrics.estimate.overallRate, 40);
assert.strictEqual(metrics.estimate.uncuratedOverallRate, 60);
assert.strictEqual(normalizeFoodName("100g Paneer"), "paneer");
const unavailableGoals = buildMetrics(users, logs, now, false);
assert.strictEqual(unavailableGoals.goalAdoption.available, false);
assert.strictEqual(unavailableGoals.goalAdoption.rate, 0);
console.log("Metrics tests: passed (10 cases)");
