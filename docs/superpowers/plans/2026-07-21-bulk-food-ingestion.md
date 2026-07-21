# Bulk Food Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest ~3,900 AI-generated food rows from `data/incoming/*.md` into the Supabase `foods_reference` tier, gated + deduped + collapsed, without touching the curated `foods.js` tier or the parser prompt.

**Architecture:** A deterministic, re-runnable offline pipeline of small pure modules under `scripts/ingest-foods/`: parse → normalize → gate → collapse → dedup → map-to-row. An orchestrator (`run.js`) chains them, writes a review report (dry-run default), and only upserts to `foods_reference` under `--load`. Every survivor gets an `AI####` `food_code` so the whole import is reversible.

**Tech Stack:** Node.js (CommonJS), `@supabase/supabase-js`, `dotenv`. Tests are plain `node` + `assert` (run `node test/<name>.js`), matching the repo convention. No test framework.

## Global Constraints

- Bulk rows go ONLY to `foods_reference` — never `src/foods.js` (prompt-size protection).
- Pipeline is read-only against the codebase; the ONLY write is the `--load` upsert to Supabase.
- All pipeline modules are **pure** (no I/O, no Supabase) except `run.js`. This keeps them unit-testable.
- `food_code` namespace prefixes: `AIH` (household), `AIQ` (quick-commerce), `AIF` (fitness), `AID` (dairy/Food_Nutrition_DB). Import is reversible via `food_code like 'AI%'`.
- Reject thresholds (verbatim): macro-cal deviation > 0.30; kcal/100g > 900 or < 5; name empty / > 60 chars / no letters.
- `data/incoming/` is already gitignored. Commit scripts, tests, and the review report — never the raw MD or loaded rows.
- After any change, the parser eval suite must stay green: `node evals/run.js` → 153/153 (curated tier is untouched, so this is a regression check, not a target moved).

## File Structure

- `scripts/ingest-foods/parse-md.js` — parse one pipe-table MD → raw records. Pure.
- `scripts/ingest-foods/normalize.js` — name cleanup, serving→{unit,grams}, per-100g. Pure.
- `scripts/ingest-foods/gate.js` — reject predicates. Pure.
- `scripts/ingest-foods/collapse.js` — collapse identical-macro + shared-token clusters. Pure.
- `scripts/ingest-foods/dedup.js` — drop rows already in curated / reference. Pure.
- `scripts/ingest-foods/to-row.js` — map survivor → `foods_reference` row + `food_code`. Pure.
- `scripts/ingest-foods/report.js` — build the review-report markdown. Pure.
- `scripts/ingest-foods/run.js` — orchestrator; dry-run writes report, `--load` upserts. I/O.
- `test/ingest-foods-test.js` — unit tests for all pure modules.
- `scripts/ingest-foods/verify.js` — post-load spot-check against Supabase. I/O.

---

### Task 1: MD table parser

**Files:**
- Create: `scripts/ingest-foods/parse-md.js`
- Test: `test/ingest-foods-test.js`

**Interfaces:**
- Produces: `parseMdTable(text: string) -> Array<{ [header: string]: string }>` — one object per data row, keyed by the table's header cells. Ignores non-table lines and the `|:---|` separator.

- [ ] **Step 1: Write the failing test** — create `test/ingest-foods-test.js`:

```javascript
const assert = require("assert");
const { parseMdTable } = require("../scripts/ingest-foods/parse-md.js");

const sample = [
  "# Title",
  "",
  "| Item Name | Serving Size | Calories (kcal) | Protein (g) |",
  "|:----------|:-------------|----------------:|------------:|",
  "| Kanda Poha | 1 bowl (150g) | 220 | 4.5 |",
  "| Plain Idli | 2 pcs (100g) | 130 | 4.2 |",
].join("\n");

const rows = parseMdTable(sample);
assert.strictEqual(rows.length, 2, "two data rows");
assert.strictEqual(rows[0]["Item Name"], "Kanda Poha");
assert.strictEqual(rows[0]["Serving Size"], "1 bowl (150g)");
assert.strictEqual(rows[0]["Calories (kcal)"], "220");
assert.strictEqual(rows[1]["Protein (g)"], "4.2");
console.log("parse-md: passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/ingest-foods-test.js`
Expected: FAIL — `Cannot find module '../scripts/ingest-foods/parse-md.js'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/ingest-foods/parse-md.js`:

```javascript
// Parse a GitHub-flavored markdown pipe-table into row objects keyed by header.
function parseMdTable(text) {
  const rows = [];
  let headers = null;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.every(c => /^:?-+:?$/.test(c))) continue; // separator row
    if (!headers) { headers = cells; continue; }
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] !== undefined ? cells[i] : ""; });
    rows.push(obj);
  }
  return rows;
}

module.exports = { parseMdTable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/ingest-foods-test.js`
Expected: PASS — prints `parse-md: passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/parse-md.js test/ingest-foods-test.js
git commit -m "Ingest pipeline: markdown table parser"
```

