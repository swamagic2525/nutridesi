# Correction & Undo Incidents — the unhappiness dataset

Mined 2026-07-19 from the full Twilio history (1,314 messages, 110 users):
every message where a user corrected, undid, or fought the bot. These are the
moments users were unhappy — each one is a labeled example of what the
attribution framework must handle. Update this file whenever a new incident
class appears; graduate each class into `evals/cases.jsonl` (parser-level) or
backend unit tests (matchRows / replace_last shapes).

Framework reference (attribution ladder): 1 explicit scope words → 2 named
food → 3 sole flagged item → 4 magnitude fit → 5 whole-meal default, always
act-with-override, never dead-end.

---

## Class A — bare "it was N cal/protein" vs multi-item batch  ⬛ FIXED 2026-07-19

The Priyanka Garg incident (2026-07-19 04:27–04:31). 5-item breakfast, whey
mis-logged at 24 kcal (grams leak), callout invited "reply 'it was 200
calories'", she complied → dead-end → "Undo" nuked the whole meal → she
re-typed everything.

- Fix shipped: matchRows sole-flagged fallback (uncurated first, else sole
  non-gram estimate) + dead-end copy no longer suggests undo + grams-leak
  prompt rule. Eval: `scope-scoop-with-milk`; unit shapes in this class pass.
- Ladder rung: 3. **Verdict: resolved.**
- ⚠️ Watch: first live firing (04:47 Swapnil test, "1 masala dosa with
  sambhar" → "It was 200 calories and 36g protein") picked **Sambar** (the
  sole inferred-portion estimate). Magnitude fit (rung 4) would have preferred
  Masala Dosa (220→200 = 0.9×) or whole meal (300→200 = 0.67×) over Sambar
  (80→200 = 2.5×). Rung 4 should *refine within* rung 3's candidates when
  several are near-flagged — revisit when rung 4 is built. NOTE: magnitude
  must never veto a flagged uncurated item (Priyanka's whey was 24→200 =
  8.3×, and correct) — flagged estimates can be arbitrarily wrong.

## Class B — named rename correction eats sibling items  ⬛ FIXED 2026-07-19

Two independent users:
- 2026-07-13 •2531: "Cup of Coffee wasn't black, it was with skimmed milk"
  → bot deleted Black Coffee AND Chia Seeds, logged only Low-Fat Milk. User
  had to re-correct; ended with duplicate entries.
- 2026-07-15 •5400: 5-item breakfast, "It was muscle blaze biozyme whey
  isolate. That has 27 grams of protein" → bot deleted ALL FIVE items,
  replaced with one 120-kcal row. User re-sent the whole meal.

A rename/spec of ONE item must replace only that item; siblings stay.
- Ladder rung: 2 (named), with atomicity: parser must emit exactly one item;
  backend must align 1:1 or refuse.
- Eval cases added: `corr-rename-one-of-five`, `corr-rename-not-black` (both
  pass — parser already emits one item; the live failures were backend).
- Backend fixed: matchRows now falls back to the sole flagged item when a
  named hint has zero word overlap with every row (the "MB biozyme whey
  isolate" vs "Protein Shake" shape). Word-overlap renames already aligned
  1:1. Unit shapes: test/correction-test.js (7 shapes).

## Class C — "each" + stated kcal loses the count  🟨 PARTIAL

2026-07-16 •0851: "Bun ×2 — 500 kcal" → "Bun is 150 cal each with 2 G
protein" → bot logged Bun ×1 at 150 (lost the ×2). Later same session:
"Each bun is 200 cal" → ✅ bun — 200 kcal (should be ×2 = 400). The
frustration cascade that followed ("Remove bun" → "Remove" → whole meal
deleted → re-typed) is this class's real cost.
- The `each`-restores-quantity rule exists in server.js (line ~341) but did
  not fire here. Needs a backend unit test on the exact shape:
  old row qty 2 + "each" + stated_kcal → new qty 2, kcal 400.
- Ladder rung: 1 (explicit scope word "each"). **Verdict: rule exists,
  under-tested.**

## Class D — correction logged as a NEW item (double-count)  ⬛ mostly fixed

Jul 9–14 era, before shouldPromoteToReplace: "Sorry it was Pani puri",
"I meant Sev puri", "Make it rajma instead", "It was veg" → each ADDED a new
item; one user's meal hit 3,252 kcal from a chain of these. Modern sessions
(Jul 15+) show 🔄 Corrected firing properly.
- Jul 14 •6062 shape still relevant: user re-stated TWO items with calories
  ("Jalapeno chicken pocket - 200 calories / pesto mozarella sandwich - 390
  calories") → logged as new duplicates, meal showed 2632 kcal; user asked
  "wrong lunch calculation, i had total 590 calories right?" and got a day
  total instead of a fix. Two-item named+stated corrections must
  replace_last both items. Eval: `corr-two-named-stated`.

## Class E — undo granularity: users think in meals, bot thinks in batches  🟥 OPEN

- "Undo all meal 1" → removed only the last batch (1 of 2 items).
- "Delete 1st meal of today, it was for yesterday" → removed the LAST batch
  (cucumber+carrot), not meal 1; user then fought it ("No that, remove
  chicken breast and keep cucumber").
- "Undo today's entry's" → removed only one batch. Triple-"Undo" spam
  (•6863) to clear a day, one batch at a time.
- "Remove meal 1" (•1870) DID work — the capability exists but is
  inconsistent.
- Design decision needed (v1 scope call): support "meal N" / "today" as undo
  scopes, or explicitly reply what undo does ("removes last message — say
  'remove meal 1' / send items to re-log"). Silent wrong-scope deletion is
  the trust killer here.

## Class F — macro-only correction  🟨 rare but interesting

2026-07-16 •2101: "Remove protein content" after a custom 740-kcal breakfast
(logged with auto-split 46g protein) → bot deleted the whole meal. User
wanted protein set to ~0, kcal kept. They eventually typed "Add 740 calories
with 10g protein 40 cal chutney with 1g protein" — power-user syntax that
worked. Low priority; note that stated_protein-only corrections exist
(`stated-protein-only` eval passes).

## Class G — whole-meal scaling (rung 5)  ✅ validated as RARE

In 35 unique incidents, **zero** were unambiguous whole-meal stated-total
corrections. Closest: "i had total 590 calories right?" (a confirmation
question, best answered as a query showing the math). Conclusion: rung 5
scaling is a tail case — build rungs 1–4 first; rung 5's main job is the
"dosa with sambar → it was 200" two-item homemade case, gated by the
credibility band (stated within ~0.4–2.5× of the batch sum, protein checked
independently).

---

## Framework scorecard against this dataset

| Class | Incidents | Ladder rung | Status |
|---|---|---|---|
| A bare-it vs multi-item | 3 users | 3 | fixed, eval'd |
| B rename eats siblings | 2 users | 2 | fixed, unit-tested |
| C each × quantity | 1 user, cascade | 1 | rule exists, needs unit test |
| D correction-as-new-log | 5+ (mostly old code) | 2 | fixed; 2-item shape eval'd |
| E undo scope (meal N) | 4 users | n/a (undo, not correction) | **open — design call** |
| F macro-only | 1 user | 1 variant | backlog |
| G whole-meal scaling | 0 clean hits | 5 | build last |

Priority from real data (B done): **C → E**, then rung-4 magnitude
refinement, then G.
