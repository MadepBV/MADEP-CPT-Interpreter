// Stress test for the resident-CG-with-DS path: slope geometry,
// stronger plastic activity, T6. Verifies the DS dot products handle
// ill-conditioned matrices without losing convergence.

import { analyzeDeformationModel } from '../src/lib/cpt-app/deformation/solver.js';

function slopeWithLineLoadModel() {
  return {
    terrain: { vertices: [
      { x: 0, y: 1.5 }, { x: 8, y: 1.5 },
      { x: 24, y: -6.5 }, { x: 35, y: -6.5 }
    ] },
    analysisBottomY: -16.5,
    phreatic: { vertices: [{ x: 0, y: -20 }, { x: 24, y: -20 }] },
    walls: [],
    regions: [{
      id: 'slope-soil', polygon: [
        { x: 0, y: -16.5 }, { x: 35, y: -16.5 }, { x: 35, y: -6.5 },
        { x: 8, y: 1.5 }, { x: 0, y: 1.5 }
      ],
      material: {
        id: 'slope-soil', label: 'slope-soil',
        Emc: 22000, nu: 0.3, K0nc: 0.55,
        cEff: 6, phiEffDeg: 28,
        gamma: 18, gammaSat: 20
      }
    }],
    surfaceLoad: { xStart: 6, xEnd: 8, q: 12 }
  };
}

function options(extra = {}) {
  return {
    meshElementType: 't6',
    meshTargetArea: 0.5,
    loadMode: 'pressure',
    outOfPlaneLength: 10,
    useSeepagePorePressures: false,
    constitutiveModel: 'mc-plastic',
    initialStressMode: 'plastic-geostatic',
    nonlinearMaxIterations: 40,
    maxLoadSteps: 200,
    initialLoadStep: 0.1,
    minLoadStep: 1 / 4096,
    ...extra
  };
}

async function run(label, opts) {
  const t0 = performance.now();
  const out = await analyzeDeformationModel({ model: slopeWithLineLoadModel(), options: opts });
  const ms = performance.now() - t0;
  const s = out?.solver || {};
  const sm = out?.summaries || {};
  return {
    label, ms,
    convergence: s.convergenceState,
    backend: s.linearAlgebraBackend?.name,
    initialPhaseConverged: s.initialPhaseConverged,
    servicePhaseStarted: s.servicePhaseStarted,
    loadFactorCommitted: s.loadFactorCommitted,
    nonlinearIter: s.nonlinearIterations,
    settlement: sm.maxSettlement,
    peakActiveMc: s.peakActiveMcElements
  };
}

console.log('=== Stress test: T6 slope, plastic-geostatic + line load (q=12 kPa) ===\n');

const cases = [
  ['cpu-f64 baseline', options()],
  ['cpu-f32 hybrid',   options({ linearAlgebraBackend: 'cpu-f32' })],
  ['cpu-f32 resident-DS', options({ linearAlgebraBackend: 'cpu-f32', useResidentCg: true })]
];

const results = [];
for (const [label, opts] of cases) {
  const r = await run(label, opts);
  results.push(r);
  console.log(`${r.convergence === 'converged' ? '✓' : '~'} ${label}  ${r.ms.toFixed(0)} ms  (${r.backend})`);
  console.log(`    convergence=${r.convergence}  initialConverged=${r.initialPhaseConverged}  serviceStarted=${r.servicePhaseStarted}  loadCommitted=${r.loadFactorCommitted}`);
  console.log(`    iters=${r.nonlinearIter}  settlement=${(r.settlement || 0).toFixed(4)} m  peakActive=${r.peakActiveMc}`);
}

const baseline = results[0];
let allOk = true;
for (let i = 1; i < results.length; i += 1) {
  const c = results[i];
  if (c.convergence !== baseline.convergence) {
    console.log(`✗ ${c.label}: convergence mismatch (baseline=${baseline.convergence}, candidate=${c.convergence})`);
    allOk = false;
    continue;
  }
  if (Math.abs(c.settlement - baseline.settlement) / Math.max(Math.abs(baseline.settlement), 1e-12) > 5e-2) {
    console.log(`✗ ${c.label}: settlement diverges (baseline=${baseline.settlement}, candidate=${c.settlement})`);
    allOk = false;
  }
}
console.log(`\n=== Overall: ${allOk ? 'STRESS TEST PASSED' : 'FAILURES'} ===`);
process.exit(allOk ? 0 : 1);
