// NutriDesi — WhatsApp food-tracking bot.
// Supports two transports: Twilio Sandbox (legacy) and Meta Cloud API (WABA).
// Both share the same handler → parser → DB → reply pipeline.

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { parseMeal } = require("./src/parser.js");
const { advanceTdee, tdeeRouteAction, shouldRouteSemanticTdee } = require("./src/tdee.js");
const { loadMetrics } = require("./src/metrics.js");
const { metricsPage } = require("./src/metricsPage.js");
const { supabase, logMeal, deleteLastLog, deleteAllToday, deleteBySeq, itemsBySeq, todayItems, todaySeqs, deleteMatchingLastLog, lastLogTargets, lastLogBatch, logRowsByExactIds, deleteLogRowsByExactIds, todayTotal, ensureUser, getProfile, saveProfile, saveTdeeProfile, saveConversationState, claimConversationState, clearConversationStateIfUnchanged, recentConversation, bumpNudge, resolveRows, dayReport, setSummaryTime, correctionMemories, forgetCorrection, replaceMealAtomic, rowsBySeq, matchLastLogTargets } = require("./src/db.js");
const { looksLikeCorrection, shouldPromoteToReplace, isExplicitAddition, formatLastLogContext } = require("./src/correctionContext.js");
const {
  WINDOW_MS,
  normaliseConversationState,
  needsConversationContext,
  needsRepeatedMealCheck,
  formatConversationContext,
  refersToRecentMedia,
  isCorrectionCue,
  correctionCuePayload,
  latestLoggedExchange,
  loggedExchangeMatchesBatch,
  correlatedTargetFromExchange,
  stateTargetsCurrentIstDate,
  isExplicitIndependentMutation,
  repeatedMealCandidate,
  repeatMealCandidateBody,
  resolvePendingChoice,
  contextualProteinGoalReply,
  persistConversationState,
  executeClaimedAction,
} = require("./src/conversationMemory.js");
const { validateSignature, extractMessages, sendMessage, markRead } = require("./src/meta.js");
const { logCorrectionEvent } = require("./src/correctionLogger.js");
const { parseReminderRequest, confirmSetReply, CONFIRM_OFF_REPLY } = require("./src/reminders.js");
const { parseForgetRequest, findForgetTarget, memoryNote } = require("./src/correctionMemory.js");

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded

