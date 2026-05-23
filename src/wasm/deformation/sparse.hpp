// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compressed Sparse Row sparse linear algebra: build pattern from element
// caches, assemble values, sparse mat-vec, and a 2×2 block-Jacobi
// preconditioner keyed on free DOFs.

#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <vector>

#include "element.hpp"
#include "types.hpp"

namespace madep::sparse {

// Build the global free-DOF CSR sparsity pattern from the element
// caches. `freeIndexByDof[fullDof]` maps a global DOF index to its
// position in the free DOF list, or -1 if the DOF is fixed.
inline void build_pattern(
    const std::vector<ElementCache>& elements,
    const std::vector<BeamElementCache>* beamElements,
    const std::vector<std::int32_t>& freeIndexByDof,
    std::int32_t nfree,
    CsrMatrix& A) {
  std::vector<std::vector<std::int32_t>> colsPerRow(nfree);
  auto add_dofs = [&](const std::int32_t* dofs, int ndofs) {
    for (int i = 0; i < ndofs; ++i) {
      const std::int32_t gi = dofs[i];
      const std::int32_t fi = freeIndexByDof[gi];
      if (fi < 0) continue;
      for (int j = 0; j < ndofs; ++j) {
        const std::int32_t gj = dofs[j];
        const std::int32_t fj = freeIndexByDof[gj];
        if (fj < 0) continue;
        colsPerRow[fi].push_back(fj);
      }
    }
  };
  for (const auto& el : elements) {
    add_dofs(el.dofs.data(), el.numDofs);
  }
  if (beamElements) {
    for (const auto& el : *beamElements) add_dofs(el.dofs.data(), 6);
  }
  A.nrows = nfree;
  A.rowPtr.assign(static_cast<std::size_t>(nfree) + 1, 0);
  for (int r = 0; r < nfree; ++r) {
    auto& cols = colsPerRow[r];
    std::sort(cols.begin(), cols.end());
    cols.erase(std::unique(cols.begin(), cols.end()), cols.end());
    A.rowPtr[r + 1] = A.rowPtr[r] + static_cast<std::int32_t>(cols.size());
  }
  const std::int32_t nnz = A.rowPtr[nfree];
  A.colIdx.assign(static_cast<std::size_t>(nnz), 0);
  A.values.assign(static_cast<std::size_t>(nnz), 0.0);
  for (int r = 0; r < nfree; ++r) {
    const auto& cols = colsPerRow[r];
    std::copy(cols.begin(), cols.end(), A.colIdx.begin() + A.rowPtr[r]);
  }
}

inline void build_pattern(
    const std::vector<ElementCache>& elements,
    const std::vector<std::int32_t>& freeIndexByDof,
    std::int32_t nfree,
    CsrMatrix& A) {
  build_pattern(elements, nullptr, freeIndexByDof, nfree, A);
}

// Find the index in row r where colIdx == c. Returns -1 if missing.
inline std::int32_t find_col(const CsrMatrix& A, std::int32_t r, std::int32_t c) {
  const std::int32_t lo = A.rowPtr[r];
  const std::int32_t hi = A.rowPtr[r + 1];
  std::int32_t a = lo;
  std::int32_t b = hi;
  while (a < b) {
    std::int32_t m = (a + b) >> 1;
    if (A.colIdx[m] < c) a = m + 1;
    else b = m;
  }
  if (a < hi && A.colIdx[a] == c) return a;
  return -1;
}

// Scatter a dense element matrix (nDofs × nDofs row major) into the CSR
// free-DOF system.
inline void scatter_element_matrix(
    CsrMatrix& A,
    const ElementCache& el,
    const std::vector<std::int32_t>& freeIndexByDof,
    const double* Ke) {
  const int n = el.numDofs;
  for (int i = 0; i < n; ++i) {
    const std::int32_t gi = el.dofs[i];
    const std::int32_t fi = freeIndexByDof[gi];
    if (fi < 0) continue;
    const std::int32_t lo = A.rowPtr[fi];
    const std::int32_t hi = A.rowPtr[fi + 1];
    for (int j = 0; j < n; ++j) {
      const std::int32_t gj = el.dofs[j];
      const std::int32_t fj = freeIndexByDof[gj];
      if (fj < 0) continue;
      // Search row for column fj.
      std::int32_t a = lo;
      std::int32_t b = hi;
      while (a < b) {
        std::int32_t m = (a + b) >> 1;
        if (A.colIdx[m] < fj) a = m + 1;
        else b = m;
      }
      A.values[a] += Ke[i * n + j];
    }
  }
}

inline void scatter_dense_matrix(
    CsrMatrix& A,
    const std::int32_t* dofs,
    int ndofs,
    const std::vector<std::int32_t>& freeIndexByDof,
    const double* Ke) {
  for (int i = 0; i < ndofs; ++i) {
    const std::int32_t gi = dofs[i];
    const std::int32_t fi = freeIndexByDof[gi];
    if (fi < 0) continue;
    const std::int32_t lo = A.rowPtr[fi];
    const std::int32_t hi = A.rowPtr[fi + 1];
    for (int j = 0; j < ndofs; ++j) {
      const std::int32_t gj = dofs[j];
      const std::int32_t fj = freeIndexByDof[gj];
      if (fj < 0) continue;
      std::int32_t a = lo;
      std::int32_t b = hi;
      while (a < b) {
        std::int32_t m = (a + b) >> 1;
        if (A.colIdx[m] < fj) a = m + 1;
        else b = m;
      }
      A.values[a] += Ke[i * ndofs + j];
    }
  }
}

// Scatter a dense element RHS into the free RHS.
inline void scatter_element_rhs(
    double* rhs,
    const ElementCache& el,
    const std::vector<std::int32_t>& freeIndexByDof,
    const double* fe) {
  for (int i = 0; i < el.numDofs; ++i) {
    const std::int32_t fi = freeIndexByDof[el.dofs[i]];
    if (fi < 0) continue;
    rhs[fi] += fe[i];
  }
}

inline void scatter_dense_rhs(
    double* rhs,
    const std::int32_t* dofs,
    int ndofs,
    const std::vector<std::int32_t>& freeIndexByDof,
    const double* fe) {
  for (int i = 0; i < ndofs; ++i) {
    const std::int32_t fi = freeIndexByDof[dofs[i]];
    if (fi < 0) continue;
    rhs[fi] += fe[i];
  }
}

// y = A * x (CSR).
inline void mat_vec(const CsrMatrix& A, const double* x, double* y) {
  const std::int32_t n = A.nrows;
  for (std::int32_t r = 0; r < n; ++r) {
    double s = 0.0;
    const std::int32_t lo = A.rowPtr[r];
    const std::int32_t hi = A.rowPtr[r + 1];
    for (std::int32_t k = lo; k < hi; ++k) s += A.values[k] * x[A.colIdx[k]];
    y[r] = s;
  }
}

inline double dot(const double* a, const double* b, std::int32_t n) {
  double s = 0.0;
  for (std::int32_t i = 0; i < n; ++i) s += a[i] * b[i];
  return s;
}

inline double norm2(const double* a, std::int32_t n) {
  return std::sqrt(dot(a, a, n));
}

// Build a 2×2 block-Jacobi preconditioner: at every free node whose Ux
// and Uy are both free, invert the 2×2 diagonal block. Otherwise fall
// back to scalar Jacobi (1/diag) per free DOF. The CPU JS path does the
// same, see buildBlockJacobiPreconditioner in solver.js.
inline void build_block_jacobi(
    const CsrMatrix& A,
    const std::vector<std::int32_t>& freeDofs,
    std::vector<double>& diag_inv) {
  const std::int32_t n = A.nrows;
  diag_inv.assign(static_cast<std::size_t>(n) * 4, 0.0);  // 4 entries per row (the 2×2 block containing it)
  // Map free DOF index -> node id + axis.
  // We tag pairs of consecutive free DOFs that come from the same node.
  for (std::int32_t i = 0; i < n; ++i) {
    diag_inv[i * 4 + 0] = 1.0;  // identity by default → scalar mode
    diag_inv[i * 4 + 1] = 0.0;
    diag_inv[i * 4 + 2] = 0.0;
    diag_inv[i * 4 + 3] = 1.0;
  }
  std::int32_t i = 0;
  while (i < n) {
    const std::int32_t globalI = freeDofs[i];
    const bool isUx = (globalI % 2) == 0;
    const bool hasNext = (i + 1) < n;
    const bool nextIsUyOfSameNode = hasNext && (freeDofs[i + 1] == globalI + 1) && isUx;
    if (nextIsUyOfSameNode) {
      // 2×2 block at (i, i), (i, i+1), (i+1, i), (i+1, i+1).
      const std::int32_t a_ii = find_col(A, i, i);
      const std::int32_t a_ij = find_col(A, i, i + 1);
      const std::int32_t a_ji = find_col(A, i + 1, i);
      const std::int32_t a_jj = find_col(A, i + 1, i + 1);
      const double aii = a_ii >= 0 ? A.values[a_ii] : 1.0;
      const double aij = a_ij >= 0 ? A.values[a_ij] : 0.0;
      const double aji = a_ji >= 0 ? A.values[a_ji] : 0.0;
      const double ajj = a_jj >= 0 ? A.values[a_jj] : 1.0;
      const double det = aii * ajj - aij * aji;
      if (std::fabs(det) > 1e-30) {
        const double inv = 1.0 / det;
        diag_inv[i * 4 + 0] = ajj * inv;
        diag_inv[i * 4 + 1] = -aij * inv;
        diag_inv[i * 4 + 2] = -aji * inv;
        diag_inv[i * 4 + 3] = aii * inv;
        diag_inv[(i + 1) * 4 + 0] = ajj * inv;
        diag_inv[(i + 1) * 4 + 1] = -aij * inv;
        diag_inv[(i + 1) * 4 + 2] = -aji * inv;
        diag_inv[(i + 1) * 4 + 3] = aii * inv;
      } else {
        diag_inv[i * 4 + 0] = std::fabs(aii) > 1e-30 ? 1.0 / aii : 1.0;
        diag_inv[i * 4 + 3] = 0.0;
        diag_inv[(i + 1) * 4 + 0] = std::fabs(ajj) > 1e-30 ? 1.0 / ajj : 1.0;
        diag_inv[(i + 1) * 4 + 3] = 0.0;
      }
      i += 2;
    } else {
      const std::int32_t a_ii = find_col(A, i, i);
      const double aii = a_ii >= 0 ? A.values[a_ii] : 1.0;
      diag_inv[i * 4 + 0] = std::fabs(aii) > 1e-30 ? 1.0 / aii : 1.0;
      diag_inv[i * 4 + 3] = 0.0;
      i += 1;
    }
  }
}

// z = M^{-1} * r using the 2×2 block-Jacobi (or scalar fallback).
// `diag_inv` packs the inverse blocks: 4 doubles per row. For rows that
// fell back to scalar mode the off-diagonals are zero.
inline void apply_block_jacobi(
    const std::vector<double>& diag_inv,
    const std::vector<std::int32_t>& freeDofs,
    const double* r,
    double* z,
    std::int32_t n) {
  std::int32_t i = 0;
  while (i < n) {
    const std::int32_t globalI = freeDofs[i];
    const bool isUx = (globalI % 2) == 0;
    const bool hasNext = (i + 1) < n;
    const bool nextIsUyOfSameNode = hasNext && (freeDofs[i + 1] == globalI + 1) && isUx;
    if (nextIsUyOfSameNode) {
      const double a = diag_inv[i * 4 + 0];
      const double b = diag_inv[i * 4 + 1];
      const double c = diag_inv[i * 4 + 2];
      const double d = diag_inv[i * 4 + 3];
      const double r0 = r[i];
      const double r1 = r[i + 1];
      z[i] = a * r0 + b * r1;
      z[i + 1] = c * r0 + d * r1;
      i += 2;
    } else {
      z[i] = diag_inv[i * 4 + 0] * r[i];
      i += 1;
    }
  }
}

}  // namespace madep::sparse
