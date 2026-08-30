// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/layout.js — the composition root of the Seep / Slope panels (refactor step 9f).
// It is `renderStage6BishopApp`'s tail, verbatim: the twenty-six locals the monolith computed
// between its prelude and its `return` (legacy-controller.js 6452-7983) — each now one call into
// the module that owns that block, computed **once**, in the monolith's order, and handed on as
// `fragments` exactly as the monolith's locals were — followed by the return template itself
// (7984-8228) with the five `data-st6details` groups of the settings column, the header, the
// settings head and the command bar substituted at their own `${…}`.
import { workspaceGeometrySectionHtml as buildWorkspaceGeometrySectionHtml, workspaceSettingsHtml as buildWorkspaceSettingsHtml } from './workspace-sections.js';
import { workspaceCanvasHelp as buildWorkspaceCanvasHelp, workspaceInfoHtml as buildWorkspaceInfoHtml } from './workspace-info.js';
import { lineProbeHtml as buildLineProbeHtml, lineProbeSummaryHtml as buildLineProbeSummaryHtml } from './line-probe.js';
import { analysisSheetHtml as buildAnalysisSheetHtml, analysisTabsHtml as buildAnalysisTabsHtml, structureAnalysisHtml as buildStructureAnalysisHtml } from './analysis.js';
import { boundarySheetHtml as buildBoundarySheetHtml, canvasSheets as buildCanvasSheets, materialsSheetHtml as buildMaterialsSheetHtml, probeSheetHtml as buildProbeSheetHtml, regionsSheetHtml as buildRegionsSheetHtml, resetSheetHtml as buildResetSheetHtml, structuresSheetHtml as buildStructuresSheetHtml, workspaceSheetHtml as buildWorkspaceSheetHtml } from './sheets.js';
import { workspaceResultsHtml as buildWorkspaceResultsHtml } from './results.js';
import { viewSectionHtml as buildViewSectionHtml } from './sections/view.js';
import { deformationContourLegendHtml as buildDeformationContourLegendHtml } from './sections/deformation-contour-legend.js';
import { seepageContourLegendHtml as buildSeepageContourLegendHtml } from './sections/seepage-contour-legend.js';
import { canvasViewMenuHtml as buildCanvasViewMenuHtml } from './sections/canvas-view-menu.js';
import { terrainSectionHtml } from './sections/geometry-terrain.js';
import { geometryRegionsSectionHtml } from './sections/geometry-regions.js';
import { geometrySetupSectionHtml } from './sections/geometry-setup.js';
import { geometryClearSectionHtml } from './sections/geometry-clear.js';
import { wallsSectionHtml } from './sections/walls.js';
import { appHeaderHtml, commandBarHtml, settingsHeadHtml } from './header.js';
import { canvasToolRailHtml } from './tool-rail.js';
import { noteHtml as stage6NoteHtml } from '../../core/format.js';

