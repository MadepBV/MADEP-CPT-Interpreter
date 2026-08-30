#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 9d / PR 18d (worklog/refactor/26-pr18d-seepslope-geometry.md): the
// Seep / Slope section geometry and the line probe moved out of legacy-controller.js into
// src/lib/cpt-app/seepslope/geometry/** and seepslope/probe/** as pure modules. Pattern of
// scripts/verify_seepslope_{state,model,run}.mjs: the controller of a base ref (default
// `integration-r`) and the working-tree controller are each loaded under Node through the Tier-B
// loader in their own child process, dump the same observations to JSON, and the parent compares
// the two dumps byte for byte (JSON text, key order included).
//
// The one addition to the established pattern: **both** controllers are materialised as a copy
// with the *same* appended `export { … }` block (`EXPORT_BLOCK` below), so the moved functions —
// module-local in the base, import aliases / façades in the working tree — can be called directly
// with identical arguments. The block adds exports and nothing else; the two copies are deleted in
// a `finally`, whatever happens.
//
//   (a) the grid — every moved function over a wide input grid built from 13 points, 15 polygons,
//       10 segments, 5 tolerances, region / model / probe / sample / interval literals and 3
//       viewport scales, degenerate cases included: empty and one-/two-point polygons, coincident
//       points, vertical and zero-length segments, self-intersecting and zero-area polygons,
//       collinear and duplicated vertices, NaN / ±Infinity / string / null / missing coordinates,
//       and every call that throws (the message is compared too)
//   (b) the probe readout — the seeded loadDemo() CPT and every CPT of the three project fixtures
//       (legacy-v0.5.2, multi-3cpt, single-layered) made runnable the way the seep-slope journey
//       makes them runnable (terrain + entry/exit zones + two side head BCs) and then **solved in
//       process**: analyzeSeepageModel on the app's own model, and one js-cpu linear-elastic
//       analyzeDeformationModel on the deformation fixture, written into bishop.seepage /
//       bishop.deformation exactly as the run reducers write them. Per CPT, per workspace and per
//       quantity: stage6BishopBuildLineProbe over five measurement lines derived from the model's
//       own bounds (across the section, partly outside, wholly outside, vertical, degenerate) with
//       the full probe object, its clipboard text and header, the formatted statistics, and — once
//       per workspace — a full renderStage6() with `#stage6Area` innerHTML and
//       stage6BishopCopyLineProbeData() compared byte for byte
//   (c) the geometry through its callers — a walk on the `layered` fixture under a seeded clock
//       and PRNG: the region draft / split / hole tools through their handlers, the terrain draft,
//       the measure tool and the copy handler, each observed on S.stage6.bishop (deep-equal + key
//       order), the UI state, the messages, `#stage6Area`, the alerts and the id-call count
//   (d) working tree only: the packages standalone — seepslope/geometry and seepslope/probe
//       imported directly, the controller's aliases proven to be the very same function objects,
//       input immutability over the whole polygon / point grid, and the two host contracts (the
//       pick tolerance as a value or a function, the probe `env`)
//   (e) the goldens that pass through the geometry / probe region, recomputed in **both**
//       controllers and compared byte for byte with the files on disk: tests/golden/node/bishop/
//       cpt.<fx>.{model,materials,search,run-handler}.json for the 7 Stage 6 profile fixtures,
//       tests/golden/node/seepage/{cpt.layered.app-boundary,state,run-handler,mesh,result,
//       base-fixed-head.samples}.json and tests/golden/node/deformation/
//       base.js-cpu.linear-elastic.t3.a0.5.{mesh,result,samples}.json
//
// Usage
//   node scripts/verify_seepslope_geometry.mjs                 compare against integration-r
//   node scripts/verify_seepslope_geometry.mjs --base <ref>    compare against another git ref
//   node scripts/verify_seepslope_geometry.mjs --snapshot f.json   dump the working tree only
//   node scripts/verify_seepslope_geometry.mjs --against f.json    compare the working tree with a dump
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-seepslope-geometry-base.legacy-controller.js';
const TREE_REL = 'src/lib/cpt-app/__verify-seepslope-geometry-tree.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
// The bishop golden suite's section and reduced search grid (scripts/golden/suites/bishop.mjs).
const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };
const CPT_SEARCH = { nEntry: 4, nExit: 4, nCenter: 6, centerOffsetMin: 0.5, centerOffsetMax: 3, minChordLength: 2, minSlipThickness: 0.75, maxExitAngleDeg: 45, validationSamples: 30, geomTol: 0.001, minSliceWidth: 0.05, targetSlices: 30, keepBest: 3 };

/** Exports appended to a copy of *both* controllers so the grid can call the moved functions. */
const EXPORT_BLOCK = `
/* ── appended by scripts/verify_seepslope_geometry.mjs (PR 18d) — exports only ── */
export {
  stage6BishopTooltipHtml,
  stage6BishopLineProbeOptions,
  stage6BishopLineProbeMeta,
  stage6CopyTextFallback,
  stage6CopyTextToClipboard,
  stage6BishopBuildLineProbe,
  stage6BishopCopyLineProbeData,
  stage6BishopDisplayRegions,
  stage6BishopBoundaryPickToleranceWorld,
  stage6BishopPickRegionBoundaryPoint,
  stage6BishopSnapToleranceWorld,
  stage6BishopStrengthSetLabel,
  stage6BishopNormalizedDeformationAnalysisType,
  stage6BishopDeformationContourOptions,
  stage6BishopDeformationContourMeta,
  stage6BishopSeepageHydraulicFs,
  stage6BishopCurrentModel,
  stage6BishopSelectedCustomRegion,
  stage6BishopSetSelectedRegion,
  stage6BishopSplitSelectedRegion,
  stage6BishopClearMeasurement,
  stage6WorkingLayers,
  ensureStage6State,
  renderStage6
};
/* The 31 names below were already *import aliases* of seepslope/{geometry,probe} in the base
   controller (PR 18d moved their bodies); PR 20's composition root no longer imports what it
   does not use, so the block re-exports them straight from the packages. Both controllers
   therefore export the very same functions — the parity comparison is unchanged. */
export {
  dist as stage6BishopDist,
  segmentOrientation as stage6BishopSegmentOrientation,
  pointOnSegment as stage6BishopPointOnSegment,
  segmentsIntersectClosed as stage6BishopSegmentsIntersectClosed,
  closestPointOnSegment as stage6BishopClosestPointOnSegment,
  uniqueSortedNumbers as stage6BishopUniqueSortedNumbers,
  pointInPolygon as stage6BishopPointInPolygon,
  pointInsideOrBoundary as stage6BishopPointInsideOrBoundary,
  polygonCentroid as stage6BishopPolygonCentroid,
  polygonIsValid as stage6BishopPolygonIsValid,
  validateHolePolygon as stage6BishopValidateHolePolygon,
  traverseBoundary as stage6BishopTraverseBoundary,
  buildSplitBoundary as stage6BishopBuildSplitBoundary,
  boundaryYAtX as stage6BishopBoundaryYAtX,
  polygonIntervalsDetailed as stage6BishopPolygonIntervalsDetailed,
  subtractDetailedIntervals as stage6BishopSubtractDetailedIntervals,
  subtractHoleFromPolygon as stage6BishopSubtractHoleFromPolygon,
  splitRegionPolygon as stage6BishopSplitRegionPolygon,
  showingCustomRegionPreview as stage6BishopShowingCustomRegionPreview,
  regionAtPoint as stage6BishopRegionAtPoint,
  regionShortLabel as stage6BishopRegionShortLabel,
  regionLegendItems as stage6BishopRegionLegendItems,
  measurementMetrics as stage6BishopMeasurementMetrics,
  measurementLabel as stage6BishopMeasurementLabel,
  measurementVectors as stage6BishopMeasurementVectors
} from './seepslope/geometry/index.js';
export {
  lineProbeFormatValue as stage6BishopLineProbeFormatValue,
  clipboardNumber as stage6ClipboardNumber,
  lineProbeClipboardValueHeader as stage6BishopLineProbeClipboardValueHeader,
  lineProbeClipboardText as stage6BishopLineProbeClipboardText,
  lineProbeStats as stage6BishopLineProbeStats,
  integrateLineProbe as stage6BishopIntegrateLineProbe
} from './seepslope/probe/index.js';
`;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// ═══════════════════════════════ the input grid (shared by both children) ═══════════════════════
const PT = {
  origin: { x: 0, y: 0 },
  a: { x: 1, y: 2 },
  b: { x: -3.5, y: 4.25 },
  inside: { x: 2, y: 1 },
  onEdge: { x: 2, y: 0 },
  vertex: { x: 4, y: 0 },
  far: { x: 1e6, y: -1e6 },
  epsilon: { x: 1e-9, y: -1e-9 },
  nan: { x: NaN, y: 1 },
  inf: { x: Infinity, y: 0 },
  strings: { x: '2', y: '3' },
  nullish: { x: null, y: undefined },
  empty: {}
};
const POLY = {
  empty: [],
  one: [{ x: 0, y: 0 }],
  two: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
  tri: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }],
  triCW: [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 4, y: 0 }],
  square: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
  rect: [{ x: -2, y: -1 }, { x: 6, y: -1 }, { x: 6, y: 2 }, { x: -2, y: 2 }],
  bowtie: [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 4, y: 0 }, { x: 0, y: 4 }],
  collinear: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }],
  duplicated: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }],
  microscopic: [{ x: 0, y: 0 }, { x: 1e-3, y: 0 }, { x: 0, y: 1e-3 }],
  concaveL: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 6 }, { x: 0, y: 6 }],
  verticalEdges: [{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 0 }],
  withNaN: [{ x: 0, y: 0 }, { x: NaN, y: 2 }, { x: 4, y: 0 }],
  huge: [{ x: -1e5, y: -1e5 }, { x: 1e5, y: -1e5 }, { x: 1e5, y: 1e5 }]
};
const SEG = {
  unit: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  diagonal: [{ x: 0, y: 0 }, { x: 4, y: 4 }],
  vertical: [{ x: 2, y: -3 }, { x: 2, y: 5 }],
  horizontal: [{ x: -4, y: 1.5 }, { x: 6, y: 1.5 }],
  degenerate: [{ x: 2, y: 2 }, { x: 2, y: 2 }],
  epsilonLong: [{ x: 0, y: 0 }, { x: 1e-7, y: 0 }],
  huge: [{ x: -1e6, y: -1e6 }, { x: 1e6, y: 1e6 }],
  reversed: [{ x: 4, y: 4 }, { x: 0, y: 0 }],
  withNaN: [{ x: NaN, y: 0 }, { x: 3, y: 3 }],
  withInfinity: [{ x: 0, y: 0 }, { x: Infinity, y: 0 }]
};
const TOLS = [0, 1e-9, 1e-6, 1e-3, 0.5];
const NUMBERS = [0, 1, -1, 0.5, 1e-7, 1e-6, 9.999999e5, 1e6, 1234.5678901234, -1e-12, 1 / 3, Math.PI, NaN, Infinity, -Infinity, null, undefined, '12', 'x'];
const MATERIALS = {
  none: null,
  bare: { id: 'm1' },
  full: { id: 'm1', label: 'Zand - matig vast', color: '#c9b089', sourceType: 'Zand', sourceSubtype: 'matig vast', sourceStrengthSet: 'da1_1', cEff: 1.234, phiEffDeg: 32.55, gamma: 18.5, gammaSat: 20.5 },
  noSet: { id: 'm2', label: 'Klei', sourceType: 'Klei', cEff: 5, phiEffDeg: 22, gamma: 16, gammaSat: 17 },
  longLabel: { id: 'm3', label: 'Een heel erg lange grondlaagnaam - subtype', sourceType: 'Leem' },
  weird: { id: 'm4', label: '', cEff: NaN, phiEffDeg: '31', gamma: null, gammaSat: undefined }
};
const SEEPAGE_QUANTITIES = ['head', 'porePressure', 'gradient', 'hydraulicFs', 'flow', 'qx', 'qy', 'normalFlow'];
const DEFORMATION_QUANTITIES = ['uTotal', 'settlement', 'ux', 'uy', 'epsilonXx', 'gammaXy', 'equivalentPlasticStrain', 'sigmaYyEff', 'tauXy', 'mcEta'];

