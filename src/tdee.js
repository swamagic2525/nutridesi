const ACTIVITY = Object.freeze({
  1: 1.2,
  2: 1.375,
  3: 1.55,
  4: 1.725,
  5: 1.9,
});

const round50 = n => Math.round(Number(n) / 50) * 50;
const lbToKg = lb => Math.round((Number(lb) * 0.45359237) * 10) / 10;
const feetToCm = (feet, inches = 0) =>
  Math.round((Number(feet) * 12 + Number(inches)) * 2.54);
const weightToKg = (value, unit) => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const kg = /^k/.test(unit) ? Math.round(raw * 10) / 10 : lbToKg(raw);
  return Number.isFinite(kg) ? kg : null;
};

function emptyState() {
  return {
    phase: "inactive",
    age: null,
    formula: null,
    heightCm: null,
    weightKg: null,
    pendingWeightValue: null,
    activity: null,
    invalidAttempts: 0,
    confirmedSignature: null,
    bmr: null,
    tdee: null,
    calculatedAt: null,
  };
}

function isTdeeRequest(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (
    /\b(calories?|kcal)\s+(?:in|of|for)\s+(?:a|an|one|two|\d+)?\s*[a-z]/.test(s)
    && !/\b(tdee|maintenance|fat loss|weight loss|weight gain)\b/.test(s)
  ) return false;
  // "set my target to 1800" is the user stating a number — that belongs to
  // set_profile. "set my goal" with no number is a request to work one out,
  // which is exactly this flow, so only defer when a figure is actually given.
  if (/\b(set|change|update)\b.{0,20}\b(target|goal)\b/.test(s) && /\d/.test(s)) return false;
  if (/\bi (?:ate|had|consumed)\b/.test(s)) return false;
  // The first-log prompt tells people to reply "goal"; honour it literally.
  if (/^(?:set )?(?:my )?(?:daily )?goals?$/.test(s)) return true;
  return /\btdee\b|\bmaintenance calories?\b|\bcalorie needs?\b|\bdaily calories?\b/.test(s)
    || /\bhow many calories should i (?:eat|consume|have)\b/.test(s)
    || /\bcalculate (?:my )?(?:daily )?calories?\b/.test(s)
    || /\b(?:fat loss|weight loss|weight gain|gain weight) calories?\b/.test(s);
}

function validCompleteInput(input) {
  return Number.isInteger(input.age) && input.age >= 18 && input.age <= 100
    && (input.formula === "male" || input.formula === "female")
    && Number.isFinite(input.heightCm) && input.heightCm >= 100 && input.heightCm <= 250
    && Number.isFinite(input.weightKg) && input.weightKg >= 30 && input.weightKg <= 350
    && Number.isInteger(input.activity) && ACTIVITY[input.activity];
}

