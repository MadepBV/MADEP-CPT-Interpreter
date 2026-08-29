// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Stage 6 settlement app: analyzeSettlement(layers, wt, cfg) → {qGross, qNet,
// totalSettlementMm, perLayer, sublayers, curves, truncation, timeCurve, notes} as cached by
// renderStage6 (:16796), for {default, heavy (rectangular, time), edge (Df below CPT, Gk 0)}.
import { stage6Cases } from './_stage6-common.mjs';

export const name = 'stage6-settlement';
export const tolerance = 'pure';
export const description = 'Stage 6 settlement: analyzeSettlement × {default, heavy, edge}';

export const cases = stage6Cases('settlement', {
  heavy: { footingType: 'rectangular', B: 6.0, L: 12.0, Df: 2.5, Gk: 600, QLead: 200, QOther: 40, useCategory: 'C', combination: 'char', stressMethod: 'two_to_one', dz: 0.2, includeTime: true, timeDays: 365, allowableSettlement: 15 },
  edge: (S) => ({ footingType: 'circular', B: 0.3, L: 0.3, Df: S.layers.at(-1).bot + 5, Gk: 0, QLead: 0, QOther: 0, dz: 0.5, includeTime: true, timeDays: 0 })
});
