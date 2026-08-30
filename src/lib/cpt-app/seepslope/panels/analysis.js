// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/analysis.js — the Analysis sheet: the Structure-response tab
// (legacy-controller.js 7083-7118), its tab strip (7119-7124) and the sheet that switches between
// Structure and the line probe (7125-7132), verbatim.
import { escAttr as stage6EscAttr, escJsString as stage6EscJsString } from '../../core/format.js';
import { wallMechanicalLabel as stage6BishopWallMechanicalLabel } from './labels.js';

/** The Structure tab: wall picker, wall card and the five response charts. */
export function structureAnalysisHtml(vm, env){
  const { bishop, analysisWall, analysisWallIndex, analysisWallResult, analysisWallSeries, analysisWallPartialBadge, analysisWallOptionHtml, wallChartsHtml, wallCopyMessage } = vm;
  return `
    <div class="st6-bishop-side" style="margin-top:14px">
      <div class="mc2-sec">Structure response</div>
      <div class="st6-help" style="margin-bottom:10px">The graphs use station <strong>s</strong> from the wall head to the tip on the vertical axis. The horizontal axis is the signed response value; positive V, M, and w act toward the wall passive side. For a right-passive wall, negative w plots to the left.</div>
      ${(bishop.walls || []).length ? `
        <label style="font-size:11px;color:var(--tx2);margin-bottom:10px;display:block">Wall
          <select onchange="stage6BishopOpenAnalysisTab('structure', this.value)">
            ${analysisWallOptionHtml}
          </select>
        </label>
      ` : ''}
      ${analysisWall ? `
        <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:10px">
          Wall: <strong>${analysisWallIndex + 1}</strong><br>
          Mechanical: <strong>${analysisWall.mechanicalActive === true ? 'active' : 'inactive'}</strong><br>
          Section: <strong>${stage6EscAttr(stage6BishopWallMechanicalLabel(analysisWall))}</strong><br>
          Result stations: <strong>${analysisWallResult?.stations?.length || 0}</strong><br>
          Soil–wall contact: <strong>${bishop.deformation?.result?.solver?.wallInterfaceActive
            ? 'single-sided Coulomb interface (gap + slip)'
            : 'bonded (no slip / no gap)'}</strong>
          ${bishop.deformation?.result?.solver?.wallInterfaceActive
            ? `<br><span style="font-size:11px;color:var(--tx2)">R_inter = ${Number(analysisWall?.interfaceRInter) > 0 ? Number(analysisWall.interfaceRInter).toFixed(2) : '0.667'}; below the excavation level the two soil sides share mesh nodes (no differential soil–soil slip across the wall plane — single-sided model).</span>`
            : ''}
          ${analysisWallPartialBadge ? `<br>${analysisWallPartialBadge}` : ''}
        </div>
        ${analysisWallResult && analysisWallSeries ? `
          <div class="st6-bishop-mini-actions" style="margin-bottom:10px">
            <button class="btn sm" onclick="stage6BishopSelectWall(${stage6EscJsString(analysisWall.id)})">Open wall settings</button>
            <button class="btn sm" onclick="stage6BishopCopyWallData(${stage6EscJsString(analysisWall.id)})">Copy wall data</button>
          </div>
          ${wallCopyMessage ? `<div class="st6-help" style="margin-bottom:10px">${stage6EscAttr(wallCopyMessage.length > 160 ? 'Wall response prepared as TSV.' : wallCopyMessage)}</div>` : ''}
          <div class="st6-wall-chart-grid">${wallChartsHtml}</div>
        ` : '<div class="st6-help" style="margin-bottom:10px">Run deformation with this wall mechanically active to inspect N, V, M, w, and theta diagrams.</div>'}
      ` : '<div class="st6-help" style="margin-bottom:10px">Draw a retaining wall in Structures, activate it mechanically, and run deformation to inspect structure response diagrams.</div>'}
    </div>
  `;
}

/** The two-tab strip of the Analysis sheet. */
export function analysisTabsHtml(vm, env){
  const { analysisTab } = vm;
  return `
    <div class="st6-analysis-tabs" role="tablist" aria-label="Analysis result views">
      <button type="button" class="st6-analysis-tab${analysisTab === 'line-probe' ? ' active' : ''}" onclick="stage6BishopSetAnalysisTab('line-probe')" role="tab" aria-selected="${analysisTab === 'line-probe' ? 'true' : 'false'}">Line probe</button>
      <button type="button" class="st6-analysis-tab${analysisTab === 'structure' ? ' active' : ''}" onclick="stage6BishopSetAnalysisTab('structure')" role="tab" aria-selected="${analysisTab === 'structure' ? 'true' : 'false'}">Structure</button>
    </div>
  `;
}

/** The Analysis sheet body. */
export function analysisSheetHtml(vm, env, fragments){
  const { analysisTab } = vm;
  const { lineProbeHtml, structureAnalysisHtml, analysisTabsHtml } = fragments;
  return `
    <div class="st6-canvas-sheet-grid">
      ${analysisTabsHtml}
      ${analysisTab === 'structure'
        ? structureAnalysisHtml
        : (lineProbeHtml || `<div class="st6-help" style="margin-bottom:10px">Line-probe analysis is available in the Seepage and Deformation workspaces.</div>`)}
    </div>
  `;
}
