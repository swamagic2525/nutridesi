// After loading, confirm the AI rows exist and that a handful of previously
// ESTIMATED dishes now resolve via the reference tier with sane numbers.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const PROBES = ["kanda poha", "masala dosa", "misal pav", "veg pulao", "rava idli",
  "chana masala", "aloo gobi", "bhindi masala", "egg curry", "mutton keema",
  "paneer bhurji", "vegetable sandwich", "cold coffee", "gulab jamun", "poha"];

async function main() {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { count } = await s.from("foods_reference").select("*", { count: "exact", head: true }).like("food_code", "AI%");
  console.log(`AI-tagged rows in foods_reference: ${count}`);
  let hit = 0;
  for (const q of PROBES) {
    const { data } = await s.rpc("match_food", { q });
    const top = data && data[0];
    const ok = top && Number(top.serving_kcal) > 0;
    if (ok) hit++;
    console.log(`${ok ? "✓" : "✗"} "${q}" -> ${top ? top.food_name + " (" + top.serving_kcal + " kcal)" : "no match"}`);
  }
  console.log(`\nresolved ${hit}/${PROBES.length} probes (target >= 12)`);
  process.exit(hit >= 12 ? 0 : 1);
}
main();
