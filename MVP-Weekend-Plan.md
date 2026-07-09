# NutriDesi — Weekend MVP Build Plan
**Version:** 1.0 | Derived from PRD v0.5 + CLAUDE.md
**Builder:** Solo, no-code, Claude Pro as pair-builder
**Timebox:** Saturday morning → Sunday night (~14 working hours)

---

## The Single Weekend Goal

> By Sunday 10pm, you text "2 roti and dal" to a WhatsApp number and get back:
> "✅ Logged: 2 Roti (178 kcal) + Dal Tadka (180 kcal) | Today: 358 kcal"
> — in under 5 seconds, from the cloud, not your laptop.

Nothing else. If this works, the weekend succeeded.

---

## What's IN vs OUT This Weekend

| IN (core loop) | OUT (Week 2, deliberately) |
|---|---|
| Twilio Sandbox → Make.com → Claude → Supabase → reply | Personal calibration (katori/roti size) |
| Two-scenario architecture (A: ingest, B: process) | 45-minute session merging |
| System prompt with alias map (58 items, as-is) | Undo |
| Two-factor routing + 4-tier fallback | Daily summary / reminders |
| Running daily total | Streaks |
| Quantity enum guardrail in schema | Intent preemption state machine |

**Why the cuts:** Every OUT item requires state tracking across messages. The IN list is stateless per message (except the daily total, which is a simple date-filtered sum). Stateless = buildable in Make.com without debugging session logic at midnight.

**Do not add an OUT item mid-weekend, even if it feels easy.** That instinct is the #1 killer of weekend builds.

---

## Pre-Weekend Checklist (Friday night, 1 hour)

Do these before Saturday so the weekend is pure building:

- [ ] Create Twilio account → activate WhatsApp Sandbox → join sandbox from your own phone (send the `join <keyword>` message)
- [ ] Create Make.com free account
- [ ] Create Supabase free account + new project
- [ ] Get Claude API key from console.anthropic.com → load $5 credit
- [ ] Confirm you can see the alias map (NutriDesi-TestSuite-v1.xlsx, Tab 2)
- [ ] Bookmark: Twilio console, Make.com dashboard, Supabase dashboard, Anthropic console

**If any signup blocks you (OTP issues, card verification), resolve Friday — not Saturday morning.**

---

## SATURDAY — Plumbing Day (no AI)

### Block 1 (morning, ~3 hrs): Scenario A — Ingestion
**Goal: a WhatsApp message becomes a Supabase row.**

1. In Supabase, create 2 tables:
   - `pending_jobs`: `id, phone_number, raw_message, status (default 'pending'), created_at`
   - `user_logs`: `id, phone_number, food_name, matched_db_id, quantity, kcal, protein, carbs, fat, is_estimate, logged_at, date`
2. In Make.com, create Scenario A:
   - Module 1: Custom webhook (copy the URL)
   - Module 2: Supabase → insert row into `pending_jobs`
   - Module 3: Webhook response → `200 OK` (empty TwiML: `<Response></Response>`, Content-Type `text/xml`)
3. In Twilio Sandbox settings, paste the Make.com webhook URL into "When a message comes in"
4. Text anything to the sandbox number → check Supabase for the row

✅ **Exit criteria:** Your message text and phone number appear as a row in `pending_jobs` within 2 seconds. Twilio shows no webhook errors.

⚠️ **Likely snag:** Twilio sends form-encoded data, not JSON. In Make.com, the webhook auto-detects — but if fields come through empty, re-run "Redetermine data structure" while sending a fresh test message.

### Block 2 (afternoon, ~3 hrs): Scenario B skeleton — no Claude yet
**Goal: new pending_jobs row triggers a canned WhatsApp reply.**

1. Create Scenario B:
   - Module 1: Supabase → watch rows in `pending_jobs` (status = 'pending')
   - Module 2: Twilio → send WhatsApp message: "Received: {{raw_message}}"
   - Module 3: Supabase → update row status to 'done'
2. Text the sandbox → get the echo back

✅ **Exit criteria:** Round trip (your message → echo reply) in under 10 seconds, consistently, 5 times in a row.

⚠️ **Likely snag:** Make.com free tier polls on an interval rather than triggering instantly. Fix: upgrade to Core plan (~₹800/month, already budgeted) for instant triggers, OR use a Supabase webhook → Make.com custom webhook as the Scenario B trigger. Decide fast — don't debug polling for 2 hours.

**Saturday hard stop:** If Block 2 isn't done by dinner, stop and finish it Sunday morning. Do NOT start the Claude integration tired — prompt debugging while exhausted wastes hours.

---

## SUNDAY — Intelligence Day

### Block 3 (morning, ~4 hrs): Claude Haiku integration
**Goal: raw_message → structured JSON.**

