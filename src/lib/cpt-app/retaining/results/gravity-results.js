// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Gravity / RC cantilever results (checks table) — the family keeps its original single-panel layout.
import { esc, fmt, utilBar, badge } from './result-kit.js';

export function gravityChecksView(rw, result) {
  if (!result) return '<div class="st6-help">No result yet.</div>';
  const rows = (result.checks || []).map((c) => {
    const kvs = (c.extra || []).map((kv) => `${esc(kv.key)} ${fmt(kv.value, 2)}${kv.unit ? ' ' + esc(kv.unit) : ''}`);
    const noteHtml = c.note ? `<div style="margin-top:4px;color:var(--tx2);font-style:italic">${esc(c.note)}</div>` : '';
    const extra = kvs.length ? `<details class="st6-rw-checkextra"><summary style="cursor:pointer">${kvs.slice(0, 3).join(' · ')}${kvs.length > 3 || c.note ? ' …' : ''}</summary><div style="margin-top:4px;line-height:1.55">${kvs.join(' · ')}${noteHtml}</div></details>` : noteHtml;
    return `<tr><td><div class="st6-rw-checkname">${esc(c.label)}</div><div class="st6-rw-checksub">${esc(c.comboLabel || c.combo)} · ${esc(c.verb)}</div>${extra}</td><td class="num" style="font-family:var(--font-mono)">${fmt(c.Ed, 2)} / ${fmt(c.Rd, 2)} ${esc(c.unit || '')}</td><td class="st6-rw-utilcell">${utilBar(c.util, c.pass)}<div class="st6-rw-utilnum">${fmt(c.util, 2)}</div></td><td>${badge(c.pass)}</td></tr>`;
  }).join('');
  return `<table class="st6-rw-checks"><thead><tr><th>Limit state (governing combination)</th><th style="text-align:right">E<sub>d</sub> / R<sub>d</sub></th><th>Util.</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${(result.notes || []).length ? `<div class="st6-rw-note" style="margin-top:8px">${(result.notes || []).map(esc).join('<br>')}</div>` : ''}
    <div class="st6-help" style="margin-top:6px">Method &amp; assumptions: <a href="/docs/engineering/retaining-wall" target="_blank" rel="noopener">documentation</a>.</div>`;
}
