require("dotenv").config();
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

async function load(rowsPath) {
  const rows = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from("foods_reference").upsert(batch, { onConflict: "food_code" });
    if (error) { console.error(`batch ${i}:`, error.message); process.exit(1); }
    console.log(`upserted ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  const { count } = await supabase.from("foods_reference").select("*", { count: "exact", head: true });
  console.log(`done — ${count} rows in foods_reference (AI-tagged: run verify.js)`);
}

module.exports = { load };
