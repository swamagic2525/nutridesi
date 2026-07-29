# NutriDesi — Claude Code Project Rules
**Version:** 1.1 | Updated 23 July 2026
**What we're building:** A WhatsApp-native Indian food calorie tracking bot. No app. No account. Users text what they ate in Hinglish and get calories back in seconds.

---

## The One Sentence That Matters

People don't fail at calorie tracking because the database is wrong — they fail because opening an app at 9pm after dinner is friction they won't do. This bot lives in WhatsApp, where they already are.

---

## Stack

```
WhatsApp → Twilio Sandbox → POST /whatsapp (Node/Express) → LLM parse → Supabase → TwiML reply
```

| Layer | Tool | Notes |
|---|---|---|
| WhatsApp interface | Twilio Sandbox (free) | Instant setup, no WABA approval needed for beta |
| Server | Node.js + Express (`server.js`) | Single synchronous webhook, Mac Mini under launchd |
| NLP Parser | Gemini → Groq → Claude (fallback chain) | `LLM_PROVIDER` env var sets primary; others are fallbacks |
| Database + state | Supabase free tier | Phone number → daily log → goal → calibration |
| Food data | Curated (347 items, in-prompt) + Reference (2,825 rows in Supabase, LLM-reranked) | Two-tier architecture |
| Tunnel | ngrok (stable URL) | Forwards to localhost:3000 |

**Do not introduce new tools without strong reason.** Complexity is the enemy at this stage.

---

## Architecture: Single Synchronous Webhook

Everything happens in one HTTP request — no queue, no background jobs.

1. Twilio sends POST to `/whatsapp` with the user's message
2. `server.js` → `handleMessage()` routes by intent (log / correct / undo / query / chitchat)
3. `preprocess()` strips WhatsApp markdown (`*`, `_`, `~`) — keeps emojis
4. `parseMeal()` calls the LLM (Gemini → Groq → Claude fallback chain) with system prompt + curated food directory
5. `resolveRows()` resolves nutrition: curated match → reference rerank → LLM estimate → placeholder
6. Logs to Supabase `user_logs`, calculates running daily total
7. Returns TwiML reply inline in the HTTP response

Response time is ~2-4 seconds. Twilio tolerates this within its webhook timeout.

**Two stateful flows sit alongside logging** (added 23-24 July 2026):
- **TDEE calculator** (`src/tdee.js`) — multi-turn collection of age/sex/height/weight/
  activity, then Mifflin-St Jeor. The LLM only classifies intent; **all arithmetic is
  deterministic code.** State in `users.tdee_profile`.
- **6-hour conversation memory** (`src/conversationMemory.js`) — up to 10 recent
  exchanges so short follow-ups resolve. History is passed to the LLM inside a quoted
  `BEGIN/END APP-PROVIDED RECENT CONVERSATION` envelope and treated as data, never
  instructions. State in `users.conversation_state`.

---

## The Parser Contract (LLM Output Schema)

Every call to the parse LLM must request this exact JSON structure. Do not deviate.

```json
{
  "items": [
    {
      "food_name": "Dal Tadka",
      "quantity": 1.0,
      "unit": "bowl",
      "matched_db_id": 17,
      "match_type": "direct",
      "portion_clarity": "specified",
      "confidence": 0.91,
      "is_estimate": false,
      "alias_used": "dal"
    }
  ],
  "meal_time_inferred": "lunch",
  "parse_notes": "user said 'dal', matched via alias. Portion from 'ek bowl'."
}
```

**`match_type` values:** `"direct"` | `"category"` | `"none"`
**`portion_clarity` values:** `"specified"` | `"inferred"` | `"unknown"`

### Quantity Field — Enum Constraint
The quantity field is constrained in the system prompt to prevent the LLM from returning arbitrary decimals. Always include this constraint:

```json
{
  "properties": {
    "quantity": {
      "type": "number",
      "description": "The normalized portion size multiplier. MUST ONLY be one of these exact values: 0.5, 1.0, 1.5, 2.0, or 3.0. Do not return any other decimal value."
    }
  }
}
```

Without this, the LLM may return `0.35` or `1.25` — values that don't map cleanly to the quantity normalisation table below.

---

## Two-Factor Routing Table

Primary routing logic. Confidence score is secondary signal only.

| match_type | portion_clarity | Action |
|---|---|---|
| `direct` | `specified` | Log silently |
| `direct` | `inferred` | Log with transparent assumption shown |
| `direct` | `unknown` | Log using personal calibration defaults |
| `category` | `specified` or `inferred` | Log at category average, show assumption |
| `category` | `unknown` | Log at category average, full assumption shown |
| `none` | any | Tier 3/4 fallback — never ask user to estimate |

**Calibrated confidence thresholds (secondary signal):**
- ≥ 0.85: Direct match — log silently
- 0.65–0.84: Close match — log with transparent assumption, no verification question
- < 0.65: Route to macro-category fallback immediately

---

## Four-Tier Fallback Chain (Never a Dead-End)

The bot must always log *something*. Never ask the user "how many calories do you think that was?"

1. **Tier 1:** Direct DB match → log silently
2. **Tier 2:** Category match → log at category average with transparent note
3. **Tier 3:** Unknown food but inferable macro → log at macro-category baseline (non-veg curry: 300 kcal, Indian sweet: 180 kcal, etc.)
4. **Tier 4:** Zero information → log as "meal — 300 kcal placeholder" and move on

**Only valid exception:** Food name is completely absent (e.g., "unlimited", "I don't know"). Then and only then ask: "What did you eat? I need a food name to log it."

---

## System Prompt Seeding Strategy

