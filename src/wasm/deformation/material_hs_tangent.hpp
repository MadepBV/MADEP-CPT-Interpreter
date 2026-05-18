// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hardening Soil Simo-Hughes tangent helpers.
//
// This header starts with the metric and dense-matrix utilities needed by the
// SH-0 residual-sensitivity oracle. Later phases add the closed-form cone,
// cap, and corner tangent builders here.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>

#include "linalg.hpp"
#include "types.hpp"

namespace madep::material::hs::tangent {

inline double stress_covector_dot_stress_vector(const Vec6& covector,
                                                const Vec6& stress_vector) {
  return covector[V_XX] * stress_vector[V_XX]
       + covector[V_YY] * stress_vector[V_YY]
       + covector[V_ZZ] * stress_vector[V_ZZ]
       + 2.0 * (covector[V_XY] * stress_vector[V_XY]
              + covector[V_YZ] * stress_vector[V_YZ]
              + covector[V_XZ] * stress_vector[V_XZ]);
}

inline Vec6 strain_vector_from_flow_tensor(const Vec6& flow_tensor) {
  return Vec6{
    flow_tensor[V_XX],
    flow_tensor[V_YY],
    flow_tensor[V_ZZ],
    2.0 * flow_tensor[V_XY],
    2.0 * flow_tensor[V_YZ],
    2.0 * flow_tensor[V_XZ]
  };
}

inline Vec6 transpose_tangent_times_stress_covector(
    const Mat6& tangent,
    const Vec6& stress_covector) {
  Vec6 out{};
  const double w[6] = {1.0, 1.0, 1.0, 2.0, 2.0, 2.0};
  for (int j = 0; j < 6; ++j) {
    double acc = 0.0;
    for (int i = 0; i < 6; ++i) {
      acc += w[i] * stress_covector[i] * tangent[i][j];
    }
    out[j] = acc;
  }
  return out;
}

inline Mat6 identity6() {
  Mat6 I{};
  for (int i = 0; i < 6; ++i) I[i][i] = 1.0;
  return I;
}

inline Mat6 invert_dense6(Mat6 A, bool& ok) {
  Mat6 inv = identity6();
  ok = true;

  for (int k = 0; k < 6; ++k) {
    int piv = k;
    double best = std::abs(A[k][k]);
    for (int i = k + 1; i < 6; ++i) {
      const double v = std::abs(A[i][k]);
      if (v > best) {
        best = v;
        piv = i;
      }
    }
    if (!(std::isfinite(best) && best > 1e-18)) {
      ok = false;
      return Mat6{};
    }
    if (piv != k) {
      std::swap(A[piv], A[k]);
      std::swap(inv[piv], inv[k]);
    }

    const double diag = A[k][k];
    for (int j = 0; j < 6; ++j) {
      A[k][j] /= diag;
      inv[k][j] /= diag;
    }

    for (int i = 0; i < 6; ++i) {
      if (i == k) continue;
      const double f = A[i][k];
      if (f == 0.0) continue;
      for (int j = 0; j < 6; ++j) {
        A[i][j] -= f * A[k][j];
        inv[i][j] -= f * inv[k][j];
      }
    }
  }

  for (int i = 0; i < 6 && ok; ++i) {
    for (int j = 0; j < 6 && ok; ++j) {
      ok = std::isfinite(inv[i][j]);
    }
  }
  return ok ? inv : Mat6{};
}

inline Mat6 compute_xi_dense(const Mat6& D_e,
                             const Mat6& dmdsigma,
                             double dlambda,
                             bool& ok) {
  bool inv_ok = false;
  Mat6 A = invert_dense6(D_e, inv_ok);
  if (!inv_ok) {
    ok = false;
    return D_e;
  }
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      A[i][j] += dlambda * dmdsigma[i][j];
    }
  }
  Mat6 Xi = invert_dense6(A, ok);
  return ok ? Xi : D_e;
}

inline Mat6 compute_xi_dense_two_surface(const Mat6& D_e,
                                         const Mat6& dms_dsigma,
                                         double dlambda_s,
                                         const Mat6& dmc_dsigma,
                                         double dlambda_c,
                                         bool& ok) {
  bool inv_ok = false;
  Mat6 A = invert_dense6(D_e, inv_ok);
  if (!inv_ok) {
    ok = false;
    return D_e;
  }
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      A[i][j] += dlambda_s * dms_dsigma[i][j]
              + dlambda_c * dmc_dsigma[i][j];
    }
  }
  Mat6 Xi = invert_dense6(A, ok);
  return ok ? Xi : D_e;
}

}  // namespace madep::material::hs::tangent
