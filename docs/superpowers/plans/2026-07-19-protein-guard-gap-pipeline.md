# Match Guards (Protein + Context) + DB-Gap Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the parser from serving confidently-wrong matches: (a) across a protein boundary ("chicken paratha" → veg Paratha (Stuffed), "mutton biryani" → Chicken Biryani), and (b) within a category ("sev puri" → plain Puri, "chole bhature" → Chole, "methi puri" → Puri). Serve suspect foods from the lab-verified INDB reference table instead, and log every DB gap so the developer can promote frequent misses into the curated Tier 1 list.

**Architecture:** Two deterministic post-parse guards run inside `resolveRows()` in `src/db.js` BEFORE nutrition resolution. The **context guard** (`src/contextGuard.js`) enforces that every content word in the user's food phrase is accounted for: a full-phrase alias of another curated food wins outright (silent rematch), disjoint aliases flag a compound, and unexplained leftover words flag the match as suspect — suspects are arbitrated against INDB with positive token evidence required to override. The **protein guard** (`src/proteinGuard.js`) is the hard tripwire underneath: a cross-protein match is nulled unconditionally so the item falls through to the existing Tier 2.5 INDB fallback (`refLookup` → `applyReference`, already live in `src/db.js:188-231`). Every guard trip, suspect, or unmatched food is appended to `evals/db-gaps.jsonl` and triggers a throttled WhatsApp alert to the developer. Promotion to `src/foods.js` + eval cases stays a manual human step — the eval suite must only contain human-verified truth.

**Tech Stack:** Node.js (CommonJS, v24), plain-`assert` test scripts in `test/` run via npm scripts (existing pattern — see `test/correction-context-test.js`), Supabase `match_food` RPC (exists), Twilio WhatsApp alerts (existing pattern in `server.js:540-542`).

## Global Constraints

