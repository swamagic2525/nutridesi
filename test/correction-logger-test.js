const assert = require("assert");
const { buildCorrectionEvent } = require("../src/correctionLogger.js");
const { annotateParserProvider } = require("../src/parser.js");

const parsed = annotateParserProvider({
  intent: "replace_last",
  parse_notes: "nutrition correction",
  items: [{
    food_name: "avocado",
    quantity: 0.5,
    stated_kcal: 160,
    stated_protein: null,
    stated_basis_amount: 0.5,
    stated_basis_unit: "piece",
  }],
}, "gemini");

const event = buildCorrectionEvent({
  intent: "replace_last",
  rawMessage: "Half avocado was 160 calories",
  parsed,
  batch: [],
  deleted: [],
  outcome: "replaced_by_name",
}, "2026-08-07T10:37:14.561Z");

assert.strictEqual(event.ts, "2026-08-07T10:37:14.561Z");
assert.strictEqual(event.parser_provider, "gemini");
assert.strictEqual(event.parse_notes, "nutrition correction");
assert.strictEqual(event.parsed_items[0].stated_basis_amount, 0.5);
assert.strictEqual(event.parsed_items[0].stated_basis_unit, "piece");
console.log("Correction logger tests: passed");
