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
    .replace(/^\s*\d+(?:\.\d+)?\s*(?:g|ml)\b\s*/, "")
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
  const displayName = String(row && row.food_name || "")
    .replace(/^\s*\d+(?:\.\d+)?\s*(?:g|ml)\b\s*/i, "");
  const base = {
    phone_number: phone,
    food_key: foodKey(displayName),
    food_name: displayName,
    protein_per_unit,
    kcal_per_unit,
    unit,
  };
  const basisAmount = Number(row && row.nutritionBasisAmount);
  const basisUnit = String(row && row.nutritionBasisUnit || "").toLowerCase();
  if (!(basisAmount > 0) || !basisUnit) return base;

  const portionAmount = Number(row.portionAmount);
  const portionScale = portionAmount > 0 && ["g", "ml"].includes(basisUnit)
    ? portionAmount / basisAmount
    : (Number(row.quantity) > 0 ? Number(row.quantity) : 1) / basisAmount;
  const confirmedProtein = Number(row.userConfirmedProteinPerBasis);
  const confirmedKcal = Number(row.userConfirmedKcalPerBasis);
  const kcalFromResolved = portionScale > 0 && Number.isFinite(Number(row.kcal))
    ? +(Number(row.kcal) / portionScale).toFixed(1) : null;
  const proteinPerBasis = Number.isFinite(confirmedProtein) && confirmedProtein > 0
    ? confirmedProtein : null;
  const kcalPerBasis = Number.isFinite(confirmedKcal) && confirmedKcal > 0
    ? confirmedKcal : kcalFromResolved;
  const assertions = [];
  if (proteinPerBasis != null) assertions.push(`${proteinPerBasis}g protein`);
  if (Number.isFinite(confirmedKcal) && confirmedKcal > 0) assertions.push(`${confirmedKcal} kcal`);
  return {
    ...base,
    basis_amount: basisAmount,
    basis_unit: basisUnit,
    protein_per_basis: proteinPerBasis,
    protein_provenance: proteinPerBasis != null ? "user_confirmed" : null,
    kcal_per_basis: kcalPerBasis,
    kcal_provenance: Number.isFinite(confirmedKcal) && confirmedKcal > 0
      ? "user_confirmed" : row.sourceKind === "estimate" ? "parser_inferred" : "catalog",
    source_assertion: assertions.length
      ? `${assertions.join(", ")} per ${basisAmount}${basisUnit}` : null,
    source_kind: row.sourceKind || null,
    source_ref: row.sourceRef || null,
    status: "active",
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
  if (mem.status && mem.status !== "active") return row;
  // New basis-aware rows are exact by product variant. The caller already
  // indexes memories by key; checking again here keeps the pure function safe
  // when used directly and prevents a Chocolate label reaching Mango oats.
  if (Number(mem.basis_amount) > 0 && mem.basis_unit) {
    if (mem.food_key && mem.food_key !== foodKey(row.food_name)) return row;
    const basisAmount = Number(mem.basis_amount);
    const basisUnit = String(mem.basis_unit).toLowerCase();
    const portionAmount = Number(row.portionAmount);
    const portionUnit = String(row.portionUnit || "").toLowerCase();
    let scale = null;
    if (["g", "ml"].includes(basisUnit)) {
      if (portionAmount > 0 && portionUnit === basisUnit) scale = portionAmount / basisAmount;
    } else if (String(row.unit || "").toLowerCase() === basisUnit) {
      scale = (Number(row.quantity) > 0 ? Number(row.quantity) : 1) / basisAmount;
    }
    if (!(scale > 0)) return row;

    const applyField = (field, valueKey, provenanceKey, round) => {
      const provenance = mem[provenanceKey];
      if (!['user_confirmed', 'parser_inferred'].includes(provenance)) return;
      const value = Number(mem[valueKey]);
      if (!Number.isFinite(value) || value < 0) return;
      const next = round(value * scale);
      if (Math.abs(next - Number(row[field] || 0)) < (field === "protein" ? 0.05 : 0.5)) return;
      row[field] = next;
      row.memoryApplied = true;
      row[`${field}Provenance`] = provenance;
    };
    applyField("protein", "protein_per_basis", "protein_provenance", n => +n.toFixed(1));
    applyField("kcal", "kcal_per_basis", "kcal_provenance", Math.round);
    if (row.memoryApplied) {
      row.stated = true;
      row.is_estimate = false;
      row.assumed = false;
      row.memoryName = mem.food_name;
      row.memoryBasisAmount = basisAmount;
      row.memoryBasisUnit = basisUnit;
      row.memoryProteinPerBasis = Number(mem.protein_per_basis);
    }
    return row;
  }
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
  const basisProtein = Number(row.memoryProteinPerBasis);
  const basisAmount = Number(row.memoryBasisAmount);
  const proteinLabel = Number.isFinite(basisProtein) && basisAmount > 0 && row.memoryBasisUnit
    ? `${fmtNumber(basisProtein)}g protein per ${fmtNumber(basisAmount)}${row.memoryBasisUnit}`
    : `${Math.round(Number(row.protein) || 0)}g protein`;
  return `\u{1F9E0} _Using your correction for *${row.memoryName}* `
    + `(${proteinLabel}). Reply "forget ${short}" to reset._`;
}

// "forget yogabar oats" / "reset yogabar oats"
function parseForgetRequest(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const m = /^(?:forget|reset|unlearn)\s+(?:my\s+)?(?:correction\s+for\s+)?(.+)$/.exec(s);
  if (!m || !m[1]) return null;
  const target = m[1].trim();
  if (/^\d+$/.test(target)) return { action: "forget", target, index: Number(target) };
  if (!target || target.length < 3) return null;
  return { action: "forget", target, key: foodKey(target) };
}

function parseMemoryListRequest(text) {
  const s = String(text || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:my|show|list|saved|show my|list my) (?:food )?(?:corrections|memories)$/.test(s)
    || /^(?:what|which) do you remember(?: about my food)?$/.test(s);
}

const fmtNumber = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(2));
};

function formatMemories(memories) {
  const active = (memories || []).filter(m => !m.status || m.status === "active");
  if (!active.length) return "🧠 I haven't saved any food corrections yet.";
  const lines = ["🧠 *Your saved food corrections*"];
  active.forEach((m, i) => {
    lines.push("", `${i + 1}. *${m.food_name}*`);
    const amount = fmtNumber(m.basis_amount);
    const basis = amount && m.basis_unit ? `${amount}${m.basis_unit}` : "serving";
    const protein = fmtNumber(m.protein_per_basis);
    const kcal = fmtNumber(m.kcal_per_basis);
    if (protein != null) lines.push(`   Protein: *${protein}g protein per ${basis}* — ${m.protein_provenance === "user_confirmed" ? "confirmed by you" : "estimated"}`);
    if (kcal != null) {
      const label = m.kcal_provenance === "user_confirmed" ? "confirmed by you"
        : m.kcal_provenance === "catalog" ? "catalog" : "estimated";
      lines.push(`   Calories: *${kcal} kcal per ${basis}* — ${label}`);
    }
  });
  lines.push("", 'Reply *“forget 1”* to remove one. To change it, send the food and corrected label value.');
  return lines.join("\n");
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
  parseMemoryListRequest, formatMemories,
};
