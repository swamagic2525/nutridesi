# NutriDesi Churn Reduction Report

**Date:** 23 July 2026  
**Review window:** launch (11 July) through 23 July 2026  
**Decision:** identify the few fixes most likely to improve retained usage

## Executive summary

NutriDesi's biggest issue is **activation without habit formation**, not failure
to understand the first meal. 143 of 155 real users logged food (92.3%
activation), but 69.3% of mature activated users have logged on only one day.
D1 retention is 23.4%; D3 is 6.9%; D7 is 5.3%, versus the product target of at
least 40% D7.

Two structural problems compound the drop:

1. The Twilio Sandbox re-join boundary makes D3/D7 access and measurement
   unreliable.
2. NutriDesi has no strong opt-in return loop after first value: no shipped
   reminder or daily-summary habit, and goal adoption is low.

Food accuracy still creates severe individual trust failures, but broad database
coverage is not the main retention lever. Users whose first batch included a
non-curated food had 25.6% D1 retention versus 22.5% for fully curated first
batches. The higher-return accuracy work is targeted: prevent confidently wrong
matches, duplicate restatement logs, and failed recovery.

## Evidence base and caveats

- Supabase: 155 real users, 1,338 food rows, 143 activated users.
- Persisted conversation history: 481 messages across 76 users, available only
  from 19 July onward.
- Local quality trails: 85 correction events and 232 food-gap events.
- Test numbers were excluded.
- D3/D7 are understated by Twilio Sandbox expiry/re-join friction.
- `is_estimate` is not a clean bad-estimate measure: it also covers some
  gram-scaled database foods. `matched_db_id = null` is also imperfect because
  verified reference foods use a null curated ID.
- Segment comparisons are observational, not randomized causal estimates.

## Product scorecard

| Metric | Current | Target / interpretation | Status |
|---|---:|---|---|
| Activation | 92.3% (143/155) | First value is working | Strong |
| D1 retention | 23.4% (30/128) | Leading habit indicator; should exceed 35% next | At risk |
| D3 retention | 6.9% (7/101) | Confounded by sandbox boundary | Critical |
| D7 retention | 5.3% (4/76) | Product target ≥40%; currently not trustworthy under Sandbox | Critical |
| Mature one-day-only users | 69.3% (79 users) | Core churn symptom | Critical |
| Median food rows / activated user | 4 | Reasonable first-session exploration | Mixed |
| Non-curated food rows | 17.2% (230/1,338) | Coverage gap, but not predictive of D1 here | Monitor |
| Users shown an assumption/match disclosure | 45/76 in message-history window | Accuracy uncertainty is common | High |
| Correction events | 85 | Users actively repair trust | High |
| Correction dead-end records | 8 | Small but severe | Fix selectively |

## What predicts return

### 1. Goal adoption is the strongest observed retention signal

| Segment | D1 retention |
|---|---:|
| Goal set | 50.0% (11/22 eligible) |
| No protein goal | 17.9% (19/106 eligible) |

This is selection-biased—engaged users are more likely to set goals—but the
3× gap is large enough to justify testing a much better goal/commitment flow.
Only 29 activated users currently have a protein goal.

### 2. First-day depth predicts return

| Food rows logged on day 1 | D1 retention |
|---|---:|
| 1–2 | 10.0% |
| 3–5 | 23.1% |
| 6+ | 34.7% |

The product needs to help a first-time user complete a useful day, not merely
demonstrate one successful lookup.

### 3. Broad food coverage is not the main churn driver

| First log batch | D1 retention |
|---|---:|
| Fully curated | 22.5% |
| Contains non-curated food | 25.6% |

Do not prioritize another broad ingestion pass for retention. Accuracy work
should focus on high-severity trust failures rather than raw coverage volume.

## Qualitative failure themes

### A. Service unavailable but user blamed

Four users hit ten parser failures during the 23 July provider outage. The
server process was alive, but Gemini and Claude had no credits and Groq could
not accept the current prompt on its tier. The reply told users to split long
messages even when the input was as short as "1 plate poha."

Impact: total failure of the core action and loss of trust. Two affected users
had not returned by the time of this review.

### B. Confidently wrong match plus duplicate clarification

One user described oats, milk, protein powder and mango. Generic protein powder
was matched to an unrelated branded SKU. Attempts to restate the breakfast were
logged as additional meals, inflating one breakfast to 1,948 kcal. A frustrated
follow-up was treated as if it contained no food.

Impact: the bot changed from useful to actively misleading. This is more
damaging than a transparent estimate.

### C. No return trigger after first value