/** Five measurement lines derived from a model's own bounds — deterministic, no magic numbers. */
function linesForModel(model) {
  const xs = (model?.terrain?.vertices || []).map((v) => Number(v.x));
  const ys = (model?.terrain?.vertices || []).map((v) => Number(v.y));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yTop = Math.max(...ys), y0 = Number(model?.analysisBottomY);
  const W = x1 - x0, H = yTop - y0;
  return {
    across: [{ x: x0 + 0.15 * W, y: y0 + 0.75 * H }, { x: x0 + 0.85 * W, y: y0 + 0.25 * H }],
    partlyOutside: [{ x: x0 - 0.6 * W, y: y0 + 0.6 * H }, { x: x0 + 0.5 * W, y: y0 + 0.4 * H }],
    outside: [{ x: x0 - 3 * W, y: yTop + 3 * H }, { x: x0 - 2 * W, y: yTop + 4 * H }],
    vertical: [{ x: x0 + 0.5 * W, y: yTop }, { x: x0 + 0.5 * W, y: y0 }],
    degenerate: [{ x: x0 + 0.5 * W, y: y0 + 0.5 * H }, { x: x0 + 0.5 * W, y: y0 + 0.5 * H }]
  };
}

// ═══════════════════════════════ child: dump one controller ═══════════════════════════════
if (args[0] === '--dump') {
  const ctrlRel = args[1];
  const outPath = args[2];
  const pure = args.includes('--pure');
  const { installDomStub } = await import('./golden/lib/load-controller.mjs');
  const { mulberry32 } = await import('./golden/lib/prng.mjs');
  const { normalize, digest } = await import('./golden/lib/normalize.mjs');
  const { stableJson } = await import('./golden/lib/store.mjs');
  const { createServer } = await import('vite');
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;   // worker-only code paths
  const stub = installDomStub();
  const canvasEl = stub.document.getElementById('stage6BishopCanvas');
  canvasEl.setPointerCapture = () => {}; canvasEl.releasePointerCapture = () => {};
  canvasEl.parentElement = canvasEl.parentNode = stub.document.createElement('div');
  const server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { $lib: resolve(ROOT, 'src/lib') } },
    define: { __APP_VERSION__: JSON.stringify(globalThis.__APP_VERSION__) }
  });
  const G = await server.ssrLoadModule('/' + ctrlRel);
  G.initLegacyController();
  const api = globalThis;
  const FIX = resolve(ROOT, 'tests/golden/fixtures');
  const manifest = JSON.parse(readFileSync(join(FIX, 'manifest.json'), 'utf8'));
  const realNow = Date.now.bind(Date);
  const realRandom = Math.random;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, label, timeout = 30000) {
    const t0 = realNow();
    while (!pred()) { if (realNow() - t0 > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(5); }
  }
  const S = () => api.PROJECT.cpts[api.PROJECT.activeCptIdx];
  const B = () => S().stage6.bishop;
  // JSON with undefined / NaN / ±Infinity made visible, key order preserved (no sorting).
  const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  // The panel prints the solver's wall-clock runtime ("Total runtime: 0.0792 s", "Runtime: 0.1694
  // s"), which differs between two processes by construction. Masked with the golden harness's own
  // two timing patterns (scripts/golden/lib/normalize.mjs MASK_SUBSTRING_PATTERNS) — and only
  // those, so entity ids and every other number in the markup stay compared byte for byte.
  const maskTimings = (s) => String(s).replace(/\b\d+(?:\.\d+)? ms\b/g, '<ms> ms').replace(/\b\d+(?:\.\d+)? s\b(?!\/)/g, '<s> s');
  const area = () => maskTimings(stub.document.getElementById('stage6Area').innerHTML);

  const dump = { controller: ctrlRel, grid: {}, probe: [], walk: [], goldens: {}, pure: {} };

  // ── (a) the grid ────────────────────────────────────────────────────────────────────────
  /** Call `fn` and record the value or the exception message — both are behaviour. */
  const call = (fn, ...a) => { try { return { v: fn(...a) }; } catch (e) { return { error: String(e?.message || e) }; } };
  const grid = (label, rows) => { dump.grid[label] = ser(rows); };
  const ptNames = Object.keys(PT);
  const polyNames = Object.keys(POLY);
  const segNames = Object.keys(SEG);

  grid('dist', ptNames.flatMap((p) => ptNames.map((q) => [p, q, call(G.stage6BishopDist, PT[p], PT[q])])).concat([
    ['undefined', 'undefined', call(G.stage6BishopDist, undefined, undefined)],
    ['null', 'origin', call(G.stage6BishopDist, null, PT.origin)]
  ]));
  grid('pointInPolygon', ptNames.flatMap((p) => polyNames.map((q) => [p, q, call(G.stage6BishopPointInPolygon, PT[p], POLY[q])])));
  grid('pointInsideOrBoundary', ptNames.flatMap((p) => polyNames.map((q) => [p, q, call(G.stage6BishopPointInsideOrBoundary, PT[p], POLY[q])])));
  grid('pointOnSegment', ptNames.flatMap((p) => segNames.flatMap((s) => TOLS.map((t) => [p, s, t, call(G.stage6BishopPointOnSegment, PT[p], SEG[s][0], SEG[s][1], t)]))));
  grid('segmentOrientation', segNames.flatMap((s) => ptNames.map((p) => [s, p, call(G.stage6BishopSegmentOrientation, SEG[s][0], SEG[s][1], PT[p])])));
  grid('segmentsIntersectClosed', segNames.flatMap((s) => segNames.flatMap((t) => TOLS.map((tol) => [s, t, tol, call(G.stage6BishopSegmentsIntersectClosed, SEG[s][0], SEG[s][1], SEG[t][0], SEG[t][1], tol)]))));
  grid('closestPointOnSegment', ptNames.flatMap((p) => segNames.map((s) => [p, s, call(G.stage6BishopClosestPointOnSegment, PT[p], SEG[s][0], SEG[s][1])])));
  grid('uniqueSortedNumbers', [
    [[], 1e-6], [[1], 1e-6], [[3, 1, 2], 1e-6], [[1, 1, 1], 1e-6], [[1, 1 + 1e-9, 1 + 1e-3], 1e-6],
    [[1, 1 + 1e-9, 1 + 1e-3], 1e-2], [[NaN, 1, Infinity, -Infinity, 2, null, undefined, '3'], 1e-6],
    [[1e6, -1e6, 0], 1e-6], [[5, 4, 3, 2, 1], 0]
  ].map(([values, tol]) => [ser(values), tol, call(G.stage6BishopUniqueSortedNumbers, values, tol)]));
  grid('polygonCentroid', polyNames.map((p) => [p, call(G.stage6BishopPolygonCentroid, POLY[p])]).concat([
    ['null', call(G.stage6BishopPolygonCentroid, null)], ['undefined', call(G.stage6BishopPolygonCentroid, undefined)]
  ]));
  grid('polygonIsValid', polyNames.map((p) => [p, call(G.stage6BishopPolygonIsValid, POLY[p])]).concat([
    ['null', call(G.stage6BishopPolygonIsValid, null)], ['notAnArray', call(G.stage6BishopPolygonIsValid, { x: 1 })]
  ]));
  grid('validateHolePolygon', polyNames.flatMap((p) => polyNames.map((h) => [p, h, call(G.stage6BishopValidateHolePolygon, { polygon: POLY[p] }, POLY[h])])).concat([
    ['null-region', 'square', call(G.stage6BishopValidateHolePolygon, null, POLY.square)],
    ['square', 'null', call(G.stage6BishopValidateHolePolygon, { polygon: POLY.square }, null)],
    ['square', 'inner', call(G.stage6BishopValidateHolePolygon, { polygon: POLY.square }, [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }])],
    ['square', 'touching', call(G.stage6BishopValidateHolePolygon, { polygon: POLY.square }, [{ x: 0, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 0, y: 3 }])],
    ['square', 'crossing', call(G.stage6BishopValidateHolePolygon, { polygon: POLY.square }, [{ x: -1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: -1, y: 3 }])]
  ]));
  grid('traverseBoundary', polyNames.flatMap((p) => [[0, 0], [0, 1], [1, 0], [0, POLY[p].length - 1], [2, 1], [0, 99]].map(([i, j]) => [p, i, j, call(G.stage6BishopTraverseBoundary, POLY[p], i, j)])));
  grid('buildSplitBoundary', [
    ['square', POLY.square, [{ x: 2, y: 0, edgeIndex: 0, vertexIndex: null, t: 0.5, name: 'a' }, { x: 2, y: 4, edgeIndex: 2, vertexIndex: null, t: 0.5, name: 'b' }]],
    ['square-vertices', POLY.square, [{ x: 0, y: 0, edgeIndex: 0, vertexIndex: 0, t: 0, name: 'a' }, { x: 4, y: 4, edgeIndex: 1, vertexIndex: 2, t: 1, name: 'b' }]],
    ['square-same-edge', POLY.square, [{ x: 1, y: 0, edgeIndex: 0, vertexIndex: null, t: 0.25, name: 'a' }, { x: 3, y: 0, edgeIndex: 0, vertexIndex: null, t: 0.75, name: 'b' }]],
    ['square-coincident', POLY.square, [{ x: 0, y: 0, edgeIndex: 0, vertexIndex: null, t: 0, name: 'a' }, { x: 0, y: 0, edgeIndex: 0, vertexIndex: null, t: 0, name: 'b' }]],
    ['tri-no-cuts', POLY.tri, []],
    ['empty', POLY.empty, [{ x: 0, y: 0, edgeIndex: 0, vertexIndex: null, t: 0, name: 'a' }]],
    ['concaveL', POLY.concaveL, [{ x: 6, y: 1, edgeIndex: 1, vertexIndex: null, t: 0.5, name: 'a' }, { x: 1, y: 6, edgeIndex: 4, vertexIndex: null, t: 0.5, name: 'b' }]]
  ].map(([label, polygon, cuts]) => [label, call(G.stage6BishopBuildSplitBoundary, polygon, cuts)]));
  grid('boundaryYAtX', polyNames.flatMap((p) => [0, 1, 2].flatMap((e) => [-1, 0, 1.5, 4, 1e6].map((x) => [p, e, x, call(G.stage6BishopBoundaryYAtX, { polygon: POLY[p], edgeIndex: e }, x)]))).concat([
    ['null', 0, 1, call(G.stage6BishopBoundaryYAtX, null, 1)],
    ['noEdge', 99, 1, call(G.stage6BishopBoundaryYAtX, { polygon: POLY.square, edgeIndex: 99 }, 1)]
  ]));
  grid('polygonIntervalsDetailed', polyNames.flatMap((p) => [-1, 0, 1e-9, 1, 2, 3.999, 4, 1e6].map((x) => [p, x, call(G.stage6BishopPolygonIntervalsDetailed, POLY[p], x)]))
    .concat([['null', 1, call(G.stage6BishopPolygonIntervalsDetailed, null, 1)]]));
  grid('subtractDetailedIntervals', (() => {
    const parents = [G.stage6BishopPolygonIntervalsDetailed(POLY.square, 2), G.stage6BishopPolygonIntervalsDetailed(POLY.concaveL, 1), [], null];
    const holes = [G.stage6BishopPolygonIntervalsDetailed([{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }], 2), [], null,
      G.stage6BishopPolygonIntervalsDetailed(POLY.square, 2)];
    return parents.flatMap((p, i) => holes.map((h, j) => [i, j, call(G.stage6BishopSubtractDetailedIntervals, p, h)]));
  })());
  grid('subtractHoleFromPolygon', polyNames.flatMap((p) => polyNames.map((h) => [p, h, call(G.stage6BishopSubtractHoleFromPolygon, POLY[p], POLY[h])])).concat([
    ['square', 'inner', call(G.stage6BishopSubtractHoleFromPolygon, POLY.square, [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }])],
    ['square', 'corner', call(G.stage6BishopSubtractHoleFromPolygon, POLY.square, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }])],
    ['null', 'null', call(G.stage6BishopSubtractHoleFromPolygon, null, null)]
  ]));
  grid('splitRegionPolygon', (() => {
    const cuts = [
      ['mid-opposite', { x: 2, y: 0 }, { x: 2, y: 4 }],
      ['coincident', { x: 2, y: 0 }, { x: 2, y: 0 }],
      ['near-coincident', { x: 2, y: 0 }, { x: 2 + 1e-5, y: 0 }],
      ['corner-corner', { x: 0, y: 0 }, { x: 4, y: 4 }],
      ['same-edge', { x: 1, y: 0 }, { x: 3, y: 0 }],
      ['outside', { x: -5, y: -5 }, { x: 9, y: 9 }],
      ['vertical', { x: 0, y: 0 }, { x: 0, y: 4 }],
      ['nan', { x: NaN, y: 0 }, { x: 2, y: 4 }],
      ['concave-chord', { x: 6, y: 1 }, { x: 1, y: 6 }]
    ];
    return polyNames.flatMap((p) => cuts.map(([label, a, b]) => [p, label, call(G.stage6BishopSplitRegionPolygon, { polygon: POLY[p] }, a, b)]))
      .concat([['null-region', 'mid', call(G.stage6BishopSplitRegionPolygon, null, { x: 0, y: 0 }, { x: 1, y: 1 })]]);
  })());
  grid('regionAtPoint', (() => {
    const models = {
      null: null,
      empty: { regions: [] },
      one: { regions: [{ id: 'r1', polygon: POLY.square, material: MATERIALS.full }] },
      stacked: { regions: [{ id: 'r1', polygon: POLY.square, material: MATERIALS.full }, { id: 'r2', polygon: POLY.rect, material: MATERIALS.noSet }] },
      degenerate: { regions: [{ id: 'r1', polygon: POLY.two }, { id: 'r2', polygon: POLY.empty }, { id: 'r3' }] }
    };
    return Object.keys(models).flatMap((m) => ptNames.map((p) => {
      const r = call(G.stage6BishopRegionAtPoint, models[m], PT[p]);
      return [m, p, 'error' in r ? r : { v: r.v?.id ?? null }];
    }));
  })());
  grid('regionShortLabel', Object.keys(MATERIALS).map((m) => [m, call(G.stage6BishopRegionShortLabel, { id: 'r', material: MATERIALS[m] })]).concat([
    ['null', call(G.stage6BishopRegionShortLabel, null)],
    ['idOnly', call(G.stage6BishopRegionShortLabel, { material: { id: 'only-an-id' } })],
    ['spaced', call(G.stage6BishopRegionShortLabel, { material: { label: '   Zand - los   ' } })],
    ['18chars', call(G.stage6BishopRegionShortLabel, { material: { label: '123456789012345678' } })],
    ['19chars', call(G.stage6BishopRegionShortLabel, { material: { label: '1234567890123456789' } })]
  ]));
  grid('regionLegendItems', [
    ['null', null], ['empty', { regions: [] }],
    ['mixed', { regions: [{ id: 'r1', material: MATERIALS.full }, { id: 'r2', material: MATERIALS.full }, { id: 'r3', material: MATERIALS.noSet }, { id: 'r4' }, { id: 'r5', material: MATERIALS.bare }] }]
  ].map(([label, model]) => [label, call(G.stage6BishopRegionLegendItems, model)]));
  grid('displayRegions/showingCustomRegionPreview', [
    ['null', null], ['empty', {}],
    ['regionsOnly', { regions: [{ id: 'a' }] }],
    ['customEmpty', { regions: [{ id: 'a' }], customRegions: [] }],
    ['custom', { regions: [{ id: 'a' }], customRegions: [{ id: 'c' }] }],
    ['customMode', { regions: [{ id: 'a' }], customRegions: [{ id: 'c' }], regionMode: 'custom' }]
  ].map(([label, model]) => [label, call(G.stage6BishopDisplayRegions, model), call(G.stage6BishopShowingCustomRegionPreview, model)]));
  grid('measurement', [
    ['none', []], ['null', null], ['one', [{ x: 0, y: 0 }]],
    ['two', [{ x: 0, y: 0 }, { x: 3, y: 4 }]],
    ['three', [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 9, y: 9 }]],
    ['coincident', [{ x: 2, y: 2 }, { x: 2, y: 2 }]],
    ['vertical', [{ x: 1, y: -5 }, { x: 1, y: 5 }]],
    ['reversed', [{ x: 3, y: 4 }, { x: 0, y: 0 }]],
    ['nanFirst', [{ x: NaN, y: 0 }, { x: 3, y: 4 }, { x: 1, y: 1 }]],
    ['strings', [{ x: '0', y: '0' }, { x: '3', y: '4' }]],
    ['huge', [{ x: -1e6, y: -1e6 }, { x: 1e6, y: 1e6 }]],
    ['tiny', [{ x: 0, y: 0 }, { x: 1e-12, y: 0 }]]
  ].map(([label, points]) => {
    const metrics = call(G.stage6BishopMeasurementMetrics, points);
    return [label, metrics, call(G.stage6BishopMeasurementLabel, metrics.v), call(G.stage6BishopMeasurementVectors, metrics.v)];
  }).concat([['undefinedMetrics', null, call(G.stage6BishopMeasurementLabel, undefined), call(G.stage6BishopMeasurementVectors, undefined)]]));
  grid('clipboardNumber', NUMBERS.map((n) => [ser(n), call(G.stage6ClipboardNumber, n)]));
  grid('lineProbeFormatValue', (() => {
    const metas = [null, {}, { unit: 'm', digits: 3 }, { unit: '', digits: 0 }, { unit: 'kPa' }, { unit: 'm/s', digits: 6 }];
    return metas.flatMap((m, i) => NUMBERS.map((n) => [i, ser(n), call(G.stage6BishopLineProbeFormatValue, m, n)]));
  })());
  grid('lineProbeClipboard', [
    ['null', null],
    ['notReady', { status: 'missing-result', quantity: 'head', meta: { unit: 'm' }, samples: [] }],
    ['ready-head', { status: 'ready', quantity: 'head', meta: { label: 'h', unit: 'm' }, samples: [{ s: 0, value: 1 }, { s: 0.5, value: 1e-9 }, { s: 1, value: null }, { s: NaN, value: 3 }] }],
    ['ready-noUnit', { status: 'ready', quantity: 'gradient', meta: { label: '|∇h|', unit: '' }, samples: [{ s: 0, value: -0.5 }] }],
    ['ready-noQuantity', { status: 'ready', meta: { label: 'Specific discharge |q|', unit: 'm/s' }, samples: [{ s: 2, value: 1e-8 }] }],
    ['ready-nothing', { status: 'ready', samples: [] }],
    ['ready-weirdUnit', { status: 'ready', quantity: '  σ′ᵧᵧ,fin ', meta: { unit: 'kN/m³' }, samples: [{}] }]
  ].map(([label, probe]) => [label, call(G.stage6BishopLineProbeClipboardValueHeader, probe), call(G.stage6BishopLineProbeClipboardText, probe)]));
  grid('lineProbeStats/integrate', [
    ['null', null], ['empty', []],
    ['flat', [{ s: 0, value: 2 }, { s: 1, value: 2 }, { s: 2, value: 2 }]],
    ['ramp', [{ s: 0, value: 0 }, { s: 1, value: 1 }, { s: 2, value: 2 }]],
    ['signed', [{ s: 0, value: -1 }, { s: 1, value: 1 }, { s: 2, value: -1 }]],
    ['gaps', [{ s: 0, value: 1 }, { s: 1, value: null }, { s: 2, value: 3 }]],
    ['nonMonotonic', [{ s: 2, value: 1 }, { s: 1, value: 2 }, { s: 0, value: 3 }]],
    ['nanS', [{ s: NaN, value: 1 }, { s: 1, value: 2 }]],
    ['duplicateS', [{ s: 1, value: 1 }, { s: 1, value: 5 }, { s: 2, value: 1 }]],
    ['allNull', [{ s: 0, value: null }, { s: 1, value: null }]],
    ['sparse', [{}, null, { s: 0, value: 1 }]]
  ].map(([label, samples]) => [label, call(G.stage6BishopLineProbeStats, samples), call(G.stage6BishopIntegrateLineProbe, samples, false), call(G.stage6BishopIntegrateLineProbe, samples, true)]));
  // stage6BishopDisplayRegions before any Stage 6 state exists (the `!bishop` guard)
  grid('displayRegionsNoBishop', [
    ['model', call(G.stage6BishopDisplayRegions, { regions: [{ id: 'a' }] })],
    ['null', call(G.stage6BishopDisplayRegions, null)]
  ]);

  // ── fixture helpers ─────────────────────────────────────────────────────────────────────
  function fixtureEntry(name) {
    for (const key of [`cpt/${name}`, `cpt/${name}.gef`, `cpt/${name}.state.json`]) if (manifest.fixtures[key]) return { key, ...manifest.fixtures[key] };
    throw new Error(`unknown CPT fixture ${name}`);
  }
  function resetProject() {
    const P = api.PROJECT;
    P.cpts.splice(0, P.cpts.length, api.newCptState('CPT-1'));
    P.activeCptIdx = 0; P.sectionOrder = [0]; P.name = 'CPT Project'; P.phase = 'analysis'; P.stratigraphy = null;
    api.selectCpt(0);
  }
  async function importCpt(name) {
    const entry = fixtureEntry(name);
    const fileRel = entry.base ? `cpt/${entry.base}` : entry.key;
    const fname = fileRel.slice(fileRel.lastIndexOf('/') + 1);
    const file = new File([readFileSync(join(FIX, fileRel))], fname);
    stub.alerts.length = 0;
    const before = stub.alerts.length;
    api.loadGEF({ target: { files: [file], value: '' } });
    await waitFor(() => (S().meta?.fname === fname && S().data.length > 0) || stub.alerts.length > before, `import of ${fname}`);
    if (entry.inject) Object.assign(S(), entry.inject);
  }
  async function classify(name) {
    resetProject();
    await importCpt(name);
    S().method = 'sb260';
    api.runClass();
    api.goS(3); api.goS(5);
  }

  await classify('layered');
  Object.assign(B(), clone(CPT_TERRAIN));
  api.setStage6App('bishop');

  // tooltip: the material's own set, the workspace fallback under all three strength sets
  {
    const rows = [];
    for (const set of ['characteristic', 'da1_1', 'da1_2']) {
      B().strengthSet = set;
      for (const m of Object.keys(MATERIALS)) rows.push([set, m, call(G.stage6BishopTooltipHtml, { id: 'r', material: MATERIALS[m] })]);
      rows.push([set, 'nullRegion', call(G.stage6BishopTooltipHtml, null)]);
      rows.push([set, 'undefinedRegion', call(G.stage6BishopTooltipHtml, undefined)]);
      rows.push([set, 'noMaterial', call(G.stage6BishopTooltipHtml, { id: 'r' })]);
    }
    B().strengthSet = 'characteristic';
    grid('tooltipHtml', rows);
  }
  // boundary picking: three viewport scales × polygons × worlds
  {
    const scales = [1, 24, 400];
    const worlds = [{ x: 2, y: 0 }, { x: 2, y: 0.1 }, { x: 2, y: 5 }, { x: 0, y: 0 }, { x: 0.0005, y: 0.0005 }, { x: 4, y: 4 }, { x: -100, y: -100 }, { x: NaN, y: 0 }];
    const rows = [];
    const scaleBefore = B().viewport.scale;
    for (const scale of scales) {
      B().viewport.scale = scale;
      rows.push([scale, 'tolerance', -1, call(G.stage6BishopBoundaryPickToleranceWorld), call(G.stage6BishopSnapToleranceWorld)]);
      for (const p of polyNames) for (let i = 0; i < worlds.length; i += 1) rows.push([scale, p, i, call(G.stage6BishopPickRegionBoundaryPoint, { polygon: POLY[p] }, worlds[i])]);
      rows.push([scale, 'nullRegion', 0, call(G.stage6BishopPickRegionBoundaryPoint, null, worlds[0])]);
    }
    B().viewport.scale = scaleBefore;
    grid('pickRegionBoundaryPoint', rows);
  }
  // the split tool's real path: both cut points come from pickRegionBoundaryPoint (so they carry
  // edgeIndex / vertexIndex / t), every ordered pair of eight probe points, five polygons
  {
    const scaleBefore = B().viewport.scale;
    B().viewport.scale = 8;
    const worlds = [{ x: 2, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 2 }, { x: 0, y: 0 }, { x: 4, y: 4 }, { x: 1, y: 0 }, { x: 3, y: 0 }];
    const rows = [];
    for (const p of ['tri', 'square', 'rect', 'concaveL', 'verticalEdges']) {
      const cuts = worlds.map((w) => G.stage6BishopPickRegionBoundaryPoint({ polygon: POLY[p] }, w));
      for (let i = 0; i < cuts.length; i += 1) for (let j = i + 1; j < cuts.length; j += 1) {
        rows.push([p, i, j, call(G.stage6BishopSplitRegionPolygon, { polygon: POLY[p] }, cuts[i], cuts[j])]);
      }
    }
    B().viewport.scale = scaleBefore;
    grid('splitRegionPolygonPicked', rows);
  }
  // the line-probe catalogue: every workspace × analysis type × hasHs, and every quantity's meta
  {
    const rows = [];
    for (const ws of ['seepage', 'deformation', 'stability', '', null, 'bogus']) {
      for (const at of [null, 'deformation', 'safety-cphi', 'bogus']) {
        for (const hs of [false, true, undefined, 'yes']) {
          rows.push([ws, at, ser(hs), null, call(G.stage6BishopLineProbeOptions, ws, at, hs)]);
          for (const q of ['head', 'porePressure', 'gradient', 'hydraulicFs', 'flow', 'qx', 'qy', 'normalFlow', 'uTotal', 'settlement', 'mcEta', 'hsGammaP', 'bogus', null, undefined]) {
            rows.push([ws, at, ser(hs), ser(q), call(G.stage6BishopLineProbeMeta, ws, q, at, hs)]);
          }
        }
      }
    }
    // the analysisType fallback reads the state, so both branches are exercised
    const before = B().deformation.options.analysisType;
    const fallback = [];
    for (const at of ['deformation', 'safety-cphi']) {
      B().deformation.options.analysisType = at;
      fallback.push([at, call(G.stage6BishopNormalizedDeformationAnalysisType), call(G.stage6BishopLineProbeOptions, 'deformation'), call(G.stage6BishopLineProbeMeta, 'deformation', 'uTotal')]);
    }
    B().deformation.options.analysisType = before;
    grid('lineProbeOptions', rows);
    grid('lineProbeOptionsFallback', fallback);
  }
  grid('copyTextFallback', [['', call(G.stage6CopyTextFallback, '')], ['text', call(G.stage6CopyTextFallback, 'a\tb\nc')]]);

  // ── (b) the probe readout on real solved fields ─────────────────────────────────────────
  const { analyzeSeepageModel, sampleSeepageHead, sampleSeepageFlowState } = await server.ssrLoadModule('/src/lib/cpt-app/seepage/solver.js');
  const { analyzeDeformationModel, sampleDeformationState } = await server.ssrLoadModule('/src/lib/cpt-app/deformation/solver.js');
  const deformationSuite = await server.ssrLoadModule('/scripts/golden/suites/deformation.mjs');
  const seepageSuite = await server.ssrLoadModule('/scripts/golden/suites/seepage.mjs');
  const { analyzeBishopSearch } = await server.ssrLoadModule('/src/lib/cpt-app/stage6-bishop.js');

  // One js-cpu linear-elastic deformation field (the `base.js-cpu.linear-elastic.t3.a0.5` golden
  // case) solved once and written into every CPT's bishop.deformation the way the run reducer
  // writes it (`mesh = output.mesh`, `result = output`). It is a *real* solved field, which is
  // what the probe's sampler and readout need; which section it belongs to does not matter for
  // sampleDeformationState, and both controllers get the identical object.
  const DEFORMATION_MODEL = JSON.parse(readFileSync(join(FIX, 'models/deformation-base.json'), 'utf8'));
  const DEFORMATION_OPTIONS = deformationSuite.baseOptions({ analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 0.5, constitutiveModel: 'linear-elastic', useWasmCpuPipeline: false });
  const deformationOut = await analyzeDeformationModel({ model: clone(DEFORMATION_MODEL), options: DEFORMATION_OPTIONS });
  const DEFORMATION_LINES = linesForModel(DEFORMATION_MODEL);

  /** Make the active CPT runnable the way seep-slope-journey does, solve, then probe. */
  async function probeActive(label) {
    api.goS(3); api.goS(5);
    Object.assign(B(), clone(CPT_TERRAIN));
    api.setStage6App('bishop');
    const model = S().stage6Cache.bishopModel;
    if (!model) { dump.probe.push({ label, skipped: 'no model', observations: [] }); return; }
    api.stage6BishopSetWorkspace('seepage');
    const boundary = S().stage6Cache.bishopSeepageBoundary || [];
    for (const [source, head] of [['side-left', 3.0], ['side-right', -0.5]]) {
      const edge = boundary.find((e) => e.source === source);
      if (!edge) continue;
      api.stage6BishopSelectSeepageBoundary(edge.edgeKey);
      api.stage6BishopSetSeepageBcType('head');
      api.stage6BishopSetSeepageBcHead(head);
    }
    api.stage6BishopSetField('seepage.options.meshTargetArea', 1.0);
    const seepageModel = S().stage6Cache.bishopModel;
    let seepageError = null;
    try {
      const out = await analyzeSeepageModel({ model: clone({ ...seepageModel, seepage: { ...(seepageModel.seepage || {}), mesh: null, result: null } }) });
      B().seepage.mesh = out.mesh; B().seepage.result = out.result;
      B().seepage.status = 'success'; B().seepage.stale = false; B().seepage.rejectReason = '';
    } catch (e) { seepageError = String(e?.message || e); }
    B().deformation.mesh = clone(deformationOut.mesh);
    B().deformation.result = clone(deformationOut);
    B().deformation.status = 'success'; B().deformation.stale = false; B().deformation.rejectReason = '';
    B().deformation.warnings = [];
    const seepageLines = linesForModel(seepageModel);
    const observations = [];
    for (const [workspace, quantities, path, lines] of [
      ['seepage', SEEPAGE_QUANTITIES, 'lineProbe.seepageQuantity', seepageLines],
      ['deformation', DEFORMATION_QUANTITIES, 'lineProbe.deformationQuantity', DEFORMATION_LINES],
      ['stability', ['head'], 'lineProbe.seepageQuantity', seepageLines]
    ]) {
      api.stage6BishopSetWorkspace(workspace);
      for (const quantity of quantities) {
        api.stage6BishopSetField(path, quantity);
        for (const [lineLabel, points] of Object.entries(lines)) {
          B().measurement.points = clone(points);
          const metrics = G.stage6BishopMeasurementMetrics(B().measurement.points);
          const probe = call(G.stage6BishopBuildLineProbe, workspace, metrics);
          observations.push({
            key: `${workspace}/${quantity}/${lineLabel}`,
            probe: ser(probe),
            clipboard: probe.v ? G.stage6BishopLineProbeClipboardText(probe.v) : null,
            valueHeader: probe.v ? G.stage6BishopLineProbeClipboardValueHeader(probe.v) : null,
            formatted: probe.v?.stats ? [G.stage6BishopLineProbeFormatValue(probe.v.meta, probe.v.stats.min), G.stage6BishopLineProbeFormatValue(probe.v.meta, probe.v.stats.max), G.stage6BishopLineProbeFormatValue(probe.v.meta, probe.v.stats.mean)] : null
          });
        }
      }
      // one full render per workspace with the "across" line, then the copy handler
      B().measurement.points = clone(lines.across);
      api.renderStage6();
      stub.alerts.length = 0;
      let copyError = null;
      try { await G.stage6BishopCopyLineProbeData(); } catch (e) { copyError = String(e?.message || e); }
      observations.push({
        key: `${workspace}/render`,
        area: area(),
        cache: ser(S().stage6Cache.bishopLineProbe),
        copyMessage: B().lineProbe.copyMessage,
        copyTone: B().lineProbe.copyTone,
        copyError,
        alerts: stub.alerts.slice()
      });
    }
    // the "run seepage first" branch: a solved mesh without a result
    api.stage6BishopSetWorkspace('seepage');
    const solvedResult = B().seepage.result;
    B().seepage.result = null;
    B().measurement.points = clone(seepageLines.across);
    const noResultProbe = call(G.stage6BishopBuildLineProbe, 'seepage', G.stage6BishopMeasurementMetrics(B().measurement.points));
    observations.push({ key: 'seepage/no-result', probe: ser(noResultProbe), clipboard: noResultProbe.v ? G.stage6BishopLineProbeClipboardText(noResultProbe.v) : null, valueHeader: noResultProbe.v ? G.stage6BishopLineProbeClipboardValueHeader(noResultProbe.v) : null, formatted: null });
    B().seepage.result = solvedResult;
    // the safety-cphi catalogue on the same solved field
    api.stage6BishopSetWorkspace('deformation');
    api.stage6BishopSetField('deformation.options.analysisType', 'safety-cphi');
    B().measurement.points = clone(DEFORMATION_LINES.across);
    const safetyProbe = call(G.stage6BishopBuildLineProbe, 'deformation', G.stage6BishopMeasurementMetrics(B().measurement.points));
    observations.push({ key: 'deformation/safety-cphi', probe: ser(safetyProbe), clipboard: safetyProbe.v ? G.stage6BishopLineProbeClipboardText(safetyProbe.v) : null, valueHeader: safetyProbe.v ? G.stage6BishopLineProbeClipboardValueHeader(safetyProbe.v) : null, formatted: null });
    api.stage6BishopSetField('deformation.options.analysisType', 'deformation');
    dump.probe.push({ label, seepageError, seepageStatus: B().seepage.status, deformationStatus: B().deformation.status, observations });
  }

  {
    resetProject();
    const saved = Math.random;
    Math.random = mulberry32(manifest.seed);
    try { api.loadDemo(); } finally { Math.random = saved; }
    await waitFor(() => S().data.length > 0, 'loadDemo');
    S().method = 'sb260';
    api.runClass();
    await probeActive('demo');
  }
  for (const fx of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${fx}.madep.json`))], `${fx}.madep.json`));
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      await probeActive(`${fx}#${i}`);
    }
  }

  // ── (c) the geometry through its callers ────────────────────────────────────────────────
  const idEvents = [];
  let clockT = 1700000000000;
  const rng = mulberry32(0x5eed5eed);
  const seedIds = () => { Date.now = () => { clockT += 1000; idEvents.push(['now', clockT]); return clockT; }; Math.random = () => { const v = rng(); idEvents.push(['random', v]); return v; }; };
  const unseedIds = () => { Date.now = realNow; Math.random = realRandom; };
  async function step(label, fn) {
    stub.rafErrors.length = 0; stub.alerts.length = 0;
    let error = null;
    try { await fn(); } catch (e) { error = String(e?.message || e); }
    dump.walk.push({
      label, error,
      bishop: ser(B()), ui: ser(S().stage6.ui),
      message: B().progress?.message ?? null,
      area: area(),
      alerts: stub.alerts.slice(), rafErrors: stub.rafErrors.map((e) => String(e?.message || e)),
      idEvents: idEvents.length
    });
  }
  await classify('layered');
  Object.assign(B(), clone(CPT_TERRAIN));
  api.setStage6App('bishop');
  seedIds();
  try {
    const draw = (points, kind) => { api.stage6BishopSetTool(kind === 'regionHole' ? 'regionHole' : kind); B().draft = clone(points); B().draftKind = kind; };
    const setSplitDraft = (a, b) => { B().draft = [a, b]; B().draftKind = 'regionSplit'; };
    await step('copy regions to custom', () => api.stage6BishopCopyCurrentRegionsToCustom());
    await step('use custom regions', () => api.stage6BishopSetUseCustomRegions(true));
    await step('region draft → finish', () => { draw([{ x: 2, y: 2 }, { x: 10, y: 2 }, { x: 10, y: -2 }, { x: 2, y: -2 }], 'region'); api.stage6BishopFinishDraft(); });
    await step('region draft degenerate → finish', () => { draw([{ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 2 }], 'region'); api.stage6BishopFinishDraft(); });
    await step('region draft self-intersecting → finish', () => { draw(POLY.bowtie, 'region'); api.stage6BishopFinishDraft(); });
    await step('region draft two points → finish', () => { draw(POLY.two, 'region'); api.stage6BishopFinishDraft(); });
    await step('select the first custom region', () => { G.stage6BishopSetSelectedRegion(B().customRegions?.[0]?.id ?? ''); });
    await step('split: two boundary points', () => {
      const poly = G.stage6BishopSelectedCustomRegion()?.polygon || [];
      const mid = (i, j) => ({ x: 0.5 * (poly[i].x + poly[j].x), y: 0.5 * (poly[i].y + poly[j].y) });
      if (poly.length >= 4) setSplitDraft(mid(0, 1), mid(2, 3)); else setSplitDraft({ x: 0, y: 0 }, { x: 1, y: 1 });
      G.stage6BishopSplitSelectedRegion();
    });
    await step('split: coincident points', () => { setSplitDraft({ x: 1, y: 1 }, { x: 1, y: 1 }); G.stage6BishopSplitSelectedRegion(); });
    await step('split: outside the polygon', () => { setSplitDraft({ x: -50, y: -50 }, { x: 50, y: 50 }); G.stage6BishopSplitSelectedRegion(); });
    await step('split: no draft', () => { B().draft = []; B().draftKind = 'regionSplit'; G.stage6BishopSplitSelectedRegion(); });
    await step('split: no selection', () => { G.stage6BishopSetSelectedRegion(''); setSplitDraft({ x: 0, y: 0 }, { x: 1, y: 1 }); G.stage6BishopSplitSelectedRegion(); });
    await step('hole draft inside a custom region', () => {
      G.stage6BishopSetSelectedRegion(B().customRegions?.[0]?.id ?? '');
      const poly = G.stage6BishopSelectedCustomRegion()?.polygon || [];
      const cx = poly.reduce((s, p) => s + p.x, 0) / Math.max(poly.length, 1);
      const cy = poly.reduce((s, p) => s + p.y, 0) / Math.max(poly.length, 1);
      draw([{ x: cx - 0.4, y: cy - 0.4 }, { x: cx + 0.4, y: cy - 0.4 }, { x: cx + 0.4, y: cy + 0.4 }, { x: cx - 0.4, y: cy + 0.4 }], 'regionHole');
      api.stage6BishopFinishDraft();
    });
    await step('hole draft outside its parent', () => { draw([{ x: -30, y: -30 }, { x: -28, y: -30 }, { x: -28, y: -28 }], 'regionHole'); api.stage6BishopFinishDraft(); });
    await step('hole draft two points', () => { draw(POLY.two, 'regionHole'); api.stage6BishopFinishDraft(); });
    await step('hole draft self-intersecting', () => { draw(POLY.bowtie, 'regionHole'); api.stage6BishopFinishDraft(); });
    await step('terrain draft → finish', () => { api.stage6BishopSetTool('terrain'); B().draft = [{ x: 0, y: 5 }, { x: 10, y: 4 }, { x: 22, y: 1 }]; B().draftKind = 'terrain'; api.stage6BishopFinishDraft(); });
    await step('pop draft point', () => { api.stage6BishopSetTool('region'); B().draft = [{ x: 1, y: 1 }, { x: 2, y: 2 }]; api.stage6BishopPopDraftPoint(); });
    await step('measure two points', () => { api.stage6BishopSetTool('measure'); B().measurement.points = [{ x: 1, y: 1 }, { x: 9, y: -1 }]; api.renderStage6(); });
    await step('copy line probe without a solved field', async () => { api.stage6BishopSetWorkspace('seepage'); B().seepage.mesh = null; B().seepage.result = null; await G.stage6BishopCopyLineProbeData(); });
    await step('clear measurement', () => G.stage6BishopClearMeasurement());
    await step('clear custom regions', () => api.stage6BishopClear('customRegions'));
    await step('clear terrain', () => api.stage6BishopClear('terrain'));
  } finally { unseedIds(); }
  dump.walkIdEvents = idEvents.length;

  // ── (e) the goldens that pass through the geometry / probe region ────────────────────────
  {
    /** Mirrors the private slimSearch of scripts/golden/suites/bishop.mjs (not exported there). */
    const slimSearch = (result) => {
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
    };
    const golden = {};
    const stage6Names = Object.entries(manifest.fixtures)
      .filter(([k, e]) => k.startsWith('cpt/') && e.role === 'profile')
      .map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, ''))
      .filter((n) => !['trailing-qc-only', 'wt-above-surface'].includes(n));
    for (const fx of stage6Names) {
      await classify(fx);
      Object.assign(B(), clone(CPT_TERRAIN));
      api.setStage6App('bishop');
      const model = S().stage6Cache.bishopModel;
      golden[`bishop/cpt.${fx}.model.json`] = stableJson(normalize(model));
      golden[`bishop/cpt.${fx}.materials.json`] = stableJson(normalize(B().materials));
      if (!model) continue;
      const b = B();
      const search = analyzeBishopSearch({ model, entryZone: b.entryZone, exitZone: b.exitZone, methodMode: b.methodMode, searchConfig: { ...b.search, ...CPT_SEARCH }, solverConfig: { ...b.solver }, spencerConfig: { ...b.spencer, recheckCount: 2 }, soilSource: 'regions' });
      golden[`bishop/cpt.${fx}.search.json`] = stableJson(normalize(slimSearch(search)));
      api.stage6BishopRunSearch();
      golden[`bishop/cpt.${fx}.run-handler.json`] = stableJson(normalize({ message: b.progress.message, running: b.progress.running, results: b.results }));
    }
    // seepage: the app-built model of `layered` with the two side heads, solved in process
    await classify('layered');
    Object.assign(B(), clone(CPT_TERRAIN));
    api.setStage6App('bishop');
    api.stage6BishopSetWorkspace('seepage');
    const boundary = S().stage6Cache.bishopSeepageBoundary;
    golden['seepage/cpt.layered.app-boundary.json'] = stableJson(normalize(boundary));
    for (const [source, head] of [['side-left', 3.0], ['side-right', -0.5]]) {
      const edge = boundary.find((e) => e.source === source);
      api.stage6BishopSelectSeepageBoundary(edge.edgeKey);
      api.stage6BishopSetSeepageBcType('head');
      api.stage6BishopSetSeepageBcHead(head);
    }
    api.stage6BishopSetField('seepage.options.meshTargetArea', 1.0);
    golden['seepage/cpt.layered.state.json'] = stableJson(normalize({ bcs: B().seepage.bcs, options: B().seepage.options, selectedEdgeKey: B().seepage.selectedEdgeKey, geometryHash: B().seepage.geometryHash }));
    api.stage6BishopRunSeepage();
    golden['seepage/cpt.layered.run-handler.json'] = stableJson(normalize({ status: B().seepage.status, rejectReason: B().seepage.rejectReason }));
    {
      const model = S().stage6Cache.bishopModel;
      const out = await analyzeSeepageModel({ model: clone({ ...model, seepage: { ...(model.seepage || {}), mesh: null, result: null } }) });
      golden['seepage/cpt.layered.mesh.json'] = stableJson(normalize(seepageSuite.slimMesh(out.mesh)));
      golden['seepage/cpt.layered.result.json'] = stableJson(normalize(seepageSuite.slimResult(out.result)));
    }
    {
      const base = JSON.parse(readFileSync(join(FIX, 'models/seepage-base-fixed-head.json'), 'utf8'));
      const out = await analyzeSeepageModel({ model: clone(base) });
      const xs = base.terrain.vertices.map((v) => v.x);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const yTop = Math.max(...base.terrain.vertices.map((v) => v.y));
      const y0 = base.analysisBottomY;
      const samples = [];
      for (let i = 1; i <= 4; i++) for (let j = 1; j <= 3; j++) {
        const x = x0 + (x1 - x0) * i / 5, y = y0 + (yTop - y0) * j / 4;
        samples.push({ x, y, head: sampleSeepageHead(out.mesh, out.result, x, y), flow: sampleSeepageFlowState(out.mesh, out.result, x, y) });
      }
      golden['seepage/base-fixed-head.samples.json'] = stableJson(normalize(samples));
    }
    // deformation: the js-cpu linear-elastic T3 case solved above, and its sample grid
    {
      golden['deformation/base.js-cpu.linear-elastic.t3.a0.5.result.json'] = stableJson(normalize(deformationSuite.slimOutput(deformationOut)));
      golden['deformation/base.js-cpu.linear-elastic.t3.a0.5.mesh.json'] = stableJson(normalize(deformationSuite.slimMesh(deformationOut.mesh)));
      const xs = DEFORMATION_MODEL.terrain.vertices.map((v) => v.x);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const yTop = Math.min(...DEFORMATION_MODEL.terrain.vertices.map((v) => v.y));
      const y0 = DEFORMATION_MODEL.analysisBottomY;
      const samples = [];
      for (let i = 1; i <= 4; i++) for (let j = 1; j <= 3; j++) {
        const x = x0 + (x1 - x0) * i / 5, y = y0 + (yTop - y0) * j / 4;
        samples.push({ x, y, state: sampleDeformationState(deformationOut.mesh, deformationOut, x, y) });
      }
      golden['deformation/base.js-cpu.linear-elastic.t3.a0.5.samples.json'] = stableJson(normalize(samples));
    }
    dump.goldens = golden;
  }

  // ── (d) the packages standalone (working tree only) ──────────────────────────────────────
  if (pure) {
    const geom = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/geometry/index.js');
    const probe = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/probe/index.js');
    const ALIASES = {
      dist: 'stage6BishopDist', pointInPolygon: 'stage6BishopPointInPolygon', regionAtPoint: 'stage6BishopRegionAtPoint',
      regionShortLabel: 'stage6BishopRegionShortLabel', polygonCentroid: 'stage6BishopPolygonCentroid',
      regionLegendItems: 'stage6BishopRegionLegendItems', measurementMetrics: 'stage6BishopMeasurementMetrics',
      measurementLabel: 'stage6BishopMeasurementLabel', measurementVectors: 'stage6BishopMeasurementVectors',
      showingCustomRegionPreview: 'stage6BishopShowingCustomRegionPreview', polygonIsValid: 'stage6BishopPolygonIsValid',
      segmentOrientation: 'stage6BishopSegmentOrientation', segmentsIntersectClosed: 'stage6BishopSegmentsIntersectClosed',
      validateHolePolygon: 'stage6BishopValidateHolePolygon', pointOnSegment: 'stage6BishopPointOnSegment',
      pointInsideOrBoundary: 'stage6BishopPointInsideOrBoundary', closestPointOnSegment: 'stage6BishopClosestPointOnSegment',
      traverseBoundary: 'stage6BishopTraverseBoundary', buildSplitBoundary: 'stage6BishopBuildSplitBoundary',
      uniqueSortedNumbers: 'stage6BishopUniqueSortedNumbers', boundaryYAtX: 'stage6BishopBoundaryYAtX',
      polygonIntervalsDetailed: 'stage6BishopPolygonIntervalsDetailed', subtractDetailedIntervals: 'stage6BishopSubtractDetailedIntervals',
      subtractHoleFromPolygon: 'stage6BishopSubtractHoleFromPolygon', splitRegionPolygon: 'stage6BishopSplitRegionPolygon'
    };
    const PROBE_ALIASES = {
      lineProbeFormatValue: 'stage6BishopLineProbeFormatValue', clipboardNumber: 'stage6ClipboardNumber',
      lineProbeClipboardValueHeader: 'stage6BishopLineProbeClipboardValueHeader', lineProbeClipboardText: 'stage6BishopLineProbeClipboardText',
      lineProbeStats: 'stage6BishopLineProbeStats', integrateLineProbe: 'stage6BishopIntegrateLineProbe'
    };
    dump.pure.aliases = Object.entries(ALIASES).map(([pkg, ctrl]) => [pkg, ctrl, geom[pkg] === G[ctrl]])
      .concat(Object.entries(PROBE_ALIASES).map(([pkg, ctrl]) => [pkg, ctrl, probe[pkg] === G[ctrl]]));
    dump.pure.namespaces = ['points', 'polygons', 'boundary', 'regions', 'measurement'].map((n) => [n, typeof geom[n] === 'object' && geom[n] !== null])
      .concat(['options', 'clipboard', 'lineProbe'].map((n) => [n, typeof probe[n] === 'object' && probe[n] !== null]));
    // input immutability over the whole polygon / point grid
    const mutations = [];
    const before = ser({ PT, POLY, SEG });
    for (const p of Object.keys(POLY)) {
      geom.polygonCentroid(POLY[p]); geom.polygonIsValid(POLY[p]); geom.polygonIntervalsDetailed(POLY[p], 2);
      geom.subtractHoleFromPolygon(POLY[p], POLY.square); geom.validateHolePolygon({ polygon: POLY[p] }, POLY.square);
      geom.splitRegionPolygon({ polygon: POLY[p] }, { x: 2, y: 0 }, { x: 2, y: 4 });
      geom.traverseBoundary(POLY[p], 0, 1); geom.buildSplitBoundary(POLY[p], []);
      geom.pickRegionBoundaryPoint({ polygon: POLY[p] }, { x: 2, y: 0.1 }, 0.5);
      for (const q of Object.keys(PT)) { geom.pointInPolygon(PT[q], POLY[p]); geom.pointInsideOrBoundary(PT[q], POLY[p]); }
      for (const s of Object.keys(SEG)) geom.closestPointOnSegment(PT.a, SEG[s][0], SEG[s][1]);
    }
    if (ser({ PT, POLY, SEG }) !== before) mutations.push('a geometry function mutated its input');
    dump.pure.immutability = mutations;
    // the tolerance contract: a number and a zero-argument function must agree, and the function
    // is called exactly once, only when an edge was found
    let calls = 0;
    const tolFn = () => { calls += 1; return 0.2; };
    const withFn = geom.pickRegionBoundaryPoint({ polygon: POLY.square }, { x: 2, y: 0.1 }, tolFn);
    const callsHit = calls;
    const withNumber = geom.pickRegionBoundaryPoint({ polygon: POLY.square }, { x: 2, y: 0.1 }, 0.2);
    geom.pickRegionBoundaryPoint({ polygon: POLY.two }, { x: 2, y: 0.1 }, tolFn);
    dump.pure.tolerance = { same: ser(withFn) === ser(withNumber), callsHit, callsAfterDegenerate: calls, value: ser(withFn) };
    // the probe env contract: buildLineProbe must not touch the block it is given
    const bishopCopy = clone(B());
    bishopCopy.deformation.mesh = deformationOut.mesh;
    bishopCopy.deformation.result = deformationOut;
    const bishopCopyText = ser(bishopCopy);
    const envCalls = [];
    const env = {
      hardeningSoilUi: false,
      normalizedDeformationAnalysisType: (t) => { envCalls.push(['type', t ?? null]); return t === 'safety-cphi' ? 'safety-cphi' : 'deformation'; },
      deformationContourOptions: (t, hs) => { envCalls.push(['options', t, hs]); return [{ id: 'uTotal', label: '|u|' }]; },
      deformationContourMeta: (id, t) => { envCalls.push(['meta', id, t]); return { label: '|u|', axisTitle: '|u| (mm)', unit: 'mm', digits: 2 }; },
      seepageHydraulicFs: (g, m) => { envCalls.push(['fs', g, m?.id ?? null]); return 1.5; }
    };
    const probeOut = probe.buildLineProbe(bishopCopy, 'deformation', geom.measurementMetrics(DEFORMATION_LINES.across), env);
    dump.pure.env = {
      untouched: ser(bishopCopy) === bishopCopyText,
      calls: envCalls.slice(0, 6),
      status: probeOut.status,
      optionsSeepage: ser(probe.lineProbeOptions('seepage')),
      optionsStability: ser(probe.lineProbeOptions('stability')),
      metaFallback: ser(probe.lineProbeMeta('seepage', 'nope'))
    };
    // the two explicit host inputs of geometry/regions.js
    dump.pure.guards = {
      noBishop: ser(geom.displayRegions({ regions: [{ id: 'a' }] }, null)),
      withBishop: ser(geom.displayRegions({ regions: [{ id: 'a' }] }, B())),
      tooltipLazySet: (() => {
        let reads = 0;
        const env = { strengthSet: () => { reads += 1; return 'da1_2'; }, strengthSetLabel: (k) => `<${k}>` };
        const noMaterial = geom.regionTooltipHtml({ id: 'r' }, env);
        const readsAfterNoMaterial = reads;
        const ownSet = geom.regionTooltipHtml({ material: { label: 'm', sourceStrengthSet: 'da1_1' } }, env);
        const readsAfterOwnSet = reads;
        const fallback = geom.regionTooltipHtml({ material: { label: 'm' } }, env);
        return { noMaterial, readsAfterNoMaterial, readsAfterOwnSet, reads, ownSet: /<da1_1>/.test(ownSet), fallback: /<da1_2>/.test(fallback) };
      })()
    };
    dump.pure.geometryKeys = Object.keys(geom).sort();
    dump.pure.probeKeys = Object.keys(probe).sort();
  }

  writeFileSync(outPath, JSON.stringify(dump));
  await server.close();
  process.exit(0);
}