---

### Task 2: Normalize (name, serving→grams, per-100g)

**Files:**
- Create: `scripts/ingest-foods/normalize.js`
- Test: `test/ingest-foods-test.js` (append)

**Interfaces:**
- Consumes: raw row objects from Task 1, plus the source filename (for brand prefixing).
- Produces:
  - `parseServing(s: string) -> { unit: string, grams: number|null }`
  - `normalizeRow(rawRow, sourceFile) -> { source_file, name, unit, grams, kcal, p, c, f, kcal_100g, p_100g, c_100g, f_100g, category }` (numbers are `Number`; `null` grams if unparseable)

- [ ] **Step 1: Write the failing test** — append to `test/ingest-foods-test.js`:

```javascript
const { parseServing, normalizeRow } = require("../scripts/ingest-foods/normalize.js");

// grams inside parens -> unit is the outer label
assert.deepStrictEqual(parseServing("1 bowl (150g)"), { unit: "bowl", grams: 150 });
// grams outside, count in parens -> unit is the parenthetical
assert.deepStrictEqual(parseServing("32g (2 tbsp)"), { unit: "2 tbsp", grams: 32 });
// bare weight -> generic unit
assert.deepStrictEqual(parseServing("100ml"), { unit: "serving", grams: 100 });
assert.deepStrictEqual(parseServing("2 pcs (100g)"), { unit: "2 pcs", grams: 100 });

const hh = normalizeRow(
  { "Item Name": "Kanda Poha", "Serving Size": "1 bowl (150g)", "Calories (kcal)": "220", "Protein (g)": "4.5", "Carbs (g)": "38", "Fats (g)": "6", "Category": "Prepared Dishes" },
  "Indian_Household_Nutrition_Database_2500.md"
);
assert.strictEqual(hh.name, "Kanda Poha");
assert.strictEqual(hh.grams, 150);
assert.strictEqual(hh.kcal, 220);
assert.strictEqual(Math.round(hh.kcal_100g), 147); // 220/150*100
assert.strictEqual(hh.category, "Prepared Dishes");

// branded file -> brand is prefixed onto the name
const br = normalizeRow(
  { "Brand": "Amul", "Product": "Gold Milk", "Serving Size": "100ml", "Calories (kcal)": "87", "Protein (g)": "3.3", "Carbs (g)": "5", "Fats (g)": "6", "Type": "Dairy/Milk" },
  "Food_Nutrition_DB.md"
);
assert.strictEqual(br.name, "Amul Gold Milk");
assert.strictEqual(br.grams, 100);
console.log("normalize: passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/ingest-foods-test.js`
Expected: FAIL — `Cannot find module '../scripts/ingest-foods/normalize.js'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/ingest-foods/normalize.js`:

```javascript
// Column names vary across the four files; read each field from its aliases.
const NAME_COLS = ["Item Name", "Product / Dish Name", "Product Name", "Product"];
const BRAND_COLS = ["Brand", "Brand / Restaurant"];
const CAT_COLS = ["Category", "Sub-Category", "Type"];

const pick = (row, cols) => { for (const c of cols) if (row[c] != null && row[c] !== "") return row[c]; return ""; };

// "1 bowl (150g)" -> {unit:"bowl", grams:150}; "32g (2 tbsp)" -> {unit:"2 tbsp", grams:32}
function parseServing(s) {
  const str = String(s || "");
  const gm = str.match(/(\d+(?:\.\d+)?)\s*(?:g|ml)\b/i);
  const grams = gm ? parseFloat(gm[1]) : null;
  let unit = str
    .replace(/\(?\s*\d+(?:\.\d+)?\s*(?:g|ml)\s*\)?/i, " ") // drop the grams/ml token
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^1\s+/, ""); // "1 bowl" -> "bowl"; keep "2 pcs"
  if (!unit) unit = "serving";
  return { unit, grams };
}

function normalizeRow(row, sourceFile) {
  const brand = pick(row, BRAND_COLS).trim();
  const rawName = pick(row, NAME_COLS).trim();
  // Prefix the brand only when it isn't already the start of the product name.
  const name = brand && !rawName.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${rawName}` : rawName;
  const { unit, grams } = parseServing(row["Serving Size"]);
  const kcal = parseFloat(row["Calories (kcal)"]);
  const p = parseFloat(row["Protein (g)"]);
  const c = parseFloat(row["Carbs (g)"]);
  const f = parseFloat(row["Fats (g)"]);
  const per100 = (v) => (grams > 0 && Number.isFinite(v)) ? +(v / grams * 100).toFixed(2) : null;
  return {
    source_file: sourceFile, name, unit, grams,
    kcal, p, c, f,
    kcal_100g: per100(kcal), p_100g: per100(p), c_100g: per100(c), f_100g: per100(f),
    category: pick(row, CAT_COLS).trim(),
  };
}

