// Offline unit tests for the reference reranker's guardrails. The LLM call is
// stubbed — we're testing the validation contract, not model quality:
//   1. A valid returned code resolves to that candidate.
//   2. A hallucinated code (not offered) is rejected -> null (falls to estimate).
//   3. Explicit null -> null.
//   4. Malformed / non-JSON reply -> null, never a throw.
const assert = require("assert");
const { rerankReference, rerankTarget } = require("../src/rerank.js");

const CANDS = [
  { food_code: "AIS0031", food_name: "Epigamia Greek Yogurt (Plain)", serving_kcal: 90, serving_protein: 7.5 },
  { food_code: "AIS0032", food_name: "Epigamia Greek Yogurt (No Added Sugar)", serving_kcal: 85, serving_protein: 8 },
];
const stub = (reply) => async () => reply;

(async () => {
  // 1. valid pick
  let r = await rerankReference("epigamia yogurt", CANDS, stub('{"code":"AIS0031"}'));
  assert.ok(r && r.food_code === "AIS0031", "valid code resolves to the candidate");

  // 2. hallucinated code not in the candidate set -> rejected
  r = await rerankReference("epigamia yogurt", CANDS, stub('{"code":"AIS9999"}'));
  assert.strictEqual(r, null, "hallucinated code rejected");

  // 3. explicit null
  r = await rerankReference("random thing", CANDS, stub('{"code":null}'));
  assert.strictEqual(r, null, "explicit null -> null");

  // 4. malformed reply doesn't throw
  r = await rerankReference("epigamia yogurt", CANDS, stub("not json at all"));
  assert.strictEqual(r, null, "malformed reply -> null");

  // 5. fenced JSON is tolerated
  r = await rerankReference("epigamia yogurt", CANDS, stub('```json\n{"code":"AIS0032"}\n```'));
  assert.ok(r && r.food_code === "AIS0032", "fenced json parsed");

  // 6. empty candidates -> null without calling the model
  r = await rerankReference("anything", [], stub('{"code":"AIS0031"}'));
  assert.strictEqual(r, null, "no candidates -> null");

  // --- rerankTarget: pick which logged row a correction refers to ---
  const LOG = [
    { id: 11, food_name: "Paneer (Raw/Grilled)", kcal: 265, quantity: 1 },
    { id: 12, food_name: "SuperYou PRO (Yeast Protein)", kcal: 124, quantity: 1 },
    { id: 13, food_name: "Roti / Chapati", kcal: 89, quantity: 6 },
  ];

  // valid 1-based index resolves to that row (LLM maps "the whey" -> SuperYou)
  let t = await rerankTarget("the whey was wrong", LOG, stub('{"index":2}'));
  assert.ok(t && t.id === 12, "index 2 -> SuperYou row");

  // out-of-range index rejected
  t = await rerankTarget("x", LOG, stub('{"index":9}'));
  assert.strictEqual(t, null, "out-of-range index -> null");

  // explicit null (ambiguous) preserved
  t = await rerankTarget("it was wrong", LOG, stub('{"index":null}'));
  assert.strictEqual(t, null, "null index -> null");

  // non-integer / malformed -> null, no throw
  t = await rerankTarget("x", LOG, stub('{"index":"two"}'));
  assert.strictEqual(t, null, "non-integer index -> null");
  t = await rerankTarget("x", LOG, stub("garbage"));
  assert.strictEqual(t, null, "malformed -> null");

  // empty rows -> null
  t = await rerankTarget("anything", [], stub('{"index":1}'));
  assert.strictEqual(t, null, "no rows -> null");

  console.log("rerank: passed");
})();
