# Claude Handoff — 2 August 2026

Read `docs/ai-onboarding.md`, then `CLAUDE.md`, then `README.md` before changing
anything. This note supersedes the original per-serving correction-memory model
described in the 1 August handoff.

## What changed

User-confirmed nutrition is now stored against its real label basis. A correction
such as `26g protein per 100g` is retained as that density, not as the scaled total
for whichever serving happened to be logged that day.

- `src/systemPrompt.js` returns `stated_basis_amount`, `stated_basis_unit`, and
  `portion_unit`; the model preserves label values and the backend performs scaling.
- `src/db.js` resolves curated/reference nutrition first and overlays only the
  user-confirmed fields. It preserves consumed grams/ml and field provenance.
- `src/correctionMemory.js` retains exact branded variants in keys, scales compatible
  quantities, persists bounded structured assertions, and keeps legacy rows working.
- A malformed nutrition `replace_target` falls through to semantic correction
  targeting instead of dead-ending.
- `my corrections` lists saved values and provenance; `forget 1` removes a row.
- The visible memory note shows the stored basis, for example
  `26g protein per 100g`, rather than only the consumed total.

## Production rollout completed

`correction-memory-basis.sql` was applied manually in the Supabase SQL editor
before the Node changes were deployed. It:

- adds basis, field provenance, structured source, and status columns;
- keeps legacy per-unit columns for rollback;
- adds bounded checks; and
- backfills the three existing named records without embedding phone numbers in
  the repository. The Yogabar key is rewritten to retain `Dark Chocolate` in the
  same transaction as its `26g protein per 100g` basis.

The three rows were read back without selecting `phone_number`; their exact keys,
bases, values, provenance, sources, and active statuses matched the migration. The
live service was restarted with:

```bash
launchctl kickstart -k gui/501/com.nutridesi.server
```

The local health endpoint returned `NutriDesi is running`, launchd reported the
service running, and the filtered post-restart log contained zero errors. A read-only
production resolution using the migrated memory returned 50g Yogabar oats as
202 kcal / 13g protein, with `memoryApplied: true` and a 100g basis.

## Required verification

- `npm run test:memcorr`
- `npm run test:routing`
- `npm run test:ref`
- `npm run test:dbshape`
- all other project test scripts
- `npm run test:brand`
- `node evals/run.js` — must be **162/162**
- public-repo PII/secrets scan

All checks above passed for the deployed build.

The regression that matters is a sequence: correct a 75g serving with a label value
of 26g protein per 100g, persist the memory, then log 50g and receive 13g protein.
The tests chain through the actual serialized memory shape to cover this.

## Deferred scope

- SKU/barcode-level identity is still future work; exact variant text is the minimal
  current boundary.
- Catalog conflicts are not auto-promoted from user reports.
- The broader `day_seq` concurrency race remains separate work; atomic correction
  replacement does not claim to fix normal-log sequence allocation.
