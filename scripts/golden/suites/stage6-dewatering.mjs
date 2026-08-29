// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Stage 6 dewatering app: analyzeDewatering(layers, wt, cfg) (drawdown curve,
// stress change, settlement; the waterTableAtDistance function on the result is dropped by
// the normaliser) as cached by renderStage6 (:16800), for {default, heavy, edge}.
import { stage6Cases } from './_stage6-common.mjs';

export const name = 'stage6-dewatering';
export const tolerance = 'pure';
export const description = 'Stage 6 dewatering: analyzeDewatering × {default, heavy, edge}';

export const cases = stage6Cases('dewatering', {
  heavy: { combination: 'quasi-permanent', targetWt: 6.0, geometry: 'equivalent_well_rectangular_excavation', aquiferType: 'confined', rw: 0.2, rCPT: 3.0, LPit: 30, BPit: 20, LTrench: 40, distanceToCPT: 4.0, CSichardt: 2000, sigmaVMode: 'realistic', aquiferBaseDepth: 12, dz: 0.2, timeDays: 30 },
  edge: (S) => ({ geometry: 'line_dewatering_trench', targetWt: S.layers.at(-1).bot + 5, rCPT: 0, distanceToCPT: 0, dz: 0.5, timeDays: 0, aquiferBaseDepth: null })
});
