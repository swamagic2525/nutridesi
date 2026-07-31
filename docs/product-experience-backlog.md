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

## Decision log

| Date | Decision |
|---|---|
| 2026-07-31 | Use a balanced onboarding model: deliver a quick first log, then progressively introduce goals, reminders, and richer input. |
| 2026-07-31 | Photo estimates must be previewed and confirmed before logging. |
| 2026-07-31 | Offer permanent-access opt-in once after five successful logs when the user is not already listed. |
| 2026-07-31 | Explore a one-time founder voice note after 30 inbound messages and five successful logs, subject to the 24-hour WhatsApp window. |