1. Build the system prompt in a text file FIRST (use Claude Pro to draft it). It must contain, in order:
   - Role: "You are a food-parsing engine. Output only valid JSON."
   - The alias map (all 58 items from Tab 2, single-line pipe format)
   - The output JSON schema — with the quantity enum guardrail: *"quantity MUST ONLY be one of: 0.5, 1.0, 1.5, 2.0, 3.0"*
   - Quantity normalisation table (thodi si → 0.5, dabake → 2.0)
   - Modifier splitting rule ("2 roti with butter" = 2 items)
   - Two-factor routing definitions (match_type, portion_clarity)
   - Rule: never fabricate a matched_db_id outside the list — unknown food = match_type "none"
2. In Scenario B, insert between trigger and reply:
   - Module: HTTP → POST to `https://api.anthropic.com/v1/messages` (current Claude Haiku model, max_tokens: 1024)
   - Module: JSON parse on the response text
3. Test with 5 phrases from the test suite (one per quadrant + one extra clean slam): "2 roti and dal makhani", "thodi si rice with ghee", "had some dal", "chicken rezala", "3 idli with sambar"

✅ **Exit criteria:** All 5 return parseable JSON with correct match_type. The landmine ("chicken rezala") returns `match_type: "none"` — NOT a fabricated ID. If Haiku invents IDs, tighten the no-fabrication instruction and retest before moving on.

### Block 4 (afternoon, ~3 hrs): Calculate, log, reply
**Goal: the real reply with real calories.**

1. In Scenario B, after JSON parse:
   - Iterator over `items[]` array
   - For each item: look up kcal (load the 58-item table into a Supabase `foods` table, or a Make.com data store) → multiply by quantity → insert into `user_logs`
   - Aggregate: sum today's `user_logs` kcal for this phone_number
2. Format reply per the routing table:
   - direct + specified → "✅ Logged: 2 Roti (178 kcal) | Today: 358 kcal"
   - category → "✅ Logged as Mixed Veg (est.) — 120 kcal | Today: X"
   - none → "✅ Logged: meal — 300 kcal placeholder | Today: X"
3. Send via Twilio module

✅ **Exit criteria:** "2 roti and dal" returns correct kcal and a correct running total. A second message the same day shows the total incrementing.

### Block 5 (evening, ~1 hr): The 10-phrase smoke test
Run 10 phrases from the test suite (3× Q1, 3× Q2, 2× Q3, 2× Q4) against the live bot from your phone. Score Pass/Fail in the spreadsheet's Pass/Fail column.

✅ **Weekend passes if:** ≥ 7/10 pass, zero silent failures (every message gets SOME reply), zero Twilio timeouts.

---

## Contingency Rules (decide now, not in the moment)

| If this happens | Do this |
|---|---|
| Saturday Block 1 takes all day | Fine. Sunday = Blocks 2+3. Push 4–5 to Monday evening. The order never changes. |
| Claude returns malformed JSON intermittently | Add a Make.com error-handler route: reply "✅ Logged: meal — 300 kcal placeholder" and mark job 'failed' for review. Never let the user see silence. |
| Make.com free tier polling blocks you | Pay the ₹800. It was budgeted. Don't burn 3 hours avoiding it. |
| Tempted to add calibration "since I'm in here anyway" | Read the IN/OUT table again. No. |
| Stuck on anything > 45 min | Paste the exact error + screenshot into Claude Pro. Solo debugging past 45 min is ego, not progress. |

---

## For Your AI PM (Claude Code / Claude Pro session prompts)

Use these as opening prompts per block — each assumes CLAUDE.md is in context:

- **Block 1:** "Walk me through connecting a Twilio WhatsApp Sandbox webhook to a Make.com scenario that writes to Supabase and returns 200 OK instantly. I'm on the free tiers. Screenshot-level detail."
- **Block 3:** "Draft the full Claude Haiku system prompt per CLAUDE.md: alias map in pipe format, JSON schema with quantity enum, quantity normalisation table, modifier splitting, two-factor routing, no-fabrication rule. Then give me 5 test inputs and their expected JSON outputs."
- **Block 4:** "Design the Make.com module chain from parsed JSON to formatted WhatsApp reply: the iterator over items[], the kcal lookup, the daily total aggregation, and the 3 reply templates from the routing table."
- **Block 5:** "Here are my 10 smoke test results [paste]. Which failures are alias gaps vs prompt logic vs Make.com plumbing? Prioritise fixes."

---

## Monday Morning Definition of Done

- [ ] Live WhatsApp bot answering from the cloud
- [ ] ≥ 7/10 smoke test pass rate recorded in the test suite spreadsheet
- [ ] Zero silent failures observed
- [ ] `user_logs` showing real entries with correct dates
- [ ] A message drafted to the director: "Scenario A logged its first live entry. Smoke test: X/10."

**Then Week 2 begins:** full 50-phrase test run → alias gaps fixed → calibration + daily summary + undo → first 10 beta users.

**Week 2 addition — post-log correction keywords (decided during build):** `undo` / `half` / `2x` acting on the user's last logged item (single `user_logs` lookup + patch, no conversation state). Never ask portion questions before logging — log with visible assumptions, correct after. One-time calibration question ("chota katori or bada bowl?") fires after logging, once per food type ever, per PRD rule 1.
