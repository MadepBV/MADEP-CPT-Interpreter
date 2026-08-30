// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// "Diagrams" tab: pressures, shear and moment of the selected branch (canvas charts).
import { esc, fmt } from './result-kit.js';
import { drawDepthChart } from '../retaining-charts.js';
import { pickBranch } from '../scenes/embedded-scene.js';
import { retainingVizSeries } from '../../../styles/theme.ts';

export function diagramsView(rw, result) {
  if (!result?.branches) return '<div class="card card--quiet card--note">Diagrams are available for embedded walls.</div>';
  const sel = pickBranch(result, rw.ui?.branch);
  const seg = `<span class="segmented segmented--sm segmented--text" role="group">${result.branches.map((b) => `<button type="button" class="segmented__btn" aria-pressed="${b.id === sel.id ? 'true' : 'false'}" onclick="retwallSet('ui.branch','${b.id}')">${esc(b.id)}</button>`).join('')}</span>`;
  const wallSeg = `<span class="segmented segmented--sm segmented--text" role="group">${[['M', 'moment'], ['V', 'shear'], ['p', 'net pressure']].map(([k, l]) => `<button type="button" class="segmented__btn" aria-pressed="${(rw.ui?.diagram || 'M') === k ? 'true' : 'false'}" onclick="retwallSet('ui.diagram','${k}')">${l}</button>`).join('')}</span>`;
  return `<div class="actions">${seg}<span class="field__hint">branch</span>&nbsp;&nbsp;${wallSeg}<span class="field__hint">drawn on the section</span></div>
    <div class="cols-2">
      <div class="viz viz--chart viz--tall"><canvas id="retwallChartPressure"></canvas></div>
      <div class="viz viz--chart viz--tall"><canvas id="retwallChartVM"></canvas></div>
    </div>
    <div class="card__text">${esc(sel.label)}. Depth from the retained surface. Pressures are the unfactored ordinates per unit width of the acting face (retained side incl. surcharge; excavation side = passive resistance${result.perPile ? ', per pile below the excavation for the Brinch Hansen model' : ''}); the net pressure, V and M are factored with this branch's partial factors${result.perPile ? ' and multiplied by the acting widths (per pile)' : ''}. The V/M tail beyond the free-earth closure is set to zero (no toe reaction is modelled beyond it).</div>`;
}

export function drawDiagramCharts(rw, result) {
  const sel = pickBranch(result, rw.ui?.branch);
  if (!sel) return;
  const S = retainingVizSeries();
  const D = sel.diagrams || {};
  const H = Number(rw.embedded.retainedHeight) || 5;
  const depthMax = H - sel.toeEl;
  const markers = [{ depth: H - sel.excavationEl, label: 'design excavation', color: S.excavation }, { depth: sel.closureDepth, label: 'free-earth closure', color: S.closure }];
  if (result.wallType === 'anchored' || (rw.embedded.anchored && result.wallType === 'soldierpile')) markers.push({ depth: Number(rw.embedded.anchorDepth) || 1.5, label: 'anchor', color: S.anchor });
  const c1 = document.getElementById('retwallChartPressure');
  const c2 = document.getElementById('retwallChartVM');
  if (c1 && D.pBack) drawDepthChart(c1, {
    title: 'Pressures (kPa)', unit: 'kPa', depthMax, markers,
    series: [
      { z: D.pBack.z, v: D.pBack.v, color: S.retained, label: 'retained side (earth + q)', fill: S.retainedSoft },
      { z: D.pFront.z, v: D.pFront.v.map((x) => -x), color: S.passive, label: 'excavation side (resistance, −)', fill: S.passiveSoft },
      { z: D.uBack.z, v: D.uBack.v, color: S.water, label: 'water, retained', width: 1.2 },
      { z: D.uFront.z, v: D.uFront.v.map((x) => -x), color: S.waterFront, label: 'water, excavation (−)', width: 1.2 },
      { z: D.net.z, v: D.net.v, color: S.net, label: `net (factored, ${D.net.unit})`, width: 1.4 }
    ]
  });
  if (c2 && D.M) drawDepthChart(c2, {
    title: `Shear and moment (${D.M.unit})`, unit: `${D.V.unit} · ${D.M.unit}`, depthMax, markers,
    series: [
      { z: D.V.z, v: D.V.v, color: S.shear, label: `V (${D.V.unit})`, fill: S.shearSoft },
      { z: D.M.z, v: D.M.v, color: S.moment, label: `M (${D.M.unit}) · M_max ${fmt(sel.Mmax, 1)} @ ${fmt(sel.yMmax, 2)} m`, fill: S.momentSoft }
    ]
  });
}
