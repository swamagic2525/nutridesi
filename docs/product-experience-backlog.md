# NutriDesi Product Experience Backlog

**Living document for future product work.** Read this before planning onboarding,
retention, media input, or feedback features. Add new ideas here instead of
scattering them across chats or implementation plans.

This file records product direction, not current shipped behaviour. Check
`docs/ai-onboarding.md` and the code before assuming an item is live.

## How to use this document

Statuses:

- **Approved direction** — the intended experience is agreed, but it may not be built.
- **Needs design** — promising idea that still needs product or technical decisions.
- **Shipped** — verified in the current code and production workflow.
- **Parked** — deliberately not a current priority.

### At a glance

| Idea | Status | Suggested priority |
|---|---|---|
| Progressive first-log onboarding | Approved direction | P1 |
| Permanent-access waitlist checkpoint | Approved direction | P1 |
| Founder voice-note feedback | Approved direction; needs technical design | P1 |
| Nutrition-label photos | Approved direction; needs technical design | P2 |
| Simple meal photos | Approved direction; needs technical design | P2 |
| Complex meal and thali photos | Approved direction; needs evidence from simpler photos | P3 |
| On-demand food-decision assistant | Approved strategic direction; needs validation | P2 |
| Opt-in personalised smart swaps | Approved strategic direction; needs validation | P3 |
| Curated products from verified labels | Approved strategic direction; needs design | P3 |
| Authorised live pricing/availability | Approved strategic direction; blocked on partnership | P4 |

Before building an item:

1. Confirm the problem with current user or outcome data.
2. Turn the item into a scoped design and implementation plan.
3. Define success and failure metrics before release.
4. Follow the testing, PII, deployment, and server-restart rules in
   `docs/ai-onboarding.md`.

## Product contract

NutriDesi should feel like a reliable food diary, not a chatbot that sometimes
understands food.

A user should be able to:

1. Log food naturally in English or Hinglish, including short conversational
   follow-ups.
2. See the food, quantity, calories, and protein that NutriDesi understood.
3. Know when a result is an estimate and be asked one useful question when
   uncertainty is material.
4. Correct, replace, or undo a log in one message and see totals update.
5. See today's running calories and protein, plus progress against a saved goal.
6. Set a safe calorie and protein goal without being forced through setup before
   receiving value.
7. Resume naturally after returning, with bounded memory and no repeated
   onboarding.
8. Opt into useful reminders and opt out just as easily.
9. Trust that retries will not double-log meals and that personal data is handled
   carefully.

Reliability, conversational continuity, and effortless corrections come before
new input modes. Photos cannot compensate for outages, forgotten context, or
confidently wrong estimates.

## Progressive onboarding

**Status: Approved direction**

Activation is the first successful food log. Deliver that value before asking the
user to complete a profile.

Recommended sequence:

1. **Immediate action:** Ask the user to send a food description or photo. Avoid a
   feature tour or multi-question setup form.
2. **Visible interpretation:** Show the detected items and quantities. For a photo,
   show an editable preview rather than silently logging it.
3. **First success:** Confirm the log and show today's running calories and protein.
4. **Progressive discovery:** Introduce correction help, goals, and the optional
   daily summary only after they become relevant.
5. **Permanent-access opt-in:** After repeated successful use, offer to notify the
   user when the permanent WhatsApp number or app becomes available.

Every optional branch must be skippable. A user who only wants to log food should
never be trapped inside profile, TDEE, reminder, waitlist, or feedback flows.

## Permanent-access waitlist checkpoint

**Status: Approved direction**

Offer one additional waitlist opportunity after the user's **fifth successful
food log**, provided their WhatsApp number is not already in the founding-members
or waitlist data.

Suggested copy:

> 🌱 *Want to keep using NutriDesi?*
>
> You're using our temporary trial number right now. Want me to add you to the
> list and notify you when NutriDesi's permanent WhatsApp number/app goes live?
>
> *Reply YES to join · NO to skip*

Guardrails:

- Count successful food logs, not total messages.
- Ask only after the current request has been completed.
- Do not interrupt a correction, TDEE, photo-confirmation, or other active flow.
- Check existing membership before asking.
- Ask once. Persist both acceptance and decline so a user is not nagged.
- Record explicit consent and its timestamp.
- Joining or declining must not change access to food tracking.

## Food and nutrition images

**Status: Approved direction; needs technical design**

### Experience promise

The default photo behaviour should be **estimate, confirm, then log**:

1. User sends a meal photo, optionally with a caption such as “lunch” or “2 rotis.”
2. NutriDesi identifies likely foods and proposes portions, calories, and protein.
3. It clearly marks uncertainty and asks at most one high-value clarification when
   the answer could materially change the estimate.
4. User confirms or edits the preview.
5. Only the confirmed result is written to the food log.

Never imply that a single meal photo can determine exact weight, hidden oil,
ingredients, or preparation method. The product should prefer an honest range or
clarifying question over false precision.

### Recommended rollout

1. **Nutrition-label photos first.** Extract serving size and nutrition facts from
   packaged-food labels. These contain explicit numbers and are safer to verify.
2. **Simple meal photos.** Support plates with one to three visible foods and a
   confirmation step.
3. **Complex meals.** Add mixed dishes, thalis, restaurant plates, and multi-image
   context only after accuracy and correction data justify expansion.

### What is needed

- Receive and authenticate WhatsApp media webhooks on both the current Twilio path
  and the future Meta path.
- Download media promptly and enforce content type and size limits.
- A vision-capable model that returns a strict structured candidate list rather
  than prose.
- Reuse the existing nutrition resolution tiers after food identification so
  photos and text do not create separate nutrition truths.
- Confidence and ambiguity rules that decide between previewing, asking one
  question, or declining to estimate.
- A short-lived pending-photo state so the next message can confirm or edit the
  proposed log without confusing it with a new meal.
- Explicit confirmation before database insertion.
- Image retention and deletion rules. Default to the minimum storage necessary;
  do not retain user food photos indefinitely without a clear product need and
  consent.
- Latency and cost budgets, timeout behaviour, and a useful text fallback when
  image processing fails.
- Evaluation sets covering nutrition labels, Indian home meals, thalis, packaged
  foods, poor lighting, partial plates, multiple plates, screenshots, and
  irrelevant or unsafe media.
- Instrumentation for confirmation-without-edit, corrected foods, corrected
  portions, abandoned previews, processing failures, cost, and response time.

### Important product distinction

A nutrition-label photo and a meal photo are different problems:

- **Label:** extract printed facts and map them to a serving.
- **Meal:** infer foods, portions, oil, and preparation, then resolve nutrition.

They should share the confirmation UI but have separate confidence rules and
evaluation sets.

## Founder voice-note feedback

**Status: Approved direction; needs technical design**

Send a short, genuine prerecorded founder voice note once to highly engaged users.
The goal is qualitative feedback and a personal connection, not promotion.

Eligibility:

- At least 30 inbound user messages.
- At least five successful food logs.
- The user's last inbound message is still inside WhatsApp's 24-hour customer
  service window.
- No active TDEE, correction, photo-confirmation, onboarding, or reminder flow.
- The feedback voice note has never previously been sent.

Send it only after completing the user's current request. Follow the audio with a
separate text prompt because the current WhatsApp media flow should not depend on
audio and body text sharing one message.

Suggested recording, approximately 15–20 seconds:

> Hey, I'm the person building NutriDesi. I noticed you've been using it quite a
> bit, and I really appreciate it. Could you tell me one thing it gets wrong or
> one thing that would make tracking easier for you? Reply here by voice or text.
> I personally read every response.

Suggested text follow-up:

> 🎙️ *What's one thing NutriDesi should improve?*
>
> Reply by text or voice — brutally honest feedback is welcome 🙂

Constraints:

- On the current Twilio Sandbox, a free-form audio message can only be sent to a
  joined user inside the 24-hour window.
- Outside that window, do not attempt to send the custom recording. After WABA
  approval, an approved template may reopen the conversation; send audio only
  after the user replies and opens a service window.
