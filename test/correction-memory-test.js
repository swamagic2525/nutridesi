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
  parseMemoryListRequest, formatMemories,
} = require("../src/correctionMemory.js");

// --- keying: the same food typed differently is one memory ---
const KEY = foodKey("Yogabar High Protein Oats (Dark Chocolate)");
assert.notStrictEqual(foodKey("yogabar high protein oats"), KEY,
  "an exact memory key retains the branded variant");
assert.notStrictEqual(foodKey("Yogabar High Protein Oats (Mango)"), KEY,
  "one flavour must never inherit another flavour's confirmed label");
assert.strictEqual(
  foodKey("High Protein Oats Yogabar (Chocolate Dark)"),
  KEY,
  "punctuation and word order remain stable without dropping variant words",
);
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

const basisMemoryRow = toMemoryRow("+0000000001", {
  food_name: "75g Yogabar High Protein Oats (Dark Chocolate)",
  kcal: 303, protein: 19.5, quantity: 1, unit: "75g",
  portionAmount: 75, portionUnit: "g",
  nutritionBasisAmount: 100, nutritionBasisUnit: "g",
  userConfirmedProteinPerBasis: 26,
  sourceKind: "reference", sourceRef: "AIS0129", stated: true,
});
assert.deepStrictEqual(basisMemoryRow, {
  phone_number: "+0000000001",
  food_key: foodKey("Yogabar High Protein Oats (Dark Chocolate)"),
  food_name: "Yogabar High Protein Oats (Dark Chocolate)",
  protein_per_unit: 19.5,
  kcal_per_unit: 303,
  unit: "75g",
  basis_amount: 100,
  basis_unit: "g",
  protein_per_basis: 26,
  protein_provenance: "user_confirmed",
  kcal_per_basis: 404,
  kcal_provenance: "catalog",
  source_assertion: "26g protein per 100g",
  source_kind: "reference",
  source_ref: "AIS0129",
  status: "active",
});

const inferredSnapshot = toMemoryRow("+0000000001", {
  food_name: "75g Local Protein Oats", kcal: 285, protein: 19.5,
  quantity: 1, unit: "75g", portionAmount: 75, portionUnit: "g",
  nutritionBasisAmount: 100, nutritionBasisUnit: "g",
  userConfirmedProteinPerBasis: 26, sourceKind: "estimate", stated: true,
});
assert.strictEqual(inferredSnapshot.kcal_per_basis, 380);
assert.strictEqual(inferredSnapshot.kcal_provenance, "parser_inferred",
  "a no-catalog estimate is pinned but never presented as confirmed");

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

// --- basis-aware scaling -------------------------------------------------
// Production incident, 2 Aug: "26g protein is for 100g; adjust for 75g" was
// eventually saved as 19.5g per opaque serving. The next quantity therefore
// inherited a total instead of the label density.
// Full loop: the persisted row produced by a 75g correction is what must scale
// tomorrow's 50g log. A hand-written memory fixture would miss serialization
// bugs between correction and reuse.
const weightMemory = basisMemoryRow;
const grams75 = applyMemory({
  food_name: "Yogabar High Protein Oats (Dark Chocolate)",
  protein: 22.5, kcal: 303, quantity: 1, unit: "75g",
  portionAmount: 75, portionUnit: "g",
}, weightMemory);
assert.strictEqual(grams75.protein, 19.5, "26g/100g scales to 19.5g at 75g");
assert.strictEqual(grams75.kcal, 303, "catalog calories are not frozen by memory");

const grams50 = applyMemory({
  food_name: "Yogabar High Protein Oats (Dark Chocolate)",
  protein: 15, kcal: 202, quantity: 1, unit: "50g",
  portionAmount: 50, portionUnit: "g",
}, weightMemory);
assert.strictEqual(grams50.protein, 13, "26g/100g scales to 13g at 50g");
assert.match(memoryNote(grams50), /26g protein per 100g/i,
  "the applied note exposes the remembered label basis, not only the scaled total");

const mango = applyMemory({
  food_name: "Yogabar High Protein Oats (Mango)",
  protein: 12, kcal: 210, quantity: 1, unit: "50g",
  portionAmount: 50, portionUnit: "g",
}, weightMemory);
assert.strictEqual(mango.protein, 12, "a different exact variant is untouched");
assert.ok(!mango.memoryApplied);

const quarantined = applyMemory({
  food_name: "Yogabar High Protein Oats (Dark Chocolate)",
  protein: 15, kcal: 202, quantity: 1, unit: "50g",
  portionAmount: 50, portionUnit: "g",
}, { ...weightMemory, status: "needs_reconfirmation" });
assert.strictEqual(quarantined.protein, 15,
  "a quarantined memory is visible for review but never silently applied");
assert.ok(!quarantined.memoryApplied);

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

// --- list/edit visibility ------------------------------------------------
assert.ok(parseMemoryListRequest("my corrections"));
assert.ok(parseMemoryListRequest("what do you remember about my food?"));
assert.strictEqual(parseMemoryListRequest("2 roti and dal"), false);
assert.match(formatMemories([]), /haven't saved any food corrections/i);
const listed = formatMemories([weightMemory]);
assert.match(listed, /Yogabar High Protein Oats \(Dark Chocolate\)/);
assert.match(listed, /26g protein per 100g/);
assert.match(listed, /confirmed by you/i);
assert.match(listed, /forget 1/i);

console.log("correction-memory-test: all passed");
