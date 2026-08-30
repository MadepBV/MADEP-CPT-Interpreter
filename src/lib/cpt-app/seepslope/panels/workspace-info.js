// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/workspace-info.js — the settings column's per-workspace summary card and the
// canvas help line (legacy-controller.js 6975-7017 and 7018-7024), verbatim.
import { escAttr as stage6EscAttr } from '../../core/format.js';

/** The "Solver polygons / Terrain vertices / …" card, one shape per workspace. */
export function workspaceInfoHtml(vm, env){
  const { bishop, model, workspace, wallCount, loadSummary, customRegionCount, showingCustomRegionPreview, measurementStatus, seepage, deformation, seepageBoundary, selectedSeepageEdge, seepageActiveBcs, seepageOrphanedBcs, seepageHeadCount, seepageStatusLabel, deformationLoadMode, deformationMeshElementLabel, deformationOutOfPlaneLength, deformationStatusLabel, deformationAppliedQ, deformationRequestedInitialStressMode } = vm;
  const { stage6BishopSeepageEdgeLabel } = env;
  return workspace === 'stability' ? `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
              Solver polygons: <strong>${model?.regions?.length || 0}</strong> (${model?.regionMode === 'custom' ? 'custom' : 'CPT-derived'})<br>
              Custom polygons stored: <strong>${customRegionCount}</strong><br>
              Polygon overlay: <strong>${showingCustomRegionPreview ? 'custom preview' : (model?.regionMode === 'custom' ? 'custom active' : 'CPT-derived')}</strong><br>
              Terrain vertices: <strong>${bishop.terrain.length}</strong><br>
              Phreatic vertices: <strong>${bishop.phreatic.length}</strong><br>
              Retaining walls: <strong>${wallCount}</strong><br>
              Active CPT x: <strong>${Number.isFinite(bishop.activeCptX)?bishop.activeCptX.toFixed(2)+' m':'not placed'}</strong><br>
              Entry zone: <strong>${bishop.entryZone?`${bishop.entryZone.xStart.toFixed(2)}-${bishop.entryZone.xEnd.toFixed(2)} m`:'not set'}</strong><br>
              Exit zone: <strong>${bishop.exitZone?`${bishop.exitZone.xStart.toFixed(2)}-${bishop.exitZone.xEnd.toFixed(2)} m`:'not set'}</strong><br>
              Surface load: <strong>${loadSummary}</strong><br>
              Measurement: <strong>${stage6EscAttr(measurementStatus)}</strong>
            </div>
  ` : workspace === 'seepage' ? `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
              Shared geometry polygons: <strong>${model?.regions?.length || 0}</strong><br>
              Outer seepage boundary edges: <strong>${seepageBoundary.length}</strong><br>
              Explicit BCs: <strong>${seepageActiveBcs.length}</strong><br>
              Prescribed head edges: <strong>${seepageHeadCount}</strong><br>
              Orphaned BCs: <strong>${seepageOrphanedBcs.length}</strong><br>
              Selected edge: <strong>${selectedSeepageEdge ? stage6EscAttr(stage6BishopSeepageEdgeLabel(selectedSeepageEdge)) : 'none'}</strong><br>
              Free-surface mode: <strong>${stage6EscAttr(seepage.options?.freeSurface === 'iterate' ? 'iterative' : 'fixed')}</strong><br>
              Solver status: <strong>${stage6EscAttr(seepageStatusLabel)}</strong><br>
              Last head range: <strong>${seepage.result ? `${seepage.result.headMin.toFixed(2)} to ${seepage.result.headMax.toFixed(2)} m` : '—'}</strong><br>
              Measurement: <strong>${stage6EscAttr(measurementStatus)}</strong>
            </div>
  ` : `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
              Shared geometry polygons: <strong>${model?.regions?.length || 0}</strong><br>
              Active CPT x: <strong>${Number.isFinite(bishop.activeCptX)?bishop.activeCptX.toFixed(2)+' m':'not placed'}</strong><br>
	              Surface loads: <strong>${stage6EscAttr(loadSummary)}</strong><br>
	              Load mode: <strong>${deformationLoadMode === 'total' ? 'total load' : 'pressure q'}</strong><br>
	              Average active pressure q: <strong>${deformationAppliedQ > 0 ? `${deformationAppliedQ.toFixed(2)} kPa` : '—'}</strong><br>
              Element type: <strong>${stage6EscAttr(deformationMeshElementLabel)}</strong><br>
              Out-of-plane length: <strong>${deformationOutOfPlaneLength.toFixed(2)} m</strong><br>
              Seepage pore pressures: <strong>${deformation.options?.useSeepagePorePressures ? 'enabled when available' : 'off'}</strong><br>
              Initial workflow: <strong>${stage6EscAttr(deformationRequestedInitialStressMode)}</strong><br>
              Solver status: <strong>${stage6EscAttr(deformationStatusLabel)}</strong><br>
              Last max settlement: <strong>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxSettlement || 0)).toFixed(2)} mm` : '—'}</strong><br>
              Measurement: <strong>${stage6EscAttr(measurementStatus)}</strong>
            </div>
  `;
}

/** The one-paragraph canvas help under the section. */
export function workspaceCanvasHelp(vm, env){
  const { workspace, deformationIsSafety } = vm;
  return workspace === 'stability'
    ? 'Canvas order: draw terrain left-to-right or import a DXF terrain line, click <strong>Finish line</strong> to accept the terrain or phreatic line, place the active CPT on the terrain, optionally add retaining walls and one or more load zones, then draw the entry and exit zones. The coloured polygons are the solver regions from Phase A; hover one to inspect its current material parameters. In custom mode you can also select a polygon, drag its vertices, split it by clicking two boundary points, or cut an interior hole with a different material.'
    : workspace === 'seepage'
      ? 'The seepage workspace reuses the same Bishop section. Use <strong>Assign BC</strong> and click the terrain, model base, or side boundaries to assign prescribed head, no-flow, or seepage-face conditions, then click <strong>Run seepage</strong>. The same terrain, polygons, walls, snap settings, and viewport stay active while you switch between stability and seepage. Contour fill, contour lines, and the legend now follow the selected seepage field, while flow lines, the phreatic line, and exit-gradient highlights remain optional overlays. When a measurement line exists, the results panel can also probe heads, gradients, and discharge along it.'
	      : (deformationIsSafety
	        ? 'The deformation workspace also supports a c-phi reduction safety route. It first requires a converged Mohr-Coulomb plastic equilibrium state, then keeps the actions fixed while reducing strength through the multiplier ΣMsf. Self-weight-only safety runs are allowed when no surcharge is active. Contours and the shared line probe can inspect the additional safety displacement field and incremental safety plasticity band.'
	        : 'The deformation workspace reuses the same section mesh logic and geometry. Draw the load interval on the terrain, set either the pressure or total slab load, then run the drained plane-strain screen. The default Mohr-Coulomb plastic route builds a K0 seed and requires self-weight equilibrium before service loading. Contour fill, contour lines, the optional legend, and the shared measurement line all follow the selected deformation field.');
}
