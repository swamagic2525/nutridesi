# Basis-less Nutrition Correction Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a nutrition value with no explicit basis apply once to the consumed portion, while preserving all explicit `each`, `per scoop`, and weight-basis scaling.

**Architecture:** Keep the parser prompt unchanged and make the deterministic overlay's missing-basis fallback safe. Add structured parser/basis diagnostics at the existing private correction-log boundary, then cover both the pure arithmetic and the real `replaced_by_name` server route with TDD. No schema or historical-data mutation is involved.

**Tech Stack:** Node.js CommonJS, built-in `assert`, Express route harness with `require.cache` I/O stubs, Supabase-backed production persistence, Git/launchd deployment.

---

## File map

- Modify `src/parser.js`: attach the provider that produced the accepted parse; do not change the prompt or parsed nutrition semantics.
- Modify `src/correctionLogger.js`: build correction events through a pure helper and retain basis/provider diagnostics.
- Create `test/correction-logger-test.js`: verify diagnostic shape without writing a real correction log.
- Modify `package.json`: add the focused `test:corrlog` command.
- Modify `test/ref-guard-test.js`: pin missing-basis and explicit-basis arithmetic.
- Modify `src/db.js`: change only the missing-basis scale from quantity to `1`.
- Modify `test/server-routing-test.js`: exercise the production `replaced_by_name` route with the avocado fixture and forced-failure recovery.
- Modify `docs/ai-onboarding.md`: document the deployed invariant, test command, and rollback boundary.

### Task 1: Capture the production baseline

**Files:**
- Read: repository status and current commit

- [ ] **Step 1: Confirm the worktree contains only the committed design**

Run:

```bash
git status --short
git rev-parse --short HEAD
```

Expected: empty status; current commit is at or after design commit `7996024`. Record this SHA in the final deployment handoff as the pre-change rollback point.

- [ ] **Step 2: Prove the focused baseline is green**

Run:

```bash
npm run test:ref
npm run test:routing
npm run test:corrections
npm run test:memcorr
```

Expected: all commands pass before edits.

### Task 2: Add correction-basis diagnostics

**Files:**
- Create: `test/correction-logger-test.js`
- Modify: `src/correctionLogger.js:6-36`
- Modify: `src/parser.js:210-228`
- Modify: `package.json:8-27`

- [ ] **Step 1: Write the failing pure diagnostic test**

Create `test/correction-logger-test.js`:

```js
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
```

Add to `package.json` scripts:

```json
"test:corrlog": "node test/correction-logger-test.js"
```

- [ ] **Step 2: Run the test and verify it fails for missing exports**

Run:

```bash
npm run test:corrlog
```

Expected: FAIL because `buildCorrectionEvent` and `annotateParserProvider` do not exist.

- [ ] **Step 3: Add minimal parser provenance**

In `src/parser.js`, add the pure helper above `parseMeal`:

```js
function annotateParserProvider(parsed, provider) {
  return { ...(parsed || {}), parser_provider: provider || null };
}
```

Replace the successful return inside `parseMeal` with:

```js
const normalized = pinPizzaSlices(rawMessage, parsed);
return annotateParserProvider(normalized, name);
```

Add `annotateParserProvider` to `module.exports`. Do not edit `SYSTEM_PROMPT`, provider order, retry logic, or temperature.

- [ ] **Step 4: Extract the pure correction-event builder**

In `src/correctionLogger.js`, move the existing event construction into:

```js
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
    deleted: (deleted || []).map(r => ({ food_name: r.food_name, kcal: r.kcal })),
    outcome,
  };
}
```

Make `logCorrectionEvent(args)` call `buildCorrectionEvent(args)` before the existing `appendFileSync`, and export both functions:

```js
module.exports = { buildCorrectionEvent, logCorrectionEvent };
```

- [ ] **Step 5: Run diagnostics and existing routing tests**

Run:

```bash
npm run test:corrlog
npm run test:routing
```

Expected: both pass. The correction log remains gitignored and no production database is touched.

- [ ] **Step 6: Commit the independently safe diagnostics**

```bash
git add package.json src/parser.js src/correctionLogger.js test/correction-logger-test.js
git commit -m "Add correction basis diagnostics"
```

Expected: one diagnostics-only commit with no prompt, database, or nutrition behaviour change.

### Task 3: Make missing-basis values consumed totals

**Files:**
- Modify: `test/ref-guard-test.js:54-68`
- Modify: `src/db.js:264-281`

- [ ] **Step 1: Write the failing missing-basis arithmetic tests**

