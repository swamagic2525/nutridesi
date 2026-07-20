// Edge-case audit fixes (2026-07-20): unknown-food quantity misparse and
// plural alias rescue. Both produced user-visible nonsense before the fix.
require("dotenv").config();
const assert = require("assert");
const { resolveRows } = require("../src/db.js");

(async () => {
  // A gram weight the parser dropped into `quantity` on a food we don't know.
  // Before: qty capped at 30, unknown food estimates ~300 kcal/serving -> 9,000 kcal.
  const misparse = await resolveRows({
    items: [{ food_name: "kaju curry", quantity: 100, matched_db_id: null, est_kcal: 300 }],
  });
  assert.strictEqual(misparse.length, 1);
  assert.ok(misparse[0].kcal < 1000,
    `unknown-food gram misparse should not log 9,000 kcal, got ${misparse[0].kcal}`);
  console.log(`audit-fixes-test: gram misparse -> ${misparse[0].kcal} kcal (was ~9000)`);

  // A real large count on a countable food must still survive.
  const realCount = await resolveRows({
    items: [{ food_name: "roti", quantity: 12, matched_db_id: 1, match_type: "direct", portion_clarity: "specified" }],
  });
  assert.strictEqual(realCount[0].quantity, 12, "12 rotis must stay 12");
  console.log("audit-fixes-test: real count 12 roti preserved");

  // Plural the LLM returns but that isn't an explicit alias.
  // Bare "paratha" is the plain one (id 2); stuffed needs the filling word.
  for (const [plural, id] of [["idlis", 13], ["parathas", 2], ["momos", 251]]) {
    const rows = await resolveRows({ items: [{ food_name: plural, quantity: 2, matched_db_id: null }] });
    assert.strictEqual(rows[0].matched_db_id, id,
      `"${plural}" should rescue to curated id ${id}, got ${rows[0].matched_db_id}`);
  }
  console.log("audit-fixes-test: plural alias rescue works (idlis, parathas)");

  console.log("audit-fixes-test: all passed");
})().catch(e => { console.error("audit-fixes-test FAILED:", e.message); process.exit(1); });
