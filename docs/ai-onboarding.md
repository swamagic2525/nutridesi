# AI Handoff — NutriDesi

**For any AI model picking up build work in this repo.** Read this top-to-bottom
before touching code. Reflects the codebase as of **24 July 2026** (live private beta,
155 real users).

---

## 0. What's TRUE vs STALE

| File | Status | Notes |
|---|---|---|
| `CLAUDE.md` | Accurate | Product rules, stack, schema. **Authoritative.** Rewritten 23 Jul to match the real architecture. |
| `README.md` | Accurate | Product overview + architecture. |
| `docs/ai-onboarding.md` | **This file** | You're reading it. |
| `docs/correction-incidents.md` | Accurate | Real incident writeups — read for context on why certain guardrails exist. |
| `docs/churn-reduction-report-2026-07-23.md` | Accurate | **Read this before picking retention work.** Real metrics: D7 is 5.3% vs a 40% target. Says database coverage is NOT the main lever. |
| `docs/superpowers/specs/` + `plans/` | Accurate | Design docs + implementation plans for TDEE and conversation memory. Both shipped. |
| `docs/post-launch-backlog.md` | Partially stale | Some items are done (rerank, meal blocks). Treat as idea list, not a plan. |
| `docs/codex-handoff-2026-07-17.md` | Stale | Pre-dates rerank, typo tolerance, meal blocks, TDEE, conversation memory. Ignore. |
| `docs/metrics-dashboard-prd.md` | Partially stale | Dashboard shipped; PRD not updated since. |

---

## 1. What this is (30 seconds)

