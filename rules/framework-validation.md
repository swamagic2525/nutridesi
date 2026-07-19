# Framework Validation Against Incident Dataset

Every incident from `docs/correction-incidents.md` run through the correction
framework rules. For each: what the user said, what the framework prescribes,
whether current code handles it, and any gap.

---

## Class A — Bare "it was N cal" vs multi-item batch

### Incident A1: User A (2026-07-19)

**Context:** 5-item breakfast batch. Whey mis-logged at 24 kcal (grams leak). Bot
callout invited "reply 'it was 200 calories'". She complied.

**User said:** "It was 200 calories and 36g protein"

**Framework trace:**
1. Gate 1 (Scope): Pronoun "it was" + no time reference → **last batch**
2. Gate 2: Last batch → **execute immediately**
3. Attribution: No food name in message → Rung 2 fails (zero word overlap)
4. Rung 3: Sole flagged item check →
   - Uncurated items: "30g Wholetruth cold coffee whey protein" (matched_db_id = null) → **1 uncurated item**
   - Target: whey protein row
5. Action: Replace whey row with stated_kcal=200, stated_protein=36

**Prescribed outcome:** Whey row updated to 200 kcal, 36g protein. Other 4 items untouched.

**Code status:** ✅ FIXED. matchRows sole-flagged fallback handles this. Unit test passes.

---

### Incident A2: Swapnil test (2026-07-19, post-fix)

**Context:** 2-item batch: Masala Dosa (220 kcal, curated) + Sambar (80 kcal, curated, is_estimate=true due to inferred portion).

**User said:** "It was 200 calories and 36g protein"

**Framework trace:**
1. Gate 1: Pronoun → **last batch**
2. Gate 2: → **execute immediately**
3. Attribution: Rung 2 fails (no food name). Rung 3:
   - Uncurated items: 0
   - Non-gram estimates: Sambar (is_estimate=true, not gram-prefixed) → **1 sole estimate**
   - Target: Sambar
4. Action: Replace Sambar with stated_kcal=200, stated_protein=36

**Prescribed outcome:** Sambar updated to 200 kcal. Dosa untouched.

**Known issue:** This is technically wrong — 200 kcal for a 2-item meal (dosa+sambar) more likely means the whole meal was 200, or the dosa specifically (220→200 = 0.9× is a tighter fit than 80→200 = 2.5×). But rung 4 (magnitude fit) is NOT YET IMPLEMENTED, and rung 3's rule is "sole flagged wins, magnitude never vetoes flagged."

