# Basis-Aware Correction Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scale user-confirmed nutrition across quantities without crossing product variants or promoting inferred macros to confirmed facts.

**Architecture:** Extend the existing per-user override table additively. The parser returns an explicit nutrition basis, resolution preserves consumed amount and source metadata, and the pure correction-memory module normalizes/apply fields by compatible basis. Server routing falls through from malformed nutrition targets and exposes a read-only saved-corrections command.

**Tech Stack:** Node.js CommonJS, Supabase/PostgreSQL, Express/Twilio, existing plain-Node assertion suites.

---

### Task 1: Pin basis and variant behavior in pure tests

**Files:**
- Modify: `test/correction-memory-test.js`
- Modify: `src/correctionMemory.js`

- [ ] Add failing assertions that exact keys retain `Dark Chocolate`, that a
  26g/100g memory produces 19.5g at 75g and 13g at 50g, that Mango does not
  receive the Chocolate memory, and that an unconfirmed calorie is not tagged
  `user_confirmed`.
- [ ] Run `npm run test:memcorr` and confirm failure occurs because the current
  key strips parentheticals and `applyMemory` has no basis-aware path.
- [ ] Add the minimal normalization and application helpers in
  `src/correctionMemory.js`; retain legacy-row compatibility.
- [ ] Re-run `npm run test:memcorr` and confirm all assertions pass.

### Task 2: Preserve weight through reference resolution

**Files:**
- Modify: `test/ref-guard-test.js`
- Modify: `src/db.js`

- [ ] Add a failing reference-resolution test in which a 75g row matched to a
  reference with per-100g nutrition remains `75g` and receives scaled macros.
- [ ] Run `npm run test:ref` and confirm the current `applyReference` replaces it
  with an opaque serving.
- [ ] Carry transient `portionAmount`/`portionUnit` metadata from
  `resolveItemBase` and make `applyReference` prefer `*_100g` fields for an
  explicit g/ml amount.
- [ ] Re-run `npm run test:ref` and `npm run test:dbshape`; confirm transient
  metadata is stripped from `user_logs` inserts.

### Task 3: Parse and preserve nutrition basis

**Files:**
- Modify: `src/systemPrompt.js`
- Modify: `evals/cases.jsonl`
- Modify: `evals/run.js`
- Modify: `src/db.js`

- [ ] Add eval expectations for `stated_basis_amount` and
  `stated_basis_unit`: 26g protein per 100g, 12g/217 kcal per 350ml, and 27g per
  scoop.
- [ ] Extend the parser contract with those two fields while preserving the
  existing meaning when no explicit basis is supplied.
- [ ] Update `resolveItem` to scale each stated field deterministically from the
  declared basis to the consumed amount and attach field-level provenance for
  memory persistence.
- [x] Run the focused offline tests, then `node evals/run.js`; require 162/162.

### Task 4: Stop nutrition corrections from dead-ending

**Files:**
- Modify: `test/server-routing-test.js`
- Modify: `server.js`

- [ ] Add a failing routing case where the parser returns a stale or malformed
  `replace_target` alongside a valid stated macro and `matchLastLogTargets`
  identifies the latest row.
- [ ] Run `npm run test:routing` and confirm the strict explicit-swap branch
  currently returns without calling `replaceMealAtomic`.
- [ ] Let stated-nutrition corrections fall through when the explicit target
  cannot resolve; keep strict refusal for genuine food-for-food swaps.
- [ ] Re-run `npm run test:routing` and confirm the atomic replacement receives
  the target id.

### Task 5: Add the migration and persistence shape

**Files:**
- Create: `correction-memory-basis.sql`
- Modify: `supabase-schema.sql`
- Modify: `src/db.js`
- Modify: `test/db-insert-shape-test.js`

- [ ] Add additive correction-memory columns for basis, per-field value,
  provenance, source assertion, source kind/reference, and status with bounded
  checks.
- [ ] In the same SQL transaction, rewrite exact variant keys and basis-aware
  values for the three existing named records without using phone numbers.
- [ ] Expand `correctionMemories`/`rememberCorrection` selects and upserts; make
  new memory writes use only structured assertions.
- [ ] Add persistence-shape tests proving transient provenance never reaches
  `user_logs` and a protein-only correction does not persist calories as
  user-confirmed.

### Task 6: Add the saved-corrections WhatsApp surface

**Files:**
- Modify: `src/correctionMemory.js`
- Modify: `server.js`
- Modify: `test/correction-memory-test.js`
- Modify: `test/server-routing-test.js`

- [ ] Add failing tests for `my corrections`, empty state, variant-bearing
  output, provenance labels, and numbered forget instructions.
- [ ] Add a deterministic pre-parser route and pure formatter.
- [ ] Re-run `npm run test:memcorr` and `npm run test:routing`.

### Task 7: Migration-first production verification

**Files:**
- Modify: `docs/ai-onboarding.md`
- Modify: `docs/claude-handoff-2026-08-01.md`

- [x] Apply `correction-memory-basis.sql` in Supabase before restarting Node.
- [x] Read back the three memory rows without printing phone numbers and verify
  their exact keys, basis, values, and provenance.
- [x] Run all relevant unit suites, `npm run test:brand`, and
  `node evals/run.js` with 162/162 required.
- [x] Scan `git diff` and tracked files for real names, phone numbers, ngrok
  URLs, and secrets.
- [x] Restart with `launchctl kickstart -k gui/501/com.nutridesi.server`, check
  HTTP health and the masked production log, and manually exercise the 75g →
  50g scaling sequence.
