// Offline eval harness: replays golden cases through the real parser and
// scores the structured output. No Twilio, no DB writes.
//
//   node evals/run.js                 # full suite
//   node evals/run.js --only=grams    # one tag
//   node evals/run.js --id=corr       # cases whose id contains "corr"
//   node evals/run.js --limit=10
//
// Each run is saved to evals/runs/<timestamp>.json so scorecards can be
// diffed across prompt/model/foods.js changes.
//
// Expected-case schema (evals/cases.jsonl, one JSON object per line):
//   input, context?, tags[], expected:{ intent (string or any-of array),
//   items:[{ db_id (number|null|any-of array), qty?, qty_any_of?, grams?,
//            raw?, stated_kcal?, stated_protein?, name_like?, name_null? }],
//   report_day?, name?, goal_kcal?, goal_protein?, query_reply_no_digits? }

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const { parseMeal, CHAIN } = require("../src/parser.js");

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--(\w+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

function loadCases() {
  const lines = fs.readFileSync(path.join(__dirname, "cases.jsonl"), "utf8").split("\n").filter(Boolean);
  let cases = lines.map(l => JSON.parse(l));
  if (args.only) cases = cases.filter(c => c.tags.includes(args.only));
  if (args.id) cases = cases.filter(c => c.id.includes(args.id));
  if (args.limit) cases = cases.slice(0, Number(args.limit));
  return cases;
}

const eq = (a, b) => Number(a) === Number(b);

// Match one expected item against the parsed items (greedy, first fit wins).
function findMatch(exp, parsedItems, used) {
  for (let i = 0; i < parsedItems.length; i++) {
    if (used.has(i)) continue;
    const p = parsedItems[i];
    const pid = p.matched_db_id ?? null;
    if (Array.isArray(exp.db_id) ? !exp.db_id.includes(pid)
      : exp.db_id !== undefined && (exp.db_id === null ? pid !== null : !eq(exp.db_id, pid))) continue;
    if (exp.name_like && !String(p.food_name || "").toLowerCase().includes(exp.name_like.toLowerCase())) continue;
    used.add(i);
    return { idx: i, item: p };
  }
  return null;
}

function checkItem(exp, p) {
  const errs = [];
  if (exp.qty !== undefined && !eq(p.quantity, exp.qty)) errs.push(`qty ${p.quantity} != ${exp.qty}`);
  if (exp.qty_any_of && !exp.qty_any_of.some(q => eq(p.quantity, q))) errs.push(`qty ${p.quantity} not in [${exp.qty_any_of}]`);
  if (exp.grams !== undefined && !eq(p.grams, exp.grams)) errs.push(`grams ${p.grams} != ${exp.grams}`);
  if (exp.raw !== undefined && !!p.raw !== exp.raw) errs.push(`raw ${!!p.raw} != ${exp.raw}`);
  if (exp.stated_kcal !== undefined && !eq(p.stated_kcal, exp.stated_kcal)) errs.push(`stated_kcal ${p.stated_kcal} != ${exp.stated_kcal}`);
  if (exp.stated_protein !== undefined && !eq(p.stated_protein, exp.stated_protein)) errs.push(`stated_protein ${p.stated_protein} != ${exp.stated_protein}`);
  if (exp.name_null && p.food_name != null) errs.push(`food_name "${p.food_name}" expected null`);
  return errs;
}

function scoreCase(c, parsed) {
  const errs = [];
  const exp = c.expected;
  const intent = parsed.intent || "log";
  const wantIntent = Array.isArray(exp.intent) ? exp.intent : [exp.intent];
  const intentOk = wantIntent.includes(intent);
  if (!intentOk) errs.push(`intent "${intent}" expected ${wantIntent.join("|")}`);

  const parsedItems = parsed.items || [];
  const used = new Set();
  let itemErrs = 0;
  for (const e of exp.items) {
    const m = findMatch(e, parsedItems, used);
    if (!m) { errs.push(`MISSING item ${JSON.stringify(e)}`); itemErrs++; continue; }
    const fieldErrs = checkItem(e, m.item);
    if (fieldErrs.length) { errs.push(`item ${m.item.food_name}: ${fieldErrs.join("; ")}`); itemErrs++; }
  }
  const extras = parsedItems.filter((_, i) => !used.has(i));
  if (extras.length) { errs.push(`EXTRA items: ${extras.map(p => p.food_name).join(", ")}`); itemErrs++; }

  for (const f of ["report_day", "name", "goal_kcal", "goal_protein"]) {
    if (exp[f] !== undefined) {
      const got = parsed[f] ?? null;
      const ok = exp[f] === null ? got === null : String(got) === String(exp[f]);
      if (!ok) errs.push(`${f} "${got}" expected "${exp[f]}"`);
    }
  }
  if (exp.query_reply_no_digits && /\d/.test(String(parsed.query_reply || ""))) {
    errs.push(`query_reply contains digits: "${parsed.query_reply}"`);
  }
  return { intentOk, itemsOk: itemErrs === 0 && !errs.some(e => e.startsWith("MISSING") || e.startsWith("EXTRA")), perfect: errs.length === 0, errs };
}

async function main() {
  const cases = loadCases();
  console.log(`Running ${cases.length} cases | provider chain: ${CHAIN.join(" -> ")} | model: ${process.env.GEMINI_MODEL || process.env.GROQ_MODEL || ""}\n`);
  const results = [];
  for (const c of cases) {
    let parsed, error = null;
    try { parsed = await parseMeal(c.input, c.context || ""); }
    catch (e) { parsed = { items: [] }; error = e.message; }
    const score = error ? { intentOk: false, itemsOk: false, perfect: false, errs: [`parse error: ${error}`] } : scoreCase(c, parsed);
    results.push({ id: c.id, tags: c.tags, input: c.input, ...score, parsed });
    process.stdout.write(score.perfect ? "." : "F");
  }
  console.log("\n");

  const n = results.length;
  const pct = (k) => `${Math.round(100 * results.filter(r => r[k]).length / n)}%`;
  console.log(`intent accuracy : ${pct("intentOk")}`);
  console.log(`items correct   : ${pct("itemsOk")}   (right foods found, none missing/extra)`);
  console.log(`perfect cases   : ${pct("perfect")}   (${results.filter(r => r.perfect).length}/${n} — intent + items + all fields)\n`);

  const tagStats = {};
  for (const r of results) for (const t of r.tags) {
    tagStats[t] = tagStats[t] || { n: 0, ok: 0 };
    tagStats[t].n++; if (r.perfect) tagStats[t].ok++;
  }
  console.log("per tag:");
  for (const [t, s] of Object.entries(tagStats).sort()) {
    console.log(`  ${t.padEnd(14)} ${s.ok}/${s.n}`);
  }

  const failures = results.filter(r => !r.perfect);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) {
      console.log(`\n  [${f.id}] "${f.input}"`);
      for (const e of f.errs) console.log(`    - ${e}`);
    }
  }

  const runsDir = path.join(__dirname, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.writeFileSync(path.join(runsDir, `${stamp}.json`), JSON.stringify({
    at: new Date().toISOString(), chain: CHAIN,
    model: process.env.GEMINI_MODEL || process.env.GROQ_MODEL || null,
    summary: { n, intent: pct("intentOk"), items: pct("itemsOk"), perfect: pct("perfect") },
    results: results.map(({ parsed, ...r }) => r),
  }, null, 2));
  console.log(`\nsaved evals/runs/${stamp}.json`);
}

main();