// ═══════════════════════════════ parent: run + compare ═══════════════════════════════
function runDump(ctrlRel, outPath, extra = []) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dump', ctrlRel, outPath, ...extra], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`dump of ${ctrlRel} failed (exit ${r.status})`);
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function firstTextDiff(a, b) {
  if (a === b) return null;
  a = String(a ?? ''); b = String(b ?? '');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`;
}
function firstDiff(aJson, bJson) {
  if (aJson === bJson) return null;
  let a, b;
  try { a = JSON.parse(aJson); b = JSON.parse(bJson); } catch { return firstTextDiff(String(aJson), String(bJson)); }
  const walk = (x, y, path) => {
    if (x === y) return null;
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') return `${path || '<root>'}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`;
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.join(' ') !== ky.join(' ')) {
      const missing = kx.filter((k) => !ky.includes(k)), extra = ky.filter((k) => !kx.includes(k));
      if (missing.length || extra.length) return `${path || '<root>'}: keys missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`;
      return `${path || '<root>'}: key order ${JSON.stringify(kx)} → ${JSON.stringify(ky)}`;
    }
    for (const k of kx) { const d = walk(x[k], y[k], path ? `${path}.${k}` : k); if (d) return d; }
    return null;
  };
  return walk(a, b, '') || 'texts differ (whitespace?)';
}
const countRows = (json) => { try { return JSON.parse(json).length; } catch { return '?'; } };

const tmp = mkdtempSync(join(tmpdir(), 'verify-seepslope-geometry-'));
const materialised = [];
let oldDump, newDump;
try {
  const against = opt('--against');
  const snapshot = opt('--snapshot');
  const treePath = resolve(ROOT, TREE_REL);
  writeFileSync(treePath, readFileSync(resolve(ROOT, CTRL_REL), 'utf8') + EXPORT_BLOCK);
  materialised.push(treePath);
  console.log('working tree controller …');
  newDump = runDump(TREE_REL, join(tmp, 'new.json'), ['--pure']);
  if (snapshot) { writeFileSync(snapshot, JSON.stringify(newDump)); console.log(`snapshot written: ${snapshot}`); process.exit(0); }
  if (against) {
    oldDump = JSON.parse(readFileSync(against, 'utf8'));
  } else {
    const base = opt('--base') || 'integration-r';
    let text;
    try { text = execFileSync('git', ['show', `${base}:${CTRL_REL}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) { console.error(`cannot read ${CTRL_REL} at ${base} (${e.message.split('\n')[0]}); pass --base <ref> or --against <dump.json>`); process.exit(2); }
    const basePath = resolve(ROOT, BASE_REL);
    writeFileSync(basePath, text + EXPORT_BLOCK); materialised.push(basePath);
    console.log(`base controller (${base}) …`);
    oldDump = runDump(BASE_REL, join(tmp, 'old.json'));
  }
} finally {
  for (const p of materialised) if (existsSync(p)) rmSync(p);
  rmSync(tmp, { recursive: true, force: true });
}

