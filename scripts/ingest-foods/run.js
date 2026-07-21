// Offline ingestion pipeline. Dry-run (default): parse -> gate -> collapse ->
// dedup -> map, then write review-report.md + to-load.json. It NEVER loads
// unless --load is passed (see Task 9). Reversible via food_code like 'AI%'.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { parseMdTable } = require("./parse-md.js");
const { normalizeRow } = require("./normalize.js");
const { gateReason } = require("./gate.js");
const { collapse } = require("./collapse.js");
const { normName, dedup } = require("./dedup.js");
const { codeFor, toReferenceRow } = require("./to-row.js");
const { buildReport } = require("./report.js");
const { FOODS } = require("../../src/foods.js");

const INCOMING = path.join(__dirname, "..", "..", "data", "incoming");
const OUT_REPORT = path.join(__dirname, "review-report.md");
const OUT_ROWS = path.join(__dirname, "to-load.json");

async function existingRefNames() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const names = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("foods_reference").select("food_name").range(from, from + 999);
    if (error) { console.error("ref fetch:", error.message); break; }
    if (!data || !data.length) break;
    for (const r of data) names.add(normName(r.food_name));
    if (data.length < 1000) break;
  }
  return names;
}

async function main() {
  const curatedNames = new Set();
  for (const f of FOODS) { curatedNames.add(normName(f.name)); f.aliases.forEach(a => curatedNames.add(normName(a))); }
  const refNames = await existingRefNames();

  const funnel = [], allRejects = [], allCollapses = [], allRows = [];
  const files = fs.readdirSync(INCOMING).filter(f => f.endsWith(".md"));

  for (const file of files) {
    const text = fs.readFileSync(path.join(INCOMING, file), "utf8");
    const parsed = parseMdTable(text).map(r => normalizeRow(r, file));

    const gated = [];
    for (const rec of parsed) {
      const reason = gateReason(rec);
      if (reason) allRejects.push({ name: rec.name, reason });
      else gated.push(rec);
    }

    const { kept: collapsed, dropped } = collapse(gated);
    allCollapses.push(...dropped);

    const { kept: deduped } = dedup(collapsed, curatedNames, refNames);
    // guard against duplicates ACROSS files within this run
    const rowsThisFile = [];
    for (const rec of deduped) {
      const key = normName(rec.name);
      if (refNames.has(key)) continue;
      refNames.add(key);
      // per-file index -> clean AIH0001.., AIQ0001.. codes; unique because the
      // prefix differs per file and the index is unique within a file.
      rowsThisFile.push(toReferenceRow(rec, codeFor(file, rowsThisFile.length)));
    }
    allRows.push(...rowsThisFile);

    funnel.push({ file, parsed: parsed.length, gated: gated.length, collapsed: collapsed.length, deduped: deduped.length, loaded: rowsThisFile.length });
  }

  // stratified-ish sample: every Nth survivor, up to 100
  const step = Math.max(1, Math.floor(allRows.length / 100));
  const sample = allRows.filter((_, i) => i % step === 0).slice(0, 100);

  fs.writeFileSync(OUT_REPORT, buildReport({ funnel, rejects: allRejects, collapses: allCollapses, sample }));
  fs.writeFileSync(OUT_ROWS, JSON.stringify(allRows, null, 0));
  console.log(`Dry run complete. ${allRows.length} rows -> ${OUT_ROWS}`);
  console.log(`Review: ${OUT_REPORT}`);
  console.log("To load: node scripts/ingest-foods/run.js --load");
}

if (process.argv.includes("--load")) {
  require("./load.js").load(OUT_ROWS);
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
