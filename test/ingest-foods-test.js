const assert = require("assert");
const { parseMdTable } = require("../scripts/ingest-foods/parse-md.js");

const sample = [
  "# Title",
  "",
  "| Item Name | Serving Size | Calories (kcal) | Protein (g) |",
  "|:----------|:-------------|----------------:|------------:|",
  "| Kanda Poha | 1 bowl (150g) | 220 | 4.5 |",
  "| Plain Idli | 2 pcs (100g) | 130 | 4.2 |",
].join("\n");

const rows = parseMdTable(sample);
assert.strictEqual(rows.length, 2, "two data rows");
assert.strictEqual(rows[0]["Item Name"], "Kanda Poha");
assert.strictEqual(rows[0]["Serving Size"], "1 bowl (150g)");
assert.strictEqual(rows[0]["Calories (kcal)"], "220");
assert.strictEqual(rows[1]["Protein (g)"], "4.2");
console.log("parse-md: passed");

const { parseServing, normalizeRow } = require("../scripts/ingest-foods/normalize.js");

// grams inside parens -> unit is the outer label
assert.deepStrictEqual(parseServing("1 bowl (150g)"), { unit: "bowl", grams: 150 });
// grams outside, count in parens -> unit is the parenthetical
assert.deepStrictEqual(parseServing("32g (2 tbsp)"), { unit: "2 tbsp", grams: 32 });
// bare weight -> generic unit
assert.deepStrictEqual(parseServing("100ml"), { unit: "serving", grams: 100 });
assert.deepStrictEqual(parseServing("2 pcs (100g)"), { unit: "2 pcs", grams: 100 });

const hh = normalizeRow(
  { "Item Name": "Kanda Poha", "Serving Size": "1 bowl (150g)", "Calories (kcal)": "220", "Protein (g)": "4.5", "Carbs (g)": "38", "Fats (g)": "6", "Category": "Prepared Dishes" },
  "Indian_Household_Nutrition_Database_2500.md"
);
assert.strictEqual(hh.name, "Kanda Poha");
assert.strictEqual(hh.grams, 150);
assert.strictEqual(hh.kcal, 220);
assert.strictEqual(Math.round(hh.kcal_100g), 147); // 220/150*100
assert.strictEqual(hh.category, "Prepared Dishes");

// branded file -> brand is prefixed onto the name
const br = normalizeRow(
  { "Brand": "Amul", "Product": "Gold Milk", "Serving Size": "100ml", "Calories (kcal)": "87", "Protein (g)": "3.3", "Carbs (g)": "5", "Fats (g)": "6", "Type": "Dairy/Milk" },
  "Food_Nutrition_DB.md"
);
assert.strictEqual(br.name, "Amul Gold Milk");
assert.strictEqual(br.grams, 100);
console.log("normalize: passed");

const { gateReason } = require("../scripts/ingest-foods/gate.js");

const good = { name: "Kanda Poha", kcal: 220, p: 4.5, c: 38, f: 6, grams: 150, kcal_100g: 147 };
assert.strictEqual(gateReason(good), null, "clean row passes");

assert.ok(gateReason({ ...good, p: NaN }), "NaN macro rejected");
assert.ok(gateReason({ ...good, kcal: -5 }), "negative kcal rejected");
// macros imply 4.5*4+38*4+6*9=224 vs kcal 220 -> within 30%, still passes
assert.strictEqual(gateReason(good), null);
// wildly inconsistent: kcal 220 but macros imply 4*4+4*4+30*9=302 -> >30% off
assert.ok(gateReason({ ...good, f: 30 }), "macro-cal mismatch rejected");
// absurd density
assert.ok(gateReason({ ...good, grams: 5, kcal_100g: 4400 }), "kcal/100g>900 rejected");
assert.ok(gateReason({ ...good, name: "" }), "empty name rejected");
assert.ok(gateReason({ ...good, name: "x".repeat(61) }), "over-long name rejected");
console.log("gate: passed");

const { collapse } = require("../scripts/ingest-foods/collapse.js");

const recs = [
  { name: "Aashirvaad Select Sharbati Atta", kcal: 345, p: 12, c: 68, f: 1.8, grams: 100 },
  { name: "Aashirvaad Chakki Atta", kcal: 345, p: 12, c: 68, f: 1.8, grams: 100 },
  { name: "Toor Dal", kcal: 140, p: 8, c: 20, f: 4, grams: 150 },
  // same macros as Toor Dal but no shared token -> must NOT collapse together
  { name: "Beetroot Soup", kcal: 140, p: 8, c: 20, f: 4, grams: 150 },
];
const { kept, dropped } = collapse(recs);
const names = kept.map(r => r.name).sort();
assert.ok(names.includes("Aashirvaad Chakki Atta"), "shortest atta kept");
assert.ok(!names.includes("Aashirvaad Select Sharbati Atta"), "longer atta dropped");
assert.ok(names.includes("Toor Dal") && names.includes("Beetroot Soup"), "coincidental-macro pair both kept");
assert.strictEqual(dropped.length, 1);
assert.strictEqual(dropped[0].keptAs, "Aashirvaad Chakki Atta");
console.log("collapse: passed");
