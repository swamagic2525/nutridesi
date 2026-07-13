# Post-Launch Backlog

Deferred deliberately so launch day stays calm. Most items upgrade food-data
quality; item #0 is the one hardening/scale item and takes priority before any
reel that could go big.

---

## 0. Harden + move off the Mac Mini (do before scaling beyond a trial reel)

**Priority:** highest. Fine for a small trial, not for a viral one.

Three linked pieces:

1. **Validate Twilio's request signature** on the `/whatsapp` webhook. It's
   currently unauthenticated — anyone who finds the URL can POST fake requests
   (spoof any From number, pollute logs, burn LLM/Twilio balance past the
   per-phone rate limit). Fix: `twilio.validateRequest(authToken, signature,
   url, params)` on each request. **Footgun:** behind ngrok the reconstructed
   URL must exactly match what Twilio signed (use `https://${req.headers.host}
   ${req.originalUrl}`). Ship it behind an env flag and test with a real message
   BEFORE enforcing — a wrong URL rejects all real requests and kills the bot.
   (The hardcoded ngrok URL was removed from the public repo on 2026-07-12;
   the founder's phone number was scrubbed from git history on 2026-07-13.)

2. **Cloud deployment** (Railway/Render) to replace the single Mac Mini + ngrok.
   Removes the single-point-of-failure (power/net cut = bot down, watchdog can't
   self-heal) and the tunnel fragility. Repo already pushes to GitHub, so this is
   mostly a deploy config + moving `.env` to the host's secrets.

3. **Proper WhatsApp Business number** (Meta Cloud API or Twilio WABA) to escape
   the Sandbox's 72-hour re-join friction — the biggest real UX wart for
   returning users.

**Why grouped:** all three are the same transition — from "founder's laptop demo"
to "service other people rely on." Do them together when the retention signal
says it's worth it, not before.

**Effort:** signature validation ~30 min + careful test; cloud deploy ~half a day;
WABA number ~1-2 days incl. Meta onboarding.

---

## 0b. Anthropic prompt caching + output-schema trim — DONE 2026-07-12

Shipped, for latency + cost. (1) `callClaude` marks the system prompt cacheable
(`cache_control: ephemeral`) — reused within ~5 min, so bursty traffic hits cache.
(2) Async (fire-and-forget) `user_logs` insert — reply computes totals locally.
(3) Trimmed 4 unused fields from the LLM output schema (unit/confidence/
is_estimate/alias_used) — ~35% less output per item. Combined: single-item ~2.4s,
4-item meal ~2.9s (was 6.8–7.9s). Record left for context.

---

## 0c. User-stated calorie corrections + welcome flow — DONE 2026-07-13

Shipped after the first US beta user hit both failures in one session.
(1) **User-stated calories are ground truth**: "4 fish sticks have 230 calories"
sets `stated_kcal` (per-serving), beats the curated DB and skips INDB; macros
scale to the user's number. Bare "«food» has N cal" classifies as `replace_last`;
with "I ate/had" it logs. A correction inside a multi-item batch replaces only
the name-matched item (was: deleted the whole batch). (2) **Supplements curated**
at true values — creatine 0 kcal, BCAA 10, black coffee 5, green tea 2 (were
falling to the 300 kcal placeholder). (3) **Welcome flow**: sandbox join /
greeting / "what can you do" → founder-signed intro with IG-DM feedback routing,
no LLM call; new user's first food log gets a one-time footer. Record for context.

---

## 1. Import IFCT raw-ingredient data (macros for plain staples)

**Problem:** INDB is a *recipe* database (1,014 cooked dishes) — it has no raw
ingredients. So plain proteins (chicken breast, paneer, tofu, egg whites) and
other staples find no INDB match and fall to the LLM estimate, which returns
**calories only, no macros**. Bad for a protein-tracking audience.

**Stopgap already shipped:** chicken breast, paneer, tofu, egg whites were
hand-added to the curated list in `src/foods.js` with standard reference values
(from general knowledge, NOT a sourced file — see note below).

**Real fix:** import IFCT 2017 (Indian Food Composition Tables, ICMR-NIN,
~528 raw foods, lab-derived) as a second reference source in Supabase, and have
the Tier-2 lookup search ingredients as well as recipes.

**Risk / effort:** 20-30 min IF a clean machine-readable IFCT file exists;
1-2 hrs if it's only the published PDF and needs parsing. **Source the data
first** before committing to the task. INDB's GitHub repo carries foreign FCTs
(US/UK/USDA) but not a clean Indian raw-items sheet — needs a separate hunt.

**Note on current curated values:** chicken breast 165 kcal / 31P / 0C / 3.6F
per 100g etc. are standard USDA/IFCT-equivalent figures typed from memory, not
traced to a repo file. Accurate, but replace with sourced numbers when IFCT lands.

---

## 2. LLM estimate as a guardrail on INDB matches (hybrid resolution) — DONE 2026-07-10

Shipped. `applyReference` in `src/db.js` now rejects an INDB match whose kcal is
outside ~0.5x-2x of the LLM's own per-serving estimate (a wrong recipe like
"honey" -> "Honey cake"). Zero extra latency. Left here as a record.

