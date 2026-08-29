// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Stage 6 pile app: analyzePile(layers, wt, cptRaw, cfg) → {capacity{deBeer, R_b,
// R_s, R_c, …}, settlement{sHead_mm, curve}, notes} as cached by renderStage6 (:16791),
// PILE_CONSTANTS, and the per-layer table text, for {default, heavy, edge} configs.
import { stage6Cases } from './_stage6-common.mjs';
import { PILE_CONSTANTS } from '../../../src/lib/cpt-app/pile/compute.js';

export const name = 'stage6-pile';
export const tolerance = 'pure';
export const description = 'Stage 6 pile: analyzePile × {default, heavy, edge}';

export async function* cases(ctx) {
  yield { id: 'constants', value: PILE_CONSTANTS };
  yield* stage6Cases('pile', {
    heavy: { pileType: 'screw', shape: 'circular', Ds: 0.6, Db: 0.8, zToe: 14.0, Fcd: 1800, Frep: 1200, loadFromComponents: true, GkPerPile: 800, QLeadPerPile: 300, QOtherPerPile: 50, sltCondition: 'none', nPiles: '4-10', cptDensity: '1/300m2', downdrag: 'none', mechanicalCone: true, coneType: 'M1', settlementMethod: 'transfer' },
    edge: (S) => ({ pileType: 'driven', shape: 'square', Ds: 0.2, Db: 0.2, zHead: 0.5, zToe: S.data.at(-1).z + 3, Fcd: 50, Frep: 30, loadFromComponents: false, sAllowable: 2, Ep: 10, pileMaterial: 'steel' })
  })(ctx);
}
