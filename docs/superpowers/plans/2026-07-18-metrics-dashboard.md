# Metrics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a protected, read-only founder dashboard for PRD metrics 1–9 and 13.

**Architecture:** Server-side Node code reads Supabase with the existing backend-only service key, reduces records to PII-free aggregates, and serves an authenticated HTML dashboard plus a JSON endpoint. The browser receives no database key or user-level records; RLS remains strict with no anon table reads.

**Tech Stack:** Node.js, Express, Supabase JS, Chart.js CDN, built-in Node `assert`.

---

### Task 1: Aggregate metric model

**Files:**
- Create: `src/metrics.js`
- Create: `test/metrics-test.js`

- [ ] Write fixture tests for test-number exclusion, D1/D3/D7 cohorts, estimate-vs-uncurated rates, gram-prefix food grouping, and goal adoption.
- [ ] Implement pure `buildMetrics(users, logs, now)` with IST `date` strings.
- [ ] Add a server-side Supabase fetch wrapper that paginates `users` and `user_logs` without weakening RLS.
- [ ] Run `node test/metrics-test.js` and expect all assertions to pass.

### Task 2: Protected server endpoints

**Files:**
- Modify: `server.js`
- Modify: `.env.example`

- [ ] Add HTTP Basic Auth middleware using `METRICS_USER` and `METRICS_PASSWORD`.
- [ ] Add `GET /metrics/data`, cache aggregates for 60 seconds, and return only the metric model.
- [ ] Add `GET /metrics`, protected by the same middleware, serving the dashboard HTML.
- [ ] Add placeholders for `METRICS_USER` and `METRICS_PASSWORD` to `.env.example`.

### Task 3: One-page dashboard

**Files:**
- Create: `src/metricsPage.js`

- [ ] Render summary cards, growth charts, join-cohort table, quality chart/list, and goal adoption.
- [ ] Include explicit labels/tooltips for join-cohort caveat, estimate vs uncurated rates, and item-row engagement.
- [ ] Render no individual phone number, food log, or message text.

### Task 4: Migration and handoff

**Files:**
- Modify: `supabase-schema.sql`
- Modify: `README.md`

- [ ] Add idempotent additive `users` column migration statements for existing databases.
- [ ] Document dashboard setup, dashboard URL, and the fact that metrics 10–12 are deferred.
- [ ] Run `npm run test:corrections`, `node test/metrics-test.js`, `node --check server.js`, and `git diff --check`.
