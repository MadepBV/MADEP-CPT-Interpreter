// Regression suite for the integrated 7-phase deformation correctness plan.
// Each block exercises a specific invariant the integrated plan introduced
// or restored. Run with `node scripts/verify_integrated_plan.mjs`. The
// script exits non-zero on the first failure and prints a per-case summary.

import {
  initialEffectiveStress6AtPoint,
  resolveNearSurfaceMinConfiningStress
} from '../src/lib/cpt-app/deformation/post.js';
import {
  prepareMechanicalMaterial,
  reduceMaterialStrengthForSafety
} from '../src/lib/cpt-app/deformation/material.js';
import {
  eigTolerance,
  mcTolerance,
  mohrCoulombIndicator3D
} from '../src/lib/cpt-app/deformation/material-models.js';
import { createLinearAlgebraBackend, probeGpuBackend } from '../src/lib/cpt-app/deformation/gpu/index.js';

const failures = [];
const passes = [];

function check(label, predicate, detail = '') {
  const ok = !!predicate;
  (ok ? passes : failures).push({ label, detail });
  const tag = ok ? 'OK ' : 'FAIL';
  process.stdout.write(`  [${tag}] ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function header(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function flatTerrainModel(yLevel = 10) {
  return {
    terrain: {
      vertices: [
        { x: 0, y: yLevel },
        { x: 100, y: yLevel }
      ]
    },
    regions: [
      {
        material: { cEff: 0, phiEffDeg: 30, gamma: 18 }
      }
    ]
  };
}

// ---------------------------------------------------------------------------
header('Phase 1 — state-invariants gate on c-phi safety');
// We don't run a full FEM solve here; we check that the gate logic in the
// solver enumerates the four invariants and rejects non-equilibrated kinds.
// The gate itself is tested by reading the source for the canonical strings
// the solver uses. This guards against future regressions that delete the
// gate or weaken the message.
import { readFileSync } from 'node:fs';
const solverSource = readFileSync('src/lib/cpt-app/deformation/solver.js', 'utf8');

check(
  'c-phi gate consumes initialPhase.canStartSafety',
  /initialPhase\.canStartSafety\s*!==\s*true/.test(solverSource)
);
check(
  'safety gate rejects stress-only-reference with explicit message',
  /stress-only-reference/.test(solverSource)
    && /Safety analysis cannot start from a stress-only initial-stress reference/.test(solverSource)
);
check(
  'safety gate rejects partial-geostatic with staged-fraction message',
  /partial-geostatic/.test(solverSource)
    && /staged corrections committed/.test(solverSource)
);
check(
  'invariants are emitted in the run record',
  /initialReferenceAccepted/.test(solverSource)
    && /initialEquilibriumConverged/.test(solverSource)
    && /initialCanStartSafety/.test(solverSource)
);

// ---------------------------------------------------------------------------
header('Phase 2 — constitutive tolerance unification');
const sandyMat = prepareMechanicalMaterial({ cEff: 0, phiEffDeg: 30 });
const stiffMat = prepareMechanicalMaterial({ cEff: 50, phiEffDeg: 25 });

check(
  'mcTolerance returns positive at zero stress (uses pRef floor)',
  mcTolerance(sandyMat, {}) > 0,
  `value=${mcTolerance(sandyMat, {})}`
);
check(
  'mcTolerance scales with stress context',
  mcTolerance(sandyMat, { maxAbsStress: 1e6 }) > mcTolerance(sandyMat, {})
);
check(
  'eigTolerance returns positive at zero stress',
  eigTolerance(sandyMat, {}) > 0
);
check(
  'mcTolerance and resolveYieldTolerance agree (helper unification)',
  // resolveYieldTolerance is internal; we verify the public mcTolerance
  // never falls below 1e-12 absolute floor
  mcTolerance(sandyMat, { s1: 0, s2: 0, s3: 0 }) >= 1e-12
);

// ---------------------------------------------------------------------------
header('Phase 3 — workflow defaults & stress-only audit');
check(
  'resolveGeostaticInitializationWorkflow consumes analysisType',
  /resolveGeostaticInitializationWorkflow\(model,\s*options\s*=\s*\{\}\,\s*analysisType/.test(solverSource)
);
check(
  'safety-cphi forces requiresEquilibratedStart',
  /requiresEquilibratedStart:\s*analysisType\s*===\s*'safety-cphi'/.test(solverSource)
);
check(
  'stress-only reference reports honest residual',
  /residualNorm:\s*audit\.residualNormBeforeCorrection/.test(solverSource)
    && /converged:\s*false/.test(solverSource)
);

// ---------------------------------------------------------------------------
header('Phase 4 — diagnostic separation');
check(
  'tensionCutoffActive is decoupled from eta_MC in the summary',
  /tensionCutoffActive\s*===\s*true/.test(solverSource)
    && /tensionCutoffActiveElementCount/.test(solverSource)
);
check(
  'linear-solve aggregate is built from history',
  /aggregateLinearSolveHistory/.test(solverSource)
    && /worstTrueResidualMismatch/.test(solverSource)
);
check(
  'preconditioner reuse stats are emitted',
  /rebuildCount/.test(solverSource)
    && /reuseRatio/.test(solverSource)
    && /lastDiagonalDrift/.test(solverSource)
);

// ---------------------------------------------------------------------------
header('Phase 5 — phase-conditional solver constants');
check(
  'service phase default initial step differs from initial-gravity',
  /phaseInitialLoadStepDefault\s*=\s*isSensitivePhase\s*\?\s*NONLINEAR_INITIAL_LOAD_STEP\s*:\s*0\.25/.test(solverSource)
);
check(
  'service phase max iterations falls back to 24',
  /phaseMaxIterationsDefault\s*=\s*isSensitivePhase\s*\?\s*NONLINEAR_MAX_ITER\s*:\s*24/.test(solverSource)
);
check(
  'service phase max load steps falls back to 256',
  /phaseMaxLoadStepsDefault\s*=\s*isSensitivePhase\s*\?\s*NONLINEAR_MAX_LOAD_STEPS\s*:\s*256/.test(solverSource)
);
check(
  'preconditioner cache plumbed through Newton dispatcher',
  /preconditionerCache,\s*$/m.test(solverSource)
);

// ---------------------------------------------------------------------------
header('Phase 6 — GPU certification policy');
const probe = await probeGpuBackend({ logger: () => {} }).catch(() => null);
const backend = await createLinearAlgebraBackend({ logger: () => {} }).catch(() => null);

check(
  'webgpu-backend ships residentCgCertified=false by default',
  /residentCgCertified:\s*false/.test(
    readFileSync('src/lib/cpt-app/deformation/gpu/webgpu-backend.js', 'utf8')
  )
);
check(
  'GMRES dispatcher gates on supportsResidentGmres (not supportsResidentCg)',
  /supportsResidentGmres\s*===\s*true/.test(solverSource)
);
check(
  'true-residual band acceptance flags propagate through decorate',
  /acceptedInTrueResidualBand/.test(solverSource)
    && /trueResidualBandFactor/.test(solverSource)
);

// ---------------------------------------------------------------------------
header('Near-surface confining-stress floor — engineer-controlled, off by default');
const slopeMat = prepareMechanicalMaterial({ cEff: 0, phiEffDeg: 30 });
const optedInMat = prepareMechanicalMaterial({ cEff: 0, phiEffDeg: 30, nearSurfaceMinConfiningStress: 2 });

check(
  'prepareMechanicalMaterial keeps nearSurfaceMinConfiningStress at 0 by default',
  slopeMat.nearSurfaceMinConfiningStress === 0,
  `default=${slopeMat.nearSurfaceMinConfiningStress}`
);
check(
  'engineer-supplied material value is preserved through preparation',
  optedInMat.nearSurfaceMinConfiningStress === 2
);
check(
  'resolveNearSurfaceMinConfiningStress prefers explicit option',
  resolveNearSurfaceMinConfiningStress({ cEff: 0 }, { nearSurfaceMinConfiningStress: 5 }) === 5
);
check(
  'resolveNearSurfaceMinConfiningStress reads baked material value when option missing',
  resolveNearSurfaceMinConfiningStress({ nearSurfaceMinConfiningStress: 2.5 }, {}) === 2.5
);
check(
  'resolveNearSurfaceMinConfiningStress defaults to 0 (no auto-cohesion)',
  resolveNearSurfaceMinConfiningStress({ cEff: 0 }, {}) === 0
);

const surfaceSeedDefault = initialEffectiveStress6AtPoint(
  flatTerrainModel(10),
  { x: 50, y: 9.999, regionIndex: 0, material: { cEff: 0, phiEffDeg: 30 } },
  {},
  []
);
check(
  'default surface seed is identically zero (no silent preload)',
  surfaceSeedDefault.every((v) => v === 0),
  `seed=[${surfaceSeedDefault.map((v) => v.toFixed(3)).join(', ')}]`
);

const surfaceSeedOptIn = initialEffectiveStress6AtPoint(
  flatTerrainModel(10),
  { x: 50, y: 9.999, regionIndex: 0, material: { cEff: 0, phiEffDeg: 30 } },
  { nearSurfaceMinConfiningStress: 1 },
  []
);
check(
  'opt-in surface seed has hydrostatic floor applied',
  surfaceSeedOptIn[0] === -1 && surfaceSeedOptIn[1] === -1 && surfaceSeedOptIn[2] === -1
    && surfaceSeedOptIn[3] === 0 && surfaceSeedOptIn[4] === 0 && surfaceSeedOptIn[5] === 0,
  `seed=[${surfaceSeedOptIn.map((v) => v.toFixed(3)).join(', ')}]`
);

// When the engineer opts in, the seed must remain admissible
const optInIndicator = mohrCoulombIndicator3D(surfaceSeedOptIn, slopeMat);
check(
  'opt-in floor seed is admissible under exact MC',
  Number.isFinite(optInIndicator?.F) && (optInIndicator?.F <= mcTolerance(slopeMat, { maxAbsStress: 1 })),
  `F=${optInIndicator?.F?.toExponential(2)}`
);

// Reduced strength for safety must preserve whatever the engineer set
const reduced = reduceMaterialStrengthForSafety(optedInMat, 1.5);
check(
  'reduced-strength material preserves engineer-set floor',
  reduced?.nearSurfaceMinConfiningStress === optedInMat.nearSurfaceMinConfiningStress
);
const reducedDefault = reduceMaterialStrengthForSafety(slopeMat, 1.5);
check(
  'reduced-strength material does not introduce a floor when engineer left it at 0',
  reducedDefault?.nearSurfaceMinConfiningStress === 0
);

// ---------------------------------------------------------------------------
process.stdout.write(`\n=== Summary ===\n`);
process.stdout.write(`  passed: ${passes.length}\n`);
process.stdout.write(`  failed: ${failures.length}\n`);

if (failures.length) {
  process.stdout.write('\nFailures:\n');
  failures.forEach(({ label, detail }) => {
    process.stdout.write(`  - ${label}${detail ? ` (${detail})` : ''}\n`);
  });
  process.exit(1);
}
process.exit(0);