- Host the audio at an authenticated or unguessable HTTPS location compatible
  with the messaging provider. Confirm supported encoding, size, and playback
  presentation before release.
- Test the actual WhatsApp presentation. Provider-supported audio may appear as a
  normal audio attachment rather than WhatsApp's native push-to-talk voice-note
  bubble.
- Track delivery and feedback response, and provide a permanent suppression flag.

This feedback will be biased toward retained users. Use it to improve depth and
delight, but continue collecting separate evidence from users who encounter poor
estimates or abandon early.

## Grocery and food-decision assistance

**Status: Approved strategic direction; needs validation and design**

The long-term shift is from **retrospective calorie tracking** to a **personalised
food-decision assistant**. Tracking answers "what did I eat?" after the fact.
The larger opportunity is answering "what should I eat *now*?" at the moment the
decision is actually being made.

### Sequence

Build strictly in this order. Each stage must earn the next.

1. **On-demand decision assistant.** The user asks; NutriDesi answers.
   - "What should I eat now?"
   - "What fits my remaining calories?"
   - "Which of these two products is better for me?"
2. **Opt-in personalised smart swaps.** Suggestions grounded in the user's own
   logs, tastes, budget and repeated habits — not generic advice.
3. **Curated products using verified nutrition labels.** Accuracy first; a
   recommendation is only as good as the label behind it.
4. **Authorised live commerce.** Real availability and pricing, via an authorised
   retailer feed, a partnership, or ONDC.

### Non-negotiables

- **Behaviour and retention first, not affiliate revenue.** The moment a
  recommendation optimises for commission rather than fit, the advice becomes
  untrustworthy and the product loses the only thing it has.
- **Rank independently, and say why.** Phrase it as *"better fit for your goal"*,
  never as universally *"healthy"*. A product that suits a cut may be wrong for a
  bulk, and NutriDesi does not adjudicate what is healthy in the abstract.
- **Do not scrape Blinkit.** Their terms are understood to prohibit automated
  collection of listings and prices. Treated here as a hard constraint. *(Sourced
  from the strategy brief, not independently verified — confirm before any work
  that depends on it, and assume the restriction applies to comparable
  quick-commerce platforms too.)*
- **No proactive deal alerts yet.** Validate that people want recommendations at
  all through the on-demand path first. Building alerts before demand exists is
  how a useful assistant becomes a spam channel.
- **Any proactive recommendation requires explicit opt-in** and must respect
  WhatsApp's 24-hour session and template rules — the same constraints documented
  for the daily summary in `docs/ai-onboarding.md`.

### Competitive context

**Reported in the strategy brief; not independently verified by this repo.**
Confirm current capabilities before treating any of it as a planning input.

| Player | Reported capability |
|---|---|
| Nutrimate, WhatFit | Indian WhatsApp calorie/photo tracking |
| HealthifyMe | Photo tracking plus proactive coaching |
| TruthIn, Goodbite | Scoring packaged Indian products, suggesting alternatives |
| GoodFor, Haul | Tracking combined with shopping/pantry intelligence |

The claimed opening is the **intersection**: actual eating history, plus personal
preferences, plus a timely and actionable choice. Each capability exists
somewhere; the combination reportedly does not.

### Validation gate — read before starting

This direction is an **expansion of scope while the core retention loop is still
unproven**, and that tension should be resolved with data rather than assumed
away. As of 31 July: D7 is 5.3% against a 40% target, 68% of activated users
logged on exactly one day, and the two retention levers (goal loop, daily
summary) shipped the same day and have produced no data yet.

A food-decision assistant is a strong idea. It is also a reason for people to
*return*, which is precisely the gap — so it may well help. But building it
before the shipped levers report back risks a larger product with the same
one-day drop-off, and a second unvalidated bet layered on the first.

Before stage 1, establish:

- Do users actually ask decision questions today? Current evidence is thin:
  only 4.1% of messages are questions, and they are overwhelmingly status
  queries ("what's my total"), not "what should I eat". The few decision-shaped
  ones asked about calorie *targets*, which the TDEE flow now answers.
- Would a recommendation be trusted? A wrong suggestion costs more than a wrong
  calorie estimate, because the user acts on it prospectively.
