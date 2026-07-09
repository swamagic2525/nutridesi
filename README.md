# NutriDesi — Swapnil's First App

WhatsApp-native Indian food calorie tracker. Text what you ate in Hinglish, get calories back.
No app, no account — just WhatsApp.

## Architecture (weekend MVP)

```
WhatsApp -> Twilio Sandbox -> POST /whatsapp -> parse (Claude Haiku)
         -> log (Supabase) -> reply inline (TwiML) -> WhatsApp
```

One synchronous webhook. Claude Haiku answers in ~1-3s, inside Twilio's 15s window,
so no async queue is needed (the two-scenario split was a Make.com limitation, not a code one).

## Setup (do once)

1. **Install**
   ```bash
   npm install
   ```
2. **Env**: copy `.env.example` to `.env` and fill in your keys.
   ```bash
   cp .env.example .env
   ```
3. **Supabase**: open your project's SQL Editor, paste `supabase-schema.sql`, run it.
4. **Seed foods** (optional — the app reads from `src/foods.js` directly, so this is only
   needed if you later move lookups into the DB).

## Run it

**Offline parser test first (no Twilio needed):**
```bash
npm run smoke
```
This runs 10 test phrases through Claude and prints match_type + kcal. Confirm:
- clean slams return `direct`
- "chicken rezala" / "sol kadhi" do NOT invent a DB id
- "unlimited" returns no items

**Live server:**
```bash
npm start
```
Then expose it to Twilio with a tunnel (in a second terminal):
```bash
npx localtunnel --port 3000
# or: ngrok http 3000
```
Copy the public URL, add `/whatsapp`, and paste into
Twilio Console -> Messaging -> WhatsApp Sandbox -> "When a message comes in".

Text your sandbox number: `2 roti and dal` -> you should get calories + a running total.

## Build order

See `MVP-Weekend-Plan.md`. Short version:
- **Sat**: `npm install`, run schema, get `npm run smoke` passing (parser correct).
- **Sun**: `npm start` + tunnel, wire Twilio, get a live round-trip, run 10-phrase smoke from your phone.

## Files

| File | Purpose |
|---|---|
| `server.js` | Express webhook, TwiML reply |
| `src/parser.js` | Claude Haiku call + markdown preprocessing |
| `src/systemPrompt.js` | Builds the system prompt (alias map + rules) |
| `src/foods.js` | 58-item food database with Hinglish aliases |
| `src/db.js` | Supabase logging + daily total + 4-tier fallback |
| `test/smoke-test.js` | Offline parser test against 10 phrases |
| `supabase-schema.sql` | Database tables |
| `CLAUDE.md` | Project rules for Claude Code |
| `NutriDesi-PRD.md` | Full PRD v0.5 |

## Not in this weekend (Week 2)

Calibration, 45-min session merging, undo, daily summary, streaks. All deliberately deferred —
they need cross-message state. Get the core loop retaining users first.
