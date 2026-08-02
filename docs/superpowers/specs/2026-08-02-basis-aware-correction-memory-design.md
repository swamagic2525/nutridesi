# Basis-Aware Correction Memory Design

## Goal

Remember a user's nutrition correction with its real basis and provenance, so a
statement such as "26g protein per 100g" scales to every later quantity without
crossing into another product variant.

## Decisions

- Correction memory remains per-user. A label conflict does not mutate the shared
  curated or reference catalogs.
- Exact memory keys retain parenthetical variant text. Fuzzy subset matching is
  allowed only for explicit `forget`/`change` commands.
- A correction stores `basis_amount` and `basis_unit` plus independent protein and
  calorie values/provenance. `user_confirmed` fields override resolution;
  `parser_inferred` fields provide a stable estimate only when no catalog source
  exists; `catalog` fields are informational and do not freeze catalog updates.
- The stored source assertion is reconstructed from structured nutrition fields,
  not copied from unrestricted WhatsApp text.
- Explicit grams/ml survive reference matching. Reference per-100g nutrition is
  scaled to the consumed amount before a memory override is applied.
- A malformed `replace_target` on a nutrition correction falls through to normal
  correction targeting. A genuine food-for-food swap keeps the strict refusal.
- Existing oats, milk, and protein-powder memories are rewritten in the same
  migration that adds the new columns. No phone number appears in committed SQL.

## User experience

When a memory applies, the note states both the scaled result and saved basis:

```text
🧠 Using your confirmed label value: 26g protein per 100g.
```

`my corrections`, `saved corrections`, and `what do you remember` list saved
records with provenance and numbered `forget`/`change` instructions.

## Safety

- Incompatible units and different exact variant keys never receive an override.
- Legacy rows remain readable during deployment, but new writes use the basis-aware
  columns after the migration is applied.
- The migration is additive except for the targeted rewrite of the three known
  memory records. Their old values remain in the legacy columns for rollback.
- Deployment order is migration, tests/evals, Node restart, then production readback.

## Acceptance cases

1. Correct Chocolate oats to 26g protein per 100g.
2. Log 75g Chocolate oats and receive 19.5g protein.
3. Log 50g Chocolate oats and receive 13g protein.
4. Log Mango oats and do not apply the Chocolate correction.
5. Correct 350ml milk to 12g protein and 217 kcal; later quantities scale.
6. Correct one scoop and log two scoops; count-based scaling still works.
7. A protein-only correction does not promote existing calories to
   `user_confirmed`.
8. The first correctly parsed nutrition correction does not dead-end because of a
   bad `replace_target`.

