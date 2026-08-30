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
// PR 20 (refactor step 10) moved the four Stage 7 capture host halves into ../seepslope/host.js
// (they own the canvas element, the frame box and the volatile model cache) and added
// `installReportApp(ctx)` at the bottom: the deps object the pure builder is fed, the Stage 7
// guard and `openStage7Report` (localStorage + window.open through ../report-storage.js, which
// the report routes import as well).

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

import { buildStage7Payload as buildStage7PayloadPure, STAGE7_GUARD_MESSAGE } from './payload.js';
import { cleanupStage7Payloads, saveStage7Payload } from '../report-storage.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installReportApp(ctx) — Stage 7 bound to a host (PR 20 / refactor step 10).
//
// `deps()` is everything the pure builder used to reach through the controller's closure, named:
// the model-parameter wrappers over the active CPT, the Stage 6 state normaliser, the host half
// of the automatic workspace capture (only called when an annex exists and no manual capture is
// stored — the same conditional as before) and the five Seep/Slope label helpers.
//
//   ctx.getProject(), ctx.getActive(), ctx.window, ctx.alert(message), ctx.toast(message, opts),
//   ctx.hsParams(l), ctx.khParams(l), ctx.workingLayers(), ctx.ensureStage6State(),
//   ctx.captureBishopWorkspaceView(workspace), ctx.seepslope  (the five label helpers)
export function installReportApp(ctx){
  const { getProject, getActive, alert, toast } = ctx;
  const app = {
    deps: () => ({
      hsParams: ctx.hsParams,
      khParams: ctx.khParams,
      workingLayers: ctx.workingLayers,
      ensureStage6State: ctx.ensureStage6State,
      captureBishopWorkspaceView: ctx.captureBishopWorkspaceView,
      seepslope: ctx.seepslope
    }),

    buildStage7Payload(){
      const S=getActive();
      if(!S.layers.length || !S.data.length){
        alert(STAGE7_GUARD_MESSAGE);
        return null;
      }
      return buildStage7PayloadPure(getProject(), S, app.deps());
    },

    openStage7Report(){
      const payload=app.buildStage7Payload();
      const win=ctx.window;
      if(!payload || !win) return;
      const key=saveStage7Payload(win.localStorage, payload);
      if(!key){
        toast('The Stage 7 report payload could not be validated for saving.',{tone:'bad'});
        return;
      }
      cleanupStage7Payloads(win.localStorage, key);
      win.open(`/report/stage7?key=${encodeURIComponent(key)}`, '_blank', 'noopener');
    }
  };
  app.handlers = {
    buildStage7Payload: app.buildStage7Payload,
    openStage7Report: app.openStage7Report
  };
  return app;
}
