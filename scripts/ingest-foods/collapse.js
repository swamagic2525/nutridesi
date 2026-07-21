const tokens = (name) => String(name || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);

// Collapse clusters that share an exact macro fingerprint AND a common content
// token (guards against merging coincidentally-equal but unrelated foods).
function collapse(recs) {
  const groups = new Map();
  for (const r of recs) {
    const fp = [r.kcal, r.p, r.c, r.f, r.grams].join("|");
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(r);
  }
  const kept = [], dropped = [];
  for (const group of groups.values()) {
    if (group.length < 2) { kept.push(group[0]); continue; }
    const sets = group.map(r => new Set(tokens(r.name)));
    const common = [...sets[0]].filter(t => sets.every(s => s.has(t)));
    if (common.length === 0) { kept.push(...group); continue; } // coincidental — keep all
    const rep = group.slice().sort((a, b) => a.name.length - b.name.length)[0];
    kept.push(rep);
    for (const r of group) if (r !== rep) dropped.push({ name: r.name, keptAs: rep.name });
  }
  return { kept, dropped };
}

module.exports = { collapse };
