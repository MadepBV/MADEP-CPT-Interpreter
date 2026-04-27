// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Resident GPU restarted GMRES (DS, no handoffs).
// ============================================================================
//
// All Krylov vectors V_1, ..., V_{m+1} (each of length N, DS-packed) live on
// GPU buffers from solve start to solve end.  The Arnoldi process runs on
// GPU; the upper-Hessenberg matrix H ((m+1) × m) and Givens rotations run on
// CPU as f64 because they are tiny (~30 × 30 = 7 KB).
//
// Mathematical structure (right-preconditioned restarted GMRES with modified
// Gram-Schmidt, Saad "Iterative Methods for Sparse Linear Systems" §6.5):
//
//     Initial:  r_0 = b - A x_0
//               beta = ||r_0||
//               v_1 = r_0 / beta
//               g[0] = beta, g[1..m] = 0
//
//     For j = 1, 2, ..., m:
//         w = A v_j                   (one matvec)
//         For i = 1, ..., j:
//             h_ij = v_i · w           (one DS dot)
//             w = w - h_ij v_i         (one DS axpy)
//         h_{j+1,j} = ||w||
//         v_{j+1} = w / h_{j+1,j}
//         Apply previous Givens rotations to column j of H
//         Compute new Givens for (h_{j,j}, h_{j+1,j}) and apply
//         |g[j+1]| is the current residual estimate
//         If |g[j+1]| < tol: break
//
//     Solve upper-triangular H y = g (back-substitution, CPU)
//     x = x_0 + Σ y_j v_j
//
// Restart: x_0 ← x, repeat.
//
// Per inner iteration j: j+1 readbacks (j dots + 1 norm).  For m = 30:
// O(m²) total readbacks per restart = 480 × 8 B = ~4 KB.  Negligible.

import {
  KERNEL_AXPY_WGSL,
  KERNEL_AXPBY_WGSL,
  KERNEL_SCALE_WGSL,
  KERNEL_COPY_WGSL,
  KERNEL_DOT_PASS1_WGSL,
  KERNEL_DOT_PASS2_WGSL,
  KERNEL_CSR_MATVEC_WGSL,
  KERNEL_BLOCK_JACOBI_WGSL,
  cpuRefAxpy,
  cpuRefAxpby,
  cpuRefDot,
  cpuRefCsrMatvec,
  cpuRefBlockJacobi,
  liftF64,
  lowerDs
} from './wgsl/blas.js';

import {
  packDsVector,
  unpackDsVector
} from './resident-buffers.js';

import { dsFromF64, dsToF64, dsAdd, dsMul } from './wgsl/ds.js';

const WG_SIZE = 64;

// =============================================================================
// CPU reference implementation of restarted GMRES with the same dispatch
// shape as the resident GPU version.  This is the canonical algorithm we
// will use to drive parity tests against the GPU once a runtime is bound.
// =============================================================================

