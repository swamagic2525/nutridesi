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

## 2. LLM estimate as a guardrail on INDB matches (hybrid resolution)

**Problem:** the INDB fuzzy match can return a confident-but-wrong recipe for an
item the databank doesn't really have (seen live: "papad" -> "Raw papaya with
coconut" 199 kcal; "chicken breast" -> "chicken sandwich"). The bare 0.75
`word_similarity` threshold catches most, but not all, and a wrong match
overwrites what would have been a decent LLM estimate.

**Fix:** the parse call already returns the LLM's `est_kcal` for every
non-curated item, for free, in the same request. Use it as a sanity check:
accept the INDB match's macros **only if its kcal is within ~0.5x-2x of the LLM
estimate**; otherwise discard the INDB match and use the LLM estimate. Zero
extra latency (both numbers already in hand). Makes the LLM a veto *on* INDB
rather than just a fallback *after* it.

**Where:** `applyReference` / `refLookup` path in `src/db.js`.

**Effort:** ~30 min + testing against the known bad matches (papad, chicken).

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

**Effort:** ~20 min. Good to do alongside #2 since both touch the same code.

---

## Ordering note

Do #1 (data sourcing) exploratory first — it's the only one with unknown scope.
#2 and #3 touch the same resolver code in `db.js`, so batch them in one pass.
All three are quality/auditability upgrades; ship behind a real-user retention
signal, not before it (per the D7 kill-criteria in CLAUDE.md).
