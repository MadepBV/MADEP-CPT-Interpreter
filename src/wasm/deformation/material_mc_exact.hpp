// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1:1 mirror of the Mohr-Coulomb exact-active-set return mapping from
// src/lib/cpt-app/deformation/material-models.js. JS line numbers are
// noted as `// JS:###`. Convention throughout: compression-positive
// principal stresses, tension-positive engineering Voigt-6 at the
// boundary (matching JS).

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <numeric>
#include <utility>
#include <vector>

#include "math_js_mirror.hpp"
#include "types.hpp"

namespace madep::mc_exact {

using madep::js_mirror::Vec3;
using madep::js_mirror::Mat3;
using madep::js_mirror::BranchKind;
using madep::js_mirror::MultiplicityKind;
using madep::js_mirror::YieldSurface;
using madep::js_mirror::PrincipalProjectors;
namespace jsm = madep::js_mirror;

// ---------------------------------------------------------------------------
// MaterialParameters — mirrors the JS `materialParameters` object that
// every constitutive function consumes. Wire format v3 will populate
// these fields fully; until then, defaults match the JS fallbacks.
// ---------------------------------------------------------------------------
struct MaterialParameters {
  // Elastic
  double Emc{ 1.0 };
  double nu{ 0.3 };
  // MC plastic
  double phiEffDeg{ 0.0 };
  double psiEffDeg{ 0.0 };
  double cEff{ 0.0 };
  // Tension cut-off
  double sigmaTAllow{ 0.0 };
  bool useTensionCutoff{ true };
  // Misc tolerances / overrides (JS materialParameters fields).
  double yieldTolerancePref{ 100.0 };
  double yieldToleranceAbsolute{ 0.0 };
  double yieldToleranceRelative{ 1e-8 };
  double eigToleranceAbsolute{ 0.0 };
  double eigToleranceRelative{ 1e-9 };
  double edgeStressGapTolerance{ 0.0 };       // 0 → derived
  double apexStressGapTolerance{ 0.0 };       // 0 → derived
  double eigSubspaceTolerance{ 0.0 };          // 0 → derived
  double activeSetComplementarityTolerance{ 0.0 }; // 0 → derived
  double apexHydrostaticTolerance{ 0.0 };      // 0 → derived
  double nearSurfaceMinConfiningStress{ 0.0 };
  bool allowFormalApexBranch{ false };
  bool symmetrizeEpTangent{ false };
  // representativeBasisPolicy parsed into a priority list.
  std::array<std::uint8_t, 3> representativeBasisPriority{ 0u, 1u, 2u };
  // Codes: 0 = committed, 1 = trial, 2 = canonical.
};

// ---------------------------------------------------------------------------
// JS:578 exactMcSurfaceParameters
// ---------------------------------------------------------------------------
struct SurfaceParameters {
  double phi{ 0.0 };
  double psi{ 0.0 };
  double c{ 0.0 };
  double sigmaTAllow{ 0.0 };
  double sinPhi{ 0.0 };
  double cosPhi{ 1.0 };
  double sinPsi{ 0.0 };
  bool useTensionCutoff{ true };
};

// JS uses `clampMcAngle` to convert phiEffDeg → radians with a small
// floor / ceiling. We replicate the same clamp here.
inline double clamp_mc_angle_deg(double angleDeg) {
  // JS clampMcAngle (line 1880): clamps to [0, 89.5] then returns deg.
  return std::clamp(angleDeg, 0.0, 89.5);
}

inline SurfaceParameters exact_mc_surface_parameters(const MaterialParameters& mp) {
  SurfaceParameters sp;
  sp.phi = clamp_mc_angle_deg(mp.phiEffDeg) * M_PI / 180.0;
  sp.psi = clamp_mc_angle_deg(mp.psiEffDeg) * M_PI / 180.0;
  sp.c = std::max(mp.cEff, 0.0);
  const double tanPhi = std::tan(sp.phi);
  const double sigmaTUpper = (std::abs(tanPhi) > 1e-12)
      ? std::max(sp.c / tanPhi, 0.0)
      : std::numeric_limits<double>::infinity();
  sp.sigmaTAllow = std::min(std::max(mp.sigmaTAllow, 0.0), sigmaTUpper);
  sp.sinPhi = std::sin(sp.phi);
  sp.cosPhi = std::cos(sp.phi);
  sp.sinPsi = std::sin(sp.psi);
  sp.useTensionCutoff = mp.useTensionCutoff;
  return sp;
}

// ---------------------------------------------------------------------------
// JS:598 principalElasticMatrix3x3 — 3×3 isotropic stiffness on principal
// stress vectors (compression-positive). Returns the same matrix in
// either sign convention since it's symmetric in trace × deviator.
// ---------------------------------------------------------------------------
inline Mat3 principal_elastic_matrix_3x3(const MaterialParameters& mp) {
  const double E = std::max(mp.Emc, 1.0);
  const double nu = std::clamp(mp.nu, -0.99, 0.49);
  const double G = E / (2.0 * (1.0 + nu));
  const double lambda = E * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
  return Mat3{{
    {lambda + 2.0 * G, lambda,             lambda},
    {lambda,             lambda + 2.0 * G, lambda},
    {lambda,             lambda,             lambda + 2.0 * G}
  }};
}

// ---------------------------------------------------------------------------
// JS:607 principalStressProjectors3DCompressionPositive — 2D plane plus
// out-of-plane szz, sorted descending by value.
// ---------------------------------------------------------------------------
struct PrincipalState {
  double s1{ 0.0 };
  double s2{ 0.0 };
  double s3{ 0.0 };
  Mat3 P1{};
  Mat3 P2{};
  Mat3 P3{};
  double planeMajor{ 0.0 };
  double planeMinor{ 0.0 };
  bool repeatedEigenvalues{ false };
  double eigTolerance{ 0.0 };
};

inline PrincipalState principal_stress_projectors_3d_compression_positive(
    const Vec6& stress6_tens, const MaterialParameters& mp) {
  // effectiveStress6ToCompressionPositiveStress3D (JS:2259) — negate
  // the relevant Voigt entries.
  const double sxx = -stress6_tens[jsm::VOIGT_XX];
  const double syy = -stress6_tens[jsm::VOIGT_YY];
  const double szz = -stress6_tens[jsm::VOIGT_ZZ];
  const double txy = -stress6_tens[jsm::VOIGT_XY];

  jsm::StressContext sc;
  sc.sxx = sxx; sc.syy = syy; sc.szz = szz; sc.txy = txy;
  const double eigenTol = jsm::eig_tolerance(
      mp.cEff, sc, mp.eigToleranceAbsolute, mp.eigToleranceRelative, mp.yieldTolerancePref);

  const double pxy = 0.5 * (sxx + syy);
  const double diff = 0.5 * (sxx - syy);
  const double radius = std::hypot(diff, txy);
  const double planeMajor = pxy + radius;
  const double planeMinor = pxy - radius;

  Vec3 vPlaneMajor{1.0, 0.0, 0.0};
  Vec3 vPlaneMinor{0.0, 1.0, 0.0};
  if (radius > eigenTol) {
    const double theta = 0.5 * std::atan2(2.0 * txy, sxx - syy);
    const double c = std::cos(theta);
    const double s = std::sin(theta);
    vPlaneMajor = Vec3{c, s, 0.0};
    vPlaneMinor = Vec3{-s, c, 0.0};
  }
  const Vec3 vOutOfPlane{0.0, 0.0, 1.0};

  struct Pair { double value; Vec3 direction; };
  std::array<Pair, 3> eigenpairs{
    Pair{planeMajor, jsm::normalize_vector3(vPlaneMajor)},
    Pair{szz,        vOutOfPlane},
    Pair{planeMinor, jsm::normalize_vector3(vPlaneMinor)}
  };
  std::sort(eigenpairs.begin(), eigenpairs.end(),
            [](const Pair& a, const Pair& b) { return a.value > b.value; });

  PrincipalState st;
  st.s1 = eigenpairs[0].value;
  st.s2 = eigenpairs[1].value;
  st.s3 = eigenpairs[2].value;
  st.P1 = jsm::principal_direction_to_projector(eigenpairs[0].direction);
  st.P2 = jsm::principal_direction_to_projector(eigenpairs[1].direction);
  st.P3 = jsm::principal_direction_to_projector(eigenpairs[2].direction);
  st.planeMajor = planeMajor;
  st.planeMinor = planeMinor;
  st.repeatedEigenvalues =
      std::abs(eigenpairs[0].value - eigenpairs[1].value) <= eigenTol ||
      std::abs(eigenpairs[1].value - eigenpairs[2].value) <= eigenTol ||
      std::abs(eigenpairs[0].value - eigenpairs[2].value) <= eigenTol;
  st.eigTolerance = eigenTol;
  return st;
}

// ---------------------------------------------------------------------------
// JS:667 tensionSurfacePrincipalCoefficients
// ---------------------------------------------------------------------------
inline std::pair<Vec3, Vec3> tension_surface_principal_coefficients(BranchKind branchKind) {
  if (branchKind == BranchKind::TENSION_EDGE_T23 ||
      branchKind == BranchKind::TENSION_CORNER_S23_T3) {
    return {Vec3{0.0, -0.5, -0.5}, Vec3{0.0, -0.5, -0.5}};
  }
  if (branchKind == BranchKind::TENSION_APEX_T123) {
    return {Vec3{-1.0 / 3.0, -1.0 / 3.0, -1.0 / 3.0},
            Vec3{-1.0 / 3.0, -1.0 / 3.0, -1.0 / 3.0}};
  }
  return {Vec3{0.0, 0.0, -1.0}, Vec3{0.0, 0.0, -1.0}};
}

// ---------------------------------------------------------------------------
// JS:686 buildExactMcSurfaces. Surfaces:
//   F12, F13, F23 (shear, intercept = 2 c cosφ),
//   T3 (tension cut-off, intercept = sigmaT) — only when useTensionCutoff.
// Branch-specific override on F13 / G13 for the tension corner branches.
// ---------------------------------------------------------------------------
struct Surface {
  char id;                 // 'a' = F12, 'b' = F13, 'c' = F23, 't' = T3
  char kind;               // 's' = shear, 't' = tension
  Vec3 nPrincipal{};
  Vec3 mPrincipal{};
  double intercept{ 0.0 };
  Vec6 n6{};
  Vec6 m6{};
};

inline std::vector<Surface> build_exact_mc_surfaces(
    const PrincipalProjectors& proj,
    const MaterialParameters& mp,
    BranchKind branchKind = BranchKind::ELASTIC) {
  const SurfaceParameters sp = exact_mc_surface_parameters(mp);
  const double shearIntercept = 2.0 * std::max(mp.cEff, 0.0) * sp.cosPhi;
  Vec3 f12{1.0 - sp.sinPhi, -(1.0 + sp.sinPhi), 0.0};
  Vec3 f13{1.0 - sp.sinPhi, 0.0, -(1.0 + sp.sinPhi)};
  Vec3 f23{0.0, 1.0 - sp.sinPhi, -(1.0 + sp.sinPhi)};
  Vec3 g12{1.0 - sp.sinPsi, -(1.0 + sp.sinPsi), 0.0};
  Vec3 g13{1.0 - sp.sinPsi, 0.0, -(1.0 + sp.sinPsi)};
  Vec3 g23{0.0, 1.0 - sp.sinPsi, -(1.0 + sp.sinPsi)};
  if (branchKind == BranchKind::TENSION_CORNER_S23_T3) {
    f13[1] = -0.5 * (1.0 + sp.sinPhi);
    f13[2] = -0.5 * (1.0 + sp.sinPhi);
    g13[1] = -0.5 * (1.0 + sp.sinPsi);
    g13[2] = -0.5 * (1.0 + sp.sinPsi);
  }
  if (branchKind == BranchKind::TENSION_CORNER_S12_T3) {
    f13[0] = 0.5 * (1.0 - sp.sinPhi);
    f13[1] = 0.5 * (1.0 - sp.sinPhi);
    g13[0] = 0.5 * (1.0 - sp.sinPsi);
    g13[1] = 0.5 * (1.0 - sp.sinPsi);
  }
  std::vector<Surface> defs;
  defs.reserve(4);
  defs.push_back(Surface{'a', 's', f12, g12, shearIntercept, {}, {}});
  defs.push_back(Surface{'b', 's', f13, g13, shearIntercept, {}, {}});
  defs.push_back(Surface{'c', 's', f23, g23, shearIntercept, {}, {}});
  if (sp.useTensionCutoff) {
    auto [tN, tM] = tension_surface_principal_coefficients(branchKind);
    defs.push_back(Surface{'t', 't', tN, tM, sp.sigmaTAllow, {}, {}});
  }
  for (auto& s : defs) {
    s.n6 = jsm::principal_coefficients_to_internal_gradient6(s.nPrincipal, proj);
    s.m6 = jsm::principal_coefficients_to_internal_gradient6(s.mPrincipal, proj);
  }
  return defs;
}

// ---------------------------------------------------------------------------
// JS:747 evaluateExactMcSurfaceValuesFromPrincipal
// ---------------------------------------------------------------------------
struct SurfaceValues {
  double F12{ 0.0 };
  double F13{ 0.0 };
  double F23{ 0.0 };
  double T3{ 0.0 };
  bool useTensionCutoff{ true };
};

inline SurfaceValues evaluate_exact_mc_surface_values_from_principal(
    const Vec3& principalValues, const MaterialParameters& mp) {
  const SurfaceParameters sp = exact_mc_surface_parameters(mp);
  const double shearIntercept = 2.0 * std::max(mp.cEff, 0.0) * sp.cosPhi;
  const double s1 = principalValues[0];
  const double s2 = principalValues[1];
  const double s3 = principalValues[2];
  SurfaceValues v;
  v.F12 = (1.0 - sp.sinPhi) * s1 - (1.0 + sp.sinPhi) * s2 - shearIntercept;
  v.F13 = (1.0 - sp.sinPhi) * s1 - (1.0 + sp.sinPhi) * s3 - shearIntercept;
  v.F23 = (1.0 - sp.sinPhi) * s2 - (1.0 + sp.sinPhi) * s3 - shearIntercept;
  v.useTensionCutoff = sp.useTensionCutoff;
  if (sp.useTensionCutoff) {
    v.T3 = -s3 - sp.sigmaTAllow;
  } else {
    v.T3 = -std::numeric_limits<double>::infinity();
  }
  return v;
}

// JS:760 evaluateExactMcSurfaceValuesFromStress
struct PrincipalAndValues {
  PrincipalState principal;
  SurfaceValues values;
};
inline PrincipalAndValues evaluate_exact_mc_surface_values_from_stress(
    const Vec6& stress6_tens, const MaterialParameters& mp) {
  PrincipalAndValues out;
  out.principal = principal_stress_projectors_3d_compression_positive(stress6_tens, mp);
  out.values = evaluate_exact_mc_surface_values_from_principal(
      Vec3{out.principal.s1, out.principal.s2, out.principal.s3}, mp);
  return out;
}

// ---------------------------------------------------------------------------
// JS:766 activeYieldSurfaceLabelFromActiveSet
// ---------------------------------------------------------------------------
inline YieldSurface active_yield_surface_label_from_active_set(const std::vector<Surface>& active) {
  bool hasTension = false;
  int shearCount = 0;
  for (const auto& s : active) {
    if (s.kind == 't') hasTension = true;
    else if (s.kind == 's') shearCount += 1;
  }
  if (hasTension) return YieldSurface::TENSION;
  if (shearCount >= 3) return YieldSurface::MC_APEX;
  if (shearCount >= 2) return YieldSurface::MC_EDGE;
  if (shearCount == 1) return YieldSurface::MC_FACE;
  return YieldSurface::NONE;
}

// ---------------------------------------------------------------------------
// JS:815 exactMcStressScale
// ---------------------------------------------------------------------------
struct McTrial {
  double s1{ 0.0 };
  double s2{ 0.0 };
  double s3{ 0.0 };
  double maxAbsStress{ 0.0 };
};

inline double exact_mc_stress_scale(const MaterialParameters& mp,
                                    const Vec3& principalValues,
                                    const McTrial& mcTrial) {
  const double cEff = std::max(mp.cEff, 0.0);
  const double pRef = std::max(mp.yieldTolerancePref, 1e-6);
  double s1 = principalValues[0], s2 = principalValues[1], s3 = principalValues[2];
  if (s1 == 0.0 && s2 == 0.0 && s3 == 0.0) {
    s1 = mcTrial.s1; s2 = mcTrial.s2; s3 = mcTrial.s3;
  }
  return std::max({std::abs(s1), std::abs(s2), std::abs(s3), cEff, pRef, 1.0});
}

// ---------------------------------------------------------------------------
// JS:1007 exactMcHydrostaticApexStress (compression-positive: -c/tanφ)
// ---------------------------------------------------------------------------
inline std::pair<bool, double> exact_mc_hydrostatic_apex_stress(const MaterialParameters& mp) {
  const SurfaceParameters sp = exact_mc_surface_parameters(mp);
  const double tanPhi = std::tan(sp.phi);
  if (!(std::abs(tanPhi) > 1e-12)) return {false, 0.0};
  return {true, -(sp.c / tanPhi)};
}

// ---------------------------------------------------------------------------
// JS:1014 isNearFormalShearApex
// ---------------------------------------------------------------------------
inline bool is_near_formal_shear_apex(const Vec3& principalValues,
                                      const MaterialParameters& mp,
                                      double apexTolerance) {
  auto [ok, apex] = exact_mc_hydrostatic_apex_stress(mp);
  if (!ok || !std::isfinite(apex)) return false;
  for (double v : principalValues) {
    if (std::abs(v - apex) > apexTolerance) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// JS:826 resolveCornerStressGapTolerance (kind = 'edge' or 'apex')
// JS:838 resolveActiveSetComplementarityTolerance
// JS:846 resolveEigenSubspaceTolerance
// JS:857 resolveApexHydrostaticTolerance
//
// JS:404 localReturnTolerance — synonym for mcTolerance in JS context.
// ---------------------------------------------------------------------------
inline double local_return_tolerance(const MaterialParameters& mp, const McTrial& mcTrial) {
  jsm::StressContext sc;
  sc.s1 = mcTrial.s1; sc.s2 = mcTrial.s2; sc.s3 = mcTrial.s3;
  sc.maxAbsStress = mcTrial.maxAbsStress;
  return jsm::mc_tolerance(mp.cEff, sc,
                           mp.yieldToleranceAbsolute, mp.yieldToleranceRelative,
                           mp.yieldTolerancePref);
}

inline double resolve_corner_stress_gap_tolerance(const MaterialParameters& mp,
                                                  const Vec3& principalValues,
                                                  const McTrial& mcTrial,
                                                  bool isApex) {
  const double explicitVal = isApex ? mp.apexStressGapTolerance : mp.edgeStressGapTolerance;
  if (std::isfinite(explicitVal) && explicitVal > 0.0) return explicitVal;
  const double stressScale = exact_mc_stress_scale(mp, principalValues, mcTrial);
  const double localTol = local_return_tolerance(mp, mcTrial);
  const double scale = isApex ? 5e-7 : 1e-7;
  const double multiplier = isApex ? 10.0 : 5.0;
  return std::max(multiplier * localTol, scale * stressScale);
}

inline double resolve_active_set_complementarity_tolerance(const MaterialParameters& mp,
                                                           const Vec3& principalValues,
                                                           const McTrial& mcTrial,
                                                           double edgeTolerance) {
  const double explicitVal = mp.activeSetComplementarityTolerance;
  if (std::isfinite(explicitVal) && explicitVal > 0.0) return explicitVal;
  const double stressScale = exact_mc_stress_scale(mp, principalValues, mcTrial);
  const double localTol = local_return_tolerance(mp, mcTrial);
  return std::max({5.0 * localTol, 1e-7 * stressScale, edgeTolerance});
}

inline double resolve_eigen_subspace_tolerance(const MaterialParameters& mp,
                                               const Vec3& principalValues,
                                               const McTrial& mcTrial,
                                               double edgeTolerance) {
  const double explicitVal = mp.eigSubspaceTolerance;
  if (std::isfinite(explicitVal) && explicitVal > 0.0) return explicitVal;
  jsm::StressContext sc;
  sc.s1 = principalValues[0]; sc.s2 = principalValues[1]; sc.s3 = principalValues[2];
  sc.maxAbsStress = exact_mc_stress_scale(mp, principalValues, mcTrial);
  const double eig = jsm::eig_tolerance(
      mp.cEff, sc, mp.eigToleranceAbsolute, mp.eigToleranceRelative, mp.yieldTolerancePref);
  return std::max(eig, edgeTolerance);
}

inline double resolve_apex_hydrostatic_tolerance(const MaterialParameters& mp,
                                                 const Vec3& principalValues,
                                                 const McTrial& mcTrial,
                                                 double apexTolerance) {
  const double explicitVal = mp.apexHydrostaticTolerance;
  if (std::isfinite(explicitVal) && explicitVal > 0.0) return explicitVal;
  auto [ok, apex] = exact_mc_hydrostatic_apex_stress(mp);
  const double apexStress = ok ? apex : 0.0;
  const double cohesionScale = std::max(mp.cEff, 0.0);
  const double nearSurfaceFloor = std::max(mp.nearSurfaceMinConfiningStress, 0.0);
  const double apexBasedScale = std::max({
      std::isfinite(apexStress) ? std::abs(apexStress) : 0.0,
      cohesionScale,
      nearSurfaceFloor
  });
  return std::max({20.0 * apexTolerance, 0.01 * apexBasedScale, 1e-3});
}

// ---------------------------------------------------------------------------
// JS:887 isTensionBranchKind / isLowerRepeatedBranchKind /
// isUpperRepeatedBranchKind / isShearEdgeBranchKind
// ---------------------------------------------------------------------------
inline bool is_tension_branch_kind(BranchKind b) {
  return b == BranchKind::TENSION_PENDING ||
         b == BranchKind::TENSION_FACE_T3 ||
         b == BranchKind::TENSION_EDGE_T23 ||
         b == BranchKind::TENSION_EDGE_F13_T3 ||
         b == BranchKind::TENSION_CORNER_S23_T3 ||
         b == BranchKind::TENSION_CORNER_S12_T3 ||
         b == BranchKind::TENSION_APEX_T123;
}

inline bool is_lower_repeated_branch_kind(BranchKind b) {
  return b == BranchKind::EDGE_S23_EQUAL ||
         b == BranchKind::TENSION_EDGE_T23 ||
         b == BranchKind::TENSION_CORNER_S23_T3;
}

inline bool is_upper_repeated_branch_kind(BranchKind b) {
  return b == BranchKind::EDGE_S12_EQUAL ||
         b == BranchKind::TENSION_CORNER_S12_T3;
}

inline bool is_shear_edge_branch_kind(BranchKind b) {
  return b == BranchKind::EDGE_S23_EQUAL || b == BranchKind::EDGE_S12_EQUAL;
}

// ---------------------------------------------------------------------------
// JS:915 activeYieldSurfaceFromBranchKind
// ---------------------------------------------------------------------------
inline YieldSurface active_yield_surface_from_branch_kind(BranchKind b) {
  switch (b) {
    case BranchKind::FACE_F13: return YieldSurface::MC_FACE;
    case BranchKind::EDGE_S23_EQUAL:
    case BranchKind::EDGE_S12_EQUAL: return YieldSurface::MC_EDGE;
    case BranchKind::APEX_FORMAL: return YieldSurface::MC_APEX;
    case BranchKind::TENSION_PENDING:
    case BranchKind::TENSION_FACE_T3:
    case BranchKind::TENSION_EDGE_T23:
    case BranchKind::TENSION_EDGE_F13_T3:
    case BranchKind::TENSION_CORNER_S23_T3:
    case BranchKind::TENSION_CORNER_S12_T3:
    case BranchKind::TENSION_APEX_T123: return YieldSurface::TENSION;
    default: return YieldSurface::NONE;
  }
}

// ---------------------------------------------------------------------------
// JS:937 multiplicityKindFromBranchKind
// ---------------------------------------------------------------------------
inline MultiplicityKind multiplicity_kind_from_branch_kind(BranchKind b) {
  switch (b) {
    case BranchKind::EDGE_S23_EQUAL:
    case BranchKind::TENSION_EDGE_T23:
    case BranchKind::TENSION_CORNER_S23_T3:
      return MultiplicityKind::S23_EQUAL;
    case BranchKind::EDGE_S12_EQUAL:
    case BranchKind::TENSION_CORNER_S12_T3:
      return MultiplicityKind::S12_EQUAL;
    case BranchKind::APEX_FORMAL:
    case BranchKind::TENSION_APEX_T123:
      return MultiplicityKind::ALL_EQUAL;
    default:
      return MultiplicityKind::DISTINCT;
  }
}

// ---------------------------------------------------------------------------
// JS:954 activeSurfaceIdsForBranchKind
// Returns an ordered list of single-char surface IDs:
//   'a' = F12, 'b' = F13, 'c' = F23, 't' = T3.
// ---------------------------------------------------------------------------
inline std::vector<char> active_surface_ids_for_branch_kind(BranchKind b) {
  switch (b) {
    case BranchKind::FACE_F13: return {'b'};
    case BranchKind::EDGE_S23_EQUAL: return {'a', 'b'};
    case BranchKind::EDGE_S12_EQUAL: return {'b', 'c'};
    case BranchKind::APEX_FORMAL: return {'a', 'b', 'c'};
    case BranchKind::TENSION_FACE_T3: return {'t'};
    case BranchKind::TENSION_EDGE_T23: return {'t'};
    case BranchKind::TENSION_EDGE_F13_T3: return {'b', 't'};
    case BranchKind::TENSION_CORNER_S23_T3: return {'b', 't'};
    case BranchKind::TENSION_CORNER_S12_T3: return {'b', 't'};
    case BranchKind::TENSION_APEX_T123: return {'t'};
    default: return {};
  }
}

// ---------------------------------------------------------------------------
// JS:981 classifyTangentQuality
// ---------------------------------------------------------------------------
enum class TangentQuality : std::uint8_t {
  SINGULAR = 0,
  VERY_POOR,
  POOR,
  FAIR,
  GOOD
};
inline TangentQuality classify_tangent_quality(double conditionNumber) {
  if (!std::isfinite(conditionNumber)) return TangentQuality::SINGULAR;
  if (conditionNumber > 1e12) return TangentQuality::VERY_POOR;
  if (conditionNumber > 1e9) return TangentQuality::POOR;
  if (conditionNumber > 1e6) return TangentQuality::FAIR;
  return TangentQuality::GOOD;
}

// ---------------------------------------------------------------------------
// JS:1020 representativeBasisPriorityList — the JS parses a string
// `representativeBasisPolicy`; the C++ MaterialParameters carries a
// pre-parsed std::array<std::uint8_t,3>. Codes: 0 = committed,
// 1 = trial, 2 = canonical. Defaults to {committed, trial, canonical}.
// We unique-ify and ensure canonical is the last fallback.
// ---------------------------------------------------------------------------
inline std::vector<std::uint8_t> representative_basis_priority_list(const MaterialParameters& mp) {
  std::vector<std::uint8_t> out;
  for (std::uint8_t c : mp.representativeBasisPriority) {
    if (c > 2) continue;
    bool seen = false;
    for (std::uint8_t x : out) if (x == c) { seen = true; break; }
    if (!seen) out.push_back(c);
  }
  if (out.empty()) return {0, 1, 2};
  bool hasCanon = false;
  for (std::uint8_t x : out) if (x == 2) { hasCanon = true; break; }
  if (!hasCanon) out.push_back(2);
  return out;
}

// ---------------------------------------------------------------------------
// JS:1034 directionCandidatesFromCommittedState. Returns up to 3
// candidate directions extracted from the committed-state projectors.
// `committedRepresentativeProjectors == nullptr` (no committed history)
// yields an empty list.
// ---------------------------------------------------------------------------
inline std::vector<Vec3> direction_candidates_from_committed_state(
    const PrincipalProjectors* committedRepresentativeProjectors,
    MultiplicityKind multiplicityKind) {
  std::vector<Vec3> out;
  if (!committedRepresentativeProjectors) return out;
  const auto& proj = *committedRepresentativeProjectors;
  if (multiplicityKind == MultiplicityKind::S23_EQUAL) {
    out.push_back(jsm::rank_one_projector_to_direction(proj.P2, Vec3{0.0, 1.0, 0.0}));
    out.push_back(jsm::rank_one_projector_to_direction(proj.P3, Vec3{0.0, 0.0, 1.0}));
  } else if (multiplicityKind == MultiplicityKind::S12_EQUAL) {
    out.push_back(jsm::rank_one_projector_to_direction(proj.P1, Vec3{1.0, 0.0, 0.0}));
    out.push_back(jsm::rank_one_projector_to_direction(proj.P2, Vec3{0.0, 1.0, 0.0}));
  } else {
    out.push_back(jsm::rank_one_projector_to_direction(proj.P1, Vec3{1.0, 0.0, 0.0}));
    out.push_back(jsm::rank_one_projector_to_direction(proj.P2, Vec3{0.0, 1.0, 0.0}));
    out.push_back(jsm::rank_one_projector_to_direction(proj.P3, Vec3{0.0, 0.0, 1.0}));
  }
  return out;
}

// ---------------------------------------------------------------------------
// JS:1052 chooseProjectedDirection. Returns the first candidate that
// has a positive norm after projecting onto `subspaceProjector` and
// orthogonalising against the `forbidden` directions. Returns
// `{found=false, ...}` if none qualify.
// ---------------------------------------------------------------------------
struct ChosenDirection { bool found{ false }; Vec3 direction{}; };
inline ChosenDirection choose_projected_direction(
    const Mat3& subspaceProjector,
    const std::vector<Vec3>& candidateDirections,
    const std::vector<Vec3>& forbidden,
    double tolerance = 1e-10) {
  for (const auto& candidate : candidateDirections) {
    Vec3 projected = jsm::multiply_matrix3x3_vector3(subspaceProjector, candidate);
    for (const auto& dir : forbidden) {
      const double norm = jsm::vector_norm3(dir);
      if (!(norm > tolerance)) continue;
      const Vec3 normalised = jsm::scale_vector3(dir, 1.0 / norm);
      const double dotVal = jsm::dot_vector3(projected, normalised);
      projected = jsm::subtract_vector3(projected, jsm::scale_vector3(normalised, dotVal));
    }
    const double norm = jsm::vector_norm3(projected);
    if (norm > tolerance) {
      ChosenDirection r;
      r.found = true;
      r.direction = jsm::scale_vector3(projected, 1.0 / norm);
      return r;
    }
  }
  return ChosenDirection{false, Vec3{}};
}

// ---------------------------------------------------------------------------
// JS:1241 classifyTrialBranchKind
// ---------------------------------------------------------------------------
inline BranchKind classify_trial_branch_kind(const Vec3& principalTrialValues,
                                             const SurfaceValues& trialSurfaceValues,
                                             double edgeTolerance,
                                             double apexTolerance,
                                             const MaterialParameters& mp) {
  const double s1 = principalTrialValues[0];
  const double s2 = principalTrialValues[1];
  const double s3 = principalTrialValues[2];
  const double gap12 = std::abs(s1 - s2);
  const double gap23 = std::abs(s2 - s3);
  const double f12 = trialSurfaceValues.F12;
  const double f13 = trialSurfaceValues.F13;
  const double f23 = trialSurfaceValues.F23;
  const double t3 = trialSurfaceValues.T3;
  const SurfaceParameters sp = exact_mc_surface_parameters(mp);
  if (sp.useTensionCutoff && t3 > 0.0) {
    if (gap12 <= apexTolerance && gap23 <= apexTolerance) return BranchKind::TENSION_APEX_T123;
    if (gap23 <= edgeTolerance && f13 > 0.0) return BranchKind::TENSION_CORNER_S23_T3;
    if (gap23 <= edgeTolerance) return BranchKind::TENSION_EDGE_T23;
    if (f13 > 0.0 && (gap12 <= edgeTolerance || f23 > 0.0)) return BranchKind::TENSION_CORNER_S12_T3;
    if (f13 > 0.0) return BranchKind::TENSION_EDGE_F13_T3;
    return BranchKind::TENSION_FACE_T3;
  }
  if (gap12 <= apexTolerance && gap23 <= apexTolerance &&
      is_near_formal_shear_apex(principalTrialValues, mp, apexTolerance)) {
    return mp.allowFormalApexBranch ? BranchKind::APEX_FORMAL : BranchKind::FACE_F13;
  }
  if (gap23 <= edgeTolerance || (f12 > 0.0 && f13 > 0.0)) return BranchKind::EDGE_S23_EQUAL;
  if (gap12 <= edgeTolerance || (f13 > 0.0 && f23 > 0.0)) return BranchKind::EDGE_S12_EQUAL;
  if (f13 > 0.0) return BranchKind::FACE_F13;
  return BranchKind::ELASTIC;
}

// ===========================================================================
// P3 — Active-set return mapping (JS:1069 onwards).
// ===========================================================================

// ---------------------------------------------------------------------------
// JS:1069 buildRepeatedSubspaceProjectors — produce the representative
// projector triple (P1, P2, P3) that is consistent with the branch's
// principal-stress multiplicity. For shear-edge branches (S23 or S12),
// the repeated subspace is rebuilt from a chosen direction inside it.
// `committedRepresentativeProjectors` may be nullptr (no committed
// state); the priority list then falls through to trial / canonical
// seeds.
// ---------------------------------------------------------------------------
enum class RepresentativeBasisSource : std::uint8_t {
  TRIAL = 0,
  COMMITTED,
  CANONICAL
};
struct RepresentativeBasisResult {
  RepresentativeBasisSource representativeBasisSource{ RepresentativeBasisSource::TRIAL };
  PrincipalProjectors representativeProjectors{};
  // P23 / P12 are only set for repeated-eigenvalue branches; we keep
  // them out of the simple Projectors triple but copy them into the
  // optional fields below.
  bool hasP23{ false };
  Mat3 P23{};
  bool hasP12{ false };
  Mat3 P12{};
};

inline RepresentativeBasisResult build_repeated_subspace_projectors(
    const PrincipalState& principalState,
    BranchKind branchKind,
    const PrincipalProjectors* committedRepresentativeProjectors,
    const MaterialParameters& mp,
    double tolerance) {
  RepresentativeBasisResult out;
  if (!is_lower_repeated_branch_kind(branchKind) && !is_upper_repeated_branch_kind(branchKind)) {
    out.representativeBasisSource = RepresentativeBasisSource::TRIAL;
    out.representativeProjectors.P1 = principalState.P1;
    out.representativeProjectors.P2 = principalState.P2;
    out.representativeProjectors.P3 = principalState.P3;
    return out;
  }
  const std::vector<std::uint8_t> priority = representative_basis_priority_list(mp);
  const MultiplicityKind multiplicityKind = multiplicity_kind_from_branch_kind(branchKind);
  const Mat3 repeatedProjector = is_lower_repeated_branch_kind(branchKind)
      ? jsm::add_matrix3(principalState.P2, principalState.P3)
      : jsm::add_matrix3(principalState.P1, principalState.P2);
  const Vec3 distinctDirection = is_lower_repeated_branch_kind(branchKind)
      ? jsm::rank_one_projector_to_direction(principalState.P1, Vec3{1.0, 0.0, 0.0})
      : jsm::rank_one_projector_to_direction(principalState.P3, Vec3{0.0, 0.0, 1.0});
  const std::vector<Vec3> trialSeeds = is_lower_repeated_branch_kind(branchKind)
      ? std::vector<Vec3>{
          jsm::rank_one_projector_to_direction(principalState.P2, Vec3{0.0, 1.0, 0.0}),
          jsm::rank_one_projector_to_direction(principalState.P3, Vec3{0.0, 0.0, 1.0})
        }
      : std::vector<Vec3>{
          jsm::rank_one_projector_to_direction(principalState.P1, Vec3{1.0, 0.0, 0.0}),
          jsm::rank_one_projector_to_direction(principalState.P2, Vec3{0.0, 1.0, 0.0})
        };
  const std::vector<Vec3> canonicalSeeds{
    Vec3{1.0, 0.0, 0.0}, Vec3{0.0, 1.0, 0.0}, Vec3{0.0, 0.0, 1.0}
  };

  RepresentativeBasisSource sourceUsed = RepresentativeBasisSource::CANONICAL;
  ChosenDirection primary;
  for (std::uint8_t source : priority) {
    std::vector<Vec3> seeds;
    if (source == 0) {
      seeds = direction_candidates_from_committed_state(
          committedRepresentativeProjectors, multiplicityKind);
    } else if (source == 1) {
      seeds = trialSeeds;
    } else {
      seeds = canonicalSeeds;
    }
    primary = choose_projected_direction(repeatedProjector, seeds, {distinctDirection}, tolerance);
    if (primary.found) {
      sourceUsed = static_cast<RepresentativeBasisSource>(source);
      break;
    }
  }
  if (!primary.found) {
    primary = choose_projected_direction(repeatedProjector, canonicalSeeds, {distinctDirection}, tolerance);
    if (!primary.found) {
      primary.found = true;
      primary.direction = is_lower_repeated_branch_kind(branchKind)
          ? Vec3{0.0, 1.0, 0.0}
          : Vec3{1.0, 0.0, 0.0};
    }
    sourceUsed = RepresentativeBasisSource::CANONICAL;
  }

  // Secondary direction: cross(distinct, primary) then re-project into
  // the repeated subspace, orthogonalising against (distinct, primary).
  Vec3 secondary = jsm::cross_vector3(distinctDirection, primary.direction);
  std::vector<Vec3> secondarySeeds = canonicalSeeds;
  secondarySeeds.insert(secondarySeeds.begin(), secondary);
  ChosenDirection secondaryChoice = choose_projected_direction(
      repeatedProjector, secondarySeeds,
      {distinctDirection, primary.direction}, tolerance);
  Vec3 secondaryDir = secondaryChoice.found
      ? secondaryChoice.direction
      : jsm::normalize_vector3(jsm::cross_vector3(distinctDirection, primary.direction),
                               is_lower_repeated_branch_kind(branchKind)
                                   ? Vec3{0.0, 0.0, 1.0}
                                   : Vec3{0.0, 1.0, 0.0});

  out.representativeBasisSource = sourceUsed;
  if (is_lower_repeated_branch_kind(branchKind)) {
    out.representativeProjectors.P1 = principalState.P1;
    out.representativeProjectors.P2 = jsm::principal_direction_to_projector(primary.direction);
    out.representativeProjectors.P3 = jsm::principal_direction_to_projector(secondaryDir);
    out.hasP23 = true;
    out.P23 = repeatedProjector;
  } else {
    out.representativeProjectors.P1 = jsm::principal_direction_to_projector(primary.direction);
    out.representativeProjectors.P2 = jsm::principal_direction_to_projector(secondaryDir);
    out.representativeProjectors.P3 = principalState.P3;
    out.hasP12 = true;
    out.P12 = repeatedProjector;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JS:1150 buildSurfaceMapForProjectors
// ---------------------------------------------------------------------------
struct SurfaceMap {
  std::vector<Surface> surfaces;
  // Indexed by char ID: 'a','b','c','t'.
  Surface* find(char id) {
    for (auto& s : surfaces) if (s.id == id) return &s;
    return nullptr;
  }
  const Surface* find(char id) const {
    for (const auto& s : surfaces) if (s.id == id) return &s;
    return nullptr;
  }
};
inline SurfaceMap build_surface_map_for_projectors(const PrincipalProjectors& projectors,
                                                   const MaterialParameters& mp,
                                                   BranchKind branchKind) {
  SurfaceMap out;
  out.surfaces = build_exact_mc_surfaces(projectors, mp, branchKind);
  return out;
}

// ---------------------------------------------------------------------------
// JS:1158 buildStressTensorProjectorsForBranch — in JS every branch
// returns the same P1/P2/P3 of the representative projectors. We
// mirror that (no override) but expose the routine for parity.
// ---------------------------------------------------------------------------
inline PrincipalProjectors build_stress_tensor_projectors_for_branch(
    BranchKind /*branchKind*/, const PrincipalProjectors& representativeProjectors) {
  return representativeProjectors;
}

// ---------------------------------------------------------------------------
// JS:1180 representedPrincipalValuesForBranch — collapse the repeated
// principal-stress pair to its average so the reassembled stress tensor
// is rotationally consistent with the chosen subspace basis.
// ---------------------------------------------------------------------------
inline Vec3 represented_principal_values_for_branch(BranchKind branchKind,
                                                    const Vec3& principalValues) {
  const double s1 = principalValues[0];
  const double s2 = principalValues[1];
  const double s3 = principalValues[2];
  if (is_lower_repeated_branch_kind(branchKind)) {
    const double rep = 0.5 * (s2 + s3);
    return Vec3{s1, rep, rep};
  }
  if (is_upper_repeated_branch_kind(branchKind)) {
    const double rep = 0.5 * (s1 + s2);
    return Vec3{rep, rep, s3};
  }
  if (branchKind == BranchKind::APEX_FORMAL || branchKind == BranchKind::TENSION_APEX_T123) {
    const double rep = (s1 + s2 + s3) / 3.0;
    return Vec3{rep, rep, rep};
  }
  return principalValues;
}

// ---------------------------------------------------------------------------
// JS:1197 evaluatePrincipalSurfaceValue — n_p · σ_p − intercept.
// ---------------------------------------------------------------------------
inline double evaluate_principal_surface_value(const Surface& surface,
                                               const Vec3& principalValues) {
  return jsm::dot_vector3(surface.nPrincipal, principalValues) - surface.intercept;
}

// ---------------------------------------------------------------------------
// JS:1202 solveExactMcActiveSystemPrincipal — couple the active surfaces'
// gradients with the principal-frame elastic stiffness D_n, solve for
// the plastic multipliers, and return the corrected principal-stress
// triple plus the coupling matrix (used later for the algorithmic
// tangent).
// ---------------------------------------------------------------------------
struct ActiveSystemResult {
  bool converged{ false };
  std::vector<double> plasticMultipliers;
  std::vector<std::vector<double>> couplingMatrix;
  double conditionNumber{ 0.0 };
  Vec3 stressReturnPrincipal{ 0.0, 0.0, 0.0 };
};

inline ActiveSystemResult solve_exact_mc_active_system_principal(
    const Vec3& trialPrincipalValues,
    const std::vector<char>& activeSurfaceIds,
    const SurfaceMap& principalSurfaceMap,
    const Mat3& D_n,
    double complementarityTolerance) {
  std::vector<const Surface*> activeSurfaces;
  activeSurfaces.reserve(activeSurfaceIds.size());
  for (char id : activeSurfaceIds) {
    const Surface* s = principalSurfaceMap.find(id);
    if (s) activeSurfaces.push_back(s);
  }
  const std::size_t na = activeSurfaces.size();
  ActiveSystemResult res;
  if (na == 0) {
    res.converged = false;
    return res;
  }
  res.couplingMatrix.assign(na, std::vector<double>(na, 0.0));
  std::vector<double> rhs(na, 0.0);
  for (std::size_t i = 0; i < na; ++i) {
    for (std::size_t j = 0; j < na; ++j) {
      res.couplingMatrix[i][j] = jsm::dot_vector3(
          activeSurfaces[i]->nPrincipal,
          jsm::multiply_matrix3x3_vector3(D_n, activeSurfaces[j]->mPrincipal));
    }
    rhs[i] = evaluate_principal_surface_value(*activeSurfaces[i], trialPrincipalValues);
  }
  const double pivotTolerance = jsm::relative_pivot_tolerance(res.couplingMatrix);
  std::vector<double> multipliers;
  if (!jsm::solve_dense_linear_system(res.couplingMatrix, rhs, multipliers, pivotTolerance)) {
    res.converged = false;
    return res;
  }
  res.conditionNumber = jsm::dense_matrix_condition_number_estimate(res.couplingMatrix, pivotTolerance);
  for (double l : multipliers) {
    if (l < -complementarityTolerance) {
      res.converged = false;
      res.plasticMultipliers = multipliers;
      return res;
    }
  }
  res.plasticMultipliers = multipliers;
  // Flow direction in principal frame: g_p = Σ_α λ_α m_α.
  Vec3 plasticFlowPrincipal{0.0, 0.0, 0.0};
  for (std::size_t a = 0; a < na; ++a) {
    plasticFlowPrincipal = jsm::add_vector3(plasticFlowPrincipal,
        jsm::scale_vector3(activeSurfaces[a]->mPrincipal, multipliers[a]));
  }
  const Vec3 stressCorrectionPrincipal = jsm::multiply_matrix3x3_vector3(D_n, plasticFlowPrincipal);
  res.stressReturnPrincipal = jsm::subtract_vector3(trialPrincipalValues, stressCorrectionPrincipal);
  res.converged = true;
  return res;
}

// ---------------------------------------------------------------------------
// JS:776 computeExactElastoplasticTangent — branch-frozen spectral
// derivative of the exact active-set return. The returned tensor is
// f(σ_trial) = Q_trial diag(s_return(s_trial)) Q_trial^T. The diagonal
// principal block is I - D_n M H^{-1} N^T, with H_{p,q} = n_p · D_n · m_q;
// the off-diagonal block is the divided-difference eigenvector derivative.
// ---------------------------------------------------------------------------
struct ExactTangentResult {
  bool valid{ false };
  bool elasticFallback{ false };
  Mat6 tangent6x6{};
};

inline Mat3 principal_projector_basis_matrix(const PrincipalProjectors& proj) {
  const Vec3 e1 = jsm::rank_one_projector_to_direction(proj.P1, Vec3{1.0, 0.0, 0.0});
  Vec3 e2 = jsm::rank_one_projector_to_direction(proj.P2, Vec3{0.0, 1.0, 0.0});
  Vec3 e3 = jsm::cross_vector3(e1, e2);
  if (!(jsm::vector_norm3(e3) > 1e-10)) {
    e3 = jsm::rank_one_projector_to_direction(proj.P3, Vec3{0.0, 0.0, 1.0});
  } else {
    e3 = jsm::normalize_vector3(e3, Vec3{0.0, 0.0, 1.0});
  }
  // Rebuild e2 from e3 x e1 so the basis is orthonormal even when projector
  // column extraction carried small roundoff.
  e2 = jsm::normalize_vector3(jsm::cross_vector3(e3, e1), e2);
  return Mat3{{
    {e1[0], e2[0], e3[0]},
    {e1[1], e2[1], e3[1]},
    {e1[2], e2[2], e3[2]}
  }};
}

inline Mat3 rotate_compression_tensor_to_principal(const Mat3& tensor,
                                                   const Mat3& basis) {
  Mat3 out{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      double v = 0.0;
      for (int a = 0; a < 3; ++a) {
        for (int b = 0; b < 3; ++b) v += basis[a][i] * tensor[a][b] * basis[b][j];
      }
      out[i][j] = v;
    }
  }
  return out;
}

inline Mat3 rotate_principal_tensor_to_compression(const Mat3& principal,
                                                   const Mat3& basis) {
  Mat3 out{};
  for (int a = 0; a < 3; ++a) {
    for (int b = 0; b < 3; ++b) {
      double v = 0.0;
      for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) v += basis[a][i] * principal[i][j] * basis[b][j];
      }
      out[a][b] = v;
    }
  }
  return out;
}

inline ExactTangentResult compute_exact_elastoplastic_tangent(
    const Mat6& Ce6,
    const std::vector<Surface>& activeSurfaces,
    const std::vector<std::vector<double>>& couplingMatrix,
    const MaterialParameters& mp,
    const Vec3& trialPrincipalValues,
    const Vec3& returnedPrincipalValues,
    const PrincipalProjectors& trialProjectors) {
  ExactTangentResult out;
  if (activeSurfaces.empty()) {
    out.valid = true;
    out.tangent6x6 = Ce6;
    return out;
  }
  const double pivotTolerance = jsm::relative_pivot_tolerance(couplingMatrix);
  std::vector<std::vector<double>> inverseCoupling;
  if (!jsm::invert_dense_matrix(couplingMatrix, inverseCoupling, pivotTolerance)) {
    out.valid = false;
    return out;
  }
  const std::size_t na = activeSurfaces.size();
  const Mat3 Dn = principal_elastic_matrix_3x3(mp);

  double Bdiag[3][3]{};
  for (int i = 0; i < 3; ++i) Bdiag[i][i] = 1.0;
  std::vector<Vec3> DmColumns(na);
  for (std::size_t q = 0; q < na; ++q) {
    DmColumns[q] = jsm::multiply_matrix3x3_vector3(Dn, activeSurfaces[q].mPrincipal);
  }
  for (std::size_t q = 0; q < na; ++q) {
    for (std::size_t p = 0; p < na; ++p) {
      const double scale = inverseCoupling[q][p];
      if (!std::isfinite(scale) || scale == 0.0) continue;
      for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
          Bdiag[i][j] -= DmColumns[q][i] * scale * activeSurfaces[p].nPrincipal[j];
        }
      }
    }
  }