module.exports = { parseServing, normalizeRow };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/ingest-foods-test.js`
Expected: PASS — prints `normalize: passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/normalize.js test/ingest-foods-test.js
git commit -m "Ingest pipeline: normalize name, serving, per-100g"
```

---

### Task 3: Quality gate

**Files:**
- Create: `scripts/ingest-foods/gate.js`
- Test: `test/ingest-foods-test.js` (append)

**Interfaces:**
- Consumes: normalized rows from Task 2.
- Produces: `gateReason(rec) -> string | null` — `null` means PASS; a non-empty string is the rejection reason.

- [ ] **Step 1: Write the failing test** — append to `test/ingest-foods-test.js`:

```javascript
const { gateReason } = require("../scripts/ingest-foods/gate.js");

const good = { name: "Kanda Poha", kcal: 220, p: 4.5, c: 38, f: 6, grams: 150, kcal_100g: 147 };
assert.strictEqual(gateReason(good), null, "clean row passes");

assert.ok(gateReason({ ...good, p: NaN }), "NaN macro rejected");
assert.ok(gateReason({ ...good, kcal: -5 }), "negative kcal rejected");
// macros imply 4.5*4+38*4+6*9=224 vs kcal 220 -> within 30%, still passes
assert.strictEqual(gateReason(good), null);
// wildly inconsistent: kcal 220 but macros imply 4*4+4*4+30*9=302 -> >30% off
assert.ok(gateReason({ ...good, f: 30 }), "macro-cal mismatch rejected");
// absurd density
assert.ok(gateReason({ ...good, grams: 5, kcal_100g: 4400 }), "kcal/100g>900 rejected");
assert.ok(gateReason({ ...good, name: "" }), "empty name rejected");
assert.ok(gateReason({ ...good, name: "x".repeat(61) }), "over-long name rejected");
console.log("gate: passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/ingest-foods-test.js`
Expected: FAIL — `Cannot find module '../scripts/ingest-foods/gate.js'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/ingest-foods/gate.js`:

```javascript
// Returns a rejection reason string, or null if the row passes every gate.
function gateReason(rec) {
  const { name, kcal, p, c, f, grams, kcal_100g } = rec;
  if (![kcal, p, c, f].every(x => Number.isFinite(x))) return "non_finite_value";
  if ([kcal, p, c, f].some(x => x < 0)) return "negative_value";
  if (!Number.isFinite(grams) || grams <= 0) return "no_grams";
  const derived = p * 4 + c * 4 + f * 9;
  if (kcal > 0 && Math.abs(derived - kcal) / kcal > 0.30) return "macro_cal_mismatch";
  if (!Number.isFinite(kcal_100g) || kcal_100g > 900 || kcal_100g < 5) return "absurd_density";
  const n = String(name || "").trim();
  if (!n || n.length > 60 || !/[a-z]/i.test(n)) return "bad_name";
  return null;
}

module.exports = { gateReason };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/ingest-foods-test.js`
Expected: PASS — prints `gate: passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/gate.js test/ingest-foods-test.js
git commit -m "Ingest pipeline: quality gate"
```

---

### Task 4: Collapse combinatorial spam

**Files:**
- Create: `scripts/ingest-foods/collapse.js`
- Test: `test/ingest-foods-test.js` (append)

**Interfaces:**
- Consumes: gate-passing rows from Task 3.
- Produces: `collapse(recs) -> { kept: Array<rec>, dropped: Array<{ name, keptAs }> }`. Rows sharing an identical `[kcal,p,c,f,grams]` fingerprint AND at least one common content token collapse to the single shortest-named representative.

- [ ] **Step 1: Write the failing test** — append to `test/ingest-foods-test.js`:

```javascript
const { collapse } = require("../scripts/ingest-foods/collapse.js");

const recs = [
  { name: "Aashirvaad Select Sharbati Atta", kcal: 345, p: 12, c: 68, f: 1.8, grams: 100 },
  { name: "Aashirvaad Chakki Atta", kcal: 345, p: 12, c: 68, f: 1.8, grams: 100 },
  { name: "Toor Dal", kcal: 140, p: 8, c: 20, f: 4, grams: 150 },
  // same macros as Toor Dal but no shared token -> must NOT collapse together
  { name: "Beetroot Soup", kcal: 140, p: 8, c: 20, f: 4, grams: 150 },
];
const { kept, dropped } = collapse(recs);
const names = kept.map(r => r.name).sort();
assert.ok(names.includes("Aashirvaad Chakki Atta"), "shortest atta kept");
assert.ok(!names.includes("Aashirvaad Select Sharbati Atta"), "longer atta dropped");
assert.ok(names.includes("Toor Dal") && names.includes("Beetroot Soup"), "coincidental-macro pair both kept");
assert.strictEqual(dropped.length, 1);
assert.strictEqual(dropped[0].keptAs, "Aashirvaad Chakki Atta");
console.log("collapse: passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/ingest-foods-test.js`
Expected: FAIL — `Cannot find module '../scripts/ingest-foods/collapse.js'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/ingest-foods/collapse.js`:

```javascript
const tokens = (name) => String(name || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);

// Collapse clusters that share an exact macro fingerprint AND a common content
// token (guards against merging coincidentally-equal but unrelated foods).
function collapse(recs) {
  const groups = new Map();
  for (const r of recs) {
    const fp = [r.kcal, r.p, r.c, r.f, r.grams].join("|");
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(r);
  }
  const kept = [], dropped = [];
  for (const group of groups.values()) {
    if (group.length < 2) { kept.push(group[0]); continue; }
    const sets = group.map(r => new Set(tokens(r.name)));
    const common = [...sets[0]].filter(t => sets.every(s => s.has(t)));
    if (common.length === 0) { kept.push(...group); continue; } // coincidental — keep all
    const rep = group.slice().sort((a, b) => a.name.length - b.name.length)[0];
    kept.push(rep);
    for (const r of group) if (r !== rep) dropped.push({ name: r.name, keptAs: rep.name });
  }
  return { kept, dropped };
}

module.exports = { collapse };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/ingest-foods-test.js`
Expected: PASS — prints `collapse: passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/collapse.js test/ingest-foods-test.js
git commit -m "Ingest pipeline: collapse identical-macro clusters"
```

---

### Task 5: Dedup against curated + reference

**Files:**
- Create: `scripts/ingest-foods/dedup.js`
- Test: `test/ingest-foods-test.js` (append)

**Interfaces:**
- Consumes: collapse survivors (Task 4), plus two `Set<string>` of normalized existing names.
- Produces:
  - `normName(s: string) -> string` — lowercase, alphanumeric-only, single-spaced.
  - `dedup(recs, curatedNames: Set, refNames: Set) -> { kept, dropped: Array<{ name, reason }> }`.

- [ ] **Step 1: Write the failing test** — append to `test/ingest-foods-test.js`:

```javascript
const { normName, dedup } = require("../scripts/ingest-foods/dedup.js");

assert.strictEqual(normName("Dal  Tadka!"), "dal tadka");

const curated = new Set(["dal tadka"]);
const ref = new Set(["hot tea garam chai"]);
const recs = [
  { name: "Dal Tadka" },        // in curated -> drop
  { name: "Hot Tea (Garam Chai)" }, // in reference -> drop
  { name: "Kanda Poha" },       // new -> keep
];
const { kept, dropped } = dedup(recs, curated, ref);
assert.deepStrictEqual(kept.map(r => r.name), ["Kanda Poha"]);
assert.strictEqual(dropped.length, 2);
assert.strictEqual(dropped.find(d => d.name === "Dal Tadka").reason, "in_curated");
assert.strictEqual(dropped.find(d => d.name.startsWith("Hot Tea")).reason, "in_reference");
console.log("dedup: passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/ingest-foods-test.js`
Expected: FAIL — `Cannot find module '../scripts/ingest-foods/dedup.js'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/ingest-foods/dedup.js`:

```javascript
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Drop rows whose normalized name already exists in the curated tier or the
// reference tier. Curated always wins; the reference tier isn't duplicated.
function dedup(recs, curatedNames, refNames) {
  const kept = [], dropped = [];
  for (const r of recs) {
    const key = normName(r.name);
    if (curatedNames.has(key)) { dropped.push({ name: r.name, reason: "in_curated" }); continue; }
    if (refNames.has(key)) { dropped.push({ name: r.name, reason: "in_reference" }); continue; }
    kept.push(r);
  }
  return { kept, dropped };
}

module.exports = { normName, dedup };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/ingest-foods-test.js`
Expected: PASS — prints `dedup: passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/dedup.js test/ingest-foods-test.js
git commit -m "Ingest pipeline: dedup vs curated and reference"
```

---

### Task 6: Map to `foods_reference` row + `food_code`

**Files:**
- Create: `scripts/ingest-foods/to-row.js`
- Test: `test/ingest-foods-test.js` (append)

**Interfaces:**
- Consumes: dedup survivors (Task 5).
- Produces:
  - `codeFor(sourceFile: string, index: number) -> string` (e.g. `"AIH0001"`).
  - `toReferenceRow(rec, code: string) -> { food_code, food_name, serving_unit, serving_kcal, serving_protein, serving_carbs, serving_fat, serving_fibre, kcal_100g, protein_100g, carbs_100g, fat_100g, fibre_100g }`.

- [ ] **Step 1: Write the failing test** — append to `test/ingest-foods-test.js`:

```javascript
const { codeFor, toReferenceRow } = require("../scripts/ingest-foods/to-row.js");

assert.strictEqual(codeFor("Indian_Household_Nutrition_Database_2500.md", 0), "AIH0001");
assert.strictEqual(codeFor("QuickCommerce_Restaurant_Food_DB_1000.md", 41), "AIQ0042");
assert.strictEqual(codeFor("Fitness_Commercial_Products_DB.md", 0), "AIF0001");
assert.strictEqual(codeFor("Food_Nutrition_DB.md", 0), "AID0001");

const rec = { name: "Kanda Poha", unit: "bowl", kcal: 220, p: 4.5, c: 38, f: 6, kcal_100g: 147, p_100g: 3, c_100g: 25.3, f_100g: 4 };
const row = toReferenceRow(rec, "AIH0001");
assert.strictEqual(row.food_code, "AIH0001");
assert.strictEqual(row.food_name, "Kanda Poha");
assert.strictEqual(row.serving_unit, "bowl");
assert.strictEqual(row.serving_kcal, 220);
assert.strictEqual(row.serving_protein, 4.5);
assert.strictEqual(row.serving_fibre, 0);
assert.strictEqual(row.kcal_100g, 147);
assert.strictEqual(row.fibre_100g, 0);
console.log("to-row: passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/ingest-foods-test.js`
Expected: FAIL — `Cannot find module '../scripts/ingest-foods/to-row.js'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/ingest-foods/to-row.js`:

```javascript
const PREFIX = {
  "Indian_Household_Nutrition_Database_2500.md": "AIH",
  "QuickCommerce_Restaurant_Food_DB_1000.md": "AIQ",
  "Fitness_Commercial_Products_DB.md": "AIF",
  "Food_Nutrition_DB.md": "AID",
};

function codeFor(sourceFile, index) {
  const prefix = PREFIX[sourceFile] || "AIX";
  return prefix + String(index + 1).padStart(4, "0");
}

// Map a survivor to the foods_reference column shape. Fibre is unknown in the
// source files -> 0 (deferred enhancement). serving_* is the row-as-stated;
// *_100g drives applyReference's fallback path.
function toReferenceRow(rec, code) {
  return {
    food_code: code,
    food_name: rec.name,
    serving_unit: rec.unit || "serving",
    serving_kcal: rec.kcal,
    serving_protein: rec.p,
    serving_carbs: rec.c,
    serving_fat: rec.f,
    serving_fibre: 0,
    kcal_100g: rec.kcal_100g,
    protein_100g: rec.p_100g,
    carbs_100g: rec.c_100g,
    fat_100g: rec.f_100g,
    fibre_100g: 0,
  };
}

module.exports = { codeFor, toReferenceRow };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/ingest-foods-test.js`
Expected: PASS — prints `to-row: passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/to-row.js test/ingest-foods-test.js
git commit -m "Ingest pipeline: map to foods_reference row + food_code"
```

---

### Task 7: Review-report builder

**Files:**
- Create: `scripts/ingest-foods/report.js`
- Test: `test/ingest-foods-test.js` (append)

**Interfaces:**
- Consumes: a `stats` object the orchestrator assembles.
- Produces: `buildReport(stats) -> string` (markdown). `stats` shape:
  `{ funnel: Array<{ file, parsed, gated, collapsed, deduped, loaded }>, rejects: Array<{ name, reason }>, collapses: Array<{ name, keptAs }>, sample: Array<{ food_name, serving_unit, serving_kcal, serving_protein, kcal_100g }> }`.

- [ ] **Step 1: Write the failing test** — append to `test/ingest-foods-test.js`:

```javascript
const { buildReport } = require("../scripts/ingest-foods/report.js");

const md = buildReport({
  funnel: [{ file: "A.md", parsed: 100, gated: 95, collapsed: 80, deduped: 75, loaded: 75 }],
  rejects: [{ name: "Weird Row", reason: "macro_cal_mismatch" }],
  collapses: [{ name: "Aashirvaad Select Atta", keptAs: "Aashirvaad Chakki Atta" }],
  sample: [{ food_name: "Kanda Poha", serving_unit: "bowl", serving_kcal: 220, serving_protein: 4.5, kcal_100g: 147 }],
});
assert.ok(md.includes("A.md"), "funnel row present");
assert.ok(md.includes("macro_cal_mismatch"), "reject reason present");
assert.ok(md.includes("Aashirvaad Chakki Atta"), "collapse decision present");
assert.ok(md.includes("Kanda Poha"), "sample row present");
console.log("report: passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/ingest-foods-test.js`
Expected: FAIL — `Cannot find module '../scripts/ingest-foods/report.js'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/ingest-foods/report.js`:

```javascript
function buildReport(stats) {
  const { funnel = [], rejects = [], collapses = [], sample = [] } = stats;
  const out = [];
  out.push("# Bulk Food Ingestion — Review Report\n");
  out.push(`Generated: ${new Date().toISOString()}\n`);

  out.push("## Funnel (per file)\n");
  out.push("| File | Parsed | After gate | After collapse | After dedup | To load |");
  out.push("|:-----|-------:|-----------:|---------------:|------------:|--------:|");
  for (const r of funnel) out.push(`| ${r.file} | ${r.parsed} | ${r.gated} | ${r.collapsed} | ${r.deduped} | ${r.loaded} |`);
  const tot = funnel.reduce((a, r) => ({ parsed: a.parsed + r.parsed, loaded: a.loaded + r.loaded }), { parsed: 0, loaded: 0 });
  out.push(`\n**Total: ${tot.parsed} parsed → ${tot.loaded} to load.**\n`);

  out.push(`## Rejected rows (${rejects.length})\n`);
  const byReason = {};
  for (const r of rejects) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) out.push(`- **${reason}**: ${n}`);
  out.push("\n<details><summary>All rejected rows</summary>\n");
  for (const r of rejects) out.push(`- ${r.name} — ${r.reason}`);
  out.push("</details>\n");

  out.push(`## Collapse decisions (${collapses.length} dropped)\n`);
  out.push("<details><summary>All collapses (dropped → kept)</summary>\n");
  for (const c of collapses) out.push(`- ${c.name} → ${c.keptAs}`);
  out.push("</details>\n");

  out.push(`## Sample of rows to load (${sample.length})\n`);
  out.push("| Food | Unit | kcal | Protein | kcal/100g |");
  out.push("|:-----|:-----|-----:|--------:|----------:|");
  for (const s of sample) out.push(`| ${s.food_name} | ${s.serving_unit} | ${s.serving_kcal} | ${s.serving_protein} | ${s.kcal_100g} |`);
  out.push("");
  return out.join("\n");
}

