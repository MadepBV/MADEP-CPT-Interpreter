// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CPU-reference parity tests for the plastic-pipeline pieces added in
// Steps 1-3 of the full-pipeline plan:
//
//  - strain-to-trial-stress kernel (plastic-trial.js)
//  - commit-state kernel (plastic-trial.js)
//
// Each test runs the JS mirror (cpuRefStrainToTrialStress / cpuRefCommitState)
// against an independent f64 baseline and asserts machine-precision parity.
// =============================================================================

import * as ds from '../src/lib/cpt-app/deformation/gpu/wgsl/ds.js';
import {
  cpuRefStrainToTrialStress,
  cpuRefCommitState
} from '../src/lib/cpt-app/deformation/gpu/wgsl/plastic-trial.js';

const passes = [];
const failures = [];

function check(label, ok, detail = '') {
  (ok ? passes : failures).push({ label, detail });
  process.stdout.write(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function header(t) { process.stdout.write(`\n=== ${t} ===\n`); }

// -----------------------------------------------------------------------------
header('Plastic-trial — degenerates to elastic when σ_committed = 0, ε_committed = 0');
{
  const numGp = 4;
  // Strain ε = (1e-3, 0, 0) at every GP.
  const strain = new Array(3 * numGp);
  for (let gp = 0; gp < numGp; gp += 1) {
    strain[gp * 3 + 0] = ds.dsFromF64(1e-3);
    strain[gp * 3 + 1] = ds.dsFromF64(0);
    strain[gp * 3 + 2] = ds.dsFromF64(0);
  }
  const strainCommitted = new Array(3 * numGp);
  for (let i = 0; i < 3 * numGp; i += 1) strainCommitted[i] = ds.dsFromF64(0);
  const sigmaCommitted = new Array(6 * numGp);
  for (let i = 0; i < 6 * numGp; i += 1) sigmaCommitted[i] = ds.dsFromF64(0);
  // Material: K = 1e5, G = 5e4 (so λ = K - 2G/3 = 1e5 - 33333.33 = 66666.67;
  // λ + 2G = 66666.67 + 1e5 = 166666.67).
  const matIndex = new Uint32Array(numGp).fill(0);
  const matParams = new Array(8);
  matParams[0] = ds.dsFromF64(0); matParams[1] = ds.dsFromF64(1);
  matParams[2] = ds.dsFromF64(0); matParams[3] = ds.dsFromF64(1);
  matParams[4] = ds.dsFromF64(0); matParams[5] = ds.dsFromF64(0);
  matParams[6] = ds.dsFromF64(1e5);
  matParams[7] = ds.dsFromF64(5e4);
  const sigmaTrial = cpuRefStrainToTrialStress({
    strainDs: strain, strainCommittedDs: strainCommitted, sigmaCommittedDs: sigmaCommitted,
    matIndex, matParamsDs: matParams
  });
  // Reference: σxx = (λ+2G) εxx = 166.667; σyy = λ εxx = 66.667; σzz = λ εxx; σxy = 0.
  const expectedSxx = 166.66666666666666;
  const expectedSyy = 66.66666666666666;
  const expectedSzz = 66.66666666666666;
  let maxRelErr = 0;
  for (let gp = 0; gp < numGp; gp += 1) {
    const got_xx = ds.dsToF64(sigmaTrial[gp * 6 + 0]);
    const got_yy = ds.dsToF64(sigmaTrial[gp * 6 + 1]);
    const got_zz = ds.dsToF64(sigmaTrial[gp * 6 + 2]);
    const got_xy = ds.dsToF64(sigmaTrial[gp * 6 + 3]);
    maxRelErr = Math.max(maxRelErr, Math.abs(got_xx - expectedSxx) / expectedSxx);
    maxRelErr = Math.max(maxRelErr, Math.abs(got_yy - expectedSyy) / expectedSyy);
    maxRelErr = Math.max(maxRelErr, Math.abs(got_zz - expectedSzz) / expectedSzz);
    if (Math.abs(got_xy) > 1e-12) { maxRelErr = 1; break; }
  }
  check('elastic-equivalent strain-to-trial yields D_e · ε with rel error < 1e-13',
        maxRelErr < 1e-13, `max rel = ${maxRelErr.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Plastic-trial — δσ adds to σ_committed correctly');
{
  const numGp = 1;
  const strain = [ds.dsFromF64(2e-3), ds.dsFromF64(-1e-3), ds.dsFromF64(0.5e-3)];
  const strainCommitted = [ds.dsFromF64(1e-3), ds.dsFromF64(-0.5e-3), ds.dsFromF64(0)];
  // σ_committed Voigt-6 = (10, 5, 7.5, 1, 0, 0) (arbitrary).
  const sigmaCommitted = [
    ds.dsFromF64(10), ds.dsFromF64(5), ds.dsFromF64(7.5),
    ds.dsFromF64(1),  ds.dsFromF64(0), ds.dsFromF64(0)
  ];
  const matIndex = new Uint32Array([0]);
  const matParams = new Array(8);
  matParams[0] = ds.dsFromF64(0); matParams[1] = ds.dsFromF64(1);
  matParams[2] = ds.dsFromF64(0); matParams[3] = ds.dsFromF64(1);
  matParams[4] = ds.dsFromF64(0); matParams[5] = ds.dsFromF64(0);
  matParams[6] = ds.dsFromF64(1e5); matParams[7] = ds.dsFromF64(5e4);
  const out = cpuRefStrainToTrialStress({
    strainDs: strain, strainCommittedDs: strainCommitted, sigmaCommittedDs: sigmaCommitted,
    matIndex, matParamsDs: matParams
  });
  // Compute δε, δσ on the side.
  const dexx = 2e-3 - 1e-3;
  const deyy = -1e-3 - (-0.5e-3);
  const dgxy = 0.5e-3 - 0;
  const K = 1e5, G = 5e4;
  const lam = K - 2 * G / 3;
  const dsxx = (lam + 2 * G) * dexx + lam * deyy;
  const dsyy = lam * dexx + (lam + 2 * G) * deyy;
  const dsxy = G * dgxy;
  const dszz = lam * (dexx + deyy);
  // σ_trial = σ_committed + δσ.
  const expected = [10 + dsxx, 5 + dsyy, 7.5 + dszz, 1 + dsxy, 0, 0];
  let maxAbs = 0;
  for (let k = 0; k < 6; k += 1) {
    const got = ds.dsToF64(out[k]);
    maxAbs = Math.max(maxAbs, Math.abs(got - expected[k]));
  }
  check('strain-to-trial with σ_committed nonzero matches manual reference',
        maxAbs < 1e-9, `max abs = ${maxAbs.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Commit-state — copies σ_returned → σ_committed and ε → ε_committed');
{
  const numGp = 3;
  const sigmaReturnedDs = new Array(6 * numGp);
  const strainDs = new Array(3 * numGp);
  for (let gp = 0; gp < numGp; gp += 1) {
    for (let k = 0; k < 6; k += 1) sigmaReturnedDs[gp * 6 + k] = ds.dsFromF64(gp * 100 + k);
    for (let k = 0; k < 3; k += 1) strainDs[gp * 3 + k] = ds.dsFromF64((gp + 1) * (k + 1) * 0.001);
  }
  const branchKind = new Uint32Array([1, 5, 10]);
  // Pre-fill committed buffers with garbage to confirm overwrites.
  const sigmaCommittedDs = new Array(6 * numGp).fill(null).map(() => ds.dsFromF64(-999));
  const strainCommittedDs = new Array(3 * numGp).fill(null).map(() => ds.dsFromF64(-999));
  const branchHistory = new Uint32Array(numGp).fill(99);
  cpuRefCommitState({
    sigmaReturnedDs, strainDs, branchKind,
    sigmaCommittedDs, strainCommittedDs, branchHistory
  });
  let okSigma = true, okStrain = true;
  for (let gp = 0; gp < numGp; gp += 1) {
    for (let k = 0; k < 6; k += 1) {
      if (Math.abs(ds.dsToF64(sigmaCommittedDs[gp * 6 + k]) - (gp * 100 + k)) > 1e-12) okSigma = false;
    }
    for (let k = 0; k < 3; k += 1) {
      if (Math.abs(ds.dsToF64(strainCommittedDs[gp * 3 + k]) - (gp + 1) * (k + 1) * 0.001) > 1e-12) okStrain = false;
    }
  }
  check('commit-state writes σ_committed correctly', okSigma);
  check('commit-state writes ε_committed correctly', okStrain);
  check('commit-state writes branchHistory correctly',
        branchHistory[0] === 1 && branchHistory[1] === 5 && branchHistory[2] === 10);
}

// -----------------------------------------------------------------------------
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
