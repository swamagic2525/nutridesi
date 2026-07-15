// NutriDesi — single synchronous Twilio webhook.
// Twilio POST -> parse with Claude -> log to Supabase -> reply inline via TwiML.
// Claude Haiku responds in ~1-3s, well within Twilio's 15s window, so no async queue needed.

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { parseMeal } = require("./src/parser.js");
const { logMeal, deleteLastLog, deleteMatching, todayTotal, ensureUser, resolveRows, dayReport } = require("./src/db.js");

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded

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
    const dayLine = (t) => `*You're at ${Math.round(t.kcal)} kcal · ${Math.round(t.protein)}g protein today*`;
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

    const parsed = /^undo$/i.test(body.trim())
      ? { intent: "undo", items: [], parse_notes: "literal undo" }
      : await parseMeal(body);

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
      const deleted = await deleteLastLog(from);
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
      // Name-match each corrected food across today's log; fall back to the
      // last-batch delete only when nothing matches (e.g. "sorry it was rajma").
      const aligned = await deleteMatching(from, parsed.items.map(i => i.food_name));
      const deleted = aligned ? aligned.filter(Boolean)
        : await deleteLastLog(from, parsed.items.length === 1 ? parsed.items[0].food_name : null);
      // Unnamed correction ("it was 220 cals 25g protein"): restore the food's
      // name from the row being replaced instead of logging "Unknown".
      if (deleted && deleted.length === 1 && parsed.items.length === 1 &&
          /^(unknown|meal|it|food|item)?$/i.test(String(parsed.items[0].food_name || "").trim())) {
        parsed.items[0].food_name = deleted[0].food_name;
      }
      // Protein-only correction ("yogurt was 22g protein"): keep the replaced
      // row's identity and calories — only the protein changes. Without this the
      // parser can re-match the name to a different food (yogurt -> Curd/Dahi).
      if (aligned) {
        parsed.items.forEach((it, i) => {
          const old = aligned[i];
          if (old && Number(it.stated_protein) > 0 && !Number(it.stated_kcal)) {
            it.food_name = old.food_name;
            it.matched_db_id = old.matched_db_id;
            it.quantity = Number(old.quantity) || 1;
            it.stated_kcal = Math.round(Number(old.kcal) / (Number(old.quantity) || 1));
            it.grams = null;
          }
        });
      }
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
    twiml.message(
      `✅ Logged\n${fmtItems(rows).join("\n")}\n\n` +
      (ass.length ? `${ass.join("\n")}\n\n` : "") +
      `Meal ${meals.length} — ${cur.kcal} kcal · ${cur.protein}g protein\n` +
      `${dayLine(totals)}\n${cfLine(totals)}`
      + (result.isNewUser ? FIRST_LOG_FOOTER : "")
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