Add after the existing stated-basis tests in `test/ref-guard-test.js`:

```js
const halfPortion = {
  food_name: "avocado", quantity: 0.5, unit: "piece",
  kcal: 80, protein: 5, carbs: 4, fat: 7, fiber: 3,
};
applyStatedNutrition({ stated_kcal: 160 }, halfPortion);
assert.strictEqual(halfPortion.kcal, 160,
  "a basis-less correction is the total for the consumed half portion");

const pluralTotal = {
  food_name: "samosa", quantity: 2, unit: "piece",
  kcal: 500, protein: 10, carbs: 50, fat: 28, fiber: 4,
};
applyStatedNutrition({ stated_kcal: 500 }, pluralTotal);
assert.strictEqual(pluralTotal.kcal, 500,
  "a plural statement without each/per remains a consumed total");

const explicitEach = {
  food_name: "roti", quantity: 2, unit: "piece",
  kcal: 180, protein: 6, carbs: 36, fat: 2, fiber: 4,
};
applyStatedNutrition({
  stated_kcal: 90, stated_basis_amount: 1, stated_basis_unit: "piece",
}, explicitEach);
assert.strictEqual(explicitEach.kcal, 180,
  "an explicit per-piece basis still scales by consumed quantity");
```

The existing 75g/100g and two-scoop tests remain unchanged and continue guarding weighted and per-scoop scaling.

- [ ] **Step 2: Run the test and verify the historical failure**

Run:

```bash
npm run test:ref
```

Expected: FAIL because the half portion becomes 80 and the two-item total becomes 1000 under the current quantity fallback.

- [ ] **Step 3: Implement the one-branch behaviour change**

Replace only the missing-basis branch in `statedBasisScale()`:

```js
if (!(basisAmount > 0) || !basisUnit) {
  return { scale: 1, basisAmount: 1, basisUnit: row.unit || "serving" };
}
```

Do not change the gram/millilitre branch, explicit-unit compatibility, calorie/protein limits, macro overlay, resolution order, correction memory, or parser prompt.

- [ ] **Step 4: Run focused arithmetic and memory tests**

Run:

```bash
npm run test:ref
npm run test:memcorr
npm run test:dbshape
```

Expected: all pass.

### Task 4: Exercise the actual named-correction route

**Files:**
- Modify: `test/server-routing-test.js:13-139,213-261`

- [ ] **Step 1: Make the atomic replacement stub test-configurable**

Before stubbing `src/db.js`, load the real pure nutrition overlay with inert test
configuration and add a controlled implementation variable:

```js
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY ||= "test-key";
const { applyStatedNutrition: realApplyStatedNutrition } = require("../src/db.js");
let replaceMealAtomicImpl = null;
```

Replace the fixed `replaceMealAtomic` stub with:

```js
replaceMealAtomic: async (...args) => {
  calls.push({ name: "replaceMealAtomic", args });
  if (replaceMealAtomicImpl) return replaceMealAtomicImpl(...args);
  return { rows: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0, meals: [] } };
},
```

Reset `replaceMealAtomicImpl = null` inside `reset()` so tests cannot leak state.

- [ ] **Step 2: Add the production-shaped avocado regression**

Add this case beside the existing nutrition-correction route tests:

```js
phone = reset({ tdee_profile: {}, conversation_state: {} }, {
  intent: "replace_last",
  replace_target: "avocado",
  items: [{
    food_name: "avocado", quantity: 0.5, unit: "piece",
    stated_kcal: 160, stated_basis_amount: null, stated_basis_unit: null,
  }],
});
todayItemsFixture = [{ id: 55, day_seq: 5, food_name: "avocado", quantity: 0.5, kcal: 80 }];
rowsBySeqFixture = [{ id: 55, day_seq: 5, food_name: "avocado", quantity: 0.5, kcal: 80 }];
replaceMealAtomicImpl = async (_from, corrected) => {
  const item = corrected.items[0];
  const row = {
    food_name: "avocado", quantity: item.quantity, unit: "piece",
    kcal: 80, protein: 5, carbs: 4, fat: 7, fiber: 3, day_seq: 5,
  };
  realApplyStatedNutrition(item, row);
  return {
    rows: [row],
    totals: { kcal: row.kcal, protein: row.protein, carbs: row.carbs, fat: row.fat, fibre: row.fiber, meals: [row] },
  };
};
reply = await handleMessage(phone, "Half avocado was 160 calories");
assert.match(reply, /avocado.*×0\.5.*160 kcal/is,
  "the named correction route stores the stated total for the consumed half");
assert.deepStrictEqual(
  calls.find(c => c.name === "replaceMealAtomic").args[2],
  [55],
  "the route still replaces exactly the selected log row",
);
```