function calculateTdee(input) {
  if (!validCompleteInput(input || {})) throw new Error("invalid TDEE input");
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

function parseFields(text, state = emptyState()) {
  const s = String(text || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const out = {
    patch: {}, relevant: false, error: null, restricted: null, pendingWeightValue: null,
    weightProvided: false,
  };

  if (/\b(pregnan(?:t|cy)|breast ?feeding|nursing)\b/.test(s)) {
    out.relevant = true;
    out.restricted = "pregnancy";
    return out;
  }

  const age = s.match(/\b(?:age|aged)\s*[:=]?\s*(-?\d{1,3})\b/)
    || s.match(/^(\d{1,3})\s+(?:(?:male|man|female|woman)\b)/);
  if (age) {
    out.relevant = true;
    const n = Number(age[1]);
    if (n < 0 || n > 100) {
      out.error = "invalid_age";
      return out;
    }
    if (n < 18) {
      out.restricted = "underage";
      return out;
    }
    out.patch.age = n;
  }

  if (/\b(female|woman)\b/.test(s)) {
    out.relevant = true;
    out.patch.formula = "female";
  } else if (/\b(male|man)\b/.test(s)) {
    out.relevant = true;
    out.patch.formula = "male";
  }

  const cm = s.match(/(-?\d+(?:\.\d+)?)\s*(?:cm|centimet(?:er|re)s?)\b/);
  const imperial = s.match(/(\d)\s*(?:ft|feet|foot|')\s*(?:(\d{1,2})\s*(?:in|inch(?:es)?|")?)?/);
  if (cm) {
    out.relevant = true;
    const n = Math.round(Number(cm[1]));
    if (n < 100 || n > 250) {
      out.error = "invalid_height";
      return out;
    }
    out.patch.heightCm = n;
  } else if (imperial) {
    out.relevant = true;
    const n = feetToCm(imperial[1], imperial[2] || 0);
    if (n < 100 || n > 250) {
      out.error = "invalid_height";
      return out;
    }
    out.patch.heightCm = n;
  } else if (
    !state.heightCm
    && (/\bheight\b/.test(s) || /^\d\.\d+$/.test(s))
    && /\b\d\.\d+\b/.test(s)
  ) {
    out.relevant = true;
    out.error = "ambiguous_height";
    return out;
  }

  const weight = s.match(/(-?\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)\b/);
  if (weight) {
    out.relevant = true;
    out.weightProvided = true;
    const n = weightToKg(weight[1], weight[2]);
    if (n == null || n < 30 || n > 350) {
      out.error = "invalid_weight";
      return out;
    }
    out.patch.weightKg = n;
    out.pendingWeightValue = null;
  } else if (
    !state.weightKg
    && /\bweight\s*[:=]?\s*-?\d+(?:\.\d+)?\s*$/.test(s)
  ) {
    out.relevant = true;
    out.pendingWeightValue = Number(s.match(/-?\d+(?:\.\d+)?\s*$/)[0]);
    out.error = "ambiguous_weight";
    return out;
  }

  const level = s.match(/\b(?:activity|level)\s*[:=]?\s*(-?\d+)\b/);
  if (level) {
    out.relevant = true;
    const n = Number(level[1]);
    if (!ACTIVITY[n]) {
      out.error = "invalid_activity";
      return out;
    }
    out.patch.activity = n;
  } else if (!state.activity && /^[1-5]$/.test(s)) {
    out.relevant = true;
    out.patch.activity = Number(s);
  } else if (/\b(sedentary|mostly sitting|little exercise)\b/.test(s)) {
    out.relevant = true;
    out.patch.activity = 1;
  } else if (/\b(?:exercise|workout|train(?:ing)?)\s*1\s*[-–]\s*3\b/.test(s)) {
    out.relevant = true;
    out.patch.activity = 2;
  } else if (
    /\b(?:exercise|workout|train(?:ing)?)\s*3\s*[-–]\s*5\b/.test(s)
    || /\b(?:workout|train)\w*\s+4\s+(?:times|days)\b/.test(s)
  ) {
    out.relevant = true;
    out.patch.activity = 3;
  } else if (
    /\b(?:exercise|workout|train(?:ing)?)\s*6\s*[-–]\s*7\b|\bactive job\b/.test(s)
  ) {
    out.relevant = true;
    out.patch.activity = 4;
  } else if (/\b(?:hard training|athlete)\b.*\bphysical job\b/.test(s)) {
    out.relevant = true;
    out.patch.activity = 5;
  }

  return out;
}

function suspiciousReasons(state) {
  if (!validCompleteInput(state || {})) return ["invalid"];
  const reasons = [];
  if (state.heightCm < 140 || state.heightCm > 210) reasons.push("height");
  if (state.weightKg < 40 || state.weightKg > 200) reasons.push("weight");
  const bmi = state.weightKg / ((state.heightCm / 100) ** 2);
  if (bmi < 12 || bmi > 70) reasons.push("combination");
  const { tdee } = calculateTdee(state);
  if (tdee < 1200 || tdee > 5000) reasons.push("tdee");
  return [...new Set(reasons)];
}

function normaliseState(raw) {
  const base = emptyState();
  const s = raw && typeof raw === "object" ? raw : {};
  const phase = ["inactive", "collecting", "confirming", "goal_offer", "complete"].includes(s.phase)
    ? s.phase
    : "inactive";
  return {
    ...base,
    phase,
    age: Number.isInteger(s.age) && s.age >= 18 && s.age <= 100 ? s.age : null,
    formula: ["male", "female"].includes(s.formula) ? s.formula : null,
    heightCm: Number.isFinite(Number(s.heightCm))
      && Number(s.heightCm) >= 100 && Number(s.heightCm) <= 250
      ? Number(s.heightCm)
      : null,
    weightKg: Number.isFinite(Number(s.weightKg))
      && Number(s.weightKg) >= 30 && Number(s.weightKg) <= 350
      ? Number(s.weightKg)
      : null,
    pendingWeightValue: s.pendingWeightValue == null
      ? null
      : Number.isFinite(Number(s.pendingWeightValue))
        ? Number(s.pendingWeightValue)
        : null,
    activity: Number.isInteger(s.activity) && s.activity >= 1 && s.activity <= 5
      ? s.activity
      : null,
    invalidAttempts: Math.min(Math.max(Number(s.invalidAttempts) || 0, 0), 2),
    confirmedSignature: typeof s.confirmedSignature === "string"
      ? s.confirmedSignature
      : null,
    bmr: Number.isFinite(Number(s.bmr)) ? Number(s.bmr) : null,
    tdee: Number.isFinite(Number(s.tdee)) ? Number(s.tdee) : null,
    calculatedAt: typeof s.calculatedAt === "string" ? s.calculatedAt : null,
  };
}

function signature(state) {
  return [
    state.age,
    state.formula,
    state.heightCm,
    state.weightKg,
    state.activity,
  ].join("|");
}

function demographicsPrompt(missing) {
  const labels = [];
  if (missing.includes("age")) labels.push("Age");
  if (missing.includes("formula")) labels.push("Male/Female formula");
  if (missing.includes("heightCm")) labels.push("Height");
  if (missing.includes("weightKg")) labels.push("Weight");
  const lead = labels.length === 4
    ? "Sure 💪 Send these in one message:"
    : `I still need: *${labels.join(" · ")}*`;
  return `${lead}\n*${labels.join(" · ")}*\nExample: _31, male, 175 cm, 80 kg_`;
}

function activityPrompt() {
  return "How active are you normally?\n\n"
    + "1️⃣ Mostly sitting, little exercise\n"
    + "2️⃣ Exercise 1–3 days/week\n"
    + "3️⃣ Exercise 3–5 days/week\n"
    + "4️⃣ Exercise 6–7 days/week or an active job\n"
    + "5️⃣ Hard training plus a physical job\n\n"
    + "_Choose the lower option if unsure._";
}

function missingReply(missing) {
  const demographics = ["age", "formula", "heightCm", "weightKg"]
    .filter(field => missing.includes(field));
  return demographics.length ? demographicsPrompt(demographics) : activityPrompt();
}

function restrictedReply(reason) {
  const subject = reason === "underage"
    ? "Because you're under 18"
    : "During pregnancy or breastfeeding";
  return `${subject}, I won't calculate an automated calorie target. `
    + "Your needs are more individual—please speak with a doctor or registered dietitian.";
}

const INVALID_REPLIES = {
  ambiguous_height: "Please send height as *175 cm* or *5 ft 9 in*—I won't guess decimal feet.",
  ambiguous_weight: "Please include the unit: for example *80 kg* or *176 lb*.",
  invalid_age: "That age doesn't look valid. This calculator is for adults aged 18–100.",
  invalid_height: "That height doesn't look valid. Send it as *175 cm* or *5 ft 9 in*.",
  invalid_weight: "That weight doesn't look valid. Send it as *80 kg* or *176 lb*.",
  invalid_activity: "Please choose an activity level from *1 to 5*.",
};

function invalidResult(state, error) {
  const attempts = (state.invalidAttempts || 0) + 1;
  if (attempts >= 2) {
    return {
      handled: true,
      clear: false,
      state: emptyState(),
      reply: "Let's stop the calculator for now so I don't use a wrong number. "
        + "Start again with: *calculate my calories — 31, male, 175 cm, 80 kg*",
    };
  }
  return {
    handled: true,
    clear: false,
    state: { ...state, phase: "collecting", invalidAttempts: attempts },
    reply: INVALID_REPLIES[error] || "That answer doesn't look valid. Please send it again.",
  };
}

function confirmationReply(state) {
  return `Just checking: did you mean *${state.weightKg} kg at ${state.heightCm} cm*, `
    + `age ${state.age}, using the ${state.formula} formula and activity ${state.activity}? `
    + "Reply *YES* to confirm or send the corrected values.";
}

function formatKcal(value) {
  return Math.round(Number(value)).toLocaleString("en-IN");
}

function resultReply(state, result) {
  let lossLine;
  let floorWarning = "";
  if (!result.fatLoss) {
    lossLine = "*Fat loss:* No automated target";
    floorWarning = "\n⚠️ Estimated maintenance is already at or below NutriDesi's "
      + "1,200 kcal safety floor, so I won't recommend a deficit.";
  } else if (result.fatLoss[0] === result.fatLoss[1]) {
    lossLine = `*Fat loss:* ${formatKcal(result.fatLoss[0])} kcal/day`;
    floorWarning = "\n⚠️ A larger deficit would take you below NutriDesi's 1,200 kcal "
      + "safety floor, so I won't recommend it. This floor is only a guardrail—not "
      + "a guarantee that 1,200 is appropriate for everyone.";
  } else {
    lossLine = `*Fat loss:* ${formatKcal(result.fatLoss[0])}–${formatKcal(result.fatLoss[1])} kcal/day`;
    if (result.fatLoss[0] === 1200) {
      floorWarning = "\n⚠️ A larger deficit would take you below NutriDesi's 1,200 kcal "
        + "safety floor, so I won't recommend it. This floor is only a guardrail—not "
        + "a guarantee that 1,200 is appropriate for everyone.";
    }
  }
  return "🔥 *Your estimated daily calories*\n\n"
    + `_Based on: age ${state.age} · ${state.formula} formula · ${state.heightCm} cm · `
    + `${state.weightKg} kg · activity ${state.activity}_\n\n`
    + `*Maintenance:* ~${formatKcal(result.tdee)} kcal/day\n`
    + `${lossLine}\n`
    + `*Weight gain:* ${formatKcal(result.weightGain[0])}–${formatKcal(result.weightGain[1])} kcal/day`
    + `${floorWarning}\n\n`
    + "Start near the middle of your chosen range and adjust from your results.\n\n"
    + "_These are predictions and may vary with your actual lifestyle and metabolism. "
    + "The best approach is to track your food and morning weight consistently for "
    + "2–3 weeks. If your average weight stays stable, your average calorie intake is "
    + "close to your real TDEE._\n\n"
    + "_This is a predicted estimate, not medical advice. For personalised guidance, "
    + "consult a qualified coach. If you have a medical condition, are under 18, "
    + "pregnant/breastfeeding, take relevant medication, or have a history of disordered "
    + "eating, speak with a doctor or registered dietitian before changing your calories._\n\n"
    + "📘 _Want to plan your own program? DM *\"PDF\"* to Swapnil at "
    + "*@swapnilgore2525* for his detailed 30-page guide._";
}

// --- Turning the result into an actual goal --------------------------------
// The calculator produced the exact numbers the goal prompt asks users to type
// from memory, then threw them away into tdee_profile. Goal-setters return at
// roughly twice the rate of everyone else (51% vs 26% over 2+ days, measured
// 29 Jul), and only ~24% ever set one, so closing this loop is the point of the
// flow — not a nicety at the end of it.
//
// Same rule as the rest of this module: every number here is computed, never
// generated. The LLM has no part in it.

// Protein per kg of bodyweight. Within the ISSN's 1.4–2.0 g/kg band for active
// people, higher in a deficit where protein protects lean mass.
const PROTEIN_G_PER_KG = { maintenance: 1.6, fatLoss: 2.0, weightGain: 1.8 };
// Bodyweight alone gives absurd targets at the extremes (a 150 kg user would be
// told 300 g), because without body-fat data we cannot use lean mass. Cap
// protein's share of the day's calories instead.
const MAX_PROTEIN_CAL_SHARE = 0.35;

function proteinTarget(weightKg, kcal, objective) {
  const perKg = PROTEIN_G_PER_KG[objective] || PROTEIN_G_PER_KG.maintenance;
  const byWeight = Number(weightKg) * perKg;
  const byCalories = (Number(kcal) * MAX_PROTEIN_CAL_SHARE) / 4;
  const grams = Math.min(byWeight, byCalories);
  return Number.isFinite(grams) && grams > 0 ? Math.round(grams / 5) * 5 : null;
}

const midpoint = range => (Array.isArray(range) && range.length === 2
  ? round50((range[0] + range[1]) / 2) : null);

// Which objective the user picked. Null when the message isn't a choice at all,
// so the caller can fall through instead of deadlocking.
function parseGoalChoice(text) {
  const v = String(text || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!v) return null;
  if (/^(skip|no|nope|later|not now|nahi|cancel)$/.test(v)) return "skip";
  if (/\b(fat ?loss|weight ?loss|lose|losing|cut|cutting|deficit|reduce)\b/.test(v)) return "fatLoss";
  if (/\b(weight ?gain|gain|gaining|bulk|bulking|muscle|surplus)\b/.test(v)) return "weightGain";
  if (/\b(maintenance|maintain|maintaining|same|steady|recomp)\b/.test(v)) return "maintenance";
  return null;
}

// Returns { goal_kcal, goal_protein, label } for a chosen objective, or null
// when that objective has no safe target (fat loss below the 1,200 floor).
function goalForObjective(state, objective) {
  const result = calculateTdee(state);
  if (!result) return null;
  let kcal = null;
  let label = null;
  if (objective === "maintenance") { kcal = result.tdee; label = "maintenance"; }
  else if (objective === "fatLoss") { kcal = midpoint(result.fatLoss); label = "fat loss"; }
  else if (objective === "weightGain") { kcal = midpoint(result.weightGain); label = "weight gain"; }
  if (!Number.isFinite(kcal) || kcal <= 0) return null;
  const protein = proteinTarget(state.weightKg, kcal, objective);
  if (!protein) return null;
  return { goal_kcal: kcal, goal_protein: protein, label };
}

function goalOfferLine(result) {
  const options = ["*maintenance*"];
  if (result.fatLoss) options.push("*fat loss*");
  options.push("*weight gain*");
  return "\n\n\u{1F3AF} _Want me to track against one of these? Reply "
    + `${options.join(", ")} — or *skip* and I'll just track totals._`;
}

function goalSetReply(goal) {
  return `\u{1F3AF} Daily goal set: *${goal.goal_kcal.toLocaleString("en-IN")} kcal · `
    + `${goal.goal_protein}g protein* (${goal.label}).\n\n`
    + "I'll show your progress with every meal. Change it anytime — just tell me a new target.";
}

function completedResult(state, now) {
  const result = calculateTdee(state);
  const completed = {
    ...state,
    // Not "complete": the number is useless until it becomes a goal. Park in
    // goal_offer so the next message can be read as the answer.
    phase: "goal_offer",
    invalidAttempts: 0,
    bmr: result.bmr,
    tdee: result.tdee,
    calculatedAt: now.toISOString(),
  };
  return {
    handled: true,
    clear: false,
    state: completed,
    reply: resultReply(completed, result) + goalOfferLine(result),
  };
}

function advanceTdee(text, stored = {}, now = new Date()) {
  let state = normaliseState(stored);
  const explicit = isTdeeRequest(text);

  // Sitting on a fresh result, waiting to hear which target they want.
  if (!explicit && state.phase === "goal_offer") {
    const choice = parseGoalChoice(text);
    const settled = { ...state, phase: "complete" };
    if (choice === "skip") {
      return {
        handled: true, clear: false, state: settled,
        reply: "No problem — I'll just track your totals. Say \"set my goal\" whenever you want one.",
      };
    }
    if (choice) {
      const goal = goalForObjective(state, choice);
      if (goal) {
        // setGoal is applied by the caller; this module stays pure.
        return { handled: true, clear: false, state: settled, setGoal: goal, reply: goalSetReply(goal) };
      }
      return {
        handled: true, clear: false, state: settled,
        reply: "I can't set a safe target for that one. Reply *maintenance* or *weight gain*, "
          + "or tell me a number directly.",
      };
    }
    // Not an answer — almost always a meal. Never hold the conversation
    // hostage over an optional question (PRD: conversations never deadlock).
    return { handled: false, clear: true, state: settled };
  }

  const active = state.phase === "collecting" || state.phase === "confirming";
  if (!explicit && !active) return { handled: false, clear: false, state };

  if (explicit && !active) {
    state = {
      ...state,
      phase: "collecting",
      invalidAttempts: 0,
      confirmedSignature: null,
    };
  }

  if (
    state.phase === "confirming"
    && /^\s*(yes|haan|ha|confirm|correct)\s*$/i.test(text)
  ) {
    state.confirmedSignature = signature(state);
    return completedResult(state, now);
  }
  if (
    state.phase === "collecting"
    && /^\s*(yes|haan|ha)\s*$/i.test(text)
  ) {
    const missing = ["age", "formula", "heightCm", "weightKg", "activity"]
      .filter(field => state[field] == null);
    return {
      handled: true,
      clear: false,
      state,
      reply: missingReply(missing),
    };
  }

  const unitOnly = String(text).trim().toLowerCase()
    .match(/^(kg|kgs|kilograms?|lb|lbs|pounds?)$/);
  let parsed = parseFields(text, state);
  if (unitOnly && state.pendingWeightValue != null) {
    const weightKg = weightToKg(state.pendingWeightValue, unitOnly[1]);
    parsed = {
      patch: weightKg == null || weightKg < 30 || weightKg > 350 ? {} : { weightKg },
      relevant: true,
      error: weightKg == null || weightKg < 30 || weightKg > 350 ? "invalid_weight" : null,
      restricted: null,
      pendingWeightValue: null,
      weightProvided: true,
    };
  }
  if (parsed.restricted) {
    return {
      handled: true,
      clear: false,
      state: emptyState(),
      reply: restrictedReply(parsed.restricted),
    };
  }
  if (parsed.error === "ambiguous_weight") {
    return {
      handled: true,
      clear: false,
      state: {
        ...state,
        ...parsed.patch,
        pendingWeightValue: parsed.pendingWeightValue,
        phase: "collecting",
      },
      reply: INVALID_REPLIES.ambiguous_weight,
    };
  }
  if (parsed.error) {
    return invalidResult(
      parsed.weightProvided ? { ...state, pendingWeightValue: null } : state,
      parsed.error
    );
  }

  const useful = Object.keys(parsed.patch).length > 0;
  if (!explicit && active && !useful) {
    return {
      handled: false,
      clear: true,
      state: { ...state, phase: "inactive" },
    };
  }

  state = {
    ...state,
    ...parsed.patch,
    pendingWeightValue: Object.prototype.hasOwnProperty.call(parsed.patch, "weightKg")
      ? parsed.pendingWeightValue
      : state.pendingWeightValue,
    phase: "collecting",
    invalidAttempts: 0,
  };
  const missing = ["age", "formula", "heightCm", "weightKg", "activity"]
    .filter(field => state[field] == null);
  if (missing.length) {
    return {
      handled: true,
      clear: false,
      state,
      reply: missingReply(missing),
    };
  }

  const reasons = suspiciousReasons(state);
  if (reasons.length && state.confirmedSignature !== signature(state)) {
    return {
      handled: true,
      clear: false,
      state: { ...state, phase: "confirming" },
      reply: confirmationReply(state),
    };
  }
  return completedResult(state, now);
}

// --- Routing decisions ---
// These live here, not inline in server.js, so they can be asserted by
// behaviour. server.js cannot be require()d from a test (it calls app.listen
// at module load), so anything left inline can only be checked by grepping the
// source — which both fails on a harmless rename and passes on dead code.

// What the webhook should do with an advanceTdee() result.
//   "reply"       -> persist state, return the reply, stop
//   "clear"       -> persist the cleared state, then keep routing the message
//   "passthrough" -> TDEE has no claim on this message
function tdeeRouteAction(step) {
  if (!step || typeof step !== "object") return { action: "passthrough", state: null, reply: null, setGoal: null };
  if (step.handled) {
    return { action: "reply", state: step.state || null, reply: step.reply || null, setGoal: step.setGoal || null };
  }
  if (step.clear) return { action: "clear", state: step.state || null, reply: null, setGoal: null };
  return { action: "passthrough", state: null, reply: null, setGoal: null };
}

// Whether a parsed message should enter TDEE via the semantic intent. Must be
// decided before generic query handling, or "how many calories should I eat"
// gets answered as a day-total query. An explicit forced intent or a pending
// corrected-meal prompt always wins — the user is mid-flow elsewhere.
function shouldRouteSemanticTdee(ctx) {
  const { forcedIntent, expectedCorrectedMeal, intent } = ctx || {};
  return !forcedIntent && !expectedCorrectedMeal && intent === "calculate_tdee";
}

module.exports = {
  ACTIVITY,
  emptyState,
  isTdeeRequest,
  calculateTdee,
  parseFields,
  suspiciousReasons,
  normaliseState,
  advanceTdee,
  tdeeRouteAction,
  shouldRouteSemanticTdee,
  parseGoalChoice,
  goalForObjective,
  proteinTarget,
  lbToKg,
  feetToCm,
};
