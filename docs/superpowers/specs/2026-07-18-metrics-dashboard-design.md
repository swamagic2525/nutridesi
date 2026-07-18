# Metrics Dashboard Design

## Objective

Build a private, read-only founder dashboard for deciding whether NutriDesi is
earning further investment. It implements PRD metrics 1–9 and 13 only.

## Scope

- `GET /metrics`: one self-contained HTML page, protected by HTTP Basic Auth.
- `GET /metrics/data`: the same authentication; aggregate JSON only, no raw
  phone numbers or message text.
- Supabase-backed metrics: users, DAU, acquisition, D1/D3/D7 join cohorts,
  next-day return, food-items-per-active-user, estimate/uncurated rates, top
  uncurated foods, and goal adoption.
- Data cache: 60 seconds. The UI can manually refresh.

Excluded: failure/latency/correction metrics, events table, user drill-down,
and client-side Supabase access.

## Decisions

1. Use HTTP Basic Auth (`METRICS_USER`, `METRICS_PASSWORD`), not a query token.
2. Keep Supabase access server-side through the existing backend-only
   `SUPABASE_SERVICE_KEY`; the browser sees aggregates only. Public
   `anon`/publishable reads remain blocked by RLS.
3. D1/D3/D7 are **join-cohort retention** based on `users.created_at`, exactly
   as the PRD specifies. The UI states that Sandbox expiry can understate D7.
4. Estimate rate (`is_estimate`) and uncurated rate (`matched_db_id is null`)
   are distinct quality signals and both are shown.
5. Metric 7 is labelled “food items / active user / day”, because one incoming
   WhatsApp message can create several `user_logs` rows.
6. Every query excludes test numbers with a `+000` prefix and uses `date` for
   IST day bucketing.

## Architecture

`src/metrics.js` fetches required `users` and `user_logs` columns with the
existing backend-only service key and reduces them into a PII-free JSON model.
`server.js` adds protected page/data routes. The page is a static HTML renderer
with inline CSS/JS and Chart.js loaded from CDN.

Goal adoption degrades to `0%` with an explanatory availability flag if the
live database has not yet run the additive goal-column migration.

## Data shape

```js
{
  asOf, totalUsers, activeToday,
  d7: { rate, eligibleUsers },
  estimate: { overallRate, uncuratedOverallRate, daily: [] },
  growth: { dau: [], newUsers: [] },
  cohorts: [{ date, size, d1, d3, d7 }],
  nextDayReturn: [], engagement: [],
  topUncurated: [{ foodName, count }],
  goalAdoption: { rate, available }
}
```

No response property contains a phone number, raw message, or individual log.

## Setup

The dashboard requires `METRICS_USER` and `METRICS_PASSWORD` in `.env`; it
uses the existing server-only `SUPABASE_SERVICE_KEY`. Existing databases also
need the additive `users` migration for `name`, `goal_protein`, and
`nudge_count`.