  double shearFactor[3][3]{};
  bool spectralOk = true;
  for (int i = 0; i < 3; ++i) {
    for (int j = i + 1; j < 3; ++j) {
      const double denom = trialPrincipalValues[i] - trialPrincipalValues[j];
      const double scale = std::max({
          std::abs(trialPrincipalValues[i]),
          std::abs(trialPrincipalValues[j]),
          std::abs(returnedPrincipalValues[i]),
          std::abs(returnedPrincipalValues[j]),
          1.0});
      if (std::abs(denom) <= 1e-10 * scale) {
        spectralOk = false;
        continue;
      }
      const double factor = (returnedPrincipalValues[i] - returnedPrincipalValues[j]) / denom;
      shearFactor[i][j] = factor;
      shearFactor[j][i] = factor;
    }
  }
  if (!spectralOk) {
    out.valid = true;
    out.elasticFallback = true;
    out.tangent6x6 = Ce6;
    return out;
  }

  const Mat3 basis = principal_projector_basis_matrix(trialProjectors);
  Mat6 tangent{};
  for (int col = 0; col < 6; ++col) {
    Vec6 strainBasis{};
    strainBasis[col] = 1.0;
    const Vec6 trialStressRateTens = jsm::multiply_matrix6x6_vector6(Ce6, strainBasis);
    const Mat3 trialRateComp = jsm::compression_positive_stress_tensor3_from6(trialStressRateTens);
    const Mat3 trialRatePrincipal =
        rotate_compression_tensor_to_principal(trialRateComp, basis);
    Mat3 returnedRatePrincipal{};
    for (int i = 0; i < 3; ++i) {
      for (int j = 0; j < 3; ++j) {
        if (i != j) returnedRatePrincipal[i][j] = shearFactor[i][j] * trialRatePrincipal[i][j];
      }
    }
    for (int i = 0; i < 3; ++i) {
      for (int j = 0; j < 3; ++j) {
        returnedRatePrincipal[i][i] += Bdiag[i][j] * trialRatePrincipal[j][j];
      }
    }
    const Mat3 returnedRateComp =
        rotate_principal_tensor_to_compression(returnedRatePrincipal, basis);
    const Vec6 colStressTens = jsm::compression_positive_tensor3_to_stress6(returnedRateComp);
    for (int row = 0; row < 6; ++row) tangent[row][col] = colStressTens[row];
  }
  if (mp.symmetrizeEpTangent) tangent = jsm::symmetrize_matrix6(tangent);
  out.tangent6x6 = tangent;
  out.valid = true;
  return out;
}

