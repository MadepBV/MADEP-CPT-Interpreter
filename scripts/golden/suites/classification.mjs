// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks Stage 2 (design §1.3): runClass() for the 5 methods on every profile fixture —
// classified rows, the assumed-Rf bookkeeping, the metrics/notes text, the #cbody row
// count and the layer preview / column SVG markup — plus the pure classifier functions of
// classification-core.js on a fixed reading grid (stress from gamma 18 kN/m³, wt 1.5 m).
import { htmlToText } from '../lib/html-text.mjs';
import {
  classifyRobertson1990, classifyRobertson2016, classifyCUR3, classifyNEN6740, classifyTabel3, simulatedLayerFsValue
} from '../../../src/lib/cpt-app/classification-core.js';

export const name = 'classification';
export const tolerance = 'pure';
export const description = 'Stage 2 runClass() × 5 methods per fixture + pure classifiers on a reading grid';

export const METHODS = ['robertson', 'robertson2016', 'cur3', 'nen6740', 'sb260'];

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.cptNames()) {
    const S = await ctx.loadCpt(fx);
    for (const method of METHODS) {
      S.method = method;
      api.runClass();
      const cbody = c.document.getElementById('cbody').innerHTML;
      yield { id: `${fx}.${method}`, value: { classified: S.classified, rfAssumedCount: S.rfAssumedCount, useSB260params: S.useSB260params, cbodyRows: (cbody.match(/<tr>/g) || []).length, layerCount: S.layers.length } };
      yield { id: `${fx}.${method}.metrics`, kind: 'txt', value: ['cmet', 'cmetricHead', 'classAssumedRfNote', 'minThkInfo'].map((id) => { const el = c.document.getElementById(id); return `[#${id}]\n${htmlToText(el.innerHTML || el.textContent)}`; }).join('') };
      yield { id: `${fx}.${method}.layer-preview`, kind: 'svg', value: c.document.getElementById('layerPreviewSvg').innerHTML };
      yield { id: `${fx}.${method}.layer-column`, kind: 'svg', value: c.document.getElementById('layerColSvg').innerHTML };
    }
    if (fx === 'qc-only') {
      // assumed-Rf variants (state set directly: setAssumedRf() schedules a debounced re-run, :1550)
      for (const rf of [2, 5]) { S.assumedRf = rf; S.method = 'sb260'; api.runClass(); yield { id: `${fx}.sb260.assumedRf${rf}`, value: { classified: S.classified, rfAssumedCount: S.rfAssumedCount, layers: S.layers } }; }
      S.assumedRf = 3;
    }
  }
  // pure classifiers on a reading grid
  const grid = [];
  for (const z of [0.5, 1, 2, 4, 8, 12, 16, 20]) for (const qc of [0.1, 0.5, 1, 2, 5, 10, 20, 40]) for (const rf of [null, 0.5, 1, 2, 4, 8]) grid.push({ z, qc, rf, fs: rf == null ? null : qc * rf / 100, u2: null });
  const stress = (z) => { const wt = 1.5, sigV = 18 * z, u = z > wt ? 9.81 * (z - wt) : 0; return { sigV: +sigV.toFixed(2), u: +u.toFixed(2), sigVeff: Math.max(sigV - u, 1) }; };
  const fns = {
    robertson1990: (r, a) => classifyRobertson1990(r, { ...stress(r.z), aRatio: 0.8, assumedRf: a }),
    robertson2016: (r, a) => classifyRobertson2016(r, { ...stress(r.z), aRatio: 0.8, assumedRf: a }),
    cur3: (r, a) => classifyCUR3(r, { assumedRf: a }),
    nen6740: (r, a) => classifyNEN6740(r, { ...stress(r.z), assumedRf: a }),
    tabel3: (r, a) => classifyTabel3(r, { assumedRf: a })
  };
  for (const [k, fn] of Object.entries(fns)) {
    const rows = grid.map((r) => ({ in: r, out: fn(r, 3) }));
    for (const a of [2, 5]) for (const r of grid.filter((x) => x.rf == null)) rows.push({ in: { ...r, assumedRf: a }, out: fn(r, a) });
    yield { id: `core.${k}`, value: rows };
  }
  yield { id: 'core.simulatedLayerFsValue', value: [['Sand', 12], ['Clay', 0.8], ['Sandy clay', 2], ['Silty sand', 6], ['Soft clay', 0.3], ['Peat / organic', 0.2], ['Gravel', 25]].flatMap(([type, avgQc]) => [2, 3, 5].map((a) => ({ type, avgQc, assumedRf: a, fs: simulatedLayerFsValue({ type, avgQc }, a) }))) };
}
