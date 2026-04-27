// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Resident GPU Newton loop orchestrator (DS, no handoffs).
// ============================================================================
//
// One Newton iteration consists of:
//
//   1. Strain at every Gauss point:           dispatchElementStrain
//   2. MC return mapping at every Gauss point: dispatchMcReturn
//   3. Per-element internal force F_e:        dispatchElementInternalForce
//   4. Per-element tangent K_e:               dispatchElementStiffness
//   5. Scatter F_e into global F_int:         dispatchScatterFreeRhs
//   6. Scatter K_e into global K (CSR):       dispatchScatterCsr
//   7. Compute residual r = b - F_int:         dispatchAxpby (-1, 1)
//   8. Residual norm ‖r‖:                      dispatchDot + readback
//   9. Solve K δu = r via resident CG/GMRES   (resident-cg.js / resident-gmres.js)
//  10. Armijo line search:
//      a) For α in {1, 1/2, 1/4, ...}:
//         - u_trial = u + α δu
//         - residual-only re-assembly (steps 1, 2, 3, 5, 7, 8)
//         - Armijo check on CPU (one scalar readback)
//      b) Accept first α that satisfies sufficient-decrease.
//  11. Update u ← u_trial.
//  12. Convergence check (one scalar readback).
//
// Per-iteration scalar readbacks: residual norm + line-search merits
// (~3-5) + convergence flags = ~10-20 × 8 B = 80-160 B.  Negligible.
//
// This module is the ORCHESTRATOR.  It does not hold buffer state — that
// belongs to the resident CG / GMRES contexts.  Instead, it coordinates the
// kernel sequence, threads scalar readbacks back to convergence checks,
// and surfaces step records for the run report.
//
// Because the assembly kernels (Phase 6) and the MC kernel (Phase 7) need
// device hardware to execute, this module is shipped as a CPU-reference
// orchestrator that drives the parity suite.  The device-bound version
// (Phase 8b) reuses the same control flow but issues GPUCommandEncoder
// dispatches; ~200 lines of mechanical wrapper, omitted here pending
// hardware-side parity testing.

import { cpuRefAxpy } from './wgsl/blas.js';
import { cpuMcReturnMapping } from './wgsl/mc-plastic.js';
import { dsFromF64, dsToF64, dsAdd, dsMul, dsNeg } from './wgsl/ds.js';
import { liftF64, lowerDs } from './wgsl/blas.js';

// -----------------------------------------------------------------------------
// CPU-reference Newton iteration (matches the GPU dispatch sequence).
//
// Inputs:
//   elementCaches     : as built by buildDeformationElementCaches (CPU)
//   materialPoints    : array of material-point states
//   matvec(rows, x)   : sparse matvec (DS or f64)
//   linearSolve(K, b) : returns δu solving K δu = b (CG or GMRES)
//   options           : { phaseKind, maxIter, relTol, absTol, ... }
//
// Returns:
//   { converged, iterations, residualNorm, history }
//
// This reference is for PHASE 10 PARITY TESTING. The actual production
// Newton loop in solver.js already does this in CPU f64 with the proven
// algorithm; the GPU resident version reproduces the same control flow on
// device buffers.
// -----------------------------------------------------------------------------
export async function residentNewtonReference({
  assembleResidualAndTangent,    // (uF64) → { K_csr, F_int_F64, residualF64 }
  assembleResidualOnly,          // (uF64) → residualF64
  linearSolve,                   // async (K_csr, rhsF64) → δu_F64
  bF64,
  u0F64,
  maxIter = 32,
  relTol = 1e-4,
  absTol = 1e-3,
  lineSearch = { reduction: 0.5, maxBacktracks: 5, armijoC1: 1e-4 }
}) {
  const N = bF64.length;
  let u = Float64Array.from(u0F64 || new Float64Array(N));

  const history = [];
  for (let iter = 1; iter <= maxIter; iter += 1) {
    const { K_csr, F_int_F64 } = await assembleResidualAndTangent(u);
    const residualF64 = new Float64Array(N);
    for (let i = 0; i < N; i += 1) residualF64[i] = bF64[i] - F_int_F64[i];
    const residualNorm = Math.sqrt(residualF64.reduce((s, v) => s + v * v, 0));
    const rhsNorm = Math.sqrt(bF64.reduce((s, v) => s + v * v, 0));
    const target = Math.max(absTol, relTol * rhsNorm);
    history.push({ iter, residualNorm, rhsNorm });
    if (residualNorm <= target) {
      return { converged: true, iterations: iter, residualNorm, solution: u, history };
    }
    const deltaU = await linearSolve(K_csr, residualF64);
    // Armijo line search.
    let alpha = 1;
    let accepted = false;
    const meritCurrent = residualNorm;
    for (let bt = 0; bt <= lineSearch.maxBacktracks; bt += 1) {
      const uTrial = new Float64Array(N);
      for (let i = 0; i < N; i += 1) uTrial[i] = u[i] + alpha * deltaU[i];
      const rTrial = await assembleResidualOnly(uTrial);
      const trialNorm = Math.sqrt(rTrial.reduce((s, v) => s + v * v, 0));
      // Sufficient-decrease (relaxed Armijo on residual norm).
      if (trialNorm <= (1 - lineSearch.armijoC1 * alpha) * meritCurrent) {
        u = uTrial;
        accepted = true;
        break;
      }
      alpha *= lineSearch.reduction;
    }
    if (!accepted) {
      // Take the last α anyway (best effort) and continue; matching the CPU
      // solver's "line search stalled but full step is best" behaviour.
      const uTrial = new Float64Array(N);
      for (let i = 0; i < N; i += 1) uTrial[i] = u[i] + alpha * deltaU[i];
      u = uTrial;
    }
  }
  // Max-iter exhausted.
  const finalResidual = await assembleResidualOnly(u);
  const finalNorm = Math.sqrt(finalResidual.reduce((s, v) => s + v * v, 0));
  return {
    converged: false,
    iterations: maxIter,
    residualNorm: finalNorm,
    solution: u,
    history
  };
}
