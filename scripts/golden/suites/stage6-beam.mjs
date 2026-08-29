// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Stage 6 beam / slab app: analyzeBeamAndReinforcement(layers, wt, cfg) (SLS/ULS
// samples, reinforcement, EC2 cover) as cached by renderStage6 (:16808), and the pure
// computeSubgradeReaction(layers, wt, cfg) on the working layers, for {default, heavy, edge}.
import { stage6Cases, workingLayers, digest } from './_stage6-common.mjs';
import { computeSubgradeReaction } from '../../../src/lib/cpt-app/stage6-engineering.js';

export const name = 'stage6-beam';
export const tolerance = 'pure';
export const description = 'Stage 6 beam/slab: analyzeBeamAndReinforcement + computeSubgradeReaction';

export const cases = stage6Cases('beam', {
  heavy: { modelMode: 'beam_length', foundationModel: 'winkler', B: 2.0, b: 0.6, L: 12.0, h: 0.6, Df: 1.2, EsMode: 'oedometric', zInfluence: 4.0, gpEta: 0.8, loadPattern: 'point_at_x', Gk: 120, QLead: 60, QOther: 10, useCategory: 'B', ulsCombination: 'A2', xLoad: 4.0, nElements: 200, fck: 35, fyk: 500, exposureClass: 'XD2', phiBar: 16, designLifeYears: 100, isSlabOrPlate: false, castAgainstUnevenSurface: true },
  edge: () => ({ modelMode: 'footing_transverse', L: 0.5, h: 0.1, Gk: 0, QLead: 0, QOther: 0, nElements: 4, loadPattern: 'uniform_patch', xStart: 0.1, xEnd: 0.2, gpOverride: 5, cNomOverride: 60 }),
  // the 0.1 m sublayer stress profile (ksInfo.profile) is locked in full for the default config
  slim: (a) => (a?.ksInfo?.profile ? { ...a, ksInfo: { ...a.ksInfo, profile: digest(a.ksInfo.profile) } } : a),
  async *extra({ api, S, fx }) {
    const layers = workingLayers(api);
    yield { id: `${fx}.subgrade`, value: [{}, { B: 3, zInfluence: 2 }, { EsMode: 'E50', gpEta: 0.5 }].map((cfg) => ({ cfg, ks: (({ profile, ...ks }) => ({ ...ks, profile: digest(profile) }))(computeSubgradeReaction(layers, S.wt, { ...S.stage6.beam, ...cfg })) })) };
  }
});
