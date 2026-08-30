// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Right-hand summary: verdict, governing numbers, compact check list.
import { esc, fmt, badge, kvList } from './result-kit.js';
import { isEmbedded, isAnchoredType } from '../wall-types.js';

export function summaryCard(rw, result, structural) {
  if (rw.status === 'error') return `<div class="verdict verdict--bad verdict--hero"><span class="verdict__tag">ENGINE ERROR</span><span class="verdict__body">${esc(rw.error)}</span></div>`;
  if (!result) return `<div class="verdict verdict--neutral verdict--hero"><span class="verdict__tag">${rw.status === 'running' ? 'COMPUTING…' : 'NO RESULT'}</span><span class="verdict__body">Adjust the inputs to run the verification.</span></div>`;
  const embedded = isEmbedded(rw.wallType);
  const checks = result.checks || [];
  const steelRows = structural?.steel?.rows?.filter((r) => !r.info) || [];
  const extraChecks = [
    ...(structural?.lagging ? [{ label: 'Lagging plate', util: structural.lagging.util, pass: structural.lagging.pass }] : []),
    ...(structural?.vertical ? [{ label: 'Vertical equilibrium (pile)', util: structural.vertical.util, pass: structural.vertical.pass }] : [])
  ];
  const all = [...checks.map((c) => ({ label: c.label, util: c.id === 'embedment' ? c.util : c.util, pass: c.pass })), ...steelRows.map((r) => ({ label: r.label, util: r.util, pass: r.pass })), ...extraChecks];
  const overall = all.every((c) => c.pass);
  const worst = all.reduce((m, c) => Math.max(m, Number.isFinite(c.util) ? c.util : 0), 0);
  let kv = '';
  if (embedded) {
    const st = result.structural || {};
    const unitM = result.perPile ? 'kNm/pile' : 'kNm/m', unitV = result.perPile ? 'kN/pile' : 'kN/m';
    const emb = checks.find((c) => c.id === 'embedment');
    const odf = emb?.extra?.find((x) => x.key === 'ODF_at_provided')?.value;
    const pairs = [
      ['d<sub>required</sub> / d<sub>provided</sub>', `${fmt(st.requiredD, 2)} / ${fmt(rw.embedded.embedment, 2)}`, `m · ${st.requiredDCombo || ''}`],
      ['ODF at provided depth', fmt(odf, 2), 'M<sub>res</sub>/M<sub>drive</sub>'],
      ['over-excavation Δa', fmt(result.overdigUls, 2), 'm'],
      ['M<sub>Ed</sub>', fmt(st.Mmax, 1), `${unitM} · ${st.combo || ''}`],
      ['V<sub>Ed</sub>', fmt(st.Vmax, 1), `${unitV} · ${st.vCombo || ''}`]
    ];
    if (isAnchoredType(rw)) pairs.push(['T<sub>Ed</sub> (support)', fmt(st.anchorForce, 1), `${unitV} · ${st.anchorCombo || ''}`], ['per anchor (axial)', fmt(st.anchorAxial, 1), 'kN']);
    if (structural?.steel) {
      const b = structural.steel.rows.find((r) => r.id === 'bending');
      pairs.push([`Steel ${esc(structural.section?.id || '')}`, fmt(b?.util, 2), `UC bending · ${structural.steel.resistance?.plasticAllowed ? 'plastic' : 'elastic'}`]);
    }
    if (structural?.lagging) pairs.push(['Lagging plate', fmt(structural.lagging.util, 2), `UC · L = ${fmt(structural.lagging.L, 2)} m`]);
    kv = kvList(pairs);
  } else {
    const st = result.structural || {};
    kv = kvList([
      ['Stem M<sub>Ed</sub> / V<sub>Ed</sub>', `${fmt(st.stem?.M, 1)} / ${fmt(st.stem?.V, 1)}`, `kNm, kN per m · ${st.stem?.combo || ''}`],
      ['Toe M<sub>Ed</sub>', fmt(st.toe?.M, 1), `kNm/m · ${st.toe?.combo || ''}`],
      ['Heel M<sub>Ed</sub>', fmt(st.heel?.M, 1), `kNm/m · ${st.heel?.combo || ''}`],
      ['Base width B', fmt(result.B, 2), 'm']
    ]);
  }
  const list = all.map((c) => `<div class="util-list__row"><span>${esc(c.label)}</span><span class="util-list__val"><span class="mono">${fmt(c.util, 2)}</span>${badge(c.pass)}</span></div>`).join('');
  // the governing utilisation as a meter under the hero verdict (§3.11): track to 1.5, mark at 1.0
  const meterTone = !overall ? 'meter--bad' : worst > 0.85 ? 'meter--warn' : 'meter--good';
  const meter = `<div class="meter ${meterTone}"><div class="meter__fill" style="width:${Math.max(0, Math.min(worst, 1.5)) / 1.5 * 100}%"></div><div class="meter__mark" style="left:${100 / 1.5}%"></div></div>`;
  return `
    <div class="verdict ${overall ? 'verdict--good' : 'verdict--bad'} verdict--hero"><span class="verdict__tag">${overall ? 'VERIFICATIONS PASS' : 'NOT VERIFIED'}</span><span class="verdict__body">governing utilisation ${fmt(worst, 2)}</span>${meter}</div>
    <div class="card"><div class="card__eyebrow">Governing values</div>${kv}</div>
    <div class="card"><div class="card__eyebrow">Limit states</div><div class="util-list">${list}</div></div>
    ${(result.notes || []).length ? `<div class="card"><div class="card__eyebrow">Engine notes</div><div class="card__text">${(result.notes || []).map(esc).join('<br>')}</div></div>` : ''}`;
}
