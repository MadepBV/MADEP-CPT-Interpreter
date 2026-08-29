// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// "Diagrams" tab: pressures, shear and moment of the selected branch (canvas charts).
import { esc, fmt } from './result-kit.js';
import { drawDepthChart } from '../retaining-charts.js';
import { pickBranch } from '../scenes/embedded-scene.js';

export function diagramsView(rw, result) {
  if (!result?.branches) return '<div class="st6-help">Diagrams are available for embedded walls.</div>';
  const sel = pickBranch(result, rw.ui?.branch);
  const seg = `<span class="st6-rw-seg">${result.branches.map((b) => `<button type="button" class="${b.id === sel.id ? 'sel' : ''}" onclick="retwallSet('ui.branch','${b.id}')">${esc(b.id)}</button>`).join('')}</span>`;
  const wallSeg = `<span class="st6-rw-seg">${[['M', 'moment'], ['V', 'shear'], ['p', 'net pressure']].map(([k, l]) => `<button type="button" class="${(rw.ui?.diagram || 'M') === k ? 'sel' : ''}" onclick="retwallSet('ui.diagram','${k}')">${l}</button>`).join('')}</span>`;
  return `<div class="st6-rw-actions">${seg}<span class="st6-help">branch</span>&nbsp;&nbsp;${wallSeg}<span class="st6-help">drawn on the section</span></div>
    <div class="st6-rw-grid2">
      <canvas class="st6-rw-chart tall" id="retwallChartPressure"></canvas>
      <canvas class="st6-rw-chart tall" id="retwallChartVM"></canvas>
    </div>
    <div class="st6-rw-note">${esc(sel.label)}. Depth from the retained surface. Pressures are the unfactored ordinates per unit width of the acting face (retained side incl. surcharge; excavation side = passive resistance${result.perPile ? ', per pile below the excavation for the Brinch Hansen model' : ''}); the net pressure, V and M are factored with this branch's partial factors${result.perPile ? ' and multiplied by the acting widths (per pile)' : ''}. The V/M tail beyond the free-earth closure is set to zero (no toe reaction is modelled beyond it).</div>`;
}

export function drawDiagramCharts(rw, result) {
  const sel = pickBranch(result, rw.ui?.branch);
  if (!sel) return;
  const D = sel.diagrams || {};
  const H = Number(rw.embedded.retainedHeight) || 5;
  const depthMax = H - sel.toeEl;
  const markers = [{ depth: H - sel.excavationEl, label: 'design excavation', color: '#b43c32' }, { depth: sel.closureDepth, label: 'free-earth closure', color: '#2e6f55' }];
  if (result.wallType === 'anchored' || (rw.embedded.anchored && result.wallType === 'soldierpile')) markers.push({ depth: Number(rw.embedded.anchorDepth) || 1.5, label: 'anchor', color: '#18181a' });
  const c1 = document.getElementById('retwallChartPressure');
  const c2 = document.getElementById('retwallChartVM');
  if (c1 && D.pBack) drawDepthChart(c1, {
    title: 'Pressures (kPa)', unit: 'kPa', depthMax, markers,
    series: [
      { z: D.pBack.z, v: D.pBack.v, color: '#9b3a32', label: 'retained side (earth + q)', fill: 'rgba(155,58,50,0.10)' },
      { z: D.pFront.z, v: D.pFront.v.map((x) => -x), color: '#2e6f55', label: 'excavation side (resistance, −)', fill: 'rgba(46,111,85,0.10)' },
      { z: D.uBack.z, v: D.uBack.v, color: '#3d6b6a', label: 'water, retained', width: 1.2 },
      { z: D.uFront.z, v: D.uFront.v.map((x) => -x), color: '#7aa6a5', label: 'water, excavation (−)', width: 1.2 },
      { z: D.net.z, v: D.net.v, color: '#18181a', label: `net (factored, ${D.net.unit})`, width: 1.4 }
    ]
  });
  if (c2 && D.M) drawDepthChart(c2, {
    title: `Shear and moment (${D.M.unit})`, unit: `${D.V.unit} · ${D.M.unit}`, depthMax, markers,
    series: [
      { z: D.V.z, v: D.V.v, color: '#8a620d', label: `V (${D.V.unit})`, fill: 'rgba(138,98,13,0.10)' },
      { z: D.M.z, v: D.M.v, color: '#7e50a8', label: `M (${D.M.unit}) · M_max ${fmt(sel.Mmax, 1)} @ ${fmt(sel.yMmax, 2)} m`, fill: 'rgba(126,80,168,0.12)' }
    ]
  });
}
