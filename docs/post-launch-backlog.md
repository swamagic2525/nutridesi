# Post-Launch Backlog

Deferred deliberately so launch day stays calm. None of these block the bot —
they upgrade food-data quality and auditability. Do the data-sourcing legwork
first on each, so any rabbit holes surface on a quiet day, not mid-traffic.

---

## 1. Import IFCT raw-ingredient data (macros for plain staples)

**Problem:** INDB is a *recipe* database (1,014 cooked dishes) — it has no raw
ingredients. So plain proteins (chicken breast, paneer, tofu, egg whites) and
other staples find no INDB match and fall to the LLM estimate, which returns
**calories only, no macros**. Bad for a protein-tracking audience.

**Stopgap already shipped:** chicken breast, paneer, tofu, egg whites were
hand-added to the curated list in `src/foods.js` with standard reference values
(from general knowledge, NOT a sourced file — see note below).

**Real fix:** import IFCT 2017 (Indian Food Composition Tables, ICMR-NIN,
~528 raw foods, lab-derived) as a second reference source in Supabase, and have
the Tier-2 lookup search ingredients as well as recipes.

**Risk / effort:** 20-30 min IF a clean machine-readable IFCT file exists;
1-2 hrs if it's only the published PDF and needs parsing. **Source the data
first** before committing to the task. INDB's GitHub repo carries foreign FCTs
(US/UK/USDA) but not a clean Indian raw-items sheet — needs a separate hunt.

**Note on current curated values:** chicken breast 165 kcal / 31P / 0C / 3.6F
per 100g etc. are standard USDA/IFCT-equivalent figures typed from memory, not
traced to a repo file. Accurate, but replace with sourced numbers when IFCT lands.

---

## 2. LLM estimate as a guardrail on INDB matches (hybrid resolution) — DONE 2026-07-10

Shipped. `applyReference` in `src/db.js` now rejects an INDB match whose kcal is
outside ~0.5x-2x of the LLM's own per-serving estimate (a wrong recipe like
"honey" -> "Honey cake"). Zero extra latency. Left here as a record.

---

## 3. Source tag in logs (which tier answered each food)

**Problem:** no way to see whether a logged item came from the curated list,
INDB, or the LLM estimate — so bad INDB over-matches are invisible until a user
notices a weird number.

**Fix:** tag each resolved item with its source tier (`curated` / `indb` /
`llm-est` / `placeholder`) and print it to `nutridesi.log` (not the user reply).
Turns "trust the threshold" into "audit what actually happened." Also the natural
signal for which foods to promote into the curated list next.

**Where:** `resolveItem` + `applyReference` in `src/db.js` set the tag; the
request log line in `server.js` prints it.

**Effort:** ~20 min. Good to do alongside #3 since both touch the same code.

---

## 4. Per-item kcal sanity cap (catch count-amplified wrong matches)

**Problem:** the quantity fix (real counts, not capped at 3) means a wrong match
to a bowl/plate item gets multiplied and explodes. Seen in QA: "chicken tikka
6 pieces" matched a gravy dish and hit **1920 kcal** for one item before it was
fixed. The NO CROSS-FOOD MATCHING prompt rule (2026-07-10) addresses the cause,
but a wrong match could still slip through and get Nx'd.

**Fix:** a backstop in `resolveItem` / `logMeal` — if a single logged item
exceeds a sane ceiling (~1200 kcal), it's almost certainly a count applied to a
portion-unit food. Options: soften to a flagged estimate, or re-check that a
large integer count isn't being applied to a bowl/plate/glass/serving unit
(counts should pair with piece-like units). Don't hard-clamp legit big meals
(e.g. 20 rotis = 1780 is real) — key on the count x portion-unit mismatch, not
raw kcal alone.

**Where:** `resolveItem` in `src/db.js` (has both quantity and the food's unit).

**Effort:** ~30 min + testing (chicken-tikka-style inputs vs legit high counts).

---

## Ordering note

Do #1 (data sourcing) exploratory first — it's the only one with unknown scope.
#3 and #4 touch the same resolver code in `db.js`, so batch them in one pass.
All are quality/safety upgrades; ship behind a real-user retention signal, not
before it (per the D7 kill-criteria in CLAUDE.md).
