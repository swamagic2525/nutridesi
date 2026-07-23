# Semantic TDEE Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Understand calorie-requirement intent semantically and route it into the existing safe TDEE state machine.

**Architecture:** Keep deterministic TDEE phrases as a fast path. Reuse the existing food-parser LLM call as the fallback semantic router by adding `calculate_tdee`, then dispatch that intent to `advanceTdee()` in `server.js`. Active calculator state handles follow-ups before generic parsing.

**Tech Stack:** Node.js, Express, existing Gemini/Groq/Claude parser chain, Supabase profile state.

---

### Task 1: Lock the reported state-machine regression

**Files:**
- Modify: `test/tdee-test.js`
- Modify: `src/tdee.js`

- [ ] Add an assertion that “What's my calories requirements” starts collection.
- [ ] Add a two-message assertion that a subsequent “Yes” remains handled and repeats missing demographics.
- [ ] Run `npm run test:tdee` and confirm the new follow-up assertion fails.
- [ ] In `advanceTdee()`, treat a bare affirmative during `collecting` as an acknowledgement and return `missingReply()` without clearing state.
- [ ] Run `npm run test:tdee` and confirm it passes.

### Task 2: Add semantic calculator intent

**Files:**
- Modify: `src/systemPrompt.js`
- Modify: `server.js`
- Modify: `evals/cases.jsonl`
- Test: `test/tdee-test.js`

- [ ] Add `calculate_tdee` to the intent contract with natural English/Hinglish examples and explicitly exclude food calorie lookups.
- [ ] Add eval cases for natural calorie-requirement intent and a food-query negative control.
- [ ] Run the new eval cases and confirm they fail before server dispatch exists or before the prompt returns the new intent.
- [ ] After `parseMeal()`, dispatch `calculate_tdee` through `advanceTdee("calculate my calories", profile.tdee_profile || {})`, save the returned state, and return its prompt.
- [ ] Add a source-order assertion that semantic dispatch occurs before `query`, `undo`, and default logging.

### Task 3: Verify and ship

**Files:**
- Verify all modified files.

- [ ] Run TDEE, memory, correction, context, and syntax tests.
- [ ] Run `node evals/run.js`; require every case green.
- [ ] Run `git diff --check` and scan the diff for PII, URLs, and secrets.
- [ ] Commit without an AI co-author trailer.
- [ ] Restart with `launchctl kickstart -k gui/501/com.nutridesi.server`.
- [ ] Exercise the screenshot flow through the local webhook with a synthetic number, clean the synthetic rows, and confirm the health endpoint.
