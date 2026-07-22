// Live end-to-end test for the retrieve-then-rerank reference path (needs
// Supabase + an LLM key). The eval suite is parser-only, so it never touches
// resolveRows where the rerank lives — this is that path's regression guard.
//
//   - branded terse phrases resolve to the right foods_reference row
//     ("epigamia yogurt" -> an Epigamia yogurt row), flagged rerankMatched
//   - a brand NOT in the table falls to a safe estimate (no false match)
//   - a negation row is never picked ("eggs"-style) — covered by the DB probe
require("dotenv").config();
const assert = require("assert");
const { resolveRows } = require("../src/db.js");

const one = async (food_name, kcal = 100) => {
  const rows = await resolveRows({ items: [{ food_name, quantity: 1, kcal, matched_db_id: null, is_estimate: true }] });
  return rows[0];
};

(async () => {
  // 1. "epigamia yogurt" — terse query vs verbose branded row. Strict match_food
  //    rejects it; the rerank should recover an Epigamia yogurt row.
  const epi = await one("epigamia yogurt");
  assert.ok(/epigamia/i.test(epi.food_name), `epigamia resolved to "${epi.food_name}"`);
  assert.ok(/yogurt|yoghurt|curd|dahi/i.test(epi.food_name), `epigamia is a yogurt row, got "${epi.food_name}"`);
  assert.ok(epi.rerankMatched, "epigamia flagged rerankMatched");

  // 2. "provilac milk" — the exact case the deterministic guard failed on.
  const prov = await one("provilac milk");
  assert.ok(/provilac/i.test(prov.food_name), `provilac resolved to "${prov.food_name}"`);
  assert.ok(prov.rerankMatched, "provilac flagged rerankMatched");

  // 3. A brand genuinely absent from the table must NOT be forced onto some
  //    other row — it should fall to an estimate.
  const ghost = await one("zzqq nonexistent protein brand xyz");
  assert.ok(!ghost.rerankMatched, "unknown brand not force-matched");
  assert.ok(ghost.is_estimate, "unknown brand falls to estimate");

  console.log("brand-rerank: passed");
})().catch(e => { console.error("brand-rerank FAILED:", e.message); process.exit(1); });