---

## 3. Source tag in logs (which tier answered each food)

**Problem:** no way to see whether a logged item came from the curated list,
INDB, or the LLM estimate — so bad INDB over-matches are invisible until a user
notices a weird number.

**Fix:** tag each resolved item with its source tier (`curated` / `indb` /
`llm-est` / `placeholder`) and print it to `nutridesi.log` (not the user reply).
Turns "trust the threshold" into "audit what actually happened." Also the natural
signal for which foods to promote into the curated list next.

**Where:** `resolveItem` + `applyReference` in `src/db.js` set the tag; the
request log line in `server.js` prints it.

**Effort:** ~20 min. Good to do alongside #3 since both touch the same code.

---

## 4. Per-item kcal sanity cap (catch count-amplified wrong matches)

**Problem:** the quantity fix (real counts, not capped at 3) means a wrong match
to a bowl/plate item gets multiplied and explodes. Seen in QA: "chicken tikka
6 pieces" matched a gravy dish and hit **1920 kcal** for one item before it was
fixed. The NO CROSS-FOOD MATCHING prompt rule (2026-07-10) addresses the cause,
but a wrong match could still slip through and get Nx'd.

**Fix:** a backstop in `resolveItem` / `logMeal` — if a single logged item
exceeds a sane ceiling (~1200 kcal), it's almost certainly a count applied to a
portion-unit food. Options: soften to a flagged estimate, or re-check that a
large integer count isn't being applied to a bowl/plate/glass/serving unit
(counts should pair with piece-like units). Don't hard-clamp legit big meals
(e.g. 20 rotis = 1780 is real) — key on the count x portion-unit mismatch, not
raw kcal alone.

