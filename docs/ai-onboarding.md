# AI Onboarding — NutriDesi

**For any AI model picking up build work in this repo.** Read this top-to-bottom
before touching code. It reflects the codebase as of **22 July 2026** (live private beta).

---

## 0. First, what's TRUE vs STALE

- **`README.md`** — accurate. Start here for the product + architecture.
- **`CLAUDE.md`** — accurate product rules and constraints. Authoritative.
- **`AGENTS.md`** — ⚠️ **STALE. Do not follow its architecture.** It describes an
  abandoned Make.com + "Codex Haiku" no-code design that was never built this way.
  The product *rules* inside it (fallback tiers, quantity map, modifier rules) are
  still valid, but the **stack, two-scenario pattern, and JSON schema are wrong.**
  Real system: one Node/Express server calling an LLM directly.

If those two ever disagree, `README.md` + the actual code win.

---

## 1. What this is (30 seconds)

WhatsApp bot. User texts Hinglish food ("2 roti aur dal", "1 scoop whey"), gets
calories + macros back in ~2-3s. Phone number = identity. No app, no account.

```
WhatsApp → Twilio Sandbox → POST /whatsapp (Express, server.js)
  → parse via LLM (Gemini → Groq → Claude fallback chain, src/parser.js)
  → resolve nutrition (curated foods → Supabase reference tier → LLM estimate)
  → Supabase insert + TwiML reply inline
```

One **synchronous** webhook. Everything happens in the request; reply is inline.
There is **no** Make.com, no queue table, no "Scenario A/B". Ignore any doc that says so.

---

## 2. Module map (where things live)

| File | Responsibility |
|---|---|
| `server.js` | Express app, all routes, `handleMessage()` orchestration, correction/undo/replace routing, welcome flow |
| `src/parser.js` | LLM call + provider fallback chain, `parseMeal()`, `preprocess()`, deterministic `pinPizzaSlices()` |
| `src/systemPrompt.js` | The LLM system prompt + `buildFoodDirectory()` (curated foods → alias-formatted lines) |
| `src/foods.js` | **Curated tier** — 347 hand-verified foods with Hinglish aliases. In the prompt. |
| `src/db.js` | Supabase I/O, nutrition resolution, `acceptableRef()` fuzzy guard, `logMeal()`, all read/delete helpers |
| `src/contextGuard.js` | Re-verifies every LLM-returned food ID against the alias map (anti-hallucination) |
| `src/correctionContext.js` | Pure helpers for correction detection + scoping to the last log batch |
| `src/proteinGuard.js` | Flags implausible protein/macros |
| `src/gapLogger.js` | Logs coverage misses to `evals/db-gaps.jsonl`, alerts on genuine gaps |
| `src/metrics.js` + `src/metricsPage.js` | `/metrics` dashboard (private, read-only) |
| `src/meta.js` | Meta/WhatsApp Cloud API path (future WABA migration; Twilio is live path) |
| `evals/` | **The eval suite** — `cases.jsonl` (158 golden cases) + `run.js` |
| `test/` | 12 unit/integration suites |
| `scripts/ingest-foods/` | Offline bulk-ingestion pipeline for the reference tier |

**Two-tier food data (important):**
- **Curated** (`src/foods.js`, 347 items) — in the LLM prompt, deterministic match.
- **Reference** (`foods_reference` in Supabase, ~2,575 rows) — NOT in the prompt.
  Fuzzy-matched via the `match_food` RPC, gated by `acceptableRef()` before it logs.

---

## 3. Non-negotiable workflow (READ THIS)

### Before shipping ANY change to prompt / foods / parser:
```bash
node evals/run.js          # must stay green (158/158). This is CI-for-vibes.
```
The eval suite hits the **real LLM**, not mocks. It is the regression net. A prompt
tweak or a new food entry can silently break existing routing — the evals catch it.
**When you add a food, add a matching eval case.** The suite only ever grows.

### Run the relevant unit tests:
```bash
npm run test:corrections   # correction scoping
npm run test:context       # ID hallucination guard
npm run test:guard         # protein/macro sanity
npm run test:serving       # unit vs gram resolution
npm run test:ref           # acceptableRef fuzzy floor
npm run test:undoall       # undo behavior
node test/pizza-slice-test.js
node test/audit-fixes-test.js
node test/ingest-foods-test.js
```

### After merging, restart the live server:
The bot runs on a **Mac Mini under launchd** (not a cloud host). Restart with:
```bash
launchctl kickstart -k gui/501/com.nutridesi.server
```
Never start `node server.js` manually — launchd owns the process, ngrok tunnel,
and a 5-min healthcheck. Logs: `~/Library/Logs/nutridesi.log`.

### Git hygiene (this repo is PUBLIC):
- **Scan every diff for PII before pushing** — real names, `+91…` phone numbers,
  ngrok URLs, API keys. `evals/correction-log.jsonl`, `evals/db-gaps.jsonl`, and
  `data/incoming/` are gitignored (they hold raw user text) — keep it that way.
- `.env` is gitignored; new vars go to `.env.example` as placeholders only.
- Commit as the founder — **no AI co-author trailer** in commit messages.
- Branch off `main`; don't commit straight to it.

---

## 4. Key invariants / gotchas (learned from real incidents)

1. **The fix pattern for LLM non-determinism is: deterministic code overrides LLM
   output.** See `pinPizzaSlices` (pizza slice vs whole) and `contextGuard` (bad IDs).
   Don't try to prompt-engineer your way out of an ambiguity you can pin in code.
2. **Never a dead-end.** 4-tier fallback: curated → reference → LLM estimate →
   placeholder. The bot always logs *something*. Only exception: no food name at all.
3. **Corrections are scoped to the immediately preceding log batch**, never an older
   item in the same meal window. Multi-item corrections are atomic (all-or-nothing).
4. **Generic terms must not match branded SKUs.** "plant protein" → generic entry,
   NOT "SuperYou PRO". Branded match requires the brand word. (`acceptableRef` + curated generics.)
5. **User-stated calories/macros override everything.** "that dosa was 120 cals" wins.
6. **IST dates.** Daily totals pin the IST date once per log to avoid midnight races.
7. **Phone numbers are masked** (`+91••••••1234`) everywhere they surface — logs,
   dashboard, incident writeups (use "User A/B", never real names).
8. **LLM provider** is env-driven: `LLM_PROVIDER` picks primary; others with keys in
   `.env` form the fallback chain. Free-tier quotas get exhausted — if you see
   placeholder replies, check for HTTP 429 first.

---

## 5. Local dev

```bash
npm install
cp .env.example .env        # fill in Supabase + at least one LLM key
npm run dev                 # node --watch server.js
node test/smoke-test.js     # 10 phrases through the real parser
```

Reference tier + corrections tests need live Supabase + LLM keys. Pure-logic tests
(`context`, `guard`, pizza, ingest) run offline.

---

## 6. Product guardrails (don't violate)

From `CLAUDE.md` — enforced in every feature:
- No unsolicited messages. Daily summary is opt-in only.
- One clarifying question per food type, ever. Conversations never deadlock.
- Value first: a new user's first food logs immediately using national-average
  defaults; calibration questions come *after*.
- Accuracy ceiling is ±15-20% for home-cooked meals — this is directional awareness,
  not clinical precision. Don't over-engineer accuracy.
- v1 explicitly does NOT include: photo recognition, Devanagari input, workout
  tracking, meal recommendations, a web/mobile app, or paid subscription.
```
