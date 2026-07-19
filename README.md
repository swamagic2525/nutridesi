# NutriDesi

WhatsApp-native Indian food calorie tracker. Text what you ate in Hinglish — "2 roti aur dal",
"100g soya chunks", "1 scoop whey" — and get calories + macros back in ~2-3 seconds.
No app, no account. Your phone number is your identity.

**Status: live in private beta** with real users, distributed via Instagram reels.

## Why

People don't fail at calorie tracking because databases are wrong — they fail because opening
an app at 9pm after dinner is friction they won't do. This bot lives in WhatsApp, where they
already are. Built by a PM & ex-fitness coach who watched clients quit every tracking app.

## What it does

- **Hinglish parsing** — "ek katori dal", "adha plate biryani", "2 chai and 3 biscuit"
- **Unit *and* gram-precise logging** — "4 roti" and "200g chicken breast" both resolve exactly
- **Raw vs cooked weights** — "100g rice raw" ≈ 364 kcal vs cooked ≈ 130; per-food conversion
  factors (grains absorb water, meat loses it). Built for meal-preppers.
- **Full macros** — calories, protein, carbs, fat, and fibre per item and per day
- **Never a dead end** — 4-tier fallback: curated DB → INDB reference → LLM estimate → placeholder
- **Corrections & undo** — "undo", "sorry it was rajma", or state the truth: "that dosa was
  120 calories" (user-stated calories override everything). Implicit corrections are safely scoped to
  the immediately preceding log, never an older item in the same 45-minute meal window.
- **Meal clustering** — messages within 45 min group into one meal in the daily total
- **Diet variants** — low-fat paneer/milk/curd, high-protein PB/roti/bread resolve to *their*
  macros, not the full-fat default; supplements (creatine, BCAA, black coffee) at true ~0 kcal
- **Welcome flow** — sandbox joins, greetings, and "what can you do" get an intro without
  burning an LLM call; a new user's first food log gets a one-time footer

## Architecture

```
WhatsApp → Twilio Sandbox → POST /whatsapp (Express)
        → LLM parse (Gemini → Groq → Claude fallback chain, prompt-cached)
        → resolve nutrition (curated 180 foods → INDB 1,014 recipes → LLM estimate)
        → Supabase (async insert) → TwiML reply inline
```

One synchronous webhook — replies land in ~2-3s, well inside Twilio's 15s window.
Guardrails: per-phone rate limiting, webhook dedupe by MessageSid, message length cap,
portion-quantity sanity caps, INDB plausibility check against the LLM's own estimate.

**Data**: 180 hand-curated Indian foods with Hinglish aliases (`src/foods.js`) +
the [Indian Nutrient Databank](https://www.indiannutrientdatabank.in/) (1,014 lab-derived
recipes) as a fuzzy-matched reference tier in Supabase.

**Infra**: self-hosted on a Mac Mini under launchd supervision (server, ngrok tunnel, and a
5-minute healthcheck that WhatsApp-alerts the founder on downtime or low Twilio balance).
Cloud deploy + proper WhatsApp Business number planned (`docs/post-launch-backlog.md` #0).

## Founder metrics dashboard

`/metrics` is a private, read-only dashboard for the beta's decision metrics:
users, DAU, join-cohort D1/D3/D7 retention, return rate, food-items-per-active-user,
estimate/uncurated rates, top missing foods, and goal adoption. It excludes `+000`
test numbers and never renders phone numbers or message text.

Set these server-side environment variables before opening it:

```bash
METRICS_USER=...
METRICS_PASSWORD=...
```

Open `/metrics` and authenticate with HTTP Basic Auth. The browser receives only
aggregated data; it never receives a Supabase key. The authenticated server uses
its existing backend-only service key, so RLS can remain enabled with no public
`anon`/`SELECT` policy on phone-number tables. Metrics 10–12 (failures, latency,
correction rate) are intentionally deferred until an events table is added. D7
is labelled **join-cohort retention** and can be understated by the Twilio
Sandbox's re-join expiry.

If your Supabase project predates the goal loop, run the three additive `alter
table users ...` statements in `supabase-schema.sql`. Until then goal adoption
shows 0% with an availability note.

## Setup

1. **Install**
   ```bash
   npm install
   ```
2. **Env**: copy `.env.example` to `.env` and fill in your keys (LLM provider, Twilio, Supabase).
3. **Supabase**: paste `supabase-schema.sql` into your project's SQL Editor and run it.
   Load the INDB reference table + `match_food` RPC if you want the Tier-2 lookup (optional —
   everything degrades gracefully without it).

## Run it

**Offline parser test (no Twilio needed):**
```bash
npm run smoke
```

**Live server:**
```bash
npm run dev        # auto-reload, or: npm start
```
Expose it with `ngrok http 3000`, then paste the public URL + `/whatsapp` into
Twilio Console → Messaging → WhatsApp Sandbox → "When a message comes in".

Text the sandbox number `2 roti and dal` → calories + running daily total.

*(Production runs under launchd instead — plists in `launchd/`, logs in `~/Library/Logs/`.)*

## Files

| File | Purpose |
|---|---|
| `server.js` | Express webhook: routing, welcome flow, rate limits, TwiML replies |
| `src/parser.js` | Multi-provider LLM call (Gemini/Groq/Claude) + preprocessing |
| `src/systemPrompt.js` | System prompt builder: alias map, parsing rules, output schema |
| `src/foods.js` | 180-item curated food DB with Hinglish aliases, raw factors, serving grams |
| `src/db.js` | Nutrition resolution (4-tier fallback), Supabase logging, daily totals |
| `scripts/healthcheck.js` | Watchdog: tunnel reachability + Twilio balance alerts |
| `launchd/` | LaunchAgent plists (server, ngrok, healthcheck) |
| `test/smoke-test.js` | Offline parser smoke test |
| `supabase-schema.sql` | Database tables |
| `NutriDesi-PRD.md` | PRD v1.0 (as-built) |
| `docs/post-launch-backlog.md` | Prioritized backlog with shipped-item records |
| `docs/codex-handoff-2026-07-17.md` | Correction-safety implementation handoff and validation notes |

## What's deliberately not built

Personal calibration, scheduled daily summaries, streaks, photo logging,
Devanagari input. Goal setting with calorie + protein targets and a progress bar
shipped in v1; the bet is to prove D7/D30 retention on the core loop before
investing in the broader accountability layer.
