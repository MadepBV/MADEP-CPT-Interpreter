// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier A lock of the Seep/Slope stability solver (design §1.8, §2.1, §3.3): for every
// scripts/fixtures/bishop-phase-a model (copied to fixtures/models/bishop-*.json) the
// section model built by buildBishopModelFromStageLayers, the slip-circle search of
// analyzeBishopSearch on the region soil source (what the Worker runs) and on the legacy
// band source (the parity pair of scripts/verify_bishop_phase_a_parity.mjs), and the
// material import for the three strength sets. Plus, per CPT profile fixture, the model
// the app itself builds (Tier B: setStage6App('bishop') → stage6BishopCurrentModel, with
// the HS mirror of stage6BishopSyncSoilModel) and a reduced-grid search on it.
// Tolerance class `iterative` (the Bishop / Spencer loops); `timing` is masked by the
// normaliser, iteration counts and rejection counts are locked exactly.
import { analyzeBishopSearch, buildBishopModelFromStageLayers, importBishopMaterialsFromLayers } from '../../../src/lib/cpt-app/stage6-bishop.js';
import { digest } from '../lib/normalize.mjs';

export const name = 'bishop';
export const tolerance = 'iterative';
export const description = 'Seep/Slope stability: buildBishopModelFromStageLayers + analyzeBishopSearch (fixtures + one model per CPT)';

/** The shortlisted circles keep every scalar; their slice tables are digested (the critical one is locked in full). */
function slimSearch(result) {
  if (!result) return result;
  const slimCircle = (r) => (r && typeof r === 'object' && Array.isArray(r.slices) ? { ...r, slices: digest(r.slices), sliceCount: r.slices.length } : r);
  const criticalText = JSON.stringify(result.critical ?? null);
  const dedupe = (r) => (r && JSON.stringify(r) === criticalText ? '<same as critical>' : r);
  return {
    ...result,
    criticalOverall: dedupe(result.criticalOverall),
    criticalThroughWall: dedupe(result.criticalThroughWall),
    criticalBelowWall: dedupe(result.criticalBelowWall),
    allResults: (result.allResults || []).map(slimCircle)
  };
}

const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };
const CPT_SEARCH = { nEntry: 4, nExit: 4, nCenter: 6, centerOffsetMin: 0.5, centerOffsetMax: 3, minChordLength: 2, minSlipThickness: 0.75, maxExitAngleDeg: 45, validationSamples: 30, geomTol: 0.001, minSliceWidth: 0.05, targetSlices: 30, keepBest: 3 };

export async function* cases(ctx) {
  const fixtureNames = Object.keys(ctx.manifest.fixtures).filter((k) => /^models\/bishop-.*\.json$/.test(k)).sort();
  for (const key of fixtureNames) {
    const fx = ctx.fixtures.json(key);
    const id = key.replace(/^models\/bishop-/, '').replace(/\.json$/, '');
    const input = { entryZone: fx.entryZone, exitZone: fx.exitZone, methodMode: fx.methodMode, searchConfig: fx.searchConfig, solverConfig: fx.solverConfig, spencerConfig: fx.spencerConfig };
    const model = buildBishopModelFromStageLayers(fx.layers, fx.bishopState);
    yield { id: `${id}.model`, value: model };
    const search = analyzeBishopSearch({ ...input, model, soilSource: 'regions' });
    yield { id: `${id}.search`, value: slimSearch(search) };
    const legacyModel = buildBishopModelFromStageLayers(fx.layers, fx.bishopState, { includeLegacyBands: true });
    const legacy = analyzeBishopSearch({ ...input, model: legacyModel, soilSource: 'legacy-bands' });
    yield { id: `${id}.legacy-bands`, value: { legacyBands: legacyModel.legacyBands, critical: legacy.critical ? { ...legacy.critical, slices: digest(legacy.critical.slices) } : null, resultCount: (legacy.allResults || []).length, rejectionCounts: legacy.rejectionCounts, summary: legacy.summary, wallSummary: legacy.wallSummary } };
    for (const set of ['characteristic', 'da1_1', 'da1_2']) {
      yield { id: `${id}.materials-${set}`, value: importBishopMaterialsFromLayers(fx.layers, [], set) };
    }
    // re-import keeps a manual override only for the SAME layer (type/subtype/extent identity), never by position
    const first = importBishopMaterialsFromLayers(fx.layers, [], 'characteristic');
    const edited = first.map((m, i) => (i === 0 ? { ...m, cEff: (m.cEff || 0) + 7, label: 'edited by engineer' } : m));
    const shifted = [{ ...fx.layers[0], bot: fx.layers[0].bot + 0.5 }, ...fx.layers.slice(1)];
    yield { id: `${id}.materials-reimport`, value: { same: importBishopMaterialsFromLayers(fx.layers, edited, 'characteristic'), shifted: importBishopMaterialsFromLayers(shifted, edited, 'characteristic'), strengthSetChange: importBishopMaterialsFromLayers(fx.layers, edited, 'da1_2') } };
  }
  // guard paths of the model builder
  const g = ctx.fixtures.json('models/bishop-homogeneous_dry.json');
  yield { id: 'guards', value: {
    noTerrain: buildBishopModelFromStageLayers(g.layers, { ...g.bishopState, terrain: [] }),
    noLayers: buildBishopModelFromStageLayers([], g.bishopState),
    noCptX: buildBishopModelFromStageLayers(g.layers, { ...g.bishopState, activeCptX: null }),
    offsetCpt: (() => { const m = buildBishopModelFromStageLayers(g.layers, { ...g.bishopState, cptInsertionOffset: -1.5 }); return m && { cptTopY: m.cptTopY, cptGroundY: m.cptGroundY, analysisBottomY: m.analysisBottomY, regions: m.regions.map((r) => r.polygon) }; })()
  } };

  // one model per CPT profile fixture, built by the app (Tier B) and searched in-process
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.stage6Names()) {
    const S = await ctx.classify(fx, 'sb260');
    api.goS(3); api.goS(5);
    Object.assign(S.stage6.bishop, JSON.parse(JSON.stringify(CPT_TERRAIN)));
    api.setStage6App('bishop');                      // renderStage6 → stage6BishopCurrentModel (activeCptX auto-placed)
    const model = S.stage6Cache.bishopModel;
    yield { id: `cpt.${fx}.model`, value: model };
    yield { id: `cpt.${fx}.materials`, value: S.stage6.bishop.materials };
    if (!model) continue;
    const b = S.stage6.bishop;
    const search = analyzeBishopSearch({ model, entryZone: b.entryZone, exitZone: b.exitZone, methodMode: b.methodMode, searchConfig: { ...b.search, ...CPT_SEARCH }, solverConfig: { ...b.solver }, spencerConfig: { ...b.spencer, recheckCount: 2 }, soilSource: 'regions' });
    yield { id: `cpt.${fx}.search`, value: slimSearch(search) };
    // the app's own run handler under Node (no Worker): the guard message is behaviour too
    api.stage6BishopRunSearch();
    yield { id: `cpt.${fx}.run-handler`, value: { message: b.progress.message, running: b.progress.running, results: b.results } };
  }
}
