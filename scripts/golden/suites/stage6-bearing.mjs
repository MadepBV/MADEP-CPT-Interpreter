// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Stage 6 bearing-capacity app: bearingProfile(cfg, layers) → {pts, selected,
// drained, undrained, maxDepth} as cached by renderStage6 (:16787), bearingAtDepth at
// spot depths, the config after ensureStage6State clamping and the rendered text.
import { stage6Cases } from './_stage6-common.mjs';

export const name = 'stage6-bearing';
export const tolerance = 'pure';
export const description = 'Stage 6 bearing: bearingProfile / bearingAtDepth × {default, heavy, edge}';

export const cases = stage6Cases('bearing', {
  heavy: { foundationType: 'footing', B: 3.0, L: 6.0, eB: 0.3, eL: 0.5, shapeMode: 'conservative', load: 600, factorMode: 'ec7', xi: 1.5, gammaRd: 1.1, ec7Combination: 'DA1-2', Df: 2.0 },
  edge: (S) => ({ foundationType: 'slab', B: 0.3, L: 0.3, eB: 5, eL: 5, load: 0, Df: S.layers.at(-1).bot + 5, showMode: 'drained' }),
  async *extra({ api, S, fx }) {
    const cfg = { ...S.stage6.bearing, Df: 1.0, B: 1.5, L: 1.5, eB: 0, eL: 0, load: 150 };
    const maxDepth = S.layers.at(-1).bot;
    yield { id: `${fx}.at-depth`, value: [0.2, 1.0, 2.5, maxDepth / 2, maxDepth].map((z) => ({ z, result: api.bearingAtDepth(z, cfg, null) })) };
    yield { id: `${fx}.layer-at-depth`, value: [0, 0.5, 3.0, maxDepth - 0.01, maxDepth + 1].map((z) => ({ z, layer: api.layerAtDepth(z) })) };
  }
});
