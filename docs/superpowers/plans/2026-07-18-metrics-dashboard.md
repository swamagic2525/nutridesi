# Metrics Dashboard Implementation Plan

**Goal:** Build a protected, read-only founder dashboard for PRD metrics 1–9 and 13.

**Architecture:** Server-side Node code reads Supabase with the existing backend-only service key, reduces records to PII-free aggregates, and serves an authenticated HTML dashboard plus a JSON endpoint. The browser receives no database key or user-level records; RLS remains strict with no anon table reads.

**Tech Stack:** Node.js, Express, Supabase JS, Chart.js CDN, built-in Node `assert`.

## Completed tasks

- [x] Add fixture-tested metric aggregation for test-number exclusion,
  D1/D3/D7 cohorts, estimate-vs-uncurated rates, gram-prefix grouping, and
  goal adoption.
- [x] Add Basic-Auth `/metrics` and `/metrics/data` routes with a 60-second
  cache and no client-side database key.
- [x] Add a Chart.js page for growth, retention, quality, curation priorities,
  engagement, and goal adoption.
- [x] Add idempotent goal-column SQL migration and dashboard setup docs.
- [x] Verify metrics/correction tests, syntax checks, and local auth behaviour.
