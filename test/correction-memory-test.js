// Per-user correction memory.
//
// A real user restated the same figure on five consecutive days (27, 28, 30,
// 31 July, 1 August) because nothing remembered it. CLAUDE.md rule 1 says a
// food-level answer is remembered permanently; for macros it never was.
//
// The risk this carries is the mirror image: a remembered figure silently
// rewrites the user's nutrition data every day from then on. So the tests below
// weigh as much on what must NOT be remembered, and on the memory staying
// visible and removable, as on the feature working.
const assert = require("assert");
const {
  foodKey, perUnit, worthRemembering, toMemoryRow,
  applyMemory, memoryNote, parseForgetRequest, findForgetTarget,
} = require("../src/correctionMemory.js");

// --- keying: the same food typed differently is one memory ---
const KEY = foodKey("Yogabar High Protein Oats (Dark Chocolate)");
assert.strictEqual(foodKey("yogabar high protein oats"), KEY, "flavour parenthetical is ignored");
assert.strictEqual(foodKey("Yogabar  High-Protein  Oats"), KEY, "punctuation and spacing ignored");
assert.strictEqual(foodKey("High Protein Oats Yogabar"), KEY, "word order ignored");
assert.notStrictEqual(foodKey("Yogabar Wholegrain Rolled Oats"), KEY,
  "a different product must not share a memory");
assert.strictEqual(foodKey(""), "");
assert.strictEqual(foodKey(null), "");

// --- per-unit storage, so tomorrow's different quantity still works ---
assert.deepStrictEqual(perUnit({ kcal: 404, protein: 52, quantity: 2, unit: "serving" }),
  { protein_per_unit: 26, kcal_per_unit: 202, unit: "serving" });

// --- what is worth remembering ---
const stated = { stated: true, food_name: "Yogabar Oats", kcal: 202, protein: 26, quantity: 1, unit: "serving" };
assert.ok(worthRemembering(stated));
assert.ok(!worthRemembering({ ...stated, stated: false }), "only figures the USER stated");
assert.ok(!worthRemembering({ ...stated, food_name: "meal" }), "never a Tier-4 placeholder");
assert.ok(!worthRemembering({ ...stated, food_name: null }));
assert.ok(!worthRemembering(null));
// Absurd values are far likelier a parse artefact than a real label.
assert.ok(!worthRemembering({ ...stated, protein: 900, kcal: null }), "implausible protein rejected");
assert.ok(!worthRemembering({ ...stated, protein: null, kcal: 99999 }), "implausible kcal rejected");

assert.deepStrictEqual(toMemoryRow("+0000000001", stated), {
  phone_number: "+0000000001",
  food_key: foodKey("Yogabar Oats"),
  food_name: "Yogabar Oats",
  protein_per_unit: 26,
  kcal_per_unit: 202,
  unit: "serving",
});

// --- applying ---
const mem = { protein_per_unit: 26, kcal_per_unit: 202, unit: "serving", food_name: "Yogabar Oats" };

const one = applyMemory({ food_name: "Yogabar Oats", protein: 15, kcal: 202, quantity: 1, unit: "serving" }, mem);
assert.strictEqual(one.protein, 26);
assert.strictEqual(one.memoryApplied, true);
// Must be marked stated, or suspect arbitration overwrites it further up the
// pipeline — the exact bug that made corrections appear to silently fail.
assert.strictEqual(one.stated, true, "a memory must carry the same weight as a fresh statement");
assert.strictEqual(one.is_estimate, false);

// Quantity scales.
const two = applyMemory({ food_name: "Yogabar Oats", protein: 30, kcal: 404, quantity: 2, unit: "serving" }, mem);
assert.strictEqual(two.protein, 52, "26 per unit x 2");
assert.strictEqual(two.kcal, 404);

// The unit LABEL is unstable for the same food: "105 gm yogabar oats" and
// "yogabar oats 105g" resolved to unit "bowl" and unit "serving", identical
// 202 kcal portions, and a strict unit check silently stopped the memory
// applying — the exact repetition it exists to prevent. Matching is on the
// energy basis instead.
const relabelled = applyMemory({ food_name: "Yogabar Oats", protein: 15, kcal: 202, quantity: 1, unit: "serving" }, mem);
assert.strictEqual(relabelled.protein, 26, "same portion, different unit label, still applies");

// A genuinely different portion must NOT inherit the figure.
const bigger = applyMemory({ food_name: "Yogabar Oats", protein: 5, kcal: 400, quantity: 1, unit: "g" }, mem);
assert.ok(!bigger.memoryApplied, "a 400 kcal portion is not the remembered 202 kcal one");
assert.strictEqual(bigger.protein, 5);
const scoop = applyMemory({ food_name: "Yogabar Oats", protein: 20, kcal: 120, quantity: 1, unit: "scoop" }, mem);
assert.ok(!scoop.memoryApplied, "a 120 kcal scoop is not the remembered serving");

// Already correct -> no-op, so the note isn't shown for nothing.
const same = applyMemory({ food_name: "Yogabar Oats", protein: 26, kcal: 202, quantity: 1, unit: "serving" }, mem);
assert.ok(!same.memoryApplied);

assert.strictEqual(applyMemory(null, mem), null);
assert.deepStrictEqual(applyMemory({ protein: 1 }, null), { protein: 1 });

// --- visibility: the user must be able to see it and undo it ---
const note = memoryNote(one);
assert.match(note, /Yogabar Oats/);
assert.match(note, /26g protein/);
assert.match(note, /forget/i, "every applied memory shows the way out");
// The handle offered must be typeable — nobody sends "forget Yogabar High
// Protein Oats (Dark Chocolate)". Subset matching makes the short form resolve.
assert.doesNotMatch(note, /forget Yogabar High Protein Oats \(Dark/,
  "the full resolved name is not what we ask them to type");
assert.strictEqual(memoryNote({ memoryApplied: false }), null, "no note when nothing changed");

// --- forgetting ---
assert.deepStrictEqual(parseForgetRequest("forget yogabar oats"),
  { action: "forget", target: "yogabar oats", key: foodKey("yogabar oats") });
assert.ok(parseForgetRequest("reset my correction for oats"));
assert.strictEqual(parseForgetRequest("2 roti and dal"), null, "a meal is not a forget request");
assert.strictEqual(parseForgetRequest("forget"), null, "needs a target");
assert.strictEqual(parseForgetRequest(""), null);

// Applying needs an exact key; forgetting matches on subset, or a user told to
// type "forget yogabar oats" could not remove a memory stored under the fuller
// resolved name.
const memories = [
  { food_key: foodKey("Yogabar High Protein Oats (Dark Chocolate)"), food_name: "Yogabar High Protein Oats" },
  { food_key: foodKey("Amul High Protein Milk"), food_name: "Amul High Protein Milk" },
];
assert.strictEqual(findForgetTarget(memories, foodKey("yogabar oats")).match.food_name,
  "Yogabar High Protein Oats", "a subset of the stored words resolves");
assert.strictEqual(findForgetTarget(memories, foodKey("chicken")).match, null, "no false match");

// Ambiguity is surfaced, not guessed — deleting the wrong memory is silent.
const amb = findForgetTarget(memories, foodKey("high protein"));
assert.strictEqual(amb.match, null);
assert.strictEqual(amb.ambiguous, true);
assert.strictEqual(amb.candidates.length, 2);

assert.deepStrictEqual(findForgetTarget([], foodKey("oats")), { match: null, ambiguous: false });
assert.deepStrictEqual(findForgetTarget(null, ""), { match: null, ambiguous: false });

console.log("correction-memory-test: all passed");
