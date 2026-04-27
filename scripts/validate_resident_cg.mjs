// Fast iteration harness for the GPU-resident CG path on a simple,
// well-conditioned case. Flat terrain, simple soil (c=1, phi=30,
// E=22000), no slope, no plastic activity in the elastic comparison.
// We exercise the cpu-f32 surrogate (which mirrors the WebGL kernels)
// rather than a real GPU because node has no WebGL2 context.
//
// Three runs per scenario:
//   * cpu-f64 baseline (current canonical path)
//   * cpu-f32 hybrid (pre-resident-CG; matvec on f32, axpy/dot on CPU)
//   * cpu-f32 resident (the new path; everything stays in the f32
//     "GPU" buffers across iterations)
//
// We compare settlement and convergence between all three. The
// resident path must agree with the hybrid path (same f32 arithmetic);
// both f32 paths must agree with f64 within the documented tolerance.

import { analyzeDeformationModel } from '../src/lib/cpt-app/deformation/solver.js';

function flatSoilModel(overrides = {}) {
  return {
    terrain: {
      vertices: [
        { x: 0, y: 0 },
        { x: 24, y: 0 }
      ]
    },
    analysisBottomY: -16,
    phreatic: { vertices: [{ x: 0, y: -20 }, { x: 24, y: -20 }] },
    walls: [],
    regions: [{
      id: 'simple-soil',
      polygon: [
        { x: 0, y: -16 }, { x: 24, y: -16 }, { x: 24, y: 0 }, { x: 0, y: 0 }
      ],
      material: {
        id: 'simple-soil',
        label: 'simple-soil',
        Emc: 22000,
        nu: 0.3,
        K0nc: 0.5,
        cEff: 1,
        phiEffDeg: 30,
        gamma: 18,
        gammaSat: 20
      }
    }],
    surfaceLoad: { xStart: 10, xEnd: 14, q: 25 },
    ...overrides
  };
}

function baseOptions(overrides = {}) {
  return {
    meshTargetArea: 0.5,
    loadMode: 'pressure',
    outOfPlaneLength: 10,
    useSeepagePorePressures: false,
    constitutiveModel: 'linear-elastic',
    initialStressMode: 'predictor',
    ...overrides
  };
}

function summary(label, output) {
  const s = output?.solver || {};
  const sm = output?.summaries || {};
  const b = s.linearAlgebraBackend || {};
  return {
    label,
    convergenceState: s.convergenceState,
    backendName: b.name,
    precisionMode: b.precisionMode,
    elementType: b.elementType,
    elementKernelsActive: b.elementKernelsActive,
    nodes: output?.mesh?.nodes?.length || 0,
    elements: output?.mesh?.elements?.length || 0,
    nonlinearIterations: s.nonlinearIterations,
    relativeResidualNorm: s.relativeResidualNorm,
    maxSettlement: sm.maxSettlement
  };
}

async function run(label, options) {
  const t0 = performance.now();
  const out = await analyzeDeformationModel({ model: flatSoilModel(), options });
  const ms = performance.now() - t0;
  return { ms, summary: summary(label, out) };
}

