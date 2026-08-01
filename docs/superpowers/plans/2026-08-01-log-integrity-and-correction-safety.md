# Log Integrity and Correction Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure NutriDesi never confirms an unsaved meal, treats a clearly named new food as an addition, accepts useful pasted recovery context, and safely repairs the affected `…0419` record.

**Architecture:** Keep the existing Express webhook and resolution pipeline. Add a pure persistence serializer with an explicit `user_logs` allowlist, await the existing Supabase insert on every user-facing log path, and tighten the deterministic correction guard so generic nutrition words cannot connect unrelated foods. Handle long messages with a bounded higher limit and recovery-oriented copy; do not build a new conversational subsystem.

**Tech Stack:** Node.js CommonJS, Express, Supabase, Anthropic parser, built-in `assert` tests.

---

## File map

- Modify `src/db.js`: isolate and test the `user_logs` insert serializer; keep transient resolution metadata out of Supabase.
- Modify `src/correctionContext.js`: distinguish meaningful food identity from generic nutrition descriptors.
- Modify `server.js`: await ordinary inserts, force explicit addition-recovery language to remain a log, and accept bounded pasted context.
- Modify `test/correction-context-test.js`: unit regressions for `20g protein shake` and misleading shared words.
- Modify `test/server-routing-test.js`: behavioral regressions for awaited logging, recovery wording, and long input.
- Create `test/db-insert-shape-test.js`: prove internal row flags never become database columns.
- Modify `package.json`: add the focused persistence test command.
- Modify `docs/ai-onboarding.md`: record the resolved incident and the new persistence invariant after deployment.

### Task 1: Lock down the current insert allowlist

**Files:**
- Modify: `src/db.js:16-25, 677-708, module.exports`
- Create: `test/db-insert-shape-test.js`
- Modify: `package.json:scripts`

- [ ] **Step 1: Write the failing serializer test**

Create a row containing every known internal flag and assert that only real `user_logs` columns survive:

```js
const assert = require("assert");
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY ||= "test-key";
const { toUserLogInsertRow } = require("../src/db.js");

const saved = toUserLogInsertRow({
  phone_number: "+000000000001", food_name: "Test oats", matched_db_id: 134,
  quantity: 1, unit: "serving", kcal: 202, protein: 26, carbs: 30,
  fat: 5, fiber: 4, meal_time: "breakfast", is_estimate: false,
  date: "2026-08-01", day_seq: 1,
  stated: true, userSaid: "oats", assumed: false, portionNote: "test",
  refVerified: true, rerankMatched: true, memoryApplied: true, memoryName: "oats",
});

assert.deepStrictEqual(Object.keys(saved).sort(), [
  "carbs", "date", "day_seq", "fat", "fiber", "food_name", "is_estimate",
  "kcal", "matched_db_id", "meal_time", "phone_number", "protein",
  "quantity", "unit",
].sort());
assert.strictEqual(saved.rerankMatched, undefined);
assert.strictEqual(saved.memoryApplied, undefined);
console.log("db-insert-shape-test: passed");
```

- [ ] **Step 2: Run the test and verify it fails before exporting the serializer**

Run: `node test/db-insert-shape-test.js`

Expected: FAIL because `toUserLogInsertRow` is not exported.

- [ ] **Step 3: Extract the allowlist mapping into a pure function**

Use one mapping function for every insert:

```js
function toUserLogInsertRow(row) {
  const out = {};
  for (const col of USER_LOG_COLUMNS) {
    if (row[col] !== undefined) out[col] = row[col];
  }
  return out;
}
```

Change the insert to `.insert(rows.map(toUserLogInsertRow))` and export the helper for the focused test.

- [ ] **Step 4: Add and run the focused test command**

Add `"test:dbshape": "node test/db-insert-shape-test.js"` to `package.json`.

Run: `npm run test:dbshape`

Expected: `db-insert-shape-test: passed`.

### Task 2: Never confirm an unpersisted ordinary log

**Files:**
- Modify: `server.js:1008-1015`
- Modify: `test/server-routing-test.js`

- [ ] **Step 1: Add a behavioral test for a rejected normal insert**

Using the existing server-routing dependency stubs, make `logMeal` throw for an ordinary food log and assert the reply contains `nothing was logged` and does not begin with `✅ Logged`.

```js
assert.match(reply, /nothing was logged/i);
assert.doesNotMatch(reply, /^✅\s*logged/i);
assert.strictEqual(logMealCalls[0].options.awaitInsert, true);
```

- [ ] **Step 2: Run the routing test and verify the new assertion fails**

Run: `npm run test:routing`

Expected: FAIL because the ordinary path currently calls `logMeal(from, parsed)` without `awaitInsert`.