- [ ] **Step 3: Add the atomic failure guard on the same route**

Add immediately after the successful case:

```js
phone = reset({ tdee_profile: {}, conversation_state: {} }, {
  intent: "replace_last",
  replace_target: "avocado",
  items: [{ food_name: "avocado", quantity: 0.5, stated_kcal: 160 }],
});
todayItemsFixture = [{ id: 56, day_seq: 5, food_name: "avocado", quantity: 0.5, kcal: 80 }];
rowsBySeqFixture = [{ id: 56, day_seq: 5, food_name: "avocado", quantity: 0.5, kcal: 80 }];
replaceMealAtomicImpl = async () => { throw new Error("forced insert failure"); };
reply = await handleMessage(phone, "Half avocado was 160 calories");
assert.match(reply, /original entry is unchanged/i);
assert.strictEqual(called("replaceMealAtomic"), 1);
assert.strictEqual(called("deleteBySeq"), 0,
  "a failed correction never deletes outside the atomic RPC");
```

- [ ] **Step 4: Run the route and correction safety suites**

Run:

```bash
npm run test:routing
npm run test:corrections
npm run test:memory
npm run test:midnight
```

Expected: all pass. The successful reply contains 160 kcal; the forced failure says the original is unchanged.

### Task 5: Document the invariant and run the release gate

**Files:**
- Modify: `docs/ai-onboarding.md:320-340,470-510`

- [ ] **Step 1: Add the production invariant**

Add after invariant 14 in `docs/ai-onboarding.md`:

```markdown
15. **Basis-less user nutrition is a consumed total.** If the parser supplies a
    calorie or protein value without an explicit basis, `statedBasisScale()` uses
    scale 1. Only explicit `each`, `per piece`, `per scoop`, `per 100g`, or
    `per 100ml` bases scale proportionally. Keep `npm run test:ref`,
    `npm run test:routing`, and `npm run test:corrlog` green when touching this
    contract. The change has no schema migration; rollback is a code revert.
```

Add a short incident note in the historical decisions section: the 7 August half-avocado correction exposed double-scaling when a parser result lacked basis diagnostics, so accepted parses now record provider and basis in the gitignored correction log.

- [ ] **Step 2: Run the complete proportional verification suite**

Run:

```bash
npm run test:corrlog
npm run test:ref
npm run test:routing
npm run test:corrections
npm run test:memcorr
npm run test:dbshape
npm run test:memory
npm run test:midnight
npm run test:outcomes
npm run test:tdee
node evals/run.js
```

Expected: every local suite passes and parser evals report 162/162. Do not deploy on any failure.

- [ ] **Step 3: Scan the public diff**

Run:

```bash
git diff --check
git diff --stat
git diff
git grep -nE '(\+91[0-9]{10}|ngrok|sk-[A-Za-z0-9]|Co-authored-by)' -- src test docs package.json
git status --short
```

Expected: no real phone number, name, email, tunnel URL, credential, or AI co-author trailer in the change. Synthetic `+000...` routing fixtures are allowed.

- [ ] **Step 4: Commit the tested behaviour and onboarding update**

```bash
git add src/db.js test/ref-guard-test.js test/server-routing-test.js docs/ai-onboarding.md
git commit -m "Fix basis-less nutrition corrections"
```

Expected: a second small commit, independently revertible from diagnostics.

### Task 6: Deploy, verify, and preserve rollback

**Files:**
- No source changes

- [ ] **Step 1: Record the release commits**

Run:

```bash
git log -3 --oneline
git status --short
```

Expected: clean worktree with the design, diagnostics, and behaviour commits visible. Record the diagnostics and behaviour SHAs in the final handoff.

- [ ] **Step 2: Restart production**

Run:

```bash
launchctl kickstart -k gui/501/com.nutridesi.server
```

Expected: command succeeds.

- [ ] **Step 3: Verify health and error tail**

Use the repository's existing local health check and launchd log inspection commands documented for the current host. Expected: `NutriDesi is running.`, a running launchd service, and no new startup/runtime error after the restart.

- [ ] **Step 4: State the reversible rollback command in the handoff**

If the new behaviour causes a regression:

```bash
git revert "$(git log -1 --format=%H --grep='Fix basis-less nutrition corrections')"
launchctl kickstart -k gui/501/com.nutridesi.server
```

Keep the diagnostics commit deployed unless it independently causes a failure. No database rollback is required, and existing rows are not rewritten.
