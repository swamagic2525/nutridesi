# Tomorrow Anchor Retention Agent — V1 Design

**Status:** Approved direction; implementation queued for later.

## Problem and hypothesis

NutriDesi's immediate product problem is repeat logging, not a lack of autonomous
AI. Many activated users log on only one day. The first retention intervention
should therefore earn one additional logging day with the smallest possible next
action.

Hypothesis:

> A new user who makes a specific commitment to log one meal tomorrow is more
> likely to return and successfully log on the following IST date than an
> otherwise similar user who receives the current logging experience.

The primary outcome is a successful log on the next IST date. Helping the user
make a healthier choice is outside V1.

## Product boundary

V1 is a deterministic, bounded agent loop:

1. Observe structured logging and flow state.
2. Decide whether one approved intervention is eligible.
3. Ask the user for a small tomorrow commitment.
4. Remember the answer.
5. Optionally send an explicitly requested reminder when WhatsApp permits it.
6. Evaluate whether the user returned and close the loop.

It does not interpret food, calculate nutrition, edit logs, invent health advice,
or interrupt an active flow. The existing logging pipeline remains unchanged.
There is no LLM call in V1. This establishes a reliable baseline before testing
whether an AI policy improves intervention selection.

## Eligibility and CTA priority

Evaluate eligibility only after Supabase has accepted a food log. Offer an anchor
when all conditions are true:

- the user is within seven days of their first successful food log;
- they have completed at least five successful food-log messages;
- they have logged on fewer than three distinct IST dates;
- no correction, TDEE, reminder setup, photo confirmation, onboarding question,
  or other stateful flow is active;
- no anchor has been offered on the current IST date;
- no accepted anchor already targets a future date; and
- the current inbound message keeps the WhatsApp service window open.

Only one optional CTA may follow a receipt. Existing safety and task flows take
priority. If the permanent-access waitlist checkpoint or another higher-priority
CTA is due, skip the anchor and reconsider it after the next successful log.

## Deterministic intervention selection

Use only structured `meal_time` history from successful logs:

- breakfast and lunch both appear: ask which one the user wants to continue;
- only breakfast appears: suggest breakfast with a yes/no response;
- only lunch appears: suggest lunch with a yes/no response;
- neither is reliable: ask for their first meal tomorrow.

Do not generate a health insight or infer motivation. If the structured history
is insufficient, choose the generic first-meal anchor.

Example after the normal receipt:

> You tracked 3 meals today—great start 🙌  
> **Which meal should we continue with tomorrow: breakfast or lunch?**

After `breakfast`:

> Perfect. Tomorrow, just send me what you have for breakfast. Want a reminder
> around 9am?

On the next day:

> You came back for breakfast—Day 2 done ✅

If the user logs a different meal, the return still counts as success. Store
whether the chosen meal matched separately; never withhold positive feedback
because the user returned differently from their plan.

## State model

Use a dedicated `return_anchors` table so product outcomes are queryable and do
not become mixed with six-hour conversation memory.

```text
id
phone_number
target_date
offer_type: breakfast | lunch | breakfast_or_lunch | first_meal
target_meal: breakfast | lunch | first_meal | null
status: offered | accepted | reminded | completed | expired
offered_at
accepted_at
reminder_time
reminder_status: none | requested | sent | failed | skipped_window
reminded_at
completed_at
returned_next_day
matched_target_meal
decision_reason
created_at
updated_at
```

Enforce one row per `(phone_number, target_date)`. State transitions must be
idempotent so webhook retries cannot create duplicate commitments or reminders.
Expire an uncompleted anchor after the target IST date ends. Missing an anchor is
never mentioned unless the user asks.

## WhatsApp and reminder behaviour

Reminders require explicit opt-in. Before promising one, calculate whether its
scheduled send time is inside the current 24-hour free-form window with a safety
margin. If not, say the temporary number cannot send that reminder yet and retain
the commitment without a reminder.