WhatsApp bot for Indian food calorie tracking. User texts Hinglish food ("2 roti
aur dal", "1 scoop whey", "epigamia yogurt"), gets calories + macros back in ~3s.
Phone number = identity. No app, no account, no sign-up.

```
WhatsApp → Twilio Sandbox → POST /whatsapp (Express, server.js)
  → parse via LLM (Gemini → Groq → Claude fallback chain)
  → resolve nutrition (curated → reference rerank → LLM estimate)
  → Supabase insert + TwiML reply inline
```

One **synchronous** webhook. Everything happens in the request; reply returns inline
in the HTTP response. There is **no** Make.com, no queue, no "Scenario A/B".

Besides meal logging, the bot also runs two **stateful** flows (both added 23-24 Jul):
a **TDEE calculator** (multi-turn, collects age/sex/height/weight/activity) and a
**6-hour conversation memory** (lets short follow-ups like "same again" resolve
against recent exchanges). Both persist state on the `users` row — see §4.

---

## 2. Module map

### Core pipeline (read in this order)

| File | What it does |
|---|---|
| `server.js` | Express app. `handleMessage()` orchestrates the full flow: intent routing, correction/undo/replace dispatch, reply formatting, welcome flow. All routes defined here. |
| `src/parser.js` | LLM calls + provider fallback chain. `parseMeal()` returns structured JSON. `preprocess()` strips WhatsApp markdown. `pinPizzaSlices()` deterministically fixes pizza unit. `askLLM(text, system)` is a generic single-shot caller used by the reranker. |
| `src/systemPrompt.js` | The system prompt sent to the LLM + `buildFoodDirectory()` which formats curated foods as alias-formatted lines for token efficiency. |
| `src/foods.js` | **Curated tier** — 347 hand-verified foods with Hinglish aliases, macros. These go IN the prompt. |
| `src/db.js` | Supabase I/O, nutrition resolution pipeline (`resolveRows`), reference food matching (`refCandidates`, `refRerank`), fuzzy scoring (`editSim`, `matchScore`), logging, corrections, daily totals. **The biggest file — ~600 lines.** |
| `src/rerank.js` | LLM-based semantic matching. `rerankReference()` picks a food_code from reference candidates. `rerankTarget()` picks which logged item a correction refers to. Both validate against the candidate set (anti-hallucination). |
| `src/contextGuard.js` | Re-verifies every LLM-returned food ID against the curated alias map. Catches hallucinated IDs. |
| `src/correctionContext.js` | Pure helpers for correction detection + scoping corrections to the last log batch. |

### Stateful flows (added 23-24 Jul 2026 — not in older docs)

| File | What it does |
|---|---|
| `src/tdee.js` | **Deterministic TDEE calculator** (~520 lines). Mifflin-St Jeor. `isTdeeRequest()` classifies intent, `advanceTdee()` is the state machine driving the multi-turn collection, `calculateTdee()` does the math, `suspiciousReasons()` gates implausible inputs. **No LLM in the math path** — the LLM only routes intent. Unit conversion helpers (`lbToKg`, `feetToCm`) are pure. |
| `src/conversationMemory.js` | **6-hour bounded conversation memory** (~410 lines). Keeps up to `MAX_EXCHANGES` (10) recent exchanges within `WINDOW_MS` (6h) so short follow-ups resolve. `formatConversationContext()` wraps history in a quoted `BEGIN/END APP-PROVIDED RECENT CONVERSATION` envelope so the LLM treats it as **data, not instructions** (prompt-injection boundary). `claimConversationState`/`clearConversationStateIfUnchanged` in db.js give it optimistic concurrency. |

### Supporting modules

| File | What it does |
|---|---|
| `src/proteinGuard.js` | Flags implausible protein/calorie ratios |
| `src/gapLogger.js` | Logs uncovered foods to `evals/db-gaps.jsonl` for analysis |
| `src/correctionLogger.js` | Logs correction events for analysis |
| `src/metrics.js` + `src/metricsPage.js` | `/metrics` dashboard (behind HTTP Basic Auth) |
| `src/meta.js` | Meta/WhatsApp Cloud API path (future WABA migration; Twilio is live) |

### Offline tooling

| Path | What it does |
|---|---|
| `evals/run.js` | Eval suite runner — 160 golden cases through the real LLM |
| `evals/cases.jsonl` | The eval cases themselves (one JSON per line) |
| `test/*.js` | 16 unit/integration test files |
| `scripts/ingest-foods/` | Bulk ingestion pipeline for reference tier (markdown → Supabase rows) |
| `scripts/healthcheck.js` | Watchdog that alerts if the server goes down |
| `*.sql` (repo root) | Schema migrations, applied by hand in the Supabase SQL editor. `supabase-schema.sql` is the consolidated current schema; the others are incremental. |

---

## 3. Two-tier food architecture (critical to understand)

### Curated tier (`src/foods.js`)
- 347 items, hand-verified macros, Hinglish aliases
- Injected INTO the LLM system prompt as alias-formatted lines
- Deterministic: LLM returns `db_id`, `contextGuard` validates against alias map
- Adding a food here = adding aliases + macros + an eval case

### Reference tier (`foods_reference` table in Supabase)
- 2,825 rows — branded products, recipes, regional dishes, fitness supplements
- **NOT in the prompt** — too many tokens
- Matched via **retrieve-then-rerank**: loose retrieval (`refCandidates`) surfaces ~15 candidates, LLM (`rerankReference`) picks the best match or NONE
- Retrieval has two tiers:
  1. **AND-all-tokens ILIKE** — fast, exact substring match
  2. **Fuzzy edit-distance** — handles typos ("provalic" → "provilac", "epigamaiya" → "Epigamia"). Uses Levenshtein similarity over an in-memory cache of the full table (~2.8k rows, refreshed every 10 minutes)
- A cost guard prevents the LLM rerank call on weak coincidental matches (score < 0.55)
- The reranker's returned `food_code` is validated against the candidate set — a hallucinated code can never apply macros

### Resolution order in `resolveRows` (db.js)
```
1. Curated match (db_id from parser) → contextGuard validates
2. Strict reference lookup (match_food RPC) → acceptableRef gate
3. LLM rerank (refRerank) → retrieve loosely, LLM picks, anti-hallucination check
4. LLM estimate (parser already provided kcal/macros as fallback)
5. Placeholder (300 kcal) — never a dead-end
```

---

## 4. LLM provider chain

Configured via `LLM_PROVIDER` env var (sets primary). All providers with keys in
`.env` form a fallback chain. Current order: **Gemini → Groq → Claude**.

```
parser.js:  callGemini() → callGroq() → callClaude()
```

Each caller now accepts an optional `system` parameter (defaults to `SYSTEM_PROMPT`
for the parse path). The reranker uses `askLLM(text, system)` which calls the same
chain with a custom system prompt.

**If you see placeholder replies or estimate-only output:** check for HTTP 429 first.
Free-tier quotas get exhausted. Groq and Gemini free tiers have been exhausted before.

---

## 5. Correction system

Users correct entries by replying naturally: "it was paneer not tofu", "remove the
roti", "the whey was wrong, it was 150 cals".

### How corrections route:
1. `correctionContext.js` detects correction intent from the LLM parse output
2. `deleteMatchingLastLog` finds the target item in the last log batch
3. **Deterministic match first** (word overlap via `matchRows`)
4. **LLM rerank fallback** (`rerankTarget`) — handles semantic matches like "the whey" → "SuperYou PRO"
5. Multi-item corrections are atomic: if any hint can't resolve, the whole correction aborts

### Item numbering:
Items are referenced by `day_seq` (sequential number within the day). There are **no
meal blocks** — the old "Meal 1/2" grouping was removed because it confused users. A
single item-number scheme is used across all reply surfaces.

---

## 5b. Stateful flows (TDEE + conversation memory)

These are the newest and least-documented parts of the system. Read
`docs/superpowers/specs/2026-07-23-tdee-conversation-design.md` and
`...-six-hour-conversation-memory-design.md` before changing either.

### TDEE calculator (`src/tdee.js`)
Multi-turn flow that collects age, sex, height, weight, activity level, then
returns maintenance calories via Mifflin-St Jeor.

- **The math never touches an LLM.** The LLM only classifies "is this a TDEE
  request?" — every number is computed deterministically. Do not move any part
  of the calculation into a prompt.
- `advanceTdee(state, message)` is a pure state machine: given current state and
  the user's reply, it returns the next state plus the reply text. This is why
  `test:tdee` can cover it exhaustively offline.
- Input guards reject implausible values (age 18-100, height 100-250cm,
  weight 30-350kg) and `suspiciousReasons()` flags combinations that look like
  a mis-parse rather than a real body.
- State persists in `users.tdee_profile` (jsonb), so a half-finished flow
  survives a server restart.
- `isTdeeRequest()` deliberately **excludes** food-calorie questions — "calories
  in 2 roti" must route to logging, not the calculator. There are eval cases
  tagged `tdee,intent` pinning this boundary.

### 6-hour conversation memory (`src/conversationMemory.js`)
Keeps the last 10 exchanges within a 6-hour window so short follow-ups resolve.

- **The prompt-injection boundary is the important part.** History is wrapped in
  `BEGIN/END APP-PROVIDED RECENT CONVERSATION` and presented as quoted data. The
  system prompt tells the model this block is a record of past turns, never a
  source of instructions. If you change the envelope, change it in
  `formatConversationContext()` **and** `src/systemPrompt.js` together, and keep
  the memory tests green — several exist specifically to catch a user pasting
  something that looks like an instruction.
- Context is loaded **only when needed** (`needsConversationContext()`), not on
  every message — full history on every turn would be a token bill for no gain.
- State is claimed with optimistic concurrency (`claimConversationState` →
  `clearConversationStateIfUnchanged`) so two rapid-fire messages can't both
  act on the same pending state.
- Memory is scoped to the current IST date (`stateTargetsCurrentIstDate`) so
  yesterday's context can't leak into today's totals.

---

## 6. Non-negotiable workflow

### Before ANY change to prompt / foods / parser / db resolution:
```bash
node evals/run.js          # must stay 160/160 green (~4 min, real LLM calls)
```
The eval suite hits the **real LLM**, not mocks. A prompt tweak or new food entry can
silently break existing routing — the evals catch it. **When you add a food, add a
matching eval case.** The suite only ever grows.

### Unit tests (run relevant ones):
```bash
npm run test:rerank        # reranker guardrails (offline, stubbed LLM)
npm run test:brand         # live e2e brand reranking (needs Supabase + LLM keys)
npm run test:corrections   # correction scoping
npm run test:context       # ID hallucination guard
npm run test:guard         # protein/macro sanity
npm run test:serving       # unit vs gram resolution
npm run test:ref           # acceptableRef fuzzy floor
npm run test:undoall       # undo behavior
npm run test:tdee          # TDEE math, state machine, input guards
npm run test:memory        # conversation memory window, envelope, concurrency
npm run test:metrics       # metrics aggregation
node test/pizza-slice-test.js
node test/audit-fixes-test.js
node test/ingest-foods-test.js
```
All of the above pass as of 24 Jul 2026. `test:tdee` and `test:memory` are the
two biggest suites — treat them as the regression net for the stateful flows,
since the evals only cover single-turn parsing.

### After merging, restart the live server:
The bot runs on a **Mac Mini under launchd** (not a cloud host).
```bash
launchctl kickstart -k gui/501/com.nutridesi.server
```
Never start `node server.js` manually — launchd owns the process, ngrok tunnel,
and a 5-min healthcheck watchdog. Logs: `~/Library/Logs/nutridesi.log`.

**Known issue:** The waitlist/founding-member log lines print full real signup
names (`server.js:1022` and `server.js:1049`). This is a privacy bug — masking
these is in the open work items below.

### Git hygiene (repo is PUBLIC):
- **Scan every diff for PII before pushing** — real names, `+91…` phone numbers,
  ngrok URLs, API keys.
- These are gitignored (contain raw user text): `evals/correction-log.jsonl`,
  `evals/db-gaps.jsonl`, `data/incoming/`
- `.env` is gitignored; new vars → `.env.example` as placeholders only.
- **No AI co-author trailer** in commit messages. Swapnil is sole author on GitHub.
- Phone numbers masked to `+91••••1234` in any display, logs, or incident writeups.
  Use "User A/B", never real names.

---

## 7. Key invariants (learned from real incidents)

1. **Deterministic code overrides LLM output.** See `pinPizzaSlices` (pizza slice vs
   whole), `contextGuard` (bad IDs), and `acceptableRef` (bad reference matches). Don't
   prompt-engineer your way out of an ambiguity you can pin in code.

2. **Never a dead-end.** 4-tier fallback: curated → reference → LLM estimate →
   placeholder. The bot always logs *something*. Only exception: no food name at all.

3. **Generic terms must not match branded SKUs.** "plant protein" → generic Plant
   Protein Powder (curated, id 353), NOT "SuperYou PRO". Branded match requires the
   brand word in the query. Enforced by `acceptableRef` + curated generics.

4. **Corrections are scoped to the last log batch only.** Multi-item corrections are
   atomic (all-or-nothing). If any hint can't resolve, the whole correction aborts.

5. **User-stated calories/macros override everything.** "that dosa was 120 cals" wins
   over any database or estimate.

6. **IST dates.** Daily totals pin the IST date once per log to avoid midnight races.

7. **The `applyReference` disagreement guard can silently reject.** If a strict
   reference match's macros disagree by >2x with the LLM estimate, `applyReference`
   rejects it internally. The calling code MUST check `r.refVerified` after the call
   and fall through to rerank if not set. This was a real bug — don't reintroduce it.

8. **LLM rerank cost guard.** The rerank LLM call only fires when at least one
   candidate has a strong match (all tokens substring OR edit-distance ≥ 0.55).
   Weak coincidental matches go straight to estimate.

9. **Numbers a user will act on are computed, never generated.** TDEE is the live
   example: the LLM classifies intent, `src/tdee.js` does all arithmetic. Apply the
   same split to anything similar (macro targets, deficits).

10. **Anything replayed into the prompt is untrusted data.** Conversation history is
    wrapped in an explicit envelope and declared non-instructional. If you add a new
    source of recalled text, envelope it the same way — don't concatenate raw user
    text into the system prompt.

---

## 8. Supabase schema

Migrations live as `*.sql` files in the repo root and are applied **by hand** in the
Supabase SQL editor — there is no migration runner. `supabase-schema.sql` is the
consolidated current state; the rest are incremental. If you add a column, add it to
both a new `*.sql` file and `supabase-schema.sql`.

### Tables
| Table | Purpose |
|---|---|
| `users` | `phone_number` (PK), `name`, `goal_kcal`, `goal_protein`, `katori_size`, `roti_size`, `created_at`, `daily_summary_time`, `nudge_count`, **`tdee_profile` (jsonb)**, **`conversation_state` (jsonb)** |
| `user_logs` | Per-item nutrition log. `id`, `phone_number`, `food_name`, `matched_db_id`, `quantity`, `unit`, `kcal`, `protein`, `carbs`, `fat`, `meal_time`, `is_estimate`, `logged_at`, `date`, `day_seq` |
| `foods_reference` | Branded/recipe reference DB. `food_code`, `food_name`, `serving_kcal`, `serving_protein`, `serving_carbs`, `serving_fat`, ... (2,825 rows) |
| `message_log` | Raw inbound/outbound message record, indexed on `(phone_number, at desc)`. Feeds the metrics dashboard and incident analysis. **Contains real user text — never export it into a committed file.** |
| `founding_members` | Waitlist signups with real names. Same rule: never commit its contents. |

The two jsonb columns on `users` are the state backing for the flows in §5b —
`tdee_profile` for the calculator, `conversation_state` for the 6-hour memory.

### Key RPC
- `match_food(query_text)` — pg_trgm word_similarity match against `foods_reference`.
  Threshold is 0.75 — too strict for terse queries, which is why `refCandidates` +
  rerank exist as a fallback path.

---

## 9. Local dev

```bash
npm install
cp .env.example .env        # fill in Supabase URL/key + at least one LLM key
npm run dev                 # node --watch server.js (auto-reloads on save)
node test/smoke-test.js     # 10 phrases through the real parser
```

Reference tier + brand tests need live Supabase + LLM keys. Pure-logic tests
(`context`, `guard`, `rerank`, pizza, ingest) run offline.

To test a message end-to-end locally, you need: Twilio Sandbox configured, ngrok
tunnel to localhost:3000, and the webhook URL set in Twilio console.

---

## 10. Open work items (as of 24 July 2026)

> **Read `docs/churn-reduction-report-2026-07-23.md` first.** It measured the live
> beta and concluded the bottleneck is **retention, not accuracy**: D7 is 5.3%
> against a 40% target, and users whose first meal hit the database perfectly
> retained no better than users who got an estimate. It explicitly **deprioritises**
> broad food-database ingestion and full-day conversation history. Don't pick
> parser/database polish off this list thinking it will move retention.

### Small + unblocked
| Item | Context |
|---|---|
| **Mask real names in waitlist logs** | `server.js:1022` and `server.js:1049` log full signup names to `~/Library/Logs/nutridesi.log`. Repo is public and logs get pasted into issues — mask to initials. Smallest real fix on this list. |
| **Per-user rerank cache** | When the reranker matches a brand ("epigamia" → a food_code), cache it per-user so the next mention skips the LLM call. Keyed `(phone, brand_key)`, per-user isolated, **never** writes to the shared table (user-supplied macros must not pollute reference data). Needs a Supabase migration. Saves latency/cost; not a retention lever. |

### What the churn report actually ranks highest
| Priority | Item | Notes |
|---|---|---|
| 1 | **Reliability patch** | Honest outage copy + provider health alert + working fallback. Users blamed themselves when the bot was down (report §A). |
| 2 | **Bad-outcome instrumentation** | Events table + recovery metrics. Currently there's no way to see a user hitting a wrong match and giving up. |
| 3 | **One-action commitment loop** | Single CTA in the first-log reply + goal-setting flow. Goal adoption is the strongest retention signal found (20.3% today). |
| 4 | **Opt-in reminder / daily summary** | The only sanctioned return trigger — product rules forbid unsolicited messages, so it must be opt-in. Not yet built. |
| 5 | **Targeted trust fixes** | Generic-brand guard + duplicate-restatement protection, with **multi-turn** evals. Narrow, not a database sweep. |
| 6 | **WABA migration** | `src/meta.js` has the Cloud API path. Gates trustworthy D3/D7 measurement, because Sandbox re-join breaks the window. Run in parallel. |

### Parked (deliberately)
| Item | Why |
|---|---|
| **"With peanuts" modifier linking** | Partially addressed by the 6-hour conversation memory, but the specific "bare modifier fragment attaches to last item" path is **not** built. Backlog says: build a multi-turn eval harness *first*. |
| Broad food-DB ingestion, photo recognition, LangGraph rewrite | Explicitly deprioritised by the churn report. |

---

## 11. Recent architecture decisions (context for why things are the way they are)

1. **Retrieve-then-rerank over deterministic matching** (commit `80bb542`): The strict
   `match_food` RPC (word_similarity > 0.75) structurally fails on terse-vs-verbose
   queries ("epigamia yogurt" vs "Epigamia High Protein Greek Yogurt (Mixed Berries)").
   `acceptableRef`'s token gate also rejects verbose brand names. Instead of relaxing
   these gates (which would introduce false matches), we added an LLM reranker that
   judges semantic fit from a loose candidate set.

2. **Typo-tolerant fuzzy retrieval** (commit `6df1d49`): ILIKE substring can't match
   "provalic" → "provilac" (internal vowel swap). Trigram Jaccard scores it at ~0.23.
   Levenshtein edit-distance handles it at ~0.75. The fuzzy tier ranks the whole
   reference table by edit-distance similarity, cached in memory and refreshed every
   10 minutes.

3. **Meal blocks removed** (commit `80bb542`): The 45-min clustering into "Meal 1/2"
   was purely presentational but created a competing numbering scheme that confused
   users ("meal 1" vs "item 1"). Removed in favor of a single `day_seq` item-number
   scheme across all reply surfaces.

4. **LLM correction-target reranking** (commit `80bb542`): Deterministic word-overlap
   can't match "the whey was wrong" to a row named "SuperYou PRO (Yeast Protein)".
   `rerankTarget` uses the LLM to match by meaning. Same anti-hallucination contract
   as `rerankReference`.

5. **Deterministic TDEE, LLM-routed intent** (`c642d7d` … `f017fa7`, 23-24 Jul): A
   calorie target is a number a user will act on for months — an LLM arithmetic slip
   is unacceptable. So the LLM only answers "is this a TDEE request?" and every
   number comes from `calculateTdee()`. `f017fa7` later widened intent routing to
   semantic phrasings ("how many calories should I eat") while keeping food-calorie
   questions ("calories in 2 roti") on the logging path — eval cases tagged
   `tdee,intent` pin that boundary.

6. **Conversation history as quoted data, not prompt text** (`29def3d`, `f8515de`,
   `ea2a7f2`, 23 Jul): The 6-hour memory feeds prior user messages back into the
   prompt, which is a prompt-injection surface — a user can type something that
   looks like an instruction and have it replayed as context. History is therefore
   wrapped in a `BEGIN/END APP-PROVIDED RECENT CONVERSATION` envelope and the system
   prompt declares that block to be a record, never a command. Several commits in
   that run exist purely to harden this boundary; keep `test:memory` green when
   touching it.

7. **Optimistic concurrency on conversation state** (`95d3c1a`, `d02d481`): Two
   messages arriving seconds apart could both read the same pending state and both
   act on it (double-logging, or a correction applied twice).
   `claimConversationState` → `clearConversationStateIfUnchanged` makes the claim
   conditional, so the loser of the race no-ops.

8. **Corrections bound to exact log rows** (`f367b0e`, `4a85b9f`, `da6d843`, 23 Jul):
   Correction targeting used to re-query by content, which could match a *different*
   batch with the same food. Corrections now carry exact row ids
   (`logRowsByExactIds` / `deleteLogRowsByExactIds`) and are gated on the batch
   actually being recent.