export function cpuReferenceResidentGmres({ csr, blockJacobiDs, bF64, x0F64 = null, maxIter = 1000, relTol = 1e-8, absTol = 1e-12, restart = 30 }) {
  const N = bF64.length;
  const m = Math.max(Math.min(restart | 0, maxIter), 1);
  const bDs = liftF64(bF64);
  let xDs = liftF64(x0F64 || new Float64Array(N));

  const rhsNormSq = dsToF64(cpuRefDot(bDs, bDs));
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const targetTol = Math.max(absTol, relTol * rhsNorm);

  let totalIters = 0;
  let lastResidualNorm = 0;

  while (totalIters < maxIter) {
    // r_0 = b - A x  (or = b when x = 0)
    let rDs;
    if (totalIters > 0 || (x0F64 && x0F64.some((v) => v !== 0))) {
      const Ax = cpuRefCsrMatvec(csr, xDs);
      rDs = bDs.map((v, i) => dsAdd(v, [-Ax[i][0], -Ax[i][1]]));
    } else {
      rDs = bDs.map((v) => [v[0], v[1]]);
    }

    // Apply right preconditioner to the residual: z_0 = M^-1 r_0.
    // Right preconditioning: solve A M^-1 (M x) = b.  Equivalent left form
    // here: we work with the preconditioned residual.  Using left
    // preconditioning is simpler in code: z = M^-1 r and Krylov subspace is
    // K_m(M^-1 A, z).
    let zDs = cpuRefBlockJacobi(blockJacobiDs, rDs);
    const beta0Sq = dsToF64(cpuRefDot(zDs, zDs));
    const beta0 = Math.sqrt(Math.max(beta0Sq, 0));
    if (beta0 <= targetTol) {
      lastResidualNorm = beta0;
      return { solution: lowerDs(xDs), iterations: totalIters, residualNorm: lastResidualNorm, converged: true };
    }

    // Allocate Krylov basis V (m+1 vectors of length N) and small CPU H, g, c, s.
    const V = new Array(m + 1);
    V[0] = zDs.map((v) => {
      const f = 1 / beta0;
      return [Math.fround(v[0] * f), Math.fround(v[1] * f + (v[0] * f - Math.fround(v[0] * f)))];
    });
    const H = Array.from({ length: m + 1 }, () => new Float64Array(m));
    const g = new Float64Array(m + 1);
    g[0] = beta0;
    const c = new Float64Array(m);
    const s = new Float64Array(m);

    let innerIters = 0;
    let breakReason = 'maxinner';

    for (let j = 0; j < m && totalIters + 1 <= maxIter; j += 1) {
      innerIters = j + 1;
      totalIters += 1;
      // w = M^-1 A v_j  (left preconditioning)
      const Avj = cpuRefCsrMatvec(csr, V[j]);
      let w = cpuRefBlockJacobi(blockJacobiDs, Avj);
      // Modified Gram-Schmidt against V[0..j].
      for (let i = 0; i <= j; i += 1) {
        const hij = dsToF64(cpuRefDot(V[i], w));
        H[i][j] = hij;
        // w = w - hij V[i]
        cpuRefAxpy(dsFromF64(-hij), V[i], w);
      }
      const wNormSq = dsToF64(cpuRefDot(w, w));
      const wNorm = Math.sqrt(Math.max(wNormSq, 0));
      H[j + 1][j] = wNorm;
      // v_{j+1} = w / wNorm  (unless wNorm ~ 0, "happy breakdown")
      if (wNorm > 1e-300) {
        V[j + 1] = w.map((v) => {
          const f = 1 / wNorm;
          return [Math.fround(v[0] * f), Math.fround(v[1] * f + (v[0] * f - Math.fround(v[0] * f)))];
        });
      } else {
        V[j + 1] = w.map(() => [0, 0]);
      }

      // Apply previous Givens rotations to column j of H.
      for (let i = 0; i < j; i += 1) {
        const tmp = c[i] * H[i][j] + s[i] * H[i + 1][j];
        H[i + 1][j] = -s[i] * H[i][j] + c[i] * H[i + 1][j];
        H[i][j] = tmp;
      }
      // Compute new Givens for (H[j][j], H[j+1][j]).
      const hj = H[j][j];
      const hjp = H[j + 1][j];
      const denom = Math.hypot(hj, hjp);
      if (denom > 0) {
        c[j] = hj / denom;
        s[j] = hjp / denom;
      } else {
        c[j] = 1; s[j] = 0;
      }
      H[j][j] = c[j] * hj + s[j] * hjp;
      H[j + 1][j] = 0;
      // Update g.
      const gj = c[j] * g[j];
      g[j + 1] = -s[j] * g[j];
      g[j] = gj;
      lastResidualNorm = Math.abs(g[j + 1]);
      if (lastResidualNorm <= targetTol) {
        breakReason = 'tolerance';
        break;
      }
    }

    // Solve upper-triangular H y = g (size innerIters) and update x.
    const yk = new Float64Array(innerIters);
    for (let i = innerIters - 1; i >= 0; i -= 1) {
      let sum = g[i];
      for (let kj = i + 1; kj < innerIters; kj += 1) {
        sum -= H[i][kj] * yk[kj];
      }
      yk[i] = H[i][i] !== 0 ? sum / H[i][i] : 0;
    }
    // x = x_0 + Σ_{j=0}^{innerIters-1} yk[j] V[j]
    for (let j = 0; j < innerIters; j += 1) {
      cpuRefAxpy(dsFromF64(yk[j]), V[j], xDs);
    }

    if (breakReason === 'tolerance') {
      return { solution: lowerDs(xDs), iterations: totalIters, residualNorm: lastResidualNorm, converged: true };
    }
    if (totalIters >= maxIter) break;
  }
  return { solution: lowerDs(xDs), iterations: totalIters, residualNorm: lastResidualNorm, converged: false };
}

