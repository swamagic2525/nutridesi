# Metrics Dashboard Implementation Plan

**Goal:** Ship PRD metrics 1–9 and 13 as a protected, read-only dashboard.

1. Add pure metric aggregation and fixtures for cohort retention, test-number
   exclusion, estimates, uncurated grouping, and goals.
2. Add server-side read-only Supabase loading plus Basic-Auth `/metrics` and
   `/metrics/data` routes with a 60-second cache.
3. Add a Chart.js one-page view with summary cards, growth, cohorts, quality,
   top uncurated foods, engagement, and goal adoption.
4. Add idempotent goal-column SQL migration and dashboard setup documentation.
5. Verify correction and metrics tests plus JavaScript syntax before review.
