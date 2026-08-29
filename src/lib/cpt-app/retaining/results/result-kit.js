// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Shared pieces of the result views.
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 2) => (v != null && Number.isFinite(Number(v))) ? Number(v).toFixed(d) : '—';

export function utilBar(util, pass) {
  const u = Number.isFinite(util) ? util : 0;
  const pct = Math.max(0, Math.min(u, 1.5)) / 1.5 * 100;
  const col = !pass ? 'var(--bad)' : u > 0.85 ? 'var(--wn)' : 'var(--ok)';
  return `<div class="st6-rw-util"><div class="st6-rw-util-fill" style="width:${pct}%;background:${col}"></div><div class="st6-rw-util-mark" style="left:${100 / 1.5}%"></div></div>`;
}
export const badge = (pass, text) => `<span class="st6-rw-badge ${pass ? 'ok' : 'bad'}">${text || (pass ? 'PASS' : 'FAIL')}</span>`;

export function table(columns, rows, { cls = 'st6-rw-table', rowClass = null } = {}) {
  const head = columns.map((c) => `<th${c.num ? ' style="text-align:right"' : ''}>${c.label}</th>`).join('');
  const body = rows.map((r, i) => `<tr${rowClass && rowClass(r, i) ? ` class="${rowClass(r, i)}"` : ''}>${columns.map((c) => `<td${c.num ? ' class="num"' : ''}>${typeof c.render === 'function' ? c.render(r, i) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
  return `<div class="st6-rw-tablewrap"><table class="${cls}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Copy button: the TSV text is stored on the element and copied by the window handler. */
export function copyButton(label, tsv) {
  return `<button type="button" class="st6-rw-copy" data-copy="${esc(tsv)}" onclick="retwallCopy(this)">${esc(label)}</button>`;
}

export function toTsv(header, rows) {
  return [header.join('\t'), ...rows.map((r) => r.map((v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(6)) : String(v ?? '')).join('\t'))].join('\n');
}

export function kvList(pairs) {
  return `<dl class="st6-rw-kv">${pairs.map(([k, v, u]) => `<dt>${k}</dt><dd>${v}${u ? `<small>${u}</small>` : ''}</dd>`).join('')}</dl>`;
}