// ── (a) ──────────────────────────────────────────────────────────────────────────────────
console.log(`\n(a) the geometry / probe grid — ${Object.keys(newDump.grid).length} function groups`);
check('(a) same function groups', JSON.stringify(Object.keys(oldDump.grid)) === JSON.stringify(Object.keys(newDump.grid)),
  `${JSON.stringify(Object.keys(oldDump.grid))} → ${JSON.stringify(Object.keys(newDump.grid))}`);
let gridValues = 0;
for (const label of Object.keys(newDump.grid)) {
  const rows = countRows(newDump.grid[label]);
  if (typeof rows === 'number') gridValues += rows;
  check(`grid ${label} (${rows} cases): deep-equal + key order`, oldDump.grid[label] === newDump.grid[label], firstDiff(oldDump.grid[label], newDump.grid[label]));
}
console.log(`       ${gridValues} grid cases compared`);
{
  const parse = (l) => JSON.parse(newDump.grid[l]);
  const messages = new Set([
    ...parse('splitRegionPolygon').map(([, , r]) => r?.v?.message),
    ...parse('splitRegionPolygonPicked').map(([, , , r]) => r?.v?.message)
  ].filter(Boolean));
  const ok = parse('splitRegionPolygonPicked').filter(([, , , r]) => r?.v?.ok === true);
  check(`grid: splitRegionPolygon reached ${messages.size} distinct refusals and ${ok.length} successful splits`,
    messages.size >= 5 && ok.length > 0, `${messages.size} distinct messages, ${ok.length} successes`);
  const holes = parse('validateHolePolygon');
  const holeMessages = new Set(holes.map(([, , r]) => r?.v?.message).filter(Boolean));
  check('grid: validateHolePolygon reached its three refusals and the success branch',
    holeMessages.size >= 3 && holes.some(([, , r]) => r?.v?.ok === true), [...holeMessages].join(' | '));
  const errs = Object.keys(newDump.grid).reduce((n, l) => n + ((newDump.grid[l].match(/"error":/g) || []).length), 0);
  check(`grid: ${errs} degenerate inputs made a function throw — the message is compared too`, errs > 0, `${errs}`);
  const picks = parse('pickRegionBoundaryPoint');
  check('grid: pickRegionBoundaryPoint returned vertex hits (t 0 and 1), edge points and nulls across three viewport scales',
    picks.some(([, , , r]) => r?.v?.t === 0) && picks.some(([, , , r]) => r?.v?.t === 1) && picks.some(([, , , r]) => r?.v && r.v.vertexIndex === null) && picks.some(([, , , r]) => r?.v === null), '');
  const opts = parse('lineProbeOptions');
  check('grid: lineProbeOptions produced the 8 seepage quantities and a non-empty deformation list',
    opts.some(([ws, , , q, v]) => ws === 'seepage' && q === null && Array.isArray(v?.v) && v.v.length === 8)
    && opts.some(([ws, , , q, v]) => ws === 'deformation' && q === null && Array.isArray(v?.v) && v.v.length > 0), '');
  const noBishop = parse('displayRegionsNoBishop');
  check('grid: displayRegions answered at module-init time (initLegacyController has already run ensure)',
    JSON.stringify(noBishop[0][1].v) === '[{"id":"a"}]' && JSON.stringify(noBishop[1][1].v) === '[]', JSON.stringify(noBishop));
}