**Code status:** ✅ Works as designed. Rung 4 refinement is a future improvement flagged in the framework. The framework explicitly states magnitude never vetoes a sole-flagged item (User A's 24→200 = 8.3× was correct).

**Gap:** When rung 4 is built, it should surface a soft signal: "Updated Sambar to 200 kcal. (Did you mean the whole meal? Say 'total was 200' next time.)" — educational, not blocking.

---

## Class B — Named rename correction eats siblings

### Incident B1: •2531 (2026-07-13)

**Context:** 2-item batch: Black Coffee + Chia Seeds. User wants to change Black Coffee to coffee with skimmed milk.

**User said:** "Cup of Coffee wasn't black, it was with skimmed milk"

**Framework trace:**
1. Gate 1: No time reference, food name "coffee" exists in last batch → **last batch**
2. Gate 2: → **execute immediately**
3. Attribution: Rung 2 — words: ["cup", "coffee", "wasn", "black", "skimmed", "milk"]
   - "Black Coffee": matches "coffee", "black" → score 2
   - "Chia Seeds": matches nothing → score 0
   - Winner: Black Coffee ✓
4. Action: Replace Black Coffee with "Coffee with Skimmed Milk" (re-parse for kcal)

**Prescribed outcome:** Black Coffee replaced. Chia Seeds untouched.

**Code status:** ✅ FIXED. Word overlap correctly identifies Black Coffee. Atomicity rule (1 hint → 1 row) prevents sibling deletion.

---

### Incident B2: •5400 (2026-07-15)

**Context:** 5-item batch: Protein Shake, Poha, Peanuts, Egg Whites, Egg (Fried/Half Fry). User wants to rename Protein Shake to the specific brand.

**User said:** "It was muscle blaze biozyme whey isolate. That has 27 grams of protein"

**Framework trace:**
1. Gate 1: Pronoun "it was" → **last batch**
2. Gate 2: → **execute immediately**
3. Attribution: Rung 2 — words from hint: ["muscle", "blaze", "biozyme", "whey", "isolate"]
   - "Protein Shake": 0 overlap
   - "Poha": 0 overlap
   - All others: 0 overlap
   - Rung 2 fails (no word matches threshold)
4. Rung 3: Sole flagged item:
   - Uncurated: 0
   - Non-gram estimates: Protein Shake (is_estimate=true) → **1 sole estimate**
   - Target: Protein Shake ✓
5. Action: Replace Protein Shake with "MB Biozyme Whey Isolate", stated_protein=27

**Prescribed outcome:** Protein Shake replaced. Other 4 items untouched.

**Code status:** ✅ FIXED. Sole-flagged fallback fires after word-overlap fails. Unit test `rename: zero-overlap brand -> sole estimate` passes.

---

## Class C — "each" + stated kcal loses the count

### Incident C1: •0851 (2026-07-16)

**Context:** Batch contains Bun ×2 (logged as quantity=2). User corrects per-unit.

**User said:** "Each bun is 200 cal"

**Framework trace:**
1. Gate 1: Named food "bun" in last batch → **last batch**
2. Gate 2: → **execute immediately**
3. Attribution: Rung 1 — explicit scope word **"each"** → per-unit correction
   - Rule: preserve original quantity. stated_kcal applies per unit.
   - Calculation: 200 kcal × quantity 2 = 400 kcal total for the row
4. Action: Update Bun row to kcal_per_unit=200, total_kcal=400, quantity stays 2

**Prescribed outcome:** Bun ×2 → 400 kcal total (200 each). Quantity preserved.

**Code status:** 🟨 PARTIAL. The `each` rule exists in server.js (~line 341) but the incident shows it didn't fire. The rule likely has a code path issue where it doesn't restore the original quantity from the row being replaced. Needs a backend unit test on this exact shape: `old row qty 2 + "each" + stated_kcal → new qty 2, kcal 400`.

**Gap:** Unit test needed. The framework correctly prescribes the behavior; the code has a bug in the execution path.

---

## Class D — Correction logged as NEW item (double-count)

### Incident D1: Pre-shouldPromoteToReplace era (Jul 9–14)

**Context:** User corrects an item but the bot interprets it as a new food to log.

**User said:** "Sorry it was Pani puri" / "I meant Sev puri" / "Make it rajma instead"

**Framework trace:**
1. Gate 1: Correction language ("sorry it was", "I meant", "make it") → enters correction flow
2. `shouldPromoteToReplace` detects: intent was logged as "log" but matches correction pattern → promote to "replace_last"
3. Attribution: Rung 2 (named food) identifies target
4. Action: Replace, don't add

**Code status:** ✅ FIXED (Jul 14). `shouldPromoteToReplace` function handles this. Modern sessions show 🔄 Corrected firing.

---

### Incident D2: •6062 (2026-07-14) — Two-item named correction

**Context:** User logged a meal, then sent a message naming two items with calories.

**User said:** "Jalapeno chicken pocket - 200 calories / pesto mozzarella sandwich - 390 calories"

**Framework trace:**
1. Gate 1: Named foods + stated calories → correction pattern → **last batch**
2. Gate 2: → **execute immediately**
3. Attribution: Rung 2 for EACH hint:
   - "Jalapeno chicken pocket" → matches row with word overlap
   - "Pesto mozzarella sandwich" → matches row with word overlap
4. Atomicity: 2 hints → must align 2 rows 1:1. Both align → proceed.
5. Action: Replace both rows with stated values (200, 390)

**Prescribed outcome:** Both items corrected in place. No new rows added. No siblings touched.

**Code status:** 🟨 Eval case `corr-two-named-stated` exists and parser handles it. Backend multi-item replace may need verification that it handles N>1 replacements atomically.

---

## Class E — Undo granularity (meal scope)

### Incident E1: "Undo all meal 1"

**Context:** User has multiple meals logged today. Wants to remove the first meal entirely.

**User said:** "Undo all meal 1"

**Framework trace:**
1. Gate 1: "meal 1" → explicit older-batch reference → **older batch**
2. Gate 2: **Confirm before executing**
   - Bot identifies meal 1 (earliest 45-min cluster today)
   - Shows: "I'll remove meal 1 (breakfast): Roti ×2, Dal, Chai — 447 kcal total. Confirm?"
3. User says "yes" → execute removal of all items in that meal cluster

**Prescribed outcome:** Full meal removed after explicit confirmation. Current meal untouched.

**Code status:** 🟥 NOT IMPLEMENTED. Current "undo" always removes last batch only. Meal-scoped deletion with confirmation flow does not exist yet.

---

### Incident E2: "Delete 1st meal of today, it was for yesterday"

**Context:** User wants to move/remove an older entry.

**User said:** "Delete 1st meal of today, it was for yesterday"

**Framework trace:**
1. Gate 1: "1st meal of today" → **older batch**
2. Gate 2: **Confirm:**
   - "I'll remove meal 1 from today: [list]. −[N] kcal. Confirm?"
   - Note: "it was for yesterday" implies re-logging under yesterday. Framework does NOT support re-dating in v1. Confirm message can note: "I'll remove it from today. To log it under yesterday, send it again and say 'this was yesterday.'"
3. User confirms → remove

**Prescribed outcome:** Items removed after confirmation. Re-dating is a separate future feature, not handled in this flow.

**Code status:** 🟥 NOT IMPLEMENTED.

---

### Incident E3: Triple "undo" spam (•6863)

**User said:** "Undo" → "Undo" → "Undo"

**Framework trace:**
1. Each "undo" = bare, no qualifier → Gate 1: **last batch** (the most recent remaining)
2. Each undo removes one batch, working backwards (stack behavior)
3. After 3rd consecutive undo, bot proactively says: "You can also say 'remove meal 1' or 'remove breakfast' to clear a whole meal at once."

**Prescribed outcome:** Three batches removed sequentially. Educational nudge on 3rd.

**Code status:** 🟨 PARTIAL. Sequential undo works. The educational nudge after 3 consecutive undos is NOT implemented.

---

### Incident E4: "Remove meal 1" (•1870) — worked

**User said:** "Remove meal 1"

**Framework trace:**
1. Gate 1: "meal 1" → **older batch**
2. Gate 2: Confirm → user confirms → execute

**Note:** This incident WORKED in production, meaning some version of meal-scoped removal exists but is inconsistent. Need to find the code path that handled this and make it reliable.

**Code status:** ⚠️ Inconsistent. Works sometimes; the conditions under which it fires need investigation.

---

## Class F — Macro-only correction

### Incident F1: •2101 (2026-07-16)

**Context:** Custom 740-kcal breakfast logged with auto-split protein (46g). User wants to keep kcal, zero out protein.

**User said:** "Remove protein content"

**Framework trace:**
1. Gate 1: No time reference, refers to recent log → **last batch**
2. Gate 2: → **execute immediately**
3. Attribution: "Remove protein content" → scope word analysis:
   - "Remove" = removal intent? Or modification (set to 0)?
   - Framework interpretation: This is a CORRECTION (set protein to 0), not a removal of items. The user wants to keep the 740 kcal row but null out protein.
4. Rung 1: "protein content" is an explicit attribute scope, not a food name
5. Action: Set protein=0 for all items in last batch. Keep kcal unchanged.

**Prescribed outcome:** All items in batch retain their kcal values. Protein set to 0 across the batch.

**Code status:** 🟥 NOT IMPLEMENTED. Current correction flow only handles kcal/food-name changes. Protein-only corrections (setting to 0 or a specific value without changing kcal) are not in the code path.

**Priority:** Low (1 incident, power-user syntax). The user self-recovered by re-logging with explicit values.

---

## Class G — Whole-meal scaling

### Incident G1: (theoretical — zero clean hits in dataset)

**User said:** (hypothetical) "Total was 500 calories"

**Framework trace:**
1. Gate 1: "total" = scope word → **last batch**
2. Gate 2: → **execute immediately**
3. Attribution: Rung 1 — "total" = explicit whole-meal scope
4. Rung 5 activation:
   - Check credibility band: stated 500 vs batch sum. If within 0.4×–2.5× → proceed
   - Scale proportionally: if Dosa=220, Sambar=80 (sum=300), and stated=500:
     - Dosa: 220/300 × 500 = 367 kcal
     - Sambar: 80/300 × 500 = 133 kcal
5. Action: Update all rows with proportional values

**Code status:** 🟥 NOT IMPLEMENTED. Zero real incidents — lowest priority.

---

## Summary Scorecard

| Class | Framework handles it? | Code implements it? | Gap |
|---|---|---|---|
| A (bare-it multi-item) | ✅ Rung 3 | ✅ Shipped | Rung 4 refinement (soft signal) |
| B (rename eats siblings) | ✅ Rung 2 + atomicity | ✅ Shipped | None |
| C (each × quantity) | ✅ Rung 1 "each" | 🟨 Rule exists, undertested | Unit test needed |
| D (correction as new log) | ✅ shouldPromoteToReplace | ✅ Shipped | Multi-item replace verify |
| E (undo scope) | ✅ Gate 2 confirm | 🟥 Not implemented | Meal grouping + confirm flow |
| F (macro-only) | ✅ Attribute-scope correction | 🟥 Not implemented | Low priority |
| G (whole-meal scaling) | ✅ Rung 5 | 🟥 Not implemented | Lowest priority (0 incidents) |

---

## Implementation Priority (from incident frequency × user pain)

1. **Class C unit test** — rule exists, just prove it works (30 min)
2. **Class E confirm flow** — 4 users hit this, trust-killer (half day)
3. **Rung 4 magnitude refinement** — soft signal, not blocking (2 hrs)
4. **Class F macro-only** — 1 user, power-user, backlog
5. **Rung 5 whole-meal scaling** — 0 incidents, build last

---

## Changelog

| Date | Change |
|---|---|
| 2026-07-19 | Initial validation. 7 classes, 10 incidents traced through framework. |
