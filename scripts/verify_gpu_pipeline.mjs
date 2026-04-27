// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification suite for the new GPU resident DS pipeline.
// ============================================================================
//
// This is the CPU-side parity harness.  Each phase's CPU reference is
// exercised against an independent f64 baseline to confirm the algorithm
// is mathematically correct.  The device-bound (real GPU) parity tests
// require WebGPU hardware and live behind a `--gpu` flag (not enabled in
// CI yet because the pipeline is mid-rebuild).

import * as ds from '../src/lib/cpt-app/deformation/gpu/wgsl/ds.js';
import * as buf from '../src/lib/cpt-app/deformation/gpu/resident-buffers.js';
import * as blas from '../src/lib/cpt-app/deformation/gpu/wgsl/blas.js';
import * as elements from '../src/lib/cpt-app/deformation/gpu/wgsl/elements.js';
import * as cg from '../src/lib/cpt-app/deformation/gpu/resident-cg.js';
import * as gmres from '../src/lib/cpt-app/deformation/gpu/resident-gmres.js';
import * as mc from '../src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js';
import * as geo from '../src/lib/cpt-app/deformation/gpu/resident-geostatic.js';
import * as t3 from '../src/lib/cpt-app/deformation/element-t3.js';

const passes = [];
const failures = [];

