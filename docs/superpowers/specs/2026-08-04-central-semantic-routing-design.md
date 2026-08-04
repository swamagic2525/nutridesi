# Central Semantic Routing Design

**Date:** 2026-08-04
**Status:** Approved architecture; implementation pending written-plan approval

## Problem

NutriDesi currently decides intent in two places:

1. semantic regular-expression shortcuts in `server.js` and supporting modules; and
2. the context-aware LLM parser in `src/parser.js`.

Because some shortcuts run before conversation history and `parseMeal()`, they can
silently preempt the more capable router. The production example was:

> Kulfi was 60 calories and 10g protein

The user was correcting a logged food. A broad protein-goal shortcut saw the words
`calories` and `protein` and instead asked for body weight. Repeating the correction
more explicitly produced the same wrong response.

Production review found that this shortcut fired 11 times across seven users and
had no verified intended use. It also found that the current history selector omits
history for three of five known natural correction forms, including a correction
that names its food explicitly. The immediate incident is fixed by removing the
shortcut; the larger problem is architectural: open-ended meaning must not be
classified by an expanding list of phrases before the LLM sees context.

## Goals

- Make the existing `parseMeal()` call the single semantic router for ordinary
  conversation, food parsing and natural-language actions.
- Preserve deterministic handling only where the input grammar or calculation is
  genuinely closed and stable.
- Make questions non-mutating and prevent inconsistent router output from writing.
- Keep correction targets constrained to real, user-owned log rows and preserve
  atomic replacement.
- Give every semantic message bounded recent context without adding a second LLM
  call or sequential Supabase latency.
- Ship the proven protein-goal shortcut removal independently before the broader
  migration.

## Non-goals

- No LangGraph, agent framework or multi-agent orchestration.
- No second intent-classification LLM call.
- No nutrition arithmetic or TDEE calculation inside the LLM.
- No weakening of correction scope, ownership checks or atomic writes.
- No wholesale rewrite of `server.js` or the working nutrition resolver.
- No new food data, image understanding or long-term free-form memory.
- No new pre-parser regular expression for open-ended semantic intent. New wording
  variants belong in the router fixtures and prompt, not another phrase gate.

## Routing Boundary

### Deterministic routes

Only these categories bypass the semantic router:

1. **Transport and security**: Twilio validation, idempotency, rate limits,
   message-length limits, media-without-caption handling and PII masking.
2. **Exact stable commands** with an anchored, finite grammar: `undo`, `undo 4`,
   `delete 4,5`, `replace item 4 with ...`, `forget 1`, `my corrections`, and
   WhatsApp `STOP`/`START`. For replacement, only the target item number and
   command structure are deterministic; the replacement food still goes through
   `parseMeal()`.
3. **Closed active-state answers**: for example activity choices `1`–`5` while
   TDEE is explicitly awaiting activity, and the finite correction/new-meal
   choice while that exact prompt is active. Safe normalized aliases include
   `1`, `correction`, `correct it`, `fix it`, and `2`, `new`, `new only`,
   `new meal`. Any other reply goes to the semantic router with the active state.
4. **Domain calculations and validation**: nutrition scaling, quantity bounds,
   reference matching gates, TDEE math, safety floors, IST dates and totals.
5. **Mutation validation and execution**: target ownership, exact row existence,
   ambiguity refusal, atomic replacement, successful-insert confirmation and
   post-commit totals.

These routes are deterministic because their accepted inputs and outcomes are
finite, not because a phrase happens to correlate with an intent today. Each exact
command parser must be anchored, independently testable and unable to consume
additional conversational wording accidentally.

### Semantic routes

Everything else that requires understanding meaning goes through the existing LLM
call with the current message, user profile, active structured state and bounded
recent conversation. This includes:

- log versus nutrition query;
- correction versus new meal;
- addition versus replacement;
- named-food nutrition questions versus personal calorie-goal calculation;
- natural reminder requests outside the exact finite command grammar;
- contextual follow-ups, recovery language, greetings, help and chitchat.

