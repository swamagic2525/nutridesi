// Reference reranker. Deterministic string similarity can't tell that
// "epigamia yogurt" == "Epigamia High Protein Greek Yogurt (Mixed Berries)".
// So retrieval casts a wide, cheap net (db.refCandidates) and the LLM picks the
// one genuine match — or NONE. The LLM only ever returns a food_code from the
// candidate list; this module validates that the code is real before trusting
// it, so a hallucinated code can never apply macros (same contract as contextGuard).

const { askLLM } = require("./parser.js");

const RERANK_SYSTEM = `You match a user's food phrase to the correct row in a food database, or decide none fit.

You are given the user's phrase and a numbered list of candidate rows (each with a CODE, name, and macros). Return STRICT JSON: {"code": "<the matching CODE>"} or {"code": null}.

Rules:
- Pick a candidate ONLY if it is genuinely the SAME food the user means. Brand and product form must agree ("epigamia yogurt" = an Epigamia yogurt row; NOT an Epigamia milkshake).
- Flavour differences do NOT matter (chocolate vs vanilla of the same product is a match) — macros are near-identical across flavours.
- A candidate that NEGATES or EXCLUDES the food is NOT a match ("eggs" must never match "Mayonnaise without eggs").
- A generic phrase should match a generic/plain row, never a heavily-qualified specialty row.
- When unsure, return null. A wrong match is worse than none — null falls back to a safe estimate.
- The code you return MUST be copied exactly from one of the candidates. Never invent a code.`;

// candidates: [{ food_code, food_name, serving_kcal, serving_protein }]
// returns the chosen candidate object, or null. `ask` is injectable for tests.
async function rerankReference(query, candidates, ask = askLLM) {
  if (!query || !candidates || !candidates.length) return null;
  const byCode = new Map(candidates.map(c => [c.food_code, c]));
  const list = candidates
    .map(c => `${c.food_code} | ${c.food_name} | ${Math.round(c.serving_kcal)} kcal, ${c.serving_protein}g protein`)
    .join("\n");
  const user = `USER PHRASE: "${query}"\n\nCANDIDATES:\n${list}`;

  let raw;
  try {
    raw = await ask(user, RERANK_SYSTEM);
  } catch (e) {
    console.error("rerank askLLM:", String(e.message).slice(0, 200));
    return null;
  }

  let code = null;
  try {
    const t = String(raw).replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
    const start = t.indexOf("{"), end = t.lastIndexOf("}");
    code = JSON.parse(start !== -1 && end > start ? t.slice(start, end + 1) : t).code;
  } catch { return null; }

  // Anti-hallucination: the returned code must be one we actually offered.
  return (code && byCode.has(code)) ? byCode.get(code) : null;
}

// Correction-target reranker. When deterministic word-overlap (matchRows) can't
// tell which logged item a correction refers to — "the whey was wrong" against a
// row named "SuperYou PRO (Yeast Protein)" shares no words — the LLM picks by
// meaning. Returns the chosen row, or null (ambiguity refusal preserved).
const TARGET_SYSTEM = `The user is correcting ONE item in their recent food log. Given their message and a numbered list of the logged items, decide which item they mean.

Return STRICT JSON: {"index": <the item number>} or {"index": null}.

Rules:
- Match by MEANING, not just shared words. A brand IS its category to users: "the whey"/"the protein" can mean a "SuperYou PRO" or "Biozyme" row; "the shake" can mean a milkshake row.
- If the message clearly points at one item, return its number.
- If it's genuinely ambiguous (could be two of them) or none fit, return null. A wrong guess silently corrupts the wrong food — null is safer.
- The index MUST be one of the numbers shown.`;

// rows: logged items [{ id, food_name, kcal, quantity }]. Returns a row or null.
async function rerankTarget(query, rows, ask = askLLM) {
  if (!query || !rows || !rows.length) return null;
  const list = rows
    .map((r, i) => `${i + 1}. ${r.food_name}${Number(r.quantity) > 1 ? ` ×${r.quantity}` : ""} — ${Math.round(Number(r.kcal) || 0)} kcal`)
    .join("\n");
  const user = `CORRECTION MESSAGE: "${query}"\n\nLOGGED ITEMS:\n${list}`;

  let raw;
  try { raw = await ask(user, TARGET_SYSTEM); }
  catch (e) { console.error("rerankTarget ask:", String(e.message).slice(0, 200)); return null; }

  let idx = null;
  try {
    const t = String(raw).replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
    const s = t.indexOf("{"), e = t.lastIndexOf("}");
    idx = JSON.parse(s !== -1 && e > s ? t.slice(s, e + 1) : t).index;
  } catch { return null; }

  // Validate: must be an in-range 1-based index we actually offered.
  return (Number.isInteger(idx) && idx >= 1 && idx <= rows.length) ? rows[idx - 1] : null;
}

module.exports = { rerankReference, rerankTarget, RERANK_SYSTEM, TARGET_SYSTEM };
