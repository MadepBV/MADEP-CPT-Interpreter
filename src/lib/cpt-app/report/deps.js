// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// report/deps.js — the explicit dependencies of buildStage7Payload(project, cpt, deps).
//
// New in PR 8 (refactor step 4). Everything the Stage 7 payload builders used to reach
// through the module-level closure of src/lib/cpt-app/legacy-controller.js is named here:
//
//   hsParams(layer) / khParams(layer) / workingLayers()
//       the model-params derivations — default: the pure model-params/ functions with
//       cptModelCtx(cpt) (what the controller wrappers hsParams/khParams/stage6WorkingLayers
//       compute for the active CPT);
//   ensureStage6State()
//       the Stage 6 state normaliser (fills defaults, clamps) the monolith called before
//       reading S.stage6 — default: no-op (a plain state object is taken as it is);
//   captureBishopWorkspaceView(workspace)
//       the automatic workspace screenshot. Until refactor step 9g this was the controller's
//       stage7CaptureBishopWorkspaceView, which temporarily switched the Stage 6 app / bishop
//       workspace, re-rendered, grabbed the live canvas and restored (01-monolith-map.md §3.4 #10 /
//       §6.3 item 7). PR 18g replaced it with seepslope/report/capture.js, which paints the frame
//       on an offscreen canvas from a view model built for the target workspace — no app switch, no
//       re-render, no write to S.stage6. `over.captureHost` carries the four things a payload build
//       cannot be pure about (the canvas factory, the frame box, the section model, the theme) plus
//       the canvas package's draw-time `env`; without it the capture is () => null, so a Node
//       payload build has no image exactly as before;
//   appVersion
//       the Vite define __APP_VERSION__ (vite.config.ts) — default: the monolith's
//       expression, '0.5.x' when the define is absent;
//   seepslope.{resultMethodLabel, seepageEdgeLabel, seepageBcTypeLabel, drainGatingLabel,
//              resolvedSeepageMeshTargetArea}
//       Seep/Slope helpers that stay in the controller until refactor step 9 — no default:
//       a missing one throws when a bishop / seepage annex needs it.

import { cptModelCtx, hsParams, khParams, workingLayers } from '../model-params/index.js';
import { bishopWorkspaceCapture } from '../seepslope/report/index.js';

const SEEPSLOPE_DEP_NAMES = ['resultMethodLabel', 'seepageEdgeLabel', 'seepageBcTypeLabel', 'drainGatingLabel', 'resolvedSeepageMeshTargetArea'];

function missingSeepslopeDep(name){
  return ()=>{
    throw new Error(`report/payload-seepslope: deps.seepslope.${name} is required (the helper stays in legacy-controller.js until refactor step 9)`);
  };
}

/** Resolve the Seep/Slope helper set (idempotent). */
export function seepslopeDeps(over = {}){
  const out = {};
  for(const name of SEEPSLOPE_DEP_NAMES) out[name] = over?.[name] || missingSeepslopeDep(name);
  return out;
}

/**
 * Resolve the Stage 7 deps for one CPT state (idempotent: a resolved object passes through).
 * @param {object} cpt   CPT state — only used for the defaults (cptModelCtx, workingLayers).
 * @param {object} over  partial deps.
 */
export function stage7Deps(cpt, over = {}){
  const mctx = cptModelCtx(cpt);
  return {
    hsParams: over.hsParams || ((layer)=>hsParams(layer, mctx)),
    khParams: over.khParams || ((layer)=>khParams(layer, mctx)),
    workingLayers: over.workingLayers || (()=>workingLayers(cpt)),
    ensureStage6State: over.ensureStage6State || (()=>{}),
    captureBishopWorkspaceView: over.captureBishopWorkspaceView || bishopWorkspaceCapture(cpt, over.captureHost),
    appVersion: over.appVersion ?? (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.5.x'),
    seepslope: seepslopeDeps(over.seepslope)
  };
}
