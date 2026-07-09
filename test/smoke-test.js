// Offline-ish smoke test: runs 10 phrases through the parser and prints match_type + kcal.
// Spaces requests (~2.5s apart) to stay under Gemini free-tier RPM limits.
// Requires GEMINI_API_KEY (or ANTHROPIC_API_KEY if LLM_PROVIDER=claude). No Twilio/Supabase needed.
require("dotenv").config();
const { parseMeal, PROVIDER } = require("../src/parser.js");
const { FOOD_BY_ID } = require("../src/foods.js");

const DELAY_MS = Number(process.env.SMOKE_DELAY_MS || 14000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHRASES = [
  "2 roti and dal makhani",        // Q1 clean slam
  "3 idli with sambar",            // Q1
  "ek cup full fat milk",          // Q1
  "*2 parathas* with amul butter", // Q2 modifier + markdown strip
  "thodi si rice with ghee",       // Q2 loose qty + modifier
  "had some dal",                  // Q3 ambiguous
  "veg sabzi",                     // Q3 category
  "chicken rezala",                // Q4 landmine (not in DB)
  "sol kadhi",                     // Q4 landmine
  "unlimited",                     // Q4 no food -> items []
];

function kcalFor(item) {
  const q = item.quantity || 1;
  const f = item.matched_db_id ? FOOD_BY_ID[item.matched_db_id] : null;
  return f ? Math.round(f.kcal * q) : 300;
}

(async () => {
  const MODEL_ENV = { groq: process.env.GROQ_MODEL, gemini: process.env.GEMINI_MODEL, claude: process.env.CLAUDE_MODEL };
  console.log(`Provider: ${PROVIDER} | model: ${MODEL_ENV[PROVIDER] || "(default)"}\n`);
  for (const p of PHRASES) {
    try {
      const r = await parseMeal(p);
      const summary = (r.items || []).map(i =>
        `${i.food_name}[${i.match_type}/${i.portion_clarity} q${i.quantity} ${kcalFor(i)}kcal]`
      ).join(" + ") || "(no items)";
      console.log(`"${p}"\n   -> ${summary}\n`);
    } catch (e) {
      console.log(`"${p}"\n   -> ERROR ${e.message}\n`);
    }
    await sleep(DELAY_MS); // stay under free-tier RPM
  }
})();
