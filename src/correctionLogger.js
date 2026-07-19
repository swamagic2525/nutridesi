const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "evals", "correction-log.jsonl");

function logCorrectionEvent({ intent, rawMessage, parsed, batch, deleted, outcome }) {
  const entry = {
    ts: new Date().toISOString(),
    intent,
    raw: rawMessage,
    parsed_items: (parsed.items || []).map(i => ({
      food_name: i.food_name,
      matched_db_id: i.matched_db_id || null,
      stated_kcal: i.stated_kcal || null,
      stated_protein: i.stated_protein || null,
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
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (_) {}
}

module.exports = { logCorrectionEvent };
