# Basis-less Nutrition Correction Scaling

**Date:** 7 August 2026
**Status:** Approved design; implementation pending

## Problem

A user logged half an avocado as 80 kcal and then said, “Half avocado was
160 calories.” The correction route ran, but the replacement was still 80 kcal.
The deterministic nutrition overlay ultimately multiplied the stated 160 kcal
by the parsed quantity `0.5`. That result is consistent with either a missing
basis or an incorrectly inferred one-piece basis.

The private correction log captured the quantity and stated calories, but not
the parsed basis or parser provider. It therefore cannot distinguish those two
causes for this historical incident. The behaviour change below makes the
missing-basis path safe; the added diagnostics provide evidence before any
future parser-contract change.

## Invariant

A user-stated nutrition value with no explicit basis applies to the consumed
portion and has scale `1`.

Only an explicit basis such as `each`, `per piece`, `per scoop`, `per 100g`, or
`per 100ml` triggers proportional scaling. The parser identifies values and
their stated basis; deterministic backend code performs all arithmetic.

Examples:

- “Half avocado was 160 calories” -> 0.5 avocado, 160 kcal.
- “2 samosas were 500 calories” -> 500 kcal total.
- “2 rotis were 90 calories each” -> 180 kcal total.
- 75g oats at 26g protein per 100g -> 19.5g protein.
- 2 scoops at 30g protein per scoop -> 60g protein.

## Scope

1. Change only the missing-basis fallback in `statedBasisScale()` from the
   consumed quantity to `1`. Keep every explicit-basis path unchanged.
2. Leave the parser prompt unchanged. Current parser behaviour already preserves
   explicit total and per-unit bases in repeated checks.
3. Extend the gitignored correction log with basis fields and available parser
   diagnostics so a future incident records the actual structured parse.
4. Add pure scaling tests and an end-to-end `handleMessage()` regression through
   the production `replaced_by_name` correction route.

There is no schema migration, historical data rewrite, regex intent rule, or
automatic repair of the affected user’s entry in this change.

## TDD and safety gates

Tests are written failing before production code changes. The required matrix is:

- missing basis with quantity 0.5 and stated 160 kcal -> 160 kcal;
- “Half avocado was 160 calories” replaces the logged half portion with 160;
- pronoun correction preserves the existing consumed portion;
- plural total without `each` remains a total;
- explicit `each`, `per scoop`, and `per 100g` continue scaling;
- a forced replacement failure leaves the original row unchanged;
- correcting one macro preserves untouched nutrition fields under the existing
  provenance rules.

Before deployment:

- run the focused scaling and correction-route tests;
- run the remaining project test scripts relevant to persistence and routing;
- run `node evals/run.js` and require 162/162;
- scan the complete public-repository diff for PII, phone numbers, secrets,
  tunnel URLs, and AI co-author trailers;
- restart the launchd service and verify health and a clean error tail.

## Versioning and documentation

Use two small Git commits:

1. correction-basis diagnostics;
2. tested missing-basis scaling fix plus onboarding documentation.

The repository has no release-tag convention and remains an internal beta at
package version 0.1.0, so this patch does not change `package.json` versioning.
Record the pre-deploy and deployed commit SHAs in the handoff.

After successful deployment, update `docs/ai-onboarding.md` with the invariant,
test command, deployed commit, and rollback note.

## Rollback

The behavioural commit is independently reversible and makes no database
changes:

1. `git revert <behaviour-fix-commit>`;
2. `launchctl kickstart -k gui/501/com.nutridesi.server`;
3. verify the health endpoint and server error log.

The diagnostics commit can remain deployed during rollback. Existing meal rows
are not rewritten; rollback affects only future corrections.