function check(label, predicate, detail = '') {
  const ok = !!predicate;
  (ok ? passes : failures).push({ label, detail });
  process.stdout.write(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function header(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

// -----------------------------------------------------------------------------
header('Phase 1 — DS primitives parity vs f64');
{
  let maxAdd = 0, maxMul = 0, maxDiv = 0, maxSqrt = 0;
  for (let i = 0; i < 5000; i += 1) {
    const a = (Math.random() - 0.5) * Math.pow(10, (Math.random() - 0.5) * 8);
    const b = (Math.random() - 0.5) * Math.pow(10, (Math.random() - 0.5) * 8);
    const da = ds.dsFromF64(a), db = ds.dsFromF64(b);
    const addExp = a + b;     const addGot = ds.dsToF64(ds.dsAdd(da, db));
    const mulExp = a * b;     const mulGot = ds.dsToF64(ds.dsMul(da, db));
    if (Math.abs(addExp) > 0) maxAdd = Math.max(maxAdd, Math.abs(addGot - addExp) / Math.abs(addExp));
    if (Math.abs(mulExp) > 0) maxMul = Math.max(maxMul, Math.abs(mulGot - mulExp) / Math.abs(mulExp));
    if (Math.abs(b) > 1e-30) {
      const divExp = a / b;   const divGot = ds.dsToF64(ds.dsDiv(da, db));
      if (Math.abs(divExp) > 0) maxDiv = Math.max(maxDiv, Math.abs(divGot - divExp) / Math.abs(divExp));
    }
    if (a > 1e-30) {
      const sqrtExp = Math.sqrt(a);
      const sqrtGot = ds.dsToF64(ds.dsSqrt(ds.dsFromF64(a)));
      if (sqrtExp > 0) maxSqrt = Math.max(maxSqrt, Math.abs(sqrtGot - sqrtExp) / sqrtExp);
    }
  }
  check('dsAdd max relative error < 1e-12', maxAdd < 1e-12, `got ${maxAdd.toExponential(2)}`);
  check('dsMul max relative error < 1e-13', maxMul < 1e-13, `got ${maxMul.toExponential(2)}`);
  check('dsDiv max relative error < 1e-13', maxDiv < 1e-13, `got ${maxDiv.toExponential(2)}`);
  check('dsSqrt max relative error < 1e-13', maxSqrt < 1e-13, `got ${maxSqrt.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Phase 2 — Buffer pack/unpack parity');
{
  const v = new Float64Array([1.234e5, -7.89e-7, 0, 1, -1, 1e10, 1e-10]);
  const round = buf.unpackDsVector(buf.packDsVector(v));
  let maxRoundErr = 0;
  for (let i = 0; i < v.length; i += 1) {
    const denom = Math.max(Math.abs(v[i]), 1e-300);
    maxRoundErr = Math.max(maxRoundErr, Math.abs(round[i] - v[i]) / denom);
  }
  check('vector pack→unpack relative error < 1e-14', maxRoundErr < 1e-14, `got ${maxRoundErr.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Phase 3 — DS BLAS kernel parity');
{
  const N = 100;
  const a = new Float64Array(N);
  const b = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    a[i] = (Math.random() - 0.5) * 1e3;
    b[i] = (Math.random() - 0.5) * 1e3;
  }
  // AXPY (alpha=0.5).
  const yRef = new Float64Array(N);
  for (let i = 0; i < N; i += 1) yRef[i] = 0.5 * a[i] + b[i];
  const xDs = blas.liftF64(a);
  const yDs = blas.liftF64(b);
  blas.cpuRefAxpy(ds.dsFromF64(0.5), xDs, yDs);
  const yGot = blas.lowerDs(yDs);
  let maxAxpy = 0;
  for (let i = 0; i < N; i += 1) {
    const denom = Math.max(Math.abs(yRef[i]), 1);
    maxAxpy = Math.max(maxAxpy, Math.abs(yGot[i] - yRef[i]) / denom);
  }
  check('AXPY max relative error < 1e-13', maxAxpy < 1e-13, `got ${maxAxpy.toExponential(2)}`);

  // DOT.
  let dotRef = 0;
  for (let i = 0; i < N; i += 1) dotRef += a[i] * b[i];
  const dotDs = blas.cpuRefDot(blas.liftF64(a), blas.liftF64(b));
  const dotGot = ds.dsToF64(dotDs);
  const dotErr = Math.abs(dotGot - dotRef) / Math.max(Math.abs(dotRef), 1);
  check('DOT relative error < 1e-13', dotErr < 1e-13, `got ${dotErr.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Phase 4 — Resident CG (CPU reference)');
{
  // Symmetric positive-definite tridiagonal Laplacian, solve to ones.
  const N = 32;
  const rows = [];
  for (let i = 0; i < N; i += 1) {
    const ind = [];
    const val = [];
    if (i > 0) { ind.push(i - 1); val.push(-1); }
    ind.push(i); val.push(2.5);
    if (i < N - 1) { ind.push(i + 1); val.push(-1); }
    rows.push({ indices: new Int32Array(ind), values: new Float64Array(val), diag: 2.5 });
  }
  const csr = buf.packDsCsr(rows);
  const numNodes = N / 2;
  const blocks = [];
  for (let n = 0; n < numNodes; n += 1) {
    blocks.push(ds.dsFromF64(1 / 2.5), ds.dsFromF64(0), ds.dsFromF64(0), ds.dsFromF64(1 / 2.5));
  }
  const xTrue = new Float64Array(N).fill(1);
  const bTrue = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    let s = 0;
    for (let k = 0; k < rows[i].indices.length; k += 1) s += rows[i].values[k] * xTrue[rows[i].indices[k]];
    bTrue[i] = s;
  }
  const result = cg.cpuReferenceResidentCg({
    csr, blockJacobiDs: blocks, bF64: bTrue, maxIter: 200, relTol: 1e-12, absTol: 1e-15
  });
  check('CG converges within 100 iters on 32-DOF Laplacian', result.iterations <= 100 && result.converged, `iters=${result.iterations}`);
  let maxSolErr = 0;
  for (let i = 0; i < N; i += 1) maxSolErr = Math.max(maxSolErr, Math.abs(result.solution[i] - 1));
  check('CG solution error < 1e-12', maxSolErr < 1e-12, `got ${maxSolErr.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Phase 5 — Resident GMRES (CPU reference)');
{
  // Mildly unsymmetric tridiagonal.
  const N = 30;
  const rows = [];
  for (let i = 0; i < N; i += 1) {
    const ind = [];
    const val = [];
    if (i > 0) { ind.push(i - 1); val.push(-1.5); }
    ind.push(i); val.push(3);
    if (i < N - 1) { ind.push(i + 1); val.push(-0.7); }
    rows.push({ indices: new Int32Array(ind), values: new Float64Array(val), diag: 3 });
  }
  const csr = buf.packDsCsr(rows);
  const numNodes = N / 2;
  const blocks = [];
  for (let n = 0; n < numNodes; n += 1) {
    blocks.push(ds.dsFromF64(1 / 3), ds.dsFromF64(0), ds.dsFromF64(0), ds.dsFromF64(1 / 3));
  }
  const xTrue = new Float64Array(N);
  for (let i = 0; i < N; i += 1) xTrue[i] = Math.sin(i * 0.3);
  const bTrue = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    let s = 0;
    for (let k = 0; k < rows[i].indices.length; k += 1) s += rows[i].values[k] * xTrue[rows[i].indices[k]];
    bTrue[i] = s;
  }
  const result = gmres.cpuReferenceResidentGmres({
    csr, blockJacobiDs: blocks, bF64: bTrue, maxIter: 300, relTol: 1e-12, absTol: 1e-15, restart: 30
  });
  check('GMRES converges within 100 iters on 30-DOF unsymmetric system', result.iterations <= 100 && result.converged, `iters=${result.iterations}`);
  let maxSolErr = 0;
  for (let i = 0; i < N; i += 1) maxSolErr = Math.max(maxSolErr, Math.abs(result.solution[i] - xTrue[i]));
  check('GMRES solution error < 1e-10', maxSolErr < 1e-10, `got ${maxSolErr.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Phase 6 — Element kernels parity vs CPU T3');
{
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  const Bcpu = t3.buildBMatrixT3(corners);
  const numLocalDofs = 6;
  const gpsPerElem = 1;
  const STRAIN_DIM = 3;
  const numElements = 1;
  const bMatrices = new Array(STRAIN_DIM * numLocalDofs);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 6; c += 1) {
      const v = Bcpu[r][c];
      bMatrices[r * numLocalDofs + c] = ds.dsFromF64(v);
    }
  }
  const dofMap = new Int32Array([0, 1, 2, 3, 4, 5]);
  const uF64 = new Float64Array([0.001, 0, 0.003, 0, 0.001, 0.002]);
  const uvec = blas.liftF64(uF64);
  const strain = elements.cpuRefElementStrain({ uvec, bMatrices, dofMap, numElements, gpsPerElem, numLocalDofs });
  const exx = ds.dsToF64(strain[0]);
  const eyy = ds.dsToF64(strain[1]);
  const gxy = ds.dsToF64(strain[2]);
  let exxRef = 0, eyyRef = 0, gxyRef = 0;
  for (let c = 0; c < 6; c += 1) {
    exxRef += Bcpu[0][c] * uF64[c];
    eyyRef += Bcpu[1][c] * uF64[c];
    gxyRef += Bcpu[2][c] * uF64[c];
  }
  const maxErr = Math.max(Math.abs(exx - exxRef), Math.abs(eyy - eyyRef), Math.abs(gxy - gxyRef));
  check('T3 element strain matches CPU baseline at machine precision', maxErr < 1e-15, `got ${maxErr.toExponential(2)}`);
}

// -----------------------------------------------------------------------------
header('Phase 7 — MC return mapping');
{
  const regimes = [
    { name: 'associated, no tension',         phi: 30, psi: 30, c: 5,  sigT: 0 },
    { name: 'non-associated 30/15, no tens',  phi: 30, psi: 15, c: 5,  sigT: 0 },
    { name: 'non-associated 30/0, no tens',   phi: 30, psi: 0,  c: 5,  sigT: 0 },
    { name: 'tension cutoff 30/15, sigT=2',   phi: 30, psi: 15, c: 5,  sigT: 2 },
    { name: 'high friction 45/20, c=10',      phi: 45, psi: 20, c: 10, sigT: 0 },
    { name: 'low friction 15/5, c=20',        phi: 15, psi: 5,  c: 20, sigT: 0 },
    { name: 'tension cutoff 28/10, sigT=5',   phi: 28, psi: 10, c: 8,  sigT: 5 }
  ];
  let totalOk = 0, totalTrials = 0;
  for (const regime of regimes) {
    const params = {
      sinPhi: Math.sin(regime.phi * Math.PI / 180),
      cosPhi: Math.cos(regime.phi * Math.PI / 180),
      sinPsi: Math.sin(regime.psi * Math.PI / 180),
      cosPsi: Math.cos(regime.psi * Math.PI / 180),
      cohesion: regime.c, tensionLimit: regime.sigT,
      KBulk: 1e5, G: 5e4
    };
    let regimeOk = 0, regimeTotal = 200;
    for (let i = 0; i < regimeTotal; i += 1) {
      const p = (Math.random() - 0.5) * 200;
      const sxx = p + (Math.random() - 0.5) * 100;
      const syy = p + (Math.random() - 0.5) * 100;
      const szz = p + (Math.random() - 0.5) * 100;
      const sxy = (Math.random() - 0.5) * 50;
      const r = mc.cpuMcReturnMapping({ sigmaTrial: [sxx, syy, szz, sxy, 0, 0], params });
      if (!r.converged) continue;
      const ret = r.sigmaReturned.map(v => v[0] + v[1]);
      const center = (ret[0] + ret[1]) / 2;
      const halfDiff = (ret[0] - ret[1]) / 2;
      const R = Math.sqrt(halfDiff * halfDiff + ret[3] * ret[3]);
      const principal = [center + R, center - R, ret[2]].sort((a, b) => b - a);
      const F13 = (principal[0] - principal[2]) - (principal[0] + principal[2]) * params.sinPhi - 2 * params.cohesion * params.cosPhi;
      const F12 = (principal[0] - principal[1]) - (principal[0] + principal[1]) * params.sinPhi - 2 * params.cohesion * params.cosPhi;
      const F23 = (principal[1] - principal[2]) - (principal[1] + principal[2]) * params.sinPhi - 2 * params.cohesion * params.cosPhi;
      const T3 = -principal[2] - params.tensionLimit;
      const stressScale = Math.max(Math.abs(p) + 100, 100);
      const tol = 1e-5 * stressScale;
      if (F12 <= tol && F13 <= tol && F23 <= tol && T3 <= tol) regimeOk += 1;
    }
    totalOk += regimeOk;
    totalTrials += regimeTotal;
    check(`MC regime "${regime.name}" — 200 random trials all admissible`, regimeOk === regimeTotal,
          `${regimeOk}/${regimeTotal}`);
  }
  check(`MC dispatcher — 1400/1400 random trials produce admissible state`, totalOk === totalTrials,
        `${totalOk}/${totalTrials}`);

  // Specific branch sanity checks.
  const baseParams = {
    sinPhi: Math.sin(30 * Math.PI / 180), cosPhi: Math.cos(30 * Math.PI / 180),
    sinPsi: Math.sin(15 * Math.PI / 180), cosPsi: Math.cos(15 * Math.PI / 180),
    cohesion: 5, tensionLimit: 100, KBulk: 1e5, G: 5e4
  };
  const elasticTrial = mc.cpuMcReturnMapping({ sigmaTrial: [50, 50, 50, 0, 0, 0], params: baseParams });
  check('Hydrostatic compression in admissible region returns ELASTIC',
        elasticTrial.converged && elasticTrial.branchKind === mc.MC_BRANCH.ELASTIC);

  const faceTrial = mc.cpuMcReturnMapping({ sigmaTrial: [200, 50, 50, 0, 0, 0], params: baseParams });
  check('Trial above F13 with σ2=σ3 hits EDGE_S23_EQUAL',
        faceTrial.converged && faceTrial.branchKind === mc.MC_BRANCH.EDGE_S23_EQUAL,
        `branch=${faceTrial.branchKind}`);

  const tensionParams = { ...baseParams, tensionLimit: 0 };
  const tensionTrial = mc.cpuMcReturnMapping({ sigmaTrial: [-30, -30, -30, 0, 0, 0], params: tensionParams });
  check('All-tensile trial with no cap returns to TENSION_APEX_T123',
        tensionTrial.converged && tensionTrial.branchKind === mc.MC_BRANCH.TENSION_APEX_T123,
        `branch=${tensionTrial.branchKind}`);
}

// -----------------------------------------------------------------------------
header('Phase 9 — K0 stress recovery parity');
{
  const numGp = 5;
  const region = { K0: ds.dsFromF64(0.5), E: ds.dsFromF64(2e4), nu: ds.dsFromF64(0.3), gamma: ds.dsFromF64(18) };
  // Build trial strains representing a downward gravity displacement field
  // at a few depths.  εyy = -γ z / E_eff_plane_strain (tension-positive in
  // standard FE convention).
  const strain = new Array(3 * numGp);
  const regionId = new Array(numGp).fill(0);
  const porePressure = new Array(numGp).fill(ds.dsFromF64(0));
  for (let gp = 0; gp < numGp; gp += 1) {
    strain[gp * 3 + 0] = ds.dsFromF64(0);             // εxx = 0
    strain[gp * 3 + 1] = ds.dsFromF64(-(gp + 1) * 1e-4); // εyy negative
    strain[gp * 3 + 2] = ds.dsFromF64(0);             // γxy = 0
  }
  const sigma = geo.cpuRefK0Recovery({
    strainPerGp: strain, regionId, regions: [region], porePressure
  });
  // Verify K0 contract: σh / σv = K0.
  let maxRatioErr = 0;
  for (let gp = 0; gp < numGp; gp += 1) {
    const sxx = ds.dsToF64(sigma[gp * 6 + 0]);
    const syy = ds.dsToF64(sigma[gp * 6 + 1]);
    if (Math.abs(syy) > 1e-12) {
      const ratio = sxx / syy;
      maxRatioErr = Math.max(maxRatioErr, Math.abs(ratio - 0.5));
    }
  }
  check('K0 recovery σh/σv = K0 at every GP', maxRatioErr < 1e-12, `got ${maxRatioErr.toExponential(2)}`);
  // Verify σxy = 0 (slope shear discarded by design).
  let maxShear = 0;
  for (let gp = 0; gp < numGp; gp += 1) maxShear = Math.max(maxShear, Math.abs(ds.dsToF64(sigma[gp * 6 + 3])));
  check('K0 recovery τ = 0 by construction', maxShear < 1e-15, `got ${maxShear.toExponential(2)}`);
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