module.exports = { buildReport };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/ingest-foods-test.js`
Expected: PASS — prints `report: passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/report.js test/ingest-foods-test.js
git commit -m "Ingest pipeline: review-report builder"
```

---

### Task 8: Orchestrator (dry-run: parse → report, no load)

**Files:**
- Create: `scripts/ingest-foods/run.js`
- Reference (read, do not edit): `scripts/import-indb.js` (Supabase upsert pattern), `src/foods.js` (curated names)

**Interfaces:**
- Consumes: all pure modules (Tasks 1–7), the four MD files, `src/foods.js`, and (for existing reference names) Supabase.
- Produces: writes `scripts/ingest-foods/review-report.md` and `scripts/ingest-foods/to-load.json` (the survivor rows). Loads nothing unless `--load` is passed (Task 9).

- [ ] **Step 1: Write the orchestrator** — create `scripts/ingest-foods/run.js`:

```javascript
// Offline ingestion pipeline. Dry-run (default): parse -> gate -> collapse ->
// dedup -> map, then write review-report.md + to-load.json. It NEVER loads
// unless --load is passed (see Task 9). Reversible via food_code like 'AI%'.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { parseMdTable } = require("./parse-md.js");
const { normalizeRow } = require("./normalize.js");
const { gateReason } = require("./gate.js");
const { collapse } = require("./collapse.js");
const { normName, dedup } = require("./dedup.js");
const { codeFor, toReferenceRow } = require("./to-row.js");
const { buildReport } = require("./report.js");
const { FOODS } = require("../../src/foods.js");

