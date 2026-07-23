# TDEE Calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an anytime, user-initiated WhatsApp TDEE calculator with deterministic arithmetic, persistent multi-turn state, conservative calorie targets and bogus-input guardrails.

**Architecture:** A new pure `src/tdee.js` module owns intent detection, bounded input parsing, the conversation state machine, Mifflin–St Jeor arithmetic and response copy. Supabase stores one validated JSONB profile per user; `server.js` invokes the state machine before the meal parser and lets unrelated food messages preempt it.

**Tech Stack:** Node.js CommonJS, built-in `assert`, Express, Supabase/PostgREST, existing launchd production service.

---

## File map

- Create `src/tdee.js`: pure parsing, validation, state transitions, calculations and reply formatting.
- Create `test/tdee-test.js`: offline behavioral tests for the entire pure module.
- Create `tdee-profile.sql`: additive production migration for persistent JSONB state.
- Modify `supabase-schema.sql`: include the column for fresh installations.
- Modify `src/db.js`: fetch and save the TDEE profile with the existing user profile.
- Modify `server.js`: route explicit TDEE requests and pending answers before `parseMeal()`.
- Modify `package.json`: add the offline `test:tdee` command.

## State contract

`users.tdee_profile` is a JSON object with this shape:

```js
{
  phase: "inactive" | "collecting" | "confirming" | "complete",
  age: 31,
  formula: "male" | "female",
  heightCm: 175,
  weightKg: 80,
  activity: 3,
  invalidAttempts: 0,
  confirmedSignature: null | "31|male|175|80|3",
  bmr: 1750,
  tdee: 2700,
  calculatedAt: "2026-07-23T12:00:00.000Z"
}
```

Unknown keys and invalid stored values are ignored by `normaliseState()`. Runtime
code never trusts JSONB values without revalidation.

### Task 1: Add the persistent profile field

**Files:**
- Create: `tdee-profile.sql`
- Modify: `supabase-schema.sql`

- [ ] **Step 1: Write the additive migration**

```sql
-- Persistent state for the on-demand TDEE calculator.
alter table users
  add column if not exists tdee_profile jsonb not null default '{}'::jsonb;

comment on column users.tdee_profile is
  'Validated NutriDesi TDEE inputs, calculation and multi-turn flow state';
```

- [ ] **Step 2: Add the same column to the base users definition**

Insert after `daily_summary_time text,` in `supabase-schema.sql`:

```sql
  tdee_profile jsonb not null default '{}'::jsonb,
```

Add the repeatable migration beside the existing goal migrations:

```sql
alter table users add column if not exists tdee_profile jsonb not null default '{}'::jsonb;
```

- [ ] **Step 3: Check both SQL files**

Run:

```bash
rg -n "tdee_profile" tdee-profile.sql supabase-schema.sql
```

Expected: one declaration in `tdee-profile.sql` and two references in
`supabase-schema.sql`.

- [ ] **Step 4: Commit**

```bash
git add tdee-profile.sql supabase-schema.sql
git commit -m "Add persistent TDEE profile schema"
```

### Task 2: Build deterministic calculations and intent detection

**Files:**
- Create: `src/tdee.js`
- Create: `test/tdee-test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing calculation and routing tests**

Create `test/tdee-test.js` with:

```js
const assert = require("assert");
const {
  isTdeeRequest, calculateTdee, parseFields, suspiciousReasons,
  advanceTdee, emptyState,
} = require("../src/tdee.js");

assert.strictEqual(isTdeeRequest("calculate my calories"), true);
assert.strictEqual(isTdeeRequest("what is my TDEE?"), true);
assert.strictEqual(isTdeeRequest("fat loss calories kitna?"), true);
assert.strictEqual(isTdeeRequest("calories in one samosa?"), false);
assert.strictEqual(isTdeeRequest("set my target to 1800 calories"), false);
assert.strictEqual(isTdeeRequest("I ate 1800 calories"), false);

const male = calculateTdee({
  age: 31, formula: "male", heightCm: 175, weightKg: 80, activity: 3,
});
assert.strictEqual(male.bmr, 1750);
assert.strictEqual(male.tdee, 2700);
assert.deepStrictEqual(male.fatLoss, [2400, 2500]);
assert.deepStrictEqual(male.weightGain, [2850, 2950]);