// ---------------------------------------------------------------------------
// JS:1266 solveExactMcCandidateBranch — per-branch solver. Mirrors the
// JS structure: build active-set, solve principal system, verify
// admissibility, branch-specific promotion / acceptance checks, then
// compute the consistent algorithmic tangent.
// ---------------------------------------------------------------------------
struct ToleranceState {
  double localTolerance{ 0.0 };
  double edgeTolerance{ 0.0 };
  double apexTolerance{ 0.0 };
  double apexHydrostaticTolerance{ 0.0 };
  double eigenSubspaceTolerance{ 0.0 };
  double complementarityTolerance{ 0.0 };
};

struct CandidateBranchResult {
  bool converged{ false };
  bool routePending{ false };
  bool promote{ false };
  BranchKind promoteTo{ BranchKind::ELASTIC };
  std::int32_t iterations{ 0 };
  Vec6 stress6_tens{};
  Vec6 plasticStrainIncrement6{};
  Mat6 algorithmicTangent6x6{};
  YieldSurface activeYieldSurface{ YieldSurface::NONE };
  std::vector<char> activeSurfaceIds;
  double yieldResidual{ 0.0 };
  BranchKind acceptedBranchKind{ BranchKind::ELASTIC };
  BranchKind branchKind{ BranchKind::ELASTIC };
  RepresentativeBasisSource representativeBasisSource{ RepresentativeBasisSource::TRIAL };
  PrincipalProjectors representativeProjectors{};
  MultiplicityKind finalMultiplicityKind{ MultiplicityKind::DISTINCT };
  double edgeTotalMultiplier{ 0.0 };
  double edgeMixWeight{ 0.0 };
  std::vector<double> plasticMultipliers;
  double tangentConditionNumber{ 1.0 };
  TangentQuality tangentQuality{ TangentQuality::GOOD };
  double branchAcceptanceResidual{ 0.0 };
};

