// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Shared pieces of the result views (component classes of src/lib/styles/components.css §24).
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 2) => (v != null && Number.isFinite(Number(v))) ? Number(v).toFixed(d) : '—';

/** Utilisation meter (§3.11): the track runs to 1.5, the mark sits at 1.0. */
export function utilBar(util, pass) {
  const u = Number.isFinite(util) ? util : 0;
  const pct = Math.max(0, Math.min(u, 1.5)) / 1.5 * 100;
  const tone = !pass ? 'meter--bad' : u > 0.85 ? 'meter--warn' : 'meter--good';
  return `<div class="meter ${tone}"><div class="meter__fill" style="width:${pct}%"></div><div class="meter__mark" style="left:${100 / 1.5}%"></div></div>`;
}
export const badge = (pass, text) => `<span class="pill ${pass ? 'pill--good' : 'pill--bad'}">${text || (pass ? 'PASS' : 'FAIL')}</span>`;

export function table(columns, rows, { cls = 'tbl tbl--dense', rowClass = null, wrapCls = '' } = {}) {
  const head = columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.label}</th>`).join('');
  const body = rows.map((r, i) => `<tr${rowClass && rowClass(r, i) ? ` class="${rowClass(r, i)}"` : ''}>${columns.map((c) => `<td${c.num ? ' class="num"' : ''}>${typeof c.render === 'function' ? c.render(r, i) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl-wrap${wrapCls ? ` ${wrapCls}` : ''}"><table class="${cls}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Copy button: the TSV text is stored on the element and copied by the window handler. */
export function copyButton(label, tsv) {
  return `<button type="button" class="btn btn--sm btn--text" data-copy="${esc(tsv)}" onclick="retwallCopy(this)">${esc(label)}</button>`;
}

export function toTsv(header, rows) {
  return [header.join('\t'), ...rows.map((r) => r.map((v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(6)) : String(v ?? '')).join('\t'))].join('\n');
}

export function kvList(pairs) {
  return `<dl class="kv">${pairs.map(([k, v, u]) => `<dt>${k}</dt><dd>${v}${u ? `<small>${u}</small>` : ''}</dd>`).join('')}</dl>`;
}
