const assert = require("assert");

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY ||= "test-key";

const filters = [];
const fixtureRows = [
  {
    id: 91, food_name: "Kulfi", kcal: 150, protein: 4, quantity: 1,
    matched_db_id: 145, is_estimate: true,
    logged_at: "2026-08-03T18:03:00.000Z", date: "2026-08-03",
  },
  {
    id: 90, food_name: "Roti", kcal: 89, protein: 3, quantity: 1,
    matched_db_id: 1, is_estimate: false,
    logged_at: "2026-08-03T17:00:00.000Z", date: "2026-08-03",
  },
];

const chain = {
  select() { return this; },
  eq(...args) { filters.push(["eq", ...args]); return this; },
  gte(...args) { filters.push(["gte", ...args]); return this; },
  lte(...args) { filters.push(["lte", ...args]); return this; },
  order() { return this; },
  async limit() { return { data: fixtureRows, error: null }; },
};
const client = {
  from(table) {
    assert.strictEqual(table, "user_logs");
    return chain;
  },
};

const supabaseModule = require.resolve("@supabase/supabase-js");
require.cache[supabaseModule] = {
  id: supabaseModule,
  filename: supabaseModule,
  loaded: true,
  exports: { createClient: () => client },
};

const { lastLogBatch } = require("../src/db.js");

(async () => {
  const now = new Date("2026-08-03T19:03:00.000Z"); // 12:33 AM IST
  const rows = await lastLogBatch("+000000000099", now, client);

  assert.deepStrictEqual(filters, [
    ["eq", "phone_number", "+000000000099"],
    ["gte", "logged_at", "2026-08-03T13:03:00.000Z"],
    ["lte", "logged_at", "2026-08-03T19:03:00.000Z"],
  ]);
  assert.strictEqual(filters.some(filter => filter[1] === "date"), false);
  assert.deepStrictEqual(rows.map(row => row.id), [91]);

  console.log("cross-midnight-correction-test: passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