const female = calculateTdee({
  age: 31, formula: "female", heightCm: 165, weightKg: 60, activity: 1,
});
assert.strictEqual(female.bmr, 1300);
assert.strictEqual(female.tdee, 1600);
assert.deepStrictEqual(female.fatLoss, [1300, 1400]);

const floor = calculateTdee({
  age: 70, formula: "female", heightCm: 145, weightKg: 40, activity: 1,
});
assert.ok(floor.fatLoss === null || floor.fatLoss[0] >= 1200);

const metric = parseFields("31, male, 175 cm, 80 kg, activity 3", emptyState());
assert.deepStrictEqual(
  { age: metric.patch.age, formula: metric.patch.formula, heightCm: metric.patch.heightCm,
    weightKg: metric.patch.weightKg, activity: metric.patch.activity },
  { age: 31, formula: "male", heightCm: 175, weightKg: 80, activity: 3 }
);

const imperial = parseFields("age 31 female 5 ft 5 in 132 lb level 2", emptyState());
assert.strictEqual(imperial.patch.heightCm, 165);
assert.strictEqual(imperial.patch.weightKg, 59.9);
assert.strictEqual(imperial.patch.activity, 2);

assert.strictEqual(parseFields("height 5.8", emptyState()).error, "ambiguous_height");
assert.strictEqual(parseFields("weight 180", emptyState()).error, "ambiguous_weight");
assert.strictEqual(parseFields("age -3", emptyState()).error, "invalid_age");
assert.ok(suspiciousReasons({ age: 30, formula: "male", heightCm: 175, weightKg: 210, activity: 2 })
  .includes("weight"));

console.log("tdee-test: calculations and parsing passed");
```

Add to `package.json`:

```json
"test:tdee": "node test/tdee-test.js",
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run test:tdee
```

Expected: FAIL with `Cannot find module '../src/tdee.js'`.

- [ ] **Step 3: Implement the calculation primitives**

Create `src/tdee.js` with these constants and functions:

```js
const ACTIVITY = Object.freeze({ 1: 1.2, 2: 1.375, 3: 1.55, 4: 1.725, 5: 1.9 });
const round50 = n => Math.round(Number(n) / 50) * 50;
const lbToKg = lb => Math.round((Number(lb) * 0.45359237) * 10) / 10;
const feetToCm = (feet, inches = 0) =>
  Math.round((Number(feet) * 12 + Number(inches)) * 2.54);

function emptyState() {
  return {
    phase: "inactive", age: null, formula: null, heightCm: null,
    weightKg: null, activity: null, invalidAttempts: 0,
    confirmedSignature: null, bmr: null, tdee: null, calculatedAt: null,
  };
}

function isTdeeRequest(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (/\b(calories?|kcal)\s+(?:in|of|for)\s+(?:a|an|one|two|\d+)?\s*[a-z]/.test(s)
      && !/\b(tdee|maintenance|fat loss|weight loss|weight gain)\b/.test(s)) return false;
  if (/\b(set|change|update)\b.{0,20}\b(target|goal)\b/.test(s)) return false;
  if (/\bi (?:ate|had|consumed)\b/.test(s)) return false;
  return /\btdee\b|\bmaintenance calories?\b|\bcalorie needs?\b|\bdaily calories?\b/.test(s)
    || /\bhow many calories should i (?:eat|consume|have)\b/.test(s)
    || /\bcalculate (?:my )?(?:daily )?calories?\b/.test(s)
    || /\b(?:fat loss|weight loss|weight gain|gain weight) calories?\b/.test(s);
}

function calculateTdee(input) {
  const offset = input.formula === "male" ? 5 : -161;
  const rawBmr = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age + offset;
  const bmr = round50(rawBmr);
  const tdee = round50(rawBmr * ACTIVITY[input.activity]);
  const fatLoss = tdee <= 1200
    ? null
    : [Math.max(1200, tdee - 300), Math.max(1200, tdee - 200)];
  const weightGain = [round50(tdee * 1.05), round50(tdee * 1.10)];
  return { bmr, tdee, fatLoss, weightGain };
}
```

Implement bounded parsing with these helpers and contract:

```js
// parseFields(text, state) returns:
// { patch: {}, relevant: boolean, error: null|string, restricted: null|string }
//
// Recognised:
// - age 31, aged 31, or the remaining 18-100 integer in a complete profile line
// - male/man and female/woman (test female before male)
// - 175 cm; 5 ft 9 in; 5'9"
// - 80 kg; 176 lb
// - activity/level 1..5; sedentary; 1-3/3-5/6-7 exercise days
//
// Required error codes:
// ambiguous_height, ambiguous_weight, invalid_age, invalid_height,
// invalid_weight, invalid_activity