// ── (b) ──────────────────────────────────────────────────────────────────────────────────
console.log(`\n(b) the line-probe readout on solved fields — ${newDump.probe.length} CPTs`);
check('(b) same CPT list', JSON.stringify(oldDump.probe.map((p) => p.label)) === JSON.stringify(newDump.probe.map((p) => p.label)),
  `${JSON.stringify(oldDump.probe.map((p) => p.label))} → ${JSON.stringify(newDump.probe.map((p) => p.label))}`);
let probeObservations = 0;
newDump.probe.forEach((n, i) => {
  const o = oldDump.probe[i] || {};
  check(`probe ${n.label}: solved identically (seepage ${n.seepageStatus ?? n.skipped}, deformation ${n.deformationStatus ?? n.skipped})`,
    o.seepageError === n.seepageError && o.seepageStatus === n.seepageStatus && o.deformationStatus === n.deformationStatus && o.skipped === n.skipped,
    `${JSON.stringify([o.seepageError, o.seepageStatus, o.deformationStatus, o.skipped])} → ${JSON.stringify([n.seepageError, n.seepageStatus, n.deformationStatus, n.skipped])}`);
  const on = o.observations || [], nn = n.observations || [];
  check(`probe ${n.label}: same observation list (${nn.length})`, JSON.stringify(on.map((x) => x.key)) === JSON.stringify(nn.map((x) => x.key)));
  nn.forEach((x, j) => {
    const y = on[j] || {};
    probeObservations += 1;
    if ('probe' in x) {
      check(`probe ${n.label} ${x.key}: buildLineProbe deep-equal + key order`, y.probe === x.probe, firstDiff(y.probe, x.probe));
      check(`probe ${n.label} ${x.key}: clipboard text / header / formatted statistics byte-identical`,
        y.clipboard === x.clipboard && y.valueHeader === x.valueHeader && JSON.stringify(y.formatted) === JSON.stringify(x.formatted),
        firstTextDiff(y.clipboard, x.clipboard) || `${JSON.stringify(y.formatted)} → ${JSON.stringify(x.formatted)}`);
    } else {
      check(`probe ${n.label} ${x.key}: #stage6Area innerHTML byte-identical (${(x.area || '').length} chars)`, y.area === x.area, firstTextDiff(y.area, x.area));
      check(`probe ${n.label} ${x.key}: cached probe, copy message / tone and alerts identical`,
        y.cache === x.cache && y.copyMessage === x.copyMessage && y.copyTone === x.copyTone && y.copyError === x.copyError && JSON.stringify(y.alerts) === JSON.stringify(x.alerts),
        firstDiff(y.cache, x.cache) || `${JSON.stringify([y.copyMessage, y.copyTone, y.copyError, y.alerts])} → ${JSON.stringify([x.copyMessage, x.copyTone, x.copyError, x.alerts])}`);
    }
  });
});
console.log(`       ${probeObservations} probe observations compared`);
{
  const all = newDump.probe.flatMap((p) => (p.observations || []).filter((o) => o.probe));
  const has = (s) => all.filter((o) => o.probe.includes(`"status":"${s}"`)).length;
  check(`(b) every probe status was reached — ready ${has('ready')}, no-valid-samples ${has('no-valid-samples')}, missing-measurement ${has('missing-measurement')}, missing-result ${has('missing-result')}, unsupported ${has('unsupported')}`,
    has('ready') > 0 && has('no-valid-samples') > 0 && has('missing-measurement') > 0 && has('missing-result') > 0 && has('unsupported') > 0);
  const partial = all.filter((o) => /"coverage":0\./.test(o.probe));
  check(`(b) a line that leaves the solved domain produced a partial-coverage probe (${partial.length})`, partial.length > 0);
  const flow = all.filter((o) => /"netCrossFlow":[-0-9]/.test(o.probe));
  check(`(b) the normalFlow quantity produced its two cross-flow integrals (${flow.length})`, flow.length > 0);
}

