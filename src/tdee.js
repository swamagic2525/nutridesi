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

function emptyState() {
  return {
    phase: "inactive",
    age: null,
    formula: null,
    heightCm: null,
    weightKg: null,
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
  if (/\b(set|change|update)\b.{0,20}\b(target|goal)\b/.test(s)) return false;
  if (/\bi (?:ate|had|consumed)\b/.test(s)) return false;
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
  const out = { patch: {}, relevant: false, error: null, restricted: null };

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
    const raw = Number(weight[1]);
    const n = /^k/.test(weight[2]) ? Math.round(raw * 10) / 10 : lbToKg(raw);
    if (n < 30 || n > 350) {
      out.error = "invalid_weight";
      return out;
    }
    out.patch.weightKg = n;
  } else if (
    !state.weightKg
    && /\bweight\s*[:=]?\s*-?\d+(?:\.\d+)?\s*$/.test(s)
  ) {
    out.relevant = true;
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

module.exports = {
  ACTIVITY,
  emptyState,
  isTdeeRequest,
  calculateTdee,
  parseFields,
  suspiciousReasons,
  lbToKg,
  feetToCm,
};
