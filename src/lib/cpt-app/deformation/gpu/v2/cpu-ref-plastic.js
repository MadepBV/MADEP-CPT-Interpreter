// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// CPU references for v2's plastic Newton flow.
// =============================================================================
//
// Modified Newton with elastic tangent (matrix-free) + Mohr-Coulomb local
// return mapping at each Gauss point.  Reuses v1's verified `cpuMcReturnMapping`
// for the constitutive update, so v2's plasticity correctness inherits v1's.
//
// Single-step plastic Newton:
//
//   u = u₀, σ_committed = σ_initial
//   for newton_iter = 0..maxNewton:
//     ε_trial[gp]   = B[gp] · u
//     σ_trial[gp]   = σ_committed[gp] + D_e · Δε[gp]    (Δε = ε_trial - ε_committed)
//     σ_new[gp]     = MC return mapping(σ_trial[gp], params)
//     F_int[free]   = scatter(∑_e Bᵀ σ_new)
//     r             = b − F_int
//     if ‖r‖ < tol: σ_committed = σ_new;  break
//     du            = matrix-free linear solve(K_e, r)   ← elastic stiffness
//     u            += du
//
// For modified Newton the tangent stays elastic across all linear solves.
// For the first call we assume σ_committed equals σ_initial and ε_committed
// is "all zero" (i.e. ε_committed corresponds to the reference configuration
// at u = u₀).  Δε then reduces to B · (u - u₀).

import { dsAdd, dsMul, dsSub, dsFromF64, dsToF64 } from '../wgsl/ds.js';
import { cpuMcReturnMapping } from '../wgsl/mc-plastic.js';
import { packDsVector, unpackDsVector } from '../resident-buffers.js';
import {
  cpuRefMfPcg, cpuRefMfBicgstab,
  cpuRefMfApplyJacobi, cpuRefMfApplyBlockJacobi,
  cpuRefMfKx
} from './cpu-ref-mf.js';

function dsAt(packed, i) { return [packed[2 * i], packed[2 * i + 1]]; }
function dsWrite(packed, i, ds) { packed[2 * i] = ds[0]; packed[2 * i + 1] = ds[1]; }

// -----------------------------------------------------------------------------
// Compute ε at every GP via ε = B · u (Voigt 3-vector per GP).
// Returns a Float64Array of length 3 * numGp.
// -----------------------------------------------------------------------------
export function cpuRefMfElementStrain({
  uF64, bMatricesDsPacked, dofMap, freeDofs,
  numElements, gpsPerElem, numLocalDofs, numGp
}) {
  const STRAIN_DIM = 3;
  const eps = new Float64Array(numGp * STRAIN_DIM);
  for (let e = 0; e < numElements; e += 1) {
    // Gather element u (in full free-DOF index space).  Constrained DOFs → 0.
    const u_e = new Array(numLocalDofs);
    for (let d = 0; d < numLocalDofs; d += 1) {
      const free = dofMap[e * numLocalDofs + d];
      u_e[d] = free < 0 ? 0 : uF64[free];
    }
    for (let g = 0; g < gpsPerElem; g += 1) {
      const gp = e * gpsPerElem + g;
      const bBase = e * gpsPerElem * STRAIN_DIM * numLocalDofs + g * STRAIN_DIM * numLocalDofs;
      let exx = 0, eyy = 0, gxy = 0;
      for (let d = 0; d < numLocalDofs; d += 1) {
        const b_xx = packed64(bMatricesDsPacked, bBase + 0 * numLocalDofs + d);
        const b_yy = packed64(bMatricesDsPacked, bBase + 1 * numLocalDofs + d);
        const b_xy = packed64(bMatricesDsPacked, bBase + 2 * numLocalDofs + d);
        exx += b_xx * u_e[d];
        eyy += b_yy * u_e[d];
        gxy += b_xy * u_e[d];
      }
      eps[gp * 3 + 0] = exx;
      eps[gp * 3 + 1] = eyy;
      eps[gp * 3 + 2] = gxy;
    }
  }
  return eps;
}

function packed64(packed, i) { return packed[2 * i] + packed[2 * i + 1]; }

