// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// CPU references for v2's matrix-free kernels.
// =============================================================================
//
// These functions mirror the WGSL kernels in `wgsl-v2/` exactly, using DS
// arithmetic on plain arrays.  They serve two purposes:
//
//   1. Algorithmic validation: a tiny synthetic mesh can be solved with both
//      v1 (explicit CSR) and v2 (matrix-free) CPU paths; their answers must
//      agree to within DS precision.  This validates the v2 algorithm
//      without requiring a GPU.
//   2. Parity oracle for the GPU side: when WebGPU runs, its output should
//      match these CPU references bit-for-bit (as long as the WGSL kernel
//      semantics match the CPU mirror).  Same pattern as v1's
//      `cpuReferenceResidentCg`.
//
// Inputs are DS-packed (Float32Array of (hi, lo) pairs) — the same pack
// produced by `gpu-mesh-pack.js`.

import { dsAdd, dsMul, dsRecip, dsSub, dsFromF64, dsToF64 } from '../wgsl/ds.js';

// -----------------------------------------------------------------------------
// Read DS from a packed Float32Array at logical index i.
// -----------------------------------------------------------------------------
function dsAt(packed, i) {
  return [packed[2 * i], packed[2 * i + 1]];
}
function dsWrite(packed, i, ds) {
  packed[2 * i] = ds[0];
  packed[2 * i + 1] = ds[1];
}

// -----------------------------------------------------------------------------
// Build the per-GP elastic D pack (DS-packed Float32Array of length 6*numGp).
// Mirrors `wgsl-v2/mf-elastic-d.js`.
//
//   λ  = K - (2/3) G
//   D11 = D22 = λ + 2G       D12 = λ
//   D33 = G                   D13 = D23 = 0
// -----------------------------------------------------------------------------
export function cpuRefBuildElasticDPerGp({ matParamsPacked, matIndex, numGp }) {
  const out = new Float32Array(6 * 2 * numGp);
  const TWO_THIRDS = dsFromF64(2 / 3);
  const TWO        = dsFromF64(2);
  const ZERO       = [0, 0];
  for (let gp = 0; gp < numGp; gp += 1) {
    const matIdx = matIndex[gp] >>> 0;
    // matParamsPacked layout: 8 DS per material, slot 6 = K, slot 7 = G
    const K = dsAt(matParamsPacked, matIdx * 8 + 6);
    const G = dsAt(matParamsPacked, matIdx * 8 + 7);
    const twoThirdG = dsMul(TWO_THIRDS, G);
    const lambda = dsSub(K, twoThirdG);
    const twoG = dsMul(TWO, G);
    const lamPlus2G = dsAdd(lambda, twoG);
    const base = gp * 6;
    dsWrite(out, base + 0, lamPlus2G);  // D11
    dsWrite(out, base + 1, lambda);      // D12
    dsWrite(out, base + 2, ZERO);        // D13
    dsWrite(out, base + 3, lamPlus2G);   // D22
    dsWrite(out, base + 4, ZERO);        // D23
    dsWrite(out, base + 5, G);           // D33
  }
  return out;
}

