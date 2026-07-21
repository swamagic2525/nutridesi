// Parse a GitHub-flavored markdown pipe-table into row objects keyed by header.
function parseMdTable(text) {
  const rows = [];
  let headers = null;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.every(c => /^:?-+:?$/.test(c))) continue; // separator row
    if (!headers) { headers = cells; continue; }
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] !== undefined ? cells[i] : ""; });
    rows.push(obj);
  }
  return rows;
}

module.exports = { parseMdTable };
