# Six-Hour Conversation Memory Design

**Date:** 2026-07-23
**Status:** Approved for implementation

## Problem

NutriDesi persists food logs and some feature-specific state, but most inbound
messages are interpreted without the surrounding conversation. Short follow-ups
therefore fall through to unrelated routes.

Two production incidents define the initial scope:

1. During the TDEE flow, a user sent valid demographics with `weight 61` but no
   unit. The calculator asked for a unit, discarded the valid fields and pending
   number, then treated the follow-up `kg` as an unrelated food message.
2. An anonymized user ending in `*2921` experienced several context breaks in one
   session:
   - a photo followed by `Rate this food` forgot that the previous message was a
     photo NutriDesi could not inspect;
   - a clarification of an already-logged breakfast was logged again;
   - `I am telling from first` received the generic food prompt instead of being
     understood as a correction cue;
   - `How much protein for this much calories` forgot the calorie goal set in the
     immediately preceding exchange.

The second incident is used only as an anonymized acceptance case. No phone
number, real name or raw personal transcript will be committed.

## Goals

- Preserve conversational continuity across server restarts.
- Use at most the last 10 exchanges from the same user and the previous 6 hours.
- Correctly handle short fragments, pronouns, corrections, modifier follow-ups
  and replies referring to a recent bot question.
- Keep structured workflows such as TDEE deterministic.
- Never log food from conversation history; only the current user message may
  create or change data.
- Keep latency and LLM cost unchanged for self-contained messages.

## Non-goals

- Long-term personality memory or free-form user summaries.
- Remembering conversations across a gap longer than 6 hours.
- Reading or rating image contents.
- Automatically deciding that every repeated food is a correction. When intent
  is genuinely ambiguous, NutriDesi must ask rather than delete or duplicate.
- Modifying historical logs outside the existing correction safety boundary.

## Recommended Architecture

The implementation uses a hybrid of structured workflow state and bounded
conversation context.

### 1. Recent conversation reader

Add a Supabase helper that reads up to 10 `message_log` exchanges for one exact
phone number, newer than six hours, ordered oldest to newest.

Each exchange contains:

- inbound user text, or an explicit `[media without text]` marker;
- the corresponding NutriDesi reply;
- whether media was attached;
- timestamp for ordering and expiry only.

The phone number is used solely in the database filter and is never included in
the prompt. User text and replies are length-capped before prompt construction.
If the query fails, return an empty history and continue with current stateless
behavior.

### 2. Context selector

Do not attach history to every LLM request. Retrieve and format it only when the
current message depends on prior context, including:

- short fragments or unit-only replies such as `kg`;
- pronouns and references such as `it`, `that`, `this much`, `same`, `again`;
- correction cues such as `actually`, `from first`, `I meant`;
- modifier fragments such as `with peanuts` or `without chutney`;
- a request referring to immediately preceding media;
- a response to a clarification asked by NutriDesi.

Self-contained meal logs, reports, greetings and deterministic commands retain
their existing fast path.

### 3. Safe prompt boundary

The formatted transcript is trusted application context, not new user input.
The prompt must state:

- history is read-only;
- only `CURRENT USER MESSAGE` may create an action or food item;
- never copy foods, quantities, goals or commands from history into a new log;
- use history only to resolve references and intent;
- when a repeated meal could be either a correction or a new meal, ask one
  concise clarification instead of guessing.

The existing most-recent-log correction context remains the authority for which
rows may be edited. Conversation history helps identify intent but does not
broaden the deletion target.

### 4. TDEE structured-state repair

The TDEE parser must retain valid fields even when one field is incomplete.
For `age 39 female height 155 cm weight 61`, state retains:

- age `39`;
- formula `female`;
- height `155 cm`;
- pending weight value `61`.

If the next active-flow message is `kg` or `lb`, the unit attaches to that
pending value. The calculator then asks only for the remaining activity level.
Unrelated food messages still close the active calculator and continue through
food logging as they do today.

### 5. Ambiguous repeated meals

History must not silently convert a similar meal into a correction. The safe
behavior is:

- explicit correction cue: route through the existing correction pipeline;
- explicit new-meal cue: log normally;
- high-overlap restatement with unclear intent: ask whether it is a correction
  or another meal;
- subsequent `correction` or `new meal` answer: apply it to the immediately
  pending restatement within the same six-hour context.

This prevents the repeated-breakfast failure while preserving the product rule
that an uncertain correction must not delete a legitimate log.

### 6. Context-aware non-food replies

- After unsupported media, `Rate this food` should explain that NutriDesi still
  cannot inspect the image and ask the user to type the food or nutrition label.
- After setting a calorie goal, `How much protein for this much calories` should
  acknowledge the goal context and explain that protein depends on body weight
  and goal, asking for the missing input rather than giving a generic day total.
- `I am telling from first` after a meal restatement should acknowledge the
  misunderstanding and ask the correction/new-meal question, never show the
  generic `What did you eat?` fallback.

## Data Flow

1. Webhook validates and normalizes the inbound message.
2. Existing deterministic routes run first.
3. The user profile and structured workflow state are loaded.
4. Active TDEE state consumes valid fragments deterministically.
5. The context selector decides whether the message needs recent history.
6. If needed, the server reads the same user's last 10 exchanges within six
   hours and builds a bounded transcript.
7. The parser receives trusted history, existing correction context and a
   clearly separated current message.
8. Existing correction, query and logging guards execute unchanged.
9. The completed exchange is saved to `message_log` by both transports.

## Failure and Privacy Rules

- A history query failure must not stop food logging.
- An empty or expired history must behave exactly like the current stateless
  pipeline.
- History queries use exact phone equality; no cross-user fallback is allowed.
- Phone numbers are never placed in prompts, logs added by this change, tests,
  fixtures or committed documentation.
- Prompt context is capped and strips unsupported control text, but keeps the
  user's wording needed for reference resolution.
- The public-repository PII and secret scan remains mandatory before commit.

## Tests

Test-first coverage must include:

1. Exact TDEE fragment sequence:
   `calculate my calories` → demographics without weight unit → `kg` → activity.
2. Valid TDEE fields survive an incomplete field.
3. Context includes at most 10 same-user exchanges from the previous six hours.
4. Exchanges older than six hours are excluded.
5. One user's history can never enter another user's prompt.
6. Self-contained meal logs do not fetch or attach history.
7. Foods in history are never emitted as current items.
8. `with peanuts` uses the latest relevant meal without re-logging its base food.
9. Unsupported photo → `Rate this food` returns the media limitation.
10. Goal setup → `How much protein for this much calories` remains a contextual
    query, not a food log or generic total.
11. Breakfast restatement after `from first` routes as a correction or asks for
    clarification; it never silently adds another copy.
12. Six-hour expiry restores ordinary stateless behavior.

All existing parser, correction, context, serving and TDEE tests must remain
green. Because this changes prompt/parser behavior, `node evals/run.js` is
mandatory and must remain 158/158 before deployment.

## Deployment

1. Run focused tests and the full relevant regression suite.
2. Run `node evals/run.js` and require 158/158.
3. Scan the complete diff for PII, phone numbers, ngrok URLs and secrets.
4. Merge the isolated implementation.
5. Restart with
   `launchctl kickstart -k gui/501/com.nutridesi.server`.
6. Verify health and replay synthetic versions of the TDEE and anonymized
   `*2921` flows.
7. Remove all synthetic Supabase rows created during verification.
