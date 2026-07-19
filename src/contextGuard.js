// Context guard: every content word in the user's food phrase must be
// explained by the matched curated entry. Catches within-category wrong-ID
// picks the protein guard can't see ("sev puri" logged as plain Puri).
// Three outcomes, checked in order per item:
//   alias_arbitrated - one alias of ANOTHER food covers the whole phrase;
//                      exact alias evidence beats the LLM's pick, rematch.
//   compound_suspect - the phrase splits into two disjoint aliases
//                      ("chole puri") - don't guess which half wins,
//                      let INDB arbitrate in resolveRows.
//   coverage_suspect - leftover content words the matched food's
//                      name+aliases don't contain ("methi puri" on Puri) -
//                      let INDB arbitrate in resolveRows.
const { FOODS, FOOD_BY_ID } = require("./foods.js");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (p) => new RegExp(`\\b${esc(p)}\\b`);
const hasWord = (text, phrase) => wordRe(phrase).test(text);

// Longest alias first so "sev puri" beats "puri".
const ALIASES = FOODS.flatMap(f => f.aliases.map(a => ({ a: a.toLowerCase(), id: f.id })))
  .sort((x, y) => y.a.length - x.a.length);

// Words that carry no dish identity: grammar glue, cooking adjectives,
// quantity words, serving units. Anything NOT here is treated as identity.
const FILLER = new Set([
  "ka", "ki", "ke", "wala", "wali", "with", "and", "aur", "of", "the", "a", "an",
  "hot", "cold", "fresh", "garam", "thoda", "thodi", "sa", "si", "plain", "simple",
  "homemade", "ghar", "normal", "small", "big", "chota", "bada",
  "ek", "one", "two", "do", "teen", "three", "half", "adha",
  "bowl", "katori", "plate", "glass", "piece", "pieces", "cup", "slice",
]);

const contentTokens = (text) => String(text || "").toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(w => w && !FILLER.has(w) && !/^\d+$/.test(w));

function contextGuard(items) {
  for (const it of items || []) {
    if (!it.matched_db_id || !it.food_name) continue;
    const food = FOOD_BY_ID[it.matched_db_id];
    if (!food) continue;
    const t = String(it.food_name).toLowerCase();
    const best = ALIASES.find(({ a }) => hasWord(t, a));
    if (best) {
      const remTokens = contentTokens(t.replace(wordRe(best.a), " "));
      if (remTokens.length === 0) {
        // One alias explains the whole phrase - it IS the identity.
        if (best.id !== it.matched_db_id) {
          it.matched_db_id = best.id;
          it.alias_arbitrated = true;
        }
        continue;
      }
      if (ALIASES.some(({ a }) => hasWord(remTokens.join(" "), a))) {
        it.compound_suspect = true;
        continue;
      }
    }
    // Leftovers vs the matched food's whole corpus - word-order variants of a
    // correct match ("makhani dal" on Dal Makhani) stay quiet.
    const corpus = `${food.name} ${food.aliases.join(" ")}`.toLowerCase();
    const leftover = contentTokens(t).filter(w => !corpus.includes(w));
    if (leftover.length) it.coverage_suspect = leftover;
  }
  return items;
}

module.exports = { contextGuard, contentTokens, FILLER };
