// Column names vary across the four files; read each field from its aliases.
const NAME_COLS = ["Item Name", "Product / Dish Name", "Product Name", "Product"];
const BRAND_COLS = ["Brand", "Brand / Restaurant"];
const CAT_COLS = ["Category", "Sub-Category", "Type"];

const pick = (row, cols) => { for (const c of cols) if (row[c] != null && row[c] !== "") return row[c]; return ""; };

// "1 bowl (150g)" -> {unit:"bowl", grams:150}; "32g (2 tbsp)" -> {unit:"2 tbsp", grams:32}
function parseServing(s) {
  const str = String(s || "");
  const gm = str.match(/(\d+(?:\.\d+)?)\s*(?:g|ml)\b/i);
  const grams = gm ? parseFloat(gm[1]) : null;
  let unit = str
    .replace(/\(?\s*\d+(?:\.\d+)?\s*(?:g|ml)\s*\)?/i, " ") // drop the grams/ml token
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^1\s+/, ""); // "1 bowl" -> "bowl"; keep "2 pcs"
  if (!unit) unit = "serving";
  return { unit, grams };
}

function normalizeRow(row, sourceFile) {
  const brand = pick(row, BRAND_COLS).trim();
  const rawName = pick(row, NAME_COLS).trim();
  // Prefix the brand only when it isn't already the start of the product name.
  const name = brand && !rawName.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${rawName}` : rawName;
  const { unit, grams } = parseServing(row["Serving Size"]);
  const kcal = parseFloat(row["Calories (kcal)"]);
  const p = parseFloat(row["Protein (g)"]);
  const c = parseFloat(row["Carbs (g)"]);
  const f = parseFloat(row["Fats (g)"]);
  const per100 = (v) => (grams > 0 && Number.isFinite(v)) ? +(v / grams * 100).toFixed(2) : null;
  return {
    source_file: sourceFile, name, unit, grams,
    kcal, p, c, f,
    kcal_100g: per100(kcal), p_100g: per100(p), c_100g: per100(c), f_100g: per100(f),
    category: pick(row, CAT_COLS).trim(),
  };
}

module.exports = { parseServing, normalizeRow };
