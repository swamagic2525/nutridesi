// NutriDesi — single synchronous Twilio webhook.
// Twilio POST -> parse with Claude -> log to Supabase -> reply inline via TwiML.
// Claude Haiku responds in ~1-3s, well within Twilio's 15s window, so no async queue needed.

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { parseMeal } = require("./src/parser.js");
const { logMeal, deleteLastLog, todayTotal, ensureUser } = require("./src/db.js");

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

const WELCOME =
  "\u{1F64F} Hey! Thanks for being an early tester of NutriDesi.\n\n" +
  "I track calories right here in WhatsApp \u2014 no app, no signup. Just text me what you ate:\n" +
  "\u2022 \"2 roti and dal\"\n" +
  "\u2022 \"100g rice, 200g chicken\"\n" +
  "\u2022 \"1 scoop whey\"\n\n" +
  "I'll reply with calories + protein/carbs/fat/fibre and your day's running total.\n\n" +
  "Fix mistakes anytime:\n" +
  "\u21A9\uFE0F \"undo\" removes the last entry\n" +
  "\u270F\uFE0F or just correct me \u2014 \"that dosa was 120 calories\"\n\n" +
  "\u2014 Swapnil \u{1F44B} full-time PM & ex-fitness coach. My clients kept quitting tracking apps, so I'm " +
  "building this where you already are. Bigger, faster version lands in ~30 days \u2014 and your feedback " +
  "shapes it: DM me on Instagram @swapnilgore2525, I read everything.";

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

    const macros = (o) => `P${Math.round(o.protein)}g C${Math.round(o.carbs)}g F${Math.round(o.fat)}g Fb${Math.round(o.fiber || 0)}g`;
    const fmtItems = (rows) => rows.map(r => {
      const est = r.is_estimate ? " (est.)" : "";
      const qty = r.quantity === 1 ? "" : `${r.quantity}x `;
      // Show macros for curated-DB and INDB-reference hits; hide zeros on bare placeholders.
      const m = (r.matched_db_id || r.protein + r.carbs + r.fat > 0) ? ` (${macros(r)})` : "";
      return `${qty}${r.food_name} — ${r.kcal} kcal${m}${est}`;
    });

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

    const parsed = /^undo$/i.test(body.trim())
      ? { intent: "undo", items: [], parse_notes: "literal undo" }
      : await parseMeal(body);

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
        `Today: ${total.kcal} kcal · ${macros(total)}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent === "replace_last") {
      if ((parsed.items || []).length === 0) {
        twiml.message("Couldn't identify the corrected food — previous entry unchanged. Send the food name again.");
        return res.type("text/xml").send(twiml.toString());
      }
      const deleted = await deleteLastLog(from, parsed.items.length === 1 ? parsed.items[0].food_name : null);
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
      const mealLine = meals.map((k, i) => `Meal ${i + 1}: ${k}`).join(" · ");
      twiml.message(
        `🔄 Corrected:\n${removedLines}\n${addedLines.join("\n")}\n\n${mealLine} kcal\n` +
        `Today: ${totals.kcal} kcal · ${macros(totals)}`
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
    const lines = fmtItems(rows);
    const mealLine = meals.map((k, i) => `Meal ${i + 1}: ${k}`).join(" · ");
    twiml.message(
      `✅ Logged:\n${lines.join("\n")}\n\n${mealLine} kcal\n` +
      `Today: ${totals.kcal} kcal · ${macros(totals)}\n` +
      `_P protein · C carbs · F fat · Fb fibre (grams) · same meal if within 45 min_`
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
