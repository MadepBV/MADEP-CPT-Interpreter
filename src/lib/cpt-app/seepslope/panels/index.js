// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/ — the Seep / Slope app's HTML, one module per `data-st6details` group
// (refactor step 9f, PLAN §2 row 18f; 01-monolith-map.md §6.2 step 9f "panels, one
// `data-st6details` group at a time, plus the tool rail").
//
// `renderStage6BishopApp` was the last giant function of legacy-controller.js: 2 392 lines, a
// prelude of 196 local derivations and then twenty-six template locals closing over them. The split
// is the same one PR 18e used on the canvas:
//
//     state  →  view-model.js  →  sections/*.js · sheets · results · tool rail  →  layout.js
//
// Every module is a pure string builder over an explicit `(vm, env)`; none of them reads `S`, the
// DOM or the clock, and the emitted HTML is byte-identical to the monolith's — including its
// whitespace, its tab-indented lines and its attribute order. `scripts/verify_seepslope_panels.mjs`
// compares the whole `#stage6Area` innerHTML of the base and the working tree over a state matrix.
//
// The host `env` (SEEPSLOPE_PANELS_ENV in legacy-controller.js) is only what step 9f must not
// touch: the details memory, the seepage boundary and its selection, the two contour catalogues,
// the wall-result readers, `stage6MaxDepth()` and the two feature flags.
export { buildPanelsViewModel } from './view-model.js';
export { bishopAppHtml } from './layout.js';
export { canvasToolRailHtml, wallInfoPanelHtml } from './tool-rail.js';
export { appHeaderHtml, commandBarHtml, settingsHeadHtml } from './header.js';
export { canvasToolButton, toolIcon } from './icons.js';
export {
  depthBandReportHtml,
  modeMeta,
  partialLoadBadgeHtml,
  resultMethodLabel,
  seepageTerminationLabel,
  strengthSetLabel,
  wallMechanicalLabel
} from './labels.js';
export { safetyCurveHtml, safetyMechanismHtml } from './safety.js';
export { workspaceGeometrySectionHtml, workspaceSettingsHtml } from './workspace-sections.js';
export { workspaceCanvasHelp, workspaceInfoHtml } from './workspace-info.js';
export { lineProbeHtml, lineProbeSummaryHtml } from './line-probe.js';
export { analysisSheetHtml, analysisTabsHtml, structureAnalysisHtml } from './analysis.js';
export {
  boundarySheetHtml,
  canvasSheets,
  materialsSheetHtml,
  probeSheetHtml,
  regionsSheetHtml,
  resetSheetHtml,
  structuresSheetHtml,
  workspaceSheetHtml
} from './sheets.js';
export { workspaceResultsHtml } from './results.js';

// The twenty-four `data-st6details` groups of the app, in the order they appear in the DOM.
export { terrainSectionHtml } from './sections/geometry-terrain.js';
export { geometryRegionsSectionHtml } from './sections/geometry-regions.js';
export { geometrySetupSectionHtml } from './sections/geometry-setup.js';
export { analysisInputsSectionHtml } from './sections/geometry-analysis.js';
export { seepageBoundarySectionHtml } from './sections/geometry-seepage-boundary.js';
export { mechanicalInputsSectionHtml } from './sections/geometry-deformation.js';
export { geometryClearSectionHtml } from './sections/geometry-clear.js';
export { wallsSectionHtml } from './sections/walls.js';
export { searchSectionHtml } from './sections/search.js';
export { spencerSectionHtml } from './sections/spencer.js';
export { materialsSectionHtml } from './sections/materials.js';
export { seepagePermeabilitySectionHtml } from './sections/seepage-permeability.js';
export { seepageBcsSectionHtml } from './sections/seepage-bcs.js';
export { seepageDrainsSectionHtml } from './sections/seepage-drains.js';
export { seepageOptionsSectionHtml } from './sections/seepage-options.js';
export { seepageIntegrationSectionHtml } from './sections/seepage-integration.js';
export { deformationMaterialsSectionHtml } from './sections/deformation-materials.js';
export { deformationSolveSectionHtml } from './sections/deformation-solve.js';
export { deformationDiagnosticsSectionHtml } from './sections/deformation-diagnostics.js';
export { deformationSolverSettingsSectionHtml } from './sections/deformation-solver-settings.js';
export { viewSectionHtml } from './sections/view.js';
export { deformationContourLegendHtml } from './sections/deformation-contour-legend.js';
export { seepageContourLegendHtml } from './sections/seepage-contour-legend.js';
export {
  canvasViewMenuHtml,
  canvasViewMenuSectionHtml,
  viewMenuContourControlHtml,
  viewMenuWorkspaceOverlayHtml
} from './sections/canvas-view-menu.js';

/** The twenty-four `data-st6details` keys the settings column and the canvas own, in DOM order. */
export const PANEL_DETAILS_KEYS = [
  'bishop-geo-terrain',
  'bishop-geo-regions',
  'bishop-geo-setup',
  'bishop-geo-analysis',
  'bishop-geo-seepage-boundary',
  'bishop-geo-deformation',
  'bishop-geo-clear',
  'bishop-walls',
  'bishop-search',
  'bishop-spencer',
  'bishop-materials',
  'bishop-seepage-perm',
  'bishop-seepage-bcs',
  'bishop-seepage-drains',
  'bishop-seepage-options',
  'bishop-seepage-integration',
  'bishop-deformation-materials',
  'bishop-deformation-solve',
  'bishop-deformation-diagnostics',
  'bishop-deformation-solver-settings',
  'bishop-geo-view',
  'bishop-deformation-contour-legend',
  'bishop-seepage-contour-legend',
  'bishop-canvas-view-menu'
];

/** The two the tool rail's View card owns (they are not settings-column sections). */
export const TOOL_RAIL_DETAILS_KEYS = ['bishop-view-quick-snap', 'bishop-view-quick-layers'];
