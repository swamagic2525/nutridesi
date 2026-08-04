# Cross-Midnight Correction Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let natural corrections and narrow bare undo reach the immediately preceding log batch for six hours across IST midnight without making daily item numbers ambiguous.

**Architecture:** Change only `lastLogBatch()` from a current-date query to a bounded rolling-time query. Atomic replacement already derives the replacement date from the locked original; server replies will use that original date to label previous-day totals honestly, while all explicit item-number helpers remain current-day scoped.

**Tech Stack:** Node.js, CommonJS, Supabase query builder, built-in `assert`, behavioural routing stubs.

---

### Task 1: Add a failing database-window regression

**Files:**
- Create: `test/cross-midnight-correction-test.js`
- Modify: `package.json`

- [ ] **Step 1: Write a fake Supabase client and fixed midnight case**

Create a test that calls `lastLogBatch(phone, now, client)` at
`2026-08-03T19:03:00.000Z` (12:33 AM IST) with a latest row logged at
`2026-08-03T18:03:00.000Z` (11:33 PM IST). Assert the query:

```js
assert.deepStrictEqual(filters, [
  ["eq", "phone_number", "+000000000099"],
  ["gte", "logged_at", "2026-08-03T13:03:00.000Z"],
  ["lte", "logged_at", "2026-08-03T19:03:00.000Z"],
]);
assert.strictEqual(filters.some(f => f[1] === "date"), false);
assert.deepStrictEqual(rows.map(r => r.id), [91]);
```

The fake chain implements `select`, `eq`, `gte`, `lte`, `order`, and `limit`;
`limit` resolves `{ data: fixtureRows, error: null }`. Before requiring `src/db.js`,
replace `@supabase/supabase-js` in `require.cache` with a `createClient()` that
returns this fake client. This keeps the initial failing test offline even though
the current function ignores the not-yet-added injected-client argument.

- [ ] **Step 2: Register the focused test command**

Add to `package.json` scripts:

```json
"test:midnight": "node test/cross-midnight-correction-test.js"
```

- [ ] **Step 3: Run the test and verify failure**

Run `npm run test:midnight`.

Expected: FAIL because current `lastLogBatch` accepts only `phone` and emits an
`.eq("date", today)` filter rather than the rolling `logged_at` window.

### Task 2: Implement the rolling last-batch query

**Files:**
- Modify: `src/db.js:972-985`

- [ ] **Step 1: Make time and client injectable and replace the date filter**

Implement:

```js
async function lastLogBatch(phone, now = new Date(), client = supabase) {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const since = new Date(at.getTime() - WINDOW_MS).toISOString();
  const { data, error } = await client.from("user_logs")
    .select("id, food_name, kcal, protein, quantity, matched_db_id, is_estimate, logged_at, date")
    .eq("phone_number", phone)
    .gte("logged_at", since)
    .lte("logged_at", at.toISOString())
    .order("logged_at", { ascending: false })
    .limit(30);
  if (error) console.error("lastLogBatch select:", error.message);
  if (!data || data.length === 0) return [];
  const lastTs = data[0].logged_at;
  return data.filter(r => r.logged_at === lastTs);
}
```

- [ ] **Step 2: Run the focused test**

Run `npm run test:midnight`.

Expected: PASS.

### Task 3: Add previous-day reply regressions

**Files:**
- Modify: `test/server-routing-test.js`

- [ ] **Step 1: Mark the Kulfi target as yesterday**

Give the existing `kulfiTarget` fixture a synthetic previous-day date and assert
each correction reply contains `Yesterday's updated total` while still reaching
`replaceMealAtomic`.

- [ ] **Step 2: Add a bare-undo previous-day case**

Add a test with `lastLogBatchFixture` containing one previous-day row. Make the
`deleteLastLog` stub return a configurable fixture, then assert bare `undo` calls
`todayTotal(phone, previousDate)` and the reply says `Yesterday's updated total`.

- [ ] **Step 3: Pin item-number scope**

With a previous-day `lastLogBatchFixture` but no current-day item fixtures, send
`item 9`. Assert the response says nothing is logged today and no delete or atomic
replacement runs.

- [ ] **Step 4: Run routing tests and verify the reply assertions fail**

Run `npm run test:routing`.

Expected: FAIL because correction and undo still render the current-day `dayLine()`.

### Task 4: Label previous-day mutations honestly

**Files:**
- Modify: `server.js:317-340`
- Modify: `server.js` undo and final natural-correction branches

- [ ] **Step 1: Add a small date-aware totals formatter**

Add:

```js
const currentIstDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function mutationDayLine(t, profile, targetDate) {
  if (!targetDate || targetDate === currentIstDate()) return dayLine(t, profile);
  return `*Yesterday's updated total: ${Math.round(t.kcal)} kcal · ${Math.round(t.protein)}g protein*`;
}
```

- [ ] **Step 2: Use the original date for bare undo totals and copy**

After deletion, set `const targetDate = deleted[0] && deleted[0].date;`, call
`todayTotal(from, targetDate)`, and render `mutationDayLine(total, profile,
targetDate)`.

- [ ] **Step 3: Use the original date in the final natural-correction reply**

In the scoped `replace_last` branch, render
`mutationDayLine(totals, profile, deleted[0] && deleted[0].date)` before `cfLine`.
Do not alter numbered or bound-state correction targeting.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test:midnight
npm run test:routing
npm run test:memory
npm run test:corrections
```

Expected: all PASS.

### Task 5: Verify, commit, deploy

**Files:**
- No additional code changes expected.

- [ ] **Step 1: Run required regression gates**

Run `npm run test:tdee`, `npm run test:dbshape`, and `node evals/run.js`.

Expected: offline suites PASS and live eval remains 162/162.

- [ ] **Step 2: Scan the complete diff for PII and secrets**

Inspect `git diff --check` and the full patch. Only synthetic `+000` identities may
appear; no raw production message export, real name, `+91` number, ngrok URL, API
key, or AI co-author trailer is permitted.

- [ ] **Step 3: Commit**

```bash
git add package.json src/db.js server.js test/cross-midnight-correction-test.js test/server-routing-test.js
git commit -m "Fix corrections across midnight"
```

- [ ] **Step 4: Merge locally, rerun focused tests, restart and verify**

Fast-forward `main`, rerun `test:midnight`, `test:routing`, and `test:memory`, then:

```bash
launchctl kickstart -k gui/501/com.nutridesi.server
curl --fail --silent --show-error http://127.0.0.1:3000/
```

Expected: launchd reports running, root health returns `NutriDesi is running.`, and
the bounded post-restart error tail is clean.
