# NutriDesi — Claude Code Project Rules
**Version:** 1.0 | Based on PRD v0.5
**What we're building:** A WhatsApp-native Indian food calorie tracking bot. No app. No account. Users text what they ate in Hinglish and get calories back in seconds.

---

## The One Sentence That Matters

People don't fail at calorie tracking because the database is wrong — they fail because opening an app at 9pm after dinner is friction they won't do. This bot lives in WhatsApp, where they already are.

---

## Stack (Non-Negotiable for Beta)

```
Twilio WhatsApp Sandbox → Make.com → Claude Haiku API → Supabase → Twilio reply
```

| Layer | Tool | Why |
|---|---|---|
| WhatsApp interface | Twilio Sandbox (free) | Instant setup, no WABA approval needed for 50-user beta |
| Orchestration | Make.com (~₹800/month) | No-code, visual, solo-founder buildable |
| NLP Parser | Claude Haiku API (pay-per-use) | Cheapest model capable of Hinglish parsing |
| Database + state | Supabase free tier | Phone number → daily log → goal → calibration |
| Scheduled summaries | Make.com time trigger | Same tool, no extra infra |

**Do not introduce new tools without strong reason.** Complexity is the enemy at this stage.

---

## Architecture: Two-Scenario Pattern (Critical — Do Not Collapse Into One)

Twilio requires an HTTP `200 OK` almost instantly. A single scenario calling Claude + Supabase + reply takes 4–6 seconds and causes Twilio timeouts, dropped messages, and duplicates.

**Scenario A — Ingestion (instant):**
1. Receives Twilio webhook
2. Writes `{phone_number, raw_message, timestamp, status: "pending"}` to Supabase `pending_jobs` table
3. Returns `200 OK` to Twilio immediately
4. Does NOT call Claude. Does NOT do any calculation.

**Scenario B — Processing (triggered by new Supabase row):**
1. Picks up new row from `pending_jobs`
2. Runs text pre-processor (strip `*`, `_`, `~` WhatsApp markdown — keep emojis)
3. Calls Claude Haiku API with system prompt + alias map + user message
4. Parses JSON response
5. Calculates running daily total from Supabase `user_logs`
6. Updates `user_logs` and marks `pending_jobs` row as `"done"`
7. Sends WhatsApp reply via Twilio

---

## The Parser Contract (Claude Haiku Output Schema)

Every call to Claude Haiku must request this exact JSON structure. Do not deviate.

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

### Quantity Field — Enum Constraint (Make.com Critical)
In a coded backend this is enforced via enum. In Make.com, it must be enforced in the schema sent to Claude. Always include this in the `quantity` property description:

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

Without this, Claude may return `0.35` or `1.25` — values Make.com's math modules cannot handle cleanly.

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

Do not pass raw JSON array to Claude. Use alias-formatted single-line entries:

```
FOOD DATABASE — match only to items in this list. Return matched_db_id or null.

ID 1 | Roti / Chapati | aliases: roti, chapati, phulka, chappati, fulka | 89 kcal/piece
ID 17 | Dal Tadka | aliases: dal, daal, yellow dal, tadka dal, toor dal, arhar dal | 180 kcal/bowl
ID 23 | Butter Chicken | aliases: butter chicken, murgh makhani, BC | 320 kcal/bowl
ID 48 | Ghee | aliases: ghee, desi ghee | 45 kcal/tsp — MODIFIER ONLY, never base food
...
```

This format uses 60–70% fewer tokens than raw JSON and puts alias strings where Claude's attention lands.

---

## Modifier Rules

When a food contains a modifier (ghee, butter, dahi, chutney), split into two separate items in the array. The modifier gets its own DB lookup. If the modifier is not in the database, apply Tier 3 fallback to the modifier only — do not downgrade the base food's confidence.

Example: "2 roti with Amul butter" →
- Item 1: Roti, quantity 2.0, matched_db_id: 1
- Item 2: Butter, quantity 1.0, unit: tsp, matched_db_id: 49

---

## Quantity Normalisation Map

Apply this *before* the string reaches Claude (Make.com text processing step):

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

## Supabase Schema (Minimum Viable)

**`users` table:**
```
phone_number (PK), goal_kcal, katori_size, roti_size, created_at, daily_summary_time
```

**`user_logs` table:**
```
id, phone_number (FK), food_name, matched_db_id, quantity, unit, kcal, protein, carbs, fat,
meal_time, is_estimate, logged_at, date (YYYY-MM-DD IST)
```

**`pending_jobs` table:**
```
id, phone_number, raw_message, status ("pending"/"done"/"failed"), created_at, processed_at
```

**`food_preferences` table:**
```
phone_number (FK), food_type (e.g. "dal"), preference (e.g. "makhani"), set_at
```

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

- `../NutriDesi-PRD.md` — Full PRD v0.5
- `../NutriDesi-TestSuite-v1.xlsx` — 50-phrase test suite with expected outputs
- `../NutriDesi-Validation-Brief.md` — Director + FITTR founder validation brief

---

## Build Order (3-Day Sprint)

**Day 1:** Twilio Sandbox → Make.com Scenario A webhook → Supabase `pending_jobs` row → `200 OK`. Nothing else.

**Day 2:** Make.com Scenario B → picks up row → calls Claude Haiku with system prompt → structured JSON output logged to console/Supabase.

**Day 3:** Map JSON fields → calculate running total → format WhatsApp reply → send back via Twilio. First end-to-end test message on your own phone.

**Week 2:** Wire personal calibration, daily summary opt-in, undo. Invite first 10 beta users.
