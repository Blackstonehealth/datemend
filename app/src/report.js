// Report generation (CSV + self-contained HTML). All local; the HTML has no scripts and no external links.
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const REPORT_COLUMNS = ['status', 'flags', 'kind', 'output_path', 'original_path', 'overlay_original_path', 'date_utc', 'date_local', 'time_zone', 'gps_lat', 'gps_lon', 'location_text', 'pairing', 'notes'];

export function rowsToCsv(rows) {
  const lines = [REPORT_COLUMNS.join(',')];
  for (const r of rows) lines.push(REPORT_COLUMNS.map((c) => csvCell(Array.isArray(r[c]) ? r[c].join('; ') : r[c])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function summaryText(summary) {
  return Object.entries(summary).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
}

export function rowsToHtml(rows, summary, { productName, version }) {
  const head = REPORT_COLUMNS.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.map((r) => `<tr class="${esc(r.status)}">` + REPORT_COLUMNS.map((c) => `<td>${esc(Array.isArray(r[c]) ? r[c].join('; ') : r[c])}</td>`).join('') + '</tr>').join('\n');
  const sum = Object.entries(summary).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(productName)} report</title>
<style>body{font:14px system-ui,sans-serif;margin:1.5rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px;text-align:left;font-size:12px}tr.failed td{background:#fdd}tr.partial td,tr.source_missing td{background:#ffe9b8}</style></head><body>
<h1>${esc(productName)} report</h1><p>Generated locally in your browser by ${esc(productName)} ${esc(version)}. Nothing was uploaded.</p>
<h2>Summary</h2><table>${sum}</table><h2>Items</h2><table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></body></html>`;
}
