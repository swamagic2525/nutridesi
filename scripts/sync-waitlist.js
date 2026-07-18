// Sync Netlify waitlist submissions into the Supabase founding_members table.
// Run manually: node scripts/sync-waitlist.js [--dry-run]
//
// Validation gate (garbage never burns one of the 50 founding spots):
//   1. classify contact as phone / email / instagram — no match -> parked for review
//   2. normalize (phone -> +91XXXXXXXXXX, email -> lowercase, IG -> strip @)
//      so the same contact typed two ways collides as a duplicate
//   3. skip contacts already in founding_members
//   4. rank continues from the current max; inserts stop at rank 50
// Netlify auth comes from the logged-in CLI (script shells out to `npx netlify api`).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { execFileSync } = require("child_process");

const FORM_ID = "6a5b83b73045c800087bc3be"; // "waitlist" form on trynutridesi
const FOUNDING_CAP = 50;
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY = process.argv.includes("--dry-run");

function classify(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const digits = s.replace(/[\s\-()."']/g, "");
  if (/^(\+91)?[6-9]\d{9}$/.test(digits)) return { type: "phone", norm: "+91" + digits.slice(-10) };
  if (/^\+\d{7,15}$/.test(digits)) return { type: "phone", norm: digits };
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s)) return { type: "email", norm: s.toLowerCase() };
  const handle = s.replace(/^@/, "").replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
  if (/^[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9_]$/i.test(handle) && /[a-z]/i.test(handle)) {
    return { type: "instagram", norm: handle.toLowerCase() };
  }
  return null;
}

async function sb(pathq, opts = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, {
    ...opts,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(`${pathq}: HTTP ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function main() {
  const out = execFileSync("npx", ["netlify", "api", "listFormSubmissions", "--data", JSON.stringify({ form_id: FORM_ID })], { encoding: "utf8" });
  // oldest first = signup order
  const subs = JSON.parse(out).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const existing = await sb("founding_members?select=contact,waitlist_rank");
  const known = new Set(existing.map(r => r.contact));
  let rank = existing.reduce((m, r) => Math.max(m, r.waitlist_rank || 0), 0);

  const parked = [], inserted = [], skipped = [], overflow = [];
  for (const s of subs) {
    const name = String(s.data?.name || "").trim();
    const raw = s.data?.contact;
    const c = classify(raw);
    if (!c) { parked.push({ name, raw }); continue; }
    if (known.has(c.norm)) { skipped.push({ name, contact: c.norm }); continue; }
    known.add(c.norm);
    if (rank >= FOUNDING_CAP) { overflow.push({ name, contact: c.norm }); continue; }
    rank += 1;
    const row = { contact: c.norm, name: name || null, source: "waitlist", waitlist_rank: rank, promised_at: s.created_at };
    if (!DRY) await sb("founding_members", { method: "POST", body: JSON.stringify([row]) });
    inserted.push({ rank, name, type: c.type, contact: c.norm });
  }

  console.log(`${DRY ? "[dry-run] " : ""}submissions: ${subs.length}`);
  for (const r of inserted) console.log(`  #${r.rank} ${r.name || "(no name)"} · ${r.type} · ${r.contact}`);
  if (skipped.length) console.log(`already in table: ${skipped.map(r => r.contact).join(", ")}`);
  if (overflow.length) console.log(`valid but past the 50 cap: ${overflow.map(r => `${r.name} ${r.contact}`).join(", ")}`);
  if (parked.length) {
    console.log("PARKED FOR REVIEW (unclassifiable — not inserted, no rank):");
    for (const p of parked) console.log(`  ${p.name || "(no name)"} · "${p.raw}"`);
  }
}

main().catch(err => { console.error("sync failed:", err.message); process.exit(1); });
