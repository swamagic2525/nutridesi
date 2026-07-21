function buildReport(stats) {
  const { funnel = [], rejects = [], collapses = [], sample = [] } = stats;
  const out = [];
  out.push("# Bulk Food Ingestion — Review Report\n");
  out.push(`Generated: ${new Date().toISOString()}\n`);

  out.push("## Funnel (per file)\n");
  out.push("| File | Parsed | After gate | After collapse | After dedup | To load |");
  out.push("|:-----|-------:|-----------:|---------------:|------------:|--------:|");
  for (const r of funnel) out.push(`| ${r.file} | ${r.parsed} | ${r.gated} | ${r.collapsed} | ${r.deduped} | ${r.loaded} |`);
  const tot = funnel.reduce((a, r) => ({ parsed: a.parsed + r.parsed, loaded: a.loaded + r.loaded }), { parsed: 0, loaded: 0 });
  out.push(`\n**Total: ${tot.parsed} parsed → ${tot.loaded} to load.**\n`);

  out.push(`## Rejected rows (${rejects.length})\n`);
  const byReason = {};
  for (const r of rejects) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) out.push(`- **${reason}**: ${n}`);
  out.push("\n<details><summary>All rejected rows</summary>\n");
  for (const r of rejects) out.push(`- ${r.name} — ${r.reason}`);
  out.push("</details>\n");

  out.push(`## Collapse decisions (${collapses.length} dropped)\n`);
  out.push("<details><summary>All collapses (dropped → kept)</summary>\n");
  for (const c of collapses) out.push(`- ${c.name} → ${c.keptAs}`);
  out.push("</details>\n");

  out.push(`## Sample of rows to load (${sample.length})\n`);
  out.push("| Food | Unit | kcal | Protein | kcal/100g |");
  out.push("|:-----|:-----|-----:|--------:|----------:|");
  for (const s of sample) out.push(`| ${s.food_name} | ${s.serving_unit} | ${s.serving_kcal} | ${s.serving_protein} | ${s.kcal_100g} |`);
  out.push("");
  return out.join("\n");
}

module.exports = { buildReport };
