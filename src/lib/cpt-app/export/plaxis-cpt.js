// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// export/plaxis-cpt.js — the "simulated CPT" trace for PLAXIS: one row per reading with
// the layer's average qc and a (measured or synthesised) sleeve friction, so PLAXIS's own
// CPT interpretation recreates the app's layer sequence.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 8, refactor step 4): the helpers
// findLayerForDepth … formatPlaxisCoord (old lines 15758-15786 at c989770) and the text
// half of `exportPlaxisCpt` (15788-15828). The only change: the CPT state is a parameter
// instead of the module-level active CPT `S` (findLayerForDepth takes the layer list,
// simulatedLayerFs takes the assumed Rf that assumedRfValue() used to read from `S`).
// The two alerts and the `<a download>` click stay in the controller wrapper.

import { simulatedLayerFsValue } from '../classification-core.js';
import { cptModelCtx } from '../model-params/index.js';

/** The controller's guard messages. */
export const NO_LAYER_MODEL_MESSAGE = 'No layer model to export. Run classification and layer identification first.';
export const NO_SIMULATED_ROWS_MESSAGE = 'No simulated CPT rows could be generated from the active layer model.';

export function findLayerForDepth(layers, z){
  for(let i=0;i<layers.length;i++){
    const l=layers[i];
    const isLast=i===layers.length-1;
    if(z >= l.top && (z < l.bot || (isLast && z <= l.bot))) return l;
  }
  return null;
}

/* The simulated CPT exists so PLAXIS's own CPT interpretation recreates the
   app's layer sequence. When a layer has no measured fs/Rf the sleeve friction
   is synthesised from a representative Rf per soil type (classification-core):
   writing fs=0 would make PLAXIS read every layer as clean sand and destroy
   the layering the export is meant to carry. */
export function simulatedLayerFs(layer, assumedRf){
  return simulatedLayerFsValue(layer, assumedRf);
}

export function layerFsIsSynthetic(layer){
  return !(layer.avgFs!=null && isFinite(layer.avgFs)) &&
         !(layer.avgRf!=null && isFinite(layer.avgRf));
}

export function formatPlaxisCoord(value){
  if(value==null || !isFinite(value)) return '0';
  const rounded=Math.abs(value) < 1e-9 ? 0 : value;
  const txt=rounded.toFixed(4).replace(/\.?0+$/,'');
  return txt === '-0' ? '0' : txt;
}

/**
 * The simulated rows `{z, qc, fs}` — one per reading that falls inside a layer.
 * @param {object} cpt  CPT state: data, layers are read.
 * @param {object} ctx  model ctx (cptModelCtx(cpt) by default); `assumedRf` is read.
 */
export function simulatedCptRows(cpt, ctx = cptModelCtx(cpt)){
  return cpt.data
    .map(r=>{
      const layer=findLayerForDepth(cpt.layers, r.z);
      if(!layer) return null;
      return{
        z:r.z,
        qc:Math.max(0, layer.avgQc || 0),
        fs:simulatedLayerFs(layer, ctx.assumedRf)
      };
    })
    .filter(Boolean);
}

/**
 * Simulated CPT text (CRLF-joined), or `null` when no reading falls inside a layer
 * (the controller alerts NO_SIMULATED_ROWS_MESSAGE in that case).
 * @param {object} cpt  CPT state: data, layers, x, y, elev are read.
 * @param {object} ctx  model ctx (cptModelCtx(cpt) by default).
 */
export function buildPlaxisCptText(cpt, ctx = cptModelCtx(cpt)){
  const rows=simulatedCptRows(cpt, ctx);
  if(!rows.length) return null;

  const syntheticFsCount=cpt.layers.filter(layerFsIsSynthetic).length;
  const fsNote=syntheticFsCount
    ? ` — fs of ${syntheticFsCount} layer(s) simulated from soil-type Rf (no measured fs in source CPT)`
    : '';
  const lines=[
    `X[m] ${formatPlaxisCoord(cpt.x)}`,
    `Y[m] ${formatPlaxisCoord(cpt.y)}`,
    `Z[m] ${formatPlaxisCoord(cpt.elev)}`,
    `D[m] Q[MPa] F[MPa] x  # depth, qc, fs, Rf(skipped)${fsNote}`,
    ...rows.map(r=>`${r.z.toFixed(4)} ${r.qc.toFixed(6)} ${r.fs.toFixed(6)} 0`)
  ];

  return lines.join('\r\n');
}

/** Download file name of the simulated CPT. */
export function plaxisCptFilename(cpt){
  return `CPT_${cpt.meta.testid||cpt.id||'export'}_plaxis_simulated.txt`;
}
