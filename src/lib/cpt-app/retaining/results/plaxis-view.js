// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// "PLAXIS 2D" tab: every value to copy into the model — Plate (sheet pile) or Plate + Embedded Beam Row.
import { esc, fmt, table, copyButton, toTsv, kvList } from './result-kit.js';

const fmtRow = (r) => Array.isArray(r) ? r : [r.label, r.value, r.unit];
function paramTable(rows, tsvName) {
  const data = rows.map(fmtRow);
  const tsv = toTsv(['parameter', 'value', 'unit / note'], data.map(([a, b, c]) => [a, typeof b === 'number' ? b : String(b), c]));
  return table([{ label: 'Parameter', render: (r) => esc(r[0]) }, { label: 'Value', num: true, render: (r) => typeof r[1] === 'number' ? (Math.abs(r[1]) >= 1e5 || (Math.abs(r[1]) < 1e-3 && r[1] !== 0) ? r[1].toExponential(3) : fmt(r[1], Math.abs(r[1]) >= 100 ? 1 : 4)) : esc(r[1]) }, { label: 'Unit / note', render: (r) => esc(r[2]) }], data) + `<div class="st6-rw-actions">${copyButton(`copy ${tsvName} (TSV)`, tsv)}</div>`;
}

export function plaxisView(rw, result, structural) {
  if (!result?.branches) return '<div class="st6-help">PLAXIS parameter sets are produced for embedded walls.</div>';
  if (!structural?.section) return '<div class="st6-rw-note warn">Select a catalogue section first.</div>';
  const P = structural.plaxis;
  let html = '';
  if (!structural.soldier) {
    html += `<div class="st6-rw-card-title">Plate — continuous sheet pile over the full length, interfaces on both sides</div>${paramTable(P.plate.rows, 'plate set')}
      <div class="st6-rw-note">${P.plate.notes.map(esc).join(' ')}</div>`;
  } else {
    html += `<div class="st6-rw-grid2">
      <div><div class="st6-rw-card-title">Plate above the design excavation (${esc(structural.section.id)}, s = ${fmt(rw.soldier.spacing, 2)} m)</div>${paramTable(P.plate.rows, 'plate set')}<div class="st6-rw-note">${P.plate.notes.map(esc).join(' ')}</div></div>
      <div><div class="st6-rw-card-title">Embedded beam row below the design excavation</div>${paramTable(P.ebr.rows, 'EBR set')}<div class="st6-rw-note">${P.ebr.notes.map(esc).join(' ')}</div></div>
    </div>
    <div class="st6-rw-grid2" style="margin-top:12px">
      <div><div class="st6-rw-card-title">Axial skin resistance T<sub>skin</sub> (Linear)</div>${paramTable(P.tskin.rows, 'T_skin')}<div class="st6-rw-note">${P.tskin.notes.map(esc).join(' ')}</div></div>
      <div><div class="st6-rw-card-title">Base resistance F<sub>max</sub></div>${P.fmax ? paramTable(P.fmax.rows, 'F_max') + `<div class="st6-rw-note">${P.fmax.notes.map(esc).join(' ')}</div>` : '<div class="st6-rw-note warn">No cone resistance at the toe stratum (single material?) — enter q_c via the CPT profile to derive F_max.</div>'}</div>
    </div>`;
    // T_lat tables
    const setId = rw.ui?.tlatSet && P.tlat.some((t) => t.id === rw.ui.tlatSet) ? rw.ui.tlatSet : (P.tlat[0]?.id || 'characteristic');
    const t = P.tlat.find((x) => x.id === setId) || P.tlat[0];
    if (t) {
      const seg = `<span class="st6-rw-seg">${P.tlat.map((x) => `<button type="button" class="${x.id === t.id ? 'sel' : ''}" onclick="retwallSet('ui.tlatSet','${x.id}')">${esc(x.id)}${x.gPhi !== 1 ? ` (γφ ${fmt(x.gPhi, 2)})` : ''}</button>`).join('')}</span>`;
      const conv = rw.soldier.tlatConvention === 'equal' ? 'equal-level (Rekennota)' : 'Andersen–Lodahl';
      const cols = [
        { label: 'Distance (m)', num: true, render: (r) => fmt(r.distance, 3) },
        { label: "σ′<sub>v,f</sub> (kPa)", num: true, render: (r) => fmt(r.sigmaVf, 2) },
        { label: 'Δq (kPa)', num: true, render: (r) => fmt(r.dq, 2) },
        { label: 'K<sub>q</sub>', num: true, render: (r) => fmt(r.Kq, 3) },
        { label: 'K<sub>c</sub>', num: true, render: (r) => fmt(r.Kc, 3) },
        { label: 'equal-level (kN/m)', num: true, render: (r) => fmt(r.rowEqual, 2) },
        { label: 'A–L (kN/m)', num: true, render: (r) => fmt(r.rowAL, 2) },
        { label: 's·p<sub>net</sub> cap (kN/m)', num: true, render: (r) => fmt(r.rowCap, 2) },
        { label: `<strong>T<sub>lat</sub> (${conv}${rw.soldier.rowCap !== false ? ', capped' : ''})</strong>`, num: true, render: (r) => `<strong>${fmt(r.tlat, 2)}</strong>` }
      ];
      const rows = t.plaxisRows.map((r, i) => ({ ...r, rowEqual: t.rows[i].tlatEqual, rowAL: t.rows[i].tlatAL }));
      const tsv = toTsv(['distance_m', 'Tlat_kN_m'], rows.map((r) => [r.distance, r.tlat]));
      const consts = table([
        { label: 'Layer top', render: (r) => fmt(r.topEl, 2) + ' m' }, { label: 'φ (°)', num: true, render: (r) => fmt(r.phi, 3) }, { label: 'c (kPa)', num: true, render: (r) => fmt(r.drained ? r.c : r.cu, 2) },
        { label: 'K<sub>q</sub><sup>A</sup>', num: true, render: (r) => fmt(r.KqA, 4) }, { label: 'K<sub>q</sub>⁰', num: true, render: (r) => fmt(r.Kq0, 4) }, { label: 'K<sub>c</sub>⁰', num: true, render: (r) => fmt(r.Kc0, 4) },
        { label: 'K₀', num: true, render: (r) => fmt(r.K0, 4) }, { label: 'd<sub>c</sub><sup>∞</sup>', num: true, render: (r) => fmt(r.dcInf, 4) }, { label: 'N<sub>c</sub>', num: true, render: (r) => fmt(r.Nc, 4) },
        { label: 'K<sub>q</sub><sup>∞</sup>', num: true, render: (r) => fmt(r.KqInf, 4) }, { label: 'K<sub>c</sub><sup>∞</sup>', num: true, render: (r) => fmt(r.KcInf, 4) }, { label: 'a<sub>q</sub>', num: true, render: (r) => fmt(r.aq, 5) }, { label: 'a<sub>c</sub>', num: true, render: (r) => fmt(r.ac, 5) }
      ], t.layers);
      html += `<div class="st6-rw-card-title" style="margin-top:12px">Lateral resistance T<sub>lat</sub> — Multi-linear, per pile, B = b = ${fmt(t.B * 1000, 0)} mm, distance from the top of the EBR (design excavation ${fmt(-t.topEl, 2)} m below nominal)</div>
        <div class="st6-rw-actions">${seg}<span class="st6-help">${esc(t.label)}</span>${copyButton('copy T_lat rows (distance, T_lat)', tsv)}</div>
        ${table(cols, rows)}
        ${kvList([['∫T<sub>lat</sub> dz (adopted)', fmt(t.Ru, 2), 'kN/pile'], ['∫T<sub>lat</sub>·z dz', fmt(t.Mu, 2), 'kNm/pile'], ['z̄', fmt(t.zBar, 3), 'm below the EBR top']])}
        <div class="st6-rw-note">Brinch Hansen (1961) coefficients per layer: equal-level e = σ′<sub>v,f</sub>·K<sub>q</sub> + c·K<sub>c</sub>; Andersen–Lodahl subtracts the retained-height active term Δq·K<sub>q</sub><sup>A</sup> (Δq = σ′<sub>v,back</sub> − σ′<sub>v,front</sub> incl. surcharges). Values per ONE pile — do not divide by the spacing. The design set recomputes every coefficient at φ′<sub>d</sub> (T<sub>lat,d</sub> ≠ T<sub>lat,k</sub>/γ<sub>φ</sub>).</div>
        <details style="margin-top:8px"><summary style="cursor:pointer;font-size:11px">Brinch Hansen constants of this set</summary>${consts}</details>`;
    }
  }
  // interfaces
  if (P.interfaces?.length) {
    html += `<div class="st6-rw-card-title" style="margin-top:12px">Interfaces (R<sub>inter</sub> = tan δ / tan φ′)</div>
      ${table([{ label: 'Layer', render: (r) => esc(r.label || '') || '—' }, { label: 'φ′<sub>k</sub> (°)', num: true, render: (r) => fmt(r.phi, 1) }, { label: 'δ (°)', num: true, render: (r) => fmt(r.delta, 1) }, { label: 'R<sub>inter</sub>', num: true, render: (r) => fmt(r.Rinter, 3) }], P.interfaces)}
      <div class="st6-rw-note">δ as in the hand calculation (${structural.soldier ? 'soldier-pile passive ratio' : 'sheet-pile passive ratio'} × φ′). Assign interfaces on both sides; hydraulic resistance on the outside interface only (Bentley KB).</div>`;
  }
  return html;
}
