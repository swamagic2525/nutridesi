# TDEE Conversation Design

**Date:** 23 July 2026  
**Status:** Approved design; implementation pending

## Goal

Let an adult ask NutriDesi how many calories they should eat and receive:

- estimated maintenance calories;
- a conservative fat-loss target;
- a gradual weight-gain range; and
- a clear explanation that the result is predicted, not measured.

The calculator is user-initiated. It must not interrupt normal food logging or
become a mandatory onboarding questionnaire.

## Conversation

### Entry intent

Common requests should start the calculator without an LLM call:

- "calculate my calories"
- "how many calories should I eat?"
- "what is my maintenance?"
- "calculate my TDEE"
- "fat loss calories kitna?"

A food query such as "calories in one samosa" is not a TDEE request.

### Smart hybrid collection

NutriDesi extracts every valid input already present in the request, then asks
only for what is missing. A complete request can return a result immediately.

When no inputs are present:

> Sure 💪 Send these in one message:  
> **Age · Male/Female formula · Height · Weight**  
> Example: `31, male, 175 cm, 80 kg`

When those four inputs are known:

> How active are you normally?  
>  
> 1️⃣ Mostly sitting, little exercise  
> 2️⃣ Exercise 1–3 days/week  
> 3️⃣ Exercise 3–5 days/week  
> 4️⃣ Exercise 6–7 days/week or an active job  
> 5️⃣ Hard training plus a physical job  
>  
> _Choose the lower option if unsure._

If a user already supplied activity, NutriDesi skips this question.

If the user sends a food while the calculator is waiting for an answer, the food
preempts and abandons the pending calculator question. Normal logging continues.

### Formula wording

The Mifflin–St Jeor equation has separate male and female coefficients. The bot
asks which formula to use rather than making assumptions about identity. If the
user gives another gender description, reply:

> The calorie equation only provides male and female coefficients. Which formula
> would you like me to use?

## Calculation

All arithmetic is deterministic application code. The LLM must never calculate
or alter the result.

### BMR

Use the Mifflin–St Jeor equations with kilograms, centimetres and years:

```text
male formula:   BMR = 10W + 6.25H - 5A + 5
female formula: BMR = 10W + 6.25H - 5A - 161
```

### Activity factors

```text
1 mostly sitting                         1.200
2 exercise 1–3 days/week                1.375
3 exercise 3–5 days/week                1.550
4 exercise 6–7 days/week or active job  1.725
5 hard training plus physical job       1.900
```

`TDEE = BMR × activity factor`

Round displayed maintenance and target values to the nearest 50 kcal to avoid
false precision.

### Fat-loss guardrails

The automated fat-loss recommendation is a 200–300 kcal deficit:

```text
lower bound = max(1200, displayed TDEE - 300)
upper bound = max(1200, displayed TDEE - 200)
```

Rules:

- Never recommend a deficit greater than 300 kcal/day.
- Never recommend an intake below 1,200 kcal/day.
- If both bounds collapse to 1,200, show one target instead of a range.
- If estimated maintenance is at or below 1,200, do not produce an automated
  fat-loss target. Recommend personalised professional guidance.
- The 1,200 kcal floor is a product guardrail, not a claim that 1,200 is suitable
  or safe for every person.

When the floor applies, add:

> ⚠️ A larger deficit would take you below NutriDesi's 1,200 kcal safety floor,
> so I won't recommend it. This floor is only a guardrail—not a guarantee that
> 1,200 is appropriate for everyone.

### Weight-gain range

Show a gradual gain range of 5–10% above estimated maintenance, rounded to the
nearest 50 kcal.

## Result

Example for a 31-year-old using the male formula, 175 cm, 80 kg, activity level 3:

> 🔥 **Your estimated daily calories**  
>  
> **Maintenance:** ~2,700 kcal/day  
> **Fat loss:** 2,400–2,500 kcal/day  
> **Weight gain:** 2,850–2,950 kcal/day  
>  
> Start near the middle of your chosen range and adjust from your results.  
>  
> _These are predictions and may vary with your actual lifestyle and metabolism.
> The best approach is to track your food and morning weight consistently for
> 2–3 weeks. If your average weight stays stable, your average calorie intake is
> close to your real TDEE._  
>  
> _This is a predicted estimate, not medical advice. For personalised guidance,
> consult a qualified coach. If you have a medical condition, are under 18,
> pregnant/breastfeeding, take relevant medication, or have a history of
> disordered eating, speak with a doctor or registered dietitian before changing
> your calories._  
>  
> 📘 _Want to plan your own program? DM **"PDF"** to Swapnil at
> **@swapnilgore2525** for his detailed 30-page guide._

## Validation and restricted cases

- Adults only: age must be 18–100.
- Accept height in centimetres or feet/inches and weight in kilograms or pounds;
  convert to metric before calculating.
- Accept broad plausible input ranges: height 100–250 cm and weight 30–350 kg.
  Values outside them should be re-entered, not clamped.
- Do not calculate an automated target for a user who states that they are under
  18, pregnant or breastfeeding. Return the professional-guidance message.
- Missing or ambiguous values cause one short follow-up question. Do not guess.
- Activity outside 1–5 causes the activity menu to be repeated until the user
  supplies a valid choice or preempts the flow with a different intent.

## State and persistence

The flow must survive a server restart. Store the calculator's active/inactive
state and partial inputs against the phone-number user profile in Supabase.

Persist the completed inputs and latest result so a future recalculation can ask
only for changed or missing information:

- age;
- formula choice;
- height in centimetres;
- weight in kilograms;
- activity level;
- calculated BMR and TDEE;
- calculation timestamp.

Normal food messages preempt the active calculator state. Starting the calculator
again may reuse saved values, but the reply must show the values being used so the
user can update stale weight or activity.

## Architecture

- Add a small pure TDEE module for parsing bounded inputs, unit conversion,
  calculation and reply formatting.
- Add deterministic request and pending-answer routing before `parseMeal()` in
  `handleMessage()`.
- Keep Supabase reads/writes in `src/db.js`, following the current profile
  helpers.
- Do not put formula arithmetic in the system prompt.
- Do not add an external health API or another runtime dependency.

## Testing and release gates

Pure unit tests must cover:

- both Mifflin–St Jeor coefficients;
- all five activity multipliers;
- metric and imperial conversion;
- a complete one-message request;
- every missing-field follow-up;
- food-intent preemption;
- the 300 kcal maximum deficit;
- the 1,200 kcal floor and collapsed range;
- maintenance at or below 1,200;
- restricted cases and invalid values;
- a food calorie query not starting the TDEE calculator.

Because intent routing and parser behavior are adjacent to this feature, run the
full `node evals/run.js` suite and keep all 158 cases green before shipping.
Restart the launchd service after the production change and scan the complete
diff for PII.

## Out of scope

- Meal-plan generation
- Medical or condition-specific calorie prescriptions
- Body-fat or wearable-device calculations
- Automatic weekly calorie changes
- Coaching payments or PDF delivery automation
- Reminder scheduling and the separate five-successful-log opt-in feature

## References

- Mifflin et al., "A new predictive equation for resting energy expenditure in
  healthy individuals": <https://pubmed.ncbi.nlm.nih.gov/2305711/>
- NIH/NIDDK Body Weight Planner: <https://www.niddk.nih.gov/bwp>
