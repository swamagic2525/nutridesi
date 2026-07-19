# Correction & Removal Framework

Single source of truth for how NutriDesi handles user corrections and deletions.
Any code change touching these behaviors must stay consistent with this document.

---

## Definitions

| Term | Meaning |
|---|---|
| **Batch** | The set of items logged from a single WhatsApp message (1–N items) |
| **Last batch** | The most recent batch for this user (regardless of meal boundary) |
| **Older batch** | Any batch that is NOT the most recent |
| **Correction** | Changing one or more attributes (kcal, protein, name, quantity) of an already-logged item |
| **Removal** | Deleting one or more already-logged items entirely |
| **Scope** | Which items the user's message targets |

---

## The Two Gates

Every correction or removal passes through two sequential gates:

### Gate 1 — Scope Detection

Determine whether the user is targeting the last batch or something older.

| Signal | Scope |
|---|---|
| No time/meal reference, pronoun correction ("it was", "that was"), bare undo | **Last batch** |
| "meal 1", "breakfast", "lunch", "this morning", "yesterday", time reference pointing to an older entry | **Older batch** |
| Named food that exists ONLY in last batch | **Last batch** |
| Named food that exists ONLY in an older batch | **Older batch** |
| Named food that exists in BOTH last and older batches | **Last batch** (recency wins; user can disambiguate) |

**Rule:** If scope cannot be determined, default to last batch. Users rarely modify beyond the immediate meal.

### Gate 2 — Confirmation Gate

| Scope | Action |
|---|---|
| Last batch | Execute immediately. Show transparent note of what changed. |
| Older batch | Show proposed change, wait for "yes" before executing. Never silently touch history. |

**Confirmation format (removal):**
```
I'll remove from [time/meal]:
- Roti ×2 (178 kcal)
- Dal Tadka (180 kcal)
Total: −358 kcal from today. Confirm?
```

**Confirmation format (correction):**
```
I'll update [food] from [time/meal]:
  [old value] → [new value]
Confirm?
```

**Intent preemption applies:** If the user sends a new food while the bot is waiting for confirmation, abandon the pending action and log the new food. Conversations never deadlock.

---

## Attribution Ladder

Once scope identifies which batch to target, the attribution ladder identifies WHICH item(s) within that batch to act on. The ladder is tried top-down; first match wins.

### Rung 1 — Explicit scope words

Keywords that unambiguously name the scope:

| Keyword | Interpretation |
|---|---|
| "each", "per" | Correction applies per-unit; preserve original quantity. `stated_kcal × quantity = total` |
| "all", "total", "whole meal" | Correction applies to the entire batch as a unit |
| "the [food name]" with article | Targets specifically that named item |
| "last", "previous" | Targets the single most recent item (not batch) |

**Rule:** If an explicit scope word is present, skip rungs 2–5. The word IS the answer.

### Rung 2 — Named food (word overlap)

The user names a food that overlaps with a row in the target batch.

**Algorithm:**
1. Tokenize the correction hint into words (>2 chars)
2. For each row in the batch, count how many hint-words appear in the row's food_name
3. Highest score wins (ties: prefer the row with `is_estimate: true`)
4. Minimum threshold: at least 1 word must match

**Atomicity rule:** If the parser emits N correction hints, each must align 1:1 with a row. If any hint cannot be aligned, refuse that hint (return null) rather than guessing. Partial alignment is allowed — aligned hints execute, unaligned hints are reported to the user.

### Rung 3 — Sole flagged item

When there's no name overlap (e.g., brand rename "MB biozyme whey isolate" vs row named "Protein Shake"), target the sole item that the bot previously flagged as uncertain:

**Priority order:**
1. Sole uncurated item (`matched_db_id == null`) — the bot explicitly said "I don't know this"
2. Sole non-gram estimate (`is_estimate: true` AND food_name does NOT start with `\d+(\.\d+)?(g|ml)`) — the bot made an assumption the user might correct

**Gram-row exclusion:** Items whose food_name starts with a weight (e.g., "30g Milk") are NEVER correction targets via this rung. The user weighed those; their `is_estimate` flag reflects DB averages, not an assumption worth correcting.

**Refusal:** If there are 2+ candidates at the same priority level, refuse (return null → dead-end message asks user to name the item). Never guess between ambiguous targets.

### Rung 4 — Magnitude fit (NOT YET IMPLEMENTED)

