// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small dense linear algebra: Voigt-6 vectors, 6×6 matrices, plane-strain
// elasticity, principal-stress decomposition. Everything we need before
// the CSR layer for assembly and the return-mapping local solver.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

#include "types.hpp"

namespace madep::linalg {

inline Vec6 zero6() { return Vec6{0.0, 0.0, 0.0, 0.0, 0.0, 0.0}; }
inline Mat6 zero6x6() { return Mat6{}; }
inline Mat3x3 zero3x3() { return Mat3x3{}; }

inline Vec6 add(const Vec6& a, const Vec6& b) {
  return Vec6{a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5]};
}
inline Vec6 sub(const Vec6& a, const Vec6& b) {
  return Vec6{a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5]};
}
inline Vec6 scale(const Vec6& a, double s) {
  return Vec6{a[0] * s, a[1] * s, a[2] * s, a[3] * s, a[4] * s, a[5] * s};
}
inline double dot6(const Vec6& a, const Vec6& b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 2.0 * (a[3] * b[3] + a[4] * b[4] + a[5] * b[5]);
}
inline double norm6(const Vec6& a) {
  return std::sqrt(dot6(a, a));
}

// y = M * x for 6×6 dense (Voigt order).
inline Vec6 mul6x6(const Mat6& M, const Vec6& x) {
  Vec6 r{};
  for (int i = 0; i < 6; ++i) {
    double s = 0.0;
    for (int j = 0; j < 6; ++j) s += M[i][j] * x[j];
    r[i] = s;
  }
  return r;
}

// Build the linear-isotropic elastic stiffness matrix in 6×6 Voigt form
// from Young modulus E and Poisson ratio ν. Convention: shear engineering
// strain γ = 2ε in the off-diagonals, so the shear-shear block is
// diag(G, G, G) without the factor of 2 that appears when using tensor
// strain.
inline Mat6 elastic_matrix_E_nu(double E, double nu) {
  E = std::max(E, 1.0);
  nu = std::clamp(nu, -0.99, 0.49);
  const double G = E / (2.0 * (1.0 + nu));
  const double K = E / (3.0 * (1.0 - 2.0 * nu));
  const double lam = K - (2.0 * G) / 3.0;
  Mat6 D{};
  D[0][0] = lam + 2.0 * G; D[0][1] = lam;             D[0][2] = lam;
  D[1][0] = lam;             D[1][1] = lam + 2.0 * G; D[1][2] = lam;
  D[2][0] = lam;             D[2][1] = lam;             D[2][2] = lam + 2.0 * G;
  D[3][3] = G; D[4][4] = G; D[5][5] = G;
  return D;
}

// Extract the 3×3 plane-strain tangent (σ_xx, σ_yy, τ_xy) from a full
// 6×6 Voigt tangent assuming plane-strain (ε_zz = γ_yz = γ_xz = 0).
inline std::array<std::array<double, 3>, 3> tangent2D_from_6x6(const Mat6& D) {
  return {{
    {D[0][0], D[0][1], D[0][3]},
    {D[1][0], D[1][1], D[1][3]},
    {D[3][0], D[3][1], D[3][3]}
  }};
}

// Lift a plane-strain strain triple (ε_xx, ε_yy, γ_xy) into Voigt-6.
inline Vec6 lift_strain_2D(double exx, double eyy, double gxy) {
  return Vec6{exx, eyy, 0.0, gxy, 0.0, 0.0};
}

