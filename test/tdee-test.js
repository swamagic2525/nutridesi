const assert = require("assert");
const {
  isTdeeRequest,
  calculateTdee,
  parseFields,
  suspiciousReasons,
  advanceTdee,
  emptyState,
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

step = advanceTdee("31 male 175 cm 80 kg", step.state);
assert.strictEqual(step.state.phase, "collecting");
assert.match(step.reply, /How active/);

step = advanceTdee("3", step.state);
assert.strictEqual(step.state.phase, "complete");
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
assert.strictEqual(unitFollowUp.state.phase, "complete");
assert.match(unitFollowUp.reply, /Maintenance/);

const oneShot = advanceTdee(
  "calculate my calories, age 31 male 175 cm 80 kg activity 3",
  {}
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
assert.strictEqual(lowMaintenance.state.phase, "complete");
assert.match(lowMaintenance.reply, /Fat loss:\* No automated target/);

const fs = require("fs");
const serverSource = fs.readFileSync(require.resolve("../server.js"), "utf8");
assert.match(
  serverSource,
  /advanceTdee\(trimmed, profile\.tdee_profile \|\| \{\}\)/
);
assert.ok(
  serverSource.indexOf("advanceTdee(trimmed")
    < serverSource.indexOf("const correctionCandidate"),
  "TDEE routing must run before parseMeal/correction routing"
);

console.log("tdee-test: state machine passed");
console.log("tdee-test: server routing hook present");
