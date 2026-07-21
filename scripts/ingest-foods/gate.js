// Returns a rejection reason string, or null if the row passes every gate.
function gateReason(rec) {
  const { name, kcal, p, c, f, grams, kcal_100g } = rec;
  if (![kcal, p, c, f].every(x => Number.isFinite(x))) return "non_finite_value";
  if ([kcal, p, c, f].some(x => x < 0)) return "negative_value";
  if (!Number.isFinite(grams) || grams <= 0) return "no_grams";
  const derived = p * 4 + c * 4 + f * 9;
  if (kcal > 0 && Math.abs(derived - kcal) / kcal > 0.30) return "macro_cal_mismatch";
  // Only a ceiling: nothing edible exceeds pure fat (~900/100g). No low floor —
  // 0-cal items (Coke Zero, creatine, green tea) are valid, not parse errors.
  if (!Number.isFinite(kcal_100g) || kcal_100g > 900) return "absurd_density";
  const n = String(name || "").trim();
  if (!n || n.length > 80 || !/[a-z]/i.test(n)) return "bad_name";
  // Nested parens are the combinatorial-permutation spam signature
  // ("... (South Indian Tempering (Mustard & Curry Leaves)))"). Two separate
  // parens like "ON Whey (Gold) (Chocolate)" are fine and don't match.
  if (/\([^()]*\(/.test(n)) return "spam_name";
  return null;
}

module.exports = { gateReason };
