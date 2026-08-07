const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "evals", "correction-log.jsonl");

function buildCorrectionEvent({ intent, rawMessage, parsed, batch, deleted, outcome }, timestamp = new Date().toISOString()) {
  return {
    ts: timestamp,
    intent,
    raw: rawMessage,
    parser_provider: parsed.parser_provider || null,
    parse_notes: parsed.parse_notes || null,
    parsed_items: (parsed.items || []).map(i => ({
      food_name: i.food_name,
      matched_db_id: i.matched_db_id || null,
      stated_kcal: i.stated_kcal || null,
      stated_protein: i.stated_protein || null,
      stated_basis_amount: i.stated_basis_amount || null,
      stated_basis_unit: i.stated_basis_unit || null,
      quantity: i.quantity,
      scope_word: i.scope_word || null,
    })),
    batch: (batch || []).map(r => ({
      food_name: r.food_name,
      matched_db_id: r.matched_db_id || null,
      kcal: r.kcal,
      is_estimate: r.is_estimate || false,
    })),
    deleted: (deleted || []).map(r => ({
      food_name: r.food_name,
      kcal: r.kcal,
    })),
    outcome,
  };
}

function logCorrectionEvent(args) {
  const entry = buildCorrectionEvent(args);
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (_) {}
}

module.exports = { buildCorrectionEvent, logCorrectionEvent };
