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
