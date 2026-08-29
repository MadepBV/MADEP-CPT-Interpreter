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
// `ctx` is the model-params ctx (cptModelCtx(cpt) by default). Every builder is pure:
// no DOM, no alert, no `S`. legacy-controller.js keeps exportCSV / exportPlaxisCommands /
// exportPlaxisCpt as wrappers that guard, alert and click the `<a download>` exactly as
// before.

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