// Meta webhook needs JSON with raw body preserved for signature validation.
app.use("/meta-whatsapp", express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Same pattern for Netlify's outgoing form-notification webhook (JWS-signed).
app.use("/netlify-waitlist", express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ---------------------------------------------------------------------------
// Metrics dashboard (unchanged)
// ---------------------------------------------------------------------------

function metricsAuth(req, res, next) {
  const expectedUser = process.env.METRICS_USER;
  const expectedPassword = process.env.METRICS_PASSWORD;
  const fail = () => {
    res.set("WWW-Authenticate", 'Basic realm="NutriDesi Metrics"');
    return res.status(401).send("Authentication required.");
  };
  if (!expectedUser || !expectedPassword) return res.status(503).send("Metrics authentication is not configured.");
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return fail();
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return fail();
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (user !== expectedUser || password !== expectedPassword) return fail();
  return next();
}

const METRICS_CACHE_MS = 60 * 1000;
let metricsCache = { value: null, at: 0, pending: null };
async function currentMetrics() {
  if (metricsCache.value && Date.now() - metricsCache.at < METRICS_CACHE_MS) return metricsCache.value;
  if (!metricsCache.pending) {
    metricsCache.pending = loadMetrics()
      .then(value => { metricsCache.value = value; metricsCache.at = Date.now(); return value; })
      .finally(() => { metricsCache.pending = null; });
  }
  return metricsCache.pending;
}

app.get("/metrics", metricsAuth, (_req, res) => res.type("html").send(metricsPage()));
app.get("/metrics/data", metricsAuth, async (_req, res) => {
  // recent rides outside the 60s cache so the conversation feed is always live
  res.set("Cache-Control", "no-store"); // a browser-cached payload looks like a frozen dashboard
  try {
    const convos = await recentConversations();
    return res.json({ ...(await currentMetrics()), recent: convos.rows, lastMessageAt: convos.lastMessageAt });
  }
  catch (error) {
    console.error("metrics error:", error.message);
    return res.status(503).json({ error: "Metrics are temporarily unavailable. Check dashboard configuration." });
  }
});

app.get("/", (_req, res) => res.send("NutriDesi is running."));

const LOG_FILE = path.join(process.env.HOME, "Library/Logs/nutridesi.log");
app.get("/logs", metricsAuth, (req, res) => {
  const lines = parseInt(req.query.lines) || 150;
  let content;
  try {
    const buf = fs.readFileSync(LOG_FILE, "utf8");
    content = buf.split("\n").slice(-lines).join("\n");
  } catch (e) { content = "Could not read log: " + e.message; }
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NutriDesi Logs</title>
<style>body{margin:0;background:#0d1210;color:#c9d6ce;font:12px/1.5 monospace;padding:12px}pre{white-space:pre-wrap;word-break:break-all}
.bar{position:sticky;top:0;background:#151d19;padding:8px 12px;border-bottom:1px solid #29362f;display:flex;gap:12px;align-items:center}
a,button{color:#72dc9a;background:none;border:1px solid #72dc9a;border-radius:6px;padding:4px 10px;cursor:pointer;text-decoration:none;font:inherit}
</style></head><body>
<div class="bar"><b>nutridesi.log</b> <span style="color:#9baca2">last ${lines} lines</span>
<a href="/logs?lines=300">300</a><a href="/logs?lines=500">500</a><button onclick="location.reload()">Refresh</button><a href="/metrics">Dashboard</a></div>
<pre>${content.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>
<script>window.scrollTo(0,document.body.scrollHeight);</script>
</body></html>`);
});

// ---------------------------------------------------------------------------
// Shared state & helpers
// ---------------------------------------------------------------------------

const RATE = { perHour: 25, perDay: 60, maxLen: 1200 };
// Ranks 1..FOUNDING_SPOTS hold the free-for-life promise (made 2026-07-19).
// Signups past it are still recorded — this only labels them.
const FOUNDING_SPOTS = 50;

// --- Duplicate-message guard -----------------------------------------------
// A resend — Twilio webhook retry, a double-tap, impatience on a slow reply —
// used to be logged a second time, silently doubling the day's total. Measured
// 29 Jul: 12 duplicate rows across 12 users (~9% of the base), 2,326 phantom
// kcal. The same identical text also tripped the correction path into
// "couldn't safely connect" aborts. Nobody eats the same meal twice inside a
// minute; an exact repeat that soon is a resend.
//
// Deliberately narrow, because repeats are legitimate in conversation — "yes",
// "3", "kg" recur as answers to different prompts, and replaying a stale answer
// would be its own bug. So this only short-circuits when the earlier identical
// message produced a SUCCESSFUL LOG, which is the case that corrupts data.
// Everything else falls through and is handled normally.
const DUP_WINDOW_MS = 90 * 1000;
const LOGGED_REPLY = /^✅\s*logged\b/i; // same marker repeatedMealCandidate uses
const recentBodies = new Map(); // `${phone}|${normalised}` -> { at, reply }

const dupKey = (phone, body) =>
  `${phone}|${String(body || "").replace(/\s+/g, " ").trim().toLowerCase()}`;

function duplicateReplay(phone, body, now = Date.now()) {
  const key = dupKey(phone, body);
  const seen = recentBodies.get(key);
  if (!seen || now - seen.at >= DUP_WINDOW_MS) return null;
  if (!LOGGED_REPLY.test(String(seen.reply || ""))) return null;
  // Replay the original reply verbatim under a note. The unchanged day total
  // inside it is the proof nothing was added.
  return `\u{21A9}\u{FE0F} _Same message again — already logged, nothing added._\n\n${seen.reply}`;
}

function rememberBody(phone, body, reply, now = Date.now()) {
  const text = String(body || "").trim();
  if (!text) return;
  recentBodies.set(dupKey(phone, body), { at: now, reply });
  if (recentBodies.size > 500) {
    for (const [k, v] of recentBodies) {
      if (now - v.at >= DUP_WINDOW_MS) recentBodies.delete(k);
    }
  }
}

// Idempotent wrapper both transports call instead of handleMessage directly.
// Media needs no special case: a caption-less photo has an empty body, which
// rememberBody never stores, so two photos in a row can't collide. A *captioned*
// photo resent within the window is a genuine duplicate and should be caught
// like any other.
async function handleMessageOnce(from, body, opts = {}) {
  const replay = duplicateReplay(from, body);
  if (replay) {
    console.log(`dedup: replayed reply for ${maskPhone(from)} (identical within ${DUP_WINDOW_MS / 1000}s)`);
    return replay;
  }
  const reply = await handleMessage(from, body, opts);
  rememberBody(from, body, reply);
  return reply;
}
const usage = new Map();
function rateLimitCheck(phone) {
  const now = Date.now();
  const day = (usage.get(phone) || []).filter(t => now - t < 24 * 60 * 60 * 1000);
  usage.set(phone, day);
  if (day.length >= RATE.perDay) return "day";
  const hour = day.filter(t => now - t < 60 * 60 * 1000);
  if (hour.length >= RATE.perHour) return "hour";
  day.push(now);
  return null;
}

const seenMsgIds = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (seenMsgIds.has(msgId)) return true;
  seenMsgIds.add(msgId);
  if (seenMsgIds.size > 2000) seenMsgIds.delete(seenMsgIds.values().next().value);
  return false;
}

const pendingQuery = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

const WELCOME =
  "\u{1F64F} Hey! Thanks for being an early tester of NutriDesi. No app, no signup — I work right here.\n\n" +
  "\u{1F37D}️ *Eat something?* Text it: \"2 roti and dal\" · \"100g rice, 200g chicken\" · \"1 scoop whey\"\n" +
  "\u{1F50D} *Deciding?* Ask first: \"calories of 2 samosa?\" — I answer without logging\n" +
  "\u{1F4CA} *Curious?* \"how much have I eaten today?\"\n" +
  "↩️ *Mistake?* \"undo\", or correct me: \"that dosa was 120 calories\"\n\n" +
  "I reply with calories + protein/carbs/fat/fibre and your day's total.\n\n" +
  "— Swapnil \u{1F44B} full-time PM & ex-fitness coach. My clients kept quitting tracking apps, so I " +
  "built this where you already are. Bigger version in ~30 days — feedback shapes it: " +
  "DM @swapnilgore2525 on Instagram, I read everything.";

// Recent conversations for the founder dashboard: persisted to Supabase
// message_log (24 h window survives restarts); the in-memory ring buffer is the
// fallback until the table exists. Phones masked in the UI, test numbers
// excluded, served only behind metrics basic auth.
const RECENT_MAX = 50;
const recentExchanges = [];
let msgLogTableMissing = false;
const maskPhone = (p) => String(p || "").replace(/^(\+\d{2})\d+(\d{4})$/, "$1••••••$2");
// Signup names are real people. The full name belongs in the DB row, never in a
// log line — logs get tailed, pasted into issues, and this repo is public.
const maskName = (n) => {
  const initials = String(n || "").trim().split(/\s+/).filter(Boolean)
    .map(w => w[0].toUpperCase()).join(".");
  return initials ? `${initials}.` : "(no name)";
};
// An unclassified contact still has to be debuggable (2026-07-20: a signup left
// no trace anywhere), but it's an email or phone — log its shape, not its value.
const maskContact = (c) => {
  const s = String(c || "").trim();
  return s ? `${s.slice(0, 3)}•••(${s.length})` : "(empty)";
};

// Strict target resolution for a name-based "replace X with…": match X's words
// against today's item names, alpha tokens only (so "250g" is ignored). Returns
// the single best row, or null when nothing overlaps OR two rows tie — an
// ambiguous or absent target must change nothing rather than delete a guess.
function resolveTargetByName(items, targetName) {
  const words = (s) => String(s || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
  const tw = words(targetName);
  if (!tw.length) return null;
  let best = null, bestScore = 0, tie = false;
  for (const it of items || []) {
    const nw = words(it.food_name);
    const score = tw.filter(w => nw.includes(w)).length;
    if (score > bestScore) { best = it; bestScore = score; tie = false; }
    else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore > 0 && !tie ? best : null;
}
function recordExchange(from, inbound, reply, media = false) {
  // Same rule as metrics isTestPhone, plus +91-prefixed all-zero throwaways.
  if (/^\+000|^\+910{5,}/.test(String(from))) return;
  recentExchanges.unshift({
    at: new Date().toISOString(), user: maskPhone(from),
    in: String(inbound || "(media)").slice(0, 160), out: String(reply || "").slice(0, 400),
  });
  if (recentExchanges.length > RECENT_MAX) recentExchanges.pop();
  supabase.from("message_log").insert([{
    phone_number: from, body: String(inbound || "").slice(0, 500),
    reply: String(reply || "").slice(0, 1500), media,
  }]).then(({ error }) => {
    if (error && !msgLogTableMissing) {
      msgLogTableMissing = true;
      console.error("message_log insert failed (run message-log.sql?):", error.message);
    }
  });
}
async function recentConversations() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from("message_log")
    .select("phone_number, body, reply, at")
    .gte("at", since).order("at", { ascending: false }).limit(200);
  if (error || !data) return { rows: recentExchanges, lastMessageAt: recentExchanges[0]?.at || null };
  const rows = data
    .filter(r => !/^\+000|^\+910{5,}/.test(r.phone_number))
    .map(r => ({ at: r.at, user: maskPhone(r.phone_number), in: r.body || "(media)", out: r.reply || "" }));
  return { rows, lastMessageAt: rows[0]?.at || null };
}

const MEDIA_REPLY =
  "\u{1F4F8} I can't read photos, screenshots or voice notes yet — I'm text-first, that's what keeps me fast.\n\n" +
  "Just type what you ate — *\"2 roti, dal, chicken curry\"* — and I'll log it with calories + protein in seconds.";
const RECENT_MEDIA_REPLY =
  "\u{1F4F8} I can't inspect the photo yet. Type the food name, or send the calories and protein from its nutrition label.";
const REPEAT_CHOICE_PROMPT =
  "That looks like your recent meal. Reply correction or new meal.";

// The reminder line sits here, on the first log, because that is where the
// retention window opens: 74.5% of returns happen the next day and 87.6%
// within two, and most users never reach a second day at all. An opt-in
// feature nobody is told about has an opt-in rate of zero. It goes ahead of
// the feedback ask because it is worth more to the user than to us.
const FIRST_LOG_FOOTER =
  "\n\n\u{1F64F} _First log — thanks for testing NutriDesi early! Reply \"undo\" to remove a mistake, " +
  "or correct me anytime (\"that dosa was 120 calories\"). Want a nightly recap? Say \"remind me at 9pm\". " +
  "Feedback? DM @swapnilgore2525 on Instagram — " +
  "I read everything. — Swapnil (PM & ex-fitness coach)_";

function dayLine(t, profile) {
  const k = Math.round(t.kcal), p = Math.round(t.protein);
  if (!profile.hasGoal) return `*You're at ${k} kcal · ${p}g protein today*`;
  const gk = profile.goal_kcal, gp = profile.goal_protein;
  const pLeft = Math.max(0, gp - p);
  const who = profile.name ? `, ${profile.name}` : "";
  let tail;
  if (k > gk) {
    const over = k - gk;
    tail = pLeft > 0
      ? `_${over} kcal past target, and ${pLeft}g protein short${who} — tread carefully ⚠️_`
      : `_${over} kcal past your target${who} — tread carefully ⚠️_`;
  } else {
    const kLeft = gk - k;
    tail = `_${kLeft} kcal, ${pLeft}g protein left today${who} \u{1F4AA}_`;
  }
  return `\u{1F525} *${k} / ${gk} kcal · ${p} / ${gp}g protein*\n${tail}`;
}

function cfLine(t) {
  return `Carbs ${Math.round(t.carbs)}g · Fat ${Math.round(t.fat)}g · Fibre ${Math.round(t.fiber || 0)}g`;
}

function fmtItems(rows) {
  return rows.map(r => {
    const qty = r.quantity === 1 ? "" : ` ×${r.quantity}`;
    const p = (r.matched_db_id || r.protein > 0) ? ` · ${Math.round(r.protein)}g protein` : "";
    const note = r.portionNote ? ` (${r.portionNote})` : "";
    const n = r.day_seq != null ? `${r.day_seq}. ` : "";
    return `${n}*${r.food_name}*${qty} — ${r.kcal} kcal${p}${note}`;
  });
}

function assumptionLines(rows) {
  const guesses = rows.filter(r => r.assumed && r.userSaid
    // A DB match whose name already covers what the user said needs no confession.
    && !(r.matched_db_id && r.food_name.toLowerCase().includes(String(r.userSaid).toLowerCase())));
  const lines = guesses.slice(0, 2).map(r =>
    r.rerankMatched
      ? `\u{1F50E} _"${r.userSaid}" — matched *${r.food_name}*. Not it? Just reply "it was …"_`
      : r.matched_db_id
        ? `\u{1F914} _"${r.userSaid}" — logged the closest match, *${r.food_name}*. Something else? Just reply "it was …"_`
        : r.refVerified
          ? `\u{1F52C} _"${r.userSaid}" isn't in my quick list — logged *${r.food_name}* from a lab-verified recipe database. Something else? Just reply "it was …"_`
          : `\u{1F914} _"${r.userSaid}" isn't in my book yet — logged my best estimate. Know the calories? Reply "it was 200 calories"_`);
  if (guesses.length > 2) lines.push(`_…and ${guesses.length - 2} more guesses in the list below_`);
  return lines;
}

// ---------------------------------------------------------------------------
// Core message handler — transport-agnostic, returns the reply string.
// ---------------------------------------------------------------------------

async function handleMessage(from, body, opts = {}) {
  // Photo / screenshot / voice note with no caption: deterministic answer, no
  // LLM call. A caption ("2 roti" under a food pic) is processed as normal text.
  if (opts.media && !String(body || "").trim()) {
    return MEDIA_REPLY;
  }
  // A copied NutriDesi receipt is conversation context, not another meal. Do
  // not feed its listed foods back through the parser and duplicate the day.
  if (/^\s*✅\s*Logged\b/i.test(String(body || ""))) {
    return "I can see the earlier log. Send only what you want me to add or change — for example, ‘add one 20g protein shake’. Nothing was changed.";
  }
  if (body.length > RATE.maxLen) {
    return "I couldn't safely read the full pasted message. Send just your last instruction — for example, ‘add one 20g protein shake’. Nothing was changed.";
  }
  const limited = rateLimitCheck(from);
  if (limited) {
    return limited === "hour"
      ? "Whoa, that's a lot of messages! Take a short break — I'll be here in an hour \u{1F642}"
      : "You've hit today's message limit. Logging resumes tomorrow \u{1F319}";
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return "What did you eat? Send me a food name and I'll log it \u{1F642}";
  }
  const isJoin = /^join\b/i.test(trimmed);
  const isGreeting = /^(hi+|hello+|hey+|namaste|hola|start|yo)[\s!.\u{1F44B}\u{1F64F}]*$/iu.test(trimmed);
  // Capability questions in any common phrasing — never worth an LLM call.
  const isHelp = /^(help|menu|commands|features|info|instructions)\b[\s!?.]*$/i.test(trimmed)
    || /\b(what (can|all can|do) (you|u) do|how (does|do) (this|it|you|u) work|how (to|do i) (use|log)|what is (this|nutridesi)|who are (you|u)|kaise (use|kaam|chalta)|kya (kar sakte|karta hai))\b/i.test(trimmed);
  if (isJoin || isGreeting || isHelp) {
    const isNew = await ensureUser(from);
    return (isNew || isJoin || isHelp)
      ? WELCOME
      : "Hey! \u{1F44B} Just tell me what you ate — e.g. \"2 roti and dal\" — and I'll log it.";
  }
  // "Can I send a screenshot / photo / voice note?" — asked in text form.
  if (/\b(screenshot|photo|pic|picture|image|voice note|voice message|audio|video)s?\b/i.test(trimmed)
    && /\b(can|could|kya|how|send|bhej|bheju|bhejun|share|upload|attach|read|scan)\b/i.test(trimmed)) {
    return MEDIA_REPLY;
  }
  // Bare acknowledgements ("thanks", "ok", "nice") — don't ask them what they ate.
  if (/^(thanks+|thank (you|u)|thanku|thnx|thx|tysm|ty|ok+|okay+|great|nice|cool|super|awesome|perfect|got it|shukriya|dhanyawad|\u{1F44D}|\u{1F64F}|❤️)[\s!.\u{1F44D}\u{1F64F}❤️]*$/iu.test(trimmed)) {
    return "\u{1F64C} Anytime! Text me your next meal whenever you eat.";
  }

  const profile = await getProfile(from);

  // Runs before correction/parseMeal routing: a bare "3" mid-collection is an
  // activity level, not a food. Decision logic is in tdee.js so it is testable.
  const tdeeRoute = tdeeRouteAction(advanceTdee(trimmed, profile.tdee_profile || {}));
  if (tdeeRoute.action === "reply") {
    await saveTdeeProfile(from, tdeeRoute.state);
    // The calculator worked out a target and the user accepted it. Persist it
    // as their actual goal — otherwise the number is computed, shown, and lost,
    // which is what used to happen.
    if (tdeeRoute.setGoal) {
      await saveProfile(from, {
        goal_kcal: tdeeRoute.setGoal.goal_kcal,
        goal_protein: tdeeRoute.setGoal.goal_protein,
      });
    }
    return tdeeRoute.reply;
  }
  if (tdeeRoute.action === "clear") {
    await saveTdeeProfile(from, tdeeRoute.state);
  }

  // Opt-in / opt-out for the daily summary. Deterministic, and ahead of the
  // parser so "remind me at 9pm" is never read as a meal.
  // "forget yogabar oats" — remove a remembered correction. Ahead of the parser
  // so it is never read as a meal, and a memory the user cannot remove would be
  // worse than the repetition it fixes.
  const forgetReq = parseForgetRequest(trimmed);
  if (forgetReq) {
    const mems = await correctionMemories(from);
    const { match, ambiguous, candidates } = findForgetTarget(mems, forgetReq.key);
    if (match) {
      await forgetCorrection(from, match.food_key);
      return `\u{1F9E0} Forgotten — I'll use my own numbers for *${match.food_name}* again.`;
    }
    if (ambiguous) {
      return `Which one? ${candidates.slice(0, 3).map(c => `*${c.food_name}*`).join(", ")}`;
    }
    if (mems.length) {
      return `I don't have a saved correction for that. Saved: ${mems.slice(0, 3).map(m => `*${m.food_name}*`).join(", ")}.`;
    }
    // No saved corrections at all: "forget the dal" means delete the entry, so
    // fall through to the undo path. Safe because the `forget X` instruction is
    // only ever shown alongside a memory that exists — if the user was told to
    // type it, the branch above will have caught it.
  }

  const reminderReq = parseReminderRequest(trimmed);
  if (reminderReq) {
    if (reminderReq.action === "off") {
      await setSummaryTime(from, null);
      return CONFIRM_OFF_REPLY;
    }
    await setSummaryTime(from, reminderReq.time);
    return confirmSetReply(reminderReq.time);
  }

  const now = Date.now();
  const rawConversationState = profile.conversation_state;
  let conversationState = normaliseConversationState(rawConversationState, now);
  if (
    rawConversationState
    && typeof rawConversationState === "object"
    && Object.keys(rawConversationState).length
    && !Object.keys(conversationState).length
  ) {
    await clearConversationStateIfUnchanged(from, rawConversationState);
  }
  if (conversationState.awaiting && !stateTargetsCurrentIstDate(conversationState, now)) {
    const cancelled = await claimConversationState(from, conversationState.nonce);
    return cancelled
      ? "That pending update was for a previous day, so nothing was changed. Please send today's request again."
      : "That pending update expired or was already handled, so nothing was changed. Please send your request again.";
  }
  const proteinGoalReply = contextualProteinGoalReply(trimmed, profile);
  if (proteinGoalReply) return proteinGoalReply;

  if (conversationState.awaiting && isExplicitIndependentMutation(trimmed)) {
    const cancelled = await claimConversationState(from, conversationState.nonce);
    if (!cancelled) {
      return "That pending update expired or was already handled, so nothing changed. Please send your request again.";
    }
    conversationState = {};
  }

  const needsHistory = needsConversationContext(trimmed, conversationState, now);
  const needsRepeatCheck = needsRepeatedMealCheck(trimmed, conversationState, now);
  const history = needsHistory || needsRepeatCheck
    ? await recentConversation(from, new Date(now))
    : [];
  if (refersToRecentMedia(trimmed, history)) {
    return RECENT_MEDIA_REPLY;
  }

  // Item-number targeting: "undo 14", "delete 14, 15", "remove #3". A bare
  // number counts as a row reference ONLY here, where a delete verb makes any
  // other reading impossible — everywhere else numbers stay quantities. No LLM
  // call, and it reaches any row from today rather than just the last batch.
  const seqRef = trimmed.match(/^(?:undo|delete|remove)\s+(?:items?\s*)?#?(\d+(?:\s*(?:,|and|&|\s)+\s*#?\d+)*)\s*$/i);
  // Only handles the message when today actually has numbered items; otherwise
  // it falls through to the normal undo path rather than claiming nothing exists.
  const availableSeqs = seqRef ? await todaySeqs(from) : [];
  if (seqRef && availableSeqs.length) {
    const seqs = [...new Set((seqRef[1].match(/\d+/g) || []).map(Number))];
    const available = availableSeqs;
    const missing = seqs.filter(s => !available.includes(s));
    if (missing.length) {
      return `No item ${missing.join(", ")} in today's log. Your items are ${available.join(", ")}.`;
    }
    const deleted = await deleteBySeq(from, seqs);
    if (!deleted || !deleted.length) return "Couldn't remove that — nothing changed.";
    logCorrectionEvent({ intent: "undo", rawMessage: body, parsed: { intent: "undo", items: [] },
      batch: [], deleted, outcome: "removed_by_number" });
    const total = await todayTotal(from);
    const lines = deleted.map(r => `${r.day_seq}. ${r.food_name} — ${r.kcal} kcal`).join("\n");
    return `\u{21A9}\u{FE0F} Removed:\n${lines}\n\n${dayLine(total, profile)}`;
  }

  // "replace item 2 with rice and dal" — item NUMBER as the swap target. Like
  // "undo N", the number is deterministic; the replacement text is parsed
  // normally. A digit must sit right after the verb, so name-based swaps
  // ("replace rajma with rice") and gram/quantity edits ("replace 250g rajma
  // with…", "replace 2 rotis with…") don't match and fall through untouched.
  const seqReplace = trimmed.match(/^(?:replace|change|swap|update)\s+(?:items?\s*)?#?(\d+)\s+(?:with|to|for|se|ko)\s+(.+)$/i);
  if (seqReplace) {
    const seq = Number(seqReplace[1]);
    const avail = await todaySeqs(from);
    if (!avail.includes(seq)) {
      return avail.length
        ? `No item ${seq} in today's log. Your items are ${avail.join(", ")}.`
        : "Nothing logged yet today — send me a food and I'll log it \u{1F642}";
    }
    const newParsed = await parseMeal(seqReplace[2]);
    if (!(newParsed.items || []).length) {
      return `Couldn't read the new food for item ${seq}. Try "replace ${seq} with 200g rice".`;
    }
    // Find, do not delete: the removal happens inside the same transaction as
    // the replacement, so a failure leaves the original entry untouched.
    const deleted = await rowsBySeq(from, [seq]);
    if (!deleted || !deleted.length) return "Couldn't change that — nothing removed.";
    let rows, totals;
    try {
      ({ rows, totals } = await replaceMealAtomic(from, newParsed, deleted.map(r => r.id)));
      logCorrectionEvent({ intent: "replace_last", rawMessage: body, parsed: newParsed, batch: [], deleted, outcome: "replaced_by_number" });
    } catch (_) {
      return "Couldn't save that correction, so your original entry is unchanged. Please try the correction again.";
    }
    const removedLines = deleted.map(r => `\u{274C} ${r.food_name} — ${r.kcal} kcal`).join("\n");
    const addedLines = fmtItems(rows).map(l => `\u{2705} ${l}`);
    return `\u{1F504} Corrected:\n${removedLines}\n${addedLines.join("\n")}\n\n` +
      `${dayLine(totals, profile)}\n${cfLine(totals)}`;
  }

  // "item 2 was wrong" / "2 is incorrect" — natural-language undo by number.
  // ("remove item N" already routes through seqRef above.)
  const seqWrong = trimmed.match(/^(?:item|no\.?|number|#)?\s*#?(\d+)\s+(?:was|is|wasn'?t|isn'?t)\s+(?:wrong|incorrect|a mistake|galat|not right|mislogged)\b/i);
  if (seqWrong) {
    const seq = Number(seqWrong[1]);
    const avail = await todaySeqs(from);
    if (!avail.includes(seq)) {
      return avail.length
        ? `No item ${seq} in today's log. Your items are ${avail.join(", ")}.`
        : "Nothing logged yet today — send me a food and I'll log it \u{1F642}";
    }
    const deleted = await deleteBySeq(from, [seq]);
    if (deleted && deleted.length) {
      logCorrectionEvent({ intent: "undo", rawMessage: body, parsed: { intent: "undo", items: [] }, batch: [], deleted, outcome: "removed_by_number" });
      const total = await todayTotal(from);
      const lines = deleted.map(r => `${r.day_seq}. ${r.food_name} — ${r.kcal} kcal`).join("\n");
      return `\u{21A9}\u{FE0F} Removed:\n${lines}\n\n${dayLine(total, profile)}`;
    }
  }

  // Bare item reference — "item 2", "item #2", "#2", "no. 2", "number 2" — and
  // nothing else. The user is pointing at a logged row (usually to change it)
  // but hasn't said what to do. Never hand this to the LLM: with no food word
  // it fabricates one (a real "Item 2" once logged "Paratha x2"). Echo the row
  // and the two things they can do with it.
  const itemRef = trimmed.match(/^(?:item|no\.?|number|#)\s*#?(\d+)$/i);
  if (itemRef) {
    const seq = Number(itemRef[1]);
    const rows = await itemsBySeq(from, [seq]);
    if (!rows.length) {
      const avail = await todaySeqs(from);
      return avail.length
        ? `No item ${seq} in today's log. Your items are ${avail.join(", ")}.`
        : "Nothing logged yet today — just send me a food and I'll log it \u{1F642}";
    }
    const it = rows[0];
    return `Item ${seq} is *${it.food_name}* (${it.kcal} kcal). What would you like to do?\n` +
      `\u{2022} Remove it: *undo ${seq}*\n` +
      `\u{2022} Swap it: *replace ${it.food_name} with …*`;
  }

  const pending = pendingQuery.get(from);
  if (/^(log it|log|ate it|had it|yes log it)$/i.test(trimmed) &&
      pending && Date.now() - pending.at < PENDING_TTL_MS) {
    pendingQuery.delete(from);
    let result;
    try {
      if (conversationState.awaiting) {
        const claimed = await executeClaimedAction({
          phone: from,
          nonce: conversationState.nonce,
          claim: claimConversationState,
          action: async () => logMeal(from, pending.parsed, { awaitInsert: true }),
        });
        if (!claimed.claimed) {
          return "That pending update expired or was already handled, so nothing was logged. Please request the preview again.";
        }
        result = claimed.value;
      } else {
        result = await logMeal(from, pending.parsed, { awaitInsert: true });
      }
    } catch (_) {
      return "That preview couldn't be saved, so nothing was logged. Please request it again.";
    }
    const { rows, totals, isNewUser } = result;
    return `✅ Logged\n${fmtItems(rows).join("\n")}\n\n` +
      `${dayLine(totals, profile)}\n${cfLine(totals)}` +
      (isNewUser ? FIRST_LOG_FOOTER : "");
  }

  let effectiveBody = body;
  let forcedIntent = null;
  let boundCorrectionTarget = null;
  let boundTargetRows = [];
  const pendingChoice = resolvePendingChoice(trimmed, conversationState, now);
  if (conversationState.awaiting === "repeat_meal_choice") {
    if (!pendingChoice) return REPEAT_CHOICE_PROMPT;
    const candidateBody = repeatMealCandidateBody(conversationState, history);
    const claimResult = await executeClaimedAction({
      phone: from,
      nonce: conversationState.nonce,
      claim: claimConversationState,
      action: async () => candidateBody,
    });
    if (!claimResult.claimed) {
      return "That meal choice expired or was already handled, so nothing changed. Please start again.";
    }
    if (!candidateBody) {
      return "I couldn't find that recent meal, so nothing changed. Send the meal again if you'd like to log it.";
    }
    effectiveBody = candidateBody;
    forcedIntent = pendingChoice === "correction" ? "replace_last" : "log";
    if (forcedIntent === "replace_last") {
      boundTargetRows = await logRowsByExactIds(from, conversationState.targetLogIds);
      if (
        boundTargetRows.length !== conversationState.targetLogIds.length
        || boundTargetRows.some(row => row.date !== conversationState.targetDate)
      ) {
        return "That original meal changed, so nothing was updated. Please send the correction again from the start.";
      }
      boundCorrectionTarget = {
        targetLogIds: conversationState.targetLogIds,
        targetDate: conversationState.targetDate,
      };
    }
  }

  const expectedCorrectedMeal = conversationState.awaiting === "corrected_meal";
  const directCorrectionPayload = correctionCuePayload(trimmed);
  const recentLoggedExchange = latestLoggedExchange(history);
  if (!forcedIntent && !expectedCorrectedMeal && directCorrectionPayload) {
    if (!recentLoggedExchange) {
      return "I couldn't find a recent logged meal, so nothing changed. Send the meal again if you'd like to log it.";
    }
    const targetRows = await lastLogBatch(from);
    const ephemeralTarget = correlatedTargetFromExchange(recentLoggedExchange, targetRows);
    if (!ephemeralTarget) {
      return "I couldn't safely connect that correction to the recent log, so nothing changed. Please try again.";
    }
    boundTargetRows = targetRows;
    boundCorrectionTarget = ephemeralTarget;
    effectiveBody = directCorrectionPayload;
    forcedIntent = "replace_last";
  }
  if (!forcedIntent && !expectedCorrectedMeal && isCorrectionCue(trimmed)) {
    if (!recentLoggedExchange) {
      return "I couldn't find a recent logged meal, so nothing changed. Send the meal again if you'd like to log it.";
    }
    const targetRows = await lastLogBatch(from);
    if (!loggedExchangeMatchesBatch(recentLoggedExchange, targetRows)) {
      return "I couldn't safely connect that correction to the recent log, so nothing changed. Please try again.";
    }
    const savedState = await persistConversationState({
      phone: from,
      awaiting: "corrected_meal",
      targetRows,
      loggedExchange: recentLoggedExchange,
      now,
      save: saveConversationState,
    });
    if (!savedState) {
      return "I couldn't safely save that correction request, so nothing changed. Please try again.";
    }
    return "NutriDesi understands this is a correction. Send the corrected meal once and I'll update the recent log.";
  }

  if (
    !forcedIntent
    && !expectedCorrectedMeal
    && needsRepeatCheck
    && repeatedMealCandidate(effectiveBody, history)
  ) {
    const targetRows = await lastLogBatch(from);
    if (!loggedExchangeMatchesBatch(recentLoggedExchange, targetRows)) {
      return "I couldn't safely connect that correction to the recent log, so nothing changed. Please try again.";
    }
    const savedState = await persistConversationState({
      phone: from,
      awaiting: "repeat_meal_choice",
      targetRows,
      loggedExchange: recentLoggedExchange,
      candidateBody: effectiveBody.trim().slice(0, RATE.maxLen),
      now,
      save: saveConversationState,
    });
    if (!savedState) {
      return "I couldn't safely save that meal choice, so nothing was logged. Please try again.";
    }
    return REPEAT_CHOICE_PROMPT;
  }

  const modifierFollowUp = /^(?:with|without|add)\b/i.test(effectiveBody.trim());
  const correctionCandidate = forcedIntent === "replace_last"
    || expectedCorrectedMeal
    || looksLikeCorrection(effectiveBody);
  if (expectedCorrectedMeal) {
    boundTargetRows = await logRowsByExactIds(from, conversationState.targetLogIds);
    if (
      boundTargetRows.length !== conversationState.targetLogIds.length
      || boundTargetRows.some(row => row.date !== conversationState.targetDate)
    ) {
      await claimConversationState(from, conversationState.nonce);
      return "That original meal changed, so nothing was updated. Please send the correction again from the start.";
    }
  }
  const recentBatch = boundTargetRows.length
    ? boundTargetRows
    : correctionCandidate || modifierFollowUp ? await lastLogBatch(from) : [];
  const contextBlocks = [
    formatConversationContext(needsHistory ? history : []),
    formatLastLogContext(recentBatch),
  ];
  const parsed = /^undo$/i.test(effectiveBody.trim())
    ? { intent: "undo", items: [], parse_notes: "literal undo" }
    : await parseMeal(effectiveBody, contextBlocks);

  if (forcedIntent) {
    parsed.intent = forcedIntent;
    if (forcedIntent === "replace_last") parsed.replace_target = null;
  } else if (expectedCorrectedMeal) {
    if (parsed.intent === "log" && (parsed.items || []).length) {
      const claimed = await claimConversationState(from, conversationState.nonce);
      if (!claimed) {
        return "That correction expired or was already handled, so nothing changed. Please start again.";
      }
      parsed.intent = "replace_last";
      parsed.replace_target = null;
      boundCorrectionTarget = {
        targetLogIds: conversationState.targetLogIds,
        targetDate: conversationState.targetDate,
      };
    } else if (parsed.intent !== "query") {
      return "Send the corrected meal with its food name and amount. Your recent log is unchanged.";
    }
  }

  // A user explicitly saying the earlier meal was correct and this food is an
  // addition outranks a model-level replace_last classification. This recovery
  // language exists precisely because a prior turn felt destructive, so never
  // compound it by deleting again.
  if (!forcedIntent && !expectedCorrectedMeal && isExplicitAddition(effectiveBody)) {
    parsed.intent = "log";
    parsed.replace_target = null;
  }

  // Must precede the generic query branch below.
  if (shouldRouteSemanticTdee({ forcedIntent, expectedCorrectedMeal, intent: parsed.intent })) {
    const semanticTdee = advanceTdee("calculate my calories", profile.tdee_profile || {});
    await saveTdeeProfile(from, semanticTdee.state);
    return semanticTdee.reply;
  }

  if (shouldPromoteToReplace(parsed, effectiveBody, recentBatch)) {
    parsed.intent = "replace_last";
    logCorrectionEvent({ intent: "promoted_to_replace", rawMessage: effectiveBody, parsed, batch: recentBatch, deleted: [], outcome: "promoted" });
  }

  // --- set_profile ---
  if (parsed.intent === "set_profile") {
    const name = parsed.name ? String(parsed.name).trim().slice(0, 30) : null;
    const gk = Number(parsed.goal_kcal) > 0 ? Math.round(Number(parsed.goal_kcal)) : null;
    const gp = Number(parsed.goal_protein) > 0 ? Math.round(Number(parsed.goal_protein)) : null;
    if (!name && !gk && !gp) {
      return "Tell me your name and daily goal, like \"Priya 1800 cal 120g protein\" \u{1F642}";
    }
    await saveProfile(from, { name, goal_kcal: gk, goal_protein: gp });
    const fresh = await getProfile(from);
    const changed = gk || gp;
    const goalLine = fresh.hasGoal
      ? `\nDaily goal: *${fresh.goal_kcal} kcal · ${fresh.goal_protein}g protein*`
      : (gk || gp ? `\nGoal so far: ${gk ? gk + " kcal" : ""}${gk && gp ? " · " : ""}${gp ? gp + "g protein" : ""}${gk && !gp ? " (add a protein target too?)" : ""}${!gk && gp ? " (add a calorie target too?)" : ""}` : "");
    const hi = name ? `Got it, ${name} \u{1F3AF}` : (changed ? "Updated \u{1F3AF}" : "Got it \u{1F3AF}");
    return `${hi}${goalLine}${fresh.hasGoal ? "\nI'll show your progress with every meal." : ""}`;
  }

  // --- query ---
  if (parsed.intent === "query") {
    let note = String(parsed.query_reply || "").trim();
    if (parsed.report_day === "today" || parsed.report_day === "yesterday") {
      const rep = await dayReport(from, parsed.report_day === "yesterday" ? 1 : 0);
      if (rep.meals.length === 0) {
        return parsed.report_day === "yesterday"
          ? "No logs from yesterday. Today's a fresh page \u{1F642}"
          : "Nothing logged yet today. Send me what you ate and I'll start the report \u{1F642}";
      }
      const items = rep.meals.flatMap(m => m.items);
      return `\u{1F9FE} *Your day — ${rep.label}*\n\n${items.join("\n")}\n\n` +
        `\u{1F525} *${Math.round(rep.totals.kcal)} kcal · ${Math.round(rep.totals.protein)}g protein*\n${cfLine(rep.totals)}`;
    }
    if ((parsed.items || []).length > 0) {
      if (/\d/.test(note)) note = "";
      const rows = await resolveRows(parsed);
      if (rows.length >= 2 && /\b(better|vs|versus|compare| or )\b/i.test(effectiveBody)) {
        const byKcal = [...rows].sort((a, b) => a.kcal - b.kcal);
        const light = byKcal[0], heavy = byKcal[byKcal.length - 1];
        note = `⚖️ Lighter: ${light.food_name} — ${light.kcal} vs ${heavy.kcal} kcal`;
        const topP = [...rows].sort((a, b) => b.protein - a.protein)[0];
        if (topP !== light && topP.protein > 0) note += `. More protein: ${topP.food_name}.`;
      }
      pendingQuery.set(from, { parsed, at: Date.now() });
      const firstName = rows[0].food_name.replace(/^\d+g /, "").toLowerCase();
      const footer = rows.length === 1
        ? `reply "log it" if you ate this`
        : `reply "log it" for all, or name one — "log ${firstName}"`;
      return (note ? `${note}\n\n` : "") +
        `ℹ️ ${fmtItems(rows).join("\n")}\n\n` +
        `_Not logged — ${footer}_ \u{1F642}`;
    }
    if (note) {
      const total = await todayTotal(from);
      const dayCtx = total.meals.length
        ? `\u{1F4CA} Your day so far: ${Math.round(total.kcal)} kcal · ${Math.round(total.protein)}g protein\n\n`
        : "";
      return `${dayCtx}${note}\n\n_Tell me when you eat something and I'll log it_ \u{1F642}`;
    }
    const total = await todayTotal(from);
    if (total.meals.length === 0) {
      return "Nothing logged yet today. Send me what you ate and I'll start counting \u{1F642}";
    }
    return `\u{1F4CA} Today so far:\n${dayLine(total, profile)}\n${cfLine(total)}`;
  }

  // --- undo ---
  if (parsed.intent === "undo") {
    const names = (parsed.items || []).map(i => i.food_name).filter(Boolean);
    // Explicit all-scope ("delete all entries", "sab hata do") clears the whole
    // day — the narrow last-batch undo silently under-delivering broke trust
    // (2026-07-19: user "deleted all", 178 kcal of roti stayed logged).
    const ALL_SCOPE = /\b(all|everything|entire|whole day|full day|sab ?kuch|sab|saara|sara|poora|pura)\b/i;
    if (!names.length && ALL_SCOPE.test(effectiveBody)) {
      const deleted = await deleteAllToday(from);
      if (!deleted || deleted.length === 0) return "Nothing to clear — no entries logged today.";
      logCorrectionEvent({ intent: "undo", rawMessage: effectiveBody, parsed, batch: recentBatch, deleted, outcome: "removed_all" });
      const kcal = deleted.reduce((s, r) => s + Number(r.kcal || 0), 0);
      return `↩️ Cleared today's log — ${deleted.length} ${deleted.length === 1 ? "entry" : "entries"} (${Math.round(kcal)} kcal) removed.\n\nFresh start: 0 kcal. \u{1F331}`;
    }
    let deleted;
    if (names.length) {
      const aligned = await deleteMatchingLastLog(from, names, recentBatch, effectiveBody);
      deleted = aligned ? aligned.filter(Boolean) : null;
      if (!deleted) {
        return `Couldn't find "${names.join(", ")}" in today's log — nothing removed.`;
      }
    } else {
      deleted = await deleteLastLog(from);
    }
    if (!deleted || deleted.length === 0) {
      return "Nothing to undo — no entries logged today.";
    }
    logCorrectionEvent({ intent: "undo", rawMessage: effectiveBody, parsed, batch: recentBatch, deleted, outcome: "removed" });
    const total = await todayTotal(from);
    const removedLines = deleted.map(r => `${r.food_name} — ${r.kcal} kcal`).join("\n");
    return `↩️ Removed:\n${removedLines}\n\n${dayLine(total, profile)}`;
  }

  // --- replace_last ---
  if (parsed.intent === "replace_last") {
    if ((parsed.items || []).length === 0) {
      return "Couldn't identify the corrected food — previous entry unchanged. Send the food name again.";
    }
    const latest = recentBatch.length ? recentBatch : await lastLogBatch(from);

    if (boundCorrectionTarget) {
      parsed.replace_target = null;
      const exactTargetRows = await logRowsByExactIds(from, boundCorrectionTarget.targetLogIds);
      if (
        exactTargetRows.length !== boundCorrectionTarget.targetLogIds.length
        || exactTargetRows.some(row => row.date !== boundCorrectionTarget.targetDate)
      ) {
        return "That original meal changed or couldn't be updated, so nothing else was logged. Please retry from the start.";
      }
      // Find, do not delete — replaceMealAtomic removes these inside the
      // same transaction that inserts the replacement.
      const deleted = await logRowsByExactIds(from, boundCorrectionTarget.targetLogIds);
      if (!deleted || deleted.length !== boundCorrectionTarget.targetLogIds.length) {
        return "That original meal changed or couldn't be updated, so nothing else was logged. Please retry from the start.";
      }
      try {
        const { rows, totals } = await replaceMealAtomic(from, parsed, deleted.map(r => r.id));
        // Logged only after the transaction commits. Recording it earlier meant
        // analytics counted corrections that never actually landed.
        logCorrectionEvent({
          intent: "replace_last",
          rawMessage: effectiveBody,
          parsed,
          batch: exactTargetRows,
          deleted,
          outcome: "corrected_bound_state",
        });
        const removedLines = deleted.map(r => `❌ ${r.food_name} — ${r.kcal} kcal`);
        const addedLines = fmtItems(rows).map(line => `✅ ${line}`);
        return `\u{1F504} Corrected:\n${removedLines.join("\n")}\n${addedLines.join("\n")}\n\n` +
          `${dayLine(totals, profile)}\n${cfLine(totals)}`;
      } catch (_) {
        return "Couldn't save that correction, so your original entry is unchanged. Please try the correction again.";
      }
    }

    // Explicit swap ("replace X with Y and Z"): the target and replacements are
    // DIFFERENT foods, possibly 1->N. Resolve the named target STRICTLY against
    // all of today's items (not the fuzzy last-batch fallback, which once
    // deleted an unrelated estimated row), then delete it by number and log the
    // new items. No confident single match -> change nothing.
    if (parsed.replace_target) {
      const target = resolveTargetByName(await todayItems(from), parsed.replace_target);
      if (!target) {
        logCorrectionEvent({ intent: "replace_last", rawMessage: effectiveBody, parsed, batch: latest, deleted: [], outcome: "dead_end" });
        return `Couldn't pin down "${parsed.replace_target}" in today's log — nothing changed. Try the item number, like "replace 2 with …".`;
      }
      // Find, do not delete — the removal is part of the replacement transaction.
      const removed = await rowsBySeq(from, [target.day_seq]);
      if (!removed || !removed.length) {
        return `Couldn't pin down "${parsed.replace_target}" in today's log — nothing changed.`;
      }
      try {
        const { rows, totals } = await replaceMealAtomic(from, parsed, removed.map(r => r.id));
        logCorrectionEvent({ intent: "replace_last", rawMessage: effectiveBody, parsed, batch: latest, deleted: removed, outcome: "replaced_by_name" });
        const removedLines = (removed || []).map(r => `\u{274C} ${r.food_name} — ${r.kcal} kcal`).join("\n");
        const addedLines = fmtItems(rows).map(l => `\u{2705} ${l}`);
        return `\u{1F504} Corrected:\n${removedLines}\n${addedLines.join("\n")}\n\n` +
          `${dayLine(totals, profile)}\n${cfLine(totals)}`;
      } catch (_) {
        return "Couldn't save that correction, so your original entry is unchanged. Please try the correction again.";
      }
    }
    // Find, do not delete. This is the route that lost user …0419 a full lunch
    // on 1 Aug: the delete committed, the insert failed, and the food was gone.
    // The removal now happens inside replaceMealAtomic's transaction.
    const aligned = await matchLastLogTargets(from, parsed.items, latest, effectiveBody);
    let deleted = aligned ? aligned.filter(Boolean) : null;
    if (!deleted && latest.length === 1) {
      deleted = await lastLogTargets(from, parsed.items.length === 1 ? parsed.items[0].food_name : null);
    }
    if (!deleted || deleted.length === 0) {
      logCorrectionEvent({ intent: "replace_last", rawMessage: effectiveBody, parsed, batch: latest, deleted: [], outcome: "dead_end" });
      return "Which item should I change? Name it and I'll fix just that one — like \"the shake was 200 calories\". Everything else stays logged.";
    }
    const inheritFromOld = (it, old) => {
      if (!old) return;
      const oq = Number(old.quantity) || 1;
      const generic = /^(unknown|meal|it|that|this|food|item)?$/i.test(String(it.food_name || "").trim());
      if (generic) it.food_name = old.food_name;
      if (!generic) {
        const words = String(it.food_name || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
        const hit = words.filter(w => old.food_name.toLowerCase().includes(w)).length;
        if (!words.length || hit / words.length < 0.6) return;
      }
      const protOnly = Number(it.stated_protein) > 0 && !Number(it.stated_kcal);
      if (protOnly) { it.quantity = oq; it.grams = null; }
      if (!Number(it.stated_kcal) && !Number(it.grams) && (!it.matched_db_id || protOnly)) {
        it.food_name = old.food_name;
        it.matched_db_id = old.matched_db_id || null;
        it.stated_kcal = Math.round(Number(old.kcal) / oq);
        if (!Number(it.stated_protein) && Number(old.protein) > 0)
          it.stated_protein = +(Number(old.protein) / oq).toFixed(1);
      }
    };
    if (aligned) parsed.items.forEach((it, i) => inheritFromOld(it, aligned[i]));
    else if (deleted && deleted.length === 1 && parsed.items.length === 1)
      inheritFromOld(parsed.items[0], deleted[0]);
    if (aligned && /\beach\b|\bper piece\b|\bhar ek\b/i.test(effectiveBody)) {
      parsed.items.forEach((it, i) => {
        const old = aligned[i];
        if (old && Number(old.quantity) > 1 && Number(it.quantity) === 1) it.quantity = Number(old.quantity);
      });
    }
    if (deleted && deleted.length === 1 && parsed.items.length === 1 &&
        parsed.items[0].portion_clarity !== "specified" &&
        Number(deleted[0].quantity) && Number(deleted[0].quantity) !== 1) {
      parsed.items[0].quantity = Number(deleted[0].quantity);
    }
    try {
      const { rows, totals } = await replaceMealAtomic(from, parsed, deleted.map(r => r.id));
      logCorrectionEvent({ intent: "replace_last", rawMessage: effectiveBody, parsed, batch: latest, deleted, outcome: "corrected" });
      const removedLines = (deleted || []).map(r => `❌ ${r.food_name} — ${r.kcal} kcal`).join("\n");
      const addedLines = fmtItems(rows).map(l => `✅ ${l}`);
      return `\u{1F504} Corrected:\n${removedLines}\n${addedLines.join("\n")}\n\n` +
        `${dayLine(totals, profile)}\n${cfLine(totals)}`;
    } catch (_) {
      return "Couldn't save that correction, so your original entry is unchanged. Please try the correction again.";
    }
  }

  // --- log (default) ---
  const systemFailure = /llm_error|parse_failed/.test(parsed.parse_notes || "");
  if ((parsed.items || []).length === 0) {
    return systemFailure
      ? "Couldn't read that one \u{1F605} mind sending it again? Splitting a long list into 2 messages helps."
      : "What did you eat? Send me a food name and I'll log it \u{1F642}";
  }

  let result;
  try {
    result = await logMeal(from, parsed, { awaitInsert: true });
  } catch (_) {
    return "I couldn't save that meal, so nothing was logged. Please send it again.";
  }
  const { rows, totals } = result;
  // A memory silently changing someone's numbers would be worse than the
  // repetition it fixes — a single mistaken correction would then be invisible
  // forever. Show it once per affected food, with the way out.
  const memNotes = rows.map(memoryNote).filter(Boolean);
  const ass = assumptionLines(rows).concat([...new Set(memNotes)].slice(0, 2));
  let goalAsk = "";
  if (!profile.hasGoal) {
    // The old ask demanded three things at once — name, calorie target and
    // protein target — two of which most people don't know. Adoption sat at
    // ~24%. Offer the calculator instead: one word, and it works the numbers
    // out from the answers it collects.
    if (result.isNewUser) {
      goalAsk = "\n\n\u{1F3AF} _Want me to track against a daily goal? Reply *goal* and I'll work out your numbers "
        + "— or send your own, like \"1800 cal 120g protein\"._";
    } else if ((profile.nudge_count || 0) < 2) {
      goalAsk = "\n\n\u{1F3AF} _Set a daily goal and I'll track progress with every meal. Reply *goal* and I'll "
        + "work out your numbers._";
      bumpNudge(from, profile.nudge_count);
    }
  }
  return `✅ Logged\n${fmtItems(rows).join("\n")}\n\n` +
    (ass.length ? `${ass.join("\n")}\n\n` : "") +
    `${dayLine(totals, profile)}\n${cfLine(totals)}` +
    (result.isNewUser ? FIRST_LOG_FOOTER : "") + goalAsk;
}

// ---------------------------------------------------------------------------
// Transport A — Twilio Sandbox (legacy, kept for migration overlap)
// ---------------------------------------------------------------------------

app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from = (req.body.From || "").replace("whatsapp:", "");
  const body = req.body.Body || "";
  const hasMedia = Number(req.body.NumMedia || 0) > 0;
  const t0 = Date.now();

  if (isDuplicate(req.body.MessageSid)) {
    return res.type("text/xml").send(twiml.toString());
  }
  res.on("finish", () => console.log(`${new Date().toISOString()} ${maskPhone(from)} "${body.slice(0, 40)}" ${Date.now() - t0}ms`));

  try {
    const reply = await handleMessageOnce(from, body, { media: hasMedia });
    twiml.message(reply);
    recordExchange(from, body, reply, hasMedia);
  } catch (err) {
    console.error("handler error:", err);
    twiml.message("✅ Logged: meal — 300 kcal (placeholder). Try again with more detail anytime.");
    recordExchange(from, body, "(handler error → placeholder reply)");
  }
  res.type("text/xml").send(twiml.toString());
});

// ---------------------------------------------------------------------------
// Transport B — Meta Cloud API (WABA)
// ---------------------------------------------------------------------------

app.get("/meta-whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("Meta webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/meta-whatsapp", async (req, res) => {
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret && req.rawBody) {
    const sig = req.headers["x-hub-signature-256"] || "";
    if (!validateSignature(req.rawBody, sig, appSecret)) {
      console.error("Meta webhook: invalid signature");
      return res.sendStatus(403);
    }
  }

  res.sendStatus(200);

  const messages = extractMessages(req.body);
  for (const { from, text, msgId, media } of messages) {
    if (isDuplicate(msgId)) continue;
    const t0 = Date.now();
    try {
      markRead(msgId);
      const reply = await handleMessageOnce(from, text, { media });
      await sendMessage(from, reply);
      recordExchange(from, text, reply, media);
    } catch (err) {
      console.error("handler error:", err);
      recordExchange(from, text, "(handler error → placeholder reply)");
      try {
        await sendMessage(from, "✅ Logged: meal — 300 kcal (placeholder). Try again with more detail anytime.");
      } catch (sendErr) {
        console.error("Meta reply failed:", sendErr.message);
      }
    }
    console.log(`${new Date().toISOString()} ${maskPhone(from)} "${text.slice(0, 40)}" ${Date.now() - t0}ms`);
  }
});

// Netlify outgoing webhook: fires on every waitlist submission. JWS-signed
// (X-Webhook-Signature) with NETLIFY_WEBHOOK_SECRET so randoms can't trigger
// free-text WhatsApp sends to Swapnil's own number by hitting this URL.
app.post("/netlify-waitlist", async (req, res) => {
  const secret = process.env.NETLIFY_WEBHOOK_SECRET;
  const token = req.headers["x-webhook-signature"];
  if (!secret || !token) return res.sendStatus(403);
  try {
    const { sha256 } = require("jsonwebtoken").verify(token, secret);
    const actual = require("crypto").createHash("sha256").update(req.rawBody).digest("hex");
    if (sha256 !== actual) return res.sendStatus(403);
  } catch (err) {
    console.error("netlify-waitlist: bad signature:", err.message);
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  const d = req.body.data || {};
  const name = String(d.name || req.body.name || "").trim();
  const rawContact = String(d.contact || "").trim();

  // Classify & normalize contact (same logic as sync-waitlist.js)
  function classifyContact(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const digits = s.replace(/[\s\-()."']/g, "");
    if (/^(\+91)?[6-9]\d{9}$/.test(digits)) return { type: "phone", norm: "+91" + digits.slice(-10) };
    if (/^\+\d{7,15}$/.test(digits)) return { type: "phone", norm: digits };
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s)) return { type: "email", norm: s.toLowerCase() };
    const handle = s.replace(/^@/, "").replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
    if (/^[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9_]$/i.test(handle) && /[a-z]/i.test(handle)) {
      return { type: "instagram", norm: handle.toLowerCase() };
    }
    return null;
  }

  const classified = classifyContact(rawContact);
  const contact = classified ? classified.norm : rawContact || "(no contact)";
  // Every valid-signature hit gets a log line — an unclassifiable contact must
  // never be invisible (2026-07-20: a signup left no trace anywhere).
  console.log(`netlify-waitlist: ${maskName(name)} · ${classified ? classified.type : `UNCLASSIFIED ${maskContact(rawContact)}`}`);

  // Auto-insert into founding_members (skip duplicates only).
  // Every valid signup is recorded, however many there are — the table is the
  // durable waitlist. FOUNDING_SPOTS is a *label*, not an insert gate: ranks
  // 1..50 hold the free-for-life promise, higher ranks are waitlisted behind
  // it. Capping the insert silently dropped signups instead (rows 51+ were
  // never written), which is unrecoverable — Netlify's notification is the
  // only copy. Who beyond 50 gets what is a separate call, made from the data.
  if (classified) {
    try {
      const { data: existing } = await supabase
        .from("founding_members")
        .select("id")
        .eq("contact", classified.norm)
        .limit(1);
      if (!existing || existing.length === 0) {
        const { data: all } = await supabase
          .from("founding_members")
          .select("waitlist_rank")
          .order("waitlist_rank", { ascending: false })
          .limit(1);
        const nextRank = ((all && all[0]?.waitlist_rank) || 0) + 1;
        const row = {
          contact: classified.norm,
          name: name || null,
          source: "waitlist",
          waitlist_rank: nextRank,
          phone_number: classified.type === "phone" ? classified.norm : null,
        };
        const { error: insErr } = await supabase.from("founding_members").insert([row]);
        if (insErr) throw new Error(insErr.message);
        const tier = nextRank <= FOUNDING_SPOTS ? "founding" : "waitlist";
        console.log(`founding_members: #${nextRank} ${maskName(name)} · ${classified.type} · ${tier}`);
      }
    } catch (err) {
      console.error("netlify-waitlist: founding_members insert failed:", err.message);
    }
  }

  // WhatsApp alert to Swapnil
  const text = `\u{1F389} New waitlist signup (#${classified ? "auto-added" : "NEEDS REVIEW"}): ${name || "(no name)"} — ${contact}`;
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || "+14155238886"}`;
    await client.messages.create({ from, to: `whatsapp:${process.env.ALERT_PHONE}`, body: text });
  } catch (err) {
    console.error("netlify-waitlist: alert send failed:", err.message);
  }
});

// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

// Only bind a port when run directly (`node server.js`, which is how launchd
// starts it). When require()d — from a test — the module loads without
// listening, so handleMessage's routing can be exercised behaviourally instead
// of asserted by grepping this file.
if (require.main === module) {
  app.listen(PORT, () => console.log(`NutriDesi listening on :${PORT}`));
}

module.exports = {
  app, handleMessage, handleMessageOnce,
  // Exported so the dedup window can be tested with an injected clock — the
  // expiry is otherwise unreachable from a test, which never waits 90s.
  duplicateReplay, rememberBody, DUP_WINDOW_MS,
};