- CommonJS `require`/`module.exports` everywhere — no ESM (matches every file in `src/`).
- No new npm dependencies. Tests use `assert` + npm scripts, like `test/correction-context-test.js`.
- `evals/db-gaps.jsonl` contains raw user food text → MUST be gitignored.
- Never modify `.env`. No secrets in code — env vars only (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ALERT_PHONE`, `TWILIO_WHATSAPP_FROM`).
- Commits: Swapnil is sole author. Do NOT add any Claude co-author trailer.
- Eval suite must stay 68/68 after every task (`node evals/run.js`). Do not add parser-level eval cases for guard behavior — the guard is deterministic post-parse code, covered by unit tests; the LLM parser is not expected to catch this class.
- Server restart is via `launchctl kickstart -k gui/501/com.nutridesi.server` — never start the server manually.
- Comment style: sparse, only for constraints the code can't show (match existing files).

## Background an implementer must know

- **Pipeline:** WhatsApp message → `handleMessage` (`server.js`) → `parseMeal` (LLM, `src/parser.js`) → `logMeal` → `resolveRows` (`src/db.js:235`) → per-item `resolveItem` → rows inserted into Supabase `user_logs` → reply formatted by `fmtItems` + `assumptionLines` (`server.js:143-162`).
- **`resolveItem` tiers:** matched `matched_db_id` → curated `FOODS` values; unmatched → LLM's `est_kcal` clamped to [20, 800] (default 300), `is_estimate: true`, `assumed: true`, `userSaid` = LLM's `food_name`.
- **Tier 2.5 (already live):** `resolveRows` runs `refLookup(food_name)` (Supabase RPC `match_food` against the 1,014-recipe INDB table) for every row with `matched_db_id: null`, and `applyReference` overwrites the row's nutrition + `food_name` when the hit passes sanity checks. **The guard's only job is to null out bad matches so this existing machinery takes over.**
- **The incident:** user sent "Ate a chicken paratha today" → LLM returned `matched_db_id: 3` (Paratha (Stuffed), veg, 5.5g protein) → user was told 6g protein with a green checkmark. Curated entries for chicken/keema/egg paratha (IDs 183-185) were added on 2026-07-19, so the *specific* food is fixed — this plan fixes the *class*.
- **Row fields stripped before DB insert** (`src/db.js:263`): `stated, userSaid, assumed, portionNote` — new in-memory-only fields must be added to this strip list.

## File Structure

- Create: `src/proteinGuard.js` — pure protein-keyword tripwire, no I/O.
- Create: `test/protein-guard-test.js` — assert-based unit tests.
- Create: `src/contextGuard.js` — pure alias-arbitration + coverage guard, no I/O.
- Create: `test/context-guard-test.js` — assert-based unit tests.
- Create: `src/gapLogger.js` — JSONL append + throttled WhatsApp alert (mirrors `src/correctionLogger.js`).
- Create: `rules/db-gap-pipeline.md` — behavior doc + promotion protocol.
- Modify: `src/db.js` — wire both guards into `resolveRows`, flag INDB rows, suspect arbitration, track gaps, extend insert strip list.
- Modify: `server.js` — reference-verified line in `assumptionLines`.
- Modify: `package.json` — `test:guard` and `test:context` scripts.
- Modify: `.gitignore` — ignore `evals/db-gaps.jsonl`.

---

### Task 1: Protein guard module (pure logic + tests)

**Files:**
- Create: `src/proteinGuard.js`
- Test: `test/protein-guard-test.js`
- Modify: `package.json:12-13` (add script)

**Interfaces:**
- Consumes: `FOOD_BY_ID` from `src/foods.js` (map id → `{ id, name, aliases[], ... }`).
- Produces: `guardItems(items) -> trippedItems[]` — mutates each tripped parsed item in place (`matched_db_id = null`, `match_type = "none"`, `protein_guard = true`) and returns the tripped items. Also exports `extractGroups(text) -> Set<string>` for tests.

- [ ] **Step 1: Write the failing test**

Create `test/protein-guard-test.js`:

```javascript
const assert = require("assert");
const { guardItems, extractGroups } = require("../src/proteinGuard.js");

// --- extractGroups: Hinglish synonyms collapse into one protein group ---
assert.deepStrictEqual([...extractGroups("chicken paratha")], ["chicken"]);
assert.deepStrictEqual([...extractGroups("murgh biryani")], ["chicken"]);
assert.deepStrictEqual([...extractGroups("anda bhurji")], ["egg"]);
assert.deepStrictEqual([...extractGroups("keema pav")], ["keema"]);
assert.deepStrictEqual([...extractGroups("plain dal tadka")], []);
// word boundaries: "eggplant" must NOT read as egg
assert.deepStrictEqual([...extractGroups("eggplant curry")], []);

// --- guardItems: cross-protein matches trip, legitimate matches don't ---
// Incident class: non-veg food matched to a veg DB item (id 3 = Paratha (Stuffed), veg)
let items = [{ food_name: "fish paratha", matched_db_id: 3, quantity: 1 }];
let tripped = guardItems(items);
assert.strictEqual(tripped.length, 1);
assert.strictEqual(items[0].matched_db_id, null);
assert.strictEqual(items[0].match_type, "none");
assert.strictEqual(items[0].protein_guard, true);

// Wrong protein: mutton biryani matched to id 8 = Biryani (Chicken)
items = [{ food_name: "mutton biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);
assert.strictEqual(items[0].matched_db_id, null);

// Correct protein match: no trip
items = [{ food_name: "chicken biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);
assert.strictEqual(items[0].matched_db_id, 8);

// Hinglish synonym on both sides: murgh == chicken, no trip
items = [{ food_name: "murgh biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);

// Veg food matched to veg item: no protein words anywhere, no trip
items = [{ food_name: "aloo paratha", matched_db_id: 3, quantity: 2 }];
assert.strictEqual(guardItems(items).length, 0);

// Veg-default policy (2026-07-19): bare "biryani" is an alias of Biryani (Veg)
// id 9, NOT of Chicken Biryani. Matched to 9 -> no trip; matched to 8 -> the
// reverse rule trips it (no alias of 8 appears in the user's words).
items = [{ food_name: "biryani", matched_db_id: 9, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);
items = [{ food_name: "biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);
assert.strictEqual(items[0].matched_db_id, null);

// Deliberate non-veg default kept by alias containment: bare "bhurji" IS an
// alias of Egg Bhurji (150), so no trip
items = [{ food_name: "bhurji", matched_db_id: 150, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);

// Explicit veg words clash with a non-veg DB item
items = [{ food_name: "veg biryani", matched_db_id: 8, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);

// Reverse direction: bare "paratha" wrongly matched to id 183 = Chicken Paratha
// (no alias of 183 appears in the user's words) -> trip
items = [{ food_name: "paratha", matched_db_id: 183, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 1);

// Correct curated non-veg match survives: chicken paratha -> id 183
items = [{ food_name: "chicken paratha", matched_db_id: 183, quantity: 1 }];
assert.strictEqual(guardItems(items).length, 0);

// Safety: null food_name (correction flows) and unmatched items are skipped
items = [
  { food_name: null, matched_db_id: 68, quantity: 1 },
  { food_name: "random unknown", matched_db_id: null, quantity: 1 },
];
assert.strictEqual(guardItems(items).length, 0);
assert.strictEqual(items[0].matched_db_id, 68);

// Multi-item: only the offending item trips
items = [
  { food_name: "2 roti", matched_db_id: 1, quantity: 2 },
  { food_name: "prawn curry", matched_db_id: 24, quantity: 1 }, // 24 = Chicken Curry
];
tripped = guardItems(items);
assert.strictEqual(tripped.length, 1);
assert.strictEqual(items[0].matched_db_id, 1);
assert.strictEqual(items[1].matched_db_id, null);

console.log("protein-guard-test: all passed");
```

- [ ] **Step 2: Add the npm script and run the test to verify it fails**

In `package.json`, after the `"test:metrics"` line, add:

```json
    "test:guard": "node test/protein-guard-test.js"
```

Run: `npm run test:guard`
Expected: FAIL with `Cannot find module '../src/proteinGuard.js'`

- [ ] **Step 3: Write the implementation**

Create `src/proteinGuard.js`:

```javascript
// Deterministic post-parse guard: the LLM must never match a food across a
// protein boundary ("chicken paratha" -> veg Paratha (Stuffed)). Runs before
// nutrition resolution; a tripped item falls through to the INDB reference
// lookup (Tier 2.5) instead of the wrong curated entry.
const { FOOD_BY_ID } = require("./foods.js");

// Hinglish synonyms collapse into one group so "murgh" == "chicken".
const PROTEIN_GROUPS = {
  chicken: ["chicken", "murgh", "murg"],
  mutton: ["mutton", "gosht", "lamb"],
  keema: ["keema", "qeema", "kheema", "mince"],
  egg: ["egg", "eggs", "anda", "ande", "anday", "omelette", "omelet"],
  fish: ["fish", "machli", "machhi", "surmai", "pomfret", "bangda"],
  prawn: ["prawn", "prawns", "jhinga", "shrimp"],
  beef: ["beef"],
  pork: ["pork", "bacon", "ham"],
};

function extractGroups(text) {
  const t = String(text || "").toLowerCase();
  const found = new Set();
  for (const [group, words] of Object.entries(PROTEIN_GROUPS)) {
    if (words.some(w => new RegExp(`\\b${w}\\b`).test(t))) found.add(group);
  }
  return found;
}

const saysVeg = (text) => /\b(veg|vegetarian|shakahari)\b/i.test(String(text || ""));

function guardItems(items) {
  const tripped = [];
  for (const it of items || []) {
    if (!it.matched_db_id || !it.food_name) continue;
    const food = FOOD_BY_ID[it.matched_db_id];
    if (!food) continue;
    const t = String(it.food_name).toLowerCase();
    const u = extractGroups(t);
    const f = extractGroups(`${food.name} ${food.aliases.join(" ")}`);
    // User named a protein the matched food doesn't have (mutton -> chicken item,
    // fish -> veg item), or explicitly said veg against a non-veg item.
    const mismatch = [...u].some(g => !f.has(g));
    const vegClash = saysVeg(t) && f.size > 0;
    // Reverse: matched a non-veg item the user never asked for, and no alias of
    // that item appears in their words. Alias containment keeps deliberate
    // defaults alive ("bhurji" -> Egg Bhurji is an alias, so no trip). Bare
    // category words otherwise default to the VEG variant via the alias map
    // ("biryani" is an alias of Biryani (Veg), not Chicken Biryani).
    const reverseClash = u.size === 0 && !saysVeg(t) && f.size > 0
      && !food.aliases.some(a => t.includes(a));
    if (mismatch || vegClash || reverseClash) {
      it.matched_db_id = null;
      it.match_type = "none";
      it.protein_guard = true;
      tripped.push(it);
    }
  }
  return tripped;
}

module.exports = { guardItems, extractGroups };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:guard`
Expected: `protein-guard-test: all passed`

Also run the existing suites to confirm nothing broke:
Run: `npm run test:corrections && npm run test:metrics`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/proteinGuard.js test/protein-guard-test.js package.json
git commit -m "Add deterministic protein guard: reject cross-protein food matches"
```

---

### Task 2: Gap logger (JSONL + throttled WhatsApp alert)

**Files:**
- Create: `src/gapLogger.js`
- Modify: `.gitignore` (add one line)

**Interfaces:**
- Consumes: env vars `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ALERT_PHONE`, `TWILIO_WHATSAPP_FROM` (all already set in `.env` — do not touch `.env`).
- Produces: `logGapEvent({ food, reason, source, served_as, kcal })` — fire-and-forget, never throws. `reason` is `"protein_guard" | "compound" | "coverage" | "no_match"`; `source` is `"indb" | "estimate" | "curated_kept"`.

- [ ] **Step 1: Write the implementation** (no unit test — the module is I/O only and mirrors the accepted `src/correctionLogger.js` pattern; it is exercised end-to-end in Task 4)

Create `src/gapLogger.js`:

```javascript
// Every food the curated DB couldn't serve is a candidate for Tier 1 promotion.
// Appends to evals/db-gaps.jsonl (gitignored - raw user text) and alerts the
// developer on WhatsApp, throttled to one alert per food per day.
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "evals", "db-gaps.jsonl");

const alerted = new Map(); // food (lowercase) -> YYYY-MM-DD last alerted

function logGapEvent({ food, reason, source, served_as, kcal }) {
  const entry = { ts: new Date().toISOString(), food, reason, source, served_as, kcal };
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch (_) {}
  try { maybeAlert(entry); } catch (_) {}
}

function maybeAlert(entry) {
  const key = String(entry.food).toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  if (alerted.get(key) === today) return;
  alerted.set(key, today);
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const to = process.env.ALERT_PHONE;
  if (!sid || !tok || !to) return;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || "+14155238886"}`;
  const body = entry.source === "indb"
    ? `\u{1F50D} DB gap: "${entry.food}" served from INDB as "${entry.served_as}" (${entry.kcal} kcal, ${entry.reason}). Review evals/db-gaps.jsonl to promote to Tier 1.`
    : entry.source === "curated_kept"
      ? `\u{1F914} DB gap: "${entry.food}" kept on curated "${entry.served_as}" (${entry.kcal} kcal, ${entry.reason}) - no better INDB hit. Check whether a new curated entry is needed.`
      : `\u{26A0}\u{FE0F} DB gap: "${entry.food}" served as LLM estimate (${entry.kcal} kcal, ${entry.reason}). No INDB hit - consider adding to foods.js.`;
  require("twilio")(sid, tok).messages.create({ from, to: `whatsapp:${to}`, body })
    .catch(err => console.error("gap alert failed:", err.message));
}

module.exports = { logGapEvent };
```

- [ ] **Step 2: Gitignore the log**

In `.gitignore`, directly below the existing `evals/correction-log.jsonl` line, add:

```
evals/db-gaps.jsonl
```

- [ ] **Step 3: Smoke-test the append path (not the alert)**

Run:
```bash
node -e "
process.env.ALERT_PHONE=''; // suppress the WhatsApp send for this smoke test
const { logGapEvent } = require('./src/gapLogger.js');
logGapEvent({ food: 'smoke test', reason: 'no_match', source: 'estimate', served_as: 'smoke test', kcal: 300 });
const fs = require('fs');
const lines = fs.readFileSync('evals/db-gaps.jsonl', 'utf8').trim().split('\n');
const last = JSON.parse(lines[lines.length - 1]);
if (last.food !== 'smoke test' || last.source !== 'estimate') throw new Error('bad entry: ' + JSON.stringify(last));
console.log('gapLogger smoke test passed');
"
```
Expected: `gapLogger smoke test passed`

Then remove the smoke entry so real data stays clean:
```bash
grep -v '"food":"smoke test"' evals/db-gaps.jsonl > /tmp/g && mv /tmp/g evals/db-gaps.jsonl || rm -f evals/db-gaps.jsonl
```

- [ ] **Step 4: Verify git sees no log file**

Run: `git status --short | grep db-gaps`
Expected: no output (file is ignored).

- [ ] **Step 5: Commit**

```bash
git add src/gapLogger.js .gitignore
git commit -m "Add DB-gap logger: JSONL trail plus daily-throttled WhatsApp alert"
```

---

### Task 3: Wire guard + gap tracking + INDB flag into db.js

**Files:**
- Modify: `src/db.js` (four edits: imports, `applyReference`, `resolveRows`, `logMeal` insert strip + call site)

**Interfaces:**
- Consumes: `guardItems` (Task 1), `logGapEvent` (Task 2).
- Produces: rows out of `resolveRows` may now carry `refVerified: true` (INDB values applied) — `server.js` reads this in Task 4. `resolveRows(parsed, opts)` gains an optional second arg `{ trackGaps: boolean }`; only `logMeal` passes `true` (query previews must not fire alerts).

- [ ] **Step 1: Add imports**

In `src/db.js`, the top currently reads:

```javascript
const { createClient } = require("@supabase/supabase-js");
const { FOOD_BY_ID } = require("./foods.js");
const { matchRows } = require("./correctionContext.js");
```

Add after those lines:

```javascript
const { guardItems } = require("./proteinGuard.js");
const { logGapEvent } = require("./gapLogger.js");
```

- [ ] **Step 2: Flag INDB-sourced rows in `applyReference`**

At the end of `applyReference` (currently `src/db.js:199-231`), the final assignments read:

```javascript
  row.kcal = Math.round(perServing * qty);
  row.protein = +(p * qty).toFixed(1);
  row.carbs = +(c * qty).toFixed(1);
  row.fat = +(f * qty).toFixed(1);
  row.fiber = +(fb * qty).toFixed(1);
  row.unit = unit;
  row.food_name = ref.food_name;
```

Add one line after `row.food_name = ref.food_name;`:

```javascript
  row.refVerified = true;
```

- [ ] **Step 3: Rewrite `resolveRows`**

Replace the current function (`src/db.js:235-245`):

```javascript
async function resolveRows(parsed) {
  const rows = (parsed.items || []).map(it => resolveItem(it));
  // Cross-reference unmatched foods against INDB (parallel, misses only).
  await Promise.all(rows
    .filter(r => !r.matched_db_id && !r.stated && r.food_name && r.food_name !== "meal")
    .map(async r => {
      const ref = await refLookup(r.food_name);
      if (ref) applyReference(r, ref);
    }));
  return rows;
}
```

with:

```javascript
async function resolveRows(parsed, opts = {}) {
  const items = parsed.items || [];
  // Deterministic protein guard first: a cross-protein match ("chicken paratha"
  // -> veg paratha) is nulled here so it takes the INDB path below instead.
  guardItems(items);
  const rows = items.map(it => resolveItem(it));
  // Cross-reference unmatched foods against INDB (parallel, misses only).
  await Promise.all(rows
    .filter(r => !r.matched_db_id && !r.stated && r.food_name && r.food_name !== "meal")
    .map(async r => {
      const ref = await refLookup(r.food_name);
      if (ref) applyReference(r, ref);
    }));
  // Gap trail: only when actually logging (not query previews). rows[i] maps 1:1 to items[i].
  if (opts.trackGaps) {
    rows.forEach((r, i) => {
      const it = items[i];
      if (!it || !it.food_name || r.matched_db_id || r.stated || r.food_name === "meal") return;
      logGapEvent({
        food: it.food_name,
        reason: it.protein_guard ? "protein_guard" : "no_match",
        source: r.refVerified ? "indb" : "estimate",
        served_as: r.food_name,
        kcal: r.kcal,
      });
    });
  }
  return rows;
}
```

- [ ] **Step 4: Pass `trackGaps` from `logMeal` and strip the new field before insert**

In `logMeal` (`src/db.js:247-265`), change the `resolveRows(parsed)` call inside `Promise.all`:

```javascript
  const [prevTotal, isNewUser, rows] = await Promise.all([todayTotal(phone), ensureUser(phone), resolveRows(parsed)]);
```

to:

```javascript
  const [prevTotal, isNewUser, rows] = await Promise.all([todayTotal(phone), ensureUser(phone), resolveRows(parsed, { trackGaps: true })]);
```

And change the insert strip list:

```javascript
  supabase.from("user_logs").insert(rows.map(({ stated, userSaid, assumed, portionNote, ...r }) => r)).then(({ error }) => {
```

to:

```javascript
  supabase.from("user_logs").insert(rows.map(({ stated, userSaid, assumed, portionNote, refVerified, ...r }) => r)).then(({ error }) => {
```

- [ ] **Step 5: Verify with a live resolveRows call (reads only — resolveRows never writes)**

Run:
```bash
node -e "
process.env.ALERT_PHONE=''; // no alert spam during verification
const { resolveRows } = require('./src/db.js');
(async () => {
  // Simulate the incident: LLM force-matched a non-veg food to veg id 3.
  const parsed = { items: [{ food_name: 'mutton paratha', matched_db_id: 3, quantity: 1, match_type: 'direct' }] };
  const rows = await resolveRows(parsed, { trackGaps: true });
  console.log(JSON.stringify(rows[0], null, 2));
  if (rows[0].matched_db_id !== null && rows[0].matched_db_id !== undefined) {
    // guard must have nulled the curated match
    if (rows[0].matched_db_id === 3) throw new Error('GUARD DID NOT TRIP');
  }
  if (rows[0].protein <= 6) console.log('NOTE: low protein - check whether INDB hit or estimate path served this');
  process.exit(0);
})();
"
```
Expected: printed row has `matched_db_id: null`, `is_estimate: true`, and EITHER `refVerified: true` with INDB nutrition (if INDB has a mutton/keema paratha recipe) OR estimate nutrition (300 kcal default — acceptable, the guard still prevented the 5.5g-protein veg answer). `evals/db-gaps.jsonl` gains one entry with `"reason":"protein_guard"`.

Clean the verification entry:
```bash
grep -v '"food":"mutton paratha"' evals/db-gaps.jsonl > /tmp/g && mv /tmp/g evals/db-gaps.jsonl || rm -f evals/db-gaps.jsonl
```

- [ ] **Step 6: Run all suites**

Run: `npm run test:guard && npm run test:corrections && npm run test:metrics && node evals/run.js`
Expected: unit suites pass; eval suite 68/68 perfect (the guard only ever nulls a *wrong* curated match; correct matches like "chicken biryani" → 8 are untouched, so no eval case changes).

- [ ] **Step 7: Commit**

```bash
git add src/db.js
git commit -m "Wire protein guard and gap tracking into nutrition resolution"
```

---

### Task 4: Transparent reply copy + end-to-end verification

**Files:**
- Modify: `server.js:152-162` (`assumptionLines`)

**Interfaces:**
- Consumes: `r.refVerified` on rows returned from `logMeal` (Task 3). (In-memory rows keep the field; only the DB insert strips it.)

- [ ] **Step 1: Add the reference-verified branch to `assumptionLines`**

Current code (`server.js:152-162`):

```javascript
function assumptionLines(rows) {
  const guesses = rows.filter(r => r.assumed && r.userSaid
    // A DB match whose name already covers what the user said needs no confession.
    && !(r.matched_db_id && r.food_name.toLowerCase().includes(String(r.userSaid).toLowerCase())));
  const lines = guesses.slice(0, 2).map(r =>
    r.matched_db_id
      ? `\u{1F914} _"${r.userSaid}" — logged the closest match, *${r.food_name}*. Something else? Just reply "it was …"_`
      : `\u{1F914} _"${r.userSaid}" isn't in my book yet — logged my best estimate. Know the calories? Reply "it was 200 calories"_`);
  if (guesses.length > 2) lines.push(`_…and ${guesses.length - 2} more guesses in the list below_`);
  return lines;
}
```

Replace the ternary so INDB-served rows get their own honest line:

```javascript
function assumptionLines(rows) {
  const guesses = rows.filter(r => r.assumed && r.userSaid
    // A DB match whose name already covers what the user said needs no confession.
    && !(r.matched_db_id && r.food_name.toLowerCase().includes(String(r.userSaid).toLowerCase())));
  const lines = guesses.slice(0, 2).map(r =>
    r.matched_db_id
      ? `\u{1F914} _"${r.userSaid}" — logged the closest match, *${r.food_name}*. Something else? Just reply "it was …"_`
      : r.refVerified
        ? `\u{1F52C} _"${r.userSaid}" isn't in my quick list — logged *${r.food_name}* from a lab-verified recipe database. Something else? Just reply "it was …"_`
        : `\u{1F914} _"${r.userSaid}" isn't in my book yet — logged my best estimate. Know the calories? Reply "it was 200 calories"_`);
  if (guesses.length > 2) lines.push(`_…and ${guesses.length - 2} more guesses in the list below_`);
  return lines;
}
```

- [ ] **Step 2: Restart the server**

Run: `launchctl kickstart -k gui/501/com.nutridesi.server && sleep 3 && curl -s http://localhost:3000/`
Expected: `NutriDesi is running.`

- [ ] **Step 3: End-to-end test through the real webhook with a test number**

Test numbers (`+000...`) are excluded from all metrics. The `/whatsapp` route has no signature validation, so curl works:

```bash
curl -s -X POST http://localhost:3000/whatsapp \
  --data-urlencode "From=whatsapp:+0000000099" \
  --data-urlencode "Body=mutton biryani khaya" \
  --data-urlencode "MessageSid=SMtest-guard-e2e-1"
```

Expected: TwiML reply where the biryani line is NOT `Biryani (Chicken)` at 450 kcal / 25g protein from curated id 8. Instead either an INDB mutton biryani (with the `\u{1F52C}` lab-verified line) or an estimate line. Also check:

```bash
tail -1 evals/db-gaps.jsonl
```
Expected: entry with `"food":"mutton biryani"` (or the LLM's phrasing), `"reason":"protein_guard"` (if the LLM matched id 8) or `"no_match"` (if the LLM returned null itself). Either is a pass — the guard is the net, not the first line.

A WhatsApp gap alert should also arrive on Swapnil's phone (ALERT_PHONE) — this is the intended behavior, not spam: it's the developer-highlight step of the pipeline.

- [ ] **Step 4: Clean up the test log rows**

The e2e test wrote real rows for the test number. Delete them:

```bash
node -e "
const { supabase } = require('./src/db.js');
(async () => {
  const { error } = await supabase.from('user_logs').delete().eq('phone_number', '+0000000099');
  console.log(error ? 'delete failed: ' + error.message : 'test rows cleaned');
  process.exit(0);
})();
"
```
Expected: `test rows cleaned`

- [ ] **Step 5: Full suite once more**

Run: `npm run test:guard && npm run test:corrections && npm run test:metrics && node evals/run.js`
Expected: all pass, evals 68/68.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "Show lab-verified reference source in reply for INDB-served foods"
```

---

### Task 5: Context guard — alias arbitration, compound detection, coverage check

The protein guard (Task 1) only catches cross-protein mistakes. This guard catches the general class: within-category confusion where the user's phrase contains words the matched food can't account for — "sev puri" logged as plain Puri (110 kcal vs 320), "chole bhature" as Chole, "methi puri" as Puri. Rule of thumb: **every content word in the food phrase must be explained by the match.**

**Files:**
- Create: `src/contextGuard.js`
- Test: `test/context-guard-test.js`
- Modify: `src/db.js` (imports, `applyReference` opts, `resolveRows` — replaces the Task 3 version)
- Modify: `package.json` (add script)

**Interfaces:**
- Consumes: `FOODS`, `FOOD_BY_ID` from `src/foods.js`; `refLookup`/`applyReference` internals of `src/db.js`; `logGapEvent` (Task 2); `guardItems` (Task 1).
- Produces: `contextGuard(items)` — mutates parsed items in place: sets `alias_arbitrated: true` + rematched `matched_db_id` (rung 1), `compound_suspect: true` (rung 2), or `coverage_suspect: string[]` of leftover words (rung 3). Also exports `contentTokens(text) -> string[]` and `FILLER` (Set) — `resolveRows` uses `contentTokens` for INDB evidence checks. `applyReference(row, ref, opts)` gains `{ trusted: boolean }` to skip the 2x ratio check when token evidence exists.

- [ ] **Step 1: Write the failing test**

Create `test/context-guard-test.js`:

```javascript
const assert = require("assert");
const { contextGuard, contentTokens } = require("../src/contextGuard.js");

// contentTokens strips filler words and bare numbers
assert.deepStrictEqual(contentTokens("2 garam roti"), ["roti"]);
assert.deepStrictEqual(contentTokens("ghar ka methi puri"), ["methi", "puri"]);

// --- Rung 1: a full-phrase alias of another curated food wins (silent rematch) ---
let items = [{ food_name: "sev puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 61); // Sev Puri, not plain Puri
assert.strictEqual(items[0].alias_arbitrated, true);

items = [{ food_name: "pani puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 60);

items = [{ food_name: "chole bhature", matched_db_id: 19, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 67);

// The original incident, now fixed deterministically (183 = curated Chicken Paratha)
items = [{ food_name: "chicken paratha", matched_db_id: 3, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 183);

// Correct match is a no-op
items = [{ food_name: "sev puri", matched_db_id: 61, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 61);
assert.strictEqual(items[0].alias_arbitrated, undefined);

// Multi-word alias of the matched food itself - no rematch, no flags
items = [{ food_name: "puri bhaji", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 4);
assert.strictEqual(items[0].compound_suspect, undefined);
assert.strictEqual(items[0].coverage_suspect, undefined);

// Word-order variant covered by an alias stays quiet ("makhani dal" is an alias of 18)
items = [{ food_name: "makhani dal", matched_db_id: 18, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 18);
assert.strictEqual(items[0].coverage_suspect, undefined);

// --- Rung 2: two disjoint aliases = compound dish - flag, don't guess which half wins ---
items = [{ food_name: "chole puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 4); // untouched until INDB evidence
assert.strictEqual(items[0].compound_suspect, true);

// --- Rung 3: leftover content word the matched food's corpus can't explain ---
items = [{ food_name: "methi puri", matched_db_id: 4, quantity: 1 }];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 4); // untouched until INDB evidence
assert.deepStrictEqual(items[0].coverage_suspect, ["methi"]);

// Filler never trips coverage
items = [{ food_name: "garam roti", matched_db_id: 1, quantity: 2 }];
contextGuard(items);
assert.strictEqual(items[0].coverage_suspect, undefined);

// Unmatched and null-name items are skipped entirely
items = [
  { food_name: null, matched_db_id: 68, quantity: 1 },
  { food_name: "mystery dish", matched_db_id: null, quantity: 1 },
];
contextGuard(items);
assert.strictEqual(items[0].matched_db_id, 68);
assert.strictEqual(items[1].coverage_suspect, undefined);

console.log("context-guard-test: all passed");
```

- [ ] **Step 2: Add the npm script and run the test to verify it fails**

In `package.json`, after the `"test:guard"` line, add:

```json
    "test:context": "node test/context-guard-test.js"
```

Run: `npm run test:context`
Expected: FAIL with `Cannot find module '../src/contextGuard.js'`

- [ ] **Step 3: Write the implementation**

Create `src/contextGuard.js`:

```javascript
// Context guard: every content word in the user's food phrase must be
// explained by the matched curated entry. Catches within-category wrong-ID
// picks the protein guard can't see ("sev puri" logged as plain Puri).
// Three outcomes, checked in order per item:
//   alias_arbitrated - one alias of ANOTHER food covers the whole phrase;
//                      exact alias evidence beats the LLM's pick, rematch.
//   compound_suspect - the phrase splits into two disjoint aliases
//                      ("chole puri") - don't guess which half wins,
//                      let INDB arbitrate in resolveRows.
//   coverage_suspect - leftover content words the matched food's
//                      name+aliases don't contain ("methi puri" on Puri) -
//                      let INDB arbitrate in resolveRows.
const { FOODS, FOOD_BY_ID } = require("./foods.js");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (p) => new RegExp(`\\b${esc(p)}\\b`);
const hasWord = (text, phrase) => wordRe(phrase).test(text);

// Longest alias first so "sev puri" beats "puri".
const ALIASES = FOODS.flatMap(f => f.aliases.map(a => ({ a: a.toLowerCase(), id: f.id })))
  .sort((x, y) => y.a.length - x.a.length);

// Words that carry no dish identity: grammar glue, cooking adjectives,
// quantity words, serving units. Anything NOT here is treated as identity.
const FILLER = new Set([
  "ka", "ki", "ke", "wala", "wali", "with", "and", "aur", "of", "the", "a", "an",
  "hot", "cold", "fresh", "garam", "thoda", "thodi", "sa", "si", "plain", "simple",
  "homemade", "ghar", "normal", "small", "big", "chota", "bada",
  "ek", "one", "two", "do", "teen", "three", "half", "adha",
  "bowl", "katori", "plate", "glass", "piece", "pieces", "cup", "slice",
]);

const contentTokens = (text) => String(text || "").toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(w => w && !FILLER.has(w) && !/^\d+$/.test(w));

function contextGuard(items) {
  for (const it of items || []) {
    if (!it.matched_db_id || !it.food_name) continue;
    const food = FOOD_BY_ID[it.matched_db_id];
    if (!food) continue;
    const t = String(it.food_name).toLowerCase();
    const best = ALIASES.find(({ a }) => hasWord(t, a));
    if (best) {
      const remTokens = contentTokens(t.replace(wordRe(best.a), " "));
      if (remTokens.length === 0) {
        // One alias explains the whole phrase - it IS the identity.
        if (best.id !== it.matched_db_id) {
          it.matched_db_id = best.id;
          it.alias_arbitrated = true;
        }
        continue;
      }
      if (ALIASES.some(({ a }) => hasWord(remTokens.join(" "), a))) {
        it.compound_suspect = true;
        continue;
      }
    }
    // Leftovers vs the matched food's whole corpus - word-order variants of a
    // correct match ("makhani dal" on Dal Makhani) stay quiet.
    const corpus = `${food.name} ${food.aliases.join(" ")}`.toLowerCase();
    const leftover = contentTokens(t).filter(w => !corpus.includes(w));
    if (leftover.length) it.coverage_suspect = leftover;
  }
  return items;
}

module.exports = { contextGuard, contentTokens, FILLER };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:context`
Expected: `context-guard-test: all passed`

- [ ] **Step 5: Wire into db.js — imports and `applyReference` opts**

In `src/db.js`, extend the imports added in Task 3:

```javascript
const { guardItems } = require("./proteinGuard.js");
const { contextGuard, contentTokens } = require("./contextGuard.js");
const { logGapEvent } = require("./gapLogger.js");
```

Change the `applyReference` signature (currently `function applyReference(row, ref) {`) to:

```javascript
function applyReference(row, ref, opts = {}) {
```

and wrap its existing ratio sanity check:

```javascript
  const llmPerServing = row.kcal / qty;
  if (llmPerServing > 0 && (perServing > llmPerServing * 2 || perServing < llmPerServing * 0.5)) return;
```

with:

```javascript
  if (!opts.trusted) {
    const llmPerServing = row.kcal / qty;
    if (llmPerServing > 0 && (perServing > llmPerServing * 2 || perServing < llmPerServing * 0.5)) return;
  }
```

(The trusted path exists because a suspect override compares INDB against the WRONG curated value — "sev puri" 320/plate vs plain Puri 110/piece is a 2.9x ratio that the untrusted check would falsely reject. Token evidence replaces the ratio check there.)

- [ ] **Step 6: Replace `resolveRows` (supersedes the Task 3 version)**

```javascript
async function resolveRows(parsed, opts = {}) {
  const items = parsed.items || [];
  // Deterministic nets before nutrition resolution (order matters): the context
  // guard may rematch or flag; the protein guard then nulls cross-protein
  // matches outright so they take the INDB path below.
  contextGuard(items);
  guardItems(items);
  const rows = items.map(it => resolveItem(it));
  // Cross-reference unmatched foods against INDB (parallel, misses only).
  await Promise.all(rows
    .filter(r => !r.matched_db_id && !r.stated && r.food_name && r.food_name !== "meal")
    .map(async r => {
      const ref = await refLookup(r.food_name);
      if (ref) applyReference(r, ref);
    }));
  // Suspect arbitration: a still-matched compound/coverage suspect asks INDB for
  // the full phrase. Only positive evidence - every content word present in the
  // INDB recipe name - overrides the curated value; otherwise curated stands.
  await Promise.all(rows.map(async (r, i) => {
    const it = items[i];
    if (!it || !r.matched_db_id || !(it.compound_suspect || it.coverage_suspect)) return;
    const ref = await refLookup(it.food_name);
    if (!ref) return;
    const refName = String(ref.food_name || "").toLowerCase();
    const tokens = contentTokens(it.food_name);
    if (!tokens.length || !tokens.every(w => refName.includes(w))) return;
    r.matched_db_id = null;
    r.is_estimate = true;
    r.assumed = true;
    applyReference(r, ref, { trusted: true });
  }));
  // Gap trail: only when actually logging (not query previews). rows[i] maps
  // 1:1 to items[i]. Silent alias rematches are correct outcomes - not logged.
  if (opts.trackGaps) {
    rows.forEach((r, i) => {
      const it = items[i];
      if (!it || !it.food_name || r.stated || r.food_name === "meal") return;
      const reason = it.protein_guard ? "protein_guard"
        : it.compound_suspect ? "compound"
        : it.coverage_suspect ? "coverage"
        : !r.matched_db_id ? "no_match" : null;
      if (!reason) return;
      const source = !r.matched_db_id ? (r.refVerified ? "indb" : "estimate") : "curated_kept";
      logGapEvent({ food: it.food_name, reason, source, served_as: r.food_name, kcal: r.kcal });
    });
  }
  return rows;
}
```

- [ ] **Step 7: Verify live through resolveRows (reads only, no writes)**

Run:
```bash
node -e "
process.env.ALERT_PHONE='';
const { resolveRows } = require('./src/db.js');
(async () => {
  // Wrong-ID pick between curated items: must silently rematch to Sev Puri (61).
  let rows = await resolveRows({ items: [{ food_name: 'sev puri', matched_db_id: 4, quantity: 1, match_type: 'direct' }] });
  console.log('sev puri ->', rows[0].food_name, rows[0].kcal, 'kcal, id', rows[0].matched_db_id);
  if (rows[0].matched_db_id !== 61) throw new Error('ARBITRATION FAILED');
  if (rows[0].kcal !== 320) throw new Error('WRONG KCAL: ' + rows[0].kcal);
  // Compound: chole puri - INDB override (matched null + refVerified) or curated kept + gap.
  rows = await resolveRows({ items: [{ food_name: 'chole puri', matched_db_id: 4, quantity: 1, match_type: 'direct' }] }, { trackGaps: true });
  console.log('chole puri ->', rows[0].food_name, rows[0].kcal, 'kcal, refVerified:', !!rows[0].refVerified);
  process.exit(0);
})();
"
```
Expected: `sev puri -> Sev Puri 320 kcal, id 61`; for chole puri, EITHER an INDB recipe name with `refVerified: true` OR `Puri 110 kcal` kept with a `"reason":"compound","source":"curated_kept"` entry in `evals/db-gaps.jsonl`. Both are passes — the developer alert closes the loop.

Clean the verification entry if one was written:
```bash
grep -v '"food":"chole puri"' evals/db-gaps.jsonl > /tmp/g && mv /tmp/g evals/db-gaps.jsonl || rm -f evals/db-gaps.jsonl
```

- [ ] **Step 8: Run all suites**

Run: `npm run test:guard && npm run test:context && npm run test:corrections && npm run test:metrics && node evals/run.js`
Expected: all unit suites pass; evals 68/68 (guards live in resolveRows, downstream of the parser the evals exercise — arbitration only ever moves a match to a MORE specific alias, so correct parser output is untouched).

- [ ] **Step 9: Restart server and commit**

```bash
launchctl kickstart -k gui/501/com.nutridesi.server
git add src/contextGuard.js test/context-guard-test.js src/db.js package.json
git commit -m "Add context guard: alias arbitration, compound detection, coverage check"
```

---

### Task 6: Behavior doc + promotion protocol

**Files:**
- Create: `rules/db-gap-pipeline.md`

- [ ] **Step 1: Write the doc**

Create `rules/db-gap-pipeline.md`:

```markdown
# DB-Gap Pipeline — Match Guards, INDB Fallback, Promotion Protocol

**Owner files:** `src/contextGuard.js`, `src/proteinGuard.js`, `src/gapLogger.js`, `src/db.js` (`resolveRows`)
**Log:** `evals/db-gaps.jsonl` (gitignored — raw user text)

## The class of bug this kills

2026-07-19 incident: "chicken paratha" was force-matched to Paratha (Stuffed)
(veg, 5.5g protein) and presented with a green checkmark. Reported by mentor
(Malay) — the user should never carry the onus of catching an absurd match.
The same class exists WITHIN a category: "sev puri" logged as plain Puri
(110 kcal vs 320), "chole bhature" as Chole. Governing rule: **every content
word in the user's food phrase must be explained by the match.**

## Pipeline (runs inside resolveRows, every log)

1. **Context guard (deterministic, ~0ms).** For every parsed item with a
   curated match, three rungs in order:
   - *Alias arbitration:* if one alias of a DIFFERENT curated food covers the
     whole phrase, exact alias evidence beats the LLM's pick — silent rematch
     ("sev puri" on Puri -> Sev Puri). Correct outcome, not gap-logged.
   - *Compound detection:* phrase splits into two disjoint aliases
     ("chole puri" = "chole" + "puri") — flagged, never guessed; INDB
     arbitrates in step 3.
   - *Coverage check:* leftover content words (after filler like garam/ghar-ka)
     that the matched food's name+aliases don't contain ("methi puri" on
     Puri) — flagged; INDB arbitrates in step 3. Word-order variants of a
     correct match ("makhani dal" on Dal Makhani) stay quiet because the check
     runs against the food's whole alias corpus.
2. **Protein guard (deterministic, ~0ms, hard tripwire).** Compare
   protein-group keywords (chicken/murgh, mutton/gosht, keema, egg/anda,
   fish/machli, prawn/jhinga, beef, pork — Hinglish synonyms collapse into one
   group) in the user's words vs the matched food's name+aliases. Trip on:
   (a) user named a protein the food lacks, (b) user said veg/vegetarian but
   food is non-veg, (c) food is non-veg, user named no protein, and no alias of
   that food appears in the user's words (alias containment keeps deliberate
   defaults: bare "bhurji" -> Egg Bhurji). A trip nulls matched_db_id
   unconditionally -> the item takes the INDB path.
   **Veg-default policy (2026-07-19):** bare category words ("biryani",
   "dum biryani") are aliases of the VEG variant in foods.js; non-veg requires
   an explicit protein word. Rule (c) is the enforcement net when the LLM
   ignores the alias map. **Documented exceptions** where common usage is
   overwhelmingly non-veg keep the bare alias on the non-veg entry, with a
   comment at the entry in foods.js — currently: bare "bhurji" -> Egg Bhurji
   (150); Paneer Bhurji (186) needs the explicit word. Alias containment in
   rule (c) is what makes exceptions safe: the bare word is a real alias, so
   no trip.
3. **INDB reference lookup (Tier 2.5, existing) + suspect arbitration.**
   `match_food` RPC against the 1,014-recipe lab-analyzed table. Unmatched
   items: hit -> nutrition applied, row flagged `refVerified`, reply says
   "logged from a lab-verified recipe database". Compound/coverage suspects
   (still matched): INDB overrides the curated value ONLY with positive token
   evidence — every content word of the phrase present in the INDB recipe
   name; otherwise the curated value stands (never worse than today).
4. **LLM estimate (Tier 3, existing).** No INDB hit -> clamped est_kcal,
   flagged as estimate, correction one reply away.
5. **Gap trail.** Every guard trip, suspect, or unmatched food appends to
   `evals/db-gaps.jsonl` (reasons: protein_guard / compound / coverage /
   no_match; sources: indb / estimate / curated_kept) and WhatsApp-alerts
   Swapnil (throttled: one alert per food per day). Query previews do NOT log
   gaps — only real logs do.

## Promotion protocol (human step — deliberately manual)

The eval suite is the safety net for model/prompt swaps; it only works if every
case is human-verified. Auto-growing it from runtime data would poison it.

1. Review `evals/db-gaps.jsonl` weekly (or on alert).
2. A food appearing 2+ times from distinct days is a promotion candidate.
3. Verify nutrition against INDB values (or a trusted source), then add to
   `src/foods.js` with Hinglish aliases, next free ID.
4. Add an eval case to `evals/cases.jsonl` expecting the new db_id.
5. Run `node evals/run.js` — must stay 100% before commit.

## What we deliberately did NOT build

- No runtime web-search/agent sourcing: 3-5s latency on the hot path for data
  no more validated than INDB, which is already ~150ms away in Supabase.
- No follow-up clarifying questions for vague foods: the PRD's core rule is
  never dead-end, always log, be transparently uncertain, make correction
  one reply away.
- No automatic eval-set additions (see promotion protocol).
```

- [ ] **Step 2: Commit**

```bash
git add rules/db-gap-pipeline.md
git commit -m "Document DB-gap pipeline: guard rules, INDB fallback, promotion protocol"
```

---

## Self-Review (completed at planning time)

- **Spec coverage:** protein tripwire (Task 1), gap log + developer highlight (Tasks 2-3), externally-validated sourcing via existing INDB (Tasks 3, 5), transparent user reply + correct/undo unchanged (Task 4), within-category context confusion — sev puri / chole puri / methi puri class (Task 5), eval additions kept manual with documented protocol (Task 6). The original ask's "agent orchestrator" was consciously replaced by deterministic guards + the existing INDB tier — recorded in the rules doc.
- **Type consistency:** `guardItems(items)` mutates and returns tripped items (Tasks 1, 3, 5). `contextGuard(items)` / `contentTokens(text)` / `FILLER` (Task 5). `logGapEvent({food, reason, source, served_as, kcal})` with reasons `protein_guard|compound|coverage|no_match` and sources `indb|estimate|curated_kept` (Tasks 2, 5). `resolveRows(parsed, {trackGaps})` (Tasks 3, 4, 5 — Task 5's version supersedes Task 3's). `applyReference(row, ref, {trusted})` (Task 5). `r.refVerified` (Tasks 3, 4, 5).
- **Known judgment call (estimate path):** `applyReference`'s untrusted 2x/0.5x sanity check compares against the LLM estimate (default 300 kcal when the LLM force-matched and gave no `est_kcal`), so INDB hits outside [150, 600] kcal/serving are discarded and the estimate stands. Acceptable: the guard's job is preventing the *wrong confident answer*; a flagged estimate is an honest fallback.
- **Known judgment call (suspect path):** suspect overrides require ALL content tokens of the phrase in the INDB recipe name — strict on purpose. A miss keeps the curated value and logs `curated_kept`, so the failure mode is "today's behavior + developer visibility", never a new wrong answer.
- **Execution note:** Task 5 intentionally rewrites `resolveRows` from Task 3 — implementers must use Task 5's version verbatim once they reach it.