Existing semantic regex helpers may remain during shadowing as production guards,
but they must not survive as competing classifiers after their route is cut over.

## Router Contract

`parseMeal()` remains the only LLM call. Its structured result is extended rather
than wrapped in a second classifier:

```json
{
  "intent": "log | replace_last | undo | set_profile | calculate_tdee | query | set_reminder | help | chitchat",
  "requested_goal_component": "calories | protein | both | null",
  "ambiguous_between": [],
  "needs_clarification": false,
  "items": [],
  "replace_target": null,
  "query_reply": null
}
```

The existing item schema, stated-nutrition fields and meal-time fields remain
unchanged. V1 retains the existing `calculate_tdee` intent name to avoid a
behavior-free contract migration across the eval and TDEE suites. Deterministic
TDEE code still performs every calculation. `requested_goal_component`
distinguishes a request for calorie, protein or both without multiplying top-level
intents.

`needs_clarification` and `ambiguous_between` are instructions to ask, not safety
licences. Model-reported confidence is not used to authorize any mutation.

## Context Loading

After transport guards and exact commands, load the user's profile and last ten
exchanges from the previous six hours in parallel:

```js
const [profile, history] = await Promise.all([
  getProfile(phone),
  recentConversation(phone, now),
]);
```

History is included for every semantic parse. The current
`needsConversationContext()` phrase gate is removed from this path because it
penalises explicit corrections such as `Kulfi was ...` while admitting pronouns.
Parallel loading changes the database latency from approximately `profile + history`
to `max(profile, history)`. If production measurements later show this is too slow,
the permitted optimization is a bounded cache or one combined database call—not a
new semantic phrase gate.

The existing quoted `BEGIN/END APP-PROVIDED RECENT CONVERSATION` boundary remains
unchanged. History is untrusted read-only data. Only the current user message may
create an action or food item. Conversation history can help select intent but never
broadens which database rows a correction may edit.

## Decision Validation

A new pure validator checks the router result before `server.js` dispatches it.
Malformed or unknown results do not mutate data. The validator is a schema and
execution guard, not an independent judge of natural-language meaning.

### New meal writes

A new meal may be written only when all of these agree:

- `intent === "log"`;
- `needs_clarification === false`; and
- at least one usable food item exists, except for the existing explicit Tier-4
  food placeholder behavior.

An LLM-routed response to a pending prompt may mutate only when there is an
unexpired active structured state, the result is valid for that exact state, and
the existing optimistic claim succeeds. Without matching state it asks for
clarification and writes nothing.

Examples:

| Message | Route | Mutation |
|---|---|---|
| `I ate 2 roti` | log | log |
| `Log 2 roti` | log | log |
| `2 roti` | log | log |
| `Calories in 2 roti?` | query | none |
| `Should I eat 2 roti?` | query | none |
| router marks ambiguity | clarification | none |

The model's fields are correlated and cannot cross-check the model's own semantic
mistake. The real controls for log-versus-query are the routing corpus, shadow
review, non-mutating query preview, visible `Logged` confirmation and immediate
undo. The validator only prevents malformed or explicitly ambiguous output from
writing.

### Corrections and undo

An LLM classification never selects a database row by itself. Existing deterministic
guards remain authoritative:

- natural corrections are limited to the immediately preceding log batch;
- explicit item-number commands may address only real rows from the current day;
- target reranking may return only a candidate row it was shown;
- ambiguous or missing targets change nothing;
- replacement uses `replaceMealAtomic()` so delete and insert commit together;
- totals are reread after commit;
- `isExplicitAddition()` remains as a transitional production safety override for
  the entire V1 rollout. Removing this existing guard is deferred and is not a gate
  for shipping the central router.

#### Cross-midnight correction scope

