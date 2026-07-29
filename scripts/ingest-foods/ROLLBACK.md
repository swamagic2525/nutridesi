# Rollback — bulk food ingestion

The entire import is namespaced under `food_code like 'AI%'` (AIH household,
AIQ quick-commerce, AID dairy, AIF fitness/commercial, etc.). To fully undo it, run in the Supabase SQL editor:

    delete from foods_reference where food_code like 'AI%';

This removes every AI-ingested row (1,528 as of 2026-07-25) and leaves the
original 1,014 INDB rows and the curated `foods.js` tier untouched. Re-running
`node scripts/ingest-foods/run.js` then `--load` re-imports idempotently (upsert
on `food_code`).
