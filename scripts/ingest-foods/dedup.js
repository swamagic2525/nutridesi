const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Drop rows whose normalized name already exists in the curated tier or the
// reference tier. Curated always wins; the reference tier isn't duplicated.
function dedup(recs, curatedNames, refNames) {
  const kept = [], dropped = [];
  for (const r of recs) {
    const key = normName(r.name);
    if (curatedNames.has(key)) { dropped.push({ name: r.name, reason: "in_curated" }); continue; }
    if (refNames.has(key)) { dropped.push({ name: r.name, reason: "in_reference" }); continue; }
    kept.push(r);
  }
  return { kept, dropped };
}

module.exports = { normName, dedup };
