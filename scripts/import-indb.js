// One-time loader: indb.json (exported from INDB.xlsx) -> Supabase foods_reference.
// Prereq: run foods-reference.sql in the Supabase SQL Editor first.
// Usage: node scripts/import-indb.js /path/to/indb.json

require("dotenv").config();
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  const path = process.argv[2];
  if (!path) { console.error("usage: node scripts/import-indb.js <indb.json>"); process.exit(1); }
  const foods = JSON.parse(fs.readFileSync(path, "utf8"));
  console.log(`importing ${foods.length} recipes...`);

  for (let i = 0; i < foods.length; i += 500) {
    const batch = foods.slice(i, i + 500);
    const { error } = await supabase.from("foods_reference").upsert(batch, { onConflict: "food_code" });
    if (error) { console.error(`batch ${i}:`, error.message); process.exit(1); }
    console.log(`  ${Math.min(i + 500, foods.length)}/${foods.length}`);
  }
  const { count } = await supabase.from("foods_reference").select("*", { count: "exact", head: true });
  console.log(`done — ${count} rows in foods_reference`);
}

main();