- [ ] **Step 3: Await the normal insert and use accurate failure copy**

Replace the conditional ordinary call with:

```js
try {
  result = await logMeal(from, parsed, { awaitInsert: true });
} catch (_) {
  return "I couldn't save that meal, so nothing was logged. Please send it again.";
}
```

Keep the existing claimed-action safety logic; do not change correction deletion behavior in this task.

- [ ] **Step 4: Run persistence and routing tests**

Run: `npm run test:dbshape && npm run test:routing && npm run test:memory`

Expected: all pass.

### Task 3: Prevent generic-word correction promotion

**Files:**
- Modify: `src/correctionContext.js:14-42`
- Modify: `test/correction-context-test.js`

- [ ] **Step 1: Add the `…0419` intent regressions**

Add tests proving a new shake cannot be connected to oats through the word `protein`, while real named corrections still promote:

```js
const oats = [{ id: 20, food_name: "Yogabar High Protein Oats", kcal: 202, protein: 26 }];
const shakeLog = {
  intent: "log",
  items: [{ food_name: "Protein Shake", stated_protein: 20 }],
};
assert.strictEqual(
  shouldPromoteToReplace(shakeLog, "20g protein shake", oats),
  false,
);
assert.strictEqual(
  shouldPromoteToReplace(
    { intent: "log", items: [{ food_name: "Yogabar oats", stated_protein: 26 }] },
    "Yogabar oats has 26g protein",
    oats,
  ),
  true,
);
```

Also cover `Protein Muesli` followed by `20g protein shake`; shared `protein` alone must not promote.

- [ ] **Step 2: Run the correction test and verify it fails**

Run: `npm run test:corrections`

Expected: FAIL because `namesOverlap` currently accepts any shared word longer than two letters.

- [ ] **Step 3: Match food identity, not nutrition descriptors**

Introduce exact word tokens and discard generic descriptors before overlap:

```js
const NON_IDENTITY_WORDS = new Set([
  "high", "low", "protein", "calorie", "calories", "kcal", "fat",
  "gram", "grams", "with", "and", "the",
]);

function identityWords(value) {
  return words(value).filter(word => !NON_IDENTITY_WORDS.has(word));
}
```

Require at least one identical identity word, using token equality rather than substring matching. Preserve pronoun corrections such as `it was 150 kcal`.

- [ ] **Step 4: Run focused correction and parser-routing suites**

Run: `npm run test:corrections && npm run test:routing && npm run test:memory`

Expected: all pass.

### Task 4: Recognize explicit “add, don’t replace” recovery language

**Files:**
- Modify: `src/correctionContext.js`
- Modify: `server.js:729-783`
- Modify: `test/correction-context-test.js`
- Modify: `test/server-routing-test.js`

- [ ] **Step 1: Add pure recovery-cue tests**

```js
assert.strictEqual(isExplicitAddition("I was adding protein shake, don't change the earlier one"), true);
assert.strictEqual(isExplicitAddition("the earlier meal was correct, please add a shake"), true);
assert.strictEqual(isExplicitAddition("change the earlier shake to 20g protein"), false);
```

- [ ] **Step 2: Add a routing test**

Stub the parser to return `replace_last` for the frustrated-user sentence. Assert the server forces `log`, performs no delete, and logs exactly one shake.

- [ ] **Step 3: Implement a narrow explicit-addition guard**

Use both an addition phrase and a do-not-change/earlier-was-correct phrase:

```js
function isExplicitAddition(text) {
  const value = String(text || "").toLowerCase();
  const adding = /\b(add|adding|log|logging)\b/.test(value);
  const preserve = /\b(?:don'?t|do not|did not)\s+(?:change|replace|remove)\b|\b(?:earlier|previous)\b[^.]{0,40}\bcorrect\b/.test(value);
  return adding && preserve;
}
```

After parsing and before promotion, set `parsed.intent = "log"` and clear `replace_target` when this guard is true. This is deliberately narrow; ordinary phrases containing `add` must retain existing modifier behavior.

- [ ] **Step 4: Run the focused suites**

Run: `npm run test:corrections && npm run test:routing && npm run test:memory`

Expected: all pass.

### Task 5: Accept useful long recovery messages safely

**Files:**
- Modify: `server.js:131, 368-376`
- Modify: `test/server-routing-test.js`

- [ ] **Step 1: Add pasted-reply and bounded-length behavior tests**

Assert that a pasted NutriDesi receipt is recognized and never re-logged, a normal 500-character meal reaches the parser, and a message above the new hard limit performs no write.