// 3×3 symmetric eigenvalue / eigenvector decomposition via Jacobi
// iteration. Returns eigenvalues sorted descending. Used for principal
// stresses.
inline void jacobi_eig_3x3(const Mat3x3& Ain, Vec3& w, Mat3x3& V) {
  Mat3x3 A = Ain;
  V = Mat3x3{};
  V[0][0] = V[1][1] = V[2][2] = 1.0;
  constexpr int kMaxIter = 64;
  for (int sweep = 0; sweep < kMaxIter; ++sweep) {
    double off = 0.0;
    for (int p = 0; p < 3; ++p)
      for (int q = p + 1; q < 3; ++q)
        off += A[p][q] * A[p][q];
    if (off < 1e-30) break;
    for (int p = 0; p < 3; ++p) {
      for (int q = p + 1; q < 3; ++q) {
        const double apq = A[p][q];
        if (std::fabs(apq) < 1e-18) continue;
        const double app = A[p][p];
        const double aqq = A[q][q];
        const double theta = (aqq - app) / (2.0 * apq);
        double t;
        if (std::fabs(theta) > 1e15) {
          t = 1.0 / (2.0 * theta);
        } else {
          const double sgn = theta >= 0.0 ? 1.0 : -1.0;
          t = sgn / (std::fabs(theta) + std::sqrt(theta * theta + 1.0));
        }
        const double c = 1.0 / std::sqrt(1.0 + t * t);
        const double s = t * c;
        A[p][p] = app - t * apq;
        A[q][q] = aqq + t * apq;
        A[p][q] = 0.0;
        A[q][p] = 0.0;
        for (int r = 0; r < 3; ++r) {
          if (r == p || r == q) continue;
          const double arp = A[r][p];
          const double arq = A[r][q];
          A[r][p] = c * arp - s * arq;
          A[p][r] = A[r][p];
          A[r][q] = s * arp + c * arq;
          A[q][r] = A[r][q];
        }
        for (int r = 0; r < 3; ++r) {
          const double vrp = V[r][p];
          const double vrq = V[r][q];
          V[r][p] = c * vrp - s * vrq;
          V[r][q] = s * vrp + c * vrq;
        }
      }
    }
  }
  w[0] = A[0][0];
  w[1] = A[1][1];
  w[2] = A[2][2];

  // Sort descending by eigenvalue.
  int idx[3] = {0, 1, 2};
  if (w[idx[1]] > w[idx[0]]) std::swap(idx[0], idx[1]);
  if (w[idx[2]] > w[idx[0]]) std::swap(idx[0], idx[2]);
  if (w[idx[2]] > w[idx[1]]) std::swap(idx[1], idx[2]);
  Vec3 wsorted{w[idx[0]], w[idx[1]], w[idx[2]]};
  Mat3x3 Vsorted{};
  for (int r = 0; r < 3; ++r) {
    for (int c = 0; c < 3; ++c) Vsorted[r][c] = V[r][idx[c]];
  }
  w = wsorted;
  V = Vsorted;
}

// Build the 3×3 stress tensor from a Voigt-6 stress (tension positive).
inline Mat3x3 stress_tensor_from_voigt(const Vec6& s) {
  Mat3x3 T{};
  T[0][0] = s[V_XX];
  T[1][1] = s[V_YY];
  T[2][2] = s[V_ZZ];
  T[0][1] = T[1][0] = s[V_XY];
  T[1][2] = T[2][1] = s[V_YZ];
  T[0][2] = T[2][0] = s[V_XZ];
  return T;
}

// Build a Voigt-6 stress from a 3×3 tensor (assumed symmetric).
inline Vec6 voigt_from_stress_tensor(const Mat3x3& T) {
  Vec6 s{};
  s[V_XX] = T[0][0];
  s[V_YY] = T[1][1];
  s[V_ZZ] = T[2][2];
  s[V_XY] = 0.5 * (T[0][1] + T[1][0]);
  s[V_YZ] = 0.5 * (T[1][2] + T[2][1]);
  s[V_XZ] = 0.5 * (T[0][2] + T[2][0]);
  return s;
}

// σ = V * diag(w) * V^T.
inline Mat3x3 reassemble_symmetric(const Vec3& w, const Mat3x3& V) {
  Mat3x3 T{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      double s = 0.0;
      for (int k = 0; k < 3; ++k) s += V[i][k] * w[k] * V[j][k];
      T[i][j] = s;
    }
  }
  return T;
}

}  // namespace madep::linalg