The immediately preceding log batch remains correctable for six hours even when IST
midnight falls between the log and the correction. This is still the same narrow
last-batch scope; the date boundary must not make a one-hour-old meal disappear.

- `lastLogBatch()` uses a rolling six-hour `logged_at` window rather than filtering
  to the current IST date.
- `replaceMealAtomic()` keeps deriving the replacement date from the locked original
  rows, so a correction after midnight stays in yesterday's log.
- A cross-midnight correction reply labels the updated day as yesterday and does not
  present yesterday's totals as today's progress.
- Explicit item-number commands remain current-day scoped because `day_seq` resets
  daily and the same number can refer to different rows on adjacent dates.
- Pending structured state remains date-scoped; this change affects direct natural
  corrections and narrow bare undo, not stale saved workflows.

### Other mutations

- `set_profile` writes only validated name/calorie/protein fields already supported
  by `saveProfile()`.
- `calculate_tdee` enters or advances the deterministic TDEE state machine; the LLM
  supplies no calculated number.
- `set_reminder` must pass the existing time parser and WhatsApp policy checks.
- `query`, `help` and `chitchat` never write food, profile or reminder data.

### Provider or schema failure

Exact commands and active finite-state answers continue to work without an LLM.
If every provider fails or the router result fails schema validation, NutriDesi
must return an honest short retry message and perform no correction, deletion,
profile change or reminder change. It must never claim `Logged` unless the normal
logging path has identified food rows and Supabase confirms the insert.

## Query Preview and Reversibility

Food questions resolve nutrition for display but do not insert rows. The existing
`Not logged — reply "log it" if you ate this` preview remains. The exact `log it`
reply is deterministic only while a non-expired preview exists.

Every successful addition remains visibly labelled `✅ Logged` and immediately
reversible with `undo`. This does not replace routing accuracy; it limits the cost of
the one non-destructive mutation that cannot be independently proven from language.

## Rollout

### Phase 0: proven incident hotfix

Remove `contextualProteinGoalReply()` from the production route, delete the dead
function and its positive tests, and add behavioural routing regressions for both
anonymized kulfi correction phrasings. This is a standalone deployment because the
existing parser correctly returns `replace_last` with and without history.

### Phase 1: contract in shadow mode

- Extend the parser prompt and response contract.
- Add the pure consistency validator.
- Continue executing current production actions.
- Record only masked, structured shadow metadata: old action, proposed action,
  clarification flag, validator result, provider and latency. Do not add raw user
  messages or phone numbers to logs or committed fixtures.
- Review disagreements using the existing private `message_log` only when needed;
  never export raw production messages.
- Measure history token size and route latency before any cutover. If p99 exceeds
  12 seconds, a combined database call, bounded cache or smaller bounded history
  payload becomes a prerequisite for Phase 2.

### Phase 2: non-mutating cutover

Move only `query`, `help` and `chitchat` to the central router. Remove their competing
semantic shortcuts after regression and shadow review. Exact commands and active
finite-state responses remain deterministic.

### Phase 3: additive logging cutover

Enable validated `log` decisions. Retain visible confirmation, pending query preview
and exact undo. Review false-log signals before proceeding to destructive routes.

### Phase 4: structured-state mutations

Move `calculate_tdee`, `set_profile` and natural-language `set_reminder` after their
paired routing fixtures pass. TDEE math and field validation remain deterministic.
Reminder results must pass the existing time parser. Exact opt-out and exact supported
reminder commands may continue to bypass the model.

### Phase 5: destructive cutover

Move natural correction and replacement classification last. Keep all existing
target validation and atomic database execution. Keep `isExplicitAddition()` as a
transitional backstop; its eventual removal is separate evidence-based work.

No phase requires a database migration.

## Shadow Metrics and Cutover Gates

The primary silent failure is a question being logged as food. It cannot be detected
from a successful-looking reply alone, so rollout uses both direct and proxy checks.

Track:

- old action versus proposed action disagreement rate;
- `log` versus `query` disagreements;
- router schema/consistency failures;
- clarification rate;
- provider fallback and total-failure rate;
- route latency p50, p90 and p99;
- logs followed shortly by `undo`, correction or explicit denial.

Before additive logging cutover:

- all 162 existing evals pass;
- all paired log/query routing fixtures pass;
- sanitized equivalents of all 11 protein-goal incidents route correctly;
- no reviewed shadow disagreement shows a question proposed as a log; and
- routing p99 remains below 12 seconds, leaving at least three seconds beneath
  Twilio's 15-second webhook ceiling for transport overhead.

The latency measurement is the first required output of Phase 1, not a late release
gate. A breach triggers the documented context-loading optimization before Phase 2.

Before destructive cutover, every correction/addition regression must pass and every
shadow disagreement involving `replace_last` or `undo` must be reviewed. A time-based
or confidence-based model score cannot waive these gates.

## Tests

### Pure contract tests

- Every allowed intent and enum value validates.
- Unknown values and missing required fields fail closed.
- `query` can never write a meal.
- `needs_clarification` prevents every mutation.
- Provider/schema failure produces no mutation.

### Behavioural routing tests

- Both kulfi corrections reach `replace_last`, never the protein-goal response.
- A Kulfi logged at 11:33 PM can be corrected at 12:33 AM; the replacement retains
  yesterday's date and the reply identifies yesterday's log.
- `item 9` remains current-day scoped after midnight and cannot collide with
  yesterday's item 9.
- Paired examples distinguish reports from questions:
  - `2 roti` / `calories in 2 roti?`;
  - `I had a protein shake` / `how much protein is in a shake?`;
  - `Kulfi was 60 calories and 10g protein` / `does kulfi have 10g protein?`.
- Goal pairs distinguish supplied values from requested calculations:
  - `Rahul 1600 calories 120g protein` -> `set_profile`;
  - `How much protein should I target?` -> `calculate_tdee` with protein requested.
- Explicit addition recovery never deletes the earlier item.
- Ambiguous correction/new-meal wording asks and writes nothing.
- Exact `undo N`, `delete N,M`, `forget N` and numbered replacement bypass the LLM.
- Active choice aliases such as `new only` and `correct it` work only while the
  matching state is active.
- History is loaded for self-contained named corrections as well as pronouns.
- History remains bounded, same-user, six-hour and prompt-injection protected.
- Correction targets remain exact, owned, recent and atomic.

Prefer behavioural `handleMessage()` tests with stubbed I/O over new assertions on
source text. Add multi-turn routing fixtures because single-turn parser evals cannot
cover state transitions.

### Required regression commands

At minimum:

```bash
npm run test:routing
npm run test:memory
npm run test:corrections
npm run test:tdee
npm run test:reminders
npm run test:outcomes
node evals/run.js
```

Because this changes the parser and prompt, `node evals/run.js` must remain 162/162.
Run the remaining project test scripts before production deployment.

## Deployment and Rollback

Each phase is a separate small commit and deployment:

1. run focused tests, all relevant suites and the 162-case live eval;
2. scan the complete diff for names, phone numbers, raw production text, ngrok URLs,
   API keys and secrets;
3. restart with `launchctl kickstart -k gui/501/com.nutridesi.server`;
4. verify `/health`, launchd status and post-restart logs;
5. replay only synthetic/anonymized acceptance conversations; and
6. confirm shadow metrics or the newly cut-over routes before advancing.

Rollback is per phase: revert the most recent routing commit and restart. Database
state does not require rollback because the design adds no schema and destructive
actions retain the already-deployed atomic transaction boundary.

## Documentation Updates During Implementation

The implementation must update:

- `CLAUDE.md` parser contract and routing boundary;
- `docs/ai-onboarding.md` module map, stateful-flow description and invariants;
- the latest handoff note with rollout status, test counts and any remaining shadow
  phases.
