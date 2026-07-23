# Semantic TDEE Intent Design

## Goal

Route natural-language calorie-requirement requests into NutriDesi's guarded TDEE calculator without maintaining an ever-growing phrase list or adding another LLM call.

## Design

The existing deterministic `isTdeeRequest()` remains a zero-latency fast path. Messages that miss it continue through the existing `parseMeal()` call, whose intent schema gains `calculate_tdee`. When that intent is returned, `server.js` starts `advanceTdee()` with the canonical calculator command, stores the resulting TDEE state, and returns the calculator's demographic prompt.

Once TDEE state is active, `advanceTdee()` remains authoritative before generic parsing. A bare affirmative while demographic fields are still missing keeps the calculator active and repeats the missing-field prompt. It confirms a result only during the existing suspicious-input confirmation phase.

## Safety and scope

- All calculations, bounds, deficit limits, disclaimers, and restricted-user handling stay deterministic in `src/tdee.js`.
- The LLM may only choose to start the calculator; it cannot produce calorie targets.
- Food calorie questions such as “calories in one samosa” remain `query`.
- No new provider call, dependency, database column, or migration is introduced.

## Verification

- Exact screenshot flow: calorie-requirement request → demographic prompt → “Yes” remains in the calculator.
- Semantic variants including English and Hinglish classify as `calculate_tdee`.
- Food calorie questions do not classify as TDEE.
- `npm run test:tdee`, related routing tests, and `node evals/run.js` must pass; production requires 158/158 or better after adding the new cases.
