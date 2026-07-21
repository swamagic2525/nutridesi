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
// alcohol: calories from ethanol -> macro-cal check skipped under opts.alcohol
assert.strictEqual(gateReason({ name: "Kingfisher Strong", kcal: 195, p: 1.8, c: 14.5, f: 0, grams: 330, kcal_100g: 59 }, { alcohol: true }), null, "alcohol row passes with opts.alcohol");
assert.ok(gateReason({ name: "Kingfisher Strong", kcal: 195, p: 1.8, c: 14.5, f: 0, grams: 330, kcal_100g: 59 }), "same row rejected without the alcohol flag");
// absurd density
assert.ok(gateReason({ ...good, grams: 5, kcal_100g: 4400 }), "kcal/100g>900 rejected");
// zero-cal items are valid (Coke Zero, creatine): pass, not rejected as density
assert.strictEqual(gateReason({ name: "Coke Zero", kcal: 0, p: 0, c: 0, f: 0, grams: 330, kcal_100g: 0 }), null, "zero-cal item passes");
assert.ok(gateReason({ ...good, name: "" }), "empty name rejected");
assert.strictEqual(gateReason({ ...good, name: "ON Gold Standard 100% Whey Isolate (Double Rich Chocolate Flavour)" }), null, "long brand name (<=80) passes");
assert.ok(gateReason({ ...good, name: "x".repeat(81) }), "over-long name (>80) rejected");
assert.strictEqual(gateReason({ ...good, name: "Green Moong (South Indian Tempering (Mustard & Curry Leaves))" }), "spam_name", "nested-paren spam rejected");
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

// Brace-scoped: this file is one flat script, and later blocks reuse names
// like `recs`/`kept`/`dropped`. Wrapping each block avoids top-level collisions.
{
  const { normName, dedup } = require("../scripts/ingest-foods/dedup.js");

  assert.strictEqual(normName("Dal  Tadka!"), "dal tadka");

  const curated = new Set(["dal tadka"]);
  const ref = new Set(["hot tea garam chai"]);
  const recs = [
    { name: "Dal Tadka" },        // in curated -> drop
    { name: "Hot Tea (Garam Chai)" }, // in reference -> drop
    { name: "Kanda Poha" },       // new -> keep
  ];
  const { kept, dropped } = dedup(recs, curated, ref);
  assert.deepStrictEqual(kept.map(r => r.name), ["Kanda Poha"]);
  assert.strictEqual(dropped.length, 2);
  assert.strictEqual(dropped.find(d => d.name === "Dal Tadka").reason, "in_curated");
  assert.strictEqual(dropped.find(d => d.name.startsWith("Hot Tea")).reason, "in_reference");
  console.log("dedup: passed");
}

{
  const { codeFor, toReferenceRow } = require("../scripts/ingest-foods/to-row.js");

  assert.strictEqual(codeFor("Indian_Household_Nutrition_Database_2500.md", 0), "AIH0001");
  assert.strictEqual(codeFor("QuickCommerce_Restaurant_Food_DB_1000.md", 41), "AIQ0042");
  assert.strictEqual(codeFor("Fitness_Commercial_Products_DB.md", 0), "AIF0001");
  assert.strictEqual(codeFor("Food_Nutrition_DB.md", 0), "AID0001");

  const rec = { name: "Kanda Poha", unit: "bowl", kcal: 220, p: 4.5, c: 38, f: 6, kcal_100g: 147, p_100g: 3, c_100g: 25.3, f_100g: 4 };
  const row = toReferenceRow(rec, "AIH0001");
  assert.strictEqual(row.food_code, "AIH0001");
  assert.strictEqual(row.food_name, "Kanda Poha");
  assert.strictEqual(row.serving_unit, "bowl");
  assert.strictEqual(row.serving_kcal, 220);
  assert.strictEqual(row.serving_protein, 4.5);
  assert.strictEqual(row.serving_fibre, 0);
  assert.strictEqual(row.kcal_100g, 147);
  assert.strictEqual(row.fibre_100g, 0);
  console.log("to-row: passed");
}

{
  const { buildReport } = require("../scripts/ingest-foods/report.js");

  const md = buildReport({
    funnel: [{ file: "A.md", parsed: 100, gated: 95, collapsed: 80, deduped: 75, loaded: 75 }],
    rejects: [{ name: "Weird Row", reason: "macro_cal_mismatch" }],
    collapses: [{ name: "Aashirvaad Select Atta", keptAs: "Aashirvaad Chakki Atta" }],
    sample: [{ food_name: "Kanda Poha", serving_unit: "bowl", serving_kcal: 220, serving_protein: 4.5, kcal_100g: 147 }],
  });
  assert.ok(md.includes("A.md"), "funnel row present");
  assert.ok(md.includes("macro_cal_mismatch"), "reject reason present");
  assert.ok(md.includes("Aashirvaad Chakki Atta"), "collapse decision present");
  assert.ok(md.includes("Kanda Poha"), "sample row present");
  console.log("report: passed");
}