const INCOMING = path.join(__dirname, "..", "..", "data", "incoming");
const OUT_REPORT = path.join(__dirname, "review-report.md");
const OUT_ROWS = path.join(__dirname, "to-load.json");

async function existingRefNames() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const names = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("foods_reference").select("food_name").range(from, from + 999);
    if (error) { console.error("ref fetch:", error.message); break; }
    if (!data || !data.length) break;
    for (const r of data) names.add(normName(r.food_name));
    if (data.length < 1000) break;
  }
  return names;
}

async function main() {
  const curatedNames = new Set();
  for (const f of FOODS) { curatedNames.add(normName(f.name)); f.aliases.forEach(a => curatedNames.add(normName(a))); }
  const refNames = await existingRefNames();

  const funnel = [], allRejects = [], allCollapses = [], allRows = [];
  const files = fs.readdirSync(INCOMING).filter(f => f.endsWith(".md"));

  for (const file of files) {
    const text = fs.readFileSync(path.join(INCOMING, file), "utf8");
    const parsed = parseMdTable(text).map(r => normalizeRow(r, file));

    const gated = [];
    for (const rec of parsed) {
      const reason = gateReason(rec);
      if (reason) allRejects.push({ name: rec.name, reason });
      else gated.push(rec);
    }

    const { kept: collapsed, dropped } = collapse(gated);
    allCollapses.push(...dropped);

    const { kept: deduped } = dedup(collapsed, curatedNames, refNames);
    // guard against duplicates ACROSS files within this run
    const rowsThisFile = [];
    for (const rec of deduped) {
      const key = normName(rec.name);
      if (refNames.has(key)) continue;
      refNames.add(key);
      // per-file index -> clean AIH0001.., AIQ0001.. codes; unique because the
      // prefix differs per file and the index is unique within a file.
      rowsThisFile.push(toReferenceRow(rec, codeFor(file, rowsThisFile.length)));
    }
    allRows.push(...rowsThisFile);

    funnel.push({ file, parsed: parsed.length, gated: gated.length, collapsed: collapsed.length, deduped: deduped.length, loaded: rowsThisFile.length });
  }

  // stratified-ish sample: every Nth survivor, up to 100
  const step = Math.max(1, Math.floor(allRows.length / 100));
  const sample = allRows.filter((_, i) => i % step === 0).slice(0, 100);

  fs.writeFileSync(OUT_REPORT, buildReport({ funnel, rejects: allRejects, collapses: allCollapses, sample }));
  fs.writeFileSync(OUT_ROWS, JSON.stringify(allRows, null, 0));
  console.log(`Dry run complete. ${allRows.length} rows -> ${OUT_ROWS}`);
  console.log(`Review: ${OUT_REPORT}`);
  console.log("To load: node scripts/ingest-foods/run.js --load");
}