// -----------------------------------------------------------------------------
// Build elastic trial stress at every GP.
//
//   σ_trial[gp] (Voigt-6) =  σ_committed[gp]  +  D_e[gp] · Δε[gp]
//
// Δε comes in as a length-3 vector per GP (εxx, εyy, γxy).  D_e is the elastic
// tangent built from KBulk and G of the GP's material.
//
// Returns a Voigt-6 stress per GP as Float64Array(numGp * 6).
// -----------------------------------------------------------------------------
export function cpuRefBuildTrialStress({
  sigmaCommittedF64, deltaEpsF64, matParamsPacked, matIndex, numGp
}) {
  const out = new Float64Array(numGp * 6);
  for (let gp = 0; gp < numGp; gp += 1) {
    const matIdx = matIndex[gp] >>> 0;
    const KBulk = packed64(matParamsPacked, matIdx * 8 + 6);
    const G     = packed64(matParamsPacked, matIdx * 8 + 7);
    const lambda = KBulk - (2 / 3) * G;
    const exx = deltaEpsF64[gp * 3 + 0];
    const eyy = deltaEpsF64[gp * 3 + 1];
    const gxy = deltaEpsF64[gp * 3 + 2];   // engineering shear
    // σ_e = D · ε
    const dSigXX = (lambda + 2 * G) * exx + lambda * eyy;
    const dSigYY = lambda * exx + (lambda + 2 * G) * eyy;
    const dSigZZ = lambda * (exx + eyy);    // plane-strain out-of-plane
    const dSigXY = G * gxy;                  // since γxy = 2 εxy
    out[gp * 6 + 0] = sigmaCommittedF64[gp * 6 + 0] + dSigXX;
    out[gp * 6 + 1] = sigmaCommittedF64[gp * 6 + 1] + dSigYY;
    out[gp * 6 + 2] = sigmaCommittedF64[gp * 6 + 2] + dSigZZ;
    out[gp * 6 + 3] = sigmaCommittedF64[gp * 6 + 3] + dSigXY;
    out[gp * 6 + 4] = sigmaCommittedF64[gp * 6 + 4];   // σ_yz = 0 in plane strain
    out[gp * 6 + 5] = sigmaCommittedF64[gp * 6 + 5];   // σ_xz = 0
  }
  return out;
}

// -----------------------------------------------------------------------------
// Apply MC return mapping at every GP.  Returns σ_new (Voigt-6 per GP),
// branchKind (Uint32Array), and a per-GP "plastic" flag.
// -----------------------------------------------------------------------------
export function cpuRefBatchReturnMapping({
  sigmaTrialF64, matParamsPacked, matIndex, numGp
}) {
  const out = new Float64Array(numGp * 6);
  const branchKind = new Uint32Array(numGp);
  const plasticFlag = new Uint8Array(numGp);
  for (let gp = 0; gp < numGp; gp += 1) {
    const matIdx = matIndex[gp] >>> 0;
    const matBase = matIdx * 8;
    const params = {
      sinPhi:       packed64(matParamsPacked, matBase + 0),
      cosPhi:       packed64(matParamsPacked, matBase + 1),
      sinPsi:       packed64(matParamsPacked, matBase + 2),
      cosPsi:       packed64(matParamsPacked, matBase + 3),
      cohesion:     packed64(matParamsPacked, matBase + 4),
      tensionLimit: packed64(matParamsPacked, matBase + 5),
      KBulk:        packed64(matParamsPacked, matBase + 6),
      G:            packed64(matParamsPacked, matBase + 7)
    };
    // The MC math runs in compression-positive convention; the rest of the
    // pipeline uses tension-positive.  Negate on entry and on exit.  This
    // mirrors the GPU kernel's `dsNeg(sigmaTrial[…])` and
    // `dsNeg(voigt[…])` at the boundary.
    const sigmaTrial = [
      -sigmaTrialF64[gp * 6 + 0], -sigmaTrialF64[gp * 6 + 1], -sigmaTrialF64[gp * 6 + 2],
      -sigmaTrialF64[gp * 6 + 3], -sigmaTrialF64[gp * 6 + 4], -sigmaTrialF64[gp * 6 + 5]
    ];
    const r = cpuMcReturnMapping({ sigmaTrial, params });
    if (!r.converged) {
      for (let k = 0; k < 6; k += 1) out[gp * 6 + k] = sigmaTrialF64[gp * 6 + k];
      branchKind[gp] = 0xFFFFFFFF;
      plasticFlag[gp] = 0;
      continue;
    }
    branchKind[gp] = r.branchKind | 0;
    plasticFlag[gp] = r.branchKind === 0 ? 0 : 1;  // 0 = ELASTIC
    for (let k = 0; k < 6; k += 1) {
      const v = dsToF64(Array.isArray(r.sigmaReturned[k]) ? r.sigmaReturned[k] : dsFromF64(r.sigmaReturned[k]));
      out[gp * 6 + k] = -v;        // negate back to tension-positive
    }
  }
  return { sigmaNewF64: out, branchKind, plasticFlag };
}