**Where:** `resolveItem` in `src/db.js` (has both quantity and the food's unit).

**Effort:** ~30 min + testing (chicken-tikka-style inputs vs legit high counts).

---

## 5. Diet / low-fat variant coverage (same food, different macros)

**Problem:** health-conscious users log a *variant* the DB collapses to its
default, and the error runs in the direction they care about most. Real case:
"low-fat paneer" matched full-fat Paneer (265 kcal / 20g fat vs ~160 / 7g) — user
called accuracy "quite low". Also found "toned/skim milk" aliased to full-fat
milk. Fixed paneer/milk/curd on 2026-07-11, but the pattern is broader.

**Fix:** audit the DB for foods that have meaningfully different diet variants and
add the common ones: fried vs grilled/tandoori, ghee/butter vs plain, full vs
low-fat/toned, maida vs whole-wheat, sugar vs sugar-free, thigh vs breast, malai
vs skimmed. Reinforce in the prompt that a stated modifier ("low-fat", "no oil",
"grilled") must pick the matching variant, not the default.

**Why it matters most for this audience:** a fat-cutting gym user seeing full-fat
numbers for their low-fat choice concludes the app is inaccurate and leaves — the
error is wrong in exactly the dimension they're optimizing.

**Where:** `src/foods.js` (variants) + a prompt note in `src/systemPrompt.js`.

**Effort:** ~30-45 min; demand-driven (add variants users actually log).

---

## 6. Raw vs cooked weight logging — DONE 2026-07-12 (expand coverage as needed)

**Shipped:** "raw"/"dry"/"uncooked"/"kaccha" sets a `raw` flag; `resolveItem`
applies a per-food `rawFactor`. Live on rice (2.8x), brown rice (2.6x), dal
(2.8x), chicken breast (0.73x — meat loses water, so raw is LOWER). "100g rice
raw" -> 364 kcal; "200g raw chicken" -> 241. Display strips "(Cooked)" when raw.
**Remaining:** add `rawFactor` to more foods as users log them raw (pasta ~2.3x,
mutton/fish ~0.7x, poha, quinoa ~2.7x). Demand-driven, ~30 sec each.

---

## (original #6 notes, for reference)

**Why this mattered:** serious fitness users weigh food **raw/dry** while meal-
prepping (rice, dal, pasta, oats, chicken), but casual users log it **cooked**
(on the plate). The calorie difference is huge and no mainstream tracker nails
it. "100g rice" is ~360 kcal raw but ~130 kcal cooked — a **2.7x swing** on the
single most-logged Indian staple. Getting this right is exactly the precision the
target (macro-counting) audience notices and switches for.

**Current state:** the bot assumes COOKED for rice/dal (correct default — most
people log the plate), but DRY for oats/soya chunks (correct — those are weighed
dry). Consistent with real logging habits, but a meal-prepper weighing raw rice
is undercounted ~2.7x with no way to say so.

**The nuance (conversion goes opposite directions):**
- Grains/legumes ABSORB water → cooked is *less* calorie-dense per gram. 100g raw
  rice ≈ 360, cooked ≈ 130 (~2.7x). Dal/lentils ~2.5x, pasta ~2.3x.
- Meat LOSES water → cooked is *more* dense per gram. 100g raw chicken breast
  ≈ 120 kcal, cooked ≈ 165 (~1.35x, and note our curated chicken breast is the
  COOKED 165 value — a raw-weigher is currently overcounted).

**Fix:** treat "raw"/"dry"/"uncooked"/"kaccha" (and "cooked"/"pakaya") as a
variant modifier (same mechanism as low-fat/high-protein in #5). When the user
says raw, apply a per-food raw↔cooked calorie factor. Needs a `raw_kcal` (or a
conversion factor) on the water-absorbing/losing staples: rice, all dals/lentils,
pasta, chicken/mutton/fish, poha, quinoa. Default stays as-is when unspecified.

**Positioning:** this is a headline feature for the fitness segment, not a bugfix.
Worth doing well and even calling out in marketing ("weigh it raw or cooked — we
handle both"). Consider a one-time nudge the first time someone logs rice by grams:
"was that raw or cooked weight?" — remembered per user, per PRD rule 1.

**Where:** `src/foods.js` (raw factors on staples) + `src/systemPrompt.js`
(variant rule) + `resolveItem` in `src/db.js` (apply factor on grams path).

**Effort:** ~1 hr + testing across the raw/cooked pairs.

---

## Ordering note

Do #1 (data sourcing) exploratory first — it's the only one with unknown scope.
#3 and #4 touch the same resolver code in `db.js`, so batch them in one pass.
All are quality/safety upgrades; ship behind a real-user retention signal, not
before it (per the D7 kill-criteria in CLAUDE.md).
