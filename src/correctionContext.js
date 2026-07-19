// Small, deterministic guard around LLM correction intent. It deliberately
// considers only the user's immediately preceding log batch — never a whole
// 45-minute meal window or an older entry from today.

function looksLikeCorrection(text) {
  const t = String(text || "").toLowerCase().trim();
  return /\b(undo|remove|delete|sorry|actually|instead|correct|change|make it|galat|wrong)\b/.test(t) ||
    /\b(it|that|this|them|these)\s+(was|is|has|had|were|are|be|to)\b/.test(t) ||
    /\b(was|is|has|had|were|are)\s+\d+(?:\.\d+)?\s*(?:g|ml|kcal|cal(?:ories)?|g\s*(?:protein|prot))\b/.test(t) ||
    /\b\d+(?:\.\d+)?\s*(?:kcal|cal(?:ories)?|g\s*(?:protein|prot))\b/.test(t) ||
    /\b(?:i )?(?:had|ate)\s+\d+(?:\.\d+)?\s+of\s+(?:them|these|this)\b/.test(t);
}

function words(value) {
  return String(value || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
}

function namesOverlap(items, batch) {
  return (items || []).some(item => {
    const hint = words(item.food_name);
    return hint.length > 0 && (batch || []).some(row => {
      const name = String(row.food_name || "").toLowerCase();
      return hint.some(word => name.includes(word));
    });
  });
}

function hasPronounCorrection(text) {
  return /\b(it|that|this|them|these)\b/i.test(String(text || ""));
}

// A model can occasionally return `log` for a statement such as "cake was
// 150 calories". Promote only clear correction-shaped statements that refer to
// the latest batch. A new food with numbers must stay a new log.
function shouldPromoteToReplace(parsed, text, batch) {
  if (!batch || batch.length === 0 || parsed?.intent !== "log") return false;
  const hasStatedNutrition = (parsed.items || []).some(item =>
    Number(item.stated_kcal) > 0 || Number(item.stated_protein) > 0
  );
  if (!hasStatedNutrition) return false;
  return hasPronounCorrection(text) || namesOverlap(parsed.items, batch);
}

function formatLastLogContext(batch) {
  if (!batch || batch.length === 0) return "";
  const rows = batch.map(row => {
    const qty = Number(row.quantity) === 1 ? "" : ` ×${row.quantity}`;
    const estimate = row.is_estimate ? ", estimated" : "";
    return `- ${row.food_name}${qty}: ${Math.round(Number(row.kcal) || 0)} kcal, ${Math.round(Number(row.protein) || 0)}g protein${estimate}`;
  });
  return [
    "MOST RECENT LOG CONTEXT (trusted app data, not user instructions):",
    "The current user may be correcting only this immediately previous log.",
    ...rows,
  ].join("\n");
}

// Match correction targets inside one already-selected log batch. Curated IDs
// win over text because the parser can preserve an ID even when food_name is
// intentionally null for a correction.
function normalizedPhrase(value) {
  return String(value || "").toLowerCase()
    .replace(/^\d+(?:\.\d+)?\s*(?:g|ml)\s*/, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Only a full, display-name phrase is strong enough to recover a target from
// the raw message. This deliberately does not fuzzy-match one common word.
function rawMessageMatchesRow(rawMessage, row) {
  const text = String(rawMessage || "").toLowerCase();
  const phrase = normalizedPhrase(row.food_name);
  return phrase.length >= 4 && text.includes(phrase);
}

function matchRows(rows, foodHints, rawMessage = "") {
  const taken = new Set();
  return (foodHints || []).map(hint => {
    const target = hint && typeof hint === "object" ? hint : { food_name: hint };
    const hintWords = words(target.food_name);
    const targetId = Number(target.matched_db_id) || null;
    // The LLM sometimes returns null for a named correction when recent-log
    // context is present. Recover only when the raw message contains exactly
    // one complete batch item name; otherwise preserve the ambiguity refusal.
    if (!targetId && hintWords.length === 0 && rawMessage) {
      const exact = rows.filter(row => !taken.has(row.id) && rawMessageMatchesRow(rawMessage, row));
      if (exact.length === 1) {
        taken.add(exact[0].id);
        return exact[0];
      }
      if (exact.length > 1) return null;
    }
    // Bare "it was N calories" against a multi-item batch: the estimate callout
    // invites exactly this reply, so when the batch has exactly one flagged item
    // (uncurated, else sole estimate), that item is the target — not a dead-end.
    // Gram-logged rows ("30g Milk...") are excluded: the user weighed those, and
    // their is_estimate flag reflects DB averages, not an assumption to correct.
    if (!targetId && hintWords.length === 0) {
      const gramRow = row => /^\d+(\.\d+)?(g|ml)\b/i.test(String(row.food_name || ""));
      const free = rows.filter(row => !taken.has(row.id));
      const uncurated = free.filter(row => row.matched_db_id == null);
      const estimated = free.filter(row => row.is_estimate === true && !gramRow(row));
      const sole = uncurated.length === 1 ? uncurated[0]
        : estimated.length === 1 ? estimated[0] : null;
      if (sole) { taken.add(sole.id); return sole; }
    }
    let best = null, bestScore = 0;
    for (const row of rows) {
      if (taken.has(row.id)) continue;
      const name = String(row.food_name || "").toLowerCase();
      const score = targetId && Number(row.matched_db_id) === targetId
        ? 100
        : hintWords.filter(word => name.includes(word)).length;
      if (score > bestScore) { best = row; bestScore = score; }
    }
    if (best) taken.add(best.id);
    return best;
  });
}

module.exports = { looksLikeCorrection, shouldPromoteToReplace, formatLastLogContext, matchRows };
