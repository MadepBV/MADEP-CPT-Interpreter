// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compressed Sparse Row sparse linear algebra: build pattern from element
// caches, assemble values, sparse mat-vec, and a block-Jacobi
// preconditioner keyed on free DOFs.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "element.hpp"
#include "types.hpp"

namespace madep::sparse {

inline constexpr int kBlockJacobiStride = 18;
inline constexpr int kBlockJacobiModeOffset = 4;
inline constexpr int kBlockJacobiLocalOffset = 5;
inline constexpr int kBlockJacobiIndexOffset = 6;
inline constexpr int kBlockJacobiInv3Offset = 9;
inline constexpr double kBlockJacobiModeWall3 = 1.0;
inline constexpr double kBlockJacobiModeDense = 2.0;

// Build the global free-DOF CSR sparsity pattern from the element
// caches. `freeIndexByDof[fullDof]` maps a global DOF index to its
// position in the free DOF list, or -1 if the DOF is fixed.
inline void build_pattern(
    const std::vector<ElementCache>& elements,
    const std::vector<BeamElementCache>* beamElements,
    const std::vector<std::int32_t>& freeIndexByDof,
    std::int32_t nfree,
    CsrMatrix& A,
    // Optional extra coupled-DOF quads (zero-thickness soil-wall interface
    // node-pairs: [soil ux, soil uy, wall ux, wall uy]). Each quad inserts its
    // full 4×4 coupling block into the pattern. nullptr/empty → unchanged.
    const std::vector<std::array<std::int32_t, 4>>* extraDofQuads = nullptr) {
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
  if (extraDofQuads) {
    for (const auto& quad : *extraDofQuads) add_dofs(quad.data(), 4);
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

inline bool invert_spd3_cholesky(const double* A, double* invA) {
  const double scale = std::max({
      std::abs(A[0]), std::abs(A[1]), std::abs(A[2]),
      std::abs(A[4]), std::abs(A[5]), std::abs(A[8]), 1.0});
  const double tol = std::max(1e-30, 1e-12 * scale);
  if (!(A[0] > tol)) return false;
  const double l00 = std::sqrt(A[0]);
  const double l10 = A[3] / l00;
  const double l20 = A[6] / l00;
  const double d11 = A[4] - l10 * l10;
  if (!(d11 > tol)) return false;
  const double l11 = std::sqrt(d11);
  const double l21 = (A[7] - l20 * l10) / l11;
  const double d22 = A[8] - l20 * l20 - l21 * l21;
  if (!(d22 > tol)) return false;
  const double l22 = std::sqrt(d22);

  for (int col = 0; col < 3; ++col) {
    const double e0 = col == 0 ? 1.0 : 0.0;
    const double e1 = col == 1 ? 1.0 : 0.0;
    const double e2 = col == 2 ? 1.0 : 0.0;
    const double y0 = e0 / l00;
    const double y1 = (e1 - l10 * y0) / l11;
    const double y2 = (e2 - l20 * y0 - l21 * y1) / l22;
    const double x2 = y2 / l22;
    const double x1 = (y1 - l21 * x2) / l11;
    const double x0 = (y0 - l10 * x1 - l20 * x2) / l00;
    invA[0 * 3 + col] = x0;
    invA[1 * 3 + col] = x1;
    invA[2 * 3 + col] = x2;
  }

  for (int i = 0; i < 3; ++i) {
    for (int j = i + 1; j < 3; ++j) {
      const double s = 0.5 * (invA[i * 3 + j] + invA[j * 3 + i]);
      invA[i * 3 + j] = s;
      invA[j * 3 + i] = s;
    }
  }
  return true;
}

inline bool invert_spd_dense_cholesky(
    const std::vector<double>& A,
    int n,
    std::vector<double>& invA) {
  invA.assign(static_cast<std::size_t>(n) * n, 0.0);
  if (n <= 0) return false;
  std::vector<double> L(static_cast<std::size_t>(n) * n, 0.0);
  double scale = 1.0;
  for (double v : A) scale = std::max(scale, std::abs(v));
  const double tol = std::max(1e-30, 1e-12 * scale);

  for (int i = 0; i < n; ++i) {
    for (int j = 0; j <= i; ++j) {
      double sum = A[static_cast<std::size_t>(i) * n + j];
      for (int k = 0; k < j; ++k) {
        sum -= L[static_cast<std::size_t>(i) * n + k] *
               L[static_cast<std::size_t>(j) * n + k];
      }
      if (i == j) {
        if (!(sum > tol)) return false;
        L[static_cast<std::size_t>(i) * n + j] = std::sqrt(sum);
      } else {
        const double ljj = L[static_cast<std::size_t>(j) * n + j];
        if (!(std::abs(ljj) > tol)) return false;
        L[static_cast<std::size_t>(i) * n + j] = sum / ljj;
      }
    }
  }

  std::vector<double> y(static_cast<std::size_t>(n), 0.0);
  for (int col = 0; col < n; ++col) {
    std::fill(y.begin(), y.end(), 0.0);
    for (int i = 0; i < n; ++i) {
      double sum = (i == col) ? 1.0 : 0.0;
      for (int k = 0; k < i; ++k) sum -= L[static_cast<std::size_t>(i) * n + k] * y[k];
      y[i] = sum / L[static_cast<std::size_t>(i) * n + i];
    }
    for (int i = n - 1; i >= 0; --i) {
      double sum = y[i];
      for (int k = i + 1; k < n; ++k) {
        sum -= L[static_cast<std::size_t>(k) * n + i] *
               invA[static_cast<std::size_t>(k) * n + col];
      }
      invA[static_cast<std::size_t>(i) * n + col] =
          sum / L[static_cast<std::size_t>(i) * n + i];
    }
  }

  for (int i = 0; i < n; ++i) {
    for (int j = i + 1; j < n; ++j) {
      const double s = 0.5 * (
          invA[static_cast<std::size_t>(i) * n + j] +
          invA[static_cast<std::size_t>(j) * n + i]);
      invA[static_cast<std::size_t>(i) * n + j] = s;
      invA[static_cast<std::size_t>(j) * n + i] = s;
    }
  }
  return true;
}

// Build a block-Jacobi preconditioner. The default block is the existing
// soil-node 2×2 (Ux, Uy) inverse, with scalar fallback for unpaired DOFs.
// Active wall nodes may supply an additional guarded 3×3 (Ux, Uy, theta_z)
// block; it is accepted only if the extracted symmetric local block is SPD.
inline void build_block_jacobi(
    const CsrMatrix& A,
    const std::vector<std::int32_t>& freeDofs,
    std::vector<double>& diag_inv,
    const std::vector<std::array<std::int32_t, 3>>* wallTriplets = nullptr,
    const std::vector<std::vector<std::int32_t>>* wallDenseBlocks = nullptr) {
  const std::int32_t n = A.nrows;
  diag_inv.assign(static_cast<std::size_t>(n) * kBlockJacobiStride, 0.0);
  // Map free DOF index -> node id + axis.
  // We tag pairs of consecutive free DOFs that come from the same node.
  for (std::int32_t i = 0; i < n; ++i) {
    const std::size_t row = static_cast<std::size_t>(i) * kBlockJacobiStride;
    diag_inv[row + 0] = 1.0;  // identity by default -> scalar mode
    diag_inv[row + 1] = 0.0;
    diag_inv[row + 2] = 0.0;
    diag_inv[row + 3] = 1.0;
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
      const std::size_t row0 = static_cast<std::size_t>(i) * kBlockJacobiStride;
      const std::size_t row1 = static_cast<std::size_t>(i + 1) * kBlockJacobiStride;
      if (std::fabs(det) > 1e-30) {
        const double inv = 1.0 / det;
        diag_inv[row0 + 0] = ajj * inv;
        diag_inv[row0 + 1] = -aij * inv;
        diag_inv[row0 + 2] = -aji * inv;
        diag_inv[row0 + 3] = aii * inv;
        diag_inv[row1 + 0] = ajj * inv;
        diag_inv[row1 + 1] = -aij * inv;
        diag_inv[row1 + 2] = -aji * inv;
        diag_inv[row1 + 3] = aii * inv;
      } else {
        diag_inv[row0 + 0] = std::fabs(aii) > 1e-30 ? 1.0 / aii : 1.0;
        diag_inv[row0 + 3] = 0.0;
        diag_inv[row1 + 0] = std::fabs(ajj) > 1e-30 ? 1.0 / ajj : 1.0;
        diag_inv[row1 + 3] = 0.0;
      }
      i += 2;
    } else {
      const std::int32_t a_ii = find_col(A, i, i);
      const double aii = a_ii >= 0 ? A.values[a_ii] : 1.0;
      const std::size_t row = static_cast<std::size_t>(i) * kBlockJacobiStride;
      diag_inv[row + 0] = std::fabs(aii) > 1e-30 ? 1.0 / aii : 1.0;
      diag_inv[row + 3] = 0.0;
      i += 1;
    }
  }

  if (!wallTriplets) return;
  for (const auto& triplet : *wallTriplets) {
    const std::int32_t i0 = triplet[0];
    const std::int32_t i1 = triplet[1];
    const std::int32_t i2 = triplet[2];
    if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= n || i1 >= n || i2 >= n ||
        i0 == i1 || i0 == i2 || i1 == i2) {
      continue;
    }
    const std::int32_t idx[3]{i0, i1, i2};
    double block[9]{};
    bool present = true;
    for (int r = 0; r < 3 && present; ++r) {
      for (int c = r; c < 3 && present; ++c) {
        const std::int32_t a_rc = find_col(A, idx[r], idx[c]);
        const std::int32_t a_cr = find_col(A, idx[c], idx[r]);
        if (a_rc < 0 || a_cr < 0) {
          present = false;
          break;
        }
        const double sym = 0.5 * (A.values[a_rc] + A.values[a_cr]);
        block[r * 3 + c] = sym;
        block[c * 3 + r] = sym;
      }
    }
    if (!present) continue;
    double inv3[9]{};
    if (!invert_spd3_cholesky(block, inv3)) continue;
    for (int local = 0; local < 3; ++local) {
      const std::size_t row = static_cast<std::size_t>(idx[local]) * kBlockJacobiStride;
      diag_inv[row + kBlockJacobiModeOffset] = kBlockJacobiModeWall3;
      diag_inv[row + kBlockJacobiLocalOffset] = static_cast<double>(local);
      diag_inv[row + kBlockJacobiIndexOffset + 0] = static_cast<double>(i0);
      diag_inv[row + kBlockJacobiIndexOffset + 1] = static_cast<double>(i1);
      diag_inv[row + kBlockJacobiIndexOffset + 2] = static_cast<double>(i2);
      for (int k = 0; k < 9; ++k) {
        diag_inv[row + kBlockJacobiInv3Offset + k] = inv3[k];
      }
    }
  }

  if (!wallDenseBlocks) return;
  for (const auto& rawBlock : *wallDenseBlocks) {
    std::vector<std::int32_t> block = rawBlock;
    block.erase(std::remove_if(block.begin(), block.end(), [&](std::int32_t idx) {
      return idx < 0 || idx >= n;
    }), block.end());
    block.erase(std::unique(block.begin(), block.end()), block.end());
    const int m = static_cast<int>(block.size());
    if (m < 3 || m > 256) continue;

    std::vector<double> Ablock(static_cast<std::size_t>(m) * m, 0.0);
    bool present = true;
    for (int r = 0; r < m && present; ++r) {
      for (int c = r; c < m && present; ++c) {
        const std::int32_t a_rc = find_col(A, block[r], block[c]);
        const std::int32_t a_cr = find_col(A, block[c], block[r]);
        if (r == c && a_rc < 0) {
          present = false;
          break;
        }
        const double v_rc = a_rc >= 0 ? A.values[a_rc] : 0.0;
        const double v_cr = a_cr >= 0 ? A.values[a_cr] : 0.0;
        const double sym = 0.5 * (v_rc + v_cr);
        Ablock[static_cast<std::size_t>(r) * m + c] = sym;
        Ablock[static_cast<std::size_t>(c) * m + r] = sym;
      }
    }
    if (!present) continue;

    std::vector<double> invBlock;
    if (!invert_spd_dense_cholesky(Ablock, m, invBlock)) continue;

    const std::size_t indexOffset = diag_inv.size();
    for (std::int32_t idx : block) diag_inv.push_back(static_cast<double>(idx));
    const std::size_t invOffset = diag_inv.size();
    diag_inv.insert(diag_inv.end(), invBlock.begin(), invBlock.end());

    for (int local = 0; local < m; ++local) {
      const std::size_t row = static_cast<std::size_t>(block[local]) * kBlockJacobiStride;
      diag_inv[row + kBlockJacobiModeOffset] = kBlockJacobiModeDense;
      diag_inv[row + kBlockJacobiLocalOffset] = static_cast<double>(local);
      diag_inv[row + kBlockJacobiIndexOffset + 0] = static_cast<double>(m);
      diag_inv[row + kBlockJacobiIndexOffset + 1] = static_cast<double>(indexOffset);
      diag_inv[row + kBlockJacobiIndexOffset + 2] = static_cast<double>(invOffset);
    }
  }
}

// z = M^{-1} * r using the 3×3 wall block, 2×2 soil block, or scalar fallback.
inline void apply_block_jacobi(
    const std::vector<double>& diag_inv,
    const std::vector<std::int32_t>& freeDofs,
    const double* r,
    double* z,
    std::int32_t n) {
  const bool extended =
      diag_inv.size() >= static_cast<std::size_t>(n) * kBlockJacobiStride;
  const int stride = extended ? kBlockJacobiStride : 4;
  std::int32_t i = 0;
  while (i < n) {
    const std::size_t row = static_cast<std::size_t>(i) * stride;
    if (extended && diag_inv[row + kBlockJacobiModeOffset] == kBlockJacobiModeDense) {
      const int local = std::max(
          0, static_cast<int>(diag_inv[row + kBlockJacobiLocalOffset]));
      const int m = std::max(
          0, static_cast<int>(diag_inv[row + kBlockJacobiIndexOffset + 0]));
      const std::size_t indexOffset = static_cast<std::size_t>(
          std::max(0.0, diag_inv[row + kBlockJacobiIndexOffset + 1]));
      const std::size_t invOffset = static_cast<std::size_t>(
          std::max(0.0, diag_inv[row + kBlockJacobiIndexOffset + 2]));
      if (m > 0 && local < m &&
          indexOffset + static_cast<std::size_t>(m) <= diag_inv.size() &&
          invOffset + static_cast<std::size_t>(m) * m <= diag_inv.size()) {
        double zi = 0.0;
        const std::size_t invRow = invOffset + static_cast<std::size_t>(local) * m;
        for (int k = 0; k < m; ++k) {
          const std::int32_t j = static_cast<std::int32_t>(diag_inv[indexOffset + k]);
          if (j >= 0 && j < n) zi += diag_inv[invRow + k] * r[j];
        }
        z[i] = zi;
        i += 1;
        continue;
      }
    }
    if (extended && diag_inv[row + kBlockJacobiModeOffset] == kBlockJacobiModeWall3) {
      const int local = std::clamp(
          static_cast<int>(diag_inv[row + kBlockJacobiLocalOffset]), 0, 2);
      const std::int32_t j0 = static_cast<std::int32_t>(diag_inv[row + kBlockJacobiIndexOffset + 0]);
      const std::int32_t j1 = static_cast<std::int32_t>(diag_inv[row + kBlockJacobiIndexOffset + 1]);
      const std::int32_t j2 = static_cast<std::int32_t>(diag_inv[row + kBlockJacobiIndexOffset + 2]);
      if (j0 >= 0 && j1 >= 0 && j2 >= 0 && j0 < n && j1 < n && j2 < n) {
        const std::size_t inv = row + kBlockJacobiInv3Offset + static_cast<std::size_t>(local) * 3;
        z[i] = diag_inv[inv + 0] * r[j0] +
               diag_inv[inv + 1] * r[j1] +
               diag_inv[inv + 2] * r[j2];
        i += 1;
        continue;
      }
    }
    const std::int32_t globalI = freeDofs[i];
    const bool isUx = (globalI % 2) == 0;
    const bool hasNext = (i + 1) < n;
    const bool nextIsUyOfSameNode = hasNext && (freeDofs[i + 1] == globalI + 1) && isUx;
    if (nextIsUyOfSameNode) {
      const double a = diag_inv[row + 0];
      const double b = diag_inv[row + 1];
      const double c = diag_inv[row + 2];
      const double d = diag_inv[row + 3];
      const double r0 = r[i];
      const double r1 = r[i + 1];
      z[i] = a * r0 + b * r1;
      z[i + 1] = c * r0 + d * r1;
      i += 2;
    } else {
      z[i] = diag_inv[row + 0] * r[i];
      i += 1;
    }
  }
}

// =============================================================================
// Two-level / deflated coarse correction (workstream A).
//
// Carries the retaining-wall rigid-body modes as an exact additive coarse
// space layered on top of the block-Jacobi smoother:
//
//   M2L^{-1} = M_BJ^{-1} + Z * Kc^{-1} * Z^T,   Kc = Z^T A Z.
//
// This is preconditioning/deflation ONLY — it changes the Krylov path, never
// the fixed point x = A^{-1} b. The stopping test in the solvers is unchanged
// (raw residual), so the accepted solution is identical to within tolerance
// regardless of whether the coarse correction is active.
// =============================================================================

// One sparse coarse column: free-DOF rows with their coefficients.
struct CoarseColumn {
  std::vector<std::int32_t> rows;
  std::vector<double> vals;
};

// The wall rigid-body coarse space Z (n × k). Built deterministically from
// the sorted beam DOF sets; columns with no entries are dropped at build.
struct WallCoarseSpace {
  std::int32_t n{ 0 };
  std::vector<CoarseColumn> columns;
  inline bool empty() const { return columns.empty(); }
  inline int k() const { return static_cast<int>(columns.size()); }
};

// The assembled coarse operator: the (possibly scaled) effective columns Zc
// together with the dense inverse of Kc = Zc^T A Zc.
struct TwoLevelCoarseOp {
  int k{ 0 };
  std::vector<CoarseColumn> Zcols;   // effective columns used by the apply
  std::vector<double> KcInv;         // k×k row-major symmetric inverse
  bool active{ false };
  mutable std::vector<double> scratchC;  // length k, reused per apply
  mutable std::vector<double> scratchD;  // length k, reused per apply
};

// Form Kc = Zc^T A Zc and dense-factor it with a guarded SPD Cholesky.
//
//   * `colScaleInv` (optional, length n): when non-null the effective columns
//     are Zc = diag(colScaleInv) * Z. The GMRES path passes 1/col_scale so the
//     coarse space lives in the column-scaled variable; CG passes nullptr.
//   * `symmetrize`: replace Kc by its symmetric part ½(Kc+Kcᵀ) before the
//     Cholesky. Mandatory for the unsymmetric (GMRES) operator; harmless for
//     the symmetric CG operator.
//
// On a Cholesky failure (yielded soil makes Kc indefinite) a tiny diagonal
// shift is applied to Kc ONLY — never to A — and on persistent failure the
// op is left inactive so the caller falls back to plain block-Jacobi.
inline bool build_two_level_coarse_op(
    const CsrMatrix& A,
    const WallCoarseSpace& Z,
    const double* colScaleInv,
    bool symmetrize,
    TwoLevelCoarseOp& op) {
  op.active = false;
  op.k = 0;
  op.Zcols.clear();
  op.KcInv.clear();
  const int n = A.nrows;
  if (Z.k() <= 0 || n <= 0) return false;

  // Effective columns (optionally column-scaled), dropping empty columns.
  std::vector<CoarseColumn> cols;
  cols.reserve(static_cast<std::size_t>(Z.k()));
  for (const auto& src : Z.columns) {
    CoarseColumn c;
    c.rows.reserve(src.rows.size());
    c.vals.reserve(src.rows.size());
    for (std::size_t e = 0; e < src.rows.size(); ++e) {
      const std::int32_t row = src.rows[e];
      if (row < 0 || row >= n) continue;
      double v = src.vals[e];
      if (colScaleInv) v *= colScaleInv[row];
      if (v != 0.0) { c.rows.push_back(row); c.vals.push_back(v); }
    }
    if (!c.rows.empty()) {
      // Normalise each effective column to unit 2-norm. The coarse correction
      // Z·Kc⁻¹·Zᵀ is exactly invariant under per-column scaling of Z, so this
      // does not change the symmetric (CG) operator at all; it only rebalances
      // the SYMMETRISED Kc on the unsymmetric (GMRES, column-equilibrated)
      // operator, where the 1/col_scale factor would otherwise leave the stiff
      // wall DOFs dominating the symmetrisation.
      double nrm = 0.0;
      for (double v : c.vals) nrm += v * v;
      nrm = std::sqrt(nrm);
      if (nrm > 0.0) {
        const double inv = 1.0 / nrm;
        for (double& v : c.vals) v *= inv;
      }
      cols.push_back(std::move(c));
    }
  }
  const int k = static_cast<int>(cols.size());
  if (k <= 0) return false;

  std::vector<double> zfull(static_cast<std::size_t>(n), 0.0);
  std::vector<double> az(static_cast<std::size_t>(n), 0.0);
  std::vector<double> Kc(static_cast<std::size_t>(k) * k, 0.0);
  for (int j = 0; j < k; ++j) {
    std::fill(zfull.begin(), zfull.end(), 0.0);
    for (std::size_t e = 0; e < cols[j].rows.size(); ++e) {
      zfull[static_cast<std::size_t>(cols[j].rows[e])] = cols[j].vals[e];
    }
    mat_vec(A, zfull.data(), az.data());
    for (int i = 0; i < k; ++i) {
      double s = 0.0;
      const auto& ci = cols[i];
      for (std::size_t e = 0; e < ci.rows.size(); ++e) {
        s += ci.vals[e] * az[static_cast<std::size_t>(ci.rows[e])];
      }
      Kc[static_cast<std::size_t>(i) * k + j] = s;
    }
  }

  if (symmetrize) {
    for (int i = 0; i < k; ++i) {
      for (int j = i + 1; j < k; ++j) {
        const double s = 0.5 * (Kc[static_cast<std::size_t>(i) * k + j] +
                                Kc[static_cast<std::size_t>(j) * k + i]);
        Kc[static_cast<std::size_t>(i) * k + j] = s;
        Kc[static_cast<std::size_t>(j) * k + i] = s;
      }
    }
  }

  std::vector<double> KcInv;
  bool ok = invert_spd_dense_cholesky(Kc, k, KcInv);
  if (!ok) {
    double maxDiag = 0.0;
    for (int i = 0; i < k; ++i) {
      maxDiag = std::max(maxDiag, std::abs(Kc[static_cast<std::size_t>(i) * k + i]));
    }
    if (maxDiag > 0.0) {
      for (double mult : {1e-12, 1e-10, 1e-8, 1e-6, 1e-4}) {
        std::vector<double> shifted = Kc;
        const double shift = mult * maxDiag;
        for (int i = 0; i < k; ++i) shifted[static_cast<std::size_t>(i) * k + i] += shift;
        if (invert_spd_dense_cholesky(shifted, k, KcInv)) { ok = true; break; }
      }
    }
    if (!ok) return false;
  }

  op.k = k;
  op.Zcols = std::move(cols);
  op.KcInv = std::move(KcInv);
  op.scratchC.assign(static_cast<std::size_t>(k), 0.0);
  op.scratchD.assign(static_cast<std::size_t>(k), 0.0);
  op.active = true;
  return true;
}

// z += Z * (Kc^{-1} * (Z^T r)). Additive on top of the block-Jacobi smooth.
inline void apply_coarse_correction(
    const TwoLevelCoarseOp& op,
    const double* r,
    double* z) {
  if (!op.active || op.k <= 0) return;
  const int k = op.k;
  std::vector<double>& c = op.scratchC;
  std::vector<double>& d = op.scratchD;
  for (int j = 0; j < k; ++j) {
    double s = 0.0;
    const auto& col = op.Zcols[static_cast<std::size_t>(j)];
    for (std::size_t e = 0; e < col.rows.size(); ++e) {
      s += col.vals[e] * r[static_cast<std::size_t>(col.rows[e])];
    }
    c[static_cast<std::size_t>(j)] = s;
  }
  for (int i = 0; i < k; ++i) {
    double s = 0.0;
    const double* krow = &op.KcInv[static_cast<std::size_t>(i) * k];
    for (int j = 0; j < k; ++j) s += krow[j] * c[static_cast<std::size_t>(j)];
    d[static_cast<std::size_t>(i)] = s;
  }
  for (int j = 0; j < k; ++j) {
    const double dj = d[static_cast<std::size_t>(j)];
    if (dj == 0.0) continue;
    const auto& col = op.Zcols[static_cast<std::size_t>(j)];
    for (std::size_t e = 0; e < col.rows.size(); ++e) {
      z[static_cast<std::size_t>(col.rows[e])] += col.vals[e] * dj;
    }
  }
}

}  // namespace madep::sparse