// -----------------------------------------------------------------------------
// Internal force per element + scatter to free DOFs.
// F_int = ∑_e Bᵀ σ_new (using only the in-plane components σxx, σyy, σxy).
// Mirrors v1's KERNEL_INTERNAL_FORCE_T3/T6_WGSL.
// -----------------------------------------------------------------------------
export function cpuRefInternalForce({
  sigmaNewF64, bMatricesDsPacked, gpWeightsDsPacked,
  forceIncPtr, forceIncList,
  numElements, gpsPerElem, numLocalDofs, numFree
}) {
  const STRAIN_DIM = 3;
  // Element-level scatter scratch: numElements * numLocalDofs DS values.
  const elemScatter = new Float32Array(2 * numElements * numLocalDofs);
  for (let e = 0; e < numElements; e += 1) {
    const bBaseElem = e * gpsPerElem * STRAIN_DIM * numLocalDofs;
    const wBaseElem = e * gpsPerElem;
    const f_e = new Array(numLocalDofs);
    for (let d = 0; d < numLocalDofs; d += 1) f_e[d] = [0, 0];
    for (let g = 0; g < gpsPerElem; g += 1) {
      const bBase = bBaseElem + g * STRAIN_DIM * numLocalDofs;
      const wDet = dsAt(gpWeightsDsPacked, wBaseElem + g);
      const gp = e * gpsPerElem + g;
      // Only in-plane stress components feed the 2-D B matrix.
      const sxx = dsFromF64(sigmaNewF64[gp * 6 + 0]);
      const syy = dsFromF64(sigmaNewF64[gp * 6 + 1]);
      const sxy = dsFromF64(sigmaNewF64[gp * 6 + 3]);
      const wxx = dsMul(wDet, sxx);
      const wyy = dsMul(wDet, syy);
      const wxy = dsMul(wDet, sxy);
      for (let d = 0; d < numLocalDofs; d += 1) {
        const b_xx = dsAt(bMatricesDsPacked, bBase + 0 * numLocalDofs + d);
        const b_yy = dsAt(bMatricesDsPacked, bBase + 1 * numLocalDofs + d);
        const b_xy = dsAt(bMatricesDsPacked, bBase + 2 * numLocalDofs + d);
        const term = dsAdd(dsAdd(dsMul(b_xx, wxx), dsMul(b_yy, wyy)), dsMul(b_xy, wxy));
        f_e[d] = dsAdd(f_e[d], term);
      }
    }
    for (let d = 0; d < numLocalDofs; d += 1) {
      dsWrite(elemScatter, e * numLocalDofs + d, f_e[d]);
    }
  }
  // Scatter to free DOFs.
  const out = new Float32Array(2 * numFree);
  for (let i = 0; i < numFree; i += 1) {
    const begin = forceIncPtr[i];
    const end = forceIncPtr[i + 1];
    let acc = [0, 0];
    for (let k = begin; k < end; k += 1) {
      acc = dsAdd(acc, dsAt(elemScatter, forceIncList[k]));
    }
    dsWrite(out, i, acc);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Modified Newton driver — single load step (b held constant).
//
// Inputs:
//   pack                 — from buildGpuMeshPack(...)
//   sigmaInitialF64      — initial committed stress at every GP (Voigt-6)
//   bF64                 — load (free-DOF length)
//   u0F64                — initial displacement guess (free-DOF length)
//   dPerGpDsPacked       — elastic D per GP (DS-packed, 6 DS per GP)
//   linearSolver         — function(rPacked) → { xDsPacked, iterations, residualNorm, converged }
//   options              — { maxNewton, residTol, residRelTol }
//
// Output: { uF64, sigmaNewF64, branchKind, iterations, residualNorms }
// -----------------------------------------------------------------------------
export function cpuRefPlasticNewton({
  pack, sigmaInitialF64, bF64, u0F64 = null, dPerGpDsPacked,
  linearSolver,                       // (rPacked) => { xDsPacked, ... }
  options = { maxNewton: 50, residTol: 1e-9, residRelTol: 1e-9 }
}) {
  const numFree = pack.numFree;
  const numElements = pack.numElements;
  const numGp = pack.numGp;
  const numLocalDofs = pack.numLocalDofs;
  const gpsPerElem = numGp / numElements;
  const u = u0F64 ? new Float64Array(u0F64) : new Float64Array(numFree);
  const sigmaCommitted = new Float64Array(sigmaInitialF64);
  const sigmaNew = new Float64Array(sigmaInitialF64);
  const residualNorms = [];
  let lastBranchKind = null;
  let bNorm = 0;
  for (let i = 0; i < numFree; i += 1) bNorm += bF64[i] * bF64[i];
  bNorm = Math.sqrt(bNorm);
  const targetTol = Math.max(options.residTol, options.residRelTol * bNorm);

  for (let iter = 0; iter < options.maxNewton; iter += 1) {
    // 1. ε_trial = B u ; Δε = ε_trial - 0 (committed reference is u=u₀; for
    //    monotonic load step starting from u₀, Δε = B(u - u₀) which equals
    //    B·u - B·u₀.  We treat u₀ as the committed reference so Δε = B·(u-u₀).
    const uMinusU0 = new Float64Array(numFree);
    if (u0F64) {
      for (let i = 0; i < numFree; i += 1) uMinusU0[i] = u[i] - u0F64[i];
    } else {
      for (let i = 0; i < numFree; i += 1) uMinusU0[i] = u[i];
    }
    const deltaEps = cpuRefMfElementStrain({
      uF64: uMinusU0,
      bMatricesDsPacked: pack.bMatricesPacked,
      dofMap: pack.dofMap,
      freeDofs: pack.freeDofs,
      numElements, gpsPerElem, numLocalDofs, numGp
    });
    // 2. σ_trial = σ_committed + D_e · Δε
    const sigmaTrial = cpuRefBuildTrialStress({
      sigmaCommittedF64: sigmaCommitted,
      deltaEpsF64: deltaEps,
      matParamsPacked: pack.matParamsPacked,
      matIndex: pack.matIndex,
      numGp
    });
    // 3. σ_new = MC return mapping(σ_trial)
    const rm = cpuRefBatchReturnMapping({
      sigmaTrialF64: sigmaTrial,
      matParamsPacked: pack.matParamsPacked,
      matIndex: pack.matIndex,
      numGp
    });
    for (let k = 0; k < numGp * 6; k += 1) sigmaNew[k] = rm.sigmaNewF64[k];
    lastBranchKind = rm.branchKind;
    // 4. F_int = scatter(∑_e Bᵀ σ_new)
    const fIntPacked = cpuRefInternalForce({
      sigmaNewF64: sigmaNew,
      bMatricesDsPacked: pack.bMatricesPacked,
      gpWeightsDsPacked: pack.gpWeightsPacked,
      forceIncPtr: pack.forceIncPtr,
      forceIncList: pack.forceIncList,
      numElements, gpsPerElem, numLocalDofs, numFree
    });
    // 5. r = b − F_int  (DS subtraction)
    const rPacked = new Float32Array(2 * numFree);
    const bPacked = packDsVector(bF64);
    for (let i = 0; i < numFree; i += 1) {
      const bi = dsAt(bPacked, i);
      const fi = dsAt(fIntPacked, i);
      dsWrite(rPacked, i, dsSub(bi, fi));
    }
    let resNorm = 0;
    for (let i = 0; i < numFree; i += 1) {
      const ri = dsAt(rPacked, i);
      const v = ri[0] + ri[1];
      resNorm += v * v;
    }
    resNorm = Math.sqrt(resNorm);
    residualNorms.push(resNorm);
    if (options.debug && iter < 5) {
      let uNorm = 0; for (const v of u) uNorm += v * v;
      let fNorm = 0;
      for (let i = 0; i < numFree; i += 1) {
        const v = fIntPacked[2*i] + fIntPacked[2*i+1];
        fNorm += v * v;
      }
      let plasticCount = 0;
      for (let gp = 0; gp < numGp; gp += 1) if (rm.branchKind[gp] !== 0) plasticCount += 1;
      process.stdout.write(`    [debug iter ${iter}] |u|=${Math.sqrt(uNorm).toExponential(2)} |Fint|=${Math.sqrt(fNorm).toExponential(2)} |r|=${resNorm.toExponential(2)} plastic=${plasticCount}/${numGp}\n`);
    }
    if (resNorm <= targetTol) {
      for (let k = 0; k < numGp * 6; k += 1) sigmaCommitted[k] = sigmaNew[k];
      return { uF64: u, sigmaNewF64: sigmaCommitted, branchKind: lastBranchKind,
               iterations: iter + 1, residualNorms, converged: true };
    }
    // 6. Solve K_e · du = r   (linear solver provided by caller)
    const linRes = linearSolver(rPacked);
    if (!linRes.converged) {
      return { uF64: u, sigmaNewF64: sigmaNew, branchKind: lastBranchKind,
               iterations: iter + 1, residualNorms, converged: false,
               reason: `linear solver did not converge at Newton iter ${iter}` };
    }
    // 7. u += du
    const duF64 = unpackDsVector(linRes.xDsPacked);
    for (let i = 0; i < numFree; i += 1) u[i] += duF64[i];
  }
  return { uF64: u, sigmaNewF64: sigmaNew, branchKind: lastBranchKind,
           iterations: options.maxNewton, residualNorms, converged: false,
           reason: 'max Newton iterations reached' };
}
