// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// report/payload-stage6.js — the Stage 6 annexes of the Stage 7 payload: bearing,
// settlement, dewatering, beam and pile (config + cached analysis) plus the Seep/Slope
// annexes with their workspace views.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 8, refactor step 4):
// stage7Stage6Payload (old lines 16495-16574 at c989770). Changes inside the body: the CPT
// state is a parameter (`cpt`) instead of the module-level active CPT `S`; the automatic
// workspace capture is `deps.captureBishopWorkspaceView`, called under exactly the old
// conditional: only when the annex exists and no manual capture is stored. (Until refactor
// step 9g that dep was the controller's stage7CaptureBishopWorkspaceView, which switched the
// Stage 6 app and re-rendered; PR 18g made it seepslope/report/capture.js, an offscreen
// render — so building a payload no longer perturbs the UI.)

import { safeClone } from './clone.js';
import { stage7Deps } from './deps.js';
import { stage7BishopPayload, stage7DeformationPayload, stage7SeepagePayload } from './payload-seepslope.js';

export function stage7Stage6Payload(cpt, workingLayers, deps){
  deps = stage7Deps(cpt, deps);
  const annexes={};
  if(cpt.stage6Cache?.bearing?.selected){
    annexes.bearing={
      config:safeClone(cpt.stage6.bearing),
      analysis:safeClone(cpt.stage6Cache.bearing)
    };
  }
  if(cpt.stage6Cache?.settlement?.sublayers?.length){
    annexes.settlement={
      config:safeClone(cpt.stage6.settlement),
      analysis:safeClone(cpt.stage6Cache.settlement)
    };
  }
  if(cpt.stage6Cache?.dewatering?.sublayers?.length || cpt.stage6Cache?.dewatering?.drawdownCurve?.length){
    annexes.dewatering={
      config:safeClone(cpt.stage6.dewatering),
      analysis:safeClone(cpt.stage6Cache.dewatering)
    };
  }
  if(cpt.stage6Cache?.beam?.sls?.xSamples?.length){
    annexes.beam={
      config:safeClone(cpt.stage6.beam),
      analysis:safeClone(cpt.stage6Cache.beam)
    };
  }
  // Pile capacity — added once the pile estimator was built (the cache is
  // populated by analyzePile in renderStage6() when app === 'pile').
  if(cpt.stage6Cache?.pile?.capacity){
    annexes.pile={
      config:safeClone(cpt.stage6.pile),
      analysis:safeClone(cpt.stage6Cache.pile)
    };
  }
  // Bishop / seepage / deformation each get a workspace screenshot. The user
  // can press the "Capture for report" button in the workspace toolbar at any
  // time to freeze a specific view (selected result, contour mode, viewport)
  // for the report. We prefer that manual capture; if the user never pressed
  // it, fall back to the automatic capture done here at report-build time.
  const bishop=stage7BishopPayload(cpt, deps);
  if(bishop){
    const manualBishopView = cpt.stage6.bishop?.capturedView?.stability || null;
    const bishopView = manualBishopView
      ? safeClone(manualBishopView)
      : deps.captureBishopWorkspaceView('stability');
    if(bishopView){
      bishopView.source = manualBishopView ? 'manual' : 'auto';
      bishop.view = bishopView;
    }
    annexes.bishop=bishop;
  }
  const seepage=stage7SeepagePayload(cpt, deps);
  if(seepage){
    const manualSeepageView = cpt.stage6.bishop?.capturedView?.seepage || null;
    const seepageView = manualSeepageView
      ? safeClone(manualSeepageView)
      : deps.captureBishopWorkspaceView('seepage');
    if(seepageView){
      seepageView.source = manualSeepageView ? 'manual' : 'auto';
      seepage.view = seepageView;
    }
    annexes.seepage=seepage;
  }
  // Deformation annex — was previously absent. Only included when a result
  // is solved AND the user has captured a view (the captured view IS the
  // deformation reporting; without a screenshot we have nothing meaningful
  // to show in the printed report at present).
  const deformation = stage7DeformationPayload(cpt, deps);
  if(deformation){
    annexes.deformation = deformation;
  }
  const available=Object.keys(annexes);
  if(!available.length) return null;
  return{
    currentApp:cpt.stage6?.app || 'bearing',
    available,
    layers:safeClone(workingLayers),
    ...annexes
  };
}
