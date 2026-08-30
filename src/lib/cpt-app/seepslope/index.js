// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/index.js — public surface of the Seep / Slope package (01-monolith-map.md §6.1 row
// `seepslope/`). The domain itself was carved out in refactor step 9 (PRs 18a-18g):
//
//   state/     the bishop state schema, its migrations and every entity helper   (pure)
//   model/     the soil-model sync and the four result invalidations             (pure patches)
//   run/       the three runs as request builders + result reducers, one worker adapter
//   geometry/  points, polygons, boundary picking / splitting, the Measure line  (pure)
//   probe/     the line-probe catalogue, sampler and clipboard readout           (pure)
//   canvas/    viewport, snapping, the pointer state machine, view model, 14 draw layers
//   panels/    one module per `data-st6details` group over one pure view model   (pure strings)
//   report/    the Stage 7 workspace screenshot, rasterised offscreen
//   contours/  the seepage and deformation contour catalogues + their palettes   (PR 20)
//   wall/      the wall-response quantities and the five small diagrams          (PR 20)
//   host.js    the host half none of the above can own — the active CPT, the DOM, the workers,
//              the canvas element, the volatile model cache and the state→render handlers
//
// `installSeepSlopeApp(ctx)` is the last piece (PR 20 / refactor step 10): it binds host.js to
// the composition root and names the handlers the Seep/Slope markup publishes on `window`.

export { createSeepSlopeHost } from './host.js';

import { createSeepSlopeHost } from './host.js';

/**
 * The Seep / Slope application bound to a host.
 *
 *   ctx.document, ctx.getActive()                       the DOM and the active CPT
 *   ctx.hardeningSoilUi                                 STAGE6_ENABLE_HARDENING_SOIL_UI
 *   ctx.ensureStage6State(), ctx.renderStage6(),        the Stage 6 shell install
 *   ctx.stage6RememberDetailsState(), ctx.stage6DetailsOpen(k), ctx.stage6SetDetailsOpen(k, o),
 *   ctx.stage6BishopUiState(), ctx.stage6WorkingLayers(), ctx.stage6MaxDepth(),
 *   ctx.stage6Defaults()
 *
 * Returns every monolith name of the Seep / Slope host layer plus `handlers`, the subset the
 * inline `on*=` attributes of seepslope/panels/** resolve at event time.
 */
export function installSeepSlopeApp(ctx){
  const app = createSeepSlopeHost(ctx);
  app.handlers = {
    // workspace, tool and canvas chrome
    stage6BishopSetWorkspace: app.stage6BishopSetWorkspace,
    stage6BishopSetField: app.stage6BishopSetField,
    stage6BishopSetTool: app.stage6BishopSetTool,
    stage6BishopToggleSettingsPanel: app.stage6BishopToggleSettingsPanel,
    stage6BishopToggleSettingsWidth: app.stage6BishopToggleSettingsWidth,
    stage6BishopToggleToolRail: app.stage6BishopToggleToolRail,
    stage6BishopToggleCanvasTools: app.stage6BishopToggleCanvasTools,
    stage6BishopSetCanvasPanel: app.stage6BishopSetCanvasPanel,
    stage6BishopSetCanvasSheet: app.stage6BishopSetCanvasSheet,
    stage6BishopOpenSettingsDetail: app.stage6BishopOpenSettingsDetail,
    fitStage6BishopViewport: app.fitStage6BishopViewport,
    // surface loads
    stage6BishopSelectSurfaceLoad: app.stage6BishopSelectSurfaceLoad,
    stage6BishopSetSurfaceLoadField: app.stage6BishopSetSurfaceLoadField,
    stage6BishopDeleteSurfaceLoad: app.stage6BishopDeleteSurfaceLoad,
    // terrain import / export and the custom soil polygons
    stage6BishopTriggerDxfImport: app.stage6BishopTriggerDxfImport,
    stage6BishopImportDxf: app.stage6BishopImportDxf,
    stage6BishopCopyCurrentRegionsToCustom: app.stage6BishopCopyCurrentRegionsToCustom,
    stage6BishopExportRegionsDxf: app.stage6BishopExportRegionsDxf,
    stage6BishopSetUseCustomRegions: app.stage6BishopSetUseCustomRegions,
    stage6BishopDeleteSelectedRegion: app.stage6BishopDeleteSelectedRegion,
    stage6BishopSetSelectedRegionMaterial: app.stage6BishopSetSelectedRegionMaterial,
    stage6BishopSetSelectedRegionCoarseness: app.stage6BishopSetSelectedRegionCoarseness,
    stage6BishopFinishDraft: app.stage6BishopFinishDraft,
    stage6BishopPopDraftPoint: app.stage6BishopPopDraftPoint,
    stage6BishopClear: app.stage6BishopClear,
    // materials
    stage6BishopSetMaterialField: app.stage6BishopSetMaterialField,
    stage6BishopSetMaterialHsField: app.stage6BishopSetMaterialHsField,
    stage6BishopResolveHsConsistentTangentMigration: app.stage6BishopResolveHsConsistentTangentMigration,
    stage6BishopSetMaterialPermeability: app.stage6BishopSetMaterialPermeability,
    stage6BishopResetMaterialPermeability: app.stage6BishopResetMaterialPermeability,
    // retaining walls
    stage6BishopSetWallField: app.stage6BishopSetWallField,
    stage6BishopSetWallMaterialField: app.stage6BishopSetWallMaterialField,
    stage6BishopDeleteWall: app.stage6BishopDeleteWall,
    stage6BishopSelectWall: app.stage6BishopSelectWall,
    stage6BishopToggleWallMomentOverlay: app.stage6BishopToggleWallMomentOverlay,
    stage6BishopOpenAnalysisTab: app.stage6BishopOpenAnalysisTab,
    stage6BishopSetAnalysisTab: app.stage6BishopSetAnalysisTab,
    stage6BishopResolveWallMechanicalActivation: app.stage6BishopResolveWallMechanicalActivation,
    stage6BishopCopyWallData: app.stage6BishopCopyWallData,
    // drains and seepage boundary conditions
    stage6BishopSelectDrain: app.stage6BishopSelectDrain,
    stage6BishopSetDrainField: app.stage6BishopSetDrainField,
    stage6BishopDeleteDrain: app.stage6BishopDeleteDrain,
    stage6BishopSelectSeepageBoundary: app.stage6BishopSelectSeepageBoundary,
    stage6BishopSetSeepageBcType: app.stage6BishopSetSeepageBcType,
    stage6BishopSetSeepageBcHead: app.stage6BishopSetSeepageBcHead,
    stage6BishopDeleteSeepageBc: app.stage6BishopDeleteSeepageBc,
    // the three runs and their results
    stage6BishopRunSeepage: app.stage6BishopRunSeepage,
    stage6BishopStopSeepage: app.stage6BishopStopSeepage,
    stage6BishopRunDeformation: app.stage6BishopRunDeformation,
    stage6BishopStopDeformation: app.stage6BishopStopDeformation,
    stage6BishopRunSearch: app.stage6BishopRunSearch,
    stage6BishopStopSearch: app.stage6BishopStopSearch,
    stage6BishopSelectResult: app.stage6BishopSelectResult,
    stage6BishopCopyLineProbeData: app.stage6BishopCopyLineProbeData,
    // the Stage 7 workspace screenshot
    stage7CaptureWorkspaceView: app.stage7CaptureWorkspaceView,
    stage7ClearWorkspaceCapture: app.stage7ClearWorkspaceCapture
  };
  return app;
}
