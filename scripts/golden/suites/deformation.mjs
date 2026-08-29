// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier A lock of the deformation solver (design §1.8, §2.1, §3.3): analyzeDeformationModel
// on the models lifted from scripts/verify_deformation_phase_1.mjs (fixtures/models/
// deformation-base|sloped.json) and the Hardening-Soil benchmarks (deformation-hs-*.json),
// through both backends — js-cpu (the in-process JS solver) and wasm-cpu (static/wasm/
// deformation, pinned by wasm.sha256.json, injected with __setDeformationWasmModuleForTests
// exactly as the verify scripts do) — with linear-elastic / mc-plastic / hardening-soil
// material points, T3 and T6 elements, a c-phi safety run and the guard errors.
// Each case is kept under 10 s (mesh target areas chosen for that; the slower grid points
// are documented in worklog/refactor/18-pr17-golden-solvers-journeys.md). Tolerance class
// `iterative` (1e-6 — the wasm path crosses -ffast-math WASM; iteration counts exact).
import { deformationModule } from '../lib/wasm.mjs';
import { digest } from '../lib/normalize.mjs';

export const name = 'deformation';
export const tolerance = 'iterative';
export const description = 'Deformation: analyzeDeformationModel js-cpu + wasm-cpu (LE / MC / HS, T3 / T6, safety) on the lifted models';

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in (o || {})).map((k) => [k, o[k]]));

/** One flat row per element (diffable, ≈ 100 B): [index, region, σ'xx, σ'yy, τxy, s1, s3, η_mc, εxx, εyy, γxy, u, ε_p, yield surface]. */
export const ELEMENT_ROW = ['elementIndex', 'regionIndex', 'sxx', 'syy', 'txy', 's1', 's3', 'etaMc', 'exx', 'eyy', 'gxy', 'porePressure', 'accumulatedPlasticStrain', 'activeYieldSurface'];
const elementRow = (e) => [e.elementIndex, e.regionIndex, e.effectiveStress?.sxx, e.effectiveStress?.syy, e.effectiveStress?.txy, e.principal?.s1, e.principal?.s3, e.mc?.eta, e.strain?.exx, e.strain?.eyy, e.strain?.gxy, e.porePressure, e.materialState?.accumulatedPlasticStrain ?? null, e.materialState?.activeYieldSurface ?? null];

/** One flat row per c-phi continuation step: [index, trialIndex, σ_Msf, λ, converged, Newton it., linear it., |u|max, settlement max, mechanism score]. */
export const SAFETY_ROW = ['index', 'trialIndex', 'sigmaMsf', 'lambda', 'converged', 'nonlinearIterations', 'linearIterations', 'uMaxAbs', 'uSettlementMax', 'mechanismScore'];
const safetyRow = (s) => SAFETY_ROW.map((k) => s?.[k] ?? null);

/** Nodal fields, summaries and solver bookkeeping in full; per-element state and the safety curve as flat rows; the rest digested. */
export function slimOutput(out) {
  if (!out) return out;
  const { timing, mesh, elementResults, solver, ...rest } = out;
  const slimSolver = solver ? { ...solver } : solver;
  if (Array.isArray(slimSolver?.safetyCurve)) {
    slimSolver.safetyCurve = { rowKeys: SAFETY_ROW, rows: slimSolver.safetyCurve.map(safetyRow), digest: digest(solver.safetyCurve) };
  }
  if (slimSolver?.safetyResult && typeof slimSolver.safetyResult === 'object' && Array.isArray(slimSolver.safetyResult.curve)) {
    slimSolver.safetyResult = { ...slimSolver.safetyResult, curve: digest(slimSolver.safetyResult.curve), curveLength: slimSolver.safetyResult.curve.length };
  }
  return { ...rest, solver: slimSolver, elements: { rowKeys: ELEMENT_ROW, rows: (elementResults || []).map(elementRow) }, elementResultsDigest: digest(elementResults || []) };
}

export function slimMesh(mesh) {
  if (!mesh) return mesh;
  return {
    ...pick(mesh, ['kind', 'elementType', 'nodes', 'elements', 'elementCell', 'meshStats', 'ndofTotal', 'mechanicalWalls', 'interfacePairs', 'warnings']),
    cells: { count: (mesh.cells || []).length, areaSum: (mesh.cells || []).reduce((s, c) => s + (Number(c.area) || 0), 0), digest: digest(mesh.cells || []) },
    constraintEdges: (mesh.constraintEdges || []).map((e) => pick(e, ['n1', 'n2', 'nMid', 'markerType', 'edgeKey', 'source', 'sourceIndex']))
  };
}

