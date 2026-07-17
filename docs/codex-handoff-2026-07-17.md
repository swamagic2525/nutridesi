# Codex Handoff — 17 July 2026

This note records the correction-safety work Codex shipped to `main`. It is
intended as the factual handoff for any later work in Claude Code.

## Shipped

### Latest-log-only corrections (Layer 1)

Implicit corrections no longer search through the whole day or the 45-minute
meal cluster. They can affect only the immediately preceding inbound log batch
(all rows with the latest shared `logged_at` timestamp).

- `undo`, `remove <food>`, and `replace_last` are local to that batch.
- A correction that names an item in a multi-item message changes only that
  item.
- A rename with no matching words (for example, `sorry, it was rajma`) can
  replace a one-item previous log.
- An ambiguous correction against a multi-item batch makes no change and asks
  the user to name the item. This is intentional: no partial or surprise edits.
- Multi-item corrections are atomic. If one target cannot be found, nothing is
  deleted or replaced.

### Context-aware correction parsing (Layer 2)

For correction-shaped messages only, the backend fetches the immediately
preceding log batch before calling the LLM. It adds a compact, trusted context
block to the parser request: food name, quantity, calories, protein, and whether
the row was estimated.

This grounds messages such as:

```text
Cake slice was 150 kcal, 5g protein
it was 170 calories
I had 3 of them
Chicken breast was 50g
```

Normal food logging does **not** make this extra database lookup, preserving the
existing fast path.

### Deterministic backstops

`src/correctionContext.js` contains small pure helpers that protect against an
LLM intent miss:

- Detect correction-shaped text, including a raw weight restatement such as
  `Chicken breast was 50g`.
- Promote a clear stated-calorie/protein correction from `log` to
  `replace_last` only when it refers to the latest batch.
- Match an item by its curated `matched_db_id` when the LLM correctly returns an
  ID but leaves `food_name` null. This was necessary for a multi-item test where
  `Chicken breast was 50g` had to select Chicken Breast—not roti, chai, bhel, or
  whey.
- Treat an empty pre-fetched batch as absent and re-query the latest batch. This
  fixes JavaScript's `[]`-is-truthy edge case that initially blocked the lookup.

## Files changed

| File | Change |
|---|---|
| `server.js` | Fetches last-log context only for likely corrections; routes all implicit corrections to the latest batch. |
| `src/parser.js` | Accepts optional recent-log context and passes it with the current message to every LLM provider. |
| `src/systemPrompt.js` | Tells the model how to treat trusted recent-log context and limits its correction scope. |
| `src/db.js` | Adds `lastLogBatch` and latest-batch-only matching/deletion helpers. |
| `src/correctionContext.js` | New pure correction detection, context formatting, and stable target matching helpers. |
| `test/correction-context-test.js` | Eight offline regression cases. |
| `package.json` | Adds `npm run test:corrections`. |

## Validation completed

```bash
npm run test:corrections
```

Passes eight offline cases, including target matching by curated food ID inside a
multi-item batch.

Live parser checks (using the configured provider) also passed:

- `Cake slice was 150 kcal, 5g protein` → `replace_last`
- `it was 170 calories` → `replace_last`
- `I had 2 eggs and toast` → normal `log`
- `Chicken breast was 50g` → `replace_last`, `grams: 50`, Chicken Breast ID

## Commits already on `main`

- `2a83102` — Fix corrections with last-log context
- `e8519ac` — Target gram corrections inside latest log

The supervised Mac Mini service was restarted after `e8519ac`, so these changes
are live.

## Deliberately not shipped

These were discussed but are not implemented:

- User-facing serial/log references such as `#12`
- Persistent `log_group_id` / Twilio MessageSid stored in `user_logs`
- Explicit correction affordances for each uncertain line item
- Cooking-fat nudge for raw ingredients
- Any pre-log confirmation gate

The recommended next step is to display explicit, item-specific correction
affordances **after** provisional/assumed logs, while retaining immediate logging.
