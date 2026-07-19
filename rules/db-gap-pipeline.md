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
   (150); Paneer Bhurji (124) needs the explicit word. Alias containment in
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