The existing outbound transport, session-window check, and atomic-send claim
pattern should be reused. Anchor scheduling should keep separate state from the
daily summary so one feature cannot suppress or duplicate the other.

The agent cannot solve Twilio Sandbox's three-day rejoin requirement or recover a
user after WhatsApp's service window closes. WABA approval later expands delivery;
it does not change the V1 consent rule.

## Completion rules

Any successful food log on `target_date` sets `returned_next_day = true` and
completes the anchor. `matched_target_meal` is computed independently:

- breakfast: parser meal time is breakfast, or it is the day's first successful
  log before 12:00 IST;
- lunch: parser meal time is lunch, or the log occurs from 11:00–16:00 IST;
- first meal: the day's first successful log at any time.

The normal logging receipt remains primary. Completion feedback is one short line
and must not introduce another CTA in the same reply.

## Failure behaviour

- An eligibility/state read failure silently skips the offer; it never blocks a
  successful logging reply.
- A state-write failure does not claim the anchor was saved.
- Duplicate responses return the already-saved state without creating another row.
- Reminder claims are atomic. A failed send records `failed` and is not reported as
  delivered.
- If the 24-hour window closes, record `skipped_window`; do not attempt delivery.
- Logs and analytics mask phone numbers and never persist raw message text in the
  anchor table.

## Rollout

1. **Shadow mode for 2–3 days:** record eligibility and proposed actions without
   displaying an offer. Manually review whether the timing is sensible.
2. **Usability pilot:** expose the flow to approximately ten eligible users and
   inspect every offer, response, reminder decision, and next-day outcome.
3. **Controlled rollout:** assign eligible users consistently to treatment or the
   existing experience with a stable hash. Never switch a user between cohorts.
4. Expand only when the funnel and guardrails are healthy.

The early beta is too small for confident statistical significance. Report exact
counts and intervals; do not present directional results as proof.

## Measurement

Funnel:

```text
eligible → offered → accepted → reminder requested → returned next day
         → logged chosen meal
```

Primary metric:

- successful next-IST-date log among offered eligible users.

Secondary metrics:

- acceptance and anchor-completion rates;
- chosen-meal match rate;
- reminder request and successful-send rates;
- D3/D7 logging retention; and
- distinct logging days during the first week.

Guardrails:

- opt-out or stop requests;
- immediate abandonment after the offer;
- repeated/conflicting CTAs;
- interrupted corrections or stateful flows;
- promised but undeliverable reminders;
- duplicate sends; and
- increased reply latency or logging failure.

Record bounded decision reasons such as `eligible_after_5_successes`,
`active_correction`, `higher_priority_cta`, `already_offered_today`,
`whatsapp_window_closed`, and `breakfast_logged_next_day`.

## Testing

Pure tests cover eligibility, intervention selection, state transitions, IST date
boundaries, meal matching, CTA priority, session-window calculations, and stable
cohort assignment.

Routing tests cover the full sequence:

```text
successful log → offer → acceptance → reminder request/constraint
→ next-day log → completion
```

They must also cover webhook replay, concurrent replies, state-write failure,
send failure, correction/TDEE preemption, a higher-priority CTA, a different meal
on the target day, and expiration without guilt copy.

## Later AI-policy experiment

Only after deterministic V1 improves repeat logging should an LLM or learned policy
choose among the approved actions `breakfast`, `lunch`, `first_meal`, and `none`.
It receives structured history only, cannot write state or send messages directly,
and remains behind the same eligibility, consent, safety, and experiment gates.
Its incremental return lift must beat the deterministic baseline enough to justify
added cost, latency, and unpredictability.

## Explicit non-goals

- General autonomous coaching.
- Meal plans, health advice, or nutrition optimisation.
- New food parsing or nutrition-resolution behaviour.
- Unsolicited outbound messaging.
- Solving Twilio or WABA platform constraints.
- Building an agent framework or rewriting the Express webhook.
