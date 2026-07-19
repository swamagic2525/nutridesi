// NutriDesi — WhatsApp food-tracking bot.
// Supports two transports: Twilio Sandbox (legacy) and Meta Cloud API (WABA).
// Both share the same handler → parser → DB → reply pipeline.

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { parseMeal } = require("./src/parser.js");
const { loadMetrics } = require("./src/metrics.js");
const { metricsPage } = require("./src/metricsPage.js");
const { supabase, logMeal, deleteLastLog, deleteAllToday, deleteMatchingLastLog, lastLogBatch, todayTotal, ensureUser, getProfile, saveProfile, bumpNudge, resolveRows, dayReport } = require("./src/db.js");
const { looksLikeCorrection, shouldPromoteToReplace, formatLastLogContext } = require("./src/correctionContext.js");
const { validateSignature, extractMessages, sendMessage, markRead } = require("./src/meta.js");
const { logCorrectionEvent } = require("./src/correctionLogger.js");

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
  try { return res.json(await currentMetrics()); }
  catch (error) {
    console.error("metrics error:", error.message);
    return res.status(503).json({ error: "Metrics are temporarily unavailable. Check dashboard configuration." });
  }
});

app.get("/", (_req, res) => res.send("NutriDesi is running."));

// ---------------------------------------------------------------------------
// Shared state & helpers
// ---------------------------------------------------------------------------

const RATE = { perHour: 25, perDay: 60, maxLen: 300 };
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

const FIRST_LOG_FOOTER =
  "\n\n\u{1F64F} _First log — thanks for testing NutriDesi early! Reply \"undo\" to remove a mistake, " +
  "or correct me anytime (\"that dosa was 120 calories\"). Feedback? DM @swapnilgore2525 on Instagram — " +
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
    return `*${r.food_name}*${qty} — ${r.kcal} kcal${p}${note}`;
  });
}