/** The whole `#stage6Area` body of the Seep / Slope app, in the monolith's order. */
export function bishopAppHtml(vm, env){
  const { bishop, model, workspace, loadQ, selectedCustomRegion, settingsCollapsed, settingsWide, selectedSeepageEdge, selectedSeepageBc, seepageMeshTargetArea, toolbarRunLabel, toolbarRunAction, toolbarStopAction, toolbarClearAction, toolbarClearLabel, toolbarRunReady, toolbarRunning, toolbarHasResult, toolbarProgressText } = vm;
  const fragments = {};
  fragments.workspaceGeometrySectionHtml = buildWorkspaceGeometrySectionHtml(vm, env);
  fragments.workspaceSettingsHtml = buildWorkspaceSettingsHtml(vm, env);
  fragments.workspaceInfoHtml = buildWorkspaceInfoHtml(vm, env);
  fragments.workspaceCanvasHelp = buildWorkspaceCanvasHelp(vm, env);
  fragments.lineProbeSummaryHtml = buildLineProbeSummaryHtml(vm, env);
  fragments.lineProbeHtml = buildLineProbeHtml(vm, env, fragments);
  fragments.structureAnalysisHtml = buildStructureAnalysisHtml(vm, env);
  fragments.analysisTabsHtml = buildAnalysisTabsHtml(vm, env);
  fragments.analysisSheetHtml = buildAnalysisSheetHtml(vm, env, fragments);
  fragments.viewSectionHtml = buildViewSectionHtml(vm, env);
  fragments.deformationContourLegendHtml = buildDeformationContourLegendHtml(vm, env);
  fragments.seepageContourLegendHtml = buildSeepageContourLegendHtml(vm, env);
  fragments.activeContourLegendHtml = workspace === 'seepage'
    ? fragments.seepageContourLegendHtml
    : fragments.deformationContourLegendHtml;
  fragments.canvasViewMenuHtml = buildCanvasViewMenuHtml(vm, env);
  fragments.structuresSheetHtml = buildStructuresSheetHtml(vm, env, fragments);
  fragments.boundarySheetHtml = buildBoundarySheetHtml(vm, env, fragments);
  fragments.regionsSheetHtml = buildRegionsSheetHtml(vm, env, fragments);
  fragments.materialsSheetHtml = buildMaterialsSheetHtml(vm, env, fragments);
  fragments.workspaceSheetHtml = buildWorkspaceSheetHtml(vm, env, fragments);
  fragments.resetSheetHtml = buildResetSheetHtml(vm, env, fragments);
  fragments.probeSheetHtml = buildProbeSheetHtml(vm, env, fragments);
  fragments.canvasSheets = buildCanvasSheets(vm, env, fragments);
  fragments.canvasToolRailHtml = canvasToolRailHtml({
    bishop,
    workspace,
    model,
    selectedCustomRegion,
    selectedSeepageEdge,
    selectedSeepageBc,
    loadQ,
    seepageMeshTargetArea,
    toolbarRunLabel,
    toolbarRunAction,
    toolbarRunReady,
    toolbarStopAction,
    toolbarRunning,
    toolbarClearLabel,
    toolbarClearAction,
    toolbarHasResult,
    toolbarProgressText,
    canvasSheets: fragments.canvasSheets
  }, env);
  fragments.workspaceResultsHtml = buildWorkspaceResultsHtml(vm, env);
  const { activeContourLegendHtml, canvasToolRailHtml: canvasToolRail, canvasViewMenuHtml,
    workspaceCanvasHelp, workspaceGeometrySectionHtml, workspaceInfoHtml, workspaceResultsHtml,
    workspaceSettingsHtml } = fragments;
  return `
    <div class="mc2 st6-bishop">${appHeaderHtml(vm, env)}
      <div class="st6-bishop-layout${settingsCollapsed ? ' st6-bishop-layout--settings-collapsed' : ''}${settingsWide ? ' st6-bishop-layout--settings-wide' : ''}">
        <div class="st6-bishop-side st6-bishop-settings-panel">${settingsHeadHtml(vm, env)}
          <div class="ctrl-row st6-bishop-controls">
	            <div class="st6-help">Draw a monotonic terrain, or import a DXF containing exactly one open polyline. Imported terrain is shifted so its leftmost vertex becomes <strong>(0, 0)</strong>. Then place or review the active CPT, optionally add infinitely stiff retaining walls and one or more uniform surcharge strips, and define the entry and exit daylight zones. The active CPT layer model is extended horizontally across the section for the Bishop search.</div>
            <div class="st6-bishop-tool-groups">${terrainSectionHtml(vm, env)}${geometryRegionsSectionHtml(vm, env)}${geometrySetupSectionHtml(vm, env)}
              ${workspaceGeometrySectionHtml}${geometryClearSectionHtml(vm, env)}
            </div>
            ${workspaceInfoHtml}${wallsSectionHtml(vm, env)}
            ${workspaceSettingsHtml}
          </div>
        </div>
        <div class="st6-bishop-main">
          <div class="st6-bishop-canvas-wrap">${commandBarHtml(vm, env)}
            <div class="st6-bishop-canvas-stage">
              ${canvasToolRail}
              <canvas id="stage6BishopCanvas" class="st6-bishop-canvas" role="img" aria-label="Seep/Slope section and slip circles"></canvas>
              ${toolbarHasResult ? `
                <button
                  type="button"
                  class="st6-canvas-capture${bishop.capturedView?.[workspace] ? ' has-capture' : ''}"
                  onclick="stage7CaptureWorkspaceView('${workspace}')"
                  aria-label="${bishop.capturedView?.[workspace]
                    ? 'Recapture the current canvas view for the Stage 7 report. Last captured at ' + new Date(bishop.capturedView[workspace].capturedAt).toLocaleTimeString() + '.'
                    : 'Capture the current canvas view for the Stage 7 report.'}"
                  title="${bishop.capturedView?.[workspace]
                    ? 'Captured ' + new Date(bishop.capturedView[workspace].capturedAt).toLocaleTimeString() + ' · click to recapture'
                    : 'Capture for Stage 7 report'}"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                    <path d="M4 7h3.2l1.6-2h6.4l1.6 2H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                    <circle cx="12" cy="13" r="3.4" fill="none" stroke="currentColor" stroke-width="1.6"/>
                  </svg>
                  ${bishop.capturedView?.[workspace] ? '<span class="st6-canvas-capture__check" aria-hidden="true">✓</span>' : ''}
                </button>
              ` : ''}
              ${canvasViewMenuHtml}
              ${activeContourLegendHtml}
	              <div id="stage6BishopTip" class="section-tip st6-bishop-tip"></div>
	            </div>
	            <div id="stage6BishopCoord" class="st6-bishop-coord"></div>
	            <div class="st6-help" style="margin-top:10px">${workspaceCanvasHelp}</div>
	          </div>
	          ${workspaceResultsHtml}
	        </div>
	      </div>
		      ${workspace === 'deformation' ? '' : stage6NoteHtml(workspace === 'seepage'
	          ? [
	              {level:'warn', text:'This Stage 6 seepage workflow is experimental. It solves steady-state 2D seepage on a constrained triangular FEM mesh built from the shared section geometry.'},
	              {level:'info', text:'The soil model is derived from the active CPT only. The interpreted layer column is extended horizontally across the drawn section for this workflow.'},
	              {level:'info', text:'Use prescribed-head, seepage-face, and no-flow conditions only on the terrain, side, and base boundaries. Interior polygon edges are material interfaces, not seepage boundaries.'},
              {level:'info', text:'The seepage result can be reused by the deformation screen and, when enabled, by the Bishop/Spencer pore-pressure hook without redrawing the section.'}
            ]
          : [
	              {level:'warn', text:'This Stage 6 slope check is experimental. It searches circular slip surfaces only and currently uses self-weight, optional infinitely stiff retaining walls, multiple optional uniform surcharge strips, and optional phreatic pore pressure along the base.'},
              {level:'info', text:'The soil model is derived from the active CPT only. The interpreted layer column is extended horizontally across the drawn section for this workflow.'},
	              {level:'info', text:'Spencer runs as a verification pass on the best Bishop circles. Each shortlisted circle is solved by intersecting the Spencer moment and force branches. If Spencer does not converge for a shortlisted circle, the app keeps the Bishop result and flags that fallback in the results panel.'},
	              {level:'info', text:'When a circle intersects a retaining wall, Bishop reduces the driving moment with the wall resistance and Spencer injects the same wall force into the horizontal force chain. Circles that pass below the wall tip remain unchanged and may still govern.'}
	            ]
	      )}
    </div>
  `;
}
