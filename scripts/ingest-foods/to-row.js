const PREFIX = {
  "Indian_Household_Nutrition_Database_2500.md": "AIH",
  "QuickCommerce_Restaurant_Food_DB_1000.md": "AIQ",
  "Fitness_Commercial_Products_DB.md": "AIF",
  "Food_Nutrition_DB.md": "AID",
};

function codeFor(sourceFile, index) {
  const prefix = PREFIX[sourceFile] || "AIX";
  return prefix + String(index + 1).padStart(4, "0");
}

// Map a survivor to the foods_reference column shape. Fibre is unknown in the
// source files -> 0 (deferred enhancement). serving_* is the row-as-stated;
// *_100g drives applyReference's fallback path.
function toReferenceRow(rec, code) {
  return {
    food_code: code,
    food_name: rec.name,
    serving_unit: rec.unit || "serving",
    serving_kcal: rec.kcal,
    serving_protein: rec.p,
    serving_carbs: rec.c,
    serving_fat: rec.f,
    serving_fibre: 0,
    kcal_100g: rec.kcal_100g,
    protein_100g: rec.p_100g,
    carbs_100g: rec.c_100g,
    fat_100g: rec.f_100g,
    fibre_100g: 0,
  };
}

module.exports = { codeFor, toReferenceRow };
