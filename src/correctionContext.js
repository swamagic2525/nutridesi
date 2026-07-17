// Small, deterministic guard around LLM correction intent. It deliberately
// considers only the user's immediately preceding log batch — never a whole
// 45-minute meal window or an older entry from today.

function looksLikeCorrection(text) {
  const t = String(text || "").toLowerCase().trim();
  return /\b(undo|remove|delete|sorry|actually|instead|correct|change|make it|galat|wrong)\b/.test(t) ||
    /\b(it|that|this|them|these)\s+(was|is|has|had|were|are|be|to)\b/.test(t) ||
    /\b(was|is|has|had|were|are)\s+\d+(?:\.\d+)?\s*(?:kcal|cal(?:ories)?|g\s*(?:protein|prot))\b/.test(t) ||
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

module.exports = { looksLikeCorrection, shouldPromoteToReplace, formatLastLogContext };
