// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// "Checks" tab: every Eurocode verification with demand, resistance, utilisation and intermediates.
import { esc, fmt, utilBar, badge } from './result-kit.js';

function checkRow(c) {
  const odf = c.id === 'embedment';
  const odfProvided = odf ? (c.extra || []).find((kv) => kv?.key === 'ODF_at_provided')?.value : null;
  const kvs = (c.extra || []).map((kv) => `${esc(kv.key)} ${fmt(kv.value, 2)}${kv.unit ? ' ' + esc(kv.unit) : ''}`);
  const noteHtml = c.note ? `<div class="tbl__remark">${esc(c.note)}</div>` : '';
  const extra = kvs.length ? `<details class="tbl__extra"><summary>${kvs.slice(0, 3).join(' · ')}${kvs.length > 3 || c.note ? ' …' : ''}</summary><div>${kvs.join(' · ')}${noteHtml}</div></details>` : noteHtml;
  return `<tr>
    <td><div class="tbl__name">${esc(c.label)}</div><div class="tbl__sub">${esc(c.comboLabel || c.combo)} · ${esc(c.verb)}${c.ref ? ' · ' + esc(c.ref) : ''}</div>${extra}</td>
    <td class="num">${fmt(c.Ed, 2)} / ${fmt(c.Rd, 2)} ${esc(c.unit || '')}</td>
    <td class="tbl__util">${utilBar(c.util, c.pass)}<div class="mono ink-muted">${odf ? (Number.isFinite(odfProvided) ? 'ODF ' + fmt(odfProvided, 2) + ' · d ratio ' + fmt(c.util, 2) : fmt(c.util, 2)) : fmt(c.util, 2)}</div></td>
    <td>${badge(c.pass)}</td>
  </tr>`;
}

export function checksView(rw, result, structural) {
  if (!result) return '<div class="card card--quiet card--note">No result yet.</div>';
  const rows = (result.checks || []).map((c) => checkRow({ ...c, ref: c.id === 'embedment' ? 'EN 1997-1 §9.7' : c.id === 'heave' ? 'EN 1997-1 §10.3' : c.id === 'anchor_pullout' ? 'EN 1537 / EC7 Table A.12' : '' }));
  const steel = structural?.steel ? structural.steel.rows.filter((r) => !r.info).map((r) => checkRow({ label: `${r.label} — ${structural.section?.id || ''}`, comboLabel: `STR · ${result.structural?.combo || ''}`, verb: 'E_d <= R_d', ref: r.ref, Ed: r.Ed, Rd: r.Rd, unit: r.unit, util: r.util, pass: r.pass, note: r.note, extra: [] })) : [];
  const lag = structural?.lagging ? [checkRow({ label: `Lagging plate ${fmt(rw.soldier.laggingThk * 1000, 0)} mm ${rw.soldier.laggingGrade}`, comboLabel: `STR · ${structural.lagging.combo || ''}`, verb: 'M_Ed <= M_Rd (elastic)', ref: structural.lagging.ref, Ed: structural.lagging.MEd, Rd: structural.lagging.MRd, unit: 'kNm/m', util: structural.lagging.util, pass: structural.lagging.pass, extra: [{ key: 'L', value: structural.lagging.L, unit: 'm' }, { key: 'sigma', value: structural.lagging.sigma, unit: 'N/mm2' }, { key: 'UC_plastic', value: structural.lagging.utilPlastic, unit: '-' }, ...(structural.lagging.deflection != null ? [{ key: 'deflection_char', value: structural.lagging.deflection * 1000, unit: 'mm' }] : [])] })] : [];
  const vert = structural?.vertical ? [checkRow({ label: 'Vertical equilibrium of the pile (self-weight vs shaft resistance)', comboLabel: 'GEO · screening', verb: 'G <= R_s', ref: structural.vertical.ref, Ed: structural.vertical.G, Rd: structural.vertical.Rs, unit: 'kN', util: structural.vertical.util, pass: structural.vertical.pass, extra: [{ key: 'G_pile', value: structural.vertical.Gpile, unit: 'kN' }, { key: 'G_lagging', value: structural.vertical.Glagging, unit: 'kN' }], note: 'Base resistance not credited; T_skin from the β-method of the PLAXIS set.' })] : [];
  return `<div class="tbl-wrap"><table class="tbl tbl--top"><thead><tr><th>Limit state (governing branch · reference)</th><th class="num">E<sub>d</sub> / R<sub>d</sub></th><th>Util.</th><th></th></tr></thead><tbody>${rows.join('')}${steel.join('')}${lag.join('')}${vert.join('')}</tbody></table></div>
    ${(result.notes || []).length ? `<div class="card__text">${(result.notes || []).map(esc).join('<br>')}</div>` : ''}
    <div class="card card--quiet card--note">Method &amp; assumptions: <a href="/docs/engineering/retaining-wall" target="_blank" rel="noopener">documentation</a>.</div>`;
}