export function baseOptions(overrides = {}) {
  return {
    analysisType: 'deformation',
    meshElementType: 't3',
    meshTargetArea: 0.5,
    loadMode: 'pressure',
    constitutiveModel: 'mc-plastic',
    outOfPlaneLength: 10,
    useSeepagePorePressures: false,
    initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-4,
    residualAbsTol: 1e-3,
    nonlinearMaxIterations: 32,
    initialLoadStep: 0.25,
    minLoadStep: 1 / 2048,
    maxLoadSteps: 256,
    useUnsymmetricPlasticSolver: false,
    useWasmCpuPipeline: true,
    useNewGpuPipeline: false,
    ...overrides
  };
}

/** model · backend · constitutive model · element type · mesh target area · analysis type (each < 10 s on Apple Silicon) */
export const GRID = [
  ['base', 'js-cpu', 'linear-elastic', 't3', 0.5, 'deformation'],
  ['base', 'wasm-cpu', 'linear-elastic', 't3', 0.5, 'deformation'],
  ['base', 'js-cpu', 'mc-plastic', 't3', 0.5, 'deformation'],
  ['base', 'wasm-cpu', 'mc-plastic', 't3', 0.5, 'deformation'],
  ['base', 'wasm-cpu', 'linear-elastic', 't6', 2.0, 'deformation'],
  ['base', 'wasm-cpu', 'mc-plastic', 't6', 6.0, 'deformation'],
  ['sloped', 'js-cpu', 'linear-elastic', 't3', 1.0, 'deformation'],
  ['sloped', 'wasm-cpu', 'mc-plastic', 't3', 1.0, 'deformation'],
  ['sloped', 'wasm-cpu', 'linear-elastic', 't6', 1.0, 'deformation'],
  ['sloped', 'wasm-cpu', 'mc-plastic', 't3', 5.0, 'safety-cphi'],
  ['hs-drained-footing', 'wasm-cpu', 'hardening-soil', 't3', 0.75, 'deformation'],
  ['hs-oc-excavation', 'wasm-cpu', 'hardening-soil', 't3', 1.0, 'deformation']
  // 'hs-softclay-embankment' (200 kPa on 10 × 3 m loose sand) needs 19–34 s at every mesh tried — excluded, model fixture kept
];

function sampleGrid(sampleDeformationState, model, out) {
  const xs = model.terrain.vertices.map((v) => v.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yTop = Math.min(...model.terrain.vertices.map((v) => v.y));
  const y0 = model.analysisBottomY;
  const samples = [];
  for (let i = 1; i <= 4; i++) for (let j = 1; j <= 3; j++) {
    const x = x0 + (x1 - x0) * i / 5, y = y0 + (yTop - y0) * j / 4;
    samples.push({ x, y, state: sampleDeformationState(out.mesh, out, x, y) });
  }
  return samples;
}

export async function* cases(ctx) {
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;   // worker-only code paths (as the verify scripts do)
  const { analyzeDeformationModel, sampleDeformationState } = await import('../../../src/lib/cpt-app/deformation/solver.js');
  const { __setDeformationWasmModuleForTests } = await import('../../../src/lib/cpt-app/deformation/wasm/wasm-loader.js');
  __setDeformationWasmModuleForTests(await deformationModule());

  for (const [modelName, backend, constitutiveModel, meshElementType, meshTargetArea, analysisType] of GRID) {
    const model = ctx.fixtures.json(`models/deformation-${modelName}.json`);
    const id = `${modelName}.${backend}.${constitutiveModel}.${meshElementType}.a${meshTargetArea}${analysisType === 'deformation' ? '' : `.${analysisType}`}`;
    const options = baseOptions({ analysisType, meshElementType, meshTargetArea, constitutiveModel, useWasmCpuPipeline: backend === 'wasm-cpu' });
    const out = await analyzeDeformationModel({ model: JSON.parse(JSON.stringify(model)), options });
    yield { id: `${id}.result`, value: slimOutput(out) };
    yield { id: `${id}.mesh`, value: slimMesh(out.mesh) };
    yield { id: `${id}.samples`, value: sampleGrid(sampleDeformationState, model, out) };
  }

  // guard paths (messages are behaviour)
  const base = ctx.fixtures.json('models/deformation-base.json');
  const errors = {};
  for (const [label, input] of [
    ['hs-on-js-cpu', { model: base, options: baseOptions({ constitutiveModel: 'hardening-soil', useWasmCpuPipeline: false }) }],
    ['safety-linear-elastic', { model: base, options: baseOptions({ analysisType: 'safety-cphi', constitutiveModel: 'linear-elastic' }) }],
    ['no-load', { model: { ...base, surfaceLoad: null, surfaceLoads: [] }, options: baseOptions() }],
    ['no-regions', { model: { ...base, regions: [] }, options: baseOptions() }]
  ]) {
    try { await analyzeDeformationModel(input); errors[label] = null; } catch (e) { errors[label] = String(e?.message || e); }
  }
  yield { id: 'guards', value: errors };
}
