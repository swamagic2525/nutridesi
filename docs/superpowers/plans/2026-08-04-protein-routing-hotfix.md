# Protein Routing Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the pre-parser protein-goal shortcut so natural food macro corrections reach the existing context-aware parser and atomic correction pipeline.

**Architecture:** This is Phase 0 of the approved central semantic-routing design. Add behavioural regressions first, then delete the single dead shortcut from `server.js` and `src/conversationMemory.js`; do not change the parser prompt, nutrition resolver, database schema, or broader history-loading gate.

**Tech Stack:** Node.js, CommonJS, Express routing, built-in `assert`, stubbed behavioural tests, live LLM eval runner.

---

## File Map

- Modify `test/server-routing-test.js`: replace the shortcut-positive test with three behavioural cases proving corrections and legitimate protein-target requests reach the parser.
- Modify `test/conversation-memory-test.js`: remove unit/source assertions for the deleted helper.
- Modify `server.js`: remove the helper import and the pre-parser early return.
- Modify `src/conversationMemory.js`: delete the unused helper and export.
- Do not modify `src/parser.js`, `src/systemPrompt.js`, `src/db.js`, SQL, or food data in this hotfix.

### Task 1: Pin the production failure with behavioural tests

**Files:**
- Modify: `test/server-routing-test.js:412-420`

- [ ] **Step 1: Replace the old shortcut-positive test with two correction regressions**

Insert this helper and the two cases where the old test currently sits:

```js
  const kulfiTarget = {
    id: 91, day_seq: 9, food_name: "Kulfi", quantity: 1, unit: "stick",
    kcal: 150, protein: 4, is_estimate: true,
  };
  const kulfiCorrection = {
    intent: "replace_last",
    replace_target: null,
    items: [{
      food_name: "Kulfi", quantity: 1, unit: "stick",
      stated_kcal: 60, stated_protein: 10,
    }],
  };

  for (const message of [
    "Kulfi was 60 calories and 10g protein",
    "Please correct kulfi calories It is 60 Calories and 10g protein",
  ]) {
    phone = reset(
      { tdee_profile: {}, conversation_state: {}, goal_kcal: 2000, goal_protein: null },
      kulfiCorrection
    );
    lastLogBatchFixture = [kulfiTarget];
    matchLastLogTargetsFixture = [kulfiTarget];
    const correctionReply = await handleMessage(phone, message);
    assert.strictEqual(called("parseMeal"), 1,
      `macro correction must reach parseMeal: ${message}`);
    assert.strictEqual(called("replaceMealAtomic"), 1,
      `macro correction must reach atomic replacement: ${message}`);
    assert.doesNotMatch(String(correctionReply), /tell me your weight/i,
      `macro correction must not become a protein-goal prompt: ${message}`);
  }
```

- [ ] **Step 2: Add a legitimate protein-target request regression**

Append after the correction loop:

```js
  phone = reset(
    { tdee_profile: {}, conversation_state: {}, goal_kcal: 1800, goal_protein: null },
    { intent: "calculate_tdee", items: [], requested_goal_component: "protein" }
  );
  const proteinReply = await handleMessage(phone, "what protein should i eat for this goal");
  assert.match(String(proteinReply), /Age.*Male\/Female.*Height.*Weight/s,
    "a genuine protein-target request enters the deterministic goal calculator");
  assert.strictEqual(called("parseMeal"), 1,
    "the semantic protein-target request is classified by parseMeal");
```

- [ ] **Step 3: Run the routing test and verify the new correction case fails**

Run:

```bash
npm run test:routing
```

Expected: FAIL on the first kulfi assertion because `parseMeal` was called zero
times and the old shortcut returned the weight/protein-target prompt.

- [ ] **Step 4: Commit the failing regression checkpoint only if working outside `main`**

Do not commit a known-red test on the live `main` branch. Continue immediately to
Task 2 when executing inline on `main`.

### Task 2: Remove the pre-parser shortcut

**Files:**
- Modify: `server.js:17-35`
- Modify: `server.js:499-500`
- Modify: `src/conversationMemory.js:337-345`
- Modify: `src/conversationMemory.js:387-409`

- [ ] **Step 1: Remove the import and early return from `server.js`**

Delete `contextualProteinGoalReply` from the destructured
`./src/conversationMemory.js` import, then delete:

```js
  const proteinGoalReply = contextualProteinGoalReply(trimmed, profile);
  if (proteinGoalReply) return proteinGoalReply;
```

- [ ] **Step 2: Delete the helper and export from `src/conversationMemory.js`**

Delete the complete function:

```js
function contextualProteinGoalReply(text, profile) {
  const value = normaliseText(text).toLowerCase();
  const kcal = finiteNumber(safeGet(profile, "goal_kcal") ?? safeGet(profile, "calorie_goal") ?? safeGet(profile, "calorieGoal"));
  const protein = finiteNumber(safeGet(profile, "goal_protein") ?? safeGet(profile, "protein_goal") ?? safeGet(profile, "proteinGoal"));
  if (!Number.isFinite(kcal) || kcal <= 0 || (Number.isFinite(protein) && protein > 0)) return null;
  if (!/\bprotein\b/.test(value) || !/\b(this|that|goal|calories?|kcal)\b/.test(value)) return null;
  return `For your ${Math.round(kcal).toLocaleString("en-IN")} kcal goal, tell me your weight in kg and whether you're aiming for fat loss or maintenance, and I'll set a protein target.`;
}
```

Remove `contextualProteinGoalReply` from `module.exports`.

- [ ] **Step 3: Run the behavioural routing test**

Run:

```bash
npm run test:routing
```

Expected: all routing tests PASS, including both kulfi corrections and the genuine
protein-target request.

### Task 3: Remove obsolete helper tests and wiring assertions

**Files:**
- Modify: `test/conversation-memory-test.js:1-26`
- Modify: `test/conversation-memory-test.js:100-135`
- Modify: `test/conversation-memory-test.js:776-797`

- [ ] **Step 1: Remove the helper from the test import**

Delete `contextualProteinGoalReply` from the destructured import of
`../src/conversationMemory.js`.

- [ ] **Step 2: Remove obsolete source and behaviour assertions**

Delete:

```js
assert.match(serverSource, /contextualProteinGoalReply/);
```

Update the nearby comment so the final bullet reads:

```js
//   - media follow-ups short-circuit before parsing
```

Delete the four direct `contextualProteinGoalReply(...)` assertions and remove its
call from the `assert.doesNotThrow` block.

- [ ] **Step 3: Run both focused suites**

Run:

```bash
npm run test:memory
npm run test:routing
```

Expected: both suites PASS.

- [ ] **Step 4: Verify the deleted shortcut has no references**

Run:

```bash
rg -n "contextualProteinGoalReply|proteinGoalReply" server.js src test
```

Expected: no output and exit status 1.

- [ ] **Step 5: Commit the hotfix**

```bash
git add server.js src/conversationMemory.js test/server-routing-test.js test/conversation-memory-test.js
git commit -m "Fix food correction intent preemption"
```

### Task 4: Run the production regression gate

**Files:**
- No file changes expected.

- [ ] **Step 1: Run all directly affected offline suites**

Run:

```bash
npm run test:routing
npm run test:memory
npm run test:corrections
npm run test:tdee
```

Expected: every suite PASS.

- [ ] **Step 2: Run the mandatory live parser eval**

Run:

```bash
node evals/run.js
```

Expected: `162/162 passed`.

- [ ] **Step 3: Scan the complete code diff for public-repository leaks**

Run:

```bash
git show --format=fuller --stat --patch HEAD
git grep -nE '\+91[0-9]{8,}|https?://[^ ]*ngrok|sk-[A-Za-z0-9_-]+' HEAD -- server.js src test
```

Expected: the patch contains only synthetic food messages and no real names, phone
numbers, tunnel URLs, API keys, secrets, or AI co-author trailer.

### Task 5: Restart and verify production

**Files:**
- No repository changes expected.

- [ ] **Step 1: Restart the launchd-owned server**

Run:

```bash
launchctl kickstart -k gui/501/com.nutridesi.server
```

Expected: exit status 0.

- [ ] **Step 2: Verify service state and health**

Run:

```bash
launchctl print gui/501/com.nutridesi.server
curl --fail --silent --show-error http://127.0.0.1:3000/health
```

Expected: launchd reports `state = running`; health returns
`NutriDesi is running`.

- [ ] **Step 3: Check only post-restart logs for errors**

Record the restart time, then inspect the bounded tail of
`~/Library/Logs/nutridesi.log`. Do not paste raw inbound messages or phone numbers
into committed files.

Expected: no startup exception, missing export, or repeated handler error after the
restart.

- [ ] **Step 4: Perform one synthetic acceptance check**

Use a non-production test identity or the founder's own sandbox session. First log a
synthetic kulfi, then send `Kulfi was 60 calories and 10g protein`.

Expected: the reply begins `Corrected`, shows 60 kcal and 10g protein, and does not
ask for weight. Remove any synthetic database rows created by this check.

---

## Deferred Central-Router Work

This plan intentionally stops after Phase 0 is healthy. Phase 1 shadow routing is a
separate implementation plan because it changes the parser contract, prompt, context
loading and production telemetry, and therefore has a larger verification and
rollback surface.

