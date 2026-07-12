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
   (The hardcoded ngrok URL was removed from the public repo on 2026-07-12.)

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

## Ordering note

Do #1 (data sourcing) exploratory first — it's the only one with unknown scope.
#3 and #4 touch the same resolver code in `db.js`, so batch them in one pass.
All are quality/safety upgrades; ship behind a real-user retention signal, not
before it (per the D7 kill-criteria in CLAUDE.md).