if (process.argv.includes("--load")) {
  require("./load.js").load(OUT_ROWS);
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Run the dry-run against the real files**

Run: `node scripts/ingest-foods/run.js`
Expected: prints a survivor count in the **1,800–2,600** range and writes both output files. If it errors on Supabase auth, confirm `.env` has `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.

- [ ] **Step 3: Sanity-check the report**

Run: `head -40 scripts/ingest-foods/review-report.md`
Expected: a funnel table with per-file counts, a reject breakdown (macro_cal_mismatch, absurd_density, etc.), and a sample table with plausible foods.

- [ ] **Step 4: Commit the pipeline (not the outputs)**

```bash
echo "scripts/ingest-foods/to-load.json" >> .gitignore
git add scripts/ingest-foods/run.js .gitignore scripts/ingest-foods/review-report.md
git commit -m "Ingest pipeline: dry-run orchestrator + review report"
```

---

### Task 9: Loader (`--load`) + verify

**Files:**
- Create: `scripts/ingest-foods/load.js`, `scripts/ingest-foods/verify.js`
- Reference (read): `scripts/import-indb.js:18-19` (batch upsert)

**Interfaces:**
- Consumes: `to-load.json` from Task 8.
- Produces: `load(rowsPath: string)` — upserts to `foods_reference` in batches of 500 on `food_code`. `verify.js` is a standalone post-load check.

- [ ] **Step 1: Write the loader** — create `scripts/ingest-foods/load.js`:

```javascript
require("dotenv").config();
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

async function load(rowsPath) {
  const rows = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from("foods_reference").upsert(batch, { onConflict: "food_code" });
    if (error) { console.error(`batch ${i}:`, error.message); process.exit(1); }
    console.log(`upserted ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  const { count } = await supabase.from("foods_reference").select("*", { count: "exact", head: true });
  console.log(`done — ${count} rows in foods_reference (of which AI-tagged: run verify.js)`);
}

module.exports = { load };
```

- [ ] **Step 2: Write the post-load verifier** — create `scripts/ingest-foods/verify.js`:

```javascript
// After loading, confirm the AI rows exist and that a handful of previously
// ESTIMATED dishes now resolve via the reference tier with sane numbers.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const PROBES = ["kanda poha", "masala dosa", "misal pav", "veg pulao", "rava idli",
  "chana masala", "aloo gobi", "bhindi masala", "egg curry", "mutton keema",
  "paneer bhurji", "vegetable sandwich", "cold coffee", "gulab jamun", "poha"];

async function main() {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { count } = await s.from("foods_reference").select("*", { count: "exact", head: true }).like("food_code", "AI%");
  console.log(`AI-tagged rows in foods_reference: ${count}`);
  let hit = 0;
  for (const q of PROBES) {
    const { data } = await s.rpc("match_food", { q });
    const top = data && data[0];
    const ok = top && Number(top.serving_kcal) > 0;
    if (ok) hit++;
    console.log(`${ok ? "✓" : "✗"} "${q}" -> ${top ? top.food_name + " (" + top.serving_kcal + " kcal)" : "no match"}`);
  }
  console.log(`\nresolved ${hit}/${PROBES.length} probes (target >= 12)`);
  process.exit(hit >= 12 ? 0 : 1);
}
main();
```

- [ ] **Step 3: Get human approval on the report**

STOP. Show the reviewer `scripts/ingest-foods/review-report.md`. Do not run `--load` until they approve. (This is the spec's review gate.)

- [ ] **Step 4: Load (after approval)**

Run: `node scripts/ingest-foods/run.js --load`
Expected: `upserted …/N` lines, then `done — <count> rows in foods_reference`.

- [ ] **Step 5: Verify the load**

Run: `node scripts/ingest-foods/verify.js`
Expected: `AI-tagged rows in foods_reference: <~2000>` and `resolved >= 12/15 probes`. Exit code 0.

- [ ] **Step 6: Confirm curated tier + prompt untouched**

Run: `node -e "const {buildFoodDirectory}=require('./src/systemPrompt.js'); console.log(buildFoodDirectory().length)"`
Expected: `37188` (unchanged from before ingestion — proves the prompt didn't grow).

Run: `node evals/run.js` (background; ~2 min)
Expected: `perfect cases : 100% (153/153 …)`.

- [ ] **Step 7: Commit**

```bash
git add scripts/ingest-foods/load.js scripts/ingest-foods/verify.js scripts/ingest-foods/review-report.md
git commit -m "Ingest pipeline: loader + post-load verify (reference tier only)"
```

---

### Task 10: Live end-to-end spot-check + rollback note

**Files:**
- Reference (read): `README` of deployment — restart via `launchctl kickstart -k gui/501/com.nutridesi.server`
- Create: `scripts/ingest-foods/ROLLBACK.md`

- [ ] **Step 1: Restart the live server so it queries the enlarged reference tier**

Run: `launchctl kickstart -k gui/501/com.nutridesi.server && sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/`
Expected: `200`.

- [ ] **Step 2: Replay a previously-estimated dish end-to-end**

Run:
```bash
curl -s -X POST http://localhost:3000/whatsapp \
  --data-urlencode "From=whatsapp:+0000000098" \
  --data-urlencode "Body=1 bowl kanda poha" | \
  python3 -c "import sys,re; t=sys.stdin.read(); m=re.search(r'<Message>(.*?)</Message>', t, re.S); print(m.group(1) if m else t)"
```
Expected: logs "Kanda Poha" with a sane kcal (~200–240) sourced from the reference tier (not a flat 300 estimate).

- [ ] **Step 3: Clean up the test number's rows**

Run:
```bash
node -r dotenv/config -e "const{createClient}=require('@supabase/supabase-js');const s=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);(async()=>{for(const t of['user_logs','users','message_log'])await s.from(t).delete().eq('phone_number','+0000000098');console.log('cleaned');})();"
```
Expected: `cleaned`.

- [ ] **Step 4: Write the rollback doc** — create `scripts/ingest-foods/ROLLBACK.md`:

```markdown
# Rollback — bulk food ingestion

The entire import is namespaced under `food_code like 'AI%'`. To fully undo it,
run in the Supabase SQL editor:

    delete from foods_reference where food_code like 'AI%';

This removes every AI-ingested row and leaves the original 1,014 INDB rows and
the curated `foods.js` tier untouched. Re-running `node scripts/ingest-foods/run.js`
then `--load` re-imports idempotently (upsert on `food_code`).
```

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-foods/ROLLBACK.md
git commit -m "Ingest pipeline: rollback doc + live spot-check verified"
```

---

## Notes for the implementer

- **Run the whole unit suite after each task:** `node test/ingest-foods-test.js` should print every module's `… : passed` line and exit 0.
- **The pipeline is pure until Task 8.** If a test needs Supabase, you've put logic in the wrong module — keep DB access in `run.js` / `load.js` / `verify.js` only.
- **Idempotency:** re-running `run.js` overwrites the report and `to-load.json`; re-running `--load` upserts (no duplicates) because `food_code` is stable per (file, position). If the source files change, positions shift and codes reassign — that's fine, it's a full re-import.
- **Do not** add any of these foods to `src/foods.js`. That tier is promoted separately and by frequency, not in bulk.
