const assert = require("assert");
const {
  isTdeeRequest,
  calculateTdee,
  parseFields,
  suspiciousReasons,
  advanceTdee,
  emptyState,
  normaliseState,
  tdeeRouteAction,
  shouldRouteSemanticTdee,
  parseGoalChoice,
  goalForObjective,
  proteinTarget,
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
assert.strictEqual(floor.fatLoss, null);

const activityExpected = { 1: 2150, 2: 2450, 3: 2750, 4: 3050, 5: 3400 };
for (const activity of [1, 2, 3, 4, 5]) {
  const result = calculateTdee({
    age: 30, formula: "male", heightCm: 180, weightKg: 80, activity,
  });
  assert.strictEqual(result.tdee, activityExpected[activity]);
}

const metric = parseFields("31, male, 175 cm, 80 kg, activity 3", emptyState());
assert.deepStrictEqual(
  {
    age: metric.patch.age,
    formula: metric.patch.formula,
    heightCm: metric.patch.heightCm,
    weightKg: metric.patch.weightKg,
    activity: metric.patch.activity,
  },
  { age: 31, formula: "male", heightCm: 175, weightKg: 80, activity: 3 }
);

const imperial = parseFields("age 31 female 5 ft 5 in 132 lb level 2", emptyState());
assert.strictEqual(imperial.patch.heightCm, 165);
assert.strictEqual(imperial.patch.weightKg, 59.9);
assert.strictEqual(imperial.patch.activity, 2);

assert.strictEqual(parseFields("height 5.8", emptyState()).error, "ambiguous_height");
assert.strictEqual(parseFields("weight 180", emptyState()).error, "ambiguous_weight");
assert.strictEqual(parseFields("age -3", emptyState()).error, "invalid_age");
assert.strictEqual(parseFields("height 999 cm", emptyState()).error, "invalid_height");
assert.strictEqual(parseFields("weight 500 kg", emptyState()).error, "invalid_weight");
assert.ok(
  suspiciousReasons({
    age: 30, formula: "male", heightCm: 175, weightKg: 210, activity: 2,
  }).includes("weight")
);

console.log("tdee-test: calculations and parsing passed");

let step = advanceTdee("calculate my calories", {});
assert.strictEqual(step.handled, true);
assert.strictEqual(step.state.phase, "collecting");
assert.match(step.reply, /Age.*Male\/Female.*Height.*Weight/s);

let requirementsStep = advanceTdee("calculate my calories", {});
requirementsStep = advanceTdee("Yes", requirementsStep.state);
assert.strictEqual(requirementsStep.handled, true);
assert.strictEqual(requirementsStep.state.phase, "collecting");
assert.match(requirementsStep.reply, /Age.*Male\/Female.*Height.*Weight/s);

step = advanceTdee("31 male 175 cm 80 kg", step.state);
assert.strictEqual(step.state.phase, "collecting");
assert.match(step.reply, /How active/);

step = advanceTdee("3", step.state);
assert.strictEqual(step.state.phase, "goal_offer", "a finished calculation now waits on the goal choice");
assert.match(step.reply, /Maintenance:\* ~2,700 kcal/);
assert.match(step.reply, /Fat loss:\* 2,400–2,500 kcal/);
assert.match(step.reply, /@swapnilgore2525/);
assert.match(step.reply, /31.*male formula.*175 cm.*80 kg.*activity 3/s);

let unitFollowUp = advanceTdee("calculate my calories for fat loss", {});
unitFollowUp = advanceTdee("Age 39 female height 155 cm weight 61", unitFollowUp.state);
assert.strictEqual(unitFollowUp.handled, true);
assert.strictEqual(unitFollowUp.state.age, 39);
assert.strictEqual(unitFollowUp.state.formula, "female");
assert.strictEqual(unitFollowUp.state.heightCm, 155);
assert.strictEqual(unitFollowUp.state.weightKg, null);
assert.strictEqual(unitFollowUp.state.pendingWeightValue, 61);
assert.match(unitFollowUp.reply, /include the unit/i);
unitFollowUp = advanceTdee("kg", unitFollowUp.state);
assert.strictEqual(unitFollowUp.handled, true);
assert.strictEqual(unitFollowUp.state.weightKg, 61);
assert.strictEqual(unitFollowUp.state.pendingWeightValue, null);
assert.match(unitFollowUp.reply, /How active/);
unitFollowUp = advanceTdee("1", unitFollowUp.state);
assert.strictEqual(unitFollowUp.state.phase, "goal_offer", "a finished calculation now waits on the goal choice");
assert.match(unitFollowUp.reply, /Maintenance/);

let pendingWeight = advanceTdee("calculate my calories", {});
pendingWeight = advanceTdee("age 39 female height 155 cm weight 61", pendingWeight.state);
assert.strictEqual(pendingWeight.state.invalidAttempts, 0);
pendingWeight = advanceTdee("500 kg", pendingWeight.state);
assert.match(pendingWeight.reply, /weight doesn't look valid/i);
assert.strictEqual(pendingWeight.state.pendingWeightValue, null);
pendingWeight = advanceTdee("kg", pendingWeight.state);
assert.strictEqual(pendingWeight.handled, false);
assert.strictEqual(pendingWeight.state.weightKg, null);

const hugePendingKg = advanceTdee("kg", {
  ...emptyState(), phase: "collecting", pendingWeightValue: 1e31,
});
assert.match(hugePendingKg.reply, /weight doesn't look valid/i);
assert.strictEqual(hugePendingKg.state.weightKg, null);

const hugePendingLb = advanceTdee("lb", {
  ...emptyState(), phase: "collecting", pendingWeightValue: 1e31,
});
assert.match(hugePendingLb.reply, /weight doesn't look valid/i);
assert.strictEqual(hugePendingLb.state.weightKg, null);

let pendingLb = advanceTdee("calculate my calories", {});
pendingLb = advanceTdee("weight 132", pendingLb.state);
pendingLb = advanceTdee("lb", pendingLb.state);
assert.strictEqual(pendingLb.state.weightKg, 59.9);

const inactiveUnit = advanceTdee("kg", {});
assert.strictEqual(inactiveUnit.handled, false);

const oneShot = advanceTdee(
  "calculate my calories, age 31 male 175 cm 80 kg activity 3",
  {}
);
assert.strictEqual(oneShot.state.phase, "goal_offer", "a finished calculation now waits on the goal choice");
assert.match(oneShot.reply, /Maintenance/);

let odd = advanceTdee("calculate my calories", {});
odd = advanceTdee("age 31 male 175 cm 210 kg activity 2", odd.state);
assert.strictEqual(odd.state.phase, "confirming");
assert.match(odd.reply, /Just checking/);
odd = advanceTdee("YES", odd.state);
assert.strictEqual(odd.state.phase, "goal_offer", "a finished calculation now waits on the goal choice");

let invalid = advanceTdee("calculate my calories", {});
invalid = advanceTdee("height 999 cm", invalid.state);
assert.strictEqual(invalid.state.invalidAttempts, 1);
invalid = advanceTdee("height 888 cm", invalid.state);
assert.strictEqual(invalid.state.phase, "inactive");
assert.match(invalid.reply, /175 cm/);

const preempt = advanceTdee("2 roti and dal", {
  ...emptyState(),
  phase: "collecting",
  age: 31,
  formula: "male",
  heightCm: 175,
  weightKg: 80,
});
assert.strictEqual(preempt.handled, false);
assert.strictEqual(preempt.clear, true);

const foodQuery = advanceTdee("calories in one samosa?", {});
assert.strictEqual(foodQuery.handled, false);

const underage = advanceTdee("calculate my calories age 16 male 170 cm 60 kg", {});
assert.strictEqual(underage.state.phase, "inactive");
assert.match(underage.reply, /under 18/i);

const pregnancy = advanceTdee("calculate my calories while pregnant", {});
assert.strictEqual(pregnancy.state.phase, "inactive");
assert.match(pregnancy.reply, /pregnancy or breastfeeding/i);

let lowMaintenance = advanceTdee(
  "calculate my calories age 70 female 145 cm 40 kg activity 1",
  {}
);
assert.strictEqual(lowMaintenance.state.phase, "confirming");
lowMaintenance = advanceTdee("yes", lowMaintenance.state);
assert.strictEqual(lowMaintenance.state.phase, "goal_offer", "a finished calculation now waits on the goal choice");
assert.match(lowMaintenance.reply, /Fat loss:\* No automated target/);

console.log("tdee-test: state machine passed");

// --- normaliseState: the trust boundary for users.tdee_profile jsonb ---
// Anything can be in that column (bad write, schema drift, manual edit). These
// assert it always yields a usable state rather than propagating garbage into
// calculateTdee.
assert.deepStrictEqual(normaliseState(null), emptyState());
assert.deepStrictEqual(normaliseState("not an object"), emptyState());
assert.deepStrictEqual(normaliseState([1, 2, 3]), emptyState());
assert.deepStrictEqual(normaliseState(undefined), emptyState());

// Out-of-range values are dropped, not clamped to a plausible-but-wrong number.
const outOfRange = normaliseState({
  phase: "collecting", age: 999, formula: "alien",
  heightCm: 1e9, weightKg: -50, activity: 99,
});
assert.strictEqual(outOfRange.age, null);
assert.strictEqual(outOfRange.formula, null);
assert.strictEqual(outOfRange.heightCm, null);
assert.strictEqual(outOfRange.weightKg, null);
assert.strictEqual(outOfRange.activity, null);

// An unknown phase falls back to inactive rather than stranding the user.
assert.strictEqual(normaliseState({ phase: "banana" }).phase, "inactive");
for (const phase of ["inactive", "collecting", "confirming", "complete"]) {
  assert.strictEqual(normaliseState({ phase }).phase, phase, `${phase} preserved`);
}

// NaN/Infinity must not survive into arithmetic.
const nonFinite = normaliseState({
  phase: "collecting", age: NaN, heightCm: Infinity,
  weightKg: -Infinity, pendingWeightValue: Infinity, activity: NaN,
});
assert.strictEqual(nonFinite.age, null);
assert.strictEqual(nonFinite.heightCm, null);
assert.strictEqual(nonFinite.weightKg, null);
assert.strictEqual(nonFinite.pendingWeightValue, null);
assert.strictEqual(nonFinite.activity, null);

// invalidAttempts is clamped into [0, 2] so a poisoned counter can neither
// loop forever nor skip the abandon path.
assert.strictEqual(normaliseState({ invalidAttempts: -99 }).invalidAttempts, 0);
assert.strictEqual(normaliseState({ invalidAttempts: 1e9 }).invalidAttempts, 2);
assert.strictEqual(normaliseState({ invalidAttempts: "junk" }).invalidAttempts, 0);

// A __proto__ key in the stored JSON must not pollute Object.prototype.
normaliseState(JSON.parse('{"__proto__":{"tdeePolluted":true},"phase":"complete"}'));
assert.strictEqual({}.tdeePolluted, undefined, "no prototype pollution");

// A corrupt row can yield phase=complete with no data. That must degrade to
// passthrough (user keeps logging food) rather than emitting a null-filled
// summary, and a fresh request must restart collection cleanly.
const hollowComplete = { phase: "complete", age: 999, heightCm: 1e9, weightKg: -50 };
assert.strictEqual(advanceTdee("2 roti and dal", hollowComplete).handled, false);
assert.strictEqual(advanceTdee("what is my tdee", hollowComplete).state.phase, "collecting");

console.log("tdee-test: normaliseState guards passed");

// --- suspiciousReasons: every branch ---
const sane = { age: 30, formula: "male", heightCm: 175, weightKg: 75, activity: 3 };
assert.deepStrictEqual(suspiciousReasons(sane), [], "a normal body is not suspicious");

// Incomplete/invalid input short-circuits to ["invalid"].
assert.deepStrictEqual(suspiciousReasons({}), ["invalid"]);
assert.deepStrictEqual(suspiciousReasons(null), ["invalid"]);
assert.deepStrictEqual(suspiciousReasons({ ...sane, activity: 9 }), ["invalid"]);

assert.ok(suspiciousReasons({ ...sane, heightCm: 135 }).includes("height"));
assert.ok(suspiciousReasons({ ...sane, heightCm: 215 }).includes("height"));
assert.ok(suspiciousReasons({ ...sane, weightKg: 210 }).includes("weight"));
assert.ok(suspiciousReasons({ ...sane, weightKg: 35 }).includes("weight"));

// "combination" is the only cross-field check: each value is individually
// plausible but the BMI they imply is not.
const highBmi = suspiciousReasons({ ...sane, heightCm: 150, weightKg: 190 });
assert.ok(highBmi.includes("combination"), `expected combination, got ${highBmi}`);

// "tdee" fires when the computed target itself lands outside 1200-5000.
const hugeTdee = suspiciousReasons({
  age: 18, formula: "male", heightCm: 210, weightKg: 200, activity: 5,
});
assert.ok(hugeTdee.includes("tdee"), `expected tdee, got ${hugeTdee}`);

// Reasons are de-duplicated.
const multi = suspiciousReasons({ ...sane, heightCm: 145, weightKg: 205 });
assert.deepStrictEqual(multi, [...new Set(multi)], "reasons are unique");

console.log("tdee-test: suspiciousReasons branches passed");

// --- Routing decisions (behaviour, not source text) ---
// These replace assertions that grepped server.js. That approach broke on a
// harmless variable rename and passed when the call sat in dead code.
assert.deepStrictEqual(
  tdeeRouteAction({ handled: true, clear: false, state: { phase: "collecting" }, reply: "ask age" }),
  { action: "reply", state: { phase: "collecting" }, reply: "ask age", setGoal: null }
);
assert.deepStrictEqual(
  tdeeRouteAction({ handled: false, clear: true, state: { phase: "inactive" } }),
  { action: "clear", state: { phase: "inactive" }, reply: null, setGoal: null }
);
assert.strictEqual(
  tdeeRouteAction({ handled: false, clear: false, state: {} }).action,
  "passthrough"
);
// handled wins over clear — never drop a reply on the floor.
assert.strictEqual(
  tdeeRouteAction({ handled: true, clear: true, state: {}, reply: "r" }).action,
  "reply"
);
for (const bad of [null, undefined, "x", 42, []]) {
  assert.strictEqual(tdeeRouteAction(bad).action, "passthrough", `${bad} -> passthrough`);
}

// The real flows must produce the actions the webhook depends on.
assert.strictEqual(tdeeRouteAction(advanceTdee("what is my TDEE?", {})).action, "reply");
assert.strictEqual(tdeeRouteAction(advanceTdee("calories in one samosa?", {})).action, "passthrough");
assert.strictEqual(tdeeRouteAction(advanceTdee("2 roti and dal", {
  ...emptyState(), phase: "collecting", age: 31, formula: "male", heightCm: 175, weightKg: 80,
})).action, "clear", "food mid-collection clears TDEE state and keeps routing");

assert.strictEqual(
  shouldRouteSemanticTdee({ intent: "calculate_tdee" }), true
);
assert.strictEqual(
  shouldRouteSemanticTdee({ intent: "query" }), false
);
// A user mid-correction or under a forced intent is not pulled into TDEE.
assert.strictEqual(
  shouldRouteSemanticTdee({ intent: "calculate_tdee", forcedIntent: "replace_last" }), false
);
assert.strictEqual(
  shouldRouteSemanticTdee({ intent: "calculate_tdee", expectedCorrectedMeal: true }), false
);
assert.strictEqual(shouldRouteSemanticTdee({}), false);
assert.strictEqual(shouldRouteSemanticTdee(null), false);

console.log("tdee-test: routing decisions passed");

// Ordering is the one property that still needs the source, because server.js
// calls app.listen() at module load and cannot be require()d here. Anchored on
// exported function names (stable API) rather than local variable names.
// --- TDEE -> goal loop ---
// The calculator used to compute the numbers, show them, and discard them.
// These cover the handoff into an actual goal.

// "goal" reaches the calculator (the first-log prompt tells people to send it),
// but a stated number still belongs to set_profile.
assert.strictEqual(isTdeeRequest("goal"), true);
assert.strictEqual(isTdeeRequest("set my goal"), true);
assert.strictEqual(isTdeeRequest("Goals"), true);
assert.strictEqual(isTdeeRequest("set my target to 1800 calories"), false, "a stated number is not a request to compute one");
assert.strictEqual(isTdeeRequest("goal 1800 cal"), false);

assert.strictEqual(parseGoalChoice("fat loss"), "fatLoss");
assert.strictEqual(parseGoalChoice("I want to lose weight"), "fatLoss");
assert.strictEqual(parseGoalChoice("maintenance"), "maintenance");
assert.strictEqual(parseGoalChoice("weight gain"), "weightGain");
assert.strictEqual(parseGoalChoice("bulk"), "weightGain");
assert.strictEqual(parseGoalChoice("skip"), "skip");
assert.strictEqual(parseGoalChoice("2 roti and dal"), null, "a meal is not a choice");
assert.strictEqual(parseGoalChoice(""), null);

// Protein is bodyweight-driven, but capped by protein's share of the day's
// calories — without body-fat data, weight alone is absurd at the extremes.
assert.strictEqual(proteinTarget(80, 2400, "fatLoss"), 160);      // 80 * 2.0
assert.strictEqual(proteinTarget(80, 2700, "maintenance"), 130);  // 80 * 1.6 -> 128 -> 130
const capped = proteinTarget(150, 2000, "fatLoss");               // 300g would be absurd
assert.ok(capped <= (2000 * 0.35) / 4, `capped by calorie share, got ${capped}`);
assert.strictEqual(proteinTarget(0, 2000, "fatLoss"), null);

// A completed calculation offers the goal rather than ending on a PDF pitch.
let goalFlow = advanceTdee("calculate my calories", {});
goalFlow = advanceTdee("31 male 175 cm 80 kg activity 3", goalFlow.state);
assert.strictEqual(goalFlow.state.phase, "goal_offer", "parks awaiting a choice, not 'complete'");
assert.match(goalFlow.reply, /Maintenance:\* ~2,700 kcal/);
assert.match(goalFlow.reply, /Want me to track against one of these/);
assert.match(goalFlow.reply, /\*fat loss\*/);

// Choosing one sets a real goal, and the caller is handed the values.
const chose = advanceTdee("fat loss", goalFlow.state);
assert.strictEqual(chose.handled, true);
assert.strictEqual(chose.state.phase, "complete");
assert.ok(chose.setGoal, "setGoal is returned for the caller to persist");
assert.strictEqual(chose.setGoal.goal_kcal, 2450, "midpoint of the 2,400-2,500 fat-loss range");
assert.strictEqual(chose.setGoal.goal_protein, 160);
assert.match(chose.reply, /Daily goal set/);
assert.match(chose.reply, /160g protein/);

const choseMaint = advanceTdee("maintenance", goalFlow.state);
assert.strictEqual(choseMaint.setGoal.goal_kcal, 2700);

// Skipping is allowed and leaves no goal.
const skipped = advanceTdee("skip", goalFlow.state);
assert.strictEqual(skipped.handled, true);
assert.strictEqual(skipped.state.phase, "complete");
assert.strictEqual(skipped.setGoal, undefined, "skip sets nothing");

// An optional question must never hold the conversation hostage: a meal sent
// instead of an answer falls through to be logged (PRD: no deadlocks).
const mealInstead = advanceTdee("2 roti and dal", goalFlow.state);
assert.strictEqual(mealInstead.handled, false, "a meal is not swallowed by the offer");
assert.strictEqual(mealInstead.clear, true, "and the offer is cleared");
assert.strictEqual(mealInstead.state.phase, "complete");

// Below the 1,200 kcal floor there is no fat-loss target, so it is neither
// offered nor settable.
let floorFlow = advanceTdee("calculate my calories age 70 female 145 cm 40 kg activity 1", {});
floorFlow = advanceTdee("yes", floorFlow.state);
assert.strictEqual(floorFlow.state.phase, "goal_offer");
assert.doesNotMatch(floorFlow.reply, /\*fat loss\*/, "fat loss is not offered below the floor");
const refused = advanceTdee("fat loss", floorFlow.state);
assert.strictEqual(refused.setGoal, undefined, "and cannot be set");
assert.match(refused.reply, /can't set a safe target/i);
assert.ok(advanceTdee("maintenance", floorFlow.state).setGoal, "maintenance still works there");

// goalForObjective is pure and refuses unknown objectives.
assert.strictEqual(goalForObjective({ age: 31, formula: "male", heightCm: 175, weightKg: 80, activity: 3 }, "nonsense"), null);

// A goal_offer state restored from jsonb survives normalisation.
assert.strictEqual(normaliseState({ phase: "goal_offer" }).phase, "goal_offer");

console.log("tdee-test: goal loop passed");

// Routing ORDER inside handleMessage is verified behaviourally in
// test/server-routing-test.js (`npm run test:routing`), which require()s
// server.js with the DB and parser stubbed. No source-text assertions here.
