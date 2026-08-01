// Per-user correction memory — pure logic.
//
// A user who tells us their oats are 26g protein should not have to tell us
// again tomorrow. One real user restated the same figure on five consecutive
// days because nothing remembered it. CLAUDE.md rule 1 says a food-level answer
// is remembered permanently; for macros it never was.
//
// Scope is deliberately narrow. This remembers a NUMBER the user stated about a
// FOOD, for THAT user only. It never writes back to the shared tiers: one
// person's label reading is not everyone's nutrition truth, and a single wrong
// correction propagated globally would be far worse than the repetition it
// fixes.
//
// No database access here — src/db.js does the I/O.

// What the bot logged it AS, normalised. Keying on the resolved name rather
// than the typed text means "yogabar oats", "yogabar high protein oats" and
// "105 gm yogabar high protein oats" all land on the same memory.
function foodKey(resolvedName) {
  return String(resolvedName || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")   // drop "(Dark Chocolate)" — flavour is not nutrition
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .sort()                        // word order shouldn't split a memory
    .join(" ");
}

// Per-unit figures, so a memory set on "1 serving" scales to tomorrow's 2.
// Rows resolved by grams already carry per-gram-block values, so those are
// stored as-is against the gram unit.
function perUnit(row) {
  const q = Number(row && row.quantity) > 0 ? Number(row.quantity) : 1;
  const protein = Number(row && row.protein);
  const kcal = Number(row && row.kcal);
  return {
    protein_per_unit: Number.isFinite(protein) ? +(protein / q).toFixed(2) : null,
    kcal_per_unit: Number.isFinite(kcal) ? +(kcal / q).toFixed(1) : null,
    unit: (row && row.unit) || "serving",
  };
}

// Only remember a deliberate, plausible statement about a real food.
function worthRemembering(row) {
  if (!row || !row.stated) return false;               // the user gave the number
  if (!row.food_name || row.food_name === "meal") return false; // not a placeholder
  const { protein_per_unit, kcal_per_unit } = perUnit(row);
  if (!Number.isFinite(protein_per_unit) && !Number.isFinite(kcal_per_unit)) return false;
  // Absurd values are far more likely a parse artefact than a real label.
  if (protein_per_unit != null && (protein_per_unit < 0 || protein_per_unit > 200)) return false;
  if (kcal_per_unit != null && (kcal_per_unit < 0 || kcal_per_unit > 2000)) return false;
  return true;
}

function toMemoryRow(phone, row) {
  const { protein_per_unit, kcal_per_unit, unit } = perUnit(row);
  return {
    phone_number: phone,
    food_key: foodKey(row.food_name),
    food_name: row.food_name,
    protein_per_unit,
    kcal_per_unit,
    unit,
  };
}

// Do the memory and the row describe the same portion?
//
// Unit equality alone is too strict: the same food logged as "105 gm yogabar
// oats" and "yogabar oats 105g" resolved to unit "bowl" and unit "serving"
// respectively — identical 202 kcal portions with different labels — and the
// memory silently stopped applying, which is the whole bug it exists to fix.
//
// The kcal basis is the honest signal. If one unit of each carries about the
// same energy, they are the same portion whatever it is called; if they differ
// (a 120 kcal scoop vs a 400 kcal 100g serving) they are not, and applying the
// memory would corrupt the row. Falls back to the unit label only when there
// is no energy to compare.
const BASIS_TOLERANCE = 0.15;
function sameBasis(row, mem, q) {
  const memK = Number(mem.kcal_per_unit);
  const rowK = Number(row.kcal) / q;
  if (Number.isFinite(memK) && memK > 0 && Number.isFinite(rowK) && rowK > 0) {
    return Math.abs(memK - rowK) / Math.max(memK, rowK) <= BASIS_TOLERANCE;
  }
  if (mem.unit && row.unit) return String(mem.unit) === String(row.unit);
  return true;
}

// Apply a remembered figure to a freshly resolved row. Mutates and returns it.
//
// Sets `stated` so the rest of the pipeline treats it exactly like a value the
// user just typed — which matters, because suspect arbitration overwrites rows
// that are not marked stated. That was the bug that made corrections appear to
// silently fail; a memory that is not stated-marked would reproduce it.
function applyMemory(row, mem) {
  if (!row || !mem) return row;
  const q = Number(row.quantity) > 0 ? Number(row.quantity) : 1;
  if (!sameBasis(row, mem, q)) return row;

  const p = Number(mem.protein_per_unit);
  if (Number.isFinite(p) && p >= 0) {
    const newP = +(p * q).toFixed(1);
    if (Math.abs(newP - Number(row.protein || 0)) >= 0.5) {
      row.protein = newP;
      row.memoryApplied = true;
    }
  }
  const k = Number(mem.kcal_per_unit);
  if (Number.isFinite(k) && k > 0) {
    const newK = Math.round(k * q);
    if (Math.abs(newK - Number(row.kcal || 0)) >= 1) {
      row.kcal = newK;
      row.memoryApplied = true;
    }
  }
  if (row.memoryApplied) {
    row.stated = true;
    row.is_estimate = false;
    row.assumed = false;
    row.memoryName = mem.food_name;
  }
  return row;
}

// Shown when a memory fires. The user must be able to see it happened and undo
// it — a silent permanent override of their nutrition data would be worse than
// the repetition, since a single mistaken correction would then be invisible
// forever.
function memoryNote(row) {
  if (!row || !row.memoryApplied) return null;
  // Suggest a SHORT handle rather than echoing the full resolved name — nobody
  // is going to type "forget Yogabar High Protein Oats (Dark Chocolate)". The
  // forget lookup matches on a subset of the stored words, so the first couple
  // of distinctive ones resolve to the same memory.
  const short = String(row.memoryName || "")
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/).filter(w => w.length > 2).slice(0, 2).join(" ") || row.memoryName;
  return `\u{1F9E0} _Using your correction for *${row.memoryName}* `
    + `(${Math.round(Number(row.protein) || 0)}g protein). Reply "forget ${short}" to reset._`;
}

// "forget yogabar oats" / "reset yogabar oats"
function parseForgetRequest(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const m = /^(?:forget|reset|unlearn)\s+(?:my\s+)?(?:correction\s+for\s+)?(.+)$/.exec(s);
  if (!m || !m[1]) return null;
  const target = m[1].trim();
  if (!target || target.length < 3) return null;
  return { action: "forget", target, key: foodKey(target) };
}

// Applying a memory needs an exact key — precision matters when silently
// changing someone's numbers. Forgetting one does not: a user typing "forget
// yogabar oats" means the memory stored as "high oats protein yogabar", and
// refusing on a word mismatch would strand them with a correction they can see
// but cannot remove. So match on subset, and only act when it is unambiguous.
function findForgetTarget(memories, key) {
  const wanted = String(key || "").split(" ").filter(Boolean);
  if (!wanted.length) return { match: null, ambiguous: false };
  const hits = (memories || []).filter(m => {
    const have = new Set(String(m.food_key || "").split(" ").filter(Boolean));
    return wanted.every(w => have.has(w));
  });
  if (hits.length === 1) return { match: hits[0], ambiguous: false };
  if (hits.length > 1) return { match: null, ambiguous: true, candidates: hits };
  return { match: null, ambiguous: false };
}

module.exports = {
  foodKey, perUnit, worthRemembering, toMemoryRow,
  applyMemory, memoryNote, parseForgetRequest, findForgetTarget, sameBasis,
};
