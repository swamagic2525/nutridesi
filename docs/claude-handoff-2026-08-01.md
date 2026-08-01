# Claude Handoff — 1 August 2026

Read `docs/ai-onboarding.md`, then `CLAUDE.md`, then `README.md` before changing
anything. This note covers only the latest production incident and its resolution.

## Current state

- Branch: `main`
- Working tree was clean at handoff.
- Launchd service was restarted after the merge and is running.
- Mandatory parser eval: **160/160**.
- All project test scripts, live brand reranking, Supabase claim tests, correction
  memory, routing, undo, and ingestion tests passed after merge.
- Public-repo PII/secrets scan was clean.

Relevant commits:

- `1bbc54b` — preserve user-stated macros during reference arbitration
- `9668580` — per-user food correction memory
- `35f91e5` — apply correction memories across equivalent serving labels
- `e646dda` — prevent silent meal loss and unsafe correction promotion
- `46e47cc` — merge the production safety fixes into `main`

## Incident: user `…0419`

The user logged Yogabar oats, corrected the protein to 26g, later logged masoor,
tofu and soya, then sent `20g protein shake` as a new food.

The failure was a cascade:

1. The lunch reply said it was logged, but Supabase rejected the entire insert
   because transient `rerankMatched` metadata was sent as a database column.
2. Since lunch never persisted, oats remained the latest saved batch.
3. The correction guard connected `Protein Shake` to `High Protein Oats` through
   the generic word `protein` and replaced the oats.
4. The user's recovery sentence was also treated as a correction.
5. Pasting NutriDesi's earlier receipt hit the old 300-character rejection.
6. A later attempt created a second shake with the default 24g protein.

Important factual distinction: the lunch was **not deleted by replace_last**. It
never persisted. The later correction deleted oats, which was the latest saved row.

## What shipped

### Persistence integrity

- `src/db.js` maps every `user_logs` insert through `toUserLogInsertRow()` and an
  explicit `USER_LOG_COLUMNS` allowlist.
- Transient flags such as `rerankMatched`, `memoryApplied`, `stated`, and
  `refVerified` cannot become Postgres columns.
- Normal logs and numbered replacements pass `{ awaitInsert: true }`; the bot does
  not say “Logged” before Supabase accepts the write.
- Regression coverage: `test/db-insert-shape-test.js` and routing failure cases.

### Addition versus correction intent

- `src/correctionContext.js` removes generic nutrition descriptors such as
  `protein`, `high`, `low`, `fat`, and `kcal` from food-identity overlap.
- `20g protein shake` no longer targets protein oats or protein muesli.
- A real named correction such as `Yogabar oats has 26g protein` still targets the
  oats.
- Explicit recovery language such as “the earlier one was correct, I was adding…”
  deterministically remains a new log even if the LLM returns `replace_last`.

### Long/pasted context

- Input ceiling increased from 300 to 1,200 characters.
- A message beginning with NutriDesi's own `✅ Logged` receipt is recognized as
  context and never parsed as another meal. The bot asks for only the new add/change
  instruction, preventing duplicate foods.
- Over-limit input gets recovery-oriented copy and explicitly says nothing changed.

### Per-user correction memory

- `correction-memory.sql` is applied in production.
- Explicit macro corrections are stored per user and never update `foods.js` or
  `foods_reference` globally.
- A fresh user statement overrides stored memory.
- Applied memory is visible in the reply and removable with `forget <food>`.
- Serving compatibility uses calorie basis with a 15% tolerance, not fragile unit
  label equality.

## Production data repair completed

Only user `…0419` and date 1 August were changed.

Final verified day:

- 8 food rows
- Yogabar oats restored at 202 kcal / 26g protein
- Masoor, 84g tofu and 100g soya restored
- Exactly one protein shake at 120 kcal / 20g protein
- Total: **1,475 kcal / 143.9g protein**

A raw before-snapshot was kept only in a restricted `/private/tmp` directory during
the repair. It and all repair scripts were permanently removed after an independent
Supabase read-back passed.

The user's oats memory was then explicitly backfilled and verified:

```text
food_key: high oats protein yogabar
food: Yogabar High Protein Oats (Dark Chocolate)
per serving: 202 kcal / 26g protein
```

This memory is scoped only to `…0419`; shared nutrition tiers were not changed.

## Expected experience now

For any user:

```text
User: The oats have 26g protein, please correct it
Bot:  Corrected — 202 kcal · 26g protein

Next matching log:
Bot:  Logged — 202 kcal · 26g protein
      🧠 Using your correction … Reply "forget Yogabar High" to reset.
```

Memories are created only from explicit corrections made after the feature shipped.
There is no bulk historical backfill. The `…0419` entry above was manually backfilled
because the user had supplied the same correction repeatedly and explicitly approved
the repair.

## Remaining risk to queue

Correction replacements still perform delete and insert as separate database
operations. Inserts are awaited and failures are no longer falsely reported as
success, but a rare failure after deletion is not fully transactional. The proper
follow-up is a Supabase RPC that validates targets and replaces rows inside one SQL
transaction. Do not disguise this with another app-side regex or retry.

## Before the next production change

1. Preserve any unrelated user changes in the working tree.
2. Add a failing regression test before implementation.
3. Run every relevant `npm run test:*` suite.
4. Run `node evals/run.js` for prompt, parser, foods, or DB-resolution changes; it
   must remain 160/160.
5. Review the complete diff for names, raw phone numbers, ngrok URLs, and secrets.
6. Commit without an AI co-author trailer.
7. Restart with `launchctl kickstart -k gui/501/com.nutridesi.server` and inspect
   `~/Library/Logs/nutridesi.log`.

