// Mine the INDB reference table (1,014 lab-analyzed recipes) for popular dishes
// not yet in the curated foods.js list. Output: ready-to-review foods.js
// candidate lines with INDB serving nutrition. Human reviews before promotion
// (rules/db-gap-pipeline.md) — this script never writes to foods.js itself.
//
// Usage: node scripts/mine-indb.js [> candidates.txt]
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { FOODS } = require("../src/foods.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Dishes Indians actually order/cook most (Swiggy/Zomato year-in-review staples
// + home staples), used only to RANK candidates — values still come from INDB.
const POPULAR = [
  // breakfast / tiffin
  "poha", "upma", "idli", "dosa", "vada", "uttapam", "paratha", "thepla", "chilla", "cheela",
  "appam", "puttu", "sheera", "sabudana", "misal", "pav bhaji", "vada pav", "dabeli", "poori",
  // dal / curry / sabzi
  "rajma", "chole", "chana", "sambar", "kadhi", "korma", "kofta", "bhindi", "baingan",
  "aloo gobi", "aloo matar", "matar paneer", "palak paneer", "kadai", "do pyaza", "handi",
  "undhiyu", "avial", "thoran", "poriyal", "usal",
  // non-veg
  "chicken curry", "butter chicken", "chicken tikka", "tandoori", "chicken 65", "chilli chicken",
  "keema", "mutton curry", "rogan josh", "fish curry", "fish fry", "prawn", "egg curry",
  "omelette", "kebab", "seekh", "shawarma", "biryani", "haleem", "nihari", "korma",
  // rice / breads
  "pulao", "fried rice", "khichdi", "curd rice", "lemon rice", "tamarind rice", "bisi bele",
  "naan", "kulcha", "bhatura", "roti", "makki", "sarson",
  // snacks / street
  "samosa", "kachori", "pakora", "bhajiya", "cutlet", "spring roll", "momos", "manchurian",
  "noodles", "chaat", "bhel", "sev puri", "pani puri", "dahi vada", "frankie", "roll",
  "sandwich", "burger", "pizza", "maggi",
  // sweets / drinks
  "gulab jamun", "jalebi", "rasgulla", "halwa", "kheer", "ladoo", "barfi", "lassi",
  "milkshake", "falooda", "kulfi", "shrikhand", "basundi", "payasam",
];

const norm = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

// A recipe is "covered" when a curated alias (2+ chars, whole-word) accounts for
// the whole normalized recipe name, or the name equals a curated name.
const CURATED = FOODS.flatMap(f => [f.name, ...f.aliases]).map(norm);
const CURATED_SET = new Set(CURATED);

function covered(name) {
  const n = norm(name);
  if (CURATED_SET.has(n)) return true;
  // e.g. "Roti/Chapati (Whole wheat)" -> "roti chapati whole wheat": every word
  // present in some single curated entry's corpus = already represented.
  return FOODS.some(f => {
    const corpus = norm(`${f.name} ${f.aliases.join(" ")}`);
    return words(n).every(w => corpus.includes(w));
  });
}

(async () => {
  const { data, error } = await supabase.from("foods_reference")
    .select("id, food_name, serving_unit, serving_kcal, serving_protein, serving_carbs, serving_fat, serving_fibre, kcal_100g")
    .order("id");
  if (error) { console.error(error.message); process.exit(1); }

  const candidates = [];
  for (const r of data) {
    if (covered(r.food_name)) continue;
    const n = norm(r.food_name);
    const hit = POPULAR.find(p => n.includes(p));
    if (!hit) continue;
    // Only trust plausible single-portion servings (same rule as applyReference).
    if (!(r.serving_kcal >= 20 && r.serving_kcal <= 800)) continue;
    candidates.push({ rank: POPULAR.indexOf(hit), hit, ...r });
  }
  candidates.sort((a, b) => a.rank - b.rank);

  console.log(`# INDB candidates not covered by foods.js (${candidates.length} of ${data.length})`);
  console.log(`# Format: ready-to-paste foods.js lines — REVIEW before adding (aliases need Hinglish pass)\n`);
  for (const c of candidates) {
    const unit = /katori|bowl/i.test(c.serving_unit) ? "katori" : /piece|number/i.test(c.serving_unit) ? "piece" : /cup/i.test(c.serving_unit) ? "cup" : /plate/i.test(c.serving_unit) ? "plate" : "serving";
    console.log(`// INDB ${c.food_code || c.id}: ${c.food_name} | serving_unit: ${c.serving_unit} | matched keyword: ${c.hit}`);
    console.log(`{ name: ${JSON.stringify(c.food_name)}, aliases: [${JSON.stringify(norm(c.food_name))}], unit: ${JSON.stringify(unit)}, kcal: ${Math.round(c.serving_kcal)}, p: ${+Number(c.serving_protein).toFixed(1)}, c: ${+Number(c.serving_carbs).toFixed(1)}, f: ${+Number(c.serving_fat).toFixed(1)}, fb: ${+Number(c.serving_fibre || 0).toFixed(1)} },\n`);
  }
})();
