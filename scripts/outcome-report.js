// Bad-outcome report. Classifies every exchange in message_log, links each bad
// moment to what the user did next, and compares churn between users who hit
// one and users who didn't.
//
// Read-only: no writes, no sends. Safe to run any time.
//   node scripts/outcome-report.js            # last 30 days
//   node scripts/outcome-report.js --days 7
//   node scripts/outcome-report.js --worst    # also list the worst offenders

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { supabase } = require("../src/db.js");
const {
  classifyOutcome, isBadOutcome, analyseUser, summarise, OUTCOME,
} = require("../src/outcomes.js");

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DAYS = Number(arg("--days", 30));
const SHOW_WORST = argv.includes("--worst");
// Test numbers never count toward product metrics.
const isTestPhone = p => /^\+000/.test(String(p || ""));

async function pageAll(table, cols, sinceIso) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(cols).range(from, from + 999);
    if (sinceIso) q = q.gte("at", sinceIso);
    const { data, error } = await q;
    if (error) { console.error(`${table}:`, error.message); break; }
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

(async () => {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const msgs = (await pageAll("message_log", "phone_number, body, reply, at", since))
    .filter(m => !isTestPhone(m.phone_number));
  if (!msgs.length) return console.log("no messages in window");

  const logs = (await pageAll("user_logs", "phone_number, date"))
    .filter(r => !isTestPhone(r.phone_number));
  const activeDays = new Map();
  for (const r of logs) {
    if (!activeDays.has(r.phone_number)) activeDays.set(r.phone_number, new Set());
    activeDays.get(r.phone_number).add(r.date);
  }

  const byUser = new Map();
  for (const m of msgs) {
    if (!byUser.has(m.phone_number)) byUser.set(m.phone_number, []);
    byUser.get(m.phone_number).push(m);
  }

  const perUser = {};
  for (const [phone, rows] of byUser) {
    perUser[phone] = {
      ...analyseUser(rows),
      activeDays: (activeDays.get(phone) || new Set()).size,
    };
  }
  const s = summarise(perUser);

  console.log(`\n=== BAD-OUTCOME REPORT — last ${DAYS} days ===`);
  console.log(`${s.messages} messages · ${s.users} users\n`);

  console.log("OUTCOME MIX");
  Object.entries(s.byOutcome).sort((a, b) => b[1] - a[1]).forEach(([o, n]) => {
    const flag = isBadOutcome(o) ? " <- bad" : "";
    console.log(`  ${num(n, 5)}  ${num((100 * n / s.messages).toFixed(1), 5)}%  ${pad(o, 18)}${flag}`);
  });

  console.log(`\nBAD OUTCOMES: ${s.bad} (${s.badRate}% of messages)`);
  if (s.bad) {
    // The number that matters. A bad outcome the user recovers from cost a few
    // seconds; one they abandon on may have cost the user entirely.
    console.log(`  recovered next message : ${num(s.recovered, 4)}  (${s.recoveryRate}%)`);
    console.log(`  hit another bad one    : ${num(s.retried, 4)}`);
    console.log(`  stopped messaging      : ${num(s.abandoned, 4)}  (${s.abandonRate}%)  <- the expensive column`);
  }
  console.log(`\nPROBABLE SILENT WRONG MATCHES: ${s.silentWrongMatch}`);
  console.log("  (a confident log immediately followed by a correction attempt —");
  console.log("   these look like successes in the logs, so they are inferred)");

  const c = s.cohorts;
  console.log("\nDID BAD OUTCOMES COST RETENTION?");
  console.log("  churn = logged on only one day. Compared WITHIN message-count");
  console.log("  bands, because hitting a failure requires sending enough");
  console.log("  messages to hit one — the unmatched split inverts the answer.\n");
  console.log(`  ${pad("band", 10)} ${pad("hit a bad outcome", 22)} ${pad("clean run", 22)} delta`);
  for (const b of c.bands) {
    const f = x => x.n ? `n=${num(x.n, 3)} churn=${num((x.churnRate ?? 0) + "%", 6)}` : "n=  0            ";
    const d = b.delta == null ? "n/a" : `${b.delta > 0 ? "+" : ""}${b.delta} pts`;
    console.log(`  ${pad(b.label, 10)} ${pad(f(b.bad), 22)} ${pad(f(b.clean), 22)} ${d}`);
  }
  console.log("\n  (positive delta = failures associated with MORE churn)");

  if (c.endedOnBadRate != null) {
    console.log(`\n  Of users who hit a failure, ${c.endedOnBadRate}% had it as the LAST`);
    console.log("  thing that happened to them. No matching needed for this one.");
  }
  console.log(`\n  [unmatched view, confounded — do not quote: bad ${c.naive.hitBadOutcome.churnRate}% vs clean ${c.naive.cleanRun.churnRate}%]`);

  if (SHOW_WORST) {
    console.log("\nWORST-AFFECTED USERS (phones masked)");
    Object.entries(perUser)
      .filter(([, u]) => u.bad > 0)
      .sort((a, b) => b[1].bad - a[1].bad)
      .slice(0, 10)
      .forEach(([phone, u]) => {
        const masked = phone.replace(/^(\+\d{2})\d+(\d{4})$/, "$1••••••$2");
        console.log(`  ${pad(masked, 16)} bad=${num(u.bad, 3)}  abandoned=${num(u.abandoned, 3)}  activeDays=${u.activeDays}  last=${u.lastOutcome}`);
      });
  }
  console.log();
})().catch(e => { console.error("outcome-report failed:", e.message); process.exit(1); });
