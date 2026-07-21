# Bulk Food Ingestion Pipeline — Design

**Date:** 2026-07-21
**Goal:** Ingest ~3,900 AI-generated Indian-food rows (4 markdown files) into the
`foods_reference` (INDB) tier with heavy quality gating, keeping only distinct,
trustworthy items and never polluting the curated `foods.js` tier or the parser prompt.

---

## Context: the two-tier architecture (why this matters)

| Tier | Where | In prompt? | Role |
|---|---|---|---|
| **Curated** | `src/foods.js` (336 items) | **Yes** — `buildFoodDirectory()`, ~9,300 tokens/call | High-frequency, hand-verified. LLM matches aliases directly. |
| **Reference (INDB)** | Supabase `foods_reference` (1,014 rows) | **No** | Fuzzy-matched *after* parse via `match_food` RPC → `acceptableRef` guard → `applyReference`. |

Adding 2–3k items to the curated tier would inflate the prompt to ~90k tokens per
message: slower, far costlier, Twilio-timeout risk, and *worse* matching (the model
drowns in options). Therefore **all bulk rows land in `foods_reference`**, served by
the existing fuzzy-match machinery. `acceptableRef` (negation + token-coverage) and
`applyReference` (>2×/<0.5× sanity vs the LLM's own estimate) are the runtime safety net.

Promotion of a *tiny* cream-of-the-crop into curated stays a separate, later,
frequency-driven activity — **out of scope here.**

---

## Data reality (read-only recon, all 3,900 rows)

- **Structurally clean:** 0 rows missing calories/macros; 0 with unparseable serving grams.
- **176 (4.5%)** fail macro-vs-calorie consistency (P·4 + C·4 + F·9 within 30% of kcal).
- **76** have absurd kcal/100g (>900 or <5).
- **253 clusters of ≥5 items sharing identical macro numbers** — AI padding to hit "2500":
  48 attas all `345/12/68/1.8`, 40 pakodas `260/4/28/12`, 26 tempering-dals identical, etc.
- **737 rows** are duplicate names within the set; **101** already exist in curated `foods.js`.

Expected survivors after gating + collapse: **~2,000–2,500 distinct, useful items.**

Source files (`data/incoming/`, all pipe-table markdown):
- `Indian_Household_Nutrition_Database_2500.md` — 2500 home dishes
- `QuickCommerce_Restaurant_Food_DB_1000.md` — 1000 brand/QSR items
- `Fitness_Commercial_Products_DB.md` — 380 brand SKUs
- `Food_Nutrition_DB.md` — 20 Amul/protein brands

---

## Pipeline (offline script, `scripts/ingest-foods/`)

A deterministic, **re-runnable** offline pipeline. It never touches the live server;
it only reads the MD files and writes to `foods_reference`. Each stage emits counts.

### 1. Parse
Read each MD, parse pipe-tables into uniform records:
`{ source_file, raw_name, brand?, category, serving_raw, kcal, p, c, f }`.

### 2. Normalize
- **Name:** trim; for branded files prepend brand (`Amul Gold Milk`). Collapse whitespace.
- **Serving → `{unit, grams}`:** `"1 bowl (150g)"` → `unit:"bowl", grams:150`;
  `"32g (2 tbsp)"` → `unit:"tbsp", grams:32`; `"100ml"` → `unit:"serving", grams:100`.
- **Per-100g:** `kcal_100g = kcal/grams*100` (and P/C/F likewise).
- **Fibre:** source files have none → `serving_fibre = 0`, `fibre_100g = 0`.
  (Category-based fibre estimate is a deferred enhancement, not in v1.)

### 3. Quality gate (reject)
Drop a row if **any** of:
- kcal or a macro is non-finite or negative.
- Macro-cal deviation > 30% (`|P·4 + C·4 + F·9 − kcal| / kcal > 0.30`).
- kcal/100g > 900 or < 5.
- Name empty, or > 60 chars (sentence-like), or contains no letters.

### 4. Collapse combinatorial spam (aggressive — per decision)
Group rows sharing an **identical macro fingerprint** `[kcal, p, c, f, grams]` **and** a
common name-root token. For each such cluster **of size ≥ 2**, keep ONE representative —
the shortest / most generic name (`Toor Dal`, `Whole Wheat Atta`) — and drop the
permutations (`Toor Dal (Bengali Tempering)`, `Aashirvaad Select Atta`). Requiring both an
exact-macro match *and* a shared root token prevents collapsing genuinely different foods
that coincidentally share numbers. Deterministic; every drop logged in the review report.

### 5. Dedup against existing
- **vs curated `foods.js`:** if the normalized name matches a curated name/alias
  (exact or high token-overlap), **drop the incoming row** — curated wins.
- **vs existing `foods_reference` (1,014):** if it closely matches an existing ref
  `food_name`, **skip** (don't duplicate the INDB tier).

### 6. Namespace + `food_code`
Assign each survivor a batch-identifiable code:
`AIH####` (household), `AIQ####` (quick-commerce), `AIF####` (fitness), `AID####` (dairy).
This makes the whole import **removable as a set** → clean rollback.

### 7. Sampled review report (gate — per decision)
Write `scripts/ingest-foods/review-report.md`:
- Funnel counts (in → parsed → gated → collapsed → deduped → to-load) per file.
- **Every rejected row** with its reason.
- A representative sample of collapse decisions.
- A **stratified sample (~100 rows)** across categories for eyeballing.
**Stop here for human approval before Stage 8.**

### 8. Load
Upsert survivors into `foods_reference` (on `food_code`, idempotent).

### 9. Verify
- Parser evals **153/153** (curated tier unchanged → expect no change; run to confirm).
- Prompt token size unchanged (`buildFoodDirectory()` byte length identical).
- **Live spot-check:** replay ~15 dishes that were previously LLM estimates (from
  `evals/db-gaps.jsonl`) and confirm they now resolve via reference with sane values
  and pass `acceptableRef`. Delete the test number's rows afterward.

### 10. Rollback
`delete from foods_reference where food_code like 'AI%'` restores the prior state.

---

## Repo hygiene
- `data/incoming/` → **gitignored** (raw AI inputs; Supabase is the source of truth, and
  the 912 KB of markdown shouldn't bloat the public repo).
- Committed: the pipeline scripts, the review report, and this spec. Not the raw MD, not
  the loaded rows (they live in Supabase).

## Non-goals (v1)
- Bulk promotion into curated `foods.js` (separate, frequency-driven, later).
- Re-sourcing / re-deriving macros from an authority — we **gate** AI values, not replace them.
- Fibre sourcing (default 0).
- Any change to the parser prompt or the curated tier.

## Success criteria
- ~2,000–2,500 distinct rows loaded to `foods_reference`, each passing the gates.
- No duplicate of a curated food; no macro-inconsistent or absurd rows.
- Parser evals green; prompt token size unchanged.
- ≥12/15 previously-estimated dishes now resolve via reference with sane values.
- Whole import reversible via the `AI%` food_code namespace.