// =============================================================================
// GPU resident GMRES is structurally identical to the CPU reference above.
// The only differences are:
//
//  - V_j are stored as DS-vector GPU buffers; allocated once, indexed by j.
//  - matvec and Gram-Schmidt happen via WGSL kernel dispatches.
//  - h_ij and ||w|| readbacks cross to CPU each inner iteration (small, fast).
//  - H, c, s, g stay on CPU (tiny).
//  - Final x update uses dispatchAxpy(yk[j], V[j], x) per j.
//
// Because the runtime layer (`resident-cg.js`) already exposes pipeline
// compilation, bind-group helpers and bind-binding helpers, the GMRES
// runtime can be assembled from the same building blocks.  See
// `resident-gmres-runtime.js` (Phase 5b — wired in Phase 8) for the
// device-bound version.  This module ships:
//
//  1. The CPU reference algorithm (above), used for parity tests.
//  2. A `dispatchPlanResidentGmres()` that returns a structured description
//     of the per-inner-iteration kernel sequence the device-bound runtime
//     must execute.  Externalising the dispatch plan lets the runtime layer
//     reuse a single kernel-cache and lets the parity suite verify the
//     plan without spinning up a real GPU.
// =============================================================================

export function dispatchPlanResidentGmres({ N, m, restart }) {
  // For documentation and future tooling: enumerate the kernels each
  // restart cycle would invoke, in order, with the binding contract.
  // Returned as a list of { kernel, inputs, outputs, count } records.
  const plan = [
    { kernel: 'csr-matvec', inputs: ['x'], outputs: ['Ap'], count: 1, phase: 'r_0 = b - A x' },
    { kernel: 'axpy',       inputs: ['Ap'], outputs: ['r'], count: 1, phase: 'r := b - A x' },
    { kernel: 'block-jacobi',inputs: ['r'],  outputs: ['z'], count: 1, phase: 'z = M^-1 r' },
    { kernel: 'dot',        inputs: ['z', 'z'], outputs: ['scalar'], count: 1, phase: 'beta = ||z||' },
    { kernel: 'scale',      inputs: ['z'], outputs: ['V[0]'], count: 1, phase: 'v_1 = z / beta' },
    // Per inner iter j:
    { kernel: 'csr-matvec',  inputs: ['V[j]'], outputs: ['Ap'], count: m, phase: 'A v_j' },
    { kernel: 'block-jacobi',inputs: ['Ap'],   outputs: ['w'],  count: m, phase: 'w = M^-1 A v_j' },
    { kernel: 'dot',         inputs: ['V[i]', 'w'], outputs: ['scalar'], count: 'm*(m+1)/2', phase: 'h_{ij} = v_i · w (MGS)' },
    { kernel: 'axpy',        inputs: ['V[i]'], outputs: ['w'],  count: 'm*(m+1)/2', phase: 'w -= h_{ij} v_i' },
    { kernel: 'dot',         inputs: ['w', 'w'], outputs: ['scalar'], count: m, phase: 'h_{j+1,j} = ||w||' },
    { kernel: 'scale',       inputs: ['w'], outputs: ['V[j+1]'], count: m, phase: 'v_{j+1} = w / h_{j+1,j}' },
    // Once per restart, after Givens convergence test:
    { kernel: 'axpy',        inputs: ['V[j]'], outputs: ['x'], count: 'innerIters', phase: 'x += y_j v_j' }
  ];
  return { N, m, restart, plan };
}