The bot proves value in the first session, but a user must remember to initiate
every future interaction. Scheduled summaries/reminders are not shipped.
The first-log reply also contains several competing calls to action: correction,
feedback, goal setting and founder context.

Impact: curiosity activation without a durable habit.

### D. Sandbox access friction

Returning users can lose access unless they re-join the Twilio Sandbox. This
both causes real churn and makes D3/D7 retention look worse than the underlying
product.

## Ranked fixes by expected return

### 1. Build a one-action commitment loop after first value

**Expected impact:** very high  
**Effort:** low to medium  
**Confidence:** medium

- Keep the first successful log immediate.
- Shorten the first-log footer to one CTA.
- Test goal commitment first: a single reply format for calorie + protein goal.
- After the user sets a goal, offer an opt-in daily reminder/summary time.
- Never send unsolicited messages; preserve the existing opt-in rule.
- Measure goal-set rate, reminder opt-in and D1 retention.

Why first: goal-set users show 50% D1 retention and deeper first-day use strongly
predicts return.

### 2. Remove the Sandbox retention ceiling

**Expected impact:** very high for D3/D7  
**Effort:** medium  
**Confidence:** high

- Complete WABA/Meta production-number migration.
- Until migration, explicitly warn testers about re-join expiry and give a
  simple recovery instruction.
- Treat D1 as the reliable leading metric; do not make product decisions from
  Sandbox-confounded D7 alone.

Why second: no product loop can retain a user who cannot reliably message the
bot.

### 3. Make the core path functionally reliable

**Expected impact:** high severity, moderate frequency  
**Effort:** low to medium  
**Confidence:** high

- Restore at least one genuinely usable secondary parse provider.
- Change `llm_error` copy to admit a temporary service issue and confirm that
  nothing was logged.
- Add a functional parse healthcheck; process/port health is insufficient.
- Alert after a small burst of parser failures or when the primary provider
  reports exhausted credits.

Why third: four of 76 users in the message-history window encountered one outage
burst. Reliability incidents destroy first-session trust immediately.

### 4. Fix trust-breaking recovery paths, not all conversational memory

**Expected impact:** medium to high  
**Effort:** medium  
**Confidence:** high for known incidents

- Generic food phrases must never resolve to branded SKUs without the brand.
- Detect near-duplicate restatements within the immediately preceding batch.
- When overlap is high, ask whether the user is correcting the previous meal
  instead of logging it again.
- Recognize direct frustration/recovery phrases and show the current last batch.
- Add multi-turn regression cases before changing routing.

Why fourth: these failures are less frequent than one-day abandonment, but each
can irreversibly break trust.

### 5. Add bad-outcome retention instrumentation

**Expected impact:** indirect but compounding  
**Effort:** low  
**Confidence:** high

Create a small backend-only Supabase `events` table with one row per inbound
request:

- phone number (never rendered unmasked)
- message ID
- intent and outcome
- provider and latency
- item, estimate and placeholder counts
- quality flags: parse failure, correction dead-end, repeated-log risk,
  negative-feedback signal
- timestamp

Do not store raw message text in this table. Compute:

- users exposed to a bad outcome
- recovery within 1 hour / 24 hours
- no return after 24 hours / 7 days
- D1 retention after clean versus bad first sessions
- top failure reason by affected users

Why fifth: the current data can identify incidents manually but cannot reliably
attribute churn to a specific outcome.

## Work to deprioritize

- Broad food-database ingestion for retention.
- Full-day LLM conversation history or a LangGraph rewrite.
- Photo recognition during this retention cycle.
- Additional reply features before reliability and the return loop are measured.

## Recommended two-week sequence

1. **Reliability patch:** honest outage copy, provider health alert and viable
   fallback.
2. **Instrumentation:** events table plus bad-outcome recovery metrics.
3. **Activation experiment:** one-CTA first-log reply and goal-setting flow.
4. **Retention experiment:** opt-in reminder/summary after goal commitment.
5. **Targeted trust fixes:** generic-brand guard and duplicate-restatement
   protection with multi-turn evals.
6. **Access:** progress WABA migration in parallel because it gates trustworthy
   D3/D7 measurement.

## Success criteria

Use D1 until WABA is live:

- D1 retention: 23.4% → at least 35%.
- Goal adoption: current 20.3% of activated users → at least 35%.
- Parser-failure exposure: below 1% of active users.
- Duplicate restatement logs: zero known incidents.
- Every bad-outcome event has measurable 1-hour and 24-hour recovery.

After WABA migration, reset cohort baselines and resume D7 ≥40% as the North
Star target.