```js
assert.match(pastedReceiptReply, /I can see the earlier log/i);
assert.strictEqual(parseCalls.length, 0); // never parse foods from our own receipt
assert.strictEqual(logMealCalls.length, 0);
assert.strictEqual(parseCalls.length, 1); // 500-character food/context message
assert.match(tooLongReply, /last instruction|food and portion/i);
assert.strictEqual(logMealCalls.length, 0); // over hard limit
```

- [ ] **Step 2: Detect a pasted NutriDesi receipt before parsing**

Add a narrow format check for the bot's own receipt prefix:

```js
function isPastedLoggedReply(text) {
  return /^\s*✅\s*Logged\b/i.test(String(text || ""));
}
```

Before the length guard, return without parsing or writing:

```js
return "I can see the earlier log. Send only what you want me to add or change — for example, ‘add one 20g protein shake’. Nothing was changed.";
```

This avoids the opposite failure: accepting the pasted receipt and logging every listed food a second time.

- [ ] **Step 3: Raise only the hard input ceiling**

Change `maxLen` from `300` to `1200`. Do not remove the bound because webhook cost and prompt-injection exposure still need a ceiling.

- [ ] **Step 4: Replace the scolding response**

Use:

```js
return "I couldn't safely read the full pasted message. Send just your last instruction — for example, ‘add one 20g protein shake’. Nothing was changed.";
```

- [ ] **Step 5: Run routing, context, and rate-limit-related tests**

Run: `npm run test:routing && npm run test:memory && npm run smoke`

Expected: all pass.

### Task 6: Full production verification and deployment

**Files:**
- Modify: `docs/ai-onboarding.md`

- [ ] **Step 1: Run every local suite**

Run each `npm run test:*` script listed in `package.json`, plus `node test/ingest-foods-test.js` if present.

Expected: all suites pass.

- [ ] **Step 2: Run the mandatory evaluation**

Run: `node evals/run.js`

Expected: `160/160` green, or the current documented total with zero failures. Stop on any regression.

- [ ] **Step 3: Review the complete diff for secrets and PII**

Run: `git diff --check`, inspect `git diff`, and search added lines for raw Indian phone numbers, personal names, ngrok URLs, API keys, and `.env` values. Test fixtures must use `+00…` synthetic identifiers and documentation must use `…0419` only.

- [ ] **Step 4: Update onboarding with the new invariants**

Document:

```md
- User-facing “Logged” replies require a successful awaited Supabase insert.
- `user_logs` inserts use an explicit column allowlist; transient resolution flags never reach Postgres.
- Generic nutrition words such as “protein” cannot by themselves link a new food to a correction target.
```

- [ ] **Step 5: Commit without an AI co-author trailer**

Commit the reviewed code, tests, plan, and onboarding update with a concise message such as `Prevent silent meal loss and unsafe correction promotion`.

- [ ] **Step 6: Restart and inspect production**

Run: `launchctl kickstart -k gui/501/com.nutridesi.server`

Confirm the service is running and inspect the new log tail for startup errors or `SUPABASE INSERT FAILED`.

### Task 7: Repair user `…0419` only after deployment

**Files:**
- No repository files. Use a temporary, non-repository backup under `/private/tmp`.

- [ ] **Step 1: Take a before snapshot**

Read all 1 Aug rows for the single account ending `0419`, mask the phone in displayed output, and save the raw JSON backup only under a freshly created `/private/tmp` directory. Confirm the snapshot contains the expected two shake rows and is missing oats plus the masoor/tofu/soya meal.

- [ ] **Step 2: Calculate the exact repair from the conversation audit**

The target state is the last known-good 1,355 kcal / 124g protein state plus one 120 kcal / 20g protein shake: approximately 1,475 kcal / 144g protein. Preserve unaffected muesli, milk, and chia rows. Do not infer or change any other date.

- [ ] **Step 3: Apply one narrowly targeted repair**

Delete only the duplicate/default 24g shake, restore the missing oats and masoor/tofu/soya rows from the audited resolved values, and retain exactly one 120 kcal / 20g shake. Use the same explicit `user_logs` column allowlist as production code.

- [ ] **Step 4: Verify the repaired day**

Re-read 1 Aug rows, confirm no duplicate shake, confirm all intended foods exist once, and independently sum calories and protein to approximately 1,475 / 144. Do not message the user automatically because Twilio’s 24-hour outbound restriction and trial rejoin rules apply.

- [ ] **Step 5: Remove the temporary raw backup after verification**

Delete only the exact temporary directory created in Step 1 and report that the production record was repaired and the temporary PII backup was removed.

## Self-review

- Spec coverage: insert integrity, truthful confirmation, correction intent, recovery language, long pasted context, production verification, restart, PII scan, and targeted repair are each covered.
- Scope exclusions: no parser rewrite, no new memory architecture, no bulk historical repair, and no outbound user message.
- Safety order: code is verified and deployed before the affected production record is changed.
