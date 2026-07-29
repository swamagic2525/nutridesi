# Log analysis — what to actually solve for

**Date:** 29 July 2026
**Source:** `message_log` (952 messages, 137 distinct users, 19–29 July) + `user_logs`
(1,874 rows). Test numbers (`+000…`) excluded. No user is named here.

---

## The headline: errors are not what's losing users

Of the 122 users with no activity in the last two days, **63% left immediately after
a message the bot handled correctly.** Only ~10% left on anything resembling a
failure.

| What the lapsed user's last message got | Users | Share |
|---|---:|---:|
| A successful log | 77 | 63.1% |
| Profile update / day report / other benign | 28 | 23.0% |
| "What did you eat?" | 6 | 4.9% |
| An explicit failure | 4 | 3.3% |
| Undo confirmation | 3 | 2.5% |
| Photo rejection | 2 | 1.6% |
| Welcome message | 2 | 1.6% |

Median messages per user is **4**. A quarter of users (34/137) sent exactly one
message ever.

This independently reproduces the churn report's conclusion from a different data
source: the problem is **activation without habit formation**, not accuracy. Parser
and database work will not move retention. Budget accordingly.

That said, the logs do contain a small number of genuinely broken things, and one
of them is a silent data-integrity bug. Those are worth fixing on their own merits
— just not as a retention play.

---

## Bucket 1 — Silent double-counting (data integrity) 🔴

**12 duplicate rows, 12 distinct users (~9% of the user base), 2,326 phantom kcal.**

Detection: same phone + same food + same kcal within 120 seconds in `user_logs`.

A user re-sends a message — WhatsApp retry, double-tap, or impatience on a slow
reply — and the bot logs it a second time. Of 10 exact-duplicate consecutive
messages observed, **4 were logged again**, 2 hit a correction abort, and none were
caught by `REPEAT_CHOICE_PROMPT`, which exists for exactly this case.

Why this ranks first despite being only 0.6% of rows: every other failure is
*visible* and therefore recoverable. This one silently corrupts the single number
the product exists to provide. A user who notices can't tell whether the bot is
wrong or they miscounted; a user who doesn't notice makes decisions on a bad number.

**Fix direction:** de-duplicate at the ingress — an identical body from the same
phone within a short window is a no-op (or routes to the existing repeat-choice
prompt), not a new log. The prompt already exists; it just isn't firing on exact
repeats.

---

## Bucket 2 — "What did you eat?" on messages that aren't food 🟠

**43 occurrences (4.5% of all messages), present every single day.** The most
chronic issue in the logs.

`CLAUDE.md` names this the *one* permitted dead-end, for when a food name is truly
absent. It is instead firing on:

| Category | Examples |
|---|---|
| Meal annotations | "this is meal 4", "meal 2 is lunch", "new entry" (×2), "don't change log this! it's a meal 3" |
| Confirmations | "yes" (×3), "yessss" |
| Flow control | "skip", "repeat", "here" |
| Correction attempts | "i m telling from first" |
| TDEE fragments | "kg", "current weight 86kgs" |
| Noise / typos | "hu", "hiip", "fu", "yooooooo" |

Two of these are self-inflicted and worth calling out:

- **Meal annotations.** Users still think in meals and are trying to tell the bot
  which meal an item belongs to. Meal blocks were removed on 22 July because the
  "Meal 1/2" numbering competed with item numbers — the removal was right, but
  nothing was put in place to *absorb* the vocabulary users already had.
- **TDEE fragments.** "kg" and "current weight 86kgs" should be caught by the TDEE
  weight-unit follow-up. They reached the food prompt instead, meaning the flow had
  already lapsed or was never armed.

**Fix direction:** these are non-food intents, not missing food names. Classify and
absorb them — a bare confirmation, a meal label, or a unit fragment should never
produce a food prompt.

---

## Bucket 3 — Correction aborts (a regression, introduced 25 July) 🟠

**7 occurrences, all on or after 25 July. Zero before.**

Copy: *"I couldn't safely connect that correction to the recent log…"*

All seven trace to the same shape: a **duplicate** multi-line meal dump, where the
second copy is classified as a correction of the first and then refuses to apply.

```
15:01  "3 eggs scramble / 100 gm chicken breast / 80 gm white rice cooked"
15:01  (identical message)          -> correction abort
18:10  "28 July / Weight— 75 / Morning / 70gram raw rice / Kadhi …"
18:11  (identical, ×2)              -> correction abort
```

The correction-hardening commits on 23 July (`f367b0e`, `4a85b9f`, `da6d843`) made
targeting stricter and atomic — correct in itself, and it prevents the worse failure
of corrupting the wrong row. But it converted a class of misfire into a visible
refusal, and it shares a root cause with Bucket 1: **the duplicate should never have
been treated as a correction at all.**

Fixing ingress de-duplication likely removes most of this bucket too.

---

## Bucket 4 — Correction target misses 🟡

**10 occurrences**, sporadic, including 4 on 28 July (recent, not stale).

Copy: *"Couldn't pin down X in today's log — nothing changed."*

The notable pattern: users quoting the bot's **own item name** back at it and still
missing — `"Provilac High Protein Milk - Vanilla"` (×2), `"150g Greek Yogurt"` (×2).
Also `"9 and 10"`, a user referring to two item numbers at once.

`rerankTarget` (shipped 22 July) was meant to cover semantic misses. These are the
opposite problem — *exact* quotes failing — which suggests the issue is in
deterministic matching or in multi-item/number references, not in semantic recall.

---

## Bucket 5 — Parse failures (an incident, already over) ⚪

**10 occurrences, all on 23 July. Zero on every other day.**

Copy: *"Couldn't read that one 😅 mind sending it again?"*

Consistent with an LLM provider outage or 429 rather than a chronic defect — the
free tiers have been exhausted before. Nothing to fix in the parser.

**Worth building instead:** the provider-health alert from the churn report's
reliability item. A whole day of failures passed without anything surfacing it, and
it was only found by reading logs a week later.

---

## Recommendation

**Do first — small, concrete, defensible on their own merits:**

1. **Ingress de-duplication** (Buckets 1 + 3). One fix, removes a silent
   data-integrity bug and most of the correction-abort regression.
2. **Absorb non-food intents** (Bucket 2). Confirmations, meal labels, and unit
   fragments stop producing food prompts.
3. **Provider-health alerting** (Bucket 5). Cheap; would have caught 23 July same-day.

**Do not** treat any of the above as a retention plan. The evidence says the users
who leave are leaving *satisfied* — the missing piece is a reason to come back,
which is the churn report's territory: a commitment loop after first value, opt-in
reminders, and WABA migration so D3/D7 can even be measured.

**Open question this data can't answer:** whether meal annotations ("this is meal 4")
mean users actually want meal grouping back, or just want to label an entry. Worth
asking two or three of them directly before building either.
