const { randomUUID } = require("crypto");

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
const validDateOnly = value => {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
};

function istDateForTimestamp(now = Date.now()) {
  const timestamp = finiteNumber(now);
  if (timestamp == null) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normaliseConversationState(raw, now = Date.now()) {
  const awaiting = safeGet(raw, "awaiting");
  const expiresAt = safeGet(raw, "expiresAt");
  const candidateBody = safeGet(raw, "candidateBody");
  const nonce = safeGet(raw, "nonce");
  const rawTargetIds = safeGet(raw, "targetLogIds");
  const targetDate = safeGet(raw, "targetDate");
  const timestamp = finiteNumber(now);
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  const nonceValid = typeof nonce === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce);
  const idsValid = Array.isArray(rawTargetIds)
    && rawTargetIds.length > 0
    && rawTargetIds.length <= 20
    && rawTargetIds.every(id => Number.isInteger(id) && id > 0)
    && new Set(rawTargetIds).size === rawTargetIds.length;
  if (
    !["corrected_meal", "repeat_meal_choice"].includes(awaiting)
    || !Number.isFinite(expiry)
    || timestamp == null
    || expiry <= timestamp
    || !validIsoDateTime(expiresAt)
    || !nonceValid
    || !idsValid
    || typeof targetDate !== "string"
    || !validDateOnly(targetDate)
  ) return {};
  const state = {
    awaiting,
    expiresAt: new Date(expiry).toISOString(),
    nonce,
    targetLogIds: [...rawTargetIds],
    targetDate,
  };
  if (awaiting === "repeat_meal_choice" && typeof candidateBody === "string") {
    const candidate = normaliseText(candidateBody).slice(0, 300).trim();
    if (candidate) state.candidateBody = candidate;
  }
  return state;
}

function stateTargetsCurrentIstDate(state, now = Date.now()) {
  const targetDate = safeGet(state, "targetDate");
  return typeof targetDate === "string"
    && validDateOnly(targetDate)
    && targetDate === istDateForTimestamp(now);
}

