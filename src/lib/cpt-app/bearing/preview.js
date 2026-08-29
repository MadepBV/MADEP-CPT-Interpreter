// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// bearing/preview.js — the partial DOM update of the bearing page while the Df slider moves
// (01-monolith-map.md §2.7 "Render" refreshStage6BearingPreview, §2.6 "Dispatch": setStage6Field
// `bearing.Df` short-circuits here instead of re-rendering the whole Stage 6 page; refactor step 7 / PR 12a).
//
// Moved verbatim out of legacy-controller.js 10664-10686 (integration-r):
//   refreshStage6BearingPreview() → refreshBearingPreview(cpt, workingLayers, queueChartBuild)
// The leading ensureStage6State() stays with the host (bearing/index.js calls ctx.ensure() first);
// `S` → cpt, stage6WorkingLayers() → workingLayers() (called after the app guard, as before),
// queueStage6BearingChartBuild() → the queue the host hands in. Recomputes the profile, writes it to
// `cpt.stage6Cache.bearing` (what the chart reads) and replaces the five result fragments in place.
import { bearingProfile } from './compute.js';
import { drainedFormulaHtml, governingResistance, materialParamsHtml, selectedDepthHtml, undrainedFormulaHtml } from './panel.js';

export function refreshBearingPreview(cpt, workingLayers, queueChartBuild){
  if(!cpt.layers.length || !cpt.stage6 || cpt.stage6.app !== 'bearing') return;
  const layers = workingLayers();
  const cfg = cpt.stage6.bearing;
  const profile = bearingProfile(cfg, layers, { wt: cpt.wt });
  if(!profile || !profile.selected) return;
  cpt.stage6Cache.bearing = profile;
  const sel = profile.selected;
  const { governing, governingMode } = governingResistance(sel);
  const dfValue = document.getElementById('stage6DfValue');
  if(dfValue) dfValue.textContent = sel.z.toFixed(2)+' m';
  const summary = document.getElementById('stage6SelectedDepth');
  if(summary) summary.innerHTML = selectedDepthHtml(sel, governing, governingMode);
  const material = document.getElementById('stage6UlsParams');
  if(material) material.innerHTML = materialParamsHtml(sel, cfg);
  const drainedFormula = document.getElementById('stage6DrainedFormula');
  if(drainedFormula) drainedFormula.innerHTML = drainedFormulaHtml(sel);
  const undrainedFormula = document.getElementById('stage6UndrainedFormula');
  if(undrainedFormula) undrainedFormula.innerHTML = undrainedFormulaHtml(sel);
  queueChartBuild();
}