- What is the nutrition source of truth for packaged products, and who is
  accountable when a label is wrong?
- Does the first shipped retention work move D1/D7 at all? If it does not, the
  problem is not the feature set.

Cheapest validation: answer decision questions **manually** for a handful of
engaged users over a week and count whether anyone asks unprompted a second
time. No build required.

## Candidate priority order

This is a starting point for the next prioritisation session, not an automatic
build order.

| Priority | Opportunity | Why |
|---|---|---|
| P0 | Reliability, context continuity, and effortless corrections | These protect the core product contract and trust. |
| P1 | Progressive first-log onboarding | Reduces time to value without adding new model risk. |
| P1 | Permanent-access opt-in checkpoint | Helps retain contact while the Sandbox remains temporary. |
| P1 | Founder voice-note feedback | Small, personal experiment for learning from engaged users. |
| P2 | Nutrition-label image preview | More bounded and verifiable than meal-photo estimation. |
| P2 | Simple meal-photo preview | Major convenience improvement, but requires strong confirmation and evaluation. |
| P3 | Complex meal and thali photos | High ambiguity; expand only after simpler images perform well. |
| P2 | On-demand food-decision assistant | The strategic shift from "what did I eat" to "what should I eat now". Gated on evidence that users ask, and on the shipped retention levers reporting back. |
| P3 | Opt-in personalised smart swaps | Needs enough logging history per user to be personal rather than generic. Most users currently log one day. |
| P3 | Curated products from verified labels | Prerequisite for trustworthy recommendations; accuracy burden is higher than for tracking. |
| P4 | Authorised live pricing/availability | Blocked on a retailer feed, partnership or ONDC. Scraping quick-commerce listings is out of bounds. |

## Success metrics

- New user → first successful log conversion.
- Median messages and time to first successful log.
- Percentage of new users who make a second log and return on D1 and D7.
- Correction, undo, retry, and abandonment rates after estimates.
- Goal adoption and daily-summary opt-in after successful logs.
- Permanent-access prompt acceptance and decline rates.
- Voice-note delivery and feedback response rates.
- For images: processing success, confirmation-without-edit, food correction,
  portion correction, preview abandonment, latency, and cost per confirmed log.
- For food decisions: share of users who ask an unprompted decision question,
  repeat-ask rate (the real demand signal), acted-on rate, and whether asking
  users show different D1/D7 than matched non-askers. Track recommendation
  reversals — a user overriding a suggestion is the trust metric that matters.

## Decision log

| Date | Decision |
|---|---|
| 2026-07-31 | Use a balanced onboarding model: deliver a quick first log, then progressively introduce goals, reminders, and richer input. |
| 2026-07-31 | Photo estimates must be previewed and confirmed before logging. |
| 2026-07-31 | Offer permanent-access opt-in once after five successful logs when the user is not already listed. |
| 2026-07-31 | Explore a one-time founder voice note after 30 inbound messages and five successful logs, subject to the 24-hour WhatsApp window. |
| 2026-07-31 | Approved strategic direction: evolve from retrospective tracking into a personalised food-decision assistant, sequenced on-demand answers → opt-in smart swaps → curated verified-label products → authorised live commerce. |
| 2026-07-31 | Recommendations are ranked independently and framed as "better fit for your goal", never as universally "healthy". Behaviour and retention come before affiliate revenue. |
| 2026-07-31 | Blinkit will not be scraped; their terms are understood to prohibit automated collection of listings and prices. Live pricing must come from an authorised feed, partnership or ONDC. Legal basis to be confirmed before any dependent work. |
| 2026-07-31 | No proactive deal alerts until on-demand recommendations demonstrate demand. Any proactive recommendation needs explicit opt-in and must respect WhatsApp's 24-hour/template rules. |
| 2026-07-31 | Competitive claims (Nutrimate, WhatFit, HealthifyMe, TruthIn, Goodbite, GoodFor, Haul) recorded as **unverified** input from the strategy brief. Confirm before using them to justify a build. |
| 2026-07-31 | Documentation only — no product behaviour implemented for this direction. |