// Optional `committedState` is supplied by the caller (it provides the
// representativeProjectors used by `buildRepeatedSubspaceProjectors`).
// In this initial port we accept a pointer-to-projectors instead of the
// full state struct; the plugin layer will pack the real committed
// state when it wraps the call.
struct CommittedStateSummary {
  bool hasRepresentativeProjectors{ false };
  PrincipalProjectors representativeProjectors{};
  BranchKind exactBranchKind{ BranchKind::ELASTIC };
  YieldSurface activeYieldSurface{ YieldSurface::NONE };
  MultiplicityKind multiplicityKind{ MultiplicityKind::DISTINCT };
};

inline CandidateBranchResult solve_exact_mc_candidate_branch(
    BranchKind branchKind,
    const Vec6& stressTrial6_tens,
    const PrincipalState& trialPrincipal,
    const Mat6& elasticTangent6x6,
    const MaterialParameters& mp,
    const McTrial& mcTrial,
    const CommittedStateSummary* committedState,
    const ToleranceState& toleranceState) {
  CandidateBranchResult res;
  res.branchKind = branchKind;
  const Vec3 trialPrincipalValues{trialPrincipal.s1, trialPrincipal.s2, trialPrincipal.s3};
  const SurfaceValues trialSurfaceValues = evaluate_exact_mc_surface_values_from_principal(
      trialPrincipalValues, mp);
  res.activeSurfaceIds = active_surface_ids_for_branch_kind(branchKind);
  if (res.activeSurfaceIds.empty()) {
    res.converged = false;
    return res;
  }
  if (branchKind == BranchKind::APEX_FORMAL) {
    const SurfaceParameters sp = exact_mc_surface_parameters(mp);
    if (!mp.allowFormalApexBranch) {
      res.converged = false;
      res.routePending = true;
      return res;
    }
    if (!(std::abs(sp.sinPsi) > 1e-12)) {
      res.converged = false;
      res.routePending = true;
      return res;
    }
  }
  const double complementarityTolerance = resolve_active_set_complementarity_tolerance(
      mp, trialPrincipalValues, mcTrial, toleranceState.edgeTolerance);
  const Mat3 D_n = principal_elastic_matrix_3x3(mp);
  const SurfaceMap trialSurfaceBundle = build_surface_map_for_projectors(
      PrincipalProjectors{trialPrincipal.P1, trialPrincipal.P2, trialPrincipal.P3}, mp, branchKind);

  const PrincipalProjectors* committedRep = (committedState && committedState->hasRepresentativeProjectors)
      ? &committedState->representativeProjectors : nullptr;
  RepresentativeBasisResult representative = build_repeated_subspace_projectors(
      trialPrincipal, branchKind, committedRep, mp, toleranceState.eigenSubspaceTolerance);
  res.representativeBasisSource = representative.representativeBasisSource;
  res.representativeProjectors = representative.representativeProjectors;
  const SurfaceMap representativeSurfaceBundle = build_surface_map_for_projectors(
      representative.representativeProjectors, mp, branchKind);

  ActiveSystemResult principalSolve = solve_exact_mc_active_system_principal(
      trialPrincipalValues, res.activeSurfaceIds, trialSurfaceBundle,
      D_n, complementarityTolerance);
  if (!principalSolve.converged) {
    res.converged = false;
    return res;
  }

  const Vec3 representedPrincipalValues = represented_principal_values_for_branch(
      branchKind, principalSolve.stressReturnPrincipal);

  if (branchKind == BranchKind::APEX_FORMAL) {
    const bool nearApex = is_near_formal_shear_apex(
        representedPrincipalValues, mp, toleranceState.apexTolerance);
    const SurfaceParameters sp = exact_mc_surface_parameters(mp);
    if (nearApex && (!mp.allowFormalApexBranch || !(std::abs(sp.sinPsi) > 1e-12))) {
      res.converged = false;
      res.routePending = true;
      return res;
    }
  }

  const PrincipalProjectors stressTensorProjectors = build_stress_tensor_projectors_for_branch(
      branchKind, representative.representativeProjectors);
  const Mat3 stressTensor = projectors_to_compression_positive_stress_tensor(
      representedPrincipalValues, stressTensorProjectors);
  res.stress6_tens = jsm::compression_positive_tensor3_to_stress6(stressTensor);

  // Plastic strain increment (engineering Voigt-6, tension-positive)
  // built from the representative surfaces' m6 (each is the global-
  // frame engineering-Voigt-6 gradient for one of the active surfaces).
  Vec6 plasticStrainIncrement6 = jsm::zero_vector6();
  std::vector<Surface> activeRepresentativeSurfaces;
  activeRepresentativeSurfaces.reserve(res.activeSurfaceIds.size());
  for (std::size_t i = 0; i < res.activeSurfaceIds.size(); ++i) {
    const Surface* surf = representativeSurfaceBundle.find(res.activeSurfaceIds[i]);
    if (!surf) continue;
    activeRepresentativeSurfaces.push_back(*surf);
    plasticStrainIncrement6 = jsm::add_vector6(
        plasticStrainIncrement6,
        jsm::scale_vector6(surf->m6, principalSolve.plasticMultipliers[i]));
  }

  // Tangent coupling matrix (global Voigt-6 form for the multi-surface
  // tangent). H_{ij} = n_i · C^e · m_j with `dot` being plain Euclidean
  // since both n6 and (C^e m6) are stored in the engineering Voigt
  // form here (matching JS dotVector6).
	  std::vector<std::vector<double>> tangentCoupling(activeRepresentativeSurfaces.size(),
	      std::vector<double>(activeRepresentativeSurfaces.size(), 0.0));
	  for (std::size_t i = 0; i < activeRepresentativeSurfaces.size(); ++i) {
	    const Vec6 Cm = jsm::multiply_matrix6x6_vector6(elasticTangent6x6,
	                                                    activeRepresentativeSurfaces[i].m6);
    for (std::size_t j = 0; j < activeRepresentativeSurfaces.size(); ++j) {
      tangentCoupling[j][i] = jsm::dot_vector6(activeRepresentativeSurfaces[j].n6, Cm);
    }
  }
  res.tangentConditionNumber = jsm::dense_matrix_condition_number_estimate(
      tangentCoupling, 1e-12);

  // Returned-stress surface evaluation (compression-positive).
  const PrincipalAndValues exactCurrent = evaluate_exact_mc_surface_values_from_stress(
      res.stress6_tens, mp);
  const SurfaceValues& exactValues = exactCurrent.values;
  const double maxPositiveResidual = std::max({
      0.0, exactValues.F12, exactValues.F13, exactValues.F23,
      (exactValues.useTensionCutoff ? exactValues.T3 : 0.0)});
  double activeResidual = 0.0;
  double inactivePositiveResidual = 0.0;
  auto value_for = [&](char id) -> double {
    switch (id) {
      case 'a': return exactValues.F12;
      case 'b': return exactValues.F13;
      case 'c': return exactValues.F23;
      case 't': return exactValues.T3;
      default:  return 0.0;
    }
  };
  for (char id : res.activeSurfaceIds) {
    activeResidual = std::max(activeResidual, std::abs(value_for(id)));
  }
  std::array<char, 4> allIds{'a', 'b', 'c', 't'};
  for (char id : allIds) {
    bool isActive = false;
    for (char a : res.activeSurfaceIds) if (a == id) { isActive = true; break; }
    if (isActive) continue;
    if (id == 't' && !exactValues.useTensionCutoff) continue;
    inactivePositiveResidual = std::max(inactivePositiveResidual, std::max(value_for(id), 0.0));
  }

  const PrincipalState principalFinal = exactCurrent.principal;
  const double gap12 = std::abs(principalFinal.s1 - principalFinal.s2);
  const double gap23 = std::abs(principalFinal.s2 - principalFinal.s3);

  res.edgeTotalMultiplier = is_shear_edge_branch_kind(branchKind)
      ? std::accumulate(principalSolve.plasticMultipliers.begin(),
                        principalSolve.plasticMultipliers.end(), 0.0,
                        [](double acc, double v) { return acc + std::max(v, 0.0); })
      : 0.0;
  res.edgeMixWeight = (is_shear_edge_branch_kind(branchKind) && res.edgeTotalMultiplier > 0.0)
      ? std::clamp(principalSolve.plasticMultipliers.front() / res.edgeTotalMultiplier, 0.0, 1.0)
      : 0.0;
  res.branchAcceptanceResidual = std::max({activeResidual, inactivePositiveResidual, maxPositiveResidual});

  if (activeResidual > toleranceState.localTolerance ||
      inactivePositiveResidual > toleranceState.localTolerance) {
    res.converged = false;
    return res;
  }

  // Branch-specific gap-closure promotions and acceptance checks
  // (JS:1400-1550).
  if (branchKind == BranchKind::FACE_F13) {
    if (gap23 <= toleranceState.edgeTolerance) {
      res.converged = false; res.promote = true; res.promoteTo = BranchKind::EDGE_S23_EQUAL;
      return res;
    }
    if (gap12 <= toleranceState.edgeTolerance) {
      res.converged = false; res.promote = true; res.promoteTo = BranchKind::EDGE_S12_EQUAL;
      return res;
    }
  }
  if (branchKind == BranchKind::TENSION_FACE_T3 && gap23 <= toleranceState.edgeTolerance) {
    res.converged = false; res.promote = true; res.promoteTo = BranchKind::TENSION_EDGE_T23;
    return res;
  }
  if (branchKind == BranchKind::TENSION_EDGE_F13_T3) {
    if (gap23 <= toleranceState.edgeTolerance) {
      res.converged = false; res.promote = true; res.promoteTo = BranchKind::TENSION_CORNER_S23_T3;
      return res;
    }
    if (gap12 <= toleranceState.edgeTolerance) {
      res.converged = false; res.promote = true; res.promoteTo = BranchKind::TENSION_CORNER_S12_T3;
      return res;
    }
  }
  if (branchKind == BranchKind::TENSION_EDGE_T23) {
    if (gap23 > toleranceState.edgeTolerance) { res.converged = false; return res; }
    if (gap12 <= toleranceState.edgeTolerance) {
      res.converged = false; res.promote = true; res.promoteTo = BranchKind::TENSION_APEX_T123;
      return res;
    }
  }
  if (branchKind == BranchKind::EDGE_S23_EQUAL && gap23 > toleranceState.edgeTolerance) {
    res.converged = false; return res;
  }
  if (branchKind == BranchKind::EDGE_S12_EQUAL && gap12 > toleranceState.edgeTolerance) {
    res.converged = false; return res;
  }
  if (branchKind == BranchKind::TENSION_CORNER_S23_T3 && gap23 > toleranceState.edgeTolerance) {
    res.converged = false; return res;
  }
  if (branchKind == BranchKind::TENSION_CORNER_S12_T3 && gap12 > toleranceState.edgeTolerance) {
    res.converged = false; return res;
  }
  if (branchKind == BranchKind::TENSION_APEX_T123 &&
      (gap12 > toleranceState.apexTolerance || gap23 > toleranceState.apexTolerance)) {
    res.converged = false; return res;
  }
  const SurfaceParameters sp = exact_mc_surface_parameters(mp);
  if ((branchKind == BranchKind::EDGE_S23_EQUAL || branchKind == BranchKind::EDGE_S12_EQUAL ||
       branchKind == BranchKind::FACE_F13) &&
      gap12 <= toleranceState.apexTolerance && gap23 <= toleranceState.apexTolerance &&
      is_near_formal_shear_apex(
          Vec3{principalFinal.s1, principalFinal.s2, principalFinal.s3},
          mp,
          toleranceState.apexHydrostaticTolerance > 0.0
              ? toleranceState.apexHydrostaticTolerance
              : toleranceState.apexTolerance) &&
      !sp.useTensionCutoff &&
      (!mp.allowFormalApexBranch || !(std::abs(sp.sinPsi) > 1e-12))) {
    res.converged = false; res.routePending = true;
    return res;
  }

  ExactTangentResult tangentResult = compute_exact_elastoplastic_tangent(
      elasticTangent6x6,
      activeRepresentativeSurfaces,
      principalSolve.couplingMatrix,
      mp,
      trialPrincipalValues,
      representedPrincipalValues,
      PrincipalProjectors{trialPrincipal.P1, trialPrincipal.P2, trialPrincipal.P3});
  if (!tangentResult.valid) {
    res.converged = false;
    res.tangentQuality = TangentQuality::SINGULAR;
    return res;
  }
  res.algorithmicTangent6x6 = tangentResult.tangent6x6;
  res.tangentQuality = classify_tangent_quality(res.tangentConditionNumber);

  res.converged = true;
  res.iterations = 1;
  res.plasticStrainIncrement6 = plasticStrainIncrement6;
  res.activeYieldSurface = active_yield_surface_from_branch_kind(branchKind);
  res.yieldResidual = maxPositiveResidual;
  res.acceptedBranchKind = branchKind;
  res.finalMultiplicityKind = multiplicity_kind_from_branch_kind(branchKind);
  res.plasticMultipliers.assign(principalSolve.plasticMultipliers.size(), 0.0);
  for (std::size_t i = 0; i < principalSolve.plasticMultipliers.size(); ++i) {
    res.plasticMultipliers[i] = std::max(principalSolve.plasticMultipliers[i], 0.0);
  }
  return res;
}