function parseFields(text, state = emptyState()) {
  const s = String(text || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const out = { patch: {}, relevant: false, error: null, restricted: null };
  if (/\b(pregnan(?:t|cy)|breast ?feeding|nursing)\b/.test(s)) {
    out.relevant = true; out.restricted = "pregnancy"; return out;
  }

  const age = s.match(/\b(?:age|aged)\s*[:=]?\s*(-?\d{1,3})\b/)
    || s.match(/^(\d{1,3})\s+(?:(?:male|man|female|woman)\b)/);
  if (age) {
    out.relevant = true;
    const n = Number(age[1]);
    if (n < 0 || n > 100) { out.error = "invalid_age"; return out; }
    if (n < 18) { out.restricted = "underage"; return out; }
    out.patch.age = n;
  }

  if (/\b(female|woman)\b/.test(s)) {
    out.relevant = true; out.patch.formula = "female";
  } else if (/\b(male|man)\b/.test(s)) {
    out.relevant = true; out.patch.formula = "male";
  }

  const cm = s.match(/(-?\d+(?:\.\d+)?)\s*(?:cm|centimet(?:er|re)s?)\b/);
  const imperial = s.match(/(\d)\s*(?:ft|feet|foot|')\s*(?:(\d{1,2})\s*(?:in|inch(?:es)?|")?)?/);
  if (cm) {
    out.relevant = true;
    const n = Math.round(Number(cm[1]));
    if (n < 100 || n > 250) { out.error = "invalid_height"; return out; }
    out.patch.heightCm = n;
  } else if (imperial) {
    out.relevant = true;
    const n = feetToCm(imperial[1], imperial[2] || 0);
    if (n < 100 || n > 250) { out.error = "invalid_height"; return out; }
    out.patch.heightCm = n;
  } else if (!state.heightCm && (/\bheight\b/.test(s) || /^\d\.\d+$/.test(s))
      && /\b\d\.\d+\b/.test(s)) {
    out.relevant = true; out.error = "ambiguous_height"; return out;
  }

  const weight = s.match(/(-?\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)\b/);
  if (weight) {
    out.relevant = true;
    const raw = Number(weight[1]);
    const n = /^k/.test(weight[2]) ? Math.round(raw * 10) / 10 : lbToKg(raw);
    if (n < 30 || n > 350) { out.error = "invalid_weight"; return out; }
    out.patch.weightKg = n;
  } else if (!state.weightKg && /\bweight\s*[:=]?\s*-?\d+(?:\.\d+)?\s*$/.test(s)) {
    out.relevant = true; out.error = "ambiguous_weight"; return out;
  }

  const level = s.match(/\b(?:activity|level)\s*[:=]?\s*(-?\d+)\b/);
  if (level) {
    out.relevant = true;
    const n = Number(level[1]);
    if (!ACTIVITY[n]) { out.error = "invalid_activity"; return out; }
    out.patch.activity = n;
  } else if (!state.activity && /^[1-5]$/.test(s)) {
    out.relevant = true; out.patch.activity = Number(s);
  } else if (/\b(sedentary|mostly sitting|little exercise)\b/.test(s)) {
    out.relevant = true; out.patch.activity = 1;
  } else if (/\b(?:exercise|workout|train(?:ing)?)\s*1\s*[-–]\s*3\b/.test(s)) {
    out.relevant = true; out.patch.activity = 2;
  } else if (/\b(?:exercise|workout|train(?:ing)?)\s*3\s*[-–]\s*5\b/.test(s)
      || /\b(?:workout|train)\w*\s+4\s+(?:times|days)\b/.test(s)) {
    out.relevant = true; out.patch.activity = 3;
  } else if (/\b(?:exercise|workout|train(?:ing)?)\s*6\s*[-–]\s*7\b|\bactive job\b/.test(s)) {
    out.relevant = true; out.patch.activity = 4;
  } else if (/\b(?:hard training|athlete)\b.*\bphysical job\b/.test(s)) {
    out.relevant = true; out.patch.activity = 5;
  }
  return out;
}
```

Hard bounds are age 18–100, height 100–250 cm and weight 30–350 kg. Do not
clamp. Return `restricted: "underage"` for a supplied age below 18 and
`restricted: "pregnancy"` for text containing pregnant, pregnancy,
breastfeeding or nursing.

Implement:

```js
function signature(s) {
  return [s.age, s.formula, s.heightCm, s.weightKg, s.activity].join("|");
}

function suspiciousReasons(s) {
  const reasons = [];
  if (s.heightCm < 140 || s.heightCm > 210) reasons.push("height");
  if (s.weightKg < 40 || s.weightKg > 200) reasons.push("weight");
  const bmi = s.weightKg / ((s.heightCm / 100) ** 2);
  if (bmi < 12 || bmi > 70) reasons.push("combination");
  const { tdee } = calculateTdee(s);
  if (tdee < 1200 || tdee > 5000) reasons.push("tdee");
  return [...new Set(reasons)];
}
```

Export every function used by the tests.

- [ ] **Step 4: Run the calculation tests**

Run:

```bash
npm run test:tdee
```

Expected: `tdee-test: calculations and parsing passed`.

- [ ] **Step 5: Commit**

```bash
git add src/tdee.js test/tdee-test.js package.json
git commit -m "Add deterministic TDEE calculator"
```

### Task 3: Implement the persistent conversation state machine

**Files:**
- Modify: `src/tdee.js`
- Modify: `test/tdee-test.js`

- [ ] **Step 1: Add failing multi-turn tests**

Append:

```js
let step = advanceTdee("calculate my calories", {});
assert.strictEqual(step.handled, true);
assert.strictEqual(step.state.phase, "collecting");
assert.match(step.reply, /Age.*Male\/Female.*Height.*Weight/s);

step = advanceTdee("31 male 175 cm 80 kg", step.state);
assert.strictEqual(step.state.phase, "collecting");
assert.match(step.reply, /How active/);

step = advanceTdee("3", step.state);
assert.strictEqual(step.state.phase, "complete");
assert.match(step.reply, /Maintenance:\* ~2,700 kcal/);
assert.match(step.reply, /Fat loss:\* 2,400–2,500 kcal/);
assert.match(step.reply, /@swapnilgore2525/);
assert.match(step.reply, /31.*male formula.*175 cm.*80 kg.*activity 3/s);

const oneShot = advanceTdee(
  "calculate my calories, age 31 male 175 cm 80 kg activity 3", {}
);
assert.strictEqual(oneShot.state.phase, "complete");
assert.match(oneShot.reply, /Maintenance/);

let odd = advanceTdee("calculate my calories", {});
odd = advanceTdee("age 31 male 175 cm 210 kg activity 2", odd.state);
assert.strictEqual(odd.state.phase, "confirming");
assert.match(odd.reply, /Just checking/);
odd = advanceTdee("YES", odd.state);
assert.strictEqual(odd.state.phase, "complete");

let invalid = advanceTdee("calculate my calories", {});
invalid = advanceTdee("height 999 cm", invalid.state);
assert.strictEqual(invalid.state.invalidAttempts, 1);
invalid = advanceTdee("height 888 cm", invalid.state);
assert.strictEqual(invalid.state.phase, "inactive");
assert.match(invalid.reply, /175 cm/);

const preempt = advanceTdee("2 roti and dal", {
  ...emptyState(), phase: "collecting", age: 31, formula: "male",
  heightCm: 175, weightKg: 80,
});
assert.strictEqual(preempt.handled, false);
assert.strictEqual(preempt.clear, true);

const foodQuery = advanceTdee("calories in one samosa?", {});
assert.strictEqual(foodQuery.handled, false);

console.log("tdee-test: state machine passed");
```

- [ ] **Step 2: Run and verify the state tests fail**

Run:

```bash
npm run test:tdee
```

Expected: FAIL because `advanceTdee` does not yet return the required replies.

- [ ] **Step 3: Implement state normalisation and prompts**

Add:

```js
function normaliseState(raw) {
  const base = emptyState();
  const s = raw && typeof raw === "object" ? raw : {};
  const phase = ["inactive", "collecting", "confirming", "complete"].includes(s.phase)
    ? s.phase : "inactive";
  return {
    ...base, phase,
    age: Number.isInteger(s.age) && s.age >= 18 && s.age <= 100 ? s.age : null,
    formula: ["male", "female"].includes(s.formula) ? s.formula : null,
    heightCm: Number(s.heightCm) >= 100 && Number(s.heightCm) <= 250 ? Number(s.heightCm) : null,
    weightKg: Number(s.weightKg) >= 30 && Number(s.weightKg) <= 350 ? Number(s.weightKg) : null,
    activity: Number.isInteger(s.activity) && s.activity >= 1 && s.activity <= 5 ? s.activity : null,
    invalidAttempts: Math.min(Math.max(Number(s.invalidAttempts) || 0, 0), 2),
    confirmedSignature: typeof s.confirmedSignature === "string" ? s.confirmedSignature : null,
    bmr: Number.isFinite(Number(s.bmr)) ? Number(s.bmr) : null,
    tdee: Number.isFinite(Number(s.tdee)) ? Number(s.tdee) : null,
    calculatedAt: typeof s.calculatedAt === "string" ? s.calculatedAt : null,
  };
}
```

Add fixed copy helpers for:

- demographics prompt;
- activity menu;
- ambiguous/invalid input;
- two-attempt cancellation;
- underage/pregnancy guidance;
- suspicious confirmation;
- formatted result with inputs, maintenance, guarded fat loss, 5–10% gain,
  calibration disclaimer, medical disclaimer and PDF CTA.

- [ ] **Step 4: Implement `advanceTdee()`**

Use this order:

```js
function advanceTdee(text, stored = {}, now = new Date()) {
  let state = normaliseState(stored);
  const explicit = isTdeeRequest(text);
  const active = state.phase === "collecting" || state.phase === "confirming";
  if (!explicit && !active) return { handled: false, clear: false, state };

  if (explicit && !active) {
    state = { ...state, phase: "collecting", invalidAttempts: 0, confirmedSignature: null };
  }

  if (state.phase === "confirming" && /^\s*(yes|haan|ha|confirm|correct)\s*$/i.test(text)) {
    state.confirmedSignature = signature(state);
    return completedResult(state, now);
  }

  const parsed = parseFields(text, state);
  if (parsed.restricted) {
    return { handled: true, clear: false, state: emptyState(), reply: restrictedReply(parsed.restricted) };
  }
  if (parsed.error) return invalidResult(state, parsed.error);

  const useful = Object.keys(parsed.patch).length > 0;
  if (!explicit && active && !useful) {
    return { handled: false, clear: true, state: { ...state, phase: "inactive" } };
  }

  state = { ...state, ...parsed.patch, phase: "collecting", invalidAttempts: 0 };
  const missing = ["age", "formula", "heightCm", "weightKg", "activity"]
    .filter(k => state[k] == null);
  if (missing.length) {
    return { handled: true, clear: false, state, reply: missingReply(missing) };
  }

  const reasons = suspiciousReasons(state);
  if (reasons.length && state.confirmedSignature !== signature(state)) {
    return {
      handled: true, clear: false, state: { ...state, phase: "confirming" },
      reply: confirmationReply(state),
    };
  }
  return completedResult(state, now);
}
```

`invalidResult()` increments `invalidAttempts`; at two it returns `emptyState()`
and the example format. `completedResult()` stores BMR, TDEE and ISO timestamp,
sets `phase: "complete"` and returns the approved output.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:tdee
```

Expected:

```text
tdee-test: calculations and parsing passed
tdee-test: state machine passed
```

- [ ] **Step 6: Commit**

```bash
git add src/tdee.js test/tdee-test.js
git commit -m "Add guarded TDEE conversation flow"
```

### Task 4: Connect Supabase and the WhatsApp handler

**Files:**
- Modify: `src/db.js`
- Modify: `server.js`
- Modify: `test/tdee-test.js`

- [ ] **Step 1: Extend the profile helpers**

Change the `getProfile()` select to:

```js
.select("name, goal_kcal, goal_protein, nudge_count, tdee_profile")
```

Add:

```js
async function saveTdeeProfile(phone, tdeeProfile) {
  const { error } = await supabase.from("users").upsert(
    { phone_number: phone, tdee_profile: tdeeProfile || {} },
    { onConflict: "phone_number" }
  );
  if (error) {
    console.error("saveTdeeProfile:", error.message);
    return false;
  }
  return true;
}
```

Export `saveTdeeProfile`.

- [ ] **Step 2: Add the TDEE routing imports**

In `server.js`:

```js
const { advanceTdee } = require("./src/tdee.js");
```

Add `saveTdeeProfile` to the existing `src/db.js` destructuring import.

- [ ] **Step 3: Route before item/correction parsing**

Immediately after `const profile = await getProfile(from);`:

```js
  const tdee = advanceTdee(trimmed, profile.tdee_profile || {});
  if (tdee.handled) {
    await saveTdeeProfile(from, tdee.state);
    return tdee.reply;
  }
  if (tdee.clear) {
    await saveTdeeProfile(from, tdee.state);
  }
```

This makes explicit requests available at any time, consumes only valid pending
answers, and clears pending state before an unrelated food reaches `parseMeal()`.

- [ ] **Step 4: Add a source-level routing assertion**

Append to `test/tdee-test.js`:

```js
const fs = require("fs");
const serverSource = fs.readFileSync(require.resolve("../server.js"), "utf8");
assert.match(serverSource, /advanceTdee\(trimmed, profile\.tdee_profile \|\| \{\}\)/);
assert.ok(serverSource.indexOf("advanceTdee(trimmed") < serverSource.indexOf("const correctionCandidate"),
  "TDEE routing must run before parseMeal/correction routing");
console.log("tdee-test: server routing hook present");
```

- [ ] **Step 5: Run offline tests**

Run:

```bash
npm run test:tdee
npm run test:corrections
npm run test:context
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.js server.js test/tdee-test.js
git commit -m "Route TDEE conversations through persisted profiles"
```

### Task 5: Apply the migration and verify production behavior

**Files:**
- No new source files.

- [ ] **Step 1: Apply `tdee-profile.sql` to the live Supabase project**

Use the linked Supabase CLI/database connection if configured. If no safe
non-interactive database connection exists, stop before deploying code and ask
the owner to run the exact contents of `tdee-profile.sql` in Supabase SQL Editor.

Expected: `users.tdee_profile` exists with default `{}`.

- [ ] **Step 2: Verify the live column without exposing user data**

Run a service-key query selecting only the new field for a synthetic number:

```bash
node -r dotenv/config -e 'const {createClient}=require("@supabase/supabase-js"); const s=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY); s.from("users").select("tdee_profile").eq("phone_number","+0000000000").limit(1).then(({error})=>{if(error)throw error; console.log("tdee_profile column reachable")})'
```

Expected: `tdee_profile column reachable`.

- [ ] **Step 3: Run all relevant tests**

```bash
npm run test:tdee
npm run test:corrections
npm run test:context
npm run test:guard
npm run test:serving
npm run test:undoall
node test/audit-fixes-test.js
```

Expected: every command passes.

- [ ] **Step 4: Run the mandatory live eval suite**

```bash
node evals/run.js
```

Expected: `158/158` green.

- [ ] **Step 5: Scan the complete diff for PII and secrets**

```bash
git diff main...HEAD --check
git diff main...HEAD | rg -n "\+91[0-9]{10}|ngrok|api[_ -]?key|auth[_ -]?token|BEGIN (RSA|OPENSSH)|@gmail\.com"
```

Expected: `git diff --check` is silent; the PII scan has no real credential,
phone, tunnel or email matches. Product copy may include the already-public
Instagram handle approved in the design.

- [ ] **Step 6: Merge to the live branch and restart launchd**

After the branch is merged:

```bash
launchctl kickstart -k gui/501/com.nutridesi.server
```

Expected: command succeeds.

- [ ] **Step 7: Verify live health**

```bash
curl --fail --silent http://127.0.0.1:3000/
tail -n 40 "$HOME/Library/Logs/nutridesi.log"
```

Expected: `NutriDesi is running.` and a fresh `NutriDesi listening on :3000`
line with no startup error.

- [ ] **Step 8: Manual WhatsApp checks**

Send:

```text
calculate my calories
31 male 175 cm 80 kg
3
```

Expected: maintenance ~2,700 kcal, fat loss 2,400–2,500 kcal, gain
2,850–2,950 kcal, inputs, disclaimer and PDF CTA.

Also verify:

```text
calories in one samosa?
```

Expected: normal food query, not the TDEE calculator.

Verify preemption by starting the calculator and then sending:

```text
2 roti and dal
```

Expected: the meal logs normally and pending TDEE state clears.
