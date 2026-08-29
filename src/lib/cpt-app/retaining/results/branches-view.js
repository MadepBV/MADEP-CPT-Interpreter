// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// "Branches" tab: the four Belgian design branches side by side with every intermediate value.
import { esc, fmt, table, copyButton, toTsv } from './result-kit.js';

export function branchesView(rw, result) {
  if (!result?.branches) return '<div class="st6-help">Branches are reported for embedded walls only.</div>';
  const perPile = !!result.perPile;
  const uM = perPile ? 'kNm' : 'kNm/m', uF = perPile ? 'kN' : 'kN/m';
  const st = result.structural || {};
  const cards = result.branches.map((b) => {
    const gov = [st.combo, st.requiredDCombo].includes(b.id);
    const f = b.factors || {};
    return `<div class="st6-rw-branchcard${gov ? ' gov' : ''}">
      <h4>${esc(b.id)}${gov ? ' <span class="st6-rw-pill ok">governs</span>' : ''}</h4>
      <div class="f">γ<sub>G</sub> ${fmt(f.gG, 2)}${f.gGResist !== f.gG ? ` / ${fmt(f.gGResist, 2)} pass.` : ''} · γ<sub>Q</sub> ${fmt(f.gQ, 2)} · γ<sub>φ</sub> ${fmt(f.gPhi, 2)} · γ<sub>c</sub> ${fmt(f.gC, 2)}${f.effectFactor !== 1 ? ` · effects × ${fmt(f.effectFactor, 2)}` : ''}</div>
      <div class="st6-rw-kv">
        <dt>excavation</dt><dd>${fmt(-b.excavationEl, 2)}<small>m below nominal</small></dd>
        <dt>free-earth d₀</dt><dd>${fmt(b.d0, 3)}<small>m</small></dd>
        <dt>design d</dt><dd>${fmt(b.dDesign, 3)}<small>m</small></dd>
        <dt>ODF at provided</dt><dd>${fmt(b.odfProvided, 3)}</dd>
        ${b.T > 0 ? `<dt>T / T<sub>Ed</sub></dt><dd>${fmt(b.T, 1)} / ${fmt(b.TEd, 1)}<small>${uF}</small></dd>` : ''}
        <dt>M<sub>max</sub> / M<sub>Ed</sub></dt><dd>${fmt(b.Mmax, 1)} / ${fmt(b.MEd, 1)}<small>${uM} @ ${fmt(b.yMmax, 2)} m</small></dd>
        <dt>V<sub>max</sub> / V<sub>Ed</sub></dt><dd>${fmt(b.Vmax, 1)} / ${fmt(b.VEd, 1)}<small>${uF} @ ${fmt(b.yVmax, 2)} m</small></dd>
        <dt>z₀ (net = 0)</dt><dd>${b.zNetZero >= 0 ? fmt(b.zNetZero, 2) : '—'}<small>m below exc.</small></dd>
        <dt>p at surface / exc. / toe</dt><dd>${fmt(b.pSurface, 1)} / ${fmt(b.pExcavation, 1)} / ${fmt(b.pToeBack - b.pToeFront, 1)}<small>kPa</small></dd>
        ${b.lagging ? `<dt>lagging p<sub>Ed</sub></dt><dd>${fmt(b.lagging.total, 1)}<small>kPa</small></dd>` : ''}
      </div>
      ${!b.bracketed ? '<div class="st6-rw-note warn">No equilibrium within 40 m of embedment.</div>' : ''}${!b.closed ? '<div class="st6-rw-note warn">Moment diagram not closed on the provided pile (under-embedded for this branch).</div>' : ''}
    </div>`;
  }).join('');
  const selId = rw.ui?.branch && result.branches.some((b) => b.id === rw.ui.branch) ? rw.ui.branch : (st.combo || 'DA1-2');
  const sel = result.branches.find((b) => b.id === selId) || result.branches[0];
  const seg = `<span class="st6-rw-seg">${result.branches.map((b) => `<button type="button" class="${b.id === sel.id ? 'sel' : ''}" onclick="retwallSet('ui.branch','${b.id}')">${esc(b.id)}</button>`).join('')}</span>`;
  const layerCols = [
    { label: 'Layer top', key: 'topEl', render: (r) => fmt(r.topEl, 2) + ' m' },
    { label: 'framework', render: (r) => r.drained ? 'drained' : 'undrained' },
    { label: 'φ′<sub>k</sub> → φ′<sub>d</sub>', num: true, render: (r) => `${fmt(r.phiK, 1)} → ${fmt(r.phiD, 2)}°` },
    { label: 'c′<sub>k</sub> → c′<sub>d</sub>', num: true, render: (r) => `${fmt(r.cK, 1)} → ${fmt(r.cD, 2)}` },
    { label: 'c<sub>u,k</sub> → c<sub>u,d</sub>', num: true, render: (r) => `${fmt(r.cuK, 0)} → ${fmt(r.cuD, 1)}` },
    { label: 'K<sub>a</sub>', num: true, render: (r) => fmt(r.Ka, 4) },
    { label: 'K<sub>ac</sub> = 2√K<sub>a</sub>', num: true, render: (r) => fmt(r.Kac, 4) },
    { label: 'δ<sub>p</sub>', num: true, render: (r) => fmt(r.deltaP, 1) + '°' },
    { label: 'K<sub>p</sub> (Annex C)', num: true, render: (r) => fmt(r.Kp, 4) },
    { label: 'K<sub>pc</sub>', num: true, render: (r) => fmt(r.Kpc, 4) }
  ];
  const tsv = toTsv(['id', 'gG', 'gGResist', 'gQ', 'gPhi', 'gC', 'gCu', 'effectFactor', 'overdig_m', 'd0_m', 'dDesign_m', 'ODF', 'T', 'TEd', 'Mmax', 'MEd', 'yMmax', 'Vmax', 'VEd'], result.branches.map((b) => [b.id, b.factors.gG, b.factors.gGResist, b.factors.gQ, b.factors.gPhi, b.factors.gC, b.factors.gCu, b.factors.effectFactor, b.factors.overdig, b.d0, b.dDesign, b.odfProvided, b.T, b.TEd, b.Mmax, b.MEd, b.yMmax, b.Vmax, b.VEd]));
  return `<div class="st6-rw-branchcards">${cards}</div>
    <div class="st6-rw-actions">${seg}<span class="st6-help">design strengths and coefficients of the selected branch</span>${copyButton('copy branch table (TSV)', tsv)}</div>
    <div class="st6-rw-card-title">Retained side</div>${table(layerCols, sel.back || [])}
    <div class="st6-rw-card-title" style="margin-top:8px">Excavation side</div>${table(layerCols, sel.front || [])}
    <div class="st6-rw-note">${esc(sel.label)}. Design strengths: tan φ′<sub>d</sub> = tan φ′<sub>k</sub>/γ<sub>φ</sub>, c′<sub>d</sub> = c′<sub>k</sub>/γ<sub>c</sub>, c<sub>u,d</sub> = c<sub>u,k</sub>/γ<sub>cu</sub>; coefficients recomputed from φ′<sub>d</sub> (never K<sub>p</sub>/γ). ${result.perPile ? 'All forces per pile (× spacing above the excavation; b / b<sub>eff</sub> below).' : 'All forces per metre of wall.'}</div>`;
}