// ---------------------------------------------------------------------------
// JS:1598 solveExactMcActiveSetReturn — dispatcher with candidate
// priority, committed-branch retention, previous-trial caching,
// near-formal-apex routing, and promotion.
// ---------------------------------------------------------------------------
struct PreviousTrialSummary {
  bool hasExactBranchKind{ false };
  BranchKind exactBranchKind{ BranchKind::ELASTIC };
  YieldSurface activeYieldSurface{ YieldSurface::NONE };
};

struct ActiveSetReturnResult {
  bool converged{ false };
  std::int32_t iterations{ 0 };
  Vec6 stress6_tens{};
  Vec6 plasticStrainIncrement6{};
  Mat6 algorithmicTangent6x6{};
  YieldSurface activeYieldSurface{ YieldSurface::NONE };
  std::vector<char> activeSurfaceIds;
  double yieldResidual{ 0.0 };
  BranchKind trialBranchKind{ BranchKind::ELASTIC };
  BranchKind acceptedBranchKind{ BranchKind::ELASTIC };
  BranchKind branchKind{ BranchKind::ELASTIC };
  RepresentativeBasisSource representativeBasisSource{ RepresentativeBasisSource::TRIAL };
  PrincipalProjectors representativeProjectors{};
  MultiplicityKind trialMultiplicityKind{ MultiplicityKind::DISTINCT };
  MultiplicityKind finalMultiplicityKind{ MultiplicityKind::DISTINCT };
  double edgeTotalMultiplier{ 0.0 };
  double edgeMixWeight{ 0.0 };
  std::vector<double> plasticMultipliers;
  double tangentConditionNumber{ 1.0 };
  TangentQuality tangentQuality{ TangentQuality::GOOD };
  double branchAcceptanceResidual{ 0.0 };
};

