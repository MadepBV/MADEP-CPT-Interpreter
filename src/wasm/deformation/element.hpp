// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Element kernels for T3 and T6 triangles in plane strain.
// Mirrors the algorithms in src/lib/cpt-app/deformation/element-t3.js and
// element-t6.js: same B-matrix derivation, same Gauss rules, same B-bar
// projection for T6.

#pragma once

#include <array>
#include <cmath>

#include "linalg.hpp"
#include "types.hpp"

namespace madep::elem {

constexpr double AREA_EPS = 1e-12;

// Signed twice-area, used to detect orientation and degenerate triangles.
inline double signed_twice_area(const Node& a, const Node& b, const Node& c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

inline double triangle_area(const Node& a, const Node& b, const Node& c) {
  return 0.5 * std::fabs(signed_twice_area(a, b, c));
}

// ---------------------------------------------------------------------------
// T3 — 3-node linear triangle
// ---------------------------------------------------------------------------
//
// B is 3×6, constant over the element. Gauss rule: 1 point at the centroid,
// weight = area. We pre-store B in GaussPoint.B[0..2][0..5].
//
inline void build_T3(const Node& a, const Node& b, const Node& c, ElementCache& cache) {
  cache.kind = ElementKind::T3;
  cache.numNodes = 3;
  cache.numDofs = 6;
  cache.numGp = 1;
  const double area2 = signed_twice_area(a, b, c);
  const double area = 0.5 * std::fabs(area2);
  cache.area = area;
  cache.nodes[0] = a;
  cache.nodes[1] = b;
  cache.nodes[2] = c;

  const double b1 = b.y - c.y;
  const double b2 = c.y - a.y;
  const double b3 = a.y - b.y;
  const double c1 = c.x - b.x;
  const double c2 = a.x - c.x;
  const double c3 = b.x - a.x;
  const double inv = 1.0 / area2;

  GaussPoint& gp = cache.gp[0];
  for (auto& row : gp.B) row.fill(0.0);
  gp.B[0][0] = b1 * inv; gp.B[0][2] = b2 * inv; gp.B[0][4] = b3 * inv;
  gp.B[1][1] = c1 * inv; gp.B[1][3] = c2 * inv; gp.B[1][5] = c3 * inv;
  gp.B[2][0] = c1 * inv; gp.B[2][2] = c2 * inv; gp.B[2][4] = c3 * inv;
  gp.B[2][1] = b1 * inv; gp.B[2][3] = b2 * inv; gp.B[2][5] = b3 * inv;
  gp.x = (a.x + b.x + c.x) / 3.0;
  gp.y = (a.y + b.y + c.y) / 3.0;
  gp.weight_det_j = area;
}

// ---------------------------------------------------------------------------
// T6 — 6-node quadratic triangle (corner + midpoints)
// ---------------------------------------------------------------------------
//
// Triangle's o2 ordering: [v1, v2, v3, m23, m31, m12].
// 3-point Gauss rule (interior, equal weights 1/6, det J = 2A).

struct T6GaussRule {
  double L1, L2, L3, w;
};

inline constexpr T6GaussRule T6_GAUSS[3] = {
  {2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0, 1.0 / 6.0},
  {1.0 / 6.0, 2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0},
  {1.0 / 6.0, 1.0 / 6.0, 2.0 / 3.0, 1.0 / 6.0}
};

inline void shape_grads_T6(
    const Node& v1, const Node& v2, const Node& v3,
    double L1, double L2, double L3,
    std::array<double, 6>& dNdx,
    std::array<double, 6>& dNdy) {
  const double area2 = signed_twice_area(v1, v2, v3);
  const double inv = 1.0 / area2;
  const double dLdx[3] = {(v2.y - v3.y) * inv, (v3.y - v1.y) * inv, (v1.y - v2.y) * inv};
  const double dLdy[3] = {(v3.x - v2.x) * inv, (v1.x - v3.x) * inv, (v2.x - v1.x) * inv};
  const double L[3] = {L1, L2, L3};
  for (int i = 0; i < 3; ++i) {
    const double scale = 4.0 * L[i] - 1.0;
    dNdx[i] = scale * dLdx[i];
    dNdy[i] = scale * dLdy[i];
  }
  dNdx[3] = 4.0 * (L2 * dLdx[2] + L3 * dLdx[1]);
  dNdy[3] = 4.0 * (L2 * dLdy[2] + L3 * dLdy[1]);
  dNdx[4] = 4.0 * (L3 * dLdx[0] + L1 * dLdx[2]);
  dNdy[4] = 4.0 * (L3 * dLdy[0] + L1 * dLdy[2]);
  dNdx[5] = 4.0 * (L1 * dLdx[1] + L2 * dLdx[0]);
  dNdy[5] = 4.0 * (L1 * dLdy[1] + L2 * dLdy[0]);
}

inline void build_T6(
    const Node& v1, const Node& v2, const Node& v3,
    const Node& m23, const Node& m31, const Node& m12,
    bool useBBar,
    ElementCache& cache) {
  cache.kind = ElementKind::T6;
  cache.numNodes = 6;
  cache.numDofs = 12;
  cache.numGp = 3;
  const double area = triangle_area(v1, v2, v3);
  cache.area = area;
  cache.nodes[0] = v1; cache.nodes[1] = v2; cache.nodes[2] = v3;
  cache.nodes[3] = m23; cache.nodes[4] = m31; cache.nodes[5] = m12;
  const double detJ = 2.0 * area;

  // First build standard B matrices at each GP.
  std::array<std::array<std::array<double, 12>, 3>, 3> Bs{};
  std::array<double, 3> wDet{};
  for (int g = 0; g < 3; ++g) {
    std::array<double, 6> dNdx{}, dNdy{};
    shape_grads_T6(v1, v2, v3, T6_GAUSS[g].L1, T6_GAUSS[g].L2, T6_GAUSS[g].L3, dNdx, dNdy);
    auto& B = Bs[g];
    for (auto& row : B) row.fill(0.0);
    for (int i = 0; i < 6; ++i) {
      const int ux = 2 * i;
      const int uy = ux + 1;
      B[0][ux] = dNdx[i];
      B[1][uy] = dNdy[i];
      B[2][ux] = dNdy[i];
      B[2][uy] = dNdx[i];
    }
    wDet[g] = T6_GAUSS[g].w * detJ;
  }

  // B-bar volumetric projection: replace (εxx + εyy) with the element-
  // averaged volumetric part. Standard Hughes/Simo procedure for plane
  // strain quadratic triangles to combat volumetric locking.
  if (useBBar) {
    double bVolAvg[12] = {0};
    double totalW = 0.0;
    for (int g = 0; g < 3; ++g) {
      totalW += wDet[g];
      for (int d = 0; d < 12; ++d) {
        bVolAvg[d] += wDet[g] * (Bs[g][0][d] + Bs[g][1][d]);
      }
    }
    if (totalW > 0.0) {
      for (int d = 0; d < 12; ++d) bVolAvg[d] /= totalW;
      for (int g = 0; g < 3; ++g) {
        for (int d = 0; d < 12; ++d) {
          const double localVol = Bs[g][0][d] + Bs[g][1][d];
          const double corr = 0.5 * (bVolAvg[d] - localVol);
          Bs[g][0][d] += corr;
          Bs[g][1][d] += corr;
        }
      }
    }
  }

  // Cache into GaussPoint slots.
  for (int g = 0; g < 3; ++g) {
    GaussPoint& gp = cache.gp[g];
    gp.B = Bs[g];
    gp.weight_det_j = wDet[g];
    const double L1 = T6_GAUSS[g].L1;
    const double L2 = T6_GAUSS[g].L2;
    const double L3 = T6_GAUSS[g].L3;
    gp.x = L1 * v1.x + L2 * v2.x + L3 * v3.x;
    gp.y = L1 * v1.y + L2 * v2.y + L3 * v3.y;
  }
}

// ---------------------------------------------------------------------------
// Strain at a Gauss point: ε = B u_e (plane-strain 3-vector).
// ---------------------------------------------------------------------------
inline void strain_at_gp(const GaussPoint& gp, const double* ue, int ndofs,
                         double& exx, double& eyy, double& gxy) {
  exx = eyy = gxy = 0.0;
  for (int i = 0; i < ndofs; ++i) {
    exx += gp.B[0][i] * ue[i];
    eyy += gp.B[1][i] * ue[i];
    gxy += gp.B[2][i] * ue[i];
  }
}

// ---------------------------------------------------------------------------
// Element stiffness K = sum_gp w_det_J * B^T * D2D * B (12×12 max).
// D2D is the 3×3 plane-strain tangent extracted from the Voigt-6 tangent.
// out is a row-major numDofs × numDofs matrix.
// ---------------------------------------------------------------------------
inline void element_stiffness(
    const ElementCache& cache,
    const std::array<std::array<std::array<double, 3>, 3>, 3>& D2DperGp,
    double* out) {
  const int n = cache.numDofs;
  for (int i = 0; i < n * n; ++i) out[i] = 0.0;
  for (int g = 0; g < cache.numGp; ++g) {
    const auto& B = cache.gp[g].B;
    const double wDet = cache.gp[g].weight_det_j;
    const auto& D = D2DperGp[g];
    for (int i = 0; i < n; ++i) {
      const double Bi0 = B[0][i];
      const double Bi1 = B[1][i];
      const double Bi2 = B[2][i];
      for (int j = 0; j < n; ++j) {
        const double Bj0 = B[0][j];
        const double Bj1 = B[1][j];
        const double Bj2 = B[2][j];
        const double DB0 = D[0][0] * Bj0 + D[0][1] * Bj1 + D[0][2] * Bj2;
        const double DB1 = D[1][0] * Bj0 + D[1][1] * Bj1 + D[1][2] * Bj2;
        const double DB2 = D[2][0] * Bj0 + D[2][1] * Bj1 + D[2][2] * Bj2;
        out[i * n + j] += wDet * (Bi0 * DB0 + Bi1 * DB1 + Bi2 * DB2);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal force F_int = sum_gp w_det_J * B^T * σ_2D (vector of size numDofs).
// stress2DperGp[g] = (σxx, σyy, τxy).
// ---------------------------------------------------------------------------
inline void element_internal_force(
    const ElementCache& cache,
    const std::array<std::array<double, 3>, 3>& stress2DperGp,
    double* out) {
  const int n = cache.numDofs;
  for (int i = 0; i < n; ++i) out[i] = 0.0;
  for (int g = 0; g < cache.numGp; ++g) {
    const auto& B = cache.gp[g].B;
    const double wDet = cache.gp[g].weight_det_j;
    const double sxx = stress2DperGp[g][0];
    const double syy = stress2DperGp[g][1];
    const double txy = stress2DperGp[g][2];
    for (int i = 0; i < n; ++i) {
      out[i] += wDet * (B[0][i] * sxx + B[1][i] * syy + B[2][i] * txy);
    }
  }
}

// ---------------------------------------------------------------------------
// Body force from gravity: constant (bx, by) over the element.
// T3: lumped equally among 3 corner nodes. T6: only midpoint nodes (the
// corner shape-function integrals are zero for a constant body force on
// the Lagrange quadratic triangle).
// ---------------------------------------------------------------------------
inline void element_body_force(const ElementCache& cache, double bx, double by, double* out) {
  const int n = cache.numDofs;
  for (int i = 0; i < n; ++i) out[i] = 0.0;
  if (cache.kind == ElementKind::T3) {
    const double share = cache.area / 3.0;
    for (int i = 0; i < 3; ++i) {
      out[2 * i + 0] = share * bx;
      out[2 * i + 1] = share * by;
    }
  } else {
    const double midShare = cache.area / 3.0;
    for (int i = 3; i < 6; ++i) {
      out[2 * i + 0] = midShare * bx;
      out[2 * i + 1] = midShare * by;
    }
  }
}

}  // namespace madep::elem
