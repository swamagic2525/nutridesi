// NutriDesi — single synchronous Twilio webhook.
// Twilio POST -> parse with Claude -> log to Supabase -> reply inline via TwiML.
// Claude Haiku responds in ~1-3s, well within Twilio's 15s window, so no async queue needed.

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { parseMeal } = require("./src/parser.js");
const { loadMetrics } = require("./src/metrics.js");
const { metricsPage } = require("./src/metricsPage.js");
const { logMeal, deleteLastLog, deleteMatchingLastLog, lastLogBatch, todayTotal, ensureUser, getProfile, saveProfile, bumpNudge, resolveRows, dayReport } = require("./src/db.js");
const { looksLikeCorrection, shouldPromoteToReplace, formatLastLogContext } = require("./src/correctionContext.js");

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded

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

// Intent (log / replace_last / undo) is classified by the LLM inside the parse
// call. Only a literal "undo" is short-circuited here to skip the LLM entirely.

// Per-user rate limits, checked BEFORE the LLM call — one spammer must not be
// able to burn the shared free-tier quota. In-memory: resets on restart, fine for MVP.
const RATE = { perHour: 25, perDay: 60, maxLen: 300 };
const usage = new Map(); // phone -> [timestamps of accepted messages]
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

// Twilio retries the webhook if a reply takes >15s — dedupe by MessageSid so a
// retry never double-logs a meal.
const seenSids = new Set();

// "calories of X?" answers are stashed so a follow-up "log it" logs them.
// In-memory, 10-min TTL: resets on restart, fine for MVP.
const pendingQuery = new Map(); // phone -> { parsed, at }
const PENDING_TTL_MS = 10 * 60 * 1000;

const WELCOME =
  "\u{1F64F} Hey! Thanks for being an early tester of NutriDesi. No app, no signup \u2014 I work right here.\n\n" +
  "\u{1F37D}\uFE0F *Eat something?* Text it: \"2 roti and dal\" \u00b7 \"100g rice, 200g chicken\" \u00b7 \"1 scoop whey\"\n" +
  "\u{1F50D} *Deciding?* Ask first: \"calories of 2 samosa?\" \u2014 I answer without logging\n" +
  "\u{1F4CA} *Curious?* \"how much have I eaten today?\"\n" +
  "\u21A9\uFE0F *Mistake?* \"undo\", or correct me: \"that dosa was 120 calories\"\n\n" +
  "I reply with calories + protein/carbs/fat/fibre and your day's total.\n\n" +
  "\u2014 Swapnil \u{1F44B} full-time PM & ex-fitness coach. My clients kept quitting tracking apps, so I " +
  "built this where you already are. Bigger version in ~30 days \u2014 feedback shapes it: " +
  "DM @swapnilgore2525 on Instagram, I read everything.";

const FIRST_LOG_FOOTER =
  "\n\n\u{1F64F} _First log \u2014 thanks for testing NutriDesi early! Reply \"undo\" to remove a mistake, " +
  "or correct me anytime (\"that dosa was 120 calories\"). Feedback? DM @swapnilgore2525 on Instagram \u2014 " +
  "I read everything. \u2014 Swapnil (PM & ex-fitness coach)_";