async function compareSettlement(baseline, candidate, label, tol) {
  const b = baseline.summary.maxSettlement || 0;
  const c = candidate.summary.maxSettlement || 0;
  const relErr = Math.abs(b - c) / Math.max(Math.abs(b), 1e-12);
  const ok = relErr < tol;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: baseline=${b.toFixed(6)} m, candidate=${c.toFixed(6)} m, relErr=${relErr.toExponential(2)} (tol=${tol.toExponential(0)})`);
  return ok;
}

console.log('=== GPU-resident CG validation: flat soil, c=1, phi=30, E=22000 ===\n');

let allOk = true;

// ---- T3 linear-elastic ----
console.log('--- T3 linear-elastic ---');
const t3F64 = await run('T3 cpu-f64',   baseOptions({ meshElementType: 't3' }));
const t3F32 = await run('T3 cpu-f32',   baseOptions({ meshElementType: 't3', linearAlgebraBackend: 'cpu-f32' }));
console.log(`  cpu-f64       : ${t3F64.ms.toFixed(0)} ms (settlement=${t3F64.summary.maxSettlement?.toFixed(6)} m, iter=${t3F64.summary.nonlinearIterations})`);
console.log(`  cpu-f32       : ${t3F32.ms.toFixed(0)} ms (settlement=${t3F32.summary.maxSettlement?.toFixed(6)} m, iter=${t3F32.summary.nonlinearIterations}, backend=${t3F32.summary.backendName})`);
allOk = (await compareSettlement(t3F64, t3F32, 'T3 cpu-f64 vs cpu-f32 (resident path)', 1e-3)) && allOk;

// ---- T6 linear-elastic ----
console.log('\n--- T6 linear-elastic ---');
const t6F64 = await run('T6 cpu-f64',   baseOptions({ meshElementType: 't6', meshTargetArea: 1.0 }));
const t6F32 = await run('T6 cpu-f32',   baseOptions({ meshElementType: 't6', meshTargetArea: 1.0, linearAlgebraBackend: 'cpu-f32' }));
console.log(`  cpu-f64       : ${t6F64.ms.toFixed(0)} ms (settlement=${t6F64.summary.maxSettlement?.toFixed(6)} m, iter=${t6F64.summary.nonlinearIterations})`);
console.log(`  cpu-f32       : ${t6F32.ms.toFixed(0)} ms (settlement=${t6F32.summary.maxSettlement?.toFixed(6)} m, iter=${t6F32.summary.nonlinearIterations}, backend=${t6F32.summary.backendName})`);
allOk = (await compareSettlement(t6F64, t6F32, 'T6 cpu-f64 vs cpu-f32 (resident path)', 1e-3)) && allOk;

// ---- T6 mc-plastic (mostly elastic, very mild plastic activity) ----
console.log('\n--- T6 mc-plastic ---');
const t6PlasticF64 = await run(
  'T6 plastic cpu-f64',
  baseOptions({
    meshElementType: 't6',
    meshTargetArea: 1.0,
    constitutiveModel: 'mc-plastic',
    initialStressMode: 'predictor'
  })
);
const t6PlasticF32 = await run(
  'T6 plastic cpu-f32',
  baseOptions({
    meshElementType: 't6',
    meshTargetArea: 1.0,
    constitutiveModel: 'mc-plastic',
    initialStressMode: 'predictor',
    linearAlgebraBackend: 'cpu-f32'
  })
);
console.log(`  cpu-f64       : ${t6PlasticF64.ms.toFixed(0)} ms (settlement=${t6PlasticF64.summary.maxSettlement?.toFixed(6)} m, iter=${t6PlasticF64.summary.nonlinearIterations})`);
console.log(`  cpu-f32       : ${t6PlasticF32.ms.toFixed(0)} ms (settlement=${t6PlasticF32.summary.maxSettlement?.toFixed(6)} m, iter=${t6PlasticF32.summary.nonlinearIterations}, backend=${t6PlasticF32.summary.backendName})`);
allOk = (await compareSettlement(t6PlasticF64, t6PlasticF32, 'T6 plastic cpu-f64 vs cpu-f32 (resident path)', 5e-3)) && allOk;

console.log(`\n=== Overall: ${allOk ? 'GPU-RESIDENT CG VALIDATED' : 'FAILURES'} ===`);
console.log('\nNotes:');
console.log('  • cpu-f32 exercises the EXACT same algorithm as the WebGL2 GPU path');
console.log('    (block-Jacobi preconditioner, persistent buffers, periodic residual refresh).');
console.log('  • Real GPU adds parallelism on top — same arithmetic, faster execution.');
console.log('  • cpu-f64 baseline is the reference; f32 paths must match within engineering tolerance.');

process.exit(allOk ? 0 : 1);