Do not pass raw JSON array to the LLM. Use alias-formatted single-line entries:

```
FOOD DATABASE — match only to items in this list. Return matched_db_id or null.

ID 1 | Roti / Chapati | aliases: roti, chapati, phulka, chappati, fulka | 89 kcal/piece
ID 17 | Dal Tadka | aliases: dal, daal, yellow dal, tadka dal, toor dal, arhar dal | 180 kcal/bowl
ID 23 | Butter Chicken | aliases: butter chicken, murgh makhani, BC | 320 kcal/bowl
ID 48 | Ghee | aliases: ghee, desi ghee | 45 kcal/tsp — MODIFIER ONLY, never base food
...
```

This format uses 60–70% fewer tokens than raw JSON and puts alias strings where the LLM's attention lands.

---

## Modifier Rules

When a food contains a modifier (ghee, butter, dahi, chutney), split into two separate items in the array. The modifier gets its own DB lookup. If the modifier is not in the database, apply Tier 3 fallback to the modifier only — do not downgrade the base food's confidence.

Example: "2 roti with Amul butter" →
- Item 1: Roti, quantity 2.0, matched_db_id: 1
- Item 2: Butter, quantity 1.0, unit: tsp, matched_db_id: 49

---

## Quantity Normalisation Map

Applied by `preprocess()` in `src/parser.js` before the string reaches the LLM:

| User input | Normalised quantity |
|---|---|
| thodi si, half, chota bowl, adha | `0.5` |
| ek, one, normal, standard (or no quantity given) | `1.0` |
| sawa, one and half, bada | `1.5` |
| do, two, bada bowl, full plate, dabake, poora | `2.0` |
| teen, three, extra | `3.0` |

---

## Key Product Rules (Enforce in Every Feature)

1. **One clarifying question per food type, ever.** Once answered, remembered permanently. Never ask the same question twice.
2. **Intent preemption.** If the bot is waiting for clarification and the user sends a new food, abandon the pending question, log the new food, reset state. Conversations never deadlock.
3. **Calibration fires after first log, not before.** Value first, questions second. Onboarding = first food logged immediately using national average defaults.
4. **Undo is narrow.** Fat-finger undo only: "undo" removes the last logged item. No historical editing in v1.
5. **Daily summary is opt-in.** No unsolicited messages. User sets time with "remind me at 9pm."
6. **Session merging window is 45 minutes.** Messages within 45 min of last log = same meal. After 45 min = new meal, confirm before logging.
7. **Transparency always.** Every log entry shows what was assumed. "2 rotis (medium, plain) → 178 kcal. With ghee? Reply '+ghee'."

---

## Supabase Schema

**`users` table:**
```
phone_number (PK), name, goal_kcal, goal_protein, katori_size, roti_size, created_at,
daily_summary_time, nudge_count, tdee_profile (jsonb), conversation_state (jsonb)
```
The two jsonb columns back the stateful flows: `tdee_profile` for the TDEE
calculator, `conversation_state` for the 6-hour conversation memory.

**`user_logs` table:**
```
id, phone_number (FK), food_name, matched_db_id, quantity, unit, kcal, protein, carbs, fat,
meal_time, is_estimate, logged_at, date (YYYY-MM-DD IST), day_seq
```

**`foods_reference` table (reference tier):**
```
food_code (PK), food_name, serving_kcal, serving_protein, serving_carbs, serving_fat, ...
```
~2,825 rows of branded products, recipes, regional dishes, fitness supplements. Matched via retrieve-then-rerank
(see `refCandidates` + `refRerank` in `src/db.js`).

**`food_preferences` table:**
```
phone_number (FK), food_type (e.g. "dal"), preference (e.g. "makhani"), set_at
```

**`message_log` / `founding_members`:** raw message records and waitlist signups.
Both hold real user text and real names — never export either into a committed file.

Migrations are `*.sql` files in the repo root, applied by hand in the Supabase SQL
editor. `supabase-schema.sql` is the consolidated current state.

---

## Accuracy Ceiling (Communicate This to Users)

Home-cooked Indian meal logging is ±15–20% accurate regardless of tool, because database values are averages, not your kitchen. This product targets directional awareness, not clinical precision. Consistent logging drives behavior change — not precise logging.

---

## What NOT to Build in v1

- Photo / camera-based food recognition
- Hindi script (Devanagari) input parsing
- Workout / exercise tracking
- Personalised meal recommendations
- Web or mobile app dashboard
- Multi-user or family tracking
- Paid subscription

Do not add features. Validate retention first.

---

## Success Metrics for Beta (50 users, zero paid marketing)

| Metric | Target | Interpretation |
|---|---|---|
| D7 retention | ≥ 40% | WhatsApp friction hypothesis holds |
| D30 retention | ≥ 30% | Habit loop forming |
| Parser direct match rate | ≥ 80% | Alias map sufficient |
| Silent failures (no log) | 0% | Fallback chain working |

**If D7 < 20%:** WhatsApp-native hypothesis is wrong. Stop, don't pivot the stack.
**If parser direct match < 70%:** Alias map needs expansion before more users.

---

## Reference Files

- `docs/ai-onboarding.md` — Full AI handoff doc (module map, workflow, invariants, open work)
- `docs/churn-reduction-report-2026-07-23.md` — Measured retention analysis. **Read before picking growth/retention work.**
- `docs/correction-incidents.md` — Real incident writeups (context for guardrails)
- `docs/superpowers/specs/` + `plans/` — Design docs for TDEE + conversation memory
- `evals/cases.jsonl` — 160 golden eval cases (the regression net)
- `.env.example` — All env vars with placeholder values