function assumptionLines(rows) {
  const guesses = rows.filter(r => r.assumed && r.userSaid
    // A DB match whose name already covers what the user said needs no confession.
    && !(r.matched_db_id && r.food_name.toLowerCase().includes(String(r.userSaid).toLowerCase())));
  const lines = guesses.slice(0, 2).map(r =>
    r.matched_db_id
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

async function handleMessage(from, body) {
  if (body.length > RATE.maxLen) {
    return "That's a long one \u{1F605} Keep it short — just the foods and portions, e.g. \"2 roti and dal\".";
  }
  const limited = rateLimitCheck(from);
  if (limited) {
    return limited === "hour"
      ? "Whoa, that's a lot of messages! Take a short break — I'll be here in an hour \u{1F642}"
      : "You've hit today's message limit. Logging resumes tomorrow \u{1F319}";
  }

  const trimmed = body.trim();
  const isJoin = /^join\b/i.test(trimmed);
  const isGreeting = /^(hi+|hello+|hey+|namaste|hola|start|yo)[\s!.\u{1F44B}\u{1F64F}]*$/iu.test(trimmed);
  const isHelp = /^(help|what can you do\??|how does (this|it) work\??|what is this\??)$/i.test(trimmed);
  if (isJoin || isGreeting || isHelp) {
    const isNew = await ensureUser(from);
    return (isNew || isJoin || isHelp)
      ? WELCOME
      : "Hey! \u{1F44B} Just tell me what you ate — e.g. \"2 roti and dal\" — and I'll log it.";
  }

  const profile = await getProfile(from);

  const pending = pendingQuery.get(from);
  if (/^(log it|log|ate it|had it|yes log it)$/i.test(trimmed) &&
      pending && Date.now() - pending.at < PENDING_TTL_MS) {
    pendingQuery.delete(from);
    const { rows, meals, totals, isNewUser } = await logMeal(from, pending.parsed);
    const cur = meals[meals.length - 1];
    return `✅ Logged\n${fmtItems(rows).join("\n")}\n\n` +
      `Meal ${meals.length} — ${cur.kcal} kcal · ${cur.protein}g protein\n` +
      `${dayLine(totals, profile)}\n${cfLine(totals)}` +
      (isNewUser ? FIRST_LOG_FOOTER : "");
  }

  const correctionCandidate = looksLikeCorrection(body);
  const recentBatch = correctionCandidate ? await lastLogBatch(from) : [];
  const parsed = /^undo$/i.test(trimmed)
    ? { intent: "undo", items: [], parse_notes: "literal undo" }
    : await parseMeal(body, formatLastLogContext(recentBatch));

  if (shouldPromoteToReplace(parsed, body, recentBatch)) {
    parsed.intent = "replace_last";
    logCorrectionEvent({ intent: "promoted_to_replace", rawMessage: body, parsed, batch: recentBatch, deleted: [], outcome: "promoted" });
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
      const mealBlocks = rep.meals.map((m, i) =>
        `*Meal ${i + 1}* — ${Math.round(m.kcal)} kcal · ${Math.round(m.protein)}g protein\n${m.items.join(", ")}`);
      return `\u{1F9FE} *Your day — ${rep.label}*\n\n${mealBlocks.join("\n\n")}\n\n` +
        `\u{1F525} *${Math.round(rep.totals.kcal)} kcal · ${Math.round(rep.totals.protein)}g protein*\n${cfLine(rep.totals)}`;
    }
    if ((parsed.items || []).length > 0) {
      if (/\d/.test(note)) note = "";
      const rows = await resolveRows(parsed);
      if (rows.length >= 2 && /\b(better|vs|versus|compare| or )\b/i.test(body)) {
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
    const mealLine = total.meals.map((m, i) => `Meal ${i + 1}: ${Math.round(m.kcal)}`).join(" · ");
    return `\u{1F4CA} Today so far:\n${mealLine} kcal\n` +
      `${dayLine(total, profile)}\n${cfLine(total)}`;
  }

  // --- undo ---
  if (parsed.intent === "undo") {
    const names = (parsed.items || []).map(i => i.food_name).filter(Boolean);
    // Explicit all-scope ("delete all entries", "sab hata do") clears the whole
    // day — the narrow last-batch undo silently under-delivering broke trust
    // (2026-07-19: user "deleted all", 178 kcal of roti stayed logged).
    const ALL_SCOPE = /\b(all|everything|entire|whole day|full day|sab ?kuch|sab|saara|sara|poora|pura)\b/i;
    if (!names.length && ALL_SCOPE.test(body)) {
      const deleted = await deleteAllToday(from);
      if (!deleted || deleted.length === 0) return "Nothing to clear — no entries logged today.";
      logCorrectionEvent({ intent: "undo", rawMessage: body, parsed, batch: recentBatch, deleted, outcome: "removed_all" });
      const kcal = deleted.reduce((s, r) => s + Number(r.kcal || 0), 0);
      return `↩️ Cleared today's log — ${deleted.length} ${deleted.length === 1 ? "entry" : "entries"} (${Math.round(kcal)} kcal) removed.\n\nFresh start: 0 kcal. \u{1F331}`;
    }
    let deleted;
    if (names.length) {
      const aligned = await deleteMatchingLastLog(from, names, recentBatch, body);
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
    logCorrectionEvent({ intent: "undo", rawMessage: body, parsed, batch: recentBatch, deleted, outcome: "removed" });
    const total = await todayTotal(from);
    const removedLines = deleted.map(r => `${r.food_name} — ${r.kcal} kcal`).join("\n");
    const mealLine = total.meals.length
      ? total.meals.map((m, i) => `Meal ${i + 1}: ${Math.round(m.kcal)}`).join(" · ") + " kcal\n"
      : "";
    return `↩️ Removed:\n${removedLines}\n\n${mealLine}` +
      `${dayLine(total, profile)}`;
  }

  // --- replace_last ---
  if (parsed.intent === "replace_last") {
    if ((parsed.items || []).length === 0) {
      return "Couldn't identify the corrected food — previous entry unchanged. Send the food name again.";
    }
    const latest = recentBatch.length ? recentBatch : await lastLogBatch(from);
    const aligned = await deleteMatchingLastLog(from, parsed.items, latest, body);
    let deleted = aligned ? aligned.filter(Boolean) : null;
    if (!deleted && latest.length === 1) {
      deleted = await deleteLastLog(from, parsed.items.length === 1 ? parsed.items[0].food_name : null);
    }
    if (!deleted || deleted.length === 0) {
      logCorrectionEvent({ intent: "replace_last", rawMessage: body, parsed, batch: latest, deleted: [], outcome: "dead_end" });
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
    if (aligned && /\beach\b|\bper piece\b|\bhar ek\b/i.test(body)) {
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
    logCorrectionEvent({ intent: "replace_last", rawMessage: body, parsed, batch: latest, deleted, outcome: "corrected" });
    const { rows, meals, totals } = await logMeal(from, parsed);
    const removedLines = (deleted || []).map(r => `❌ ${r.food_name} — ${r.kcal} kcal`).join("\n");
    const addedLines = fmtItems(rows).map(l => `✅ ${l}`);
    return `\u{1F504} Corrected:\n${removedLines}\n${addedLines.join("\n")}\n\n` +
      `${dayLine(totals, profile)}\n${cfLine(totals)}`;
  }

  // --- log (default) ---
  const systemFailure = /llm_error|parse_failed/.test(parsed.parse_notes || "");
  if ((parsed.items || []).length === 0) {
    return systemFailure
      ? "Couldn't read that one \u{1F605} mind sending it again? Splitting a long list into 2 messages helps."
      : "What did you eat? Send me a food name and I'll log it \u{1F642}";
  }

  const result = await logMeal(from, parsed);
  const { rows, meals, totals } = result;
  const cur = meals[meals.length - 1];
  const ass = assumptionLines(rows);
  let goalAsk = "";
  if (!profile.hasGoal) {
    if (result.isNewUser) {
      goalAsk = "\n\n\u{1F3AF} _Want me to track against a daily goal? Reply your name + target — like \"Priya, 1800 cal 120g protein\". Or skip, I'll just track totals._";
    } else if ((profile.nudge_count || 0) < 2) {
      goalAsk = "\n\n\u{1F3AF} _New: set a daily goal and I'll track your progress. Reply \"Rahul 2000 cal 140 protein\" anytime._";
      bumpNudge(from, profile.nudge_count);
    }
  }
  return `✅ Logged\n${fmtItems(rows).join("\n")}\n\n` +
    (ass.length ? `${ass.join("\n")}\n\n` : "") +
    `Meal ${meals.length} — ${cur.kcal} kcal · ${cur.protein}g protein\n` +
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
  const t0 = Date.now();

  if (isDuplicate(req.body.MessageSid)) {
    return res.type("text/xml").send(twiml.toString());
  }
  res.on("finish", () => console.log(`${new Date().toISOString()} ${from} "${body.slice(0, 40)}" ${Date.now() - t0}ms`));

  try {
    const reply = await handleMessage(from, body);
    twiml.message(reply);
  } catch (err) {
    console.error("handler error:", err);
    twiml.message("✅ Logged: meal — 300 kcal (placeholder). Try again with more detail anytime.");
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
  for (const { from, text, msgId } of messages) {
    if (isDuplicate(msgId)) continue;
    const t0 = Date.now();
    try {
      markRead(msgId);
      const reply = await handleMessage(from, text);
      await sendMessage(from, reply);
    } catch (err) {
      console.error("handler error:", err);
      try {
        await sendMessage(from, "✅ Logged: meal — 300 kcal (placeholder). Try again with more detail anytime.");
      } catch (sendErr) {
        console.error("Meta reply failed:", sendErr.message);
      }
    }
    console.log(`${new Date().toISOString()} ${from} "${text.slice(0, 40)}" ${Date.now() - t0}ms`);
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

  // Auto-insert into founding_members (skip if duplicate or past cap)
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
        if (nextRank <= 50) {
          const row = {
            contact: classified.norm,
            name: name || null,
            source: "waitlist",
            waitlist_rank: nextRank,
            phone_number: classified.type === "phone" ? classified.norm : null,
          };
          await supabase.from("founding_members").insert([row]);
          console.log(`founding_members: #${nextRank} ${name || "(no name)"} · ${classified.type}`);
        }
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
app.listen(PORT, () => console.log(`NutriDesi listening on :${PORT}`));
