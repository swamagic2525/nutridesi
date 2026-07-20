// Deterministic post-parse guard: the LLM must never match a food across a
// protein boundary ("chicken paratha" -> veg Paratha (Stuffed)). Runs before
// nutrition resolution; a tripped item falls through to the INDB reference
// lookup (Tier 2.5) instead of the wrong curated entry.
const { FOOD_BY_ID } = require("./foods.js");

// Hinglish synonyms collapse into one group so "murgh" == "chicken".
const PROTEIN_GROUPS = {
  chicken: ["chicken", "murgh", "murg"],
  mutton: ["mutton", "gosht", "lamb"],
  keema: ["keema", "qeema", "kheema", "mince"],
  egg: ["egg", "eggs", "anda", "ande", "anday", "omelette", "omelet"],
  fish: ["fish", "machli", "machhi", "surmai", "pomfret", "bangda"],
  prawn: ["prawn", "prawns", "jhinga", "shrimp"],
  beef: ["beef"],
  pork: ["pork", "bacon", "ham"],
};

// A negated mention is not a protein mention. Without this the guard reads
// "Mayonnaise without eggs" as an egg food and waves an egg query straight
// through to it (2026-07-20 incident: "2 eggs" -> 988 kcal of mayonnaise).
function stripNegated(text, word) {
  return text
    .replace(new RegExp(`\\b(?:without|no|sans|excluding|free\\s+of)\\s+(?:\\w+\\s+){0,2}?${word}\\b`, "g"), " ")
    .replace(new RegExp(`\\b${word}\\s*-?\\s*(?:free|less)\\b`, "g"), " ")
    .replace(new RegExp(`\\b${word}less\\b`, "g"), " ");
}

function extractGroups(text) {
  const t0 = String(text || "").toLowerCase();
  const found = new Set();
  for (const [group, words] of Object.entries(PROTEIN_GROUPS)) {
    for (const w of words) {
      if (new RegExp(`\\b${w}\\b`).test(stripNegated(t0, w))) { found.add(group); break; }
    }
  }
  return found;
}

const saysVeg = (text) => /\b(veg|vegetarian|shakahari)\b/i.test(String(text || ""));

function guardItems(items) {
  const tripped = [];
  for (const it of items || []) {
    if (!it.matched_db_id || !it.food_name) continue;
    const food = FOOD_BY_ID[it.matched_db_id];
    if (!food) continue;
    const t = String(it.food_name).toLowerCase();
    const u = extractGroups(t);
    const f = extractGroups(`${food.name} ${food.aliases.join(" ")}`);
    // User named a protein the matched food doesn't have (mutton -> chicken item,
    // fish -> veg item), or explicitly said veg against a non-veg item.
    const mismatch = [...u].some(g => !f.has(g));
    const vegClash = saysVeg(t) && f.size > 0;
    // Reverse: matched a non-veg item the user never asked for, and no alias of
    // that item appears in their words. Alias containment keeps deliberate
    // defaults alive ("bhurji" -> Egg Bhurji is an alias, so no trip). Bare
    // category words otherwise default to the VEG variant via the alias map
    // ("biryani" is an alias of Biryani (Veg), not Chicken Biryani).
    const reverseClash = u.size === 0 && !saysVeg(t) && f.size > 0
      && !food.aliases.some(a => t.includes(a));
    if (mismatch || vegClash || reverseClash) {
      it.matched_db_id = null;
      it.match_type = "none";
      it.protein_guard = true;
      tripped.push(it);
    }
  }
  return tripped;
}

module.exports = { guardItems, extractGroups };
