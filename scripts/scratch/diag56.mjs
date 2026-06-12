// Task #56 diagnostics harness: staged terrain + wall fixture, dumps the I-0
// convergence telemetry and (under MODE=1/2) the Stage-B experiment results.
//   env CUT     cut depth in m (default 1.5)
//   env RINTER  interface R_inter (default 0.667)
//   env IF      '0' disables the wall interface (staged-only repro)
//   env STAGED  '0' disables staged excavation (legacy control)
//   env MODE    0 = off, 1 = fixed-point probe, 2 = Davis associated bracket
//   env Q       surcharge in kPa (default 0.2)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __setDeformationWasmModuleForTests } from '../../src/lib/cpt-app/deformation/wasm/wasm-loader.js';
import { buildBishopModelFromStageLayers } from '../../src/lib/cpt-app/stage6-bishop.js';
if (typeof globalThis.performance === 'undefined') globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
const glue = await import(pathToFileURL(resolve('static/wasm/deformation/deformation.js')).href);
const mod = await (glue.default || glue.createDeformationModule)({ wasmBinary: readFileSync(resolve('static/wasm/deformation/deformation.wasm')) });
const MODE = Number(process.env.MODE || 0);
if (MODE && typeof mod._madepSetDebugSolverMode === 'function') mod._madepSetDebugSolverMode(MODE);
__setDeformationWasmModuleForTests(mod);
const { analyzeDeformationModel } = await import('../../src/lib/cpt-app/deformation/solver.js');
const layers = [
  { top: 0.00, bot: 2.98,  type: 'Sand',       subtype: 'zand, matig',      c: 1, phi: 30, psi: 0, g: 17, gs: 19, Emc: 23448, nu: 0.3, K0nc: 0.500, rShear: 0.33, kh: 4e-5, kv: 4e-5 },
  { top: 2.98, bot: 6.98,  type: 'Sandy clay', subtype: 'klei, matig vast', c: 4, phi: 20, psi: 0, g: 17, gs: 17, Emc: 5316,  nu: 0.4, K0nc: 0.658, rShear: 0.15, kh: 5e-7, kv: 1.7e-7, cu: 50 },
  { top: 6.98, bot: 21.72, type: 'Silty sand', subtype: 'leem, vast',       c: 8, phi: 22, psi: 0, g: 20, gs: 20, Emc: 11374, nu: 0.3, K0nc: 0.625, rShear: 0.25, kh: 3e-6, kv: 1e-6, cu: 100 }
];
const xw = 8.5, cut = Number(process.env.CUT || 1.5);
const uiState = {
  terrain: [{ x: 0, y: 0 }, { x: xw, y: 0 }, { x: xw, y: -cut }, { x: 20, y: -cut }],
  activeCptX: 4, analysisDepth: 20, strengthSet: 'characteristic',
  useCustomRegions: false, customRegions: [],
  walls: [{ id: 'wall-1', x: xw, yTop: 0, yTip: -8, passiveSide: 'right', mechanicalActive: true,
    interfaceRInter: Number(process.env.RINTER || 0.667),
    material: { label: 'RC wall', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
      mechanical: { model: 'rectangular', E: 3e7, nu: 0.2, thickness: 0.5, kappa: 5 / 6, source: 'user' } }, anchors: [] }],
  surfaceLoads: [{ id: 'load-1', xStart: 3, xEnd: xw, q: Number(process.env.Q || 0.2), active: true }],
  deformation: { options: { outOfPlaneLength: 1, loadMode: 'pressure' } }, seepage: null
};
const options = {
  analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 1.2,
  loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 1,
  useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
  residualRelTol: 1e-4, residualAbsTol: 1e-3, displacementRelTol: 1e-4, displacementAbsTol: 1e-6,
  nonlinearMaxIterations: 32, initialLoadStep: 0.25, minLoadStep: 1 / 4096, maxLoadSteps: 384,
  useWasmCpuPipeline: true, useNewGpuPipeline: false,
  useStagedExcavation: process.env.STAGED !== '0',
  useWallInterface: process.env.IF !== '0'
};
const model = buildBishopModelFromStageLayers(layers, uiState);
const r = await analyzeDeformationModel({ model, options });
const s = r?.solver || {};
console.log('RUN', JSON.stringify({
  cut, mode: MODE, staged: options.useStagedExcavation, iface: options.useWallInterface,
  geo: s.initialPhaseConvergenceState, svc: s.servicePhaseConvergenceState,
  lambda: s.loadFactorCommitted, residualNorm: s.residualNorm,
  newton: s.nonlinearIterations, linear: s.linearIterations, tier2: s.tier2 || null
}));
const conv = s.convergence || null;
if (!conv) { console.log('NO CONVERGENCE DIAGNOSTICS'); process.exit(2); }
for (const ph of conv.phases || []) {
  const { alphaMHistory, residualHistory, plaxisErrorHistory, ...rest } = ph;
  console.log('PHASE', JSON.stringify(rest));
  const tail = (a, n) => (a || []).slice(-n).map((x) => Number(x).toExponential(3)).join(' ');
  console.log('  alphaM tail :', tail(alphaMHistory, 12));
  console.log('  resid  tail :', tail(residualHistory, 12));
  console.log('  plaxis tail :', tail(plaxisErrorHistory, 12));
}
if (conv.fixedPointProbe) {
  const p = conv.fixedPointProbe;
  const { residualHistory, alphaMHistory, epsFHistory, marchLambdas, marchIterations, ...rest } = p;
  console.log('PROBE', JSON.stringify(rest));
  const fmt = (a) => (a || []).map((x) => Number(x).toExponential(3));
  const rh = fmt(residualHistory);
  console.log('  resid history (first 10):', rh.slice(0, 10).join(' '));
  console.log('  resid history (last 10) :', rh.slice(-10).join(' '));
  console.log('  alphaM history (last 20):', fmt(alphaMHistory).slice(-20).join(' '));
  console.log('  epsF history (last 10)  :', fmt(epsFHistory).slice(-10).join(' '));
  console.log('  march:', JSON.stringify({ lambdas: marchLambdas, iterations: marchIterations }));
}
console.log('warnings:', JSON.stringify(r?.warnings || []).slice(0, 600));