When rung 3 has multiple near-flagged candidates, use the stated correction value to pick the most plausible target:

**Credibility band:** `0.4× ≤ (stated_kcal / row_kcal) ≤ 2.5×`

- If exactly one candidate falls within the band → that's the target
- If zero or multiple candidates fall within → fall through to rung 5
- **Override prohibition:** Magnitude NEVER vetoes a rung-3 sole-flagged item. A flagged estimate can be arbitrarily wrong (User A's whey: 24→200 = 8.3×, and correct). Magnitude only refines when rung 3 itself is ambiguous.

### Rung 5 — Whole-meal default (NOT YET IMPLEMENTED)

When no individual item can be identified, treat the correction as applying to the entire batch:

**Conditions for activation:**
- Rungs 1–4 all failed to identify a single target
- The stated value is within the credibility band of the batch total (0.4×–2.5× of sum)
- The batch has ≤5 items (larger batches are too ambiguous to scale)

**Scaling:** Distribute the correction proportionally across all items in the batch based on their current kcal share.

**Protein check:** If the user states protein AND kcal, and the protein/kcal ratio is physiologically implausible for the food types in the batch (>40% of calories from protein for a carb-heavy meal), refuse and ask which item they mean.

---

## Removal Rules

### "Undo" (bare, no qualifier)

- Removes the entire last batch (all items from the most recent message)
- Instant, no confirmation
- Response: "Removed: [list]. −[N] kcal from today."

### "Remove [food name]"

- Removes the named item(s) from the last batch only
- Uses Rung 2 (word overlap) for identification
- If the named food is NOT in the last batch → triggers Gate 2 (scope = older, confirm first)
- If the name matches multiple rows in the batch → remove all matches (user said the name, they mean all of them)

### "Remove meal N" / "Remove breakfast" / "Remove today"

- Scope = older batch (always)
- Gate 2 applies: show full list of what will be removed, wait for confirmation
- Meal grouping: batches within a 45-min window sharing the same `meal_time_inferred` value constitute one meal
- "Today" = all batches from the current IST calendar day

### Repeated "undo"

- Each "undo" removes one batch further back (stack behavior)
- After 3 consecutive undos, proactively say: "You can also say 'remove meal 1' or 'remove breakfast' to clear a whole meal at once."

---

## Dead-End Handling

The bot must NEVER leave a correction/removal in a dead state. If attribution fails:

**Message:** "Which item should I change? Name it and I'll fix it."

**Do NOT:**
- Suggest "undo" (which nukes the whole batch — this caused the User-A cascade)
- Ask the user to estimate calories themselves
- Silently do nothing

---

## Parser Contract for Corrections

The LLM must emit these fields for any correction/removal intent:

```json
{
  "intent": "replace_last" | "delete_last" | "delete_item",
  "items": [
    {
      "food_name": "the food to target (or null if bare correction)",
      "matched_db_id": null,
      "stated_kcal": 200,
      "stated_protein": 36,
      "quantity": 1.0,
      "scope_word": "each" | "all" | "total" | null
    }
  ],
  "delete_scope": "last" | "item" | "meal_N" | "today" | null
}
```

**`delete_scope` values:**
- `"last"` — undo most recent batch
- `"item"` — remove specific named item(s)
- `"meal_N"` — remove Nth meal of the day (N = 1, 2, 3...)
- `"today"` — remove all items from today
- `null` — correction (not removal)

---

## State Machine

```
USER MESSAGE
     │
     ▼
┌─────────────┐
│ Is it a     │──no──▶ [normal log flow]
│ correction/ │
│ removal?    │
└─────┬───────┘
      │ yes
      ▼
┌─────────────┐
│ Scope       │
│ Detection   │──▶ last batch? ──▶ Attribution Ladder ──▶ EXECUTE
└─────┬───────┘                                            (show note)
      │ older batch
      ▼
┌─────────────┐
│ Attribution │
│ Ladder      │
└─────┬───────┘
      │
      ▼
┌─────────────┐
│ Show        │
│ Proposed    │──▶ user says "yes" ──▶ EXECUTE
│ Change      │
└─────┬───────┘
      │ user sends food / ignores
      ▼
   ABANDON (intent preemption)
```

---

## Changelog

| Date | Change |
|---|---|
| 2026-07-19 | Initial framework. Covers Classes A–G from incident dataset. |
