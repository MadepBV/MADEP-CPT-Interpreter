// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Krylov solvers for the deformation Newton inner step.
//
//   * Preconditioned CG (block-Jacobi) — used for the SPD elastic /
//     symmetric-tangent path.
//   * Restarted, row-and-column scaled, left-preconditioned GMRES —
//     the production plastic-tangent path. 1:1 port of
//     `solveGmresScaled` from src/lib/cpt-app/deformation/solver.js,
//     including the per-restart raw-residual recompute and the
//     equilibration scaling that keeps Krylov convergence robust on
//     the rank-deficient consistent algorithmic tangent.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "sparse.hpp"

namespace madep::cg {

struct LinearSolveResult {
  std::int32_t iterations{ 0 };
  double residualNorm{ 0.0 };
  bool converged{ false };
};

// =============================================================================
// Preconditioned conjugate gradient (block-Jacobi).
//
// Used when the global stiffness is SPD (linear-elastic, modified Newton
// MC plastic). Stops at the first iteration where the raw residual norm
// drops below max(absTol, relTol * ‖b‖).
// =============================================================================
inline LinearSolveResult solve_cg(
    const CsrMatrix& A,
    const std::vector<double>& diag_inv,
    const std::vector<std::int32_t>& freeDofs,
    const double* rhs,
    double* x,
    std::int32_t maxIter,
    double relTol,
    double absTol) {
  const std::int32_t n = A.nrows;
  std::vector<double> r(static_cast<std::size_t>(n), 0.0);
  std::vector<double> z(static_cast<std::size_t>(n), 0.0);
  std::vector<double> p(static_cast<std::size_t>(n), 0.0);
  std::vector<double> Ap(static_cast<std::size_t>(n), 0.0);

  sparse::mat_vec(A, x, r.data());
  for (std::int32_t i = 0; i < n; ++i) r[i] = rhs[i] - r[i];

  const double bnorm = sparse::norm2(rhs, n);
  const double tol = std::max(absTol, relTol * bnorm);

  sparse::apply_block_jacobi(diag_inv, freeDofs, r.data(), z.data(), n);
  for (std::int32_t i = 0; i < n; ++i) p[i] = z[i];
  double rz = sparse::dot(r.data(), z.data(), n);
  double rnorm = sparse::norm2(r.data(), n);

  LinearSolveResult out;
  if (rnorm <= tol) {
    out.iterations = 0;
    out.residualNorm = rnorm;
    out.converged = true;
    return out;
  }

  for (std::int32_t iter = 1; iter <= maxIter; ++iter) {
    sparse::mat_vec(A, p.data(), Ap.data());
    const double pAp = sparse::dot(p.data(), Ap.data(), n);
    if (!(pAp > 1e-30)) {
      out.iterations = iter;
      out.residualNorm = rnorm;
      out.converged = false;
      return out;
    }
    const double alpha = rz / pAp;
    for (std::int32_t i = 0; i < n; ++i) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    rnorm = sparse::norm2(r.data(), n);
    if (rnorm <= tol) {
      out.iterations = iter;
      out.residualNorm = rnorm;
      out.converged = true;
      return out;
    }
    sparse::apply_block_jacobi(diag_inv, freeDofs, r.data(), z.data(), n);
    const double rz_new = sparse::dot(r.data(), z.data(), n);
    const double beta = rz_new / rz;
    rz = rz_new;
    for (std::int32_t i = 0; i < n; ++i) p[i] = z[i] + beta * p[i];

    if (iter % 200 == 0) {
      sparse::mat_vec(A, x, r.data());
      for (std::int32_t i = 0; i < n; ++i) r[i] = rhs[i] - r[i];
      rnorm = sparse::norm2(r.data(), n);
      sparse::apply_block_jacobi(diag_inv, freeDofs, r.data(), z.data(), n);
      rz = sparse::dot(r.data(), z.data(), n);
      for (std::int32_t i = 0; i < n; ++i) p[i] = z[i];
    }
  }

  out.iterations = maxIter;
  out.residualNorm = rnorm;
  out.converged = (rnorm <= tol);
  return out;
}

// =============================================================================
// Row + column equilibration of the linear system.
//
// 1:1 port of `buildScaledLinearSystem` from solver.js. Column scale
// normalises each column's max-magnitude to 1; row scale normalises
// each (already column-scaled) row's max-magnitude to 1. After solving
// A' x' = b' the original-variable solution is x = col_scale ∘ x'.
// =============================================================================
struct ScaledCsr {
  CsrMatrix matrix;
  std::vector<double> rhs;
  std::vector<double> col_scale;  // x = col_scale ∘ x_scaled
  std::vector<double> row_scale;  // rhs_scaled = row_scale ∘ rhs
};

inline ScaledCsr build_scaled_csr(
    const CsrMatrix& A,
    const double* rhs,
    double scaleFloor = 1e-12) {
  const std::int32_t n = A.nrows;
  std::vector<double> col_max(static_cast<std::size_t>(n), 0.0);
  for (std::int32_t r = 0; r < n; ++r) {
    const std::int32_t lo = A.rowPtr[r];
    const std::int32_t hi = A.rowPtr[r + 1];
    for (std::int32_t k = lo; k < hi; ++k) {
      const std::int32_t c = A.colIdx[k];
      const double v = std::fabs(A.values[k]);
      if (v > col_max[c]) col_max[c] = v;
    }
  }
  std::vector<double> col_scale(static_cast<std::size_t>(n), 1.0);
  for (std::int32_t c = 0; c < n; ++c) {
    col_scale[c] = 1.0 / std::max(col_max[c], scaleFloor);
  }
  std::vector<double> row_max(static_cast<std::size_t>(n), 0.0);
  for (std::int32_t r = 0; r < n; ++r) {
    const std::int32_t lo = A.rowPtr[r];
    const std::int32_t hi = A.rowPtr[r + 1];
    for (std::int32_t k = lo; k < hi; ++k) {
      const double v = std::fabs(A.values[k] * col_scale[A.colIdx[k]]);
      if (v > row_max[r]) row_max[r] = v;
    }
  }
  std::vector<double> row_scale(static_cast<std::size_t>(n), 1.0);
  for (std::int32_t r = 0; r < n; ++r) {
    row_scale[r] = 1.0 / std::max(row_max[r], scaleFloor);
  }
  ScaledCsr out;
  out.matrix.nrows = n;
  out.matrix.rowPtr = A.rowPtr;
  out.matrix.colIdx = A.colIdx;
  out.matrix.values.resize(A.values.size());
  for (std::int32_t r = 0; r < n; ++r) {
    const std::int32_t lo = A.rowPtr[r];
    const std::int32_t hi = A.rowPtr[r + 1];
    const double rf = row_scale[r];
    for (std::int32_t k = lo; k < hi; ++k) {
      out.matrix.values[k] = rf * A.values[k] * col_scale[A.colIdx[k]];
    }
  }
  out.rhs.assign(static_cast<std::size_t>(n), 0.0);
  for (std::int32_t r = 0; r < n; ++r) out.rhs[r] = row_scale[r] * rhs[r];
  out.col_scale = std::move(col_scale);
  out.row_scale = std::move(row_scale);
  return out;
}

// Standard 2D Givens rotation primitives used by GMRES.
inline void givens_apply(double x, double y, double c, double s, double& ox, double& oy) {
  ox =  c * x + s * y;
  oy = -s * x + c * y;
}

inline void givens_compute(double a, double b, double& c, double& s) {
  constexpr double EPS = 1e-30;
  if (std::fabs(b) <= EPS) { c = 1.0; s = 0.0; return; }
  if (std::fabs(a) <= EPS) { c = 0.0; s = 1.0; return; }
  const double r = std::hypot(a, b);
  c = a / r;
  s = b / r;
}

// =============================================================================
// solveGmresScaled (1:1 port).
//
// Equilibrates the system (row + column scaling) then runs restarted
// left-preconditioned GMRES with MGS Arnoldi + Givens. At each restart
// boundary the raw (unscaled) residual is recomputed and the
// convergence test runs against it; this guards against numerical
// drift and against the rank-deficient case where the preconditioned
// residual can fall below tolerance while the true residual hasn't.
// =============================================================================
inline LinearSolveResult solve_gmres_scaled(
    const CsrMatrix& A,
    const std::vector<std::int32_t>& freeDofs,
    const double* rhs,
    double* x,
    std::int32_t maxIter,
    double relTol,
    double absTol,
    std::int32_t restart = 40) {
  const std::int32_t n = A.nrows;
  LinearSolveResult out;
  if (n == 0) { out.converged = true; return out; }

  ScaledCsr scaled = build_scaled_csr(A, rhs);
  std::vector<double> diag_inv;
  sparse::build_block_jacobi(scaled.matrix, freeDofs, diag_inv);
  const double rawRhsNorm = sparse::norm2(scaled.rhs.data(), n);

  // Scaled initial guess: x_scaled = x / col_scale (so x = col_scale * x_scaled).
  std::vector<double> xs(static_cast<std::size_t>(n), 0.0);
  for (std::int32_t i = 0; i < n; ++i) xs[i] = x[i] / std::max(scaled.col_scale[i], 1e-30);

  // JS solveGmresScaled calls this the "raw" residual, but it is raw in
  // the scaled system: r = R b - (R A C) x_scaled.
  const double rawTol = std::max(absTol, relTol * std::max(rawRhsNorm, 1e-30));

  std::vector<double> ax(static_cast<std::size_t>(n), 0.0);
  std::vector<double> r_raw(static_cast<std::size_t>(n), 0.0);
  std::vector<double> r_pre(static_cast<std::size_t>(n), 0.0);
  std::vector<double> w(static_cast<std::size_t>(n), 0.0);
  std::vector<double> wpre(static_cast<std::size_t>(n), 0.0);

  auto recompute_raw_residual = [&]() {
    sparse::mat_vec(scaled.matrix, xs.data(), ax.data());
    for (std::int32_t i = 0; i < n; ++i) r_raw[i] = scaled.rhs[i] - ax[i];
    return sparse::norm2(r_raw.data(), n);
  };
  auto write_unscaled_solution = [&]() {
    for (std::int32_t i = 0; i < n; ++i) x[i] = scaled.col_scale[i] * xs[i];
  };

  // Initial residual + tolerance check.
  double raw_rnorm = recompute_raw_residual();
  if (raw_rnorm <= rawTol) {
    write_unscaled_solution();
    out.converged = true;
    out.iterations = 0;
    out.residualNorm = raw_rnorm;
    return out;
  }
  sparse::apply_block_jacobi(diag_inv, freeDofs, r_raw.data(), r_pre.data(), n);
  const double rhsNorm = sparse::norm2(r_pre.data(), n);
  const double preTol = std::max(absTol, relTol * std::max(rhsNorm, 1e-30));

  std::int32_t totalIter = 0;
  std::vector<std::vector<double>> V;
  std::vector<double> H;
  std::vector<double> cs;
  std::vector<double> sn;
  std::vector<double> g;
  std::vector<double> y;

  while (totalIter < maxIter) {
    const double beta = sparse::norm2(r_pre.data(), n);
    if (!(beta > 1e-30)) {
      // The preconditioned residual has collapsed. Recheck raw.
      raw_rnorm = recompute_raw_residual();
      write_unscaled_solution();
      out.converged = (raw_rnorm <= rawTol);
      out.iterations = totalIter;
      out.residualNorm = raw_rnorm;
      return out;
    }
    const std::int32_t krylovDim = std::min(restart, maxIter - totalIter);
    V.assign(static_cast<std::size_t>(krylovDim + 1),
             std::vector<double>(static_cast<std::size_t>(n), 0.0));
    H.assign(static_cast<std::size_t>(krylovDim + 1) * krylovDim, 0.0);
    cs.assign(static_cast<std::size_t>(krylovDim), 0.0);
    sn.assign(static_cast<std::size_t>(krylovDim), 0.0);
    g.assign(static_cast<std::size_t>(krylovDim + 1), 0.0);
    g[0] = beta;
    for (std::int32_t i = 0; i < n; ++i) V[0][i] = r_pre[i] / beta;

    std::int32_t completed = 0;
    bool break_for_convergence = false;
    for (std::int32_t k = 0; k < krylovDim; ++k) {
      ++totalIter;
      completed = k + 1;

      // w = A * v_k  (in scaled system),  then apply left preconditioner.
      sparse::mat_vec(scaled.matrix, V[k].data(), w.data());
      sparse::apply_block_jacobi(diag_inv, freeDofs, w.data(), wpre.data(), n);
      // MGS orthogonalisation against V[0..k].
      for (std::int32_t i = 0; i <= k; ++i) {
        const double proj = sparse::dot(wpre.data(), V[i].data(), n);
        H[i * krylovDim + k] = proj;
        for (std::int32_t j = 0; j < n; ++j) wpre[j] -= proj * V[i][j];
      }
      const double normNext = sparse::norm2(wpre.data(), n);
      H[(k + 1) * krylovDim + k] = normNext;
      if (normNext > 1e-30 && (k + 1) < krylovDim + 1) {
        for (std::int32_t j = 0; j < n; ++j) V[k + 1][j] = wpre[j] / normNext;
      }

      // Apply previous Givens rotations to the new column of H.
      for (std::int32_t i = 0; i < k; ++i) {
        double a = H[i * krylovDim + k];
        double b = H[(i + 1) * krylovDim + k];
        double ra, rb;
        givens_apply(a, b, cs[i], sn[i], ra, rb);
        H[i * krylovDim + k] = ra;
        H[(i + 1) * krylovDim + k] = rb;
      }
      // New Givens that zeros H[k+1, k].
      double cv, sv;
      givens_compute(H[k * krylovDim + k], H[(k + 1) * krylovDim + k], cv, sv);
      cs[k] = cv;
      sn[k] = sv;
      double newDiag, newSub;
      givens_apply(H[k * krylovDim + k], H[(k + 1) * krylovDim + k], cv, sv, newDiag, newSub);
      H[k * krylovDim + k] = newDiag;
      H[(k + 1) * krylovDim + k] = 0.0;
      double gk, gkp1;
      givens_apply(g[k], g[k + 1], cv, sv, gk, gkp1);
      g[k] = gk;
      g[k + 1] = gkp1;

      const double precond_res = std::fabs(g[k + 1]);
      // Update scaled iterate using current Hessenberg least-squares
      // solution, then recompute raw residual to test true convergence.
      // We do this at every iteration so the rank-deficient case (where
      // precond_res drops fast but raw residual lingers) is handled
      // correctly.
      if (precond_res <= preTol || k + 1 == krylovDim || totalIter >= maxIter || normNext <= 1e-30) {
        y.assign(static_cast<std::size_t>(completed), 0.0);
        for (std::int32_t i = completed - 1; i >= 0; --i) {
          double sum = g[i];
          for (std::int32_t j = i + 1; j < completed; ++j) sum -= H[i * krylovDim + j] * y[j];
          const double diag = H[i * krylovDim + i];
          if (!(std::fabs(diag) > 1e-30)) { y[i] = 0.0; }
          else y[i] = sum / diag;
        }
        std::vector<double> dxs(static_cast<std::size_t>(n), 0.0);
        for (std::int32_t i = 0; i < completed; ++i) {
          for (std::int32_t j = 0; j < n; ++j) dxs[j] += y[i] * V[i][j];
        }
        for (std::int32_t j = 0; j < n; ++j) xs[j] += dxs[j];
        raw_rnorm = recompute_raw_residual();
        if (raw_rnorm <= rawTol) {
          write_unscaled_solution();
          out.converged = true;
          out.iterations = totalIter;
          out.residualNorm = raw_rnorm;
          return out;
        }
        sparse::apply_block_jacobi(diag_inv, freeDofs, r_raw.data(), r_pre.data(), n);
        break_for_convergence = true;
        break;
      }
    }
    if (!break_for_convergence && completed > 0) {
      // Restart triggered by krylovDim cap without explicit convergence
      // check; assemble the least-squares correction so we don't lose it.
      y.assign(static_cast<std::size_t>(completed), 0.0);
      for (std::int32_t i = completed - 1; i >= 0; --i) {
        double sum = g[i];
        for (std::int32_t j = i + 1; j < completed; ++j) sum -= H[i * krylovDim + j] * y[j];
        const double diag = H[i * krylovDim + i];
        if (!(std::fabs(diag) > 1e-30)) { y[i] = 0.0; }
        else y[i] = sum / diag;
      }
      std::vector<double> dxs(static_cast<std::size_t>(n), 0.0);
      for (std::int32_t i = 0; i < completed; ++i) {
        for (std::int32_t j = 0; j < n; ++j) dxs[j] += y[i] * V[i][j];
      }
      for (std::int32_t j = 0; j < n; ++j) xs[j] += dxs[j];
      raw_rnorm = recompute_raw_residual();
      sparse::apply_block_jacobi(diag_inv, freeDofs, r_raw.data(), r_pre.data(), n);
      if (raw_rnorm <= rawTol) {
        write_unscaled_solution();
        out.converged = true;
        out.iterations = totalIter;
        out.residualNorm = raw_rnorm;
        return out;
      }
    }
  }

  // Final unscaled solution into x.
  for (std::int32_t i = 0; i < n; ++i) x[i] = scaled.col_scale[i] * xs[i];
  out.iterations = totalIter;
  out.residualNorm = raw_rnorm;
  out.converged = (raw_rnorm <= rawTol);
  return out;
}

// Compatibility wrapper for the previous solve_gmres call sites.
inline LinearSolveResult solve_gmres(
    const CsrMatrix& A,
    const std::vector<double>& /*unused*/,
    const std::vector<std::int32_t>& freeDofs,
    const double* rhs,
    double* x,
    std::int32_t maxIter,
    double relTol,
    double absTol,
    std::int32_t restart = 40) {
  return solve_gmres_scaled(A, freeDofs, rhs, x, maxIter, relTol, absTol, restart);
}

}  // namespace madep::cg
