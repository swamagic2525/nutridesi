# PRD — NutriDesi Metrics Dashboard

**Status:** Plan (not built). **Owner:** Swapnil. **For:** an AI agent building this in-repo.

## Goal

A read-only dashboard that answers one question weekly: *is this worth continuing?*
The single decision metric is **D7 cohort retention** (PRD kill-criteria: ≥40% =
strong, <20% = stop). Everything else is supporting context — growth, engagement
depth, and where the bot is failing users.

Keep it simple: this is a founder's instrument panel, not an analytics product.
One page, auto-refreshing, no build step beyond what the repo already uses.

---

## Data sources (read these exactly — do not invent schema)

**Supabase (primary).** Same project the server uses; read-only via the existing
`SUPABASE_URL` + a **read-only** key (do NOT reuse the service key in a browser).

- `users`: `phone_number` (PK), `created_at`, `name`, `goal_kcal`, `goal_protein`,
  `nudge_count`, `daily_summary_time`.
- `user_logs`: `phone_number`, `food_name`, `matched_db_id` (null = not a curated
  match), `quantity`, `kcal`, `protein`, `carbs`, `fat`, `fiber`, `meal_time`,
  `is_estimate` (true = estimate/placeholder, not a confident match), `logged_at`
  (timestamptz), `date` (YYYY-MM-DD in IST — use this for day bucketing, not
  logged_at, so day boundaries match the bot's IST logic).

**Server log (secondary — failures live here, NOT in Supabase yet).**
`~/Library/Logs/nutridesi.log` on the host. Failure/latency signals are only in
this file today: lines like `LLM claude failed: …`, `parser: … served by gemini`,
`handler error:`, and per-request lines `<ISO ts> <phone> "<msg 40 chars>" <N>ms`.

> **Architectural decision the builder must make first:** the log file is not
> queryable from a cloud dashboard. Pick one:
> **(A)** dashboard runs on the same host and tails the file (simplest now), or
> **(B) recommended** — add a tiny `events` table to Supabase and have `server.js`
> write one row per request (phone, intent, served_by_provider, latency_ms,
> was_estimate_count, failed bool, created_at). (B) makes failure metrics reliable
> and survives the cloud migration. If you choose (B), also propose the 1-line
> insert in server.js — do not silently change reply behavior.

**Always exclude test numbers:** any `phone_number` starting with `+000` is a test
fixture and must be filtered out of every metric.

---

## Metrics (definition matters — be precise)

| # | Metric | Exact definition | Source | Viz |
|---|--------|------------------|--------|-----|
| 1 | Total users | distinct `phone_number` in `users` | Supabase | big number |
| 2 | Active today | distinct `phone_number` in `user_logs` where `date` = today (IST) | Supabase | big number |
| 3 | New users / day | count of `users.created_at` per day | Supabase | bar, last 30d |
| 4 | DAU | distinct loggers per `date` | Supabase | line, last 30d |
| 5 | **D-N cohort retention** | for users who joined on day X, % who logged on day X+1 / X+3 / X+7. **North Star = D7.** | Supabase (join `users.created_at` × `user_logs.date`) | cohort table or curve |
| 6 | Next-day return | of users active on day D, % active on D+1 (rolling, all days) | Supabase | line |
| 7 | Engagement depth | avg `user_logs` rows per active user per day | Supabase | line |
| 8 | Estimate rate | % of `user_logs` rows where `matched_db_id` is null (or `is_estimate` = true), overall and per day | Supabase | line + % |
| 9 | Top uncurated foods | most-frequent `food_name` where `matched_db_id` is null, last 7d (strip leading `NNNg `) | Supabase | ranked list — drives curation |
| 10 | Failures | count of `LLM … failed` / `handler error` / 300-kcal placeholder logs, per day | log file **or** `events` | number + line |
| 11 | Latency | p50 and p95 of per-request ms; count of requests >10s (Twilio 15s-timeout risk) | log file **or** `events` | two numbers |
| 12 | Correction rate | % of messages that were `replace_last`/`undo` (a UX-friction signal) | `events` (needs intent logged) | % |
| 13 | Goal adoption | % of users with `goal_protein` not null | Supabase | % |

Metrics 1–9 and 13 are pure Supabase and can ship first. 10–12 depend on the
log-vs-events decision above — ship them in a second pass if needed.

---

## Non-goals

- No per-user drill-down, no PII display (see privacy below).
- No writes to `users`/`user_logs` — read-only.
- No new analytics dependency (no Mixpanel/GA). Query Supabase directly.
- Not real-time; a 1–5 min cache / manual refresh is fine.

---

## Constraints the builder MUST honour

- **Privacy:** never render full phone numbers. If a number must appear (e.g. a
  debug list), mask to `+91••••••1234`. No message contents in the UI beyond
  aggregate counts. This is real user data.
- **Auth:** the dashboard exposes user data and the server is on a public URL.
  Gate it — at minimum a secret token (`/metrics?key=…` compared to an env var),
  ideally HTTP basic auth. Never ship it unauthenticated.
- **Stack fit:** reuse the existing Node/Express server. Preferred shape: a new
  `GET /metrics` route rendering a single self-contained HTML page (inline CSS/JS,
  Chart.js from CDN is fine) that calls a `GET /metrics/data` JSON endpoint. No
  separate service, no framework, no build tooling.
- **Keys:** read metrics with a Supabase **anon/read-only** key stored in `.env`
  (`SUPABASE_READONLY_KEY`), never the service key in client-side code. `.env` is
  gitignored — add the new var to `.env.example` with a placeholder only.
- **Timezone:** all day bucketing in IST (Asia/Kolkata), matching `user_logs.date`.

---

## Suggested layout (top to bottom)

1. Header row of big numbers: total users · active today · D7 retention · estimate rate.
2. Growth: DAU line + new-users bars (last 30 days).
3. Retention: cohort curve/table (D1/D3/D7) — the hero chart.
4. Quality: estimate-rate trend + top-10 uncurated foods list (the curation TODO).
5. Health: failures/day, p50/p95 latency, requests >10s.
6. Adoption: goal-set %, correction rate.

Footer: "excludes test numbers · IST · data as of <timestamp>".

---

## Open decisions for the builder (call these out, don't guess)

1. Log-file tail (A) vs `events` table (B) for failure/latency metrics — recommend B.
2. Auth mechanism (token vs basic auth).
3. Whether to add the `events` insert to `server.js` now or defer failure metrics.
