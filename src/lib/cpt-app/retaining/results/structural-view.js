// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// "Structural" tab: steel section resistance (EN 1993-1-1 / EN 1993-5), lagging, vertical equilibrium.
import { esc, fmt, table, badge, kvList } from './result-kit.js';

export function structuralView(rw, result, structural) {
  if (!result) return '<div class="card card--quiet card--note">No result yet.</div>';
  if (!result.branches) return gravityStructural(result);
  if (!structural?.section) return '<div class="verdict verdict--warn">Select a catalogue section to run the steel checks.</div>';
  const S = structural, R = S.steel?.resistance || {};
  const perPile = S.perPile;
  const uM = perPile ? 'kNm' : 'kNm/m', uF = perPile ? 'kN' : 'kN/m';
  const resistance = S.soldier
    ? kvList([[`Section`, esc(S.section.id), `${esc(rw.soldier.grade)} · f<sub>y</sub> ${S.fy} N/mm²`], ['Class (EN 1993-1-1 Table 5.2)', R.cls?.cls, `flange c/t ${fmt(R.cls?.flange?.ct, 2)} ≤ ${fmt(R.cls?.flange?.limit1, 1)} · web ${fmt(R.cls?.web?.ct, 2)} ≤ ${fmt(R.cls?.web?.limit1, 1)}`], ['M<sub>pl,Rd</sub> / M<sub>el,Rd</sub>', `${fmt(R.MplRd, 2)} / ${fmt(R.MelRd, 2)}`, 'kNm'], ['V<sub>pl,Rd</sub>', fmt(R.VplRd, 1), `kN · A<sub>v,z</sub> ${fmt(S.section.Avz * 1e4, 2)} cm²`], ['N<sub>pl,Rd</sub>', fmt(R.NplRd, 0), 'kN'], ['γ<sub>M0</sub>', '1.00', 'NBN EN 1993-1-1 ANB']])
    : kvList([[`Section`, esc(S.section.id), `${esc(rw.sheet.grade)} · f<sub>y</sub> ${S.fy} N/mm²${rw.sheet.corrosionLoss ? ` · corrosion −${fmt(rw.sheet.corrosionLoss * 100, 0)} %` : ''}`], ['Class (catalogue, this grade)', R.cls ?? '—', R.plasticAllowed ? 'plastic resistance used' : 'elastic resistance used'], ['M<sub>c,Rd</sub>', fmt(R.McRd, 1), `kNm/m · ${R.plasticAllowed ? 'β_B·W_pl·f_y' : 'W_el·f_y'}`], ['M<sub>pl,Rd</sub> / M<sub>el,Rd</sub>', `${fmt(R.MplRd, 1)} / ${fmt(R.MelRd, 1)}`, 'kNm/m'], ['V<sub>pl,Rd</sub>', fmt(R.VplRd, 1), `kN/m · ${fmt(R.websPerM, 2)} webs/m · A<sub>v</sub> ${fmt(R.Av * 1e4, 1)} cm²/m`], ['N<sub>pl,Rd</sub>', fmt(R.NplRd, 0), 'kN/m'], ['γ<sub>M0</sub>', '1.00', 'NBN EN 1993-1-1 ANB']]);
  const cols = [
    { label: 'Verification', render: (r) => `<strong>${esc(r.label)}</strong><div class="tbl__sub">${esc(r.ref || '')}${r.note ? ' · ' + esc(r.note) : ''}</div>` },
    { label: 'E<sub>d</sub>', num: true, render: (r) => `${fmt(r.Ed, 2)} ${esc(r.unit)}` },
    { label: 'R<sub>d</sub>', num: true, render: (r) => `${fmt(r.Rd, 2)} ${esc(r.unit)}` },
    { label: 'UC', num: true, render: (r) => fmt(r.util, 3) },
    { label: '', render: (r) => r.info ? '<span class="pill pill--data">info</span>' : badge(r.pass) }
  ];
  let html = `<div class="cols-2"><div class="stack--sections"><div class="card__eyebrow">Section resistance</div>${resistance}</div>
    <div class="stack--sections"><div class="card__eyebrow">Design effects (STR envelope)</div>${kvList([['M<sub>Ed</sub>', fmt(result.structural.Mmax, 2), `${uM} · ${result.structural.combo}`], ['V<sub>Ed</sub>', fmt(result.structural.Vmax, 2), `${uF} · ${result.structural.vCombo}`], ...(result.structural.anchorForce > 0 ? [['T<sub>Ed</sub>', fmt(result.structural.anchorForce, 2), `${uF} · ${result.structural.anchorCombo}`]] : [])])}</div></div>
    <div class="card__eyebrow">Steel checks</div>${table(cols, S.steel.rows)}`;
  if (S.lagging) {
    const L = S.lagging;
    html += `<div class="card__eyebrow">Lagging plate — ${fmt(rw.soldier.laggingThk * 1000, 0)} mm ${esc(rw.soldier.laggingGrade)}, span ${L.spanMode === 'clear' ? 'clear s − b' : 'centre-to-centre'} = ${fmt(L.L, 3)} m</div>
      ${kvList([['p<sub>Ed</sub> at the design excavation', fmt(result.structural.laggingPressure, 2), `kPa · ${result.structural.laggingCombo}`], ['M<sub>Ed</sub> = p·L²/8', fmt(L.MEd, 3), 'kNm/m'], ['W<sub>el</sub> = t²/6 · W<sub>pl</sub> = t²/4', `${(L.Wel * 1e6).toFixed(1)} / ${(L.Wpl * 1e6).toFixed(1)}`, 'cm³/m'], ['σ = M<sub>Ed</sub>/W<sub>el</sub>', fmt(L.sigma, 1), 'N/mm²'], ['UC elastic / plastic', `${fmt(L.utilElastic, 3)} / ${fmt(L.utilPlastic, 3)}`, badge(L.pass)], ...(L.deflection != null ? [['Deflection under p<sub>k</sub> (5pL⁴/384EI)', fmt(L.deflection * 1000, 1), 'mm']] : [])])}
      <div class="card__text">Elastic verification on the c/c span is the conservative basis (Rekennota §7.8); the clear span between the flanges is the physically correct one. No arching between the piles is credited.</div>`;
  }
  if (S.vertical) {
    const V = S.vertical;
    html += `<div class="card__eyebrow">Vertical equilibrium of one pile</div>
      ${kvList([[`G (pile + lagging${result.structural.anchorVertical ? ' + anchor down-drag' : ''})`, fmt(V.G, 2), 'kN'], ['R<sub>s</sub> = ∫T<sub>skin</sub> dz over the embedment', fmt(V.Rs, 2), 'kN'], ['UC', fmt(V.util, 3), badge(V.pass)]])}
      <div class="card__text">Base resistance F<sub>max</sub> not credited. With δ = 0 on the passive face no vertical earth-pressure component acts on the pile.</div>`;
  }
  return html;
}

function gravityStructural(result) {
  const st = result.structural || {};
  return `<div class="card__eyebrow">Structural design forces (per m run)</div>
    <div class="tbl-wrap"><table class="tbl tbl--dense"><tbody>
      <tr><td>Stem (base)</td><td>M<sub>Ed</sub> ${fmt(st.stem?.M, 1)} kNm</td><td>V<sub>Ed</sub> ${fmt(st.stem?.V, 1)} kN</td><td>${esc(st.stem?.combo || '')}</td></tr>
      <tr><td>Toe</td><td>M<sub>Ed</sub> ${fmt(st.toe?.M, 1)} kNm</td><td>V<sub>Ed</sub> ${fmt(st.toe?.V, 1)} kN</td><td>${esc(st.toe?.combo || '')}</td></tr>
      <tr><td>Heel</td><td>M<sub>Ed</sub> ${fmt(st.heel?.M, 1)} kNm</td><td>V<sub>Ed</sub> ${fmt(st.heel?.V, 1)} kN</td><td>${esc(st.heel?.combo || '')}</td></tr>
    </tbody></table></div>
    <div class="card__text">Reinforcement design to EN 1992 remains the engineer's task (see the reinforcement application for a strip screening).</div>`;
}
