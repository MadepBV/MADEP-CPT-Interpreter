// Replicate the user's reported case in node: flat terrain, weak soil
// (E=22400, c=1, phi=30, gamma=17), 5 kPa strip load over 2m. Verify
// it converges on cpu-f64, cpu-f32 (= GPU code path surrogate), and
// the cpu-f32 path with the resident CG opt-in. The cpu-f64 path is
// the canonical reference — it must converge cleanly on this case.

import { analyzeDeformationModel } from '../src/lib/cpt-app/deformation/solver.js';

function userCase() {
  return {
    terrain: { vertices: [{ x: 0, y: 0 }, { x: 24, y: 0 }] },
    analysisBottomY: -16,
    phreatic: { vertices: [{ x: 0, y: -20 }, { x: 24, y: -20 }] },
    walls: [],
    regions: [{
      id: 'soil', polygon: [
        { x: 0, y: -16 }, { x: 24, y: -16 }, { x: 24, y: 0 }, { x: 0, y: 0 }
      ],
      material: {
        id: 'soil', label: 'soil',
        Emc: 22400, nu: 0.3, K0nc: 0.5,
        cEff: 1, phiEffDeg: 30, gamma: 17, gammaSat: 19
      }
    }],
    surfaceLoad: { xStart: 11, xEnd: 13, q: 5 }
  };
}

function options(extra = {}) {
  return {
    meshTargetArea: 0.5,
    loadMode: 'pressure',
    outOfPlaneLength: 10,
    useSeepagePorePressures: false,
    constitutiveModel: 'mc-plastic',
    initialStressMode: 'predictor',
    ...extra
  };
}

async function run(label, opts) {
  const t0 = performance.now();
  const out = await analyzeDeformationModel({ model: userCase(), options: opts });
  const ms = performance.now() - t0;
  const s = out?.solver || {};
  const sm = out?.summaries || {};
  return {
    label, ms,
    convergenceState: s.convergenceState,
    backend: s.linearAlgebraBackend?.name,
    initialPhaseConverged: s.initialPhaseConverged,
    servicePhaseStarted: s.servicePhaseStarted,
    loadFactorCommitted: s.loadFactorCommitted,
    nonlinearIterations: s.nonlinearIterations,
    maxSettlement: sm.maxSettlement,
    peakActiveMcElements: s.peakActiveMcElements,
    warningCount: (out?.warnings || []).length
  };
}

console.log('=== User-reported case: flat soil, c=1, phi=30, E=22400, q=5 kPa over 2 m ===\n');

const cases = [
  ['cpu-f64',           options()],
  ['cpu-f32 hybrid',    options({ linearAlgebraBackend: 'cpu-f32' })],
  ['cpu-f32 resident',  options({ linearAlgebraBackend: 'cpu-f32', useResidentCg: true })]
];

let allOk = true;
for (const [label, opts] of cases) {
  const r = await run(label, opts);
  const ok = r.convergenceState === 'converged' && r.loadFactorCommitted === 1;
  if (!ok) allOk = false;
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  console.log(`    duration=${r.ms.toFixed(0)} ms  backend=${r.backend}`);
  console.log(`    convergenceState=${r.convergenceState}  initialPhaseConverged=${r.initialPhaseConverged}  servicePhaseStarted=${r.servicePhaseStarted}`);
  console.log(`    loadFactorCommitted=${r.loadFactorCommitted}  nonlinearIter=${r.nonlinearIterations}  peakActiveMc=${r.peakActiveMcElements}`);
  console.log(`    maxSettlement=${(r.maxSettlement || 0).toFixed(6)} m  warnings=${r.warningCount}`);
}

console.log(`\n=== Overall: ${allOk ? 'USER CASE OK' : 'FAILURES — needs attention'} ===`);
process.exit(allOk ? 0 : 1);