function isCorrectionCue(text) {
  const raw = normaliseText(text).toLowerCase();
  if (/\?$/.test(raw)) return false;
  const value = raw.replace(/[.!]+$/, "").trim();
  return /^(?:from\s+(?:the\s+)?first(?:\s+one)?|(?:i\s*(?:am|['’]?m|m)|im)\s+(?:just\s+)?(?:telling|saying)(?:\s+you)?\s+(?:from\s+)?(?:the\s+)?first(?:\s+one)?)$/.test(value);
}

function correctionCuePayload(text) {
  const raw = normaliseText(text);
  if (!raw || /\?$/.test(raw)) return null;
  const match = /^(?:from\s+(?:the\s+)?first(?:\s+one)?|(?:i\s*(?:am|['’]?m|m)|im)\s+(?:just\s+)?(?:telling|saying)(?:\s+you)?\s+(?:from\s+)?(?:the\s+)?first(?:\s+one)?)(?:\s*[,;:–—-]\s*|\s+)(.+)$/i.exec(raw);
  if (!match) return null;
  const payload = normaliseText(match[1]).replace(/[.!]+$/, "").trim();
  return payload || null;
}

function isExplicitIndependentMutation(text) {
  const value = normaliseText(text).toLowerCase();
  if (!value || isCorrectionCue(value)) return false;
  return /^(?:undo|delete|remove)\b/.test(value)
    || /^(?:item|no\.?|number|#)?\s*#?\d+\s+(?:was|is|wasn'?t|isn'?t)\s+(?:wrong|incorrect|a mistake|galat|not right|mislogged)\b/.test(value)
    || /^(?:replace|change|swap|update)\b.+\b(?:with|to|for|se|ko)\b.+/.test(value)
    || /\b(?:actually\s+)?i\s+meant\s+\S+|\bactually\s+meant\s+\S+/.test(value)
    || /\b(?:was|is|had|has)\s+\d+(?:\.\d+)?\s*(?:g|ml|kcal|cal(?:ories)?|g\s*(?:protein|prot))\b/.test(value);
}

function needsConversationContext(text, state, now = Date.now()) {
  const value = normaliseText(text).toLowerCase();
  if (!value) return false;
  if (normaliseConversationState(state, now).awaiting === "corrected_meal") return true;
  if (/\b(it|that|this|these|them|same|again|first|earlier|previous|above)\b/.test(value)) return true;
  if (isCorrectionCue(value) || /\b(?:actually\s+)?i\s+meant\b|\bactually\s+meant\b/.test(value)) return true;
  if (/^(?:with|without|add)\b/.test(value) || /\b(?:this|that)\s+much\b/.test(value)) return true;
  if (/^(?:g|grams?|kg|kgs|kilograms?|lb|lbs|pounds?)$/i.test(value)
    || /^(?:\d+(?:\.\d+)?|half|quarter|one|two|three)\s*(?:g|kg|ml|cup|bowl|katori|plate|piece|pieces|serving)s?$/i.test(value)) return true;
  if (/\b(?:rate|review|analyse|analyze|check)\s+(?:this|it|food)\b/.test(value)) return true;
  return /\b(?:morning|breakfast|brkfst|lunch|dinner|snack)\b.*\bwas\b/.test(value);
}

function needsRepeatedMealCheck(text, state, now = Date.now()) {
  const value = normaliseText(text).toLowerCase();
  if (!value) return false;
  if (normaliseConversationState(state, now).awaiting === "repeat_meal_choice") return true;
  return mealTokens(value).length >= 3;
}

function exchangeText(exchange) {
  return normaliseText(safeGet(exchange, "body"));
}

function exchangeReply(exchange) {
  return normaliseText(safeGet(exchange, "reply"));
}

function latestLoggedExchange(exchanges) {
  if (!Array.isArray(exchanges)) return null;
  return [...exchanges].reverse().find(exchange =>
    /^✅\s*Logged\b/.test(exchangeReply(exchange))
  ) || null;
}

function hasRecentLoggedExchange(exchanges) {
  return latestLoggedExchange(exchanges) !== null;
}

function loggedExchangeMatchesBatch(exchange, rows) {
  const rawReply = safeGet(exchange, "reply");
  if (typeof rawReply !== "string" || !Array.isArray(rows) || !rows.length || rows.length > 20) return false;
  const lines = rawReply.replace(/\r\n?/g, "\n").split("\n");
  if (lines.shift().trim() !== "✅ Logged") return false;
  const itemLines = [];
  let reachedSeparator = false;
  for (const line of lines) {
    if (!line.trim()) {
      reachedSeparator = true;
      break;
    }
    itemLines.push(line.trim());
  }
  if (!reachedSeparator || itemLines.length !== rows.length) return false;
  const normaliseName = value => {
    try { return normaliseText(value).normalize("NFKC").toLowerCase(); } catch (_) { return ""; }
  };
  const displayed = [];
  for (const line of itemLines) {
    const match = /^(?:\d+\.\s+)?\*([^*\n]+)\*(?:\s+×(\d+(?:\.\d+)?))?\s+—\s+(\d+(?:\.\d+)?)\s+kcal\b/.exec(line);
    if (!match) return false;
    const name = normaliseName(match[1]);
    const quantity = match[2] == null ? 1 : Number(match[2]);
    const kcal = Number(match[3]);
    if (!name || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(kcal)) return false;
    displayed.push(`${name}|${quantity}|${Math.round(kcal)}`);
  }
  const stored = [];
  for (const row of rows) {
    const name = normaliseName(safeGet(row, "food_name"));
    const rawQuantity = safeGet(row, "quantity");
    const quantity = rawQuantity == null ? 1 : finiteNumber(rawQuantity);
    const kcal = finiteNumber(safeGet(row, "kcal"));
    if (!name || quantity == null || quantity <= 0 || kcal == null) return false;
    stored.push(`${name}|${quantity}|${Math.round(kcal)}`);
  }
  displayed.sort();
  stored.sort();
  return displayed.every((signature, index) => signature === stored[index]);
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
  if (!hasMedia(latest)) return false;
  const value = normaliseText(text);
  const explicitInspection = /\b(?:photo|image|picture|screenshot|media)\b.*\b(?:read|inspect|identify|recognise|recognize|analyse|analyze|check|what)\b|\b(?:read|inspect|identify|recognise|recognize|analyse|analyze|check|what)\b.*\b(?:photo|image|picture|screenshot|media)\b/i.test(value);
  if (explicitInspection) return true;
  return !exchangeText(latest)
    && /\b(this|that|it|these|them|above|photo|image|picture|media)\b/i.test(value);
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

function repeatMealCandidateBody(state, exchanges) {
  const stored = safeGet(state, "candidateBody");
  if (safeGet(state, "awaiting") === "repeat_meal_choice" && typeof stored === "string") {
    const candidate = normaliseText(stored).slice(0, 300).trim();
    if (candidate) return candidate;
  }
  const entries = Array.isArray(exchanges) ? exchanges : [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const askedChoice = /\breply\s+\*?["']?correction["']?\*?\s+or\s+\*?["']?new meal["']?\*?[.!]?$/i
      .test(exchangeReply(entry));
    const body = exchangeText(entry);
    if (askedChoice && body && repeatedMealCandidate(body, entries.slice(0, index))) return body;
  }
  return null;
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

async function persistConversationState({
  phone,
  awaiting,
  targetRows,
  loggedExchange,
  candidateBody,
  now = Date.now(),
  save,
  nonceFactory = randomUUID,
}) {
  if (typeof save !== "function" || typeof nonceFactory !== "function") return null;
  if (!Array.isArray(targetRows) || !targetRows.length || targetRows.length > 20) return null;
  if (!loggedExchangeMatchesBatch(loggedExchange, targetRows)) return null;
  const targetLogIds = targetRows.map(row => safeGet(row, "id"));
  if (
    !targetLogIds.every(id => Number.isInteger(id) && id > 0)
    || new Set(targetLogIds).size !== targetLogIds.length
  ) return null;
  const targetDates = [...new Set(targetRows.map(row => safeGet(row, "date")))];
  if (targetDates.length !== 1 || typeof targetDates[0] !== "string" || !validDateOnly(targetDates[0])) return null;
  let nonce;
  try { nonce = nonceFactory(); } catch (_) { return null; }
  const state = normaliseConversationState({
    awaiting,
    expiresAt: new Date(Number(now) + WINDOW_MS).toISOString(),
    nonce,
    targetLogIds,
    targetDate: targetDates[0],
    ...(awaiting === "repeat_meal_choice" ? { candidateBody } : {}),
  }, now);
  if (!Object.keys(state).length) return null;
  try {
    return await save(phone, state) === true ? state : null;
  } catch (_) {
    return null;
  }
}

async function executeClaimedAction({ phone, nonce, claim, action }) {
  if (typeof claim !== "function" || typeof action !== "function") {
    return { claimed: false, value: null };
  }
  let claimed;
  try { claimed = await claim(phone, nonce); } catch (_) { claimed = false; }
  if (claimed !== true) return { claimed: false, value: null };
  return { claimed: true, value: await action() };
}

module.exports = {
  WINDOW_MS,
  MAX_EXCHANGES,
  normaliseConversationState,
  istDateForTimestamp,
  stateTargetsCurrentIstDate,
  needsConversationContext,
  needsRepeatedMealCheck,
  formatConversationContext,
  refersToRecentMedia,
  isCorrectionCue,
  correctionCuePayload,
  hasRecentLoggedExchange,
  latestLoggedExchange,
  loggedExchangeMatchesBatch,
  isExplicitIndependentMutation,
  repeatedMealCandidate,
  repeatMealCandidateBody,
  resolvePendingChoice,
  contextualProteinGoalReply,
  persistConversationState,
  executeClaimedAction,
};
