# Metrics Dashboard Design

Build a private, read-only founder dashboard for PRD metrics 1–9 and 13.

## Shape

- `GET /metrics` renders a single self-contained HTML page.
- `GET /metrics/data` returns PII-free aggregates only.
- Both routes require HTTP Basic Auth via `METRICS_USER` and
  `METRICS_PASSWORD`.
- Server-side Supabase access uses `SUPABASE_READONLY_KEY`; no database key is
  sent to the browser.
- Responses are cached for 60 seconds.

## Metric conventions

- Test numbers (`+000…`) are excluded everywhere.
- IST `user_logs.date` drives daily metrics.
- D1/D3/D7 are **join-cohort** retention using `users.created_at`.
- Estimate rate uses `is_estimate`; uncurated rate uses `matched_db_id is null`.
- Engagement is called **food items / active user / day**, not messages.
- Goal adoption is users with non-null `goal_protein`. It reports 0% with an
  availability note if the live migration has not yet added that column.

Metrics 10–12 remain deferred; no events table is added in this build.
