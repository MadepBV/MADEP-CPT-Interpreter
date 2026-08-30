// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// export/index.js — public surface of the text-export package
// (01-monolith-map.md §6.1 row `export/`, extracted in PR 8 / refactor step 4).
//
//   csv.js              buildLayersCsv(cpt, ctx) → text, layersCsvFilename(cpt)
//   plaxis-commands.js  buildPlaxisCommandsText(cpt, ctx) → text, plaxisNuDrainageConflicts,
//                       plaxisNuDrainageAlertMessage, plaxisCommandsFilename + the token helpers
//   plaxis-cpt.js       buildPlaxisCptText(cpt, ctx) → text | null, simulatedCptRows,
//                       plaxisCptFilename + findLayerForDepth / formatPlaxisCoord …
//
// `ctx` is the model-params ctx (cptModelCtx(cpt) by default). Every builder is pure: no DOM,
// no alert, no `S`. PR 20 (refactor step 10) added `installExportApp(ctx)` at the bottom — the
// three handlers that guard, alert and click the `<a download>` over the active CPT. Their
// `alert()`s stay blocking on purpose: a golden locks the text and the guard stops a download
// (worklog 25 §3).

export { NO_LAYERS_MESSAGE, LAYERS_CSV_HEADER, buildLayersCsv, layersCsvFilename } from './csv.js';
export {
  safeMaterialToken, plaxisDrainageType, plaxisDisplayName, plaxisCommandValue, buildPlaxisSoilmatCommand, msToMday,
  plaxisCptId, buildPlaxisCommandsText, plaxisNuDrainageConflicts, plaxisNuDrainageAlertMessage, plaxisCommandsFilename
} from './plaxis-commands.js';
export {
  NO_LAYER_MODEL_MESSAGE, NO_SIMULATED_ROWS_MESSAGE,
  findLayerForDepth, simulatedLayerFs, layerFsIsSynthetic, formatPlaxisCoord,
  simulatedCptRows, buildPlaxisCptText, plaxisCptFilename
} from './plaxis-cpt.js';

import { buildLayersCsv, layersCsvFilename, NO_LAYERS_MESSAGE } from './csv.js';
import {
  buildPlaxisCommandsText, plaxisNuDrainageConflicts, plaxisNuDrainageAlertMessage, plaxisCommandsFilename
} from './plaxis-commands.js';
import {
  buildPlaxisCptText, plaxisCptFilename, NO_LAYER_MODEL_MESSAGE, NO_SIMULATED_ROWS_MESSAGE
} from './plaxis-cpt.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installExportApp(ctx) — the three download buttons of Stage 4 (PR 20 / refactor step 10).
//
//   ctx.document, ctx.getActive(), ctx.modelCtx(), ctx.alert(message)
export function installExportApp(ctx){
  const { document, getActive, alert } = ctx;

  /** The monolith's `<a download>` click, verbatim. */
  function download(href, name){
    const a=document.createElement('a');
    a.href=href;
    a.download=name;
    a.click();
  }

  const app = {
    exportCSV(){
      const S=getActive();
      if(!S.layers.length){alert(NO_LAYERS_MESSAGE);return;}
      const csv=buildLayersCsv(S, ctx.modelCtx());
      download('data:text/csv;charset=utf-8,'+encodeURIComponent(csv), layersCsvFilename(S));
    },

    exportPlaxisCommands(){
      const S=getActive();
      if(!S.layers.length){
        alert(NO_LAYERS_MESSAGE);
        return;
      }
      const txt=buildPlaxisCommandsText(S, ctx.modelCtx());
      const nuDrainageConflicts=plaxisNuDrainageConflicts(S, ctx.modelCtx());
      if(nuDrainageConflicts.length){
        alert(plaxisNuDrainageAlertMessage(nuDrainageConflicts));
      }
      download('data:text/plain;charset=utf-8,'+encodeURIComponent(txt), plaxisCommandsFilename(S));
    },

    exportPlaxisCpt(){
      const S=getActive();
      if(!S.layers.length || !S.data.length){
        alert(NO_LAYER_MODEL_MESSAGE);
        return;
      }
      const txt=buildPlaxisCptText(S, ctx.modelCtx());
      if(txt==null){
        alert(NO_SIMULATED_ROWS_MESSAGE);
        return;
      }
      download('data:text/plain;charset=utf-8,'+encodeURIComponent(txt), plaxisCptFilename(S));
    }
  };
  app.handlers = {
    exportCSV: app.exportCSV,
    exportPlaxisCommands: app.exportPlaxisCommands,
    exportPlaxisCpt: app.exportPlaxisCpt
  };
  return app;
}
