require("dotenv").config();
const assert = require("assert");
const { resolveRows } = require("../src/db.js");

(async () => {
  // The incident: "chicken tandoor platter" served as 1 tikka piece = 55 kcal.
  // A serving word on a per-piece food with no count -> assume 4 pieces, flagged.
  let rows = await resolveRows({ items: [{ food_name: "chicken tikka platter", matched_db_id: 90, quantity: 1, match_type: "direct", portion_clarity: "unknown" }] });
  assert.strictEqual(rows[0].quantity, 4);
  assert.strictEqual(rows[0].kcal, 220);
  assert.strictEqual(rows[0].is_estimate, true);
  assert.ok(/platter/.test(rows[0].portionNote), "reply must show the platter assumption");

  // An explicit count beats the platter default
  rows = await resolveRows({ items: [{ food_name: "chicken tikka platter", matched_db_id: 90, quantity: 6, match_type: "direct", portion_clarity: "specified" }] });
  assert.strictEqual(rows[0].quantity, 6);

  // Serving word on a bowl food: no bump (a thali's dal is still one katori)
  rows = await resolveRows({ items: [{ food_name: "dal thali", matched_db_id: 17, quantity: 1, match_type: "direct", portion_clarity: "specified" }] });
  assert.strictEqual(rows[0].quantity, 1);

  // Plain per-piece food without a serving word: untouched
  rows = await resolveRows({ items: [{ food_name: "chicken tikka", matched_db_id: 90, quantity: 1, match_type: "direct", portion_clarity: "specified" }] });
  assert.strictEqual(rows[0].quantity, 1);
  assert.strictEqual(rows[0].kcal, 55);

  console.log("serving-size-test: all passed");
})().catch(e => { console.error(e); process.exit(1); });