// -----------------------------------------------------------------------------
// Matrix-free Kx (element scatter step).  Mirrors `wgsl-v2/mf-kx-element.js`.
//
// Inputs (all DS-packed Float32Arrays except dofMap which is Int32):
//   uDsPacked  — global free-DOF u (length 2*numFree)
//   bMatricesDsPacked — per-element B (length 2*numElements*gpsPerElem*3*numLocalDofs)
//   gpWeightsDsPacked — w·|J| per GP (length 2*numElements*gpsPerElem)
//   dPerGpDsPacked    — D per GP (length 2*numElements*gpsPerElem*6)
//   dofMap            — Int32Array (length numElements*numLocalDofs), -1 for constrained
//
// Output: kxOutDsPacked (length 2*numElements*numLocalDofs)
// -----------------------------------------------------------------------------
export function cpuRefMfKxElement({
  uDsPacked, bMatricesDsPacked, gpWeightsDsPacked, dPerGpDsPacked, dofMap,
  numElements, gpsPerElem, numLocalDofs
}) {
  const STRAIN_DIM = 3;
  const D_PACK = 6;
  const out = new Float32Array(2 * numElements * numLocalDofs);
  for (let e = 0; e < numElements; e += 1) {
    const bBaseElem = e * gpsPerElem * STRAIN_DIM * numLocalDofs;
    const dBaseElem = e * gpsPerElem * D_PACK;
    const wBaseElem = e * gpsPerElem;
    const dofBase = e * numLocalDofs;
    const outBase = e * numLocalDofs;

    // Gather u_e
    const u_e = new Array(numLocalDofs);
    for (let d = 0; d < numLocalDofs; d += 1) {
      const dofIdx = dofMap[dofBase + d];
      u_e[d] = dofIdx < 0 ? [0, 0] : dsAt(uDsPacked, dofIdx);
    }
    // Element accumulator
    const ke_u = new Array(numLocalDofs);
    for (let d = 0; d < numLocalDofs; d += 1) ke_u[d] = [0, 0];

    for (let g = 0; g < gpsPerElem; g += 1) {
      const bBase = bBaseElem + g * STRAIN_DIM * numLocalDofs;
      const dBase = dBaseElem + g * D_PACK;
      const wDet = dsAt(gpWeightsDsPacked, wBaseElem + g);
      // Strain = B u_e
      let eps_xx = [0, 0], eps_yy = [0, 0], eps_xy = [0, 0];
      for (let d = 0; d < numLocalDofs; d += 1) {
        const b_xx = dsAt(bMatricesDsPacked, bBase + 0 * numLocalDofs + d);
        const b_yy = dsAt(bMatricesDsPacked, bBase + 1 * numLocalDofs + d);
        const b_xy = dsAt(bMatricesDsPacked, bBase + 2 * numLocalDofs + d);
        eps_xx = dsAdd(eps_xx, dsMul(b_xx, u_e[d]));
        eps_yy = dsAdd(eps_yy, dsMul(b_yy, u_e[d]));
        eps_xy = dsAdd(eps_xy, dsMul(b_xy, u_e[d]));
      }
      // Stress = D ε
      const D11 = dsAt(dPerGpDsPacked, dBase + 0);
      const D12 = dsAt(dPerGpDsPacked, dBase + 1);
      const D13 = dsAt(dPerGpDsPacked, dBase + 2);
      const D22 = dsAt(dPerGpDsPacked, dBase + 3);
      const D23 = dsAt(dPerGpDsPacked, dBase + 4);
      const D33 = dsAt(dPerGpDsPacked, dBase + 5);
      const s_xx = dsAdd(dsAdd(dsMul(D11, eps_xx), dsMul(D12, eps_yy)), dsMul(D13, eps_xy));
      const s_yy = dsAdd(dsAdd(dsMul(D12, eps_xx), dsMul(D22, eps_yy)), dsMul(D23, eps_xy));
      const s_xy = dsAdd(dsAdd(dsMul(D13, eps_xx), dsMul(D23, eps_yy)), dsMul(D33, eps_xy));
      // ke_u_d += w|J| (B^T σ)_d
      const sigma_xx = dsMul(wDet, s_xx);
      const sigma_yy = dsMul(wDet, s_yy);
      const sigma_xy = dsMul(wDet, s_xy);
      for (let d = 0; d < numLocalDofs; d += 1) {
        const b_xx = dsAt(bMatricesDsPacked, bBase + 0 * numLocalDofs + d);
        const b_yy = dsAt(bMatricesDsPacked, bBase + 1 * numLocalDofs + d);
        const b_xy = dsAt(bMatricesDsPacked, bBase + 2 * numLocalDofs + d);
        const term = dsAdd(dsAdd(dsMul(b_xx, sigma_xx), dsMul(b_yy, sigma_yy)),
                           dsMul(b_xy, sigma_xy));
        ke_u[d] = dsAdd(ke_u[d], term);
      }
    }
    for (let d = 0; d < numLocalDofs; d += 1) {
      dsWrite(out, outBase + d, ke_u[d]);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Scatter element output → global free-DOF vector via incidence list.
// Mirrors v1's KERNEL_SCATTER_FREE_RHS_WGSL.  rhsFree[i] = sum of
// elemScatter[forceIncList[k]] for k in [forceIncPtr[i], forceIncPtr[i+1]).
// -----------------------------------------------------------------------------
export function cpuRefMfScatterToFreeDofs({
  elemScatterDsPacked, forceIncPtr, forceIncList, numFree
}) {
  const out = new Float32Array(2 * numFree);
  for (let i = 0; i < numFree; i += 1) {
    const begin = forceIncPtr[i];
    const end = forceIncPtr[i + 1];
    let acc = [0, 0];
    for (let k = begin; k < end; k += 1) {
      acc = dsAdd(acc, dsAt(elemScatterDsPacked, forceIncList[k]));
    }
    dsWrite(out, i, acc);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Full matrix-free K·x:  combines element + scatter.  Convenience wrapper.
// -----------------------------------------------------------------------------
export function cpuRefMfKx({
  uDsPacked, bMatricesDsPacked, gpWeightsDsPacked, dPerGpDsPacked, dofMap,
  forceIncPtr, forceIncList,
  numElements, gpsPerElem, numLocalDofs, numFree
}) {
  const elemScatter = cpuRefMfKxElement({
    uDsPacked, bMatricesDsPacked, gpWeightsDsPacked, dPerGpDsPacked, dofMap,
    numElements, gpsPerElem, numLocalDofs
  });
  return cpuRefMfScatterToFreeDofs({
    elemScatterDsPacked: elemScatter, forceIncPtr, forceIncList, numFree
  });
}

// -----------------------------------------------------------------------------
// Matrix-free diag(K) extraction.  Mirrors `wgsl-v2/mf-jacobi-diag.js`.
// -----------------------------------------------------------------------------
export function cpuRefMfDiagElement({
  bMatricesDsPacked, gpWeightsDsPacked, dPerGpDsPacked,
  numElements, gpsPerElem, numLocalDofs
}) {
  const STRAIN_DIM = 3;
  const D_PACK = 6;
  const TWO = dsFromF64(2);
  const out = new Float32Array(2 * numElements * numLocalDofs);
  for (let e = 0; e < numElements; e += 1) {
    const bBaseElem = e * gpsPerElem * STRAIN_DIM * numLocalDofs;
    const dBaseElem = e * gpsPerElem * D_PACK;
    const wBaseElem = e * gpsPerElem;
    const outBase = e * numLocalDofs;
    const diag_e = new Array(numLocalDofs);
    for (let d = 0; d < numLocalDofs; d += 1) diag_e[d] = [0, 0];

    for (let g = 0; g < gpsPerElem; g += 1) {
      const bBase = bBaseElem + g * STRAIN_DIM * numLocalDofs;
      const dBase = dBaseElem + g * D_PACK;
      const wDet = dsAt(gpWeightsDsPacked, wBaseElem + g);
      const D11 = dsAt(dPerGpDsPacked, dBase + 0);
      const D12 = dsAt(dPerGpDsPacked, dBase + 1);
      const D13 = dsAt(dPerGpDsPacked, dBase + 2);
      const D22 = dsAt(dPerGpDsPacked, dBase + 3);
      const D23 = dsAt(dPerGpDsPacked, dBase + 4);
      const D33 = dsAt(dPerGpDsPacked, dBase + 5);
      for (let d = 0; d < numLocalDofs; d += 1) {
        const b_xx = dsAt(bMatricesDsPacked, bBase + 0 * numLocalDofs + d);
        const b_yy = dsAt(bMatricesDsPacked, bBase + 1 * numLocalDofs + d);
        const b_xy = dsAt(bMatricesDsPacked, bBase + 2 * numLocalDofs + d);
        const t11 = dsMul(dsMul(b_xx, b_xx), D11);
        const t22 = dsMul(dsMul(b_yy, b_yy), D22);
        const t33 = dsMul(dsMul(b_xy, b_xy), D33);
        const t12 = dsMul(dsMul(b_xx, b_yy), D12);
        const t13 = dsMul(dsMul(b_xx, b_xy), D13);
        const t23 = dsMul(dsMul(b_yy, b_xy), D23);
        const cross = dsMul(TWO, dsAdd(dsAdd(t12, t13), t23));
        const dd = dsAdd(dsAdd(dsAdd(t11, t22), t33), cross);
        diag_e[d] = dsAdd(diag_e[d], dsMul(wDet, dd));
      }
    }
    for (let d = 0; d < numLocalDofs; d += 1) {
      dsWrite(out, outBase + d, diag_e[d]);
    }
  }
  return out;
}

export function cpuRefMfDiag({
  bMatricesDsPacked, gpWeightsDsPacked, dPerGpDsPacked,
  forceIncPtr, forceIncList,
  numElements, gpsPerElem, numLocalDofs, numFree
}) {
  const elemScatter = cpuRefMfDiagElement({
    bMatricesDsPacked, gpWeightsDsPacked, dPerGpDsPacked,
    numElements, gpsPerElem, numLocalDofs
  });
  return cpuRefMfScatterToFreeDofs({
    elemScatterDsPacked: elemScatter, forceIncPtr, forceIncList, numFree
  });
}

// -----------------------------------------------------------------------------
// Apply Jacobi: z = mInv .* r  (elementwise DS multiply).
// -----------------------------------------------------------------------------
export function cpuRefMfApplyJacobi({ mInvDsPacked, rDsPacked }) {
  const n = mInvDsPacked.length >> 1;
  const out = new Float32Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const mi = dsAt(mInvDsPacked, i);
    const ri = dsAt(rDsPacked, i);
    dsWrite(out, i, dsMul(mi, ri));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Reciprocal: mInv = 1 / diag  (with near-zero guard, mirrors WGSL recip).
// -----------------------------------------------------------------------------
export function cpuRefMfRecip({ diagDsPacked }) {
  const n = diagDsPacked.length >> 1;
  const out = new Float32Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const d = dsAt(diagDsPacked, i);
    const dF64 = d[0] + d[1];
    if (Math.abs(dF64) < 1e-30) {
      dsWrite(out, i, [1, 0]);
    } else {
      dsWrite(out, i, dsRecip(d));
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Matrix-free preconditioned CG (CPU reference).
// Mirrors the GPU controller's CG flow; uses DS arithmetic on packed buffers.
//
// Inputs:
//   matvec(xPacked) → yPacked   (matrix-free K·x)
//   applyM(rPacked) → zPacked   (preconditioner: e.g. z = M^{-1}·r)
//   bDsPacked                    (RHS, DS-packed)
//   x0DsPacked                   (initial guess, may be null = zeros)
//   maxIter, relTol, absTol
//
// Output: { xDsPacked, iterations, residualNorm, converged }
// -----------------------------------------------------------------------------
export function cpuRefMfPcg({ matvec, applyM, bDsPacked, x0DsPacked = null, maxIter = 5000, relTol = 1e-10, absTol = 1e-12 }) {
  const n = bDsPacked.length >> 1;
  const x = x0DsPacked ? new Float32Array(x0DsPacked) : new Float32Array(2 * n);
  // r = b - A x.  If x = 0, r = b.
  let r;
  if (x0DsPacked && Array.from(x0DsPacked).some((v) => v !== 0)) {
    const Ax = matvec(x);
    r = new Float32Array(2 * n);
    for (let i = 0; i < n; i += 1) {
      const di = dsSub(dsAt(bDsPacked, i), dsAt(Ax, i));
      dsWrite(r, i, di);
    }
  } else {
    r = new Float32Array(bDsPacked);
  }
  let z = applyM(r);
  let p = new Float32Array(z);
  let rz = vecDot(r, z);
  const rhsNorm = Math.sqrt(Math.max(vecDot(bDsPacked, bDsPacked), 0));
  const targetTol = Math.max(absTol, relTol * rhsNorm);
  let residualNorm = Math.sqrt(Math.max(vecDot(r, r), 0));
  let converged = residualNorm <= targetTol;
  let iter = 0;
  for (iter = 1; iter <= maxIter && !converged; iter += 1) {
    const Ap = matvec(p);
    const pAp = vecDot(p, Ap);
    if (!Number.isFinite(pAp) || Math.abs(pAp) < 1e-300) break;
    const alpha = rz / pAp;
    vecAxpy(dsFromF64(alpha), p, x);
    vecAxpy(dsFromF64(-alpha), Ap, r);
    if (iter % 25 === 0) {
      const Ax = matvec(x);
      for (let i = 0; i < n; i += 1) {
        const di = dsSub(dsAt(bDsPacked, i), dsAt(Ax, i));
        dsWrite(r, i, di);
      }
    }
    residualNorm = Math.sqrt(Math.max(vecDot(r, r), 0));
    if (residualNorm <= targetTol) { converged = true; break; }
    z = applyM(r);
    const rzNew = vecDot(r, z);
    const beta = Math.abs(rz) > 1e-300 ? rzNew / rz : 0;
    vecAxpby(dsFromF64(1), z, dsFromF64(beta), p);
    rz = rzNew;
  }
  return { xDsPacked: x, iterations: iter, residualNorm, converged };
}

// -----------------------------------------------------------------------------
// Matrix-free preconditioned BiCGStab (van der Vorst 1992).
// Mirrors the GPU controller's BiCGStab flow; uses DS arithmetic.
// Used for non-symmetric tangents (non-associated MC plasticity).
//
// Algorithm:
//   r₀ = b - A x₀;  r̂₀ = r₀
//   ρ₀ = α₀ = ω₀ = 1;   v₀ = p₀ = 0
//   for i = 1, 2, …:
//     ρᵢ = <r̂₀, rᵢ₋₁>
//     β  = (ρᵢ/ρᵢ₋₁) · (αᵢ₋₁/ωᵢ₋₁)
//     pᵢ = rᵢ₋₁ + β (pᵢ₋₁ - ωᵢ₋₁ vᵢ₋₁)
//     y  = M⁻¹ pᵢ;     vᵢ = A y
//     αᵢ = ρᵢ / <r̂₀, vᵢ>
//     s  = rᵢ₋₁ - αᵢ vᵢ
//     ‖s‖ check → if small: x = xᵢ₋₁ + αᵢ y; converge
//     z  = M⁻¹ s;       t = A z
//     ωᵢ = <t, s> / <t, t>
//     xᵢ = xᵢ₋₁ + αᵢ y + ωᵢ z
//     rᵢ = s - ωᵢ t
// -----------------------------------------------------------------------------
export function cpuRefMfBicgstab({ matvec, applyM, bDsPacked, x0DsPacked = null, maxIter = 5000, relTol = 1e-10, absTol = 1e-12 }) {
  const n = bDsPacked.length >> 1;
  const x = x0DsPacked ? new Float32Array(x0DsPacked) : new Float32Array(2 * n);
  let r;
  if (x0DsPacked && Array.from(x0DsPacked).some((v) => v !== 0)) {
    const Ax = matvec(x);
    r = new Float32Array(2 * n);
    for (let i = 0; i < n; i += 1) {
      dsWrite(r, i, dsSub(dsAt(bDsPacked, i), dsAt(Ax, i)));
    }
  } else {
    r = new Float32Array(bDsPacked);
  }
  const rhat = new Float32Array(r);                  // shadow residual
  let p = new Float32Array(2 * n);                   // p₀ = 0
  let v = new Float32Array(2 * n);                   // v₀ = 0
  let rho = 1, alpha = 1, omega = 1;
  const rhsNorm = Math.sqrt(Math.max(vecDot(bDsPacked, bDsPacked), 0));
  const targetTol = Math.max(absTol, relTol * rhsNorm);
  let residualNorm = Math.sqrt(Math.max(vecDot(r, r), 0));
  let converged = residualNorm <= targetTol;
  let iter = 0;
  for (iter = 1; iter <= maxIter && !converged; iter += 1) {
    const rhoNew = vecDot(rhat, r);
    if (!Number.isFinite(rhoNew) || Math.abs(rhoNew) < 1e-300) break;
    const beta = (rhoNew / rho) * (alpha / omega);
    rho = rhoNew;
    // p = r + β (p - ω v)
    for (let i = 0; i < n; i += 1) {
      const ri = dsAt(r, i);
      const pi = dsAt(p, i);
      const vi = dsAt(v, i);
      const inner = dsSub(pi, dsMul(dsFromF64(omega), vi));
      const pNew = dsAdd(ri, dsMul(dsFromF64(beta), inner));
      dsWrite(p, i, pNew);
    }
    const y = applyM(p);
    v = matvec(y);
    const rhatV = vecDot(rhat, v);
    if (!Number.isFinite(rhatV) || Math.abs(rhatV) < 1e-300) break;
    alpha = rho / rhatV;
    // s = r - α v
    const s = new Float32Array(2 * n);
    for (let i = 0; i < n; i += 1) {
      const ri = dsAt(r, i);
      const vi = dsAt(v, i);
      dsWrite(s, i, dsSub(ri, dsMul(dsFromF64(alpha), vi)));
    }
    const sNorm = Math.sqrt(Math.max(vecDot(s, s), 0));
    if (sNorm <= targetTol) {
      // x += α y
      for (let i = 0; i < n; i += 1) {
        dsWrite(x, i, dsAdd(dsAt(x, i), dsMul(dsFromF64(alpha), dsAt(y, i))));
      }
      residualNorm = sNorm;
      converged = true;
      break;
    }
    const z = applyM(s);
    const t = matvec(z);
    const tt = vecDot(t, t);
    const ts = vecDot(t, s);
    if (!Number.isFinite(tt) || tt < 1e-300) break;
    omega = ts / tt;
    // x += α y + ω z
    // r  = s - ω t
    for (let i = 0; i < n; i += 1) {
      const xi = dsAt(x, i);
      const yi = dsAt(y, i);
      const zi = dsAt(z, i);
      const newX = dsAdd(xi, dsAdd(dsMul(dsFromF64(alpha), yi), dsMul(dsFromF64(omega), zi)));
      dsWrite(x, i, newX);
      const si = dsAt(s, i);
      const ti = dsAt(t, i);
      dsWrite(r, i, dsSub(si, dsMul(dsFromF64(omega), ti)));
    }
    residualNorm = Math.sqrt(Math.max(vecDot(r, r), 0));
    if (residualNorm <= targetTol) { converged = true; break; }
  }
  return { xDsPacked: x, iterations: iter, residualNorm, converged };
}

// -----------------------------------------------------------------------------
// Helpers: DS dot, axpy, axpby on packed Float32Array DS vectors.
// -----------------------------------------------------------------------------
function vecDot(aPacked, bPacked) {
  const n = aPacked.length >> 1;
  let acc = [0, 0];
  for (let i = 0; i < n; i += 1) {
    acc = dsAdd(acc, dsMul(dsAt(aPacked, i), dsAt(bPacked, i)));
  }
  return dsToF64(acc);
}
function vecAxpy(alphaDs, xPacked, yPacked) {
  const n = xPacked.length >> 1;
  for (let i = 0; i < n; i += 1) {
    const xi = dsAt(xPacked, i);
    const yi = dsAt(yPacked, i);
    dsWrite(yPacked, i, dsAdd(yi, dsMul(alphaDs, xi)));
  }
}
function vecAxpby(alphaDs, xPacked, betaDs, yPacked) {
  const n = xPacked.length >> 1;
  for (let i = 0; i < n; i += 1) {
    const xi = dsAt(xPacked, i);
    const yi = dsAt(yPacked, i);
    dsWrite(yPacked, i, dsAdd(dsMul(alphaDs, xi), dsMul(betaDs, yi)));
  }
}

// -----------------------------------------------------------------------------
// Build a 2×2 nodal block-Jacobi preconditioner pack from the matrix-free
// pipeline.  For each free DOF pair (2n, 2n+1) belonging to the same node,
// we need the 2×2 K block.  Matrix-free extraction:
//
//   K_block[2n, 2n]   = e_{2n} · K · e_{2n}     (already in diag(K))
//   K_block[2n+1,2n+1]= e_{2n+1} · K · e_{2n+1} (already in diag(K))
//   K_block[2n, 2n+1] = e_{2n} · K · e_{2n+1}
//   K_block[2n+1,2n]  = e_{2n+1} · K · e_{2n}   (= [2n,2n+1] for symmetric K)
//
// Strategy: for each "active node pair" (both 2n and 2n+1 are free DOFs),
// run two extra matvecs with e_{2n} and e_{2n+1} to fill in the off-diag
// entries.  This is a one-shot cost at preconditioner build (typically 2 ×
// numNodes matvecs); not in the inner loop.
//
// For simplicity in the matrix-free CPU reference we extract using the
// element scatter directly per-element — much cheaper than two matvecs.
// One thread per element computes the 2×2 contributions for every node pair
// it touches; node-side reduction sums them into the global block buffer.
//
// The pack format matches v1's `packDsBlockJacobi`: 4 DS values per node,
// laid out as (a, b, c, d) where M^{-1} y₂ = [a b; c d] r₂.
// -----------------------------------------------------------------------------
export function cpuRefMfBuildBlockJacobi({
  bMatricesDsPacked, gpWeightsDsPacked, dPerGpDsPacked,
  forceIncPtr, forceIncList, dofMap, freeDofs,
  numElements, gpsPerElem, numLocalDofs, numFree
}) {
  // We need the four entries of K per nodal 2×2 block.  For each free DOF i,
  // we already have diag entry from cpuRefMfDiag.  The off-diagonal entry
  // K[i, j] for j = i±1 (the same-node mate) we compute via element-scatter.
  //
  // Build via three element passes:
  //   pass A: write per-element K[d,d] (diag-self)        → out_a (numEl·LD DS)
  //   pass B: write per-element K[d,d±1] (cross)          → out_b
  // and node-side reduce both via the existing forceIncPtr/List.
  //
  // For a free DOF i, its mate j satisfies dofMap[same-element-slot] pairs
  // — but the global-DOF mate of free-dof i is freeDofs[i] ± 1 if that is
  // also free.  We compute, per free DOF, the four 2×2 entries in
  // free-DOF index space.
  //
  // Actually the cleanest approach mirrors v1's `buildBlockJacobiPackForFreeDofs`:
  // build the explicit CSR row of K for the row indexed by `2n` and look up
  // the column indexed by `2n+1` (and vice-versa).  Since matrix-free CPU
  // reference is just for correctness, we materialise a small CSR-like
  // reduction here.  This is O(numFree²) in worst case but tiny on test
  // problems.
  // Build a list of off-diagonal contributions: for each element, for each
  // pair of free local DOFs (i_local, j_local), accumulate K_e[i_local,j_local]
  // into an `(iFree, jFree)` map.
  const STRAIN_DIM = 3;
  const D_PACK = 6;
  const offdiag = new Map();   // key = `${i}-${j}` (i<j) → [hi, lo]
  const diag = new Float32Array(2 * numFree);
  for (let e = 0; e < numElements; e += 1) {
    const bBaseElem = e * gpsPerElem * STRAIN_DIM * numLocalDofs;
    const dBaseElem = e * gpsPerElem * D_PACK;
    const wBaseElem = e * gpsPerElem;
    // Compute K_e (as a small symmetric numLocalDofs × numLocalDofs DS matrix).
    const Ke = new Array(numLocalDofs * numLocalDofs);
    for (let k = 0; k < Ke.length; k += 1) Ke[k] = [0, 0];
    for (let g = 0; g < gpsPerElem; g += 1) {
      const bBase = bBaseElem + g * STRAIN_DIM * numLocalDofs;
      const dBase = dBaseElem + g * D_PACK;
      const wDet = dsAt(gpWeightsDsPacked, wBaseElem + g);
      const D = [
        [dsAt(dPerGpDsPacked, dBase + 0), dsAt(dPerGpDsPacked, dBase + 1), dsAt(dPerGpDsPacked, dBase + 2)],
        [dsAt(dPerGpDsPacked, dBase + 1), dsAt(dPerGpDsPacked, dBase + 3), dsAt(dPerGpDsPacked, dBase + 4)],
        [dsAt(dPerGpDsPacked, dBase + 2), dsAt(dPerGpDsPacked, dBase + 4), dsAt(dPerGpDsPacked, dBase + 5)],
      ];
      const Bcol = (d) => [
        dsAt(bMatricesDsPacked, bBase + 0 * numLocalDofs + d),
        dsAt(bMatricesDsPacked, bBase + 1 * numLocalDofs + d),
        dsAt(bMatricesDsPacked, bBase + 2 * numLocalDofs + d),
      ];
      for (let i = 0; i < numLocalDofs; i += 1) {
        const Bi = Bcol(i);
        for (let j = 0; j < numLocalDofs; j += 1) {
          const Bj = Bcol(j);
          const cb0 = dsAdd(dsAdd(dsMul(D[0][0], Bj[0]), dsMul(D[0][1], Bj[1])), dsMul(D[0][2], Bj[2]));
          const cb1 = dsAdd(dsAdd(dsMul(D[1][0], Bj[0]), dsMul(D[1][1], Bj[1])), dsMul(D[1][2], Bj[2]));
          const cb2 = dsAdd(dsAdd(dsMul(D[2][0], Bj[0]), dsMul(D[2][1], Bj[1])), dsMul(D[2][2], Bj[2]));
          const kij = dsAdd(dsAdd(dsMul(Bi[0], cb0), dsMul(Bi[1], cb1)), dsMul(Bi[2], cb2));
          Ke[i * numLocalDofs + j] = dsAdd(Ke[i * numLocalDofs + j], dsMul(wDet, kij));
        }
      }
    }
    // Scatter Ke[i,j] into globals.
    for (let i = 0; i < numLocalDofs; i += 1) {
      const iFree = dofMap[e * numLocalDofs + i];
      if (iFree < 0) continue;
      for (let j = 0; j < numLocalDofs; j += 1) {
        const jFree = dofMap[e * numLocalDofs + j];
        if (jFree < 0) continue;
        if (iFree === jFree) {
          dsWrite(diag, iFree, dsAdd(dsAt(diag, iFree), Ke[i * numLocalDofs + j]));
        } else if (iFree < jFree) {
          const key = `${iFree}-${jFree}`;
          const cur = offdiag.get(key) || [0, 0];
          offdiag.set(key, dsAdd(cur, Ke[i * numLocalDofs + j]));
        }
      }
    }
  }

  // Build 2×2 inverse blocks per node pair.  A free DOF i and its mate i±1
  // are "same node" iff freeDofs[i] and freeDofs[i±1] differ by ±1 and share
  // the same node id (freeDofs[i] >> 1 === freeDofs[i±1] >> 1).
  // For each such pair, build [a b; c d] inverse.
  const numNodes = Math.ceil(numFree / 2);
  const blocks = new Array(numNodes);
  for (let n = 0; n < numNodes; n += 1) blocks[n] = { a: 1, b: 0, c: 0, d: 1 };
  // Walk free DOFs and group by (global-dof >> 1).
  const groups = new Map();
  for (let f = 0; f < numFree; f += 1) {
    const node = freeDofs[f] >> 1;
    if (!groups.has(node)) groups.set(node, []);
    groups.get(node).push(f);
  }
  let pairIdx = 0;
  for (const [, list] of groups) {
    if (list.length === 2) {
      const i = list[0], j = list[1];
      const a = dsToF64(dsAt(diag, i));
      const dV = dsToF64(dsAt(diag, j));
      const offKey = i < j ? `${i}-${j}` : `${j}-${i}`;
      const off = dsToF64(offdiag.get(offKey) || [0, 0]);
      // Symmetric: K[i,j] = K[j,i] = off
      const det = a * dV - off * off;
      if (Math.abs(det) > 1e-300) {
        blocks[pairIdx] = {
          a:  dV / det,
          b: -off / det,
          c: -off / det,
          d:  a / det
        };
      } else {
        // Degenerate; fall back to scalar Jacobi.
        blocks[pairIdx] = {
          a: a !== 0 ? 1 / a : 1,
          b: 0,
          c: 0,
          d: dV !== 0 ? 1 / dV : 1
        };
      }
    } else if (list.length === 1) {
      const i = list[0];
      const a = dsToF64(dsAt(diag, i));
      blocks[pairIdx] = { a: a !== 0 ? 1 / a : 1, b: 0, c: 0, d: 1 };
    }
    pairIdx += 1;
  }
  // Pack blocks (4 DS per node).
  const packed = new Float32Array(8 * blocks.length);
  for (let n = 0; n < blocks.length; n += 1) {
    const b = blocks[n];
    const entries = [b.a, b.b, b.c, b.d];
    for (let k = 0; k < 4; k += 1) {
      const v = Number(entries[k]) || 0;
      const hi = Math.fround(v);
      const lo = Math.fround(v - hi);
      packed[8 * n + 2 * k] = hi;
      packed[8 * n + 2 * k + 1] = lo;
    }
  }
  // Per-node DOF "groups" → per-free-DOF block index.  We also need to
  // know, for an arbitrary free DOF i, which node-pair it belongs to and
  // whether it's the first or second slot.  Returns a pairIndex map.
  const freeToPair = new Int32Array(numFree);
  const freeIsSecond = new Uint8Array(numFree);
  let p = 0;
  for (const [, list] of groups) {
    for (let k = 0; k < list.length; k += 1) {
      freeToPair[list[k]] = p;
      freeIsSecond[list[k]] = k === 1 ? 1 : 0;
    }
    p += 1;
  }
  return { blocksPacked: packed, freeToPair, freeIsSecond, numNodes: blocks.length };
}

// -----------------------------------------------------------------------------
// Apply 2×2 nodal block-Jacobi.  z[2n,2n+1] = M_n^{-1} · r[2n,2n+1].
// -----------------------------------------------------------------------------
export function cpuRefMfApplyBlockJacobi({
  blocksPacked, freeToPair, freeIsSecond, rDsPacked
}) {
  const n = rDsPacked.length >> 1;
  const z = new Float32Array(2 * n);
  // Walk pairs: for each pair, read the two r entries and compute
  //   z_first  = a r_first + b r_second
  //   z_second = c r_first + d r_second
  // We need to find, for each pair, the two free-DOF slots.  Build a quick
  // inverse map.
  // Iterate free DOFs, group by pair index.
  const slots = new Map();    // pairIdx → [iFreeFirst, iFreeSecond?]
  for (let i = 0; i < n; i += 1) {
    const p = freeToPair[i];
    if (!slots.has(p)) slots.set(p, [-1, -1]);
    slots.get(p)[freeIsSecond[i] ? 1 : 0] = i;
  }
  for (const [pairIdx, [iA, iB]] of slots) {
    const a = dsAt(blocksPacked, 4 * pairIdx + 0);
    const b = dsAt(blocksPacked, 4 * pairIdx + 1);
    const c = dsAt(blocksPacked, 4 * pairIdx + 2);
    const d = dsAt(blocksPacked, 4 * pairIdx + 3);
    if (iA >= 0 && iB >= 0) {
      const rA = dsAt(rDsPacked, iA);
      const rB = dsAt(rDsPacked, iB);
      dsWrite(z, iA, dsAdd(dsMul(a, rA), dsMul(b, rB)));
      dsWrite(z, iB, dsAdd(dsMul(c, rA), dsMul(d, rB)));
    } else if (iA >= 0) {
      const rA = dsAt(rDsPacked, iA);
      dsWrite(z, iA, dsMul(a, rA));     // scalar fallback
    } else if (iB >= 0) {
      const rB = dsAt(rDsPacked, iB);
      dsWrite(z, iB, dsMul(d, rB));
    }
  }
  return z;
}