inline ActiveSetReturnResult solve_exact_mc_active_set_return(
    const Vec6& stressTrial6_tens,
    const Mat6& elasticTangent6x6,
    const MaterialParameters& mp,
    const McTrial& mcTrial,
    const CommittedStateSummary* committedState,
    const PreviousTrialSummary* previousTrialState) {
  ActiveSetReturnResult result;
  const double tolerance = local_return_tolerance(mp, mcTrial);
  const PrincipalState principalTrial = principal_stress_projectors_3d_compression_positive(
      stressTrial6_tens, mp);
  const Vec3 trialPrincipalValues{principalTrial.s1, principalTrial.s2, principalTrial.s3};
  const SurfaceValues trialSurfaceValues = evaluate_exact_mc_surface_values_from_principal(
      trialPrincipalValues, mp);
  const double maxTrialResidual = std::max({
      0.0, trialSurfaceValues.F12, trialSurfaceValues.F13, trialSurfaceValues.F23,
      (trialSurfaceValues.useTensionCutoff ? trialSurfaceValues.T3 : 0.0)});
  const double edgeTolerance = resolve_corner_stress_gap_tolerance(mp, trialPrincipalValues, mcTrial, false);
  const double apexTolerance = resolve_corner_stress_gap_tolerance(mp, trialPrincipalValues, mcTrial, true);
  const double apexHydrostaticTolerance = resolve_apex_hydrostatic_tolerance(
      mp, trialPrincipalValues, mcTrial, apexTolerance);
  const double eigenSubspaceTolerance = resolve_eigen_subspace_tolerance(
      mp, trialPrincipalValues, mcTrial, edgeTolerance);
  ToleranceState toleranceState;
  toleranceState.localTolerance = tolerance;
  toleranceState.edgeTolerance = edgeTolerance;
  toleranceState.apexTolerance = apexTolerance;
  toleranceState.apexHydrostaticTolerance = apexHydrostaticTolerance;
  toleranceState.eigenSubspaceTolerance = eigenSubspaceTolerance;
  toleranceState.complementarityTolerance = resolve_active_set_complementarity_tolerance(
      mp, trialPrincipalValues, mcTrial, edgeTolerance);

  // ELASTIC path — JS:1615.
  if (!(maxTrialResidual > tolerance)) {
    if (committedState &&
        !active_surface_ids_for_branch_kind(committedState->exactBranchKind).empty() &&
        committedState->activeYieldSurface != YieldSurface::NONE) {
      CandidateBranchResult retained = solve_exact_mc_candidate_branch(
          committedState->exactBranchKind, stressTrial6_tens, principalTrial,
          elasticTangent6x6, mp, mcTrial, committedState, toleranceState);
      if (retained.converged) {
        result.converged = true;
        result.iterations = 0;
        result.stress6_tens = retained.stress6_tens;
        result.plasticStrainIncrement6 = retained.plasticStrainIncrement6;
        result.algorithmicTangent6x6 = retained.algorithmicTangent6x6;
        result.activeYieldSurface = retained.activeYieldSurface;
        result.activeSurfaceIds = retained.activeSurfaceIds;
        result.yieldResidual = retained.yieldResidual;
        result.trialBranchKind = committedState->exactBranchKind;
        result.acceptedBranchKind = retained.acceptedBranchKind;
        result.branchKind = retained.branchKind;
        result.representativeBasisSource = retained.representativeBasisSource;
        result.representativeProjectors = retained.representativeProjectors;
        result.trialMultiplicityKind = committedState->multiplicityKind;
        result.finalMultiplicityKind = retained.finalMultiplicityKind;
        result.edgeTotalMultiplier = retained.edgeTotalMultiplier;
        result.edgeMixWeight = retained.edgeMixWeight;
        result.plasticMultipliers = retained.plasticMultipliers;
        result.tangentConditionNumber = retained.tangentConditionNumber;
        result.tangentQuality = retained.tangentQuality;
        result.branchAcceptanceResidual = retained.branchAcceptanceResidual;
        return result;
      }
    }
    result.converged = true;
    result.iterations = 0;
    result.stress6_tens = stressTrial6_tens;
    result.plasticStrainIncrement6 = jsm::zero_vector6();
    result.algorithmicTangent6x6 = elasticTangent6x6;
    result.activeYieldSurface = YieldSurface::NONE;
    result.yieldResidual = maxTrialResidual;
    result.trialBranchKind = BranchKind::ELASTIC;
    result.acceptedBranchKind = BranchKind::ELASTIC;
    result.branchKind = BranchKind::ELASTIC;
    result.representativeBasisSource = RepresentativeBasisSource::TRIAL;
    result.representativeProjectors.P1 = principalTrial.P1;
    result.representativeProjectors.P2 = principalTrial.P2;
    result.representativeProjectors.P3 = principalTrial.P3;
    result.trialMultiplicityKind = MultiplicityKind::DISTINCT;
    result.finalMultiplicityKind = MultiplicityKind::DISTINCT;
    result.tangentConditionNumber = 1.0;
    result.tangentQuality = TangentQuality::GOOD;
    result.branchAcceptanceResidual = maxTrialResidual;
    return result;
  }

  const SurfaceParameters sp = exact_mc_surface_parameters(mp);
  const double gap12Trial = std::abs(principalTrial.s1 - principalTrial.s2);
  const double gap23Trial = std::abs(principalTrial.s2 - principalTrial.s3);
  const BranchKind trialBranchKind = classify_trial_branch_kind(
      trialPrincipalValues, trialSurfaceValues, edgeTolerance, apexTolerance, mp);
  const MultiplicityKind trialMultiplicityKind = multiplicity_kind_from_branch_kind(trialBranchKind);
  const bool tensionViolated = sp.useTensionCutoff && trialSurfaceValues.T3 > tolerance;
  const bool nearFormalApex = gap12Trial <= apexTolerance && gap23Trial <= apexTolerance &&
      is_near_formal_shear_apex(trialPrincipalValues, mp, apexHydrostaticTolerance);

  if (nearFormalApex && !mp.allowFormalApexBranch && !tensionViolated) {
    const double shearExceeded = std::max({
        trialSurfaceValues.F12, trialSurfaceValues.F13, trialSurfaceValues.F23});
    if (!(shearExceeded > tolerance)) {
      result.converged = false;
      result.yieldResidual = maxTrialResidual;
      result.trialBranchKind = trialBranchKind;
      result.trialMultiplicityKind = trialMultiplicityKind;
      return result;
    }
  }

  // Build the priority list (JS:1696-1751).
  std::vector<BranchKind> preferredCandidates;
  auto push_candidate = [&](BranchKind k) {
    if (k == BranchKind::ELASTIC) return;
    for (BranchKind x : preferredCandidates) if (x == k) return;
    preferredCandidates.push_back(k);
  };
  const BranchKind committedBranch = committedState ? committedState->exactBranchKind : BranchKind::ELASTIC;
  const bool directLowerEdge = gap23Trial <= edgeTolerance ||
      (trialSurfaceValues.F12 > tolerance && trialSurfaceValues.F13 > tolerance);
  const bool directUpperEdge = gap12Trial <= edgeTolerance ||
      (trialSurfaceValues.F13 > tolerance && trialSurfaceValues.F23 > tolerance);
  const bool committedPrefLower = committedBranch == BranchKind::EDGE_S23_EQUAL && gap23Trial <= 2.0 * edgeTolerance;
  const bool committedPrefUpper = committedBranch == BranchKind::EDGE_S12_EQUAL && gap12Trial <= 2.0 * edgeTolerance;
  const bool directTensionApex = tensionViolated && gap12Trial <= apexTolerance && gap23Trial <= apexTolerance;
  const bool directLowerTensionEdge = tensionViolated && gap23Trial <= edgeTolerance;
  const bool directLowerTensionCorner = tensionViolated && gap23Trial <= edgeTolerance && trialSurfaceValues.F13 > tolerance;
  const bool directUpperTensionCorner = tensionViolated && (gap12Trial <= edgeTolerance || trialSurfaceValues.F23 > tolerance);
  const bool committedPrefTensionApex = committedBranch == BranchKind::TENSION_APEX_T123;
  const bool committedPrefLowerTensionEdge = committedBranch == BranchKind::TENSION_EDGE_T23 && gap23Trial <= 2.0 * edgeTolerance;
  const bool committedPrefLowerTensionCorner = committedBranch == BranchKind::TENSION_CORNER_S23_T3 && gap23Trial <= 2.0 * edgeTolerance;
  const bool committedPrefUpperTensionCorner = committedBranch == BranchKind::TENSION_CORNER_S12_T3 && gap12Trial <= 2.0 * edgeTolerance;
  const bool committedPrefTensionEdge = committedBranch == BranchKind::TENSION_EDGE_F13_T3 &&
      (trialSurfaceValues.F13 > -2.0 * tolerance || nearFormalApex);
  const bool committedPrefTensionFace = committedBranch == BranchKind::TENSION_FACE_T3;

  auto pushShearCandidates = [&]() {
    if (nearFormalApex && mp.allowFormalApexBranch) push_candidate(BranchKind::APEX_FORMAL);
    if (committedPrefLower) push_candidate(BranchKind::EDGE_S23_EQUAL);
    if (committedPrefUpper) push_candidate(BranchKind::EDGE_S12_EQUAL);
    if (directLowerEdge) push_candidate(BranchKind::EDGE_S23_EQUAL);
    if (directUpperEdge) push_candidate(BranchKind::EDGE_S12_EQUAL);
    if (trialSurfaceValues.F13 > tolerance) push_candidate(BranchKind::FACE_F13);
  };
  auto pushTensionCandidates = [&]() {
    if (committedPrefTensionApex) push_candidate(BranchKind::TENSION_APEX_T123);
    if (directTensionApex) push_candidate(BranchKind::TENSION_APEX_T123);
    if (committedPrefLowerTensionEdge) push_candidate(BranchKind::TENSION_EDGE_T23);
    if (committedPrefLowerTensionCorner) push_candidate(BranchKind::TENSION_CORNER_S23_T3);
    if (committedPrefUpperTensionCorner) push_candidate(BranchKind::TENSION_CORNER_S12_T3);
    if (directLowerTensionEdge) push_candidate(BranchKind::TENSION_EDGE_T23);
    if (directLowerTensionCorner) push_candidate(BranchKind::TENSION_CORNER_S23_T3);
    if (directUpperTensionCorner) push_candidate(BranchKind::TENSION_CORNER_S12_T3);
    if (committedPrefTensionEdge || trialSurfaceValues.F13 > tolerance || nearFormalApex) {
      push_candidate(BranchKind::TENSION_EDGE_F13_T3);
      if (committedPrefTensionFace) push_candidate(BranchKind::TENSION_FACE_T3);
    } else {
      if (committedPrefTensionFace) push_candidate(BranchKind::TENSION_FACE_T3);
      push_candidate(BranchKind::TENSION_FACE_T3);
      push_candidate(BranchKind::TENSION_EDGE_F13_T3);
    }
    push_candidate(BranchKind::TENSION_FACE_T3);
    push_candidate(BranchKind::TENSION_EDGE_T23);
    push_candidate(BranchKind::TENSION_EDGE_F13_T3);
    push_candidate(BranchKind::TENSION_CORNER_S23_T3);
    push_candidate(BranchKind::TENSION_CORNER_S12_T3);
    push_candidate(BranchKind::TENSION_APEX_T123);
  };

  // Previous-trial branch caching (JS:1762-1785).
  if (previousTrialState && previousTrialState->hasExactBranchKind &&
      !active_surface_ids_for_branch_kind(previousTrialState->exactBranchKind).empty() &&
      previousTrialState->activeYieldSurface != YieldSurface::NONE &&
      (tensionViolated == is_tension_branch_kind(previousTrialState->exactBranchKind)) &&
      !nearFormalApex &&
      (previousTrialState->exactBranchKind != BranchKind::FACE_F13 ||
       (gap12Trial > 2.0 * edgeTolerance && gap23Trial > 2.0 * edgeTolerance)) &&
      (previousTrialState->exactBranchKind != BranchKind::EDGE_S23_EQUAL ||
       gap23Trial <= 2.0 * edgeTolerance) &&
      (previousTrialState->exactBranchKind != BranchKind::EDGE_S12_EQUAL ||
       gap12Trial <= 2.0 * edgeTolerance)) {
    push_candidate(previousTrialState->exactBranchKind);
  }
  // Committed branch as a fallback hint (JS:1786-1808).
  if (committedState &&
      !active_surface_ids_for_branch_kind(committedBranch).empty()) {
    // Compatibility heuristic mirrors JS cachedBranchStillCompatible.
    bool compatible = !nearFormalApex;
    if (committedBranch == BranchKind::FACE_F13 &&
        (gap12Trial <= 2.0 * edgeTolerance || gap23Trial <= 2.0 * edgeTolerance)) compatible = false;
    if (committedBranch == BranchKind::EDGE_S23_EQUAL && gap23Trial > 2.0 * edgeTolerance) compatible = false;
    if (committedBranch == BranchKind::EDGE_S12_EQUAL && gap12Trial > 2.0 * edgeTolerance) compatible = false;
    if (tensionViolated && !is_tension_branch_kind(committedBranch)) compatible = false;
    if (!tensionViolated && is_tension_branch_kind(committedBranch)) compatible = false;
    if (compatible) push_candidate(committedBranch);
  }
  if (tensionViolated) {
    const double shearSeverity = std::max({
        trialSurfaceValues.F12, trialSurfaceValues.F13, trialSurfaceValues.F23, 0.0});
    const double tensionSeverity = std::max(trialSurfaceValues.T3, 0.0);
    if (shearSeverity >= tensionSeverity) {
      pushShearCandidates();
      pushTensionCandidates();
    } else {
      pushTensionCandidates();
      pushShearCandidates();
    }
  } else {
    pushShearCandidates();
  }
  if (preferredCandidates.empty()) {
    push_candidate(trialBranchKind == BranchKind::ELASTIC
        ? BranchKind::FACE_F13
        : trialBranchKind);
  }

  // Loop through candidates with dynamic route/promotion appends (JS:1833-1872).
  CandidateBranchResult last;
  std::vector<BranchKind> attempted;
  for (std::size_t index = 0; index < preferredCandidates.size(); ++index) {
    const BranchKind candidate = preferredCandidates[index];
    bool alreadyAttempted = false;
    for (BranchKind x : attempted) {
      if (x == candidate) {
        alreadyAttempted = true;
        break;
      }
    }
    if (alreadyAttempted) continue;
    attempted.push_back(candidate);

    CandidateBranchResult c = solve_exact_mc_candidate_branch(
        candidate, stressTrial6_tens, principalTrial, elasticTangent6x6,
        mp, mcTrial, committedState, toleranceState);
    last = c;
    if (c.converged) {
      result.converged = true;
      result.iterations = 1;
      result.stress6_tens = c.stress6_tens;
      result.plasticStrainIncrement6 = c.plasticStrainIncrement6;
      result.algorithmicTangent6x6 = c.algorithmicTangent6x6;
      result.activeYieldSurface = c.activeYieldSurface;
      result.activeSurfaceIds = c.activeSurfaceIds;
      result.yieldResidual = c.yieldResidual;
      result.trialBranchKind = trialBranchKind;
      result.acceptedBranchKind = c.acceptedBranchKind;
      result.branchKind = c.branchKind;
      result.representativeBasisSource = c.representativeBasisSource;
      result.representativeProjectors = c.representativeProjectors;
      result.trialMultiplicityKind = trialMultiplicityKind;
      result.finalMultiplicityKind = c.finalMultiplicityKind;
      result.edgeTotalMultiplier = c.edgeTotalMultiplier;
      result.edgeMixWeight = c.edgeMixWeight;
      result.plasticMultipliers = c.plasticMultipliers;
      result.tangentConditionNumber = c.tangentConditionNumber;
      result.tangentQuality = c.tangentQuality;
      result.branchAcceptanceResidual = c.branchAcceptanceResidual;
      return result;
    }
    if (c.routePending) {
      if (tensionViolated) {
        pushTensionCandidates();
      } else {
        push_candidate(BranchKind::FACE_F13);
        push_candidate(BranchKind::EDGE_S23_EQUAL);
        push_candidate(BranchKind::EDGE_S12_EQUAL);
      }
      continue;
    }
    if (c.promote) push_candidate(c.promoteTo);
  }

  // No candidate converged. Return a non-converged result with the
  // residual & trial info so the caller can fall back to a smooth
  // surface or to load-step cutback.
  result.converged = false;
  result.iterations = 0;
  result.stress6_tens = stressTrial6_tens;
  result.plasticStrainIncrement6 = jsm::zero_vector6();
  result.algorithmicTangent6x6 = elasticTangent6x6;
  result.activeYieldSurface = YieldSurface::NONE;
  result.yieldResidual = last.branchAcceptanceResidual > 0.0 ? last.branchAcceptanceResidual : maxTrialResidual;
  result.trialBranchKind = trialBranchKind;
  result.acceptedBranchKind = BranchKind::ELASTIC;
  result.branchKind = BranchKind::ELASTIC;
  result.representativeBasisSource = RepresentativeBasisSource::TRIAL;
  result.representativeProjectors.P1 = principalTrial.P1;
  result.representativeProjectors.P2 = principalTrial.P2;
  result.representativeProjectors.P3 = principalTrial.P3;
  result.trialMultiplicityKind = trialMultiplicityKind;
  result.finalMultiplicityKind = trialMultiplicityKind;
  return result;
}

} // namespace madep::mc_exact
