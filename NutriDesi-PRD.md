# NutriDesi – Product Requirements Document
**Version:** 0.5 (MVP — no-code stack + two-scenario architecture + quantity schema guardrail)
**Author:** Working draft
**Status:** Final — ready for Make.com build sprint

---

## Context & Why This Exists

HealthifyMe and MyFitnessPal technically solve Indian calorie tracking. But talking to users reveals a different problem: **people aren't failing at tracking because the database is bad — they're failing because opening an app, finding the food, tapping portions, and dismissing coaching upsells is 30 seconds of friction they won't do at 9pm after dinner.**

The insight: the most-used communication tool in India is WhatsApp. People already narrate their day there. This product puts the log where the habit already lives.

---

## Problem Statement

Health-conscious urban Indians aged 25–40 want to track what they eat, but drop off from existing apps within 2 weeks because of account setup friction, app-switch overhead, aggressive coaching upsells (HealthifyMe's business model requires it), and food databases that don't recognise the way Indians actually describe food ("2 roti, half bowl dal, one small katori sabzi"). The cost of not solving this is clear: lifestyle diseases (PCOS, Type 2 diabetes, obesity) are rising fastest in exactly this demographic, and dietary awareness is the single most evidence-backed first intervention — but only if the logging habit sticks.

---

## Goals

**User goals**

1. A user can log a full day's meals in under 60 seconds total, without opening a dedicated app.
2. A user understands whether they are over or under their calorie goal at any point in the day by sending one message.
3. A user builds a 7-day logging streak within the first 14 days of using the product.

**Founder / business goals**

4. Validate that WhatsApp-native logging produces higher Day-14 retention than app-based tracking (hypothesis: >40% vs HealthifyMe's reported ~15% D14 retention).
5. Reach 200 active daily users within 90 days of launch through zero paid marketing, to confirm organic word-of-mouth in WhatsApp groups is a viable growth channel.

---

## Non-Goals (v1)

| What we will not build | Why |
|---|---|
| Photo / camera-based food recognition | Requires expensive vision API calls at scale; adds infra complexity before PMF is proven |
| Hindi script (Devanagari) input parsing | Hinglish in Roman script covers 90% of how urban Indians type on WhatsApp; pure Hindi script is v2 |
| Workout / exercise tracking | Separate habit loop; dilutes focus; HealthifyMe already does this adequately |
| Personalised meal recommendations | Requires clinical validation, dietician involvement, and significantly more user data |
| Web or mobile app dashboard | If users want an app, they already have HealthifyMe. This product wins by being appless. |
| Multi-user or family tracking | Single-user loop must work first; family mode adds significant product complexity |
| Paid subscription in v1 | Monetisation gates are removed until retention is proven; charge nothing until D30 retention clears 30% |

---

## Target Users

### Primary: The Lapsed HealthifyMe User
- Urban, 26–38 years old, Tier 1 Indian city
- Downloaded HealthifyMe at some point, used it for 1–3 weeks, stopped
- Knows roughly what a calorie is; has a weight or health goal (weight loss, PCOS management, "just being more aware")
- Uses WhatsApp 30–80 times per day
- Won't download another fitness app; will try something that requires zero install

### Secondary: The PCOS-Aware Woman
- 25–35, recently diagnosed or aware of PCOS
- Has been told by a doctor or nutritionist to track food; doesn't have a system that stuck
- High motivation, high drop-off from complex apps
- Strong word-of-mouth channel: PCOS WhatsApp groups are active and share tools aggressively

### Out of scope for v1
- Serious athletes with macro precision needs (they use MyMacros+ or Cronometer)
- Users outside India or Indian diaspora (food database is India-specific)
- Users who primarily speak Hindi in Devanagari script

---

## User Stories

### Core logging loop
- As a user, I want to send a WhatsApp message like "2 roti dal and chai for breakfast" and get back the calorie count instantly, so I don't have to open a separate app or search a database manually.
- As a user, I want to log meals throughout the day and ask "how much left?" at any point, so I know whether I can eat a snack without doing any mental math.
- As a user, I want the bot to understand Indian portion descriptions ("1 katori", "small bowl", "2 pieces", "half plate") so I don't have to look up gram weights.

### Goal setting
- As a new user, I want to set my daily calorie goal by sending one message ("my goal is 1600 cal"), so onboarding takes under 30 seconds.
- As a user, I want the bot to suggest a default calorie goal if I share my rough target ("I want to lose weight slowly"), so I don't have to know the number.

### Daily summary & accountability
- As a user, I want to receive a daily summary at a time I choose (e.g., 9pm) showing what I ate and whether I hit my goal, so I get a gentle close to the day without having to ask.
- As a user, I want to see a simple streak count ("Day 5 ✅") when I log, so I feel rewarded for consistency.

### Correction & editing
- As a user, I want to say "remove the chai I logged" or "undo last entry" and have it corrected, so a mistake doesn't ruin my day's data.
- As a user, if the bot doesn't recognise a food, I want it to ask me for the calories so I can continue logging, rather than hitting a dead end.

### Edge cases
- As a user who eats restaurant food, I want to log "biryani at Paradise" or "dal makhani, restaurant portion" and get a reasonable estimate with a clear disclaimer that it's an estimate.
- As a user who skips a day, I want the bot to not make me feel guilty — just pick up where I left off the next morning.

---

## Core Product Philosophy

**Consistency beats precision.** The biggest predictor of calorie tracking success is streak length, not accuracy. An estimate logged every day is worth more than a precise log three times a week. Every design decision should reduce friction first, then improve accuracy second.

**Directional accuracy is sufficient.** Research consistently shows that even careful, deliberate logging of home-cooked meals is ±20% accurate at best — because the database value for dal is an average across thousands of recipes, not your mom's recipe. Knowing you ate roughly 1,800 vs. 2,400 calories drives behavior change. Clinical precision requires a dietician and a food scale, not an app. NutriDesi is an awareness tool, not a clinical instrument. This must be communicated explicitly to users in onboarding.

**One question, never two — with intent preemption.** For every ambiguous food entry, the bot asks one clarifying question targeting the single highest-calorie variable. It never interrogates. For dal: the type (moong vs. makhani is a 3x calorie swing). For roti: ghee or plain (+45 kcal per tsp — half a roti's worth). For rice: quantity (small bowl vs. full plate is 2x). The bot then remembers the user's answer as their preference for that food. One question, once, then never again.

Critical: if the bot is waiting for a clarification answer and the user sends a *new food item* instead, the bot must **abandon the pending question, log the new food using its best estimate, and reset state cleanly**. Conversations must never deadlock. The user's next food always takes priority over any pending clarification.

**Fallback: always log something, never ask the user for calories.** When the parser cannot identify a food (low confidence, unknown regional dish, restaurant-specific name), it must never respond with "how many calories was it?" — that is homework, and it breaks the core value proposition. Instead, the fallback is always a graceful macro-category estimate: *"Couldn't find Chicken Rezala in my database, so I've logged it as a rich chicken curry (~350 kcal). Reply with a number if you want to override."* The user can correct or ignore — either way, the log continues. No dead ends, ever.

---

## Requirements

### P0 — Must-Have (MVP cannot ship without these)

**1. WhatsApp interface**
The entire product must be accessible via WhatsApp. No app download, no account creation beyond a first message. Keyed to phone number.
- *Acceptance criteria:* A user's first message to the bot number triggers onboarding in under 3 messages. Goal is set. Logging works. All within WhatsApp.

**2. Natural language food parsing (English + Hinglish) with explicit schema and fallback chain**
The bot must parse free-text meal descriptions and map them to the food database with reasonable accuracy. The parser must return a structured JSON response to the backend — this is the contract between the LLM and the application layer.

**Important technical note on LLM confidence scores (added post product director review):**
LLMs do not calculate true mathematical confidence. When asked to self-rate, Claude Haiku's scores cluster at extremes — either 0.90–0.95 (overconfident) or 0.10–0.20 (confused) — rarely producing a meaningful gradient between 0.50 and 0.80. A blanket confidence score will cause the medium band to misfire: the LLM may return 0.75 for a wrong guess, triggering a "Right?" confirmation loop that reintroduces friction. The schema below addresses this with a two-factor evaluation.

Required parser output schema:
```json
{
  "items": [
    {
      "food_name": "Dal Tadka",
      "quantity": 1,
      "unit": "bowl",
      "matched_db_id": 27,
      "match_type": "direct",
      "portion_clarity": "specified",
      "confidence": 0.91,
      "is_estimate": false,
      "alias_used": "dal"
    }
  ],
  "meal_time_inferred": "lunch",
  "parse_notes": "user said 'dal', matched to Dal Tadka via alias. Portion inferred from 'one bowl'."
}
```

**Two-factor routing (replaces single confidence threshold):**

| Factor 1: DB Match | Factor 2: Portion Clarity | Action |
|---|---|---|
| `match_type: "direct"` | `portion_clarity: "specified"` | Log silently, confirm inline |
| `match_type: "direct"` | `portion_clarity: "inferred"` | Log with transparent assumption shown |
| `match_type: "category"` | Either | Drop immediately to macro-category fallback |
| `match_type: "none"` | Either | Log as unknown at 300 kcal conservative, add to review queue |

`match_type` values: `"direct"` (food ID in DB, high-certainty alias), `"category"` (food group known, specific dish not in DB), `"none"` (cannot identify food or category).

`portion_clarity` values: `"specified"` (user stated quantity + unit), `"inferred"` (bot assumed from context or personal defaults), `"unknown"` (neither — treat as 1 medium serving).

**Calibrated confidence thresholds (for reference — two-factor is primary routing):**
- ≥ 0.85: Direct name/alias match. Log silently.
- 0.65–0.84: Close match with assumption. Log transparently, no verification question.
- < 0.65: Ambiguous. Do not guess. Route to macro-category fallback immediately. Never ask user to verify a low-confidence guess.

The rationale for raising the medium floor from 0.50 to 0.65: below 0.65, the LLM is making category-level associations, not food-level matches. Asking "Logged as Mix Veg — right?" for a wrong guess reintroduces friction faster than a transparent macro-category fallback.

**Fallback chain (in order — never skip to the last step):**
1. **Direct match, portion specified (≥ 0.85):** Log silently. *"Logged: 2 rotis, plain → 178 kcal ✓"*
2. **Direct match, portion inferred (0.65–0.84):** Log with assumption visible. *"Dal Tadka (1 bowl, medium) → 180 kcal. Logged — with ghee? Reply '+ghee'."*
3. **Category match only (< 0.65):** Macro-category fallback, no verification question. *"Couldn't find Chicken Rezala in my list — logging as rich chicken curry (~350 kcal). Reply with a number to override."*
4. **No match:** Conservative 300 kcal placeholder. *"Logged that as a meal (~300 kcal estimate). Reply with the actual number if you know it."* Add raw input to review queue for database expansion.

**System prompt seeding strategy (for tech co-founder):**
Do not pass the raw 88-item JSON array to the LLM. Format it as a matching-optimised alias list — this is what drives direct match accuracy:

```
FOOD DATABASE — match only to items in this list. Return matched_db_id or null.

ID 1 | Roti / Chapati | aliases: roti, chapati, phulka, chappati, fulka | 89 kcal/piece
ID 2 | Paratha (Plain) | aliases: paratha, plain paratha, tawa paratha | 155 kcal/piece
ID 27 | Dal Tadka | aliases: dal, daal, yellow dal, tadka dal, toor dal | 180 kcal/bowl
ID 28 | Dal Makhani | aliases: dal makhani, makhani dal, kali dal, black dal | 280 kcal/bowl
...
```

Aliases are the single biggest lever on parse accuracy. "Chapati" returning no match because the DB says "Roti / Chapati" is a fatal prompt engineering failure. Build the alias list before the tech co-founder writes a line of backend code — it is a product task, not an engineering task.

**Prompt engineering effort estimate:** 1 week of iteration to hit ≥ 80% direct match rate on a 50-phrase test set. This is the highest-risk build task in the entire MVP and should be started in Week 1, not treated as a detail.

Inputs to support: "2 roti", "one bowl dal tadka", "half plate rice with sabzi", "chai", "aloo paratha with dahi", "3 idli sambar", "varan bhaat", "sol kadhi", "chicken rezala" — regional and unknown dishes route to fallback chain, not errors.

**Pre-processing pipeline — before the string reaches Claude Haiku (added post product director review v0.4):**

The backend must run a lightweight regex pre-processor on every incoming WhatsApp message *before* passing it to the LLM. Three things to handle:

**(a) Quantity normalisation for loose terms.** Hinglish quantity words are vague and will produce unpredictable fractional outputs if left unresolved. Force discrete multipliers:

| User says | Normalised `quantity` |
|---|---|
| "thodi si", "half", "chota bowl", "half katori" | `0.5` |
| "ek", "one", "normal", "standard", "ek katori" | `1.0` |
| "do", "two", "bada bowl", "full plate", "dabake" | `2.0` |
| "teen", "three", "extra" | `3.0` |

Include this mapping table explicitly in the system prompt. If a loose term does not match the table, default to `1.0` and set `portion_clarity: "inferred"`. Never allow the LLM to return a non-standard decimal (e.g., `0.35`) for a quantity field.

**Critical for no-code Make.com implementation (added post director review):** In a coded backend, enforcing discrete quantity values is trivial via an `enum` or array lookup. In Make.com, the only enforcement point is the JSON schema passed to Claude Haiku. The `quantity` property must explicitly declare its allowable values inside the schema object sent with every API call:

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

Without this explicit boundary in the schema, Claude Haiku may return `0.35` or `1.25` for ambiguous inputs — values that Make.com's mathematical routers cannot handle cleanly, causing silent failures in the calorie calculation step. This schema declaration is the no-code equivalent of an enum constraint.

**(b) Modifier extraction — main entity and modifiers are separate `items` array objects.** When a user says "2 roti with Amul butter" or "dal with ghee", the parser must not search for a single DB entry called "Roti with Butter." System prompt must instruct: *"If a food contains a modifier (butter, ghee, oil, dahi, chutney), split into two separate items: the base food and the modifier. Match each independently."*

Example: "2 roti with Amul butter" →
```json
[
  {"food_name": "Roti", "quantity": 2, "matched_db_id": 1, "match_type": "direct"},
  {"food_name": "Butter", "quantity": 1, "unit": "tsp", "matched_db_id": [butter ID], "match_type": "direct"}
]
```

If the modifier is not in the 88-item database (e.g., a regional pickle), apply the Tier 3 fallback to the modifier only — the confidence of the base food item is unaffected. This prevents one unknown ingredient from downgrading an otherwise clean match.

**(c) WhatsApp markdown and emoji stripping.** Users send bold text (`*2 roti*`), underlines, accidental copy-pastes with newlines, and emojis (`2 roti 🫓 + dal 🥣`). A 5-line regex pre-processor (engineer task, not product task) strips WhatsApp markdown characters (`*`, `_`, `~`, `>`) before the string hits the LLM. Emojis should be *preserved* — food emojis are strong contextual anchors that significantly improve match accuracy and cost nothing to pass through.

This pre-processing is a one-time engineering task estimated at half a day. It prevents an entire category of parser failures and should be built before any prompt engineering testing begins.

- *Acceptance criteria:* In a test of 50 common Indian meal descriptions, `match_type: "direct"` on ≥ 80% of items. Zero responses that ask the user to estimate calories. All low-confidence items route to macro-category fallback within 2 seconds. `is_estimate: true` appends "(estimate)" tag in every WhatsApp response where it is set.

**3. Indian food database (88+ items, expandable)**
Minimum viable database covering the foods that constitute 80% of meals for the target user: North + South Indian staples, common snacks, beverages, sweets, restaurant-style dishes.
- *Acceptance criteria:* Foods from the NutriDesi prototype (88 items) are baseline. All items have calories, protein, carbs, fat per default serving. Database is structured so new items can be added without code changes.

**4. Fragmented message handling — session merging**
Users text like they think: fragmented and interrupted. "2 roti" at 1:30pm, then "and dal" at 1:55pm are parts of the same meal, not two separate meals.

Rule: any food message arriving within **45 minutes** of the previous log is treated as a continuation of the same meal and merged into the same meal bucket. After 45 minutes of inactivity, a new message opens a new meal event (prompting the user to confirm which meal: "That sounds like a snack — adding to Snacks. Right?").

State machine requirements:
- Bot must track: `last_message_timestamp`, `current_open_meal`, `pending_clarification` (boolean)
- If `pending_clarification = true` and user sends a food item (not a clarification), bot must: set `pending_clarification = false`, process the new food item, skip the pending question, log using best estimate.
- Pending clarification questions are abandoned, never repeated.

- *Acceptance criteria:* A two-part message sent 30 minutes apart ("2 roti" then "and dal") is logged as a single Lunch entry. A message sent 60 minutes after the previous log prompts meal confirmation before logging. A new food item sent while clarification is pending is logged immediately without requiring the clarification to be answered first.

**5. Daily calorie tracking and goal management**
Log persists across a calendar day, resets at midnight. Users can query total and remaining at any point.
- *Acceptance criteria:* "Total today" and "how much left" queries return correct running totals within 2 seconds. Day resets correctly at midnight IST.

**6. Personalised calibration — triggered after first successful log, not before**

*Changed from earlier version based on product director feedback: calibration before first value delivery drops onboarding completion. Value first, questions second.*

Flow:
1. User sends first food message → bot logs it immediately using national average defaults → delivers calorie count (dopamine hit first).
2. *After* that first log confirmation, bot sends: *"By the way — to make this accurate for you specifically, two quick things: what size is your usual katori? [Small] [Medium] [Large]. And your rotis: [Small] [Medium] [Large]."*
3. These become permanent personal defaults for all future logs.

The system also asks one clarifying question per food type on first encounter (see Product Philosophy above), then remembers the user's preference permanently.

- *Acceptance criteria:* First food message is logged within one bot response, no calibration required. Calibration prompt appears only after the first log confirmation. All subsequent logs use calibrated defaults. Assumptions always shown transparently: "2 rotis (medium, plain) → 178 kcal. With ghee? Reply '+ghee'". Users can update with "change my katori size".

**7. Daily summary (opt-in, time-customisable)**
Automated end-of-day message with total eaten, goal delta, and streak.
- *Acceptance criteria:* User can set reminder time with "remind me at 9pm". Summary arrives ±5 minutes of set time. Users who haven't opted in do not receive unsolicited messages.

---

### P1 — Should Have (high-priority fast follow, target within 4 weeks of v1 launch)

**5. Undo last entry (narrow scope — fat-finger protection only)**

*Scope narrowed from earlier version: full historical editing moved to P2. Fat-finger undo retained in P0 because WhatsApp context-switching means accidental food logs to the bot happen regularly and cause user distrust.*

"Undo", "remove last", "delete that" remove only the most recent log item. Editing or removing older entries is P2. This is a 20-line implementation that prevents the most common trust-breaking moment in the beta.
- *Acceptance criteria:* Any of the trigger phrases removes the last-logged item and confirms. Only the most recent item is affected. Historical log is otherwise immutable in v1.

**7. Streak tracking**
Day count of consecutive days with at least one log entry. Displayed on daily summary and on-demand.

**8. "What did I eat today?" full log recap**
User can ask to see the full day's log as a list with individual calorie counts.

**9. Quick add for repeated meals**
"Same breakfast as yesterday" should work. Reduces friction for users with routine mornings.

**10. Portion size guidance**
When a food is logged without a quantity ("just had some poha"), bot asks one question: "Roughly how much — small bowl, medium bowl, or large?" rather than asking for grams.

**11. Basic onboarding flow**
First message triggers: ask name (optional), ask goal (weight loss / maintenance / muscle gain), suggest calorie target, confirm. Under 5 messages total.

---

### P2 — Future Considerations (design with these in mind, do not build now)

**12. Photo-based food logging** — snap a photo, AI estimates the meal. Requires vision model integration and significant cost per query. Design the parsing module as a swappable layer so photo input can replace text input in future without restructuring the database or response logic.

**13. PCOS / condition-specific mode** — lower-carb targets, iron/folate tracking, cycle-phase awareness. Keep data model extensible to support additional nutrient fields beyond cal/protein/carbs/fat.

**14. WhatsApp group mode** — accountability partner or small group (2–5 people) shares a daily summary. Peer accountability is one of the strongest retention levers in habit-formation research.

**15. Hindi script (Devanagari) input** — "आज सुबह 2 रोटी और दाल खाई". Requires a separate NLP pipeline. Structure the language parsing layer to be pluggable.

**16. Paid tier** — meal history beyond 7 days, PDF weekly report, personalised targets, custom recipe saving. Do not build until D30 retention exceeds 30%.

---

## Success Metrics

### Leading indicators (check weekly)

| Metric | Definition | Target (30 days post-launch) |
|---|---|---|
| Activation rate | % of users who log at least 1 meal within 24h of first message | ≥ 70% |
| D7 retention | % of activated users who log on Day 7 | ≥ 40% |
| Daily log volume | Average messages logged per active user per day | ≥ 2 (breakfast + dinner minimum) |
| Parse success rate | % of food messages correctly identified without fallback | ≥ 80% |
| Onboarding completion | % of first-message users who complete goal setup | ≥ 85% |

### Lagging indicators (check at 60 and 90 days)

| Metric | Definition | Target |
|---|---|---|
| D30 retention | % of activated users still logging on Day 30 | ≥ 30% (hypothesis: 2× HealthifyMe's reported D14) |
| Organic referral rate | % of new users who found product via WhatsApp share / recommendation | ≥ 40% of signups |
| Streak distribution | % of active users with a 7-day streak | ≥ 25% by Day 45 |
| Word-of-mouth NPS proxy | Users who forward the bot number to someone else | Track via referral code in welcome message |

### Accuracy benchmark (new — to validate against FITTR/HealthifyMe data)

| Metric | Definition | Target |
|---|---|---|
| Calibration adoption | % of users who complete the katori/roti calibration in onboarding | ≥ 90% |
| One-question clarification rate | % of food logs that trigger a clarifying question | ≤ 20% (i.e., 80% of logs are confident, no question needed) |
| User-reported accuracy satisfaction | % of users who rate "close enough" or better in Week 2 check-in | ≥ 75% |

### The daily summary is the primary retention engine

*Flagged explicitly after product director review: D30 retention is achievable at 25–35% (consistent with fintech WhatsApp utility bots like early Khatabook experiments) — but only because of the proactive end-of-day push. Without this feature, D30 will likely fall below 10% as the bot drifts below the fold in users' chat lists. The scheduled summary transforms a passive tool users forget into an active accountability trigger.*

Implementation note: The summary time must be set by the user, not defaulted. A summary that arrives at the wrong time (during dinner, during work) will be muted and then ignored permanently.

### What failure looks like
If D7 retention is below 20% after 2 weeks with 50+ activated users, the core hypothesis (WhatsApp reduces friction enough to change retention) is not validated and the product direction needs revisiting before building further.

If the fallback review queue (unknown foods from Requirement 2) shows more than 20% of all logs triggering low-confidence fallback after Week 2, the database needs emergency expansion before open beta — not as a scheduled Week 5 task.

If parse success rate stays below 70% after database expansion in Week 5, the Hinglish NLP approach needs a rethink — likely switching from a pure LLM approach to a hybrid rule-based + LLM system for common foods.

---

## Open Questions

| Question | Owner | Blocking? |
|---|---|---|
| WhatsApp Business API access: apply for WABA directly (2–4 week approval) or use Twilio Sandbox for testing? | Founder + Tech co-founder | Yes — determines launch timeline by ~4 weeks |
| What LLM do we use for food parsing, and what is cost-per-message at scale? Claude Haiku is ~$0.0008/message; 200 DAU × 5 messages = ~$2.40/day. Acceptable? | Tech co-founder | No — manageable at MVP scale, revisit at 1K DAU |
| Is the 88-item food database enough for 80% of meals, or do we need 200+ items before launch? | Founder (user research) | No — ship with 88, add top-requested foods in Week 2 based on parse failures |
| PCOS WhatsApp groups as distribution: do we need a specific PCOS-aware mode to get traction there, or does generic calorie tracking serve them adequately in v1? | Founder | No — generic v1, PCOS mode is P2; validate via user interviews in first 2 weeks |
| Data privacy: user food logs are stored linked to phone number. Is this acceptable without explicit consent flow in India's DPDP framework? | Legal (consult before launch) | Yes — must add privacy notice and consent on first message before storing any data |
| Restaurant / branded food estimates: do we disclaim clearly when returning an estimate vs. a verified entry? | Product + Founder | No — add "(estimate)" tag in responses for restaurant items; design this from Day 1 |
| What level of calorie inaccuracy is "good enough" for behavior change in a non-clinical, awareness-only context? FITTR coaches likely have direct experience with this. | Validation (Jitendra/FITTR) | No — directional answer shapes onboarding copy and user expectation-setting |
| Do FITTR users who self-track without a coach show meaningfully different retention than those with a coach from Day 1? This would validate or kill the self-serve assumption. | Validation (Jitendra/FITTR) | No — shapes whether NutriDesi targets pre-FITTR users or truly never-FITTR users |

---

## Technical Architecture (for conversation with tech co-founder)

This is not a requirements section — it is context to help scope the build conversation.

**Recommended MVP stack (no-code solo-founder path — updated post director review):**
- **WhatsApp interface:** Twilio WhatsApp Sandbox (free; users join once via keyword → fully clean retention signal post-onboarding)
- **Orchestration:** Make.com (~₹800/month) — visual scenario builder, no code required
- **Food parsing:** Claude Haiku API or Gemini API (pay-per-use; ~₹300–500/month at 50 DAU)
- **Food database + user state:** Supabase free tier (phone number → daily log → goal → calibration defaults)
- **Scheduled summaries:** Make.com time-based trigger scenario

**Critical architecture: two-scenario pattern to avoid Twilio timeout failures (added post director review)**

Twilio requires an HTTP `200 OK` response almost instantly after delivering a message. A single Make.com scenario that sequentially calls Claude + reads/writes Supabase + sends a reply can stretch to 4–6 seconds, causing Twilio to time out and drop or duplicate messages — corrupting the user experience silently.

The fix — split into two Make.com scenarios:

- **Scenario A (instant):** Receives Twilio webhook → writes the raw message + phone number to a Supabase `pending_jobs` table → returns `200 OK` to Twilio immediately. No AI call. Sub-second.
- **Scenario B (triggered):** Watches for new rows in `pending_jobs` → calls Claude Haiku with system prompt + alias map → calculates running total → updates user log in Supabase → sends WhatsApp reply via Twilio. All logic lives here.

This pattern completely eliminates timeout failures and is buildable entirely within Make.com with no code.

**Note on the regex pre-processor in Make.com:** Stripping WhatsApp markdown (`*`, `_`, `~`) using Make.com's native string functions is doable but produces messy visual scenarios. Recommended: one "clean input" step at the start of Scenario B using Make.com's built-in `replace()` and `trim()` functions chained together. Tedious to test, but a one-time setup cost.

**Estimated build time (solo, no-code, Claude Pro as building partner):**
- Webhook-to-Claude loop working end-to-end: 2–3 days
- Supabase state + daily log wired up: +2 days
- Daily summary trigger + opt-in: +1 day
- Total to first beta-ready message: ~1 week of focused evenings

**Estimated monthly infra cost at 50-user beta:** Under ₹1,500/month (Make.com + Supabase free tier + Claude API). Same stack can scale to 200 DAU before migrating to coded backend.

**Tech co-founder path (post-PMF):** Node.js or Python (FastAPI) on Railway or Render replaces Make.com after retention is proven. The PRD, alias map, and 50-phrase test suite hand directly to a developer — the no-code beta generates the evidence that makes recruiting a technical partner significantly easier.

---

## Timeline

| Milestone | Target | Notes |
|---|---|---|
| Tech co-founder aligned on stack | Week 1 | Non-negotiable dependency |
| Food parsing prototype (text → calories via WhatsApp) | Week 2 | Twilio sandbox, no persistence yet |
| Full MVP: logging, goals, daily summary, undo | Week 3–4 | Full loop working end-to-end |
| Closed beta: 20 users from founder's network | End of Week 4 | No public launch; collect failure logs |
| Food database expanded based on beta parse failures | Week 5 | Add top 20 unrecognised foods |
| Open beta: share in 3–5 WhatsApp/Instagram communities | Week 6 | PCOS groups, fitness communities, friends-of-friends |
| D30 retention check | Week 10 | Go/no-go on paid tier and PCOS mode |

**Hard constraint:** Do not invest in WABA application fees, paid LLM tier upgrades, or any paid marketing before D7 retention clears 40% with the first 50 users. Every rupee spent before that is a bet on an unvalidated hypothesis.

---

## What v2 Looks Like (only if v1 retention validates)

If D30 retention exceeds 30% and organic referral exceeds 40% of signups, the next spec covers:
- PCOS-specific mode (lower carb targets, iron/folate fields, cycle-phase integration)
- Paid tier (₹149/month: history, PDF weekly report, custom recipes)
- WhatsApp group accountability (2–5 people share daily log)
- Photo logging pilot (limited to 10 foods, test accuracy before scaling)

The point of v2 is not to build more features. It is to pick the one retention or monetisation lever the data says matters most and build that one thing extremely well.

---

*This PRD is intentionally narrow. The goal is not to describe every possible feature of a calorie tracking product — it is to describe the minimum set of decisions that need to be made before a tech co-founder writes a single line of code. Everything in P2 exists to prevent architectural dead ends, not to create a feature roadmap.*