// ── (c) ──────────────────────────────────────────────────────────────────────────────────
console.log(`\n(c) the geometry through its callers — ${newDump.walk.length} steps`);
check('(c) same step list', JSON.stringify(oldDump.walk.map((d) => d.label)) === JSON.stringify(newDump.walk.map((d) => d.label)));
oldDump.walk.forEach((o, i) => {
  const n = newDump.walk[i] || {};
  const p = `step ${String(i + 1).padStart(2, '0')} ${o.label}`;
  check(`${p}: exception identical (${o.error || 'none'})`, o.error === n.error, `${o.error} → ${n.error}`);
  check(`${p}: S.stage6.bishop deep-equal + key order`, o.bishop === n.bishop, firstDiff(o.bishop, n.bishop));
  check(`${p}: S.stage6.ui, the progress message, the alerts and the rAF errors identical`,
    o.ui === n.ui && o.message === n.message && JSON.stringify(o.alerts) === JSON.stringify(n.alerts) && JSON.stringify(o.rafErrors) === JSON.stringify(n.rafErrors),
    firstDiff(o.ui, n.ui) || `${JSON.stringify([o.message, o.alerts, o.rafErrors])} → ${JSON.stringify([n.message, n.alerts, n.rafErrors])}`);
  check(`${p}: #stage6Area innerHTML byte-identical (${(n.area || '').length} chars)`, o.area === n.area, firstTextDiff(o.area, n.area));
  check(`${p}: same number of Date.now() / Math.random() calls so far (${n.idEvents})`, o.idEvents === n.idEvents, `${o.idEvents} → ${n.idEvents}`);
});
check(`(c) same id-event total over the walk (${newDump.walkIdEvents})`, oldDump.walkIdEvents === newDump.walkIdEvents, `${oldDump.walkIdEvents} → ${newDump.walkIdEvents}`);
{
  const at = (l) => newDump.walk.find((o) => o.label === l);
  const parse = (o) => JSON.parse(o.bishop.replace(/"<undefined>"/g, 'null'));
  const added = parse(at('region draft → finish'));
  check('walk: the region draft added a custom polygon and selected it', added.customRegions.length > 0 && !!added.selectedRegionId, `${added.customRegions.length} regions`);
  const invalid = at('region draft self-intersecting → finish');
  check('walk: a self-intersecting region draft is refused with the monolith message',
    /simple non-self-intersecting closed shapes/.test(invalid.message || ''), invalid.message || '');
  const coincident = at('split: coincident points');
  check('walk: coincident split points are refused with the monolith message',
    /distinct points on the selected polygon boundary/.test(coincident.message || ''), coincident.message || '');
  const outside = at('split: outside the polygon');
  check('walk: a chord that leaves the polygon is refused',
    /must stay inside the selected polygon|falls outside the polygon|separate polygon-boundary points|invalid polygon/.test(outside.message || ''), outside.message || '');
  const noDraft = at('split: no draft');
  check('walk: splitting without two boundary points is refused', /Choose two boundary points/.test(noDraft.message || ''), noDraft.message || '');
  const badHole = at('hole draft outside its parent');
  check('walk: a hole outside its parent is refused with the monolith message',
    /strictly inside the selected custom polygon|three distinct points/.test(badHole.message || ''), badHole.message || '');
  const noProbe = at('copy line probe without a solved field');
  check('walk: copying without a solved field warns instead of copying',
    /Run seepage first|No plotted line-probe data/.test(parse(noProbe).lineProbe.copyMessage || ''), parse(noProbe).lineProbe.copyMessage || '');
}

