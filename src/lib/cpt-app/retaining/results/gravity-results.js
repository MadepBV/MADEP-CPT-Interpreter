// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Gravity / RC cantilever results (checks table) — the family keeps its original single-panel layout.
import { esc, fmt, utilBar, badge } from './result-kit.js';

export function gravityChecksView(rw, result) {
  if (!result) return '<div class="card card--quiet card--note">No result yet.</div>';
  const rows = (result.checks || []).map((c) => {
    const kvs = (c.extra || []).map((kv) => `${esc(kv.key)} ${fmt(kv.value, 2)}${kv.unit ? ' ' + esc(kv.unit) : ''}`);
    const noteHtml = c.note ? `<div class="tbl__remark">${esc(c.note)}</div>` : '';
    const extra = kvs.length ? `<details class="tbl__extra"><summary>${kvs.slice(0, 3).join(' · ')}${kvs.length > 3 || c.note ? ' …' : ''}</summary><div>${kvs.join(' · ')}${noteHtml}</div></details>` : noteHtml;
    return `<tr><td><div class="tbl__name">${esc(c.label)}</div><div class="tbl__sub">${esc(c.comboLabel || c.combo)} · ${esc(c.verb)}</div>${extra}</td><td class="num">${fmt(c.Ed, 2)} / ${fmt(c.Rd, 2)} ${esc(c.unit || '')}</td><td class="tbl__util">${utilBar(c.util, c.pass)}<div class="mono ink-muted">${fmt(c.util, 2)}</div></td><td>${badge(c.pass)}</td></tr>`;
  }).join('');
  return `<div class="tbl-wrap"><table class="tbl tbl--top"><thead><tr><th>Limit state (governing combination)</th><th class="num">E<sub>d</sub> / R<sub>d</sub></th><th>Util.</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${(result.notes || []).length ? `<div class="card__text">${(result.notes || []).map(esc).join('<br>')}</div>` : ''}
    <div class="card card--quiet card--note">Method &amp; assumptions: <a href="/docs/engineering/retaining-wall" target="_blank" rel="noopener">documentation</a>.</div>`;
}
