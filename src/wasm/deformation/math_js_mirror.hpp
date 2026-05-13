// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1:1 mirror of the JS math / projector / strain helpers in
// src/lib/cpt-app/deformation/material-models.js. Function names are
// the snake_case form of the JS names so cross-checking against the
// reference is mechanical. JS source line numbers are noted as
// `// JS:###` in each comment.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

#include "types.hpp"

namespace madep::js_mirror {

// -----------------------------------------------------------------------------
// VOIGT slot indices (JS:8-13).
// -----------------------------------------------------------------------------
inline constexpr std::size_t VOIGT_XX = 0;
inline constexpr std::size_t VOIGT_YY = 1;
inline constexpr std::size_t VOIGT_ZZ = 2;
inline constexpr std::size_t VOIGT_XY = 3;
inline constexpr std::size_t VOIGT_YZ = 4;
inline constexpr std::size_t VOIGT_XZ = 5;

// -----------------------------------------------------------------------------
// Yield-surface labels (JS:15-21). String-equivalent in C++ as enum codes.
// -----------------------------------------------------------------------------
enum class YieldSurface : std::uint8_t {
  NONE = 0,
  MC_SHEAR,
  MC_FACE,
  MC_EDGE,
  MC_APEX,
  TENSION,
  COMPRESSION_CAP
};

// -----------------------------------------------------------------------------
// Branch-kind labels (JS:23-35).
// -----------------------------------------------------------------------------
enum class BranchKind : std::uint8_t {
  ELASTIC = 0,
  FACE_F13,
  EDGE_S23_EQUAL,
  EDGE_S12_EQUAL,
  APEX_FORMAL,
  TENSION_PENDING,
  TENSION_FACE_T3,
  TENSION_EDGE_T23,
  TENSION_EDGE_F13_T3,
  TENSION_CORNER_S23_T3,
  TENSION_CORNER_S12_T3,
  TENSION_APEX_T123,
  FALLBACK_SMOOTH
};

// -----------------------------------------------------------------------------
// Multiplicity-kind labels (JS:937 multiplicityKindFromBranchKind).
// -----------------------------------------------------------------------------
enum class MultiplicityKind : std::uint8_t {
  DISTINCT = 0,
  S23_EQUAL,
  S12_EQUAL,
  ALL_EQUAL
};

// Type aliases used in the JS reference.
using Vec3 = std::array<double, 3>;
using Mat3 = std::array<std::array<double, 3>, 3>;
// Vec6 / Mat6 come from types.hpp.

// -----------------------------------------------------------------------------
// JS:37 zeroVector6
// -----------------------------------------------------------------------------
inline Vec6 zero_vector6() {
  return Vec6{0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
}

// JS:41 cloneVector6 — defensive (Number(x) || 0) coercion mirrors the
// JS but is a no-op when inputs are already double.
inline Vec6 clone_vector6(const Vec6& v) { return v; }

// JS:53 cloneMatrix6
inline Mat6 clone_matrix6(const Mat6& m) { return m; }

// JS:60 addVector6
inline Vec6 add_vector6(const Vec6& a, const Vec6& b) {
  return Vec6{a[0] + b[0], a[1] + b[1], a[2] + b[2],
              a[3] + b[3], a[4] + b[4], a[5] + b[5]};
}

// JS:71 scaleVector6
inline Vec6 scale_vector6(const Vec6& a, double f) {
  return Vec6{a[0] * f, a[1] * f, a[2] * f, a[3] * f, a[4] * f, a[5] * f};
}

// JS:82 subtractVector6
inline Vec6 subtract_vector6(const Vec6& a, const Vec6& b) {
  return Vec6{a[0] - b[0], a[1] - b[1], a[2] - b[2],
              a[3] - b[3], a[4] - b[4], a[5] - b[5]};
}

// JS:93 addPorePressureToNormalComponents
inline Vec6 add_pore_pressure_to_normal_components(const Vec6& s, double u) {
  const double u0 = std::max(u, 0.0);
  Vec6 out = s;
  out[VOIGT_XX] += u0;
  out[VOIGT_YY] += u0;
  out[VOIGT_ZZ] += u0;
  return out;
}

// JS:102 descendingNumeric — used as a sort comparator.
inline bool descending_numeric_cmp(double left, double right) {
  // JS Array.prototype.sort callback returns (right - left); negative
  // keeps order, positive swaps. For std::sort we return whether
  // `left` should come before `right` — i.e., true if left > right.
  return left > right;
}

// JS:106 zeroMatrix3
inline Mat3 zero_matrix3() { return Mat3{}; }

// JS:114 cloneMatrix3
inline Mat3 clone_matrix3(const Mat3& m) { return m; }

// JS:121 cloneVector3
inline Vec3 clone_vector3(const Vec3& v) { return v; }

// JS:130 addVector3
inline Vec3 add_vector3(const Vec3& a, const Vec3& b) {
  return Vec3{a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

// JS:138 subtractVector3
inline Vec3 subtract_vector3(const Vec3& a, const Vec3& b) {
  return Vec3{a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

// JS:146 scaleVector3
inline Vec3 scale_vector3(const Vec3& v, double f) {
  return Vec3{v[0] * f, v[1] * f, v[2] * f};
}

// JS:154 dotVector3
inline double dot_vector3(const Vec3& a, const Vec3& b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// JS:162 crossVector3
inline Vec3 cross_vector3(const Vec3& a, const Vec3& b) {
  return Vec3{
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  };
}

// JS:170 vectorNorm3
inline double vector_norm3(const Vec3& v) {
  return std::sqrt(dot_vector3(v, v));
}

// JS:174 multiplyMatrix3x3Vector3
inline Vec3 multiply_matrix3x3_vector3(const Mat3& M, const Vec3& v) {
  return Vec3{
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]
  };
}

// JS:188 outerProduct3
inline Mat3 outer_product3(const Vec3& a, const Vec3& b) {
  return Mat3{{
    {a[0] * b[0], a[0] * b[1], a[0] * b[2]},
    {a[1] * b[0], a[1] * b[1], a[1] * b[2]},
    {a[2] * b[0], a[2] * b[1], a[2] * b[2]}
  }};
}

// JS:208 addMatrix3
inline Mat3 add_matrix3(const Mat3& a, const Mat3& b) {
  Mat3 out{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) out[i][j] = a[i][j] + b[i][j];
  return out;
}

// JS:216 scaleMatrix3
inline Mat3 scale_matrix3(const Mat3& m, double f) {
  Mat3 out{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) out[i][j] = m[i][j] * f;
  return out;
}

// JS:270 normalizeVector3 (defined out of order in JS; placed here so
// it's available to principalDirectionToProjector below).
inline Vec3 normalize_vector3(const Vec3& v, const Vec3& fallback = Vec3{1.0, 0.0, 0.0}) {
  const double n = vector_norm3(v);
  if (!(n > 1e-12)) return fallback;
  return scale_vector3(v, 1.0 / n);
}

// JS:224 principalDirectionToProjector
inline Mat3 principal_direction_to_projector(const Vec3& v) {
  const double n = vector_norm3(v);
  if (!(n > 1e-12)) return zero_matrix3();
  const Vec3 u = scale_vector3(v, 1.0 / n);
  return outer_product3(u, u);
}

// JS:231 rankOneProjectorToDirection
inline Vec3 rank_one_projector_to_direction(const Mat3& projector,
                                            const Vec3& fallback = Vec3{1.0, 0.0, 0.0}) {
  std::array<Vec3, 3> cols{
    Vec3{projector[0][0], projector[1][0], projector[2][0]},
    Vec3{projector[0][1], projector[1][1], projector[2][1]},
    Vec3{projector[0][2], projector[1][2], projector[2][2]}
  };
  double bestNorm = 0.0;
  int bestIdx = -1;
  for (int i = 0; i < 3; ++i) {
    const double n = vector_norm3(cols[i]);
    if (n > bestNorm) { bestNorm = n; bestIdx = i; }
  }
  if (!(bestNorm > 1e-12) || bestIdx < 0) return normalize_vector3(fallback, fallback);
  return normalize_vector3(cols[bestIdx], fallback);
}

// JS:259 projectorTensorToEngineeringGradient6 — converts a 3×3
// symmetric projector tensor to a Voigt-6 with the 2× engineering-
// shear convention.
inline Vec6 projector_tensor_to_engineering_gradient6(const Mat3& p) {
  return Vec6{
    p[0][0], p[1][1], p[2][2],
    2.0 * p[0][1], 2.0 * p[1][2], 2.0 * p[0][2]
  };
}

// JS:276 matrixInfinityNorm — operates on dynamic (size-n) square matrices.
inline double matrix_infinity_norm(const std::vector<std::vector<double>>& M) {
  double maxRowSum = 0.0;
  for (const auto& row : M) {
    double rowSum = 0.0;
    for (double v : row) rowSum += std::abs(v);
    maxRowSum = std::max(maxRowSum, rowSum);
  }
  return maxRowSum;
}

// JS:289 matrixMaxAbsEntry
inline double matrix_max_abs_entry(const std::vector<std::vector<double>>& M) {
  double maxEntry = 0.0;
  for (const auto& row : M)
    for (double v : row) maxEntry = std::max(maxEntry, std::abs(v));
  return maxEntry;
}

// JS:300 relativePivotTolerance
inline double relative_pivot_tolerance(const std::vector<std::vector<double>>& M,
                                       double relative = 1e-12, double absolute = 1e-12) {
  return std::max(absolute, std::max(relative, 0.0) * matrix_max_abs_entry(M));
}

// JS:310 solveDenseLinearSystem — partial-pivoted LU on a small dense
// matrix. Returns false on singular pivot or non-finite pivot.
inline bool solve_dense_linear_system(std::vector<std::vector<double>> M,
                                      std::vector<double> rhs,
                                      std::vector<double>& solution,
                                      double tolerance = 1e-12) {
  const std::size_t n = rhs.size();
  if (n == 0) { solution.clear(); return true; }
  for (std::size_t k = 0; k < n; ++k) {
    std::size_t pivotRow = k;
    double pivotValue = std::abs(M[k][k]);
    for (std::size_t r = k + 1; r < n; ++r) {
      const double v = std::abs(M[r][k]);
      if (v > pivotValue) { pivotValue = v; pivotRow = r; }
    }
    if (!(pivotValue > tolerance) || !std::isfinite(pivotValue)) return false;
    if (pivotRow != k) {
      std::swap(M[k], M[pivotRow]);
      std::swap(rhs[k], rhs[pivotRow]);
    }
    const double pivot = M[k][k];
    for (std::size_t r = k + 1; r < n; ++r) {
      const double factor = M[r][k] / pivot;
      M[r][k] = 0.0;
      for (std::size_t c = k + 1; c < n; ++c) M[r][c] -= factor * M[k][c];
      rhs[r] -= factor * rhs[k];
    }
  }
  solution.assign(n, 0.0);
  for (std::ptrdiff_t r = static_cast<std::ptrdiff_t>(n) - 1; r >= 0; --r) {
    double v = rhs[r];
    for (std::size_t c = r + 1; c < n; ++c) v -= M[r][c] * solution[c];
    const double pivot = M[r][r];
    if (!(std::abs(pivot) > tolerance) || !std::isfinite(pivot)) return false;
    solution[r] = v / pivot;
  }
  return true;
}

// JS:513 invertDenseMatrix — column-wise solves of M x = e_col.
inline bool invert_dense_matrix(const std::vector<std::vector<double>>& M,
                                std::vector<std::vector<double>>& inverse,
                                double tolerance = 1e-12) {
  const std::size_t n = M.size();
  inverse.assign(n, std::vector<double>(n, 0.0));
  for (std::size_t col = 0; col < n; ++col) {
    std::vector<double> rhs(n, 0.0);
    rhs[col] = 1.0;
    std::vector<double> column;
    if (!solve_dense_linear_system(M, rhs, column, tolerance)) return false;
    for (std::size_t r = 0; r < n; ++r) inverse[r][col] = column[r];
  }
  return true;
}

// JS:304 denseMatrixConditionNumberEstimate
inline double dense_matrix_condition_number_estimate(const std::vector<std::vector<double>>& M,
                                                     double tolerance = 1e-12) {
  std::vector<std::vector<double>> inv;
  if (!invert_dense_matrix(M, inv, tolerance)) return std::numeric_limits<double>::infinity();
  return matrix_infinity_norm(M) * matrix_infinity_norm(inv);
}

// JS:357 multiplyMatrix6x6Vector6
inline Vec6 multiply_matrix6x6_vector6(const Mat6& M, const Vec6& v) {
  Vec6 out{};
  for (int i = 0; i < 6; ++i) {
    out[i] = M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]
           + M[i][3] * v[3] + M[i][4] * v[4] + M[i][5] * v[5];
  }
  return out;
}

// JS:383 stressScaleFromContext — overload for the common Gauss-point
// argument shape (s1, s2, s3, maxAbsStress, cEff, yieldTolerancePref).
// The JS variant accepts an arbitrary `stressContext` object; in C++
// we provide the fields explicitly so it's typesafe.
struct StressContext {
  double s1{ 0.0 };
  double s2{ 0.0 };
  double s3{ 0.0 };
  double sxx{ 0.0 };
  double syy{ 0.0 };
  double szz{ 0.0 };
  double txy{ 0.0 };
  double maxAbsStress{ 0.0 };
};
inline double stress_scale_from_context(const StressContext& sc, double cEff, double pRef) {
  return std::max({
    std::abs(sc.s1), std::abs(sc.s2), std::abs(sc.s3),
    std::abs(sc.sxx), std::abs(sc.syy), std::abs(sc.szz), std::abs(sc.txy),
    std::abs(sc.maxAbsStress),
    std::max(cEff, 0.0),
    std::max(pRef, 1.0)
  });
}

// JS:400 mcTolerance — uses explicit absolute first, otherwise relative
// scaled by stress context. In the C++ port the RegionParams currently
// does not expose `yieldTolerance` / `yieldToleranceRelative`; wire
// format v3 will add them. For now we use the JS default values.
inline double mc_tolerance(double cEff, const StressContext& sc,
                           double yieldToleranceAbsolute = 0.0,
                           double yieldToleranceRelative = 1e-8,
                           double yieldTolerancePref = 100.0) {
  if (std::isfinite(yieldToleranceAbsolute) && yieldToleranceAbsolute > 0.0) {
    return std::max(yieldToleranceAbsolute, 1e-12);
  }
  const double rel = std::max(yieldToleranceRelative, 1e-15);
  return std::max(rel * stress_scale_from_context(sc, cEff, yieldTolerancePref), 1e-12);
}

// JS:412 eigTolerance
inline double eig_tolerance(double cEff, const StressContext& sc,
                            double eigToleranceAbsolute = 0.0,
                            double eigToleranceRelative = 1e-9,
                            double yieldTolerancePref = 100.0) {
  if (std::isfinite(eigToleranceAbsolute) && eigToleranceAbsolute > 0.0) {
    return std::max(eigToleranceAbsolute, 1e-12);
  }
  const double rel = std::max(eigToleranceRelative, 1e-15);
  return std::max(rel * stress_scale_from_context(sc, cEff, yieldTolerancePref), 1e-12);
}

// JS:424 resolveYieldTolerance — thin wrapper.
inline double resolve_yield_tolerance(double cEff, const StressContext& sc) {
  return mc_tolerance(cEff, sc);
}

// JS:428 weightedEngineeringStrainDot — strain-strain inner product
// with 0.5× factor on shears (engineering convention).
inline double weighted_engineering_strain_dot(const Vec6& a, const Vec6& b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
       + 0.5 * (a[3] * b[3] + a[4] * b[4] + a[5] * b[5]);
}

// JS:439 deviatoricEngineeringStrain6
inline Vec6 deviatoric_engineering_strain6(const Vec6& e) {
  const double exx = e[VOIGT_XX];
  const double eyy = e[VOIGT_YY];
  const double ezz = e[VOIGT_ZZ];
  const double mean = (exx + eyy + ezz) / 3.0;
  return Vec6{exx - mean, eyy - mean, ezz - mean,
              e[VOIGT_XY], e[VOIGT_YZ], e[VOIGT_XZ]};
}

// JS:454 equivalentPlasticStrainIncrement — ε^p_eq = √(2/3 · |ε^p_dev|²)
// where |·|² uses weighted engineering dot (0.5 on shears).
inline double equivalent_plastic_strain_increment(const Vec6& dEpsP) {
  const Vec6 dev = deviatoric_engineering_strain6(dEpsP);
  const double normSq = weighted_engineering_strain_dot(dev, dev);
  return std::sqrt(std::max((2.0 / 3.0) * normSq, 0.0));
}

// JS:460 vectorNorm6 — plain Euclidean (no engineering factors).
inline double vector_norm6(const Vec6& v) {
  return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
                 + v[3] * v[3] + v[4] * v[4] + v[5] * v[5]);
}

// JS:471 dotVector6 — plain Euclidean.
inline double dot_vector6(const Vec6& a, const Vec6& b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
       + a[3] * b[3] + a[4] * b[4] + a[5] * b[5];
}

// JS:482 outerProduct6
inline Mat6 outer_product6(const Vec6& a, const Vec6& b, double scale = 1.0) {
  Mat6 out{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) out[i][j] = scale * a[i] * b[j];
  return out;
}

// JS:490 subtractMatrix6
inline Mat6 subtract_matrix6(const Mat6& a, const Mat6& b) {
  Mat6 out{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) out[i][j] = a[i][j] - b[i][j];
  return out;
}

// JS:498 symmetrizeMatrix6
inline Mat6 symmetrize_matrix6(const Mat6& M) {
  Mat6 out{};
  for (int i = 0; i < 6; ++i)
    for (int j = 0; j < 6; ++j) out[i][j] = 0.5 * (M[i][j] + M[j][i]);
  return out;
}

// JS:509 zeroMatrix6
inline Mat6 zero_matrix6() { return Mat6{}; }

// JS:528 compressionPositiveStressTensor3From6
inline Mat3 compression_positive_stress_tensor3_from6(const Vec6& s) {
  return Mat3{{
    {-s[VOIGT_XX], -s[VOIGT_XY], -s[VOIGT_XZ]},
    {-s[VOIGT_XY], -s[VOIGT_YY], -s[VOIGT_YZ]},
    {-s[VOIGT_XZ], -s[VOIGT_YZ], -s[VOIGT_ZZ]}
  }};
}

// JS:536 compressionPositiveTensor3ToStress6
inline Vec6 compression_positive_tensor3_to_stress6(const Mat3& T) {
  return Vec6{
    -T[0][0], -T[1][1], -T[2][2],
    -T[0][1], -T[1][2], -T[0][2]
  };
}

// JS:547 combinePrincipalProjectors — returns
// c0 · P1 + c1 · P2 + c2 · P3.
struct PrincipalProjectors {
  Mat3 P1{};
  Mat3 P2{};
  Mat3 P3{};
};
inline Mat3 combine_principal_projectors(const PrincipalProjectors& proj, const Vec3& coef) {
  Mat3 out{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      out[i][j] = coef[0] * proj.P1[i][j] + coef[1] * proj.P2[i][j] + coef[2] * proj.P3[i][j];
    }
  }
  return out;
}

// JS:557 compressionPositiveGradientTensorToInternalEngineeringGradient6
inline Vec6 compression_positive_gradient_tensor_to_internal_engineering_gradient6(const Mat3& T) {
  return Vec6{
    -T[0][0], -T[1][1], -T[2][2],
    -2.0 * T[0][1], -2.0 * T[1][2], -2.0 * T[0][2]
  };
}

// JS:568 principalCoefficientsToInternalGradient6
inline Vec6 principal_coefficients_to_internal_gradient6(const Vec3& coef,
                                                         const PrincipalProjectors& proj) {
  return compression_positive_gradient_tensor_to_internal_engineering_gradient6(
      combine_principal_projectors(proj, coef));
}

// JS:574 projectorsToCompressionPositiveStressTensor
inline Mat3 projectors_to_compression_positive_stress_tensor(const Vec3& principalValues,
                                                             const PrincipalProjectors& proj) {
  return combine_principal_projectors(proj, principalValues);
}

} // namespace madep::js_mirror