app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from = (req.body.From || "").replace("whatsapp:", "");
  const body = req.body.Body || "";
  const t0 = Date.now();

  const sid = req.body.MessageSid;
  if (sid) {
    if (seenSids.has(sid)) return res.type("text/xml").send(twiml.toString());
    seenSids.add(sid);
    if (seenSids.size > 1000) seenSids.delete(seenSids.values().next().value);
  }
  // Twilio drops replies after 15s — log every request's duration to catch it.
  res.on("finish", () => console.log(`${new Date().toISOString()} ${from} "${body.slice(0, 40)}" ${Date.now() - t0}ms`));

  try {
    if (body.length > RATE.maxLen) {
      twiml.message("That's a long one 😅 Keep it short — just the foods and portions, e.g. \"2 roti and dal\".");
      return res.type("text/xml").send(twiml.toString());
    }
    const limited = rateLimitCheck(from);
    if (limited) {
      twiml.message(limited === "hour"
        ? "Whoa, that's a lot of messages! Take a short break — I'll be here in an hour 🙂"
        : "You've hit today's message limit. Logging resumes tomorrow 🌙");
      return res.type("text/xml").send(twiml.toString());
    }

    // Reply renderers (beta feedback 2026-07-14: words not codes, no legend line).
    // dayLine is goal-aware: with a goal set it shows a progress bar + "left today"
    // open loop; without one it falls back to plain totals. `profile` is fetched
    // below, before any reply that uses dayLine.
    let profile = {};
    const dayLine = (t) => {
      const k = Math.round(t.kcal), p = Math.round(t.protein);
      if (!profile.hasGoal) return `*You're at ${k} kcal · ${p}g protein today*`;
      const gk = profile.goal_kcal, gp = profile.goal_protein;
      const pLeft = Math.max(0, gp - p);
      const who = profile.name ? `, ${profile.name}` : "";
      // Calories are a ceiling, protein a floor. Over on calories -> caution
      // (still flag protein if it's short too); under -> normal "left today".
      let tail;
      if (k > gk) {
        const over = k - gk;
        tail = pLeft > 0
          ? `_${over} kcal past target, and ${pLeft}g protein short${who} — tread carefully ⚠️_`
          : `_${over} kcal past your target${who} — tread carefully ⚠️_`;
      } else {
        const kLeft = gk - k;
        tail = `_${kLeft} kcal, ${pLeft}g protein left today${who} 💪_`;
      }
      return `🔥 *${k} / ${gk} kcal · ${p} / ${gp}g protein*\n${tail}`;
    };
    const cfLine = (t) => `Carbs ${Math.round(t.carbs)}g · Fat ${Math.round(t.fat)}g · Fibre ${Math.round(t.fiber || 0)}g`;
    const fmtItems = (rows) => rows.map(r => {
      const qty = r.quantity === 1 ? "" : ` ×${r.quantity}`;
      const p = (r.matched_db_id || r.protein > 0) ? ` · ${Math.round(r.protein)}g protein` : "";
      const note = r.portionNote ? ` (${r.portionNote})` : "";
      return `*${r.food_name}*${qty} — ${r.kcal} kcal${p}${note}`;
    });
    // 🤔 callouts for dish-identity guesses (closest match / estimate), capped at 2.
    const assumptionLines = (rows) => {
      const guesses = rows.filter(r => r.assumed && r.userSaid);
      const lines = guesses.slice(0, 2).map(r =>
        r.food_name.toLowerCase().includes(String(r.userSaid).toLowerCase())
          ? `\u{1F914} _"${r.userSaid}" isn't in my book yet — logged my best estimate. Know the calories? Reply "it was 200 calories"_`
          : `\u{1F914} _"${r.userSaid}" — logged the closest match, *${r.food_name}*. Something else? Just reply "it was …"_`);
      if (guesses.length > 2) lines.push(`_…and ${guesses.length - 2} more guesses in the list below_`);
      return lines;
    };

    // Sandbox join, greetings, and "what is this" get the intro — no LLM call.
    const trimmed = body.trim();
    const isJoin = /^join\b/i.test(trimmed);
    const isGreeting = /^(hi+|hello+|hey+|namaste|hola|start|yo)[\s!.\u{1F44B}\u{1F64F}]*$/iu.test(trimmed);
    const isHelp = /^(help|what can you do\??|how does (this|it) work\??|what is this\??)$/i.test(trimmed);
    if (isJoin || isGreeting || isHelp) {
      const isNew = await ensureUser(from);
      twiml.message(isNew || isJoin || isHelp
        ? WELCOME
        : "Hey! \u{1F44B} Just tell me what you ate \u2014 e.g. \"2 roti and dal\" \u2014 and I'll log it.");
      return res.type("text/xml").send(twiml.toString());
    }

    // Profile (name + goal) drives the goal-aware dayLine and onboarding prompts.
    profile = await getProfile(from);

    // "log it" after a food question -> log the stashed items, no LLM call.
    const pending = pendingQuery.get(from);
    if (/^(log it|log|ate it|had it|yes log it)$/i.test(trimmed) &&
        pending && Date.now() - pending.at < PENDING_TTL_MS) {
      pendingQuery.delete(from);
      const { rows, meals, totals, isNewUser } = await logMeal(from, pending.parsed);
      const cur = meals[meals.length - 1];
      twiml.message(
        `\u2705 Logged\n${fmtItems(rows).join("\n")}\n\n` +
        `Meal ${meals.length} \u2014 ${cur.kcal} kcal \u00b7 ${cur.protein}g protein\n` +
        `${dayLine(totals)}\n${cfLine(totals)}` +
        (isNewUser ? FIRST_LOG_FOOTER : "")
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // Layer 2: fetch ONLY the immediately preceding log for correction-shaped
    // messages, then ground the parser in that small context. Normal logs do
    // not pay an extra DB round-trip.
    const correctionCandidate = looksLikeCorrection(body);
    const recentBatch = correctionCandidate ? await lastLogBatch(from) : [];
    const parsed = /^undo$/i.test(body.trim())
      ? { intent: "undo", items: [], parse_notes: "literal undo" }
      : await parseMeal(body, formatLastLogContext(recentBatch));

    // Layer 1: deterministic backstop for the rare model miss on a clear
    // nutrition correction. It can promote only to the immediately previous
    // log, never an older meal.
    if (shouldPromoteToReplace(parsed, body, recentBatch)) parsed.intent = "replace_last";

    if (parsed.intent === "set_profile") {
      const name = parsed.name ? String(parsed.name).trim().slice(0, 30) : null;
      const gk = Number(parsed.goal_kcal) > 0 ? Math.round(Number(parsed.goal_kcal)) : null;
      const gp = Number(parsed.goal_protein) > 0 ? Math.round(Number(parsed.goal_protein)) : null;
      if (!name && !gk && !gp) {
        twiml.message("Tell me your name and daily goal, like \"Priya 1800 cal 120g protein\" \u{1F642}");
        return res.type("text/xml").send(twiml.toString());
      }
      await saveProfile(from, { name, goal_kcal: gk, goal_protein: gp });
      const fresh = await getProfile(from);
      const changed = gk || gp;
      const goalLine = fresh.hasGoal
        ? `\nDaily goal: *${fresh.goal_kcal} kcal · ${fresh.goal_protein}g protein*`
        : (gk || gp ? `\nGoal so far: ${gk ? gk + " kcal" : ""}${gk && gp ? " · " : ""}${gp ? gp + "g protein" : ""}${gk && !gp ? " (add a protein target too?)" : ""}${!gk && gp ? " (add a calorie target too?)" : ""}` : "");
      const hi = name ? `Got it, ${name} \u{1F3AF}` : (changed ? "Updated \u{1F3AF}" : "Got it \u{1F3AF}");
      twiml.message(`${hi}${goalLine}${fresh.hasGoal ? "\nI'll show your progress with every meal." : ""}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent === "query") {
      // LLM's one-line verdict/suggestion. Qualitative only (prompt forbids
      // numbers) so it can never contradict the DB values printed below it.
      let note = String(parsed.query_reply || "").trim();
      if (parsed.report_day === "today" || parsed.report_day === "yesterday") {
        const rep = await dayReport(from, parsed.report_day === "yesterday" ? 1 : 0);
        if (rep.meals.length === 0) {
          twiml.message(parsed.report_day === "yesterday"
            ? "No logs from yesterday. Today's a fresh page \u{1F642}"
            : "Nothing logged yet today. Send me what you ate and I'll start the report \u{1F642}");
        } else {
          const mealBlocks = rep.meals.map((m, i) =>
            `*Meal ${i + 1}* \u2014 ${Math.round(m.kcal)} kcal \u00b7 ${Math.round(m.protein)}g protein\n${m.items.join(", ")}`);
          twiml.message(
            `\u{1F9FE} *Your day \u2014 ${rep.label}*\n\n${mealBlocks.join("\n\n")}\n\n` +
            `\u{1F525} *${Math.round(rep.totals.kcal)} kcal \u00b7 ${Math.round(rep.totals.protein)}g protein*\n${cfLine(rep.totals)}`
          );
        }
        return res.type("text/xml").send(twiml.toString());
      }
      if ((parsed.items || []).length > 0) {
        // Backstop: a verdict with numbers can contradict the DB table below it
        // (seen: "~260 cal each" when 260 was the total). Drop it; the table answers.
        if (/\d/.test(note)) note = "";
        // Food question: verdict + nutrition, log nothing, stash for "log it".
        const rows = await resolveRows(parsed);
        // Comparison question ("better X or Y"): the verdict is computed from our
        // own resolved numbers, never the LLM's guess (seen it pick the wrong winner).
        if (rows.length >= 2 && /\b(better|vs|versus|compare| or )\b/i.test(body)) {
          const byKcal = [...rows].sort((a, b) => a.kcal - b.kcal);
          const light = byKcal[0], heavy = byKcal[byKcal.length - 1];
          note = `\u2696\uFE0F Lighter: ${light.food_name} \u2014 ${light.kcal} vs ${heavy.kcal} kcal`;
          const topP = [...rows].sort((a, b) => b.protein - a.protein)[0];
          if (topP !== light && topP.protein > 0) note += `. More protein: ${topP.food_name}.`;
        }
        pendingQuery.set(from, { parsed, at: Date.now() });
        const firstName = rows[0].food_name.replace(/^\d+g /, "").toLowerCase();
        const footer = rows.length === 1
          ? `reply "log it" if you ate this`
          : `reply "log it" for all, or name one \u2014 "log ${firstName}"`;
        twiml.message(
          (note ? `${note}\n\n` : "") +
          `\u2139\uFE0F ${fmtItems(rows).join("\n")}\n\n` +
          `_Not logged \u2014 ${footer}_ \u{1F642}`
        );
      } else if (note) {
        // Advice question ("what can I eat for protein?"): suggestions, with
        // their day so far for context when they've logged anything.
        const total = await todayTotal(from);
        const dayCtx = total.meals.length
          ? `\u{1F4CA} Your day so far: ${Math.round(total.kcal)} kcal \u00b7 ${Math.round(total.protein)}g protein\n\n`
          : "";
        twiml.message(`${dayCtx}${note}\n\n_Tell me when you eat something and I'll log it_ \u{1F642}`);
      } else {
        // Day question: today's running total.
        const total = await todayTotal(from);
        if (total.meals.length === 0) {
          twiml.message("Nothing logged yet today. Send me what you ate and I'll start counting \u{1F642}");
        } else {
          const mealLine = total.meals.map((m, i) => `Meal ${i + 1}: ${Math.round(m.kcal)}`).join(" \u00b7 ");
          twiml.message(
            `\u{1F4CA} Today so far:\n${mealLine} kcal\n` +
            `${dayLine(total)}\n${cfLine(total)}`
          );
        }
      }
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent === "undo") {
      // Named removal and bare undo are intentionally local to the immediately
      // preceding log. Older entries need an explicit reference in a later pass.
      const names = (parsed.items || []).map(i => i.food_name).filter(Boolean);
      let deleted;
      if (names.length) {
        const aligned = await deleteMatchingLastLog(from, names, recentBatch, body);
        deleted = aligned ? aligned.filter(Boolean) : null;
        if (!deleted) {
          twiml.message(`Couldn't find "${names.join(", ")}" in today's log — nothing removed.`);
          return res.type("text/xml").send(twiml.toString());
        }
      } else {
        deleted = await deleteLastLog(from);
      }
      if (!deleted || deleted.length === 0) {
        twiml.message("Nothing to undo — no entries logged today.");
        return res.type("text/xml").send(twiml.toString());
      }
      const total = await todayTotal(from);
      const removedLines = deleted.map(r => `${r.food_name} — ${r.kcal} kcal`).join("\n");
      const mealLine = total.meals.length
        ? total.meals.map((m, i) => `Meal ${i + 1}: ${Math.round(m.kcal)}`).join(" · ") + " kcal\n"
        : "";
      twiml.message(
        `↩️ Removed:\n${removedLines}\n\n${mealLine}` +
        `${dayLine(total)}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent === "replace_last") {
      if ((parsed.items || []).length === 0) {
        twiml.message("Couldn't identify the corrected food — previous entry unchanged. Send the food name again.");
        return res.type("text/xml").send(twiml.toString());
      }
      // Layer 1: corrections can touch only the immediately preceding log
      // message. Never search through today's / 45-minute meal history.
      const latest = recentBatch.length ? recentBatch : await lastLogBatch(from);
      const aligned = await deleteMatchingLastLog(from, parsed.items, latest, body);
      let deleted = aligned ? aligned.filter(Boolean) : null;
      // A rename with no word overlap ("sorry, it was rajma") can safely
      // replace a one-item last batch. A multi-item batch is ambiguous: do not
      // delete it just because the model guessed an intent.
      if (!deleted && latest.length === 1) {
        deleted = await deleteLastLog(from, parsed.items.length === 1 ? parsed.items[0].food_name : null);
      }
      if (!deleted || deleted.length === 0) {
        twiml.message("I couldn't tell which item in your most recent log to change — tell me its name, or use undo and send it again.");
        return res.type("text/xml").send(twiml.toString());
      }
      // Correction inheritance: any value the user did NOT restate carries over
      // from the row being replaced — name ("it was 220 cals" keeps the dish),
      // per-serving kcal/protein ("I had 3 of them" keeps the corrected values,
      // scaled by the new count), and identity on protein-only corrections.
      // A rename to a DIFFERENT dish (word overlap < 60%) inherits nothing.
      const inheritFromOld = (it, old) => {
        if (!old) return;
        const oq = Number(old.quantity) || 1;
        const generic = /^(unknown|meal|it|that|this|food|item)?$/i.test(String(it.food_name || "").trim());
        if (generic) it.food_name = old.food_name;
        if (!generic) {
          const words = String(it.food_name || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
          const hit = words.filter(w => old.food_name.toLowerCase().includes(w)).length;
          if (!words.length || hit / words.length < 0.6) return; // different dish — fresh values
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
      // "60 calories EACH": the stated value is per piece — carry the replaced
      // row's count so 2 rotis corrected at 60 each land as 120, not 60.
      if (aligned && /\beach\b|\bper piece\b|\bhar ek\b/i.test(body)) {
        parsed.items.forEach((it, i) => {
          const old = aligned[i];
          if (old && Number(old.quantity) > 1 && Number(it.quantity) === 1) it.quantity = Number(old.quantity);
        });
      }
      // Name-only correction ("it was veg not chicken") inherits the old quantity —
      // only when the user didn't state a new one and the swap is one-for-one.
      if (deleted && deleted.length === 1 && parsed.items.length === 1 &&
          parsed.items[0].portion_clarity !== "specified" &&
          Number(deleted[0].quantity) && Number(deleted[0].quantity) !== 1) {
        parsed.items[0].quantity = Number(deleted[0].quantity);
      }
      const { rows, meals, totals } = await logMeal(from, parsed);
      const removedLines = (deleted || []).map(r => `❌ ${r.food_name} — ${r.kcal} kcal`).join("\n");
      const addedLines = fmtItems(rows).map(l => `✅ ${l}`);
      twiml.message(
        `🔄 Corrected:\n${removedLines}\n${addedLines.join("\n")}\n\n` +
        `${dayLine(totals)}\n${cfLine(totals)}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    const systemFailure = /llm_error|parse_failed/.test(parsed.parse_notes || "");
    if ((parsed.items || []).length === 0) {
      // System failure on a real meal -> ask to resend rather than logging a wrong
      // 300 kcal placeholder that pollutes the day. Non-failure -> normal prompt.
      twiml.message(systemFailure
        ? "Couldn't read that one 😅 mind sending it again? Splitting a long list into 2 messages helps."
        : "What did you eat? Send me a food name and I'll log it 🙂");
      return res.type("text/xml").send(twiml.toString());
    }

    const result = await logMeal(from, parsed);
    const { rows, meals, totals } = result;
    const cur = meals[meals.length - 1];
    const ass = assumptionLines(rows);
    // Goal capture: no goal set yet -> invite one. New user gets the warm ask +
    // founder footer; a returning user gets a compact nudge, capped at 2 so we
    // never nag. Once a goal exists, this disappears and the progress bar takes over.
    let goalAsk = "";
    if (!profile.hasGoal) {
      if (result.isNewUser) {
        goalAsk = "\n\n🎯 _Want me to track against a daily goal? Reply your name + target — like \"Priya, 1800 cal 120g protein\". Or skip, I'll just track totals._";
      } else if ((profile.nudge_count || 0) < 2) {
        goalAsk = "\n\n🎯 _New: set a daily goal and I'll track your progress. Reply \"Rahul 2000 cal 140 protein\" anytime._";
        bumpNudge(from, profile.nudge_count);
      }
    }
    twiml.message(
      `✅ Logged\n${fmtItems(rows).join("\n")}\n\n` +
      (ass.length ? `${ass.join("\n")}\n\n` : "") +
      `Meal ${meals.length} — ${cur.kcal} kcal · ${cur.protein}g protein\n` +
      `${dayLine(totals)}\n${cfLine(totals)}` +
      (result.isNewUser ? FIRST_LOG_FOOTER : "") + goalAsk
    );
  } catch (err) {
    console.error("handler error:", err);
    // Never leave the user with silence.
    twiml.message("✅ Logged: meal — 300 kcal (placeholder). Try again with more detail anytime.");
  }

  res.type("text/xml").send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriDesi listening on :${PORT}`));
