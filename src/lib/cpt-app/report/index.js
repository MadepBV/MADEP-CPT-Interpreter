// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// report/index.js — public surface of the Stage 7 report package
// (01-monolith-map.md §6.1 row `report/`, extracted in PR 8 / refactor step 4).
//
//   payload.js           buildStage7Payload(project, cpt, deps) → payload | null,
//                        stage7LayerWarnings / stage7TuningPayload / stage7WorkingLayerPayload,
//                        the label helpers, STAGE7_GUARD_MESSAGE
//   payload-stage6.js    stage7Stage6Payload(cpt, workingLayers, deps)  (bearing … pile annexes)
//   payload-seepslope.js stage7BishopPayload / stage7SeepagePayload / stage7DeformationPayload
//   deps.js              stage7Deps(cpt, over) — the explicit deps (model-params defaults,
//                        ensureStage6State, the workspace capture, appVersion, seepslope helpers)
//   clone.js             safeClone
//   svg.js               buildLayerColumnSvgMarkup / buildLayerPreviewSvgMarkup (was report-svg.js)
//
// The workspace capture moved to ../seepslope/report/capture.js in refactor step 9g (PR 18g): it
// paints the Seep / Slope frame on an offscreen canvas instead of switching the Stage 6 app and
// re-rendering, and `deps.js` binds it through `bishopWorkspaceCapture(cpt, over.captureHost)`.
// Still in legacy-controller.js: the four host halves — stage7CaptureCanvasImage (reads
// #stage6BishopCanvas by id), stage7CaptureWorkspaceView / stage7ClearWorkspaceCapture (the
// toolbar button: it writes S.stage6 and re-renders on purpose) and openStage7Report (localStorage
// + window.open, through ../report-storage.js which the report routes import as well).

export {
  STAGE7_GUARD_MESSAGE,
  stage7MethodLabel, stage7ParamMethodLabel, stage7AlphaMethodLabel, stage7StiffMethodLabel,
  stage7WtSourceLabel, stage7ElevSourceLabel,
  stage7LayerWarnings, stage7TuningPayload, stage7WorkingLayerPayload,
  buildStage7Payload
} from './payload.js';
export { stage7Stage6Payload } from './payload-stage6.js';
export { stage7BishopPayload, stage7SeepagePayload, stage7DeformationPayload } from './payload-seepslope.js';
export { stage7Deps, seepslopeDeps } from './deps.js';
export { safeClone } from './clone.js';
export { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from './svg.js';