// ── (e) ──────────────────────────────────────────────────────────────────────────────────
console.log(`\n(e) the goldens that pass through the geometry / probe region — ${Object.keys(newDump.goldens).length} files`);
check('(e) same golden set', JSON.stringify(Object.keys(oldDump.goldens).sort()) === JSON.stringify(Object.keys(newDump.goldens).sort()));
for (const rel of Object.keys(newDump.goldens).sort()) {
  const path = resolve(ROOT, 'tests/golden/node', rel);
  const onDisk = existsSync(path) ? readFileSync(path, 'utf8') : null;
  check(`${rel}: base == working tree == the file on disk`,
    oldDump.goldens[rel] === newDump.goldens[rel] && onDisk === newDump.goldens[rel],
    firstTextDiff(oldDump.goldens[rel], newDump.goldens[rel]) || firstTextDiff(onDisk, newDump.goldens[rel]));
}

// ── (d) ──────────────────────────────────────────────────────────────────────────────────
console.log('\n(d) the packages standalone (working tree)');
{
  const p = newDump.pure;
  const badAliases = p.aliases.filter(([, , same]) => !same);
  check(`(d) the ${p.aliases.length} controller names are the package's own function objects`, badAliases.length === 0, badAliases.map(([a, b]) => `${a} != ${b}`).join(', '));
  check('(d) both index modules expose their per-file namespaces', p.namespaces.every(([, ok]) => ok), JSON.stringify(p.namespaces));
  check('(d) no geometry function mutated any of its inputs over the whole grid', p.immutability.length === 0, p.immutability.join('; '));
  check('(d) pickRegionBoundaryPoint: a number and a () => number agree, and the function is called once, only when an edge was found',
    p.tolerance.same && p.tolerance.callsHit === 1 && p.tolerance.callsAfterDegenerate === 1, JSON.stringify(p.tolerance));
  check(`(d) buildLineProbe leaves the bishop block it is handed untouched, drives the env hooks and reaches '${p.env.status}'`,
    p.env.untouched === true && p.env.status === 'ready' && p.env.calls.length > 0 && p.env.calls[0][0] === 'type', JSON.stringify([p.env.status, p.env.calls]));
  check('(d) the probe catalogue without an env: 8 seepage quantities, [] in stability, the first option as the meta fallback',
    JSON.parse(p.env.optionsSeepage).length === 8 && JSON.parse(p.env.optionsStability).length === 0 && JSON.parse(p.env.metaFallback).id === 'head',
    `${JSON.parse(p.env.optionsSeepage).length} / ${JSON.parse(p.env.optionsStability).length} / ${JSON.parse(p.env.metaFallback)?.id}`);
  check('(d) displayRegions returns [] without a bishop block and the model regions with one',
    p.guards.noBishop === '[]' && p.guards.withBishop === '[{"id":"a"}]', JSON.stringify([p.guards.noBishop, p.guards.withBishop]));
  check('(d) regionTooltipHtml reads the fallback strength set lazily — never without a material, never when the material carries its own',
    p.guards.noBishop !== null && p.guards.tooltipLazySet.noMaterial === '' && p.guards.tooltipLazySet.readsAfterNoMaterial === 0
    && p.guards.tooltipLazySet.readsAfterOwnSet === 0 && p.guards.tooltipLazySet.reads === 1
    && p.guards.tooltipLazySet.ownSet === true && p.guards.tooltipLazySet.fallback === true, JSON.stringify(p.guards.tooltipLazySet));
  const expectedGeom = ['boundary', 'boundaryYAtX', 'buildSplitBoundary', 'closestPointOnSegment', 'displayRegions', 'dist', 'measurement', 'measurementLabel', 'measurementMetrics', 'measurementVectors', 'pickRegionBoundaryPoint', 'pointInPolygon', 'pointInsideOrBoundary', 'pointOnSegment', 'points', 'polygonCentroid', 'polygonIntervalsDetailed', 'polygonIsValid', 'polygons', 'regionAtPoint', 'regionLegendItems', 'regionShortLabel', 'regionTooltipHtml', 'regions', 'segmentOrientation', 'segmentsIntersectClosed', 'showingCustomRegionPreview', 'splitRegionPolygon', 'subtractDetailedIntervals', 'subtractHoleFromPolygon', 'traverseBoundary', 'uniqueSortedNumbers', 'validateHolePolygon'];
  const expectedProbe = ['buildLineProbe', 'clipboard', 'clipboardNumber', 'integrateLineProbe', 'lineProbe', 'lineProbeClipboardText', 'lineProbeClipboardValueHeader', 'lineProbeFormatValue', 'lineProbeMeta', 'lineProbeOptions', 'lineProbeStats', 'options'];
  check(`(d) seepslope/geometry exports exactly the ${expectedGeom.length} documented names`, JSON.stringify(p.geometryKeys) === JSON.stringify(expectedGeom), JSON.stringify(p.geometryKeys));
  check(`(d) seepslope/probe exports exactly the ${expectedProbe.length} documented names`, JSON.stringify(p.probeKeys) === JSON.stringify(expectedProbe), JSON.stringify(p.probeKeys));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.slice(0, 30).join('; ')); process.exit(1); }
