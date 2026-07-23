const WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_EXCHANGES = 10;
const CONTEXT_BEGIN = "BEGIN APP-PROVIDED RECENT CONVERSATION";
const CONTEXT_END = "END APP-PROVIDED RECENT CONVERSATION";

const normaliseText = value => {
  try { return String(value || "").replace(/\s+/g, " ").trim(); } catch (_) { return ""; }
};
const words = value => normaliseText(value).toLowerCase().match(/[a-z0-9]+/g) || [];
const safeGet = (value, key) => {
  try { return value && typeof value === "object" ? value[key] : undefined; } catch (_) { return undefined; }
};
const finiteNumber = value => {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  } catch (_) { return null; }
};
const isLeapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const validIsoDateTime = value => {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= days[month - 1]
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59;
};

function normaliseConversationState(raw, now = Date.now()) {
  const awaiting = safeGet(raw, "awaiting");
  const expiresAt = safeGet(raw, "expiresAt");
  const timestamp = finiteNumber(now);
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (
    !["corrected_meal", "repeat_meal_choice"].includes(awaiting)
    || !Number.isFinite(expiry)
    || timestamp == null
    || expiry <= timestamp
    || !validIsoDateTime(expiresAt)
  ) return {};
  return { awaiting, expiresAt: new Date(expiry).toISOString() };
}

function isCorrectionCue(text) {
  const raw = normaliseText(text).toLowerCase();
  if (/\?$/.test(raw)) return false;
  const value = raw.replace(/[.!]+$/, "").trim();
  const correction = /\b(?:correction|corrected|correct|fix|replace)\b/.test(value);
  const newMeal = /\b(?:new|another)\s+meal\b|\blog\s+(?:a\s+)?(?:new|another)\b/.test(value);
  const negated = /\b(?:don'?t|do not|not|no)\b.{0,20}\b(?:correction|corrected|correct|fix|replace)\b/.test(value);
  if (negated || (correction && newMeal)) return false;
  return /\b(?:actually\s+)?i\s+meant\b|\bactually\s+meant\b|\bcorrection\s*[:,-]|\b(?:please\s+)?(?:correct|fix|replace)\s+(?:this|it|the\s+first(?:\s+one)?)\b/.test(value)
    || /\b(?:i\s*['’]?m|im|i am)\s+(?:just\s+)?(?:telling|saying)(?:\s+you)?\b.*\b(?:first|earlier)\b/.test(value);
}

function needsConversationContext(text, state, now = Date.now()) {
  const value = normaliseText(text).toLowerCase();
  if (!value) return false;
  if (Object.keys(normaliseConversationState(state, now)).length) return true;
  if (/\b(it|that|this|these|them|same|again|first|earlier|previous|above)\b/.test(value)) return true;
  if (isCorrectionCue(value) || /\bfrom\s+(?:the\s+)?first\b/.test(value)) return true;
  if (/^(?:with|without|add)\b/.test(value) || /\b(?:this|that)\s+much\b/.test(value)) return true;
  if (/^(?:g|grams?|kg|kgs|kilograms?|lb|lbs|pounds?)$/i.test(value)
    || /^(?:\d+(?:\.\d+)?|half|quarter|one|two|three)\s*(?:g|kg|ml|cup|bowl|katori|plate|piece|pieces|serving)s?$/i.test(value)) return true;
  if (/\b(?:rate|review|analyse|analyze|check)\s+(?:this|it|food)\b/.test(value)) return true;
  return words(value).length >= 2
    && /\b(?:morning|breakfast|brkfst|lunch|dinner|snack)\b/.test(value);
}

function exchangeText(exchange) {
  return normaliseText(safeGet(exchange, "body"));
}

function exchangeReply(exchange) {
  return normaliseText(safeGet(exchange, "reply"));
}

function hasMedia(exchange) {
  return safeGet(exchange, "media") === true;
}

function quotedHistoryText(value, limit) {
  return normaliseText(value)
    .replace(/CURRENT USER MESSAGE:/gi, "CURRENT USER MESSAGE (quoted)")
    .replace(new RegExp(CONTEXT_BEGIN, "gi"), "[quoted historical boundary text]")
    .replace(new RegExp(CONTEXT_END, "gi"), "[quoted historical boundary text]")
    .slice(0, limit);
}

function historyRecord(role, text) {
  let value = text;
  let encoded = JSON.stringify({ role, text: value });
  while (encoded.length > 540 && value.length) {
    value = value.slice(0, -1);
    encoded = JSON.stringify({ role, text: value });
  }
  return encoded;
}

function formatConversationContext(exchanges) {
  const latest = Array.isArray(exchanges) ? exchanges.slice(-MAX_EXCHANGES) : [];
  if (!latest.length) return "";
  const lines = [CONTEXT_BEGIN];
  for (const exchange of latest) {
    const inbound = exchangeText(exchange);
    const reply = exchangeReply(exchange);
    lines.push(historyRecord("user", quotedHistoryText(inbound || (hasMedia(exchange) ? "[media without text]" : ""), 300)));
    lines.push(historyRecord("assistant", quotedHistoryText(reply, 500)));
  }
  lines.push(CONTEXT_END);
  return lines.join("\n");
}

function refersToRecentMedia(text, exchanges) {
  const latest = Array.isArray(exchanges) && exchanges.length ? exchanges[exchanges.length - 1] : null;
  return hasMedia(latest)
    && /\b(this|that|it|these|them|above|photo|image|picture|media)\b/i.test(normaliseText(text));
}

const MEAL_STOPWORDS = new Set([
  "i", "ate", "had", "have", "my", "meal", "food", "for", "the", "a", "an", "and", "with", "of",
  "is", "was", "today", "morning", "breakfast", "brkfst", "lunch", "dinner", "snack", "log", "logged",
  "please", "again", "same", "one", "two", "three", "this", "that", "it", "in", "on", "at", "to",
]);

function mealTokens(text) {
  return [...new Set(words(text).filter(token => !MEAL_STOPWORDS.has(token) && !/^\d+$/.test(token)))];
}

function repeatedMealCandidate(text, exchanges) {
  const current = mealTokens(text);
  const entries = Array.isArray(exchanges) ? exchanges : [];
  const previous = [...entries].reverse().find(entry => /^✅\s*logged\b/i.test(exchangeReply(entry)));
  if (!previous) return false;
  const prior = mealTokens(exchangeText(previous));
  if (current.length < 3 || prior.length < 3) return false;
  const priorSet = new Set(prior);
  const overlap = current.filter(token => priorSet.has(token)).length;
  const shorter = Math.min(current.length, prior.length);
  const longer = Math.max(current.length, prior.length);
  const union = new Set([...current, ...prior]).size;
  return overlap >= 3
    && overlap / shorter >= 0.7
    && overlap / union >= 0.7
    && longer / shorter <= 1.5;
}

function resolvePendingChoice(text, state, now = Date.now()) {
  const active = normaliseConversationState(state, now);
  if (active.awaiting !== "repeat_meal_choice") return null;
  const raw = normaliseText(text).toLowerCase();
  if (/\?$/.test(raw)) return null;
  const value = raw.replace(/[.!]+$/, "").trim();
  const correctionCue = /\b(?:correction|correct|fix|replace|first\s+one)\b/.test(value);
  const newCue = /\b(?:new|another)\s+meal\b|\blog\s+(?:a\s+)?(?:new|another)\b/.test(value);
  const negated = /\b(?:don'?t|do not|not|no)\b.{0,20}\b(?:correction|correct|fix|replace|new|another)\b/.test(value);
  if (negated || (correctionCue && newCue)) return null;
  if (/^(?:please\s+)?(?:correction|correct(?:\s+(?:the\s+)?first(?:\s+one)?|\s+(?:this|it))?|fix(?:\s+(?:this|it))?|replace(?:\s+(?:this|it))?|first\s+one)$/.test(value)) return "correction";
  if (/^(?:please\s+)?(?:new|another)\s+meal$|^log\s+(?:a\s+)?(?:new|another)\s+meal$/.test(value)) return "new";
  return null;
}

function contextualProteinGoalReply(text, profile) {
  const value = normaliseText(text).toLowerCase();
  const kcal = finiteNumber(safeGet(profile, "goal_kcal") ?? safeGet(profile, "calorie_goal") ?? safeGet(profile, "calorieGoal"));
  const protein = finiteNumber(safeGet(profile, "goal_protein") ?? safeGet(profile, "protein_goal") ?? safeGet(profile, "proteinGoal"));
  if (!Number.isFinite(kcal) || kcal <= 0 || (Number.isFinite(protein) && protein > 0)) return null;
  if (!/\bprotein\b/.test(value) || !/\b(this|that|goal|calories?|kcal)\b/.test(value)) return null;
  return `For your ${Math.round(kcal).toLocaleString("en-IN")} kcal goal, tell me your weight in kg and whether you're aiming for fat loss or maintenance, and I'll set a protein target.`;
}

module.exports = {
  WINDOW_MS,
  MAX_EXCHANGES,
  normaliseConversationState,
  needsConversationContext,
  formatConversationContext,
  refersToRecentMedia,
  isCorrectionCue,
  repeatedMealCandidate,
  resolvePendingChoice,
  contextualProteinGoalReply,
};
