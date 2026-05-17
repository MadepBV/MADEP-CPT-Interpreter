// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hardening Soil (HS) constitutive update — Phase 2 single-surface return
// mappings (cone-only, cap-only, elastic). Corner / tension cutoff are
// deferred to Phase 3 / Phase 4.
//
// Sign convention. Codebase Voigt-6 is tension-positive (matches the rest
// of the WASM solver — see types.hpp). HS-internal principal frame is
// compression-positive: s1 >= s2 >= s3 (s1 is the most compressive). The
// principal decomposition reused from material_mc_exact.hpp handles the
// flip from tension-positive Voigt to compression-positive principals
// internally; the reconstruction at the end of each return mapping
// undoes the flip with `sigma_voigt[k] = -sigma3d[i][j]`.
//
// Reference: docs/features/hardening-soil-model.md, Appendices A (F1–F22)
// and B (B.0–B.9). Spec sections referenced inline as `F#` / `B.#`.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>

#include "linalg.hpp"
#include "material_mc_exact.hpp"
#include "math_js_mirror.hpp"
#include "types.hpp"

namespace madep::material::hs {

namespace lng = madep::linalg;
namespace jsm = madep::js_mirror;
namespace mce = madep::mc_exact;

using madep::Vec6;
using madep::Mat6;
using madep::Mat3x3;
using madep::RegionParams;
using madep::MaterialPoint;
using madep::js_mirror::Vec3;
using madep::js_mirror::Mat3;
using madep::js_mirror::VOIGT_XX;
using madep::js_mirror::VOIGT_YY;
using madep::js_mirror::VOIGT_ZZ;
using madep::js_mirror::VOIGT_XY;
using madep::js_mirror::VOIGT_YZ;
using madep::js_mirror::VOIGT_XZ;

// ---------------------------------------------------------------------------
// Result struct returned by every HS update entry point.
// ---------------------------------------------------------------------------
struct HsUpdateResult {
  Vec6 stressUpdated{};                  // updated effective stress (Voigt-6, tension-positive)
  Vec6 plasticIncrement{};               // increment of plastic strain (Voigt-6, tension-positive)
  Mat6 tangent{};                        // algorithmic 6x6 tangent (elastic for Phase 2 — see B.9)
  MaterialPoint::HsState stateUpdated{}; // updated HS state
  std::uint8_t activeSurface{ 0 };       // 0=elastic, 1=cone, 2=cap, 3=corner
  std::uint16_t failureCode{ 0 };
};

// ---------------------------------------------------------------------------
// Cone flow regime (F9). Detected ONCE at trial state and HELD for the whole
// inner Newton — re-detecting per iteration breaks Newton convergence.
// ---------------------------------------------------------------------------
enum class ConeFlowRegime : std::uint8_t {
  Face13 = 0,
  CompressionEdge = 1,
  ExtensionEdge = 2
};

// ---------------------------------------------------------------------------
// Math helpers.
// ---------------------------------------------------------------------------

// cot(x) with a numerical floor on sin(x) so the cohesion-only soil
// (phi -> 0) case does not divide by zero.
inline double cot_safe(double angle) {
  const double s = std::sin(angle);
  const double c = std::cos(angle);
  return c / std::max(std::abs(s), 1e-12);
}

// Tensile shift p_t = c * cot(phi) (F3). Apex of the MC cone in
// compression-positive p' space.
inline double tensile_shift_p_t(double c_eff, double phi_eff) {
  return c_eff * cot_safe(phi_eff);
}

// F1 — Power-law stress-dependent stiffness. `sigma_relevant` is sigma_3
// for E_50 and E_ur, sigma_1 for E_oed. Compression-positive convention.
inline double power_law_stiffness(double E_ref, double sigma_relevant,
                                  double c_eff, double phi_eff,
                                  double p_ref, double m) {
  const double cosPhi = std::cos(phi_eff);
  const double sinPhi = std::sin(phi_eff);
  double numerator = c_eff * cosPhi + sigma_relevant * sinPhi;
  double denominator = c_eff * cosPhi + p_ref * sinPhi;
  // Numerical floor (F1): the bracketed term must stay positive. 0.5 kPa
  // is the same residual-pressure tolerance the spec recommends in §3.4.
  if (numerator < 0.5) numerator = 0.5;
  if (denominator < 0.5) denominator = 0.5;
  const double ratio = numerator / denominator;
  const double exponent = std::clamp(m, 0.0, 1.0);
  return E_ref * std::pow(ratio, exponent);
}

// F14 — Plane-strain elastic Voigt tangent (just calls linalg helper).
inline Mat6 elastic_tangent_voigt(double E_ur, double nu_ur) {
  return lng::elastic_matrix_E_nu(E_ur, nu_ur);
}

// F16 — Dilatancy cutoff threshold.
inline double dilatancy_cutoff_threshold(double e_init, double e_max) {
  if (e_init > 0.0 && e_max > 0.0 && e_max > e_init) {
    return (e_init - e_max) / (1.0 + e_init);
  }
  return -1.0e9;
}

// F7 — Critical-state friction (computed at region setup; this helper is
// available for safety-phase recomputation).
inline double critical_state_sin_phi_cv(double phi_eff, double psi_eff) {
  const double sphi = std::sin(phi_eff);
  const double spsi = std::sin(psi_eff);
  double denom = 1.0 - sphi * spsi;
  if (denom < 1e-12) denom = 1e-12;
  double s_cv = (sphi - spsi) / denom;
  if (s_cv < 0.0) s_cv = 0.0;
  return s_cv;
}

// F6 — Mobilised friction angle. Inputs in compression-positive principal
// frame; sigma1 is most compressive.
inline double mobilised_sin_phi(double sigma1, double sigma3,
                                double c_eff, double phi_eff) {
  double denom = sigma1 + sigma3 + 2.0 * c_eff * cot_safe(phi_eff);
  if (denom < 1e-6) denom = 1e-6;
  double s_mob = (sigma1 - sigma3) / denom;
  const double sphi = std::sin(phi_eff);
  if (s_mob < 0.0) s_mob = 0.0;
  if (s_mob > sphi) s_mob = sphi;
  return s_mob;
}

// F8 — Mobilised dilatancy (Rowe + cutoffs).
inline double mobilised_sin_psi(double sin_phi_mob, double sin_phi_cv,
                                double psi_eff,
                                double eps_v_p_current,
                                double eps_v_p_max) {
  if (sin_phi_mob < sin_phi_cv) return 0.0;
  double denom = 1.0 - sin_phi_mob * sin_phi_cv;
  if (denom < 1e-12) denom = 1e-12;
  double s_psi = (sin_phi_mob - sin_phi_cv) / denom;
  // Dilatancy cutoff at maximum void ratio. eps_v_p_max is NEGATIVE
  // (compression-positive ε_v decreases as dilation accumulates).
  if (eps_v_p_current <= eps_v_p_max) return 0.0;
  const double s_psi_eff = std::sin(psi_eff);
  if (s_psi > s_psi_eff) s_psi = s_psi_eff;
  if (s_psi < 0.0) s_psi = 0.0;
  return s_psi;
}

// ---------------------------------------------------------------------------
// F4 — Cone yield function (B.2 cone_yield_value).
// q is the MC deviator sigma1 - sigma3 (compression positive).
// ---------------------------------------------------------------------------
inline double cone_yield_value(double q, double q_a, double E_i,
                               double E_ur, double gamma_p) {
  const double q_clamped = std::min(q, 0.999 * q_a);
  double denom = 1.0 - q_clamped / q_a;
  if (denom < 1e-3) denom = 1e-3;
  return (2.0 / E_i) * q_clamped / denom
       - 2.0 * q_clamped / E_ur
       - gamma_p;
}

// ---------------------------------------------------------------------------
// F9 — Cone-flow regime classification, ONCE at trial state.
// ---------------------------------------------------------------------------
inline ConeFlowRegime classify_cone_regime(const mce::PrincipalState& pr) {
  const double tol = std::max(pr.eigTolerance, 1e-9);
  const double d23 = std::abs(pr.s2 - pr.s3);
  const double d12 = std::abs(pr.s1 - pr.s2);
  const bool edge23 = d23 <= tol;
  const bool edge12 = d12 <= tol;
  if (edge23 && edge12) {
    // Hydrostatic / triple coincidence. Phase 2 fall-back: use the
    // compression-edge flow (single-face Face13 would break symmetry).
    return ConeFlowRegime::CompressionEdge;
  }
  if (edge23) return ConeFlowRegime::CompressionEdge;
  if (edge12) return ConeFlowRegime::ExtensionEdge;
  return ConeFlowRegime::Face13;
}

// F9 — Plastic potential gradient in principal frame.
inline void cone_flow_gradient(ConeFlowRegime regime, double sin_psi_mob,
                               double& dg1, double& dg2, double& dg3) {
  const double a = 1.0 - sin_psi_mob;
  const double b = 1.0 + sin_psi_mob;
  switch (regime) {
    case ConeFlowRegime::Face13:
      dg1 =  0.5 * a;  dg2 =  0.0;       dg3 = -0.5 * b;
      return;
    case ConeFlowRegime::CompressionEdge:
      dg1 =  0.5 * a;  dg2 = -0.25 * b;  dg3 = -0.25 * b;
      return;
    case ConeFlowRegime::ExtensionEdge:
      dg1 =  0.25 * a; dg2 =  0.25 * a;  dg3 = -0.5 * b;
      return;
  }
}

// F9' — Cone yield gradient at the edges (regime-aware ∂f^s/∂σ).
// `df_dq` is the scalar derivative of f^s with respect to q (independent
// of regime); the per-principal gradient is df_dq times a regime mask.
inline void cone_yield_gradient(ConeFlowRegime regime, double df_dq,
                                double& df_d1, double& df_d2, double& df_d3) {
  switch (regime) {
    case ConeFlowRegime::Face13:
      df_d1 =  df_dq;       df_d2 =  0.0;          df_d3 = -df_dq;
      return;
    case ConeFlowRegime::CompressionEdge:
      df_d1 =  df_dq;       df_d2 = -0.5 * df_dq;  df_d3 = -0.5 * df_dq;
      return;
    case ConeFlowRegime::ExtensionEdge:
      df_d1 =  0.5 * df_dq; df_d2 =  0.5 * df_dq;  df_d3 = -df_dq;
      return;
  }
}

// ---------------------------------------------------------------------------
// F5 — Cap yield function value (compression-positive principals).
// ---------------------------------------------------------------------------
inline double cap_yield_value(double sigma1, double sigma2, double sigma3,
                              double p_p, double M_cap, double p_t,
                              double phi_eff) {
  const double sphi = std::sin(phi_eff);
  const double delta = (3.0 + sphi) / (3.0 - sphi);
  const double q_tilde = sigma1 + (delta - 1.0) * sigma2 - delta * sigma3;
  const double p_prime = (sigma1 + sigma2 + sigma3) / 3.0;
  return (q_tilde * q_tilde) / (M_cap * M_cap)
       + (p_prime + p_t) * (p_prime + p_t)
       - (p_p + p_t) * (p_p + p_t);
}

// F11 — Cap yield gradient (associated flow), regime-aware.
// Outputs the gradient of f^c with respect to (sigma1, sigma2, sigma3) and
// w.r.t. the cap hardening variable p_p.
inline void cap_yield_gradient(ConeFlowRegime regime,
                               double sigma1, double sigma2, double sigma3,
                               double p_p, double M_cap, double p_t,
                               double phi_eff,
                               double& df_d1, double& df_d2, double& df_d3,
                               double& df_dpp) {
  const double sphi = std::sin(phi_eff);
  const double delta = (3.0 + sphi) / (3.0 - sphi);
  const double dm1 = delta - 1.0;
  const double neg_d = -delta;

  double dq_d1, dq_d2, dq_d3;
  switch (regime) {
    case ConeFlowRegime::Face13:
      dq_d1 = 1.0;
      dq_d2 = dm1;
      dq_d3 = neg_d;
      break;
    case ConeFlowRegime::CompressionEdge:
      dq_d1 = 1.0;
      dq_d2 = 0.5 * (dm1 + neg_d);
      dq_d3 = 0.5 * (neg_d + dm1);
      break;
    case ConeFlowRegime::ExtensionEdge:
      dq_d1 = 0.5 * (1.0 + dm1);
      dq_d2 = 0.5 * (dm1 + 1.0);
      dq_d3 = neg_d;
      break;
  }

  const double q_tilde = sigma1 + dm1 * sigma2 + neg_d * sigma3;
  const double p_prime = (sigma1 + sigma2 + sigma3) / 3.0;
  const double two_qt_over_M2 = 2.0 * q_tilde / (M_cap * M_cap);
  const double pt_term = (2.0 / 3.0) * (p_prime + p_t);

  df_d1 = two_qt_over_M2 * dq_d1 + pt_term;
  df_d2 = two_qt_over_M2 * dq_d2 + pt_term;
  df_d3 = two_qt_over_M2 * dq_d3 + pt_term;
  df_dpp = -2.0 * (p_p + p_t);
}

// F12 — Volumetric trace of cap flow direction per unit plastic multiplier.
inline double cap_volumetric_per_lambda(double p_prime, double p_t) {
  return 2.0 * (p_prime + p_t);
}

// F13 — Cap hardening rate dp_p / dlambda_c.
inline double cap_hardening_rate(double H_cap, double p_prime, double p_t) {
  return H_cap * cap_volumetric_per_lambda(p_prime, p_t);
}

// ---------------------------------------------------------------------------
// Internal: build a MaterialParameters bag suitable for the mc_exact
// principal decomposition helper. The HS yield/flow logic does not use
// MC parameters directly; this is only for setting eig_tolerance.
// ---------------------------------------------------------------------------
inline mce::MaterialParameters make_mp_for_eig(const RegionParams& region,
                                               double c_eff,
                                               double /*phi_eff*/) {
  mce::MaterialParameters mp{};
  mp.cEff = c_eff;
  mp.yieldTolerancePref = 100.0;        // matches JS default
  mp.eigToleranceAbsolute = 0.0;
  mp.eigToleranceRelative = 1e-9;
  mp.useTensionCutoff = region.useTensionCutoff != 0u;
  return mp;
}

// ---------------------------------------------------------------------------
// Helper: reconstruct codebase Voigt-6 (tension-positive) stress from
// compression-positive principal triple and trial-state projectors.
// ---------------------------------------------------------------------------
inline Vec6 reconstruct_stress_voigt_from_principals(
    const mce::PrincipalState& principalT,
    double s1, double s2, double s3) {
  using jsm::scale_matrix3;
  using jsm::add_matrix3;
  Mat3 sigma3d = scale_matrix3(principalT.P1, s1);
  sigma3d = add_matrix3(sigma3d, scale_matrix3(principalT.P2, s2));
  sigma3d = add_matrix3(sigma3d, scale_matrix3(principalT.P3, s3));
  Vec6 sigma_voigt{};
  sigma_voigt[VOIGT_XX] = -sigma3d[0][0];
  sigma_voigt[VOIGT_YY] = -sigma3d[1][1];
  sigma_voigt[VOIGT_ZZ] = -sigma3d[2][2];
  sigma_voigt[VOIGT_XY] = -sigma3d[0][1];
  sigma_voigt[VOIGT_YZ] = -sigma3d[1][2];
  sigma_voigt[VOIGT_XZ] = -sigma3d[0][2];
  return sigma_voigt;
}

// ---------------------------------------------------------------------------
// Helper: convert a principal-frame plastic strain triple (dλ * dg_i) into a
// codebase Voigt-6 plastic strain increment (tension-positive). The
// projectors P_i are 3×3 outer products and the principal-frame strain
// reconstructs as ε_3d = Σ_i (dε_i) P_i. Engineering shear means γ_xy =
// 2 ε_xy in Voigt-6; the off-diagonals of ε_3d are tensor strain, so we
// double them when packing into the engineering-shear slots.
// ---------------------------------------------------------------------------
inline Vec6 plastic_increment_voigt(const mce::PrincipalState& principalT,
                                    double dep1, double dep2, double dep3) {
  using jsm::scale_matrix3;
  using jsm::add_matrix3;
  Mat3 eps3d = scale_matrix3(principalT.P1, dep1);
  eps3d = add_matrix3(eps3d, scale_matrix3(principalT.P2, dep2));
  eps3d = add_matrix3(eps3d, scale_matrix3(principalT.P3, dep3));
  // ε_3d is in compression-positive coords; codebase Voigt strain is
  // tension-positive, so flip sign. Engineering shear: γ_xy = 2 ε_xy.
  Vec6 dEpsP{};
  dEpsP[VOIGT_XX] = -eps3d[0][0];
  dEpsP[VOIGT_YY] = -eps3d[1][1];
  dEpsP[VOIGT_ZZ] = -eps3d[2][2];
  dEpsP[VOIGT_XY] = -2.0 * eps3d[0][1];
  dEpsP[VOIGT_YZ] = -2.0 * eps3d[1][2];
  dEpsP[VOIGT_XZ] = -2.0 * eps3d[0][2];
  return dEpsP;
}

// ---------------------------------------------------------------------------
// B.3 — Single-surface cone return mapping.
//
// Drives f^s = 0 with a 1-D Newton on dlambda. Regime is detected ONCE
// from the trial principal state; the flow and yield gradients use the
// regime-aware formulas (F9 / F9'). Stress correction in principal frame:
//   sigma_new[i] = sigma_trial[i] - dlambda * (D_e_principal · dg)[i]
// with D_e_principal[i][j] = λ + 2μ δ_ij for the isotropic case.
// ---------------------------------------------------------------------------
inline HsUpdateResult return_cone_only(
    const mce::PrincipalState& principalT,
    const MaterialPoint::HsState& stateC,
    double c_eff, double phi_eff, double psi_eff, double sin_phi_cv,
    double E_i_trial, double E_ur_trial, double q_a_trial,
    const Mat6& D_e, const RegionParams& region) {
  HsUpdateResult out{};
  out.stateUpdated = stateC;

  // Elastic moduli for principal-frame correction. Match the D_e the caller
  // built from the committed-state E_ur (B.1 step 5/6).
  const double G_s = std::max(D_e[3][3], 1.0);
  const double lam = D_e[0][0] - 2.0 * G_s;
  const double two_mu = 2.0 * G_s;
  // Cache HS-parameters needed to recompute hyperbolic-curve constants at
  // the corrected σ_3 per Newton iteration. This is the "consistent
  // constitutive" refinement of the operator-split spec (B.3 / F10
  // note): treat E_i, q_a, E_ur as variables that track σ_3, not frozen
  // at the trial σ_3. Without this, the operator-split error is ~1% at
  // typical step sizes, which exceeds the D.1 1e-3 verification tolerance.
  const double Rf = std::clamp(region.hs.Rf, 1e-3, 0.999);
  const double m_exp = std::clamp(region.hs.m, 0.0, 1.0);
  const double p_ref = std::max(region.hs.p_ref, 1.0);
  const double cosPhi = std::cos(phi_eff);
  const double sinPhi = std::sin(phi_eff);
  const double denom_pow = std::max(c_eff * cosPhi + p_ref * sinPhi, 0.5);
  auto power_ratio = [&](double sigma3_arg) {
    const double num = std::max(c_eff * cosPhi + sigma3_arg * sinPhi, 0.5);
    return std::pow(num / denom_pow, m_exp);
  };
  auto recompute_consts = [&](double s3, double& E_i_out, double& q_a_out, double& E_ur_out) {
    const double pr = power_ratio(s3);
    const double E_50_local = region.hs.E50_ref * pr;
    E_ur_out = region.hs.Eur_ref * pr;
    double sinPhi_f = sinPhi;
    if (sinPhi_f < 1e-6) sinPhi_f = 1e-6;
    const double q_f_local = (c_eff * cot_safe(phi_eff) + s3) * 2.0 * sinPhi_f / std::max(1.0 - sinPhi_f, 1e-9);
    q_a_out = std::max(q_f_local / Rf, 1.0);
    E_i_out = 2.0 * E_50_local / (2.0 - Rf);
  };

  // Working consts — initialised at trial σ_3, updated each iteration.
  double E_i = E_i_trial;
  double E_ur = E_ur_trial;
  double q_a = q_a_trial;

  // F9 — regime fixed at trial.
  const ConeFlowRegime regime = classify_cone_regime(principalT);

  const double eps_v_p_max = dilatancy_cutoff_threshold(
      region.hs.e_init, region.hs.e_max);

  // Initial guess on dlambda. Two regimes:
  //   (a) q_trial < 0.9 q_a: start at dlambda = 0 (cheap, converges fast).
  //   (b) q_trial >= 0.9 q_a: linearise to land at q_new ≈ 0.85 q_a after
  //       the first principal correction. Otherwise the 1/(1-q/qa)^2 factor
  //       in df^s/dq blows up the Jacobian and Newton ping-pongs.
  const double q_trial = principalT.s1 - principalT.s3;
  const double f_trial = cone_yield_value(q_trial, q_a, E_i, E_ur, stateC.gamma_p);
  (void)f_trial;
  double dlambda = 0.0;
  if (q_trial > 0.9 * q_a) {
    // Estimate dq/dlambda assuming sin_psi_mob ≈ 0 (most conservative
    // for the K_eff_1 - K_eff_3 magnitude); the regime tells us which
    // pairing of (s1, s3) drives q.
    double dg_q1 = 0.5, dg_q3 = -0.5;
    if (regime == ConeFlowRegime::CompressionEdge) {
      dg_q1 = 0.5; dg_q3 = -0.25;
    } else if (regime == ConeFlowRegime::ExtensionEdge) {
      dg_q1 = 0.25; dg_q3 = -0.5;
    }
    const double dq_per_lambda_est = -two_mu * (dg_q1 - dg_q3);
    const double q_target = 0.85 * q_a;
    if (std::abs(dq_per_lambda_est) > 1e-6) {
      dlambda = std::max((q_target - q_trial) / dq_per_lambda_est, 0.0);
    }
  }

  // Working principal-frame state.
  double s1_new = principalT.s1;
  double s2_new = principalT.s2;
  double s3_new = principalT.s3;
  double gamma_p_new = stateC.gamma_p;
  double eps_v_p_new = stateC.eps_v_p;
  double dg1 = 0.0, dg2 = 0.0, dg3 = 0.0;
  double sin_psi_mob = 0.0;

  // Compute dq/dlambda upper bound for clamping. dq = (dσ_1 - dσ_3) per
  // unit dlambda, ignoring the trace_dg term that cancels in (σ_1 - σ_3).
  // For all three regimes |dq_per_lambda| ≤ 2μ · 1.0 (worst case Face13
  // with sin_psi = -1, but realistic cap ~ 1.5μ for sin_psi ~ 0).
  const double max_safe_dlambda_step = (std::max(q_a, 1.0)) / std::max(two_mu, 1.0);

  const double f_tolerance = 1e-8 * std::max(std::abs(q_a), 1.0);
  bool converged = false;
  double prev_f = std::numeric_limits<double>::infinity();
  double prev_dlambda = dlambda;

  for (int it = 0; it < 50; ++it) {
    // Mobilised friction at current corrected state.
    const double sin_phi_mob = mobilised_sin_phi(s1_new, s3_new, c_eff, phi_eff);
    sin_psi_mob = mobilised_sin_psi(
        sin_phi_mob, sin_phi_cv, psi_eff,
        stateC.eps_v_p + dlambda * (-sin_psi_mob),
        eps_v_p_max);

    // Flow gradient.
    cone_flow_gradient(regime, sin_psi_mob, dg1, dg2, dg3);

    // Principal-frame correction.
    const double trace_dg = dg1 + dg2 + dg3;
    auto principal_correction = [&](double dg_i) {
      return -dlambda * (lam * trace_dg + two_mu * dg_i);
    };
    s1_new = principalT.s1 + principal_correction(dg1);
    s2_new = principalT.s2 + principal_correction(dg2);
    s3_new = principalT.s3 + principal_correction(dg3);

    // Ordering check (B.3): the projector reconstruction is direction-
    // locked, so a swap of principal magnitudes is a hard failure.
    if (!(s1_new >= s2_new - 1e-9 && s2_new >= s3_new - 1e-9)) {
      out.failureCode = 101;
      return out;
    }

    gamma_p_new = stateC.gamma_p + dlambda;
    eps_v_p_new = stateC.eps_v_p + dlambda * (-sin_psi_mob);

    // Recompute hyperbolic-curve constants at the CURRENT corrected σ_3
    // (consistent-constitutive refinement — see comment above).
    recompute_consts(s3_new, E_i, q_a, E_ur);

    // Yield residual.
    const double q_new = s1_new - s3_new;
    const double f_new = cone_yield_value(q_new, q_a, E_i, E_ur, gamma_p_new);

    if (std::abs(f_new) < f_tolerance) {
      converged = true;
      break;
    }

    // Newton on dlambda.
    //   df^s / d(dlambda) = - (∂f/∂σ · D_e · ∂g/∂σ) - 1
    // The hardening -1 comes from ∂f/∂γ^p · dγ^p/dlambda = (-1)(+1).
    const double q_clamped = std::min(q_new, 0.999 * q_a);
    double denom_qa = 1.0 - q_clamped / q_a;
    if (denom_qa < 1e-3) denom_qa = 1e-3;
    const double df_dq_factor = (2.0 / E_i) / (denom_qa * denom_qa) - 2.0 / E_ur;

    // D_e · dg in principal frame (isotropic).
    const double De_dg1 = lam * trace_dg + two_mu * dg1;
    const double De_dg2 = lam * trace_dg + two_mu * dg2;
    const double De_dg3 = lam * trace_dg + two_mu * dg3;

    // Regime-aware unit yield gradient (df_dq_factor scales it inside the
    // quadratic form).
    double df_d1, df_d2, df_d3;
    cone_yield_gradient(regime, 1.0, df_d1, df_d2, df_d3);
    const double quad_unscaled =
        df_d1 * De_dg1 + df_d2 * De_dg2 + df_d3 * De_dg3;

    double df_dlambda = -df_dq_factor * quad_unscaled - 1.0;
    if (std::abs(df_dlambda) < 1e-12) break;
    double delta_lambda = f_new / df_dlambda;
    // Clamp delta_lambda to a safe step so the Newton can't jump across
    // the q = q_a singularity in a single iteration. The bound
    // |Δλ| ≤ q_a / (2μ) corresponds roughly to "drop q by a full q_a in
    // one step", which is more than ever needed.
    if (delta_lambda > max_safe_dlambda_step) delta_lambda = max_safe_dlambda_step;
    if (delta_lambda < -max_safe_dlambda_step) delta_lambda = -max_safe_dlambda_step;
    // Bisection-style line search: if the proposed step would overshoot
    // (|f_new| > |f_prev|), halve.
    double trial_dlambda = dlambda - delta_lambda;
    if (trial_dlambda < 0.0) trial_dlambda = 0.0;
    const bool overshoot = std::abs(f_new) > std::abs(prev_f) * 1.1
                           && it > 0;
    if (overshoot) {
      trial_dlambda = 0.5 * (dlambda + prev_dlambda);
    }
    prev_f = f_new;
    prev_dlambda = dlambda;
    dlambda = trial_dlambda;
    if (std::abs(delta_lambda) < 1e-12) {
      // Re-evaluate one more time at the converged dlambda before exit.
      const double sin_phi_mob_final = mobilised_sin_phi(s1_new, s3_new, c_eff, phi_eff);
      sin_psi_mob = mobilised_sin_psi(
          sin_phi_mob_final, sin_phi_cv, psi_eff,
          stateC.eps_v_p + dlambda * (-sin_psi_mob),
          eps_v_p_max);
      cone_flow_gradient(regime, sin_psi_mob, dg1, dg2, dg3);
      const double trace_dg_final = dg1 + dg2 + dg3;
      s1_new = principalT.s1 - dlambda * (lam * trace_dg_final + two_mu * dg1);
      s2_new = principalT.s2 - dlambda * (lam * trace_dg_final + two_mu * dg2);
      s3_new = principalT.s3 - dlambda * (lam * trace_dg_final + two_mu * dg3);
      gamma_p_new = stateC.gamma_p + dlambda;
      eps_v_p_new = stateC.eps_v_p + dlambda * (-sin_psi_mob);
      const double q_check = s1_new - s3_new;
      const double f_check = cone_yield_value(q_check, q_a, E_i, E_ur, gamma_p_new);
      if (std::abs(f_check) < 10.0 * f_tolerance) converged = true;
      break;
    }
  }

  if (!converged) {
    out.failureCode = 101;
    return out;
  }

  // Plastic-strain increment in principal frame.
  const double dep1 = dlambda * dg1;
  const double dep2 = dlambda * dg2;
  const double dep3 = dlambda * dg3;

  out.stressUpdated = reconstruct_stress_voigt_from_principals(
      principalT, s1_new, s2_new, s3_new);
  out.plasticIncrement = plastic_increment_voigt(principalT, dep1, dep2, dep3);
  out.tangent = D_e;
  out.stateUpdated.gamma_p = gamma_p_new;
  out.stateUpdated.eps_v_p = eps_v_p_new;
  out.stateUpdated.p_p = stateC.p_p;
  out.stateUpdated.lastActiveSet = 1;
  out.activeSurface = 1;
  out.failureCode = 0;
  return out;
}

// ---------------------------------------------------------------------------
// B.4 — Single-surface cap return mapping.
//
// 1-D Newton on dlambda_c driving f_c = 0 with associated flow (∂g = ∂f
// from F11). p_p evolves via F13. Regime detected ONCE at trial state.
// ---------------------------------------------------------------------------
inline HsUpdateResult return_cap_only(
    const mce::PrincipalState& principalT,
    const MaterialPoint::HsState& stateC,
    double c_eff, double phi_eff,
    double M_cap, double p_t, double H_cap,
    const Mat6& D_e, const RegionParams& region) {
  (void)c_eff;
  HsUpdateResult out{};
  out.stateUpdated = stateC;

  // Elastic moduli for principal-frame correction (consistent with D_e).
  // Recover λ, G from D_e directly: D_e[3][3] = G, D_e[0][0] = λ + 2G.
  const double G_s = std::max(D_e[3][3], 1.0);
  const double lam = D_e[0][0] - 2.0 * G_s;
  const double two_mu = 2.0 * G_s;

  // F9 — regime classifier shared between cone and cap.
  const ConeFlowRegime regime = classify_cone_regime(principalT);

  // Trial cap residual (helps with initial guess sign).
  double f_trial = cap_yield_value(
      principalT.s1, principalT.s2, principalT.s3,
      stateC.p_p, M_cap, p_t, phi_eff);
  if (f_trial < 0.0) {
    // Already admissible — return elastic.
    out.stressUpdated = reconstruct_stress_voigt_from_principals(
        principalT, principalT.s1, principalT.s2, principalT.s3);
    out.tangent = D_e;
    out.activeSurface = 0;
    out.failureCode = 0;
    return out;
  }

  double dlambda = 0.0;
  double s1_new = principalT.s1;
  double s2_new = principalT.s2;
  double s3_new = principalT.s3;
  double p_p_new = stateC.p_p;
  double eps_v_p_new = stateC.eps_v_p;
  double dg1 = 0.0, dg2 = 0.0, dg3 = 0.0;

  // f_c has units stress²; tolerance scaled by (p_p + p_t)² (B.3.2).
  // Use a 1e-8 relative tolerance (slightly looser than B.3.2's 1e-10 to
  // accommodate the operator-split with σ-dependent stiffness updating).
  const double pp_pt_scale = std::max(stateC.p_p + p_t, 1.0);
  const double f_tolerance = 1e-8 * pp_pt_scale * pp_pt_scale;
  bool converged = false;

  for (int it = 0; it < 60; ++it) {
    // Cap flow (associated) at current corrected state and current p_p.
    double dummy_dpp = 0.0;
    cap_yield_gradient(regime, s1_new, s2_new, s3_new,
                       p_p_new, M_cap, p_t, phi_eff,
                       dg1, dg2, dg3, dummy_dpp);

    const double trace_dg = dg1 + dg2 + dg3;
    auto correction = [&](double dg_i) {
      return -dlambda * (lam * trace_dg + two_mu * dg_i);
    };
    s1_new = principalT.s1 + correction(dg1);
    s2_new = principalT.s2 + correction(dg2);
    s3_new = principalT.s3 + correction(dg3);

    // p_p hardening (F13). H_cap evaluated at trial p_p / p' for stability.
    const double p_prime_now = (s1_new + s2_new + s3_new) / 3.0;
    const double dpp_dlambda = cap_hardening_rate(H_cap, p_prime_now, p_t);
    p_p_new = stateC.p_p + dlambda * dpp_dlambda;
    if (p_p_new < stateC.p_p) p_p_new = stateC.p_p;   // cap monotone

    // Volumetric plastic strain.
    eps_v_p_new = stateC.eps_v_p + dlambda * cap_volumetric_per_lambda(p_prime_now, p_t);

    const double f_new = cap_yield_value(
        s1_new, s2_new, s3_new, p_p_new, M_cap, p_t, phi_eff);

    if (std::abs(f_new) < f_tolerance) {
      converged = true;
      break;
    }

    // Newton denominator. By the chain rule with associated cap flow:
    //   df^c / d(dlambda) = - (∂f/∂σ · D_e · ∂f/∂σ) + ∂f/∂p_p · dp_p/d(dlambda)
    //                     = - (∂f/∂σ · D_e · ∂f/∂σ) - 4 H_cap (p_p+p_t)(p'+p_t)
    // (∂f/∂p_p = -2 (p_p+p_t), dp_p/dlambda = H_cap · 2(p'+p_t), product is
    // -4 H_cap (p_p+p_t)(p'+p_t) which is negative ⇒ a stiffening term in
    // the denominator.)
    const double De_dg1 = lam * trace_dg + two_mu * dg1;
    const double De_dg2 = lam * trace_dg + two_mu * dg2;
    const double De_dg3 = lam * trace_dg + two_mu * dg3;
    const double quad = dg1 * De_dg1 + dg2 * De_dg2 + dg3 * De_dg3;
    const double hardening_term = -4.0 * H_cap * (p_p_new + p_t) * (p_prime_now + p_t);
    double df_dlambda = -quad + hardening_term;
    if (std::abs(df_dlambda) < 1e-12) break;
    const double delta_lambda = f_new / df_dlambda;
    dlambda -= delta_lambda;
    if (dlambda < 0.0) dlambda = 0.0;
    // No early break on delta_lambda smallness — cap Newton's residual
    // (units stress²) may legitimately need many small steps.
  }

  if (!converged) {
    out.failureCode = 102;
    return out;
  }

  out.stressUpdated = reconstruct_stress_voigt_from_principals(
      principalT, s1_new, s2_new, s3_new);
  const double dep1 = dlambda * dg1;
  const double dep2 = dlambda * dg2;
  const double dep3 = dlambda * dg3;
  out.plasticIncrement = plastic_increment_voigt(principalT, dep1, dep2, dep3);
  out.tangent = D_e;
  out.stateUpdated.gamma_p = stateC.gamma_p;
  out.stateUpdated.eps_v_p = eps_v_p_new;
  out.stateUpdated.p_p = p_p_new;
  out.stateUpdated.lastActiveSet = 2;
  out.activeSurface = 2;
  out.failureCode = 0;
  return out;
}

// ---------------------------------------------------------------------------
// B.1 — Top-level dispatcher: elastic → tension → cone-only → cap-only
//      → corner. Phase 2 only supports elastic, cone-only, cap-only.
//      The corner case returns failureCode 999.
// ---------------------------------------------------------------------------
inline HsUpdateResult update(
    const Vec6& strainTrialVoigt,
    const Vec6& strainCommittedVoigt,
    const Vec6& stressCommittedVoigt,
    const MaterialPoint::HsState& stateCommitted,
    const RegionParams& region,
    double sigmaMsf) {
  HsUpdateResult out{};
  out.stateUpdated = stateCommitted;

  // (1) Strength under c-φ safety reduction.
  const double smsf = std::max(sigmaMsf, 1.0);
  const double c_eff = std::max(region.cEff / smsf, 0.0);
  const double phi_eff = std::atan(std::max(std::tan(region.phi) / smsf, 0.0));
  const double psi_eff = std::min(
      std::atan(std::max(std::tan(region.psi) / smsf, 0.0)),
      phi_eff);
  const double sigT = region.sigmaTAllow / smsf;
  (void)sigT;

  // (2) Region-derived constants.
  const double M_cap = std::max(region.hs.M_cap, 1e-6);
  const double H_cap = std::max(region.hs.H_cap, 1.0);
  // sin_phi_cv may change under safety reduction; recompute.
  const double sin_phi_cv = critical_state_sin_phi_cv(phi_eff, psi_eff);
  const double p_t = tensile_shift_p_t(c_eff, phi_eff);

  // (3) Strain increment.
  const Vec6 dEps = lng::sub(strainTrialVoigt, strainCommittedVoigt);

  // (4) Committed-stress principal decomposition for E_ur.
  const mce::MaterialParameters mp_eig = make_mp_for_eig(region, c_eff, phi_eff);
  const auto principalC =
      mce::principal_stress_projectors_3d_compression_positive(
          stressCommittedVoigt, mp_eig);
  const double sigma3_c = principalC.s3;   // least compressive (smallest sigma)

  // (5) Stress-dependent stiffness at committed sigma_3.
  const double E_ur = power_law_stiffness(
      region.hs.Eur_ref, sigma3_c, c_eff, phi_eff,
      region.hs.p_ref, region.hs.m);

  // (6) Elastic 6×6 Voigt tangent.
  const Mat6 D_e = elastic_tangent_voigt(E_ur, region.hs.nu_ur);

  // (7) Elastic predictor.
  const Vec6 sigT_voigt = lng::add(stressCommittedVoigt, lng::mul6x6(D_e, dEps));

  // (8) Trial principal decomposition.
  const auto principalT =
      mce::principal_stress_projectors_3d_compression_positive(
          sigT_voigt, mp_eig);

  // (9) Stiffness at trial sigma_3 for hyperbolic curve constants.
  const double E_50 = power_law_stiffness(
      region.hs.E50_ref, principalT.s3, c_eff, phi_eff,
      region.hs.p_ref, region.hs.m);
  const double sphi = std::sin(phi_eff);
  const double cotPhi = cot_safe(phi_eff);
  double q_f_denom = 1.0 - sphi;
  if (q_f_denom < 1e-9) q_f_denom = 1e-9;
  const double q_f = (c_eff * cotPhi + principalT.s3) * 2.0 * sphi / q_f_denom;
  const double Rf = std::clamp(region.hs.Rf, 1e-3, 0.999);
  const double q_a = std::max(q_f / Rf, 1e-6);
  const double E_i = 2.0 * E_50 / (2.0 - Rf);

  // (10) Yield evaluations at trial.
  const double q_tr = principalT.s1 - principalT.s3;
  const double f_s = cone_yield_value(q_tr, q_a, E_i, E_ur, stateCommitted.gamma_p);
  const double f_c = cap_yield_value(
      principalT.s1, principalT.s2, principalT.s3,
      stateCommitted.p_p, M_cap, p_t, phi_eff);

  const double F_TOL_S = 1e-10 * std::max(std::abs(q_a), 1.0);
  const double F_TOL_C = 1e-10 * std::max(stateCommitted.p_p + p_t, 1.0)
                              * std::max(stateCommitted.p_p + p_t, 1.0);

  // (11) Dispatch.
  // Helper to evaluate cone f^s at corrected (s1, s3) with the same E_i,
  // q_a, E_ur, p_t evaluated at trial σ_3 (consistent with the dispatcher).
  auto cone_yield_after_return = [&](double s1, double s3, double gamma_p) {
    return cone_yield_value(s1 - s3, q_a, E_i, E_ur, gamma_p);
  };
  auto cap_yield_after_return = [&](double s1, double s2, double s3, double p_p) {
    return cap_yield_value(s1, s2, s3, p_p, M_cap, p_t, phi_eff);
  };

  // Helper to extract corrected principals from a return-mapping result
  // (we re-decompose the returned Voigt stress with the SAME mp_eig
  // parameters used at trial — gives the principals in compression-positive
  // ordering for sequential f-value checks).
  auto check_other_surface_after = [&](const HsUpdateResult& r,
                                       std::uint8_t expectActiveSurface,
                                       double otherTol,
                                       bool checkCap) -> bool {
    if (r.failureCode != 0) return false;
    const auto pr = mce::principal_stress_projectors_3d_compression_positive(
        r.stressUpdated, mp_eig);
    if (checkCap) {
      const double f_c_after = cap_yield_after_return(
          pr.s1, pr.s2, pr.s3, r.stateUpdated.p_p);
      return f_c_after <= otherTol;
    }
    const double f_s_after = cone_yield_after_return(
        pr.s1, pr.s3, r.stateUpdated.gamma_p);
    (void)expectActiveSurface;
    return f_s_after <= otherTol;
  };

  if (f_s <= F_TOL_S && f_c <= F_TOL_C) {
    // Pure elastic.
    out.stressUpdated = sigT_voigt;
    out.plasticIncrement = Vec6{};
    out.tangent = D_e;
    out.stateUpdated = stateCommitted;
    out.stateUpdated.lastActiveSet = 0;
    out.activeSurface = 0;
    out.failureCode = 0;
    return out;
  }
  if (f_s > F_TOL_S && f_c <= F_TOL_C) {
    out = return_cone_only(principalT, stateCommitted,
                           c_eff, phi_eff, psi_eff, sin_phi_cv,
                           E_i, E_ur, q_a, D_e, region);
    return out;
  }
  if (f_s <= F_TOL_S && f_c > F_TOL_C) {
    out = return_cap_only(principalT, stateCommitted,
                          c_eff, phi_eff, M_cap, p_t, H_cap, D_e, region);
    return out;
  }

  // Both surfaces active at trial. Phase 2 fallback: sequential project-
  // and-check. Try cap-only first (cap is associated and usually dominates
  // K0 / oedometric loading); if the cone yield at the returned state is
  // still satisfied (≤ F_TOL_S), accept. Otherwise try cone-only and
  // check the cap. If neither single-surface return alone satisfies the
  // other surface, signal a true corner case via failureCode 999 (Phase 3).
  HsUpdateResult cap_first = return_cap_only(
      principalT, stateCommitted,
      c_eff, phi_eff, M_cap, p_t, H_cap, D_e, region);
  if (check_other_surface_after(cap_first, 2, F_TOL_S, /*checkCap=*/false)) {
    return cap_first;
  }
  HsUpdateResult cone_first = return_cone_only(
      principalT, stateCommitted,
      c_eff, phi_eff, psi_eff, sin_phi_cv,
      E_i, E_ur, q_a, D_e, region);
  if (check_other_surface_after(cone_first, 1, F_TOL_C, /*checkCap=*/true)) {
    return cone_first;
  }

  // True corner case — Phase 3 territory.
  out.stressUpdated = sigT_voigt;
  out.tangent = D_e;
  out.failureCode = 999;
  out.activeSurface = 3;
  return out;
}

// ---------------------------------------------------------------------------
// C.1 — M_cap iterative calibration. Simulate single-Gauss-point K0
// loading from sigma_v = p_ref/2 to p_ref and adjust M to hit K0_nc.
//
// We reuse update() above for the single-Gauss-point K0 simulation: at
// each step, drive d_sigma_1 in a strain-controlled manner with ε_h = 0
// (so d_sigma_3 is determined by the constitutive). After the ramp,
// compare sigma_3 / sigma_1 against K0_nc_target.
// ---------------------------------------------------------------------------

// Forward-declare the K0 / oedometer trial used by C.1 / C.2.
inline double simulate_K0_at_pref(double M_cap, double H_cap,
                                  double phi_eff,
                                  const RegionParams::HsParams& hs,
                                  const RegionParams& region,
                                  double c_eff);

inline double simulate_oedometric_tangent_at_pref(
    double M_cap, double H_cap,
    double phi_eff,
    const RegionParams::HsParams& hs,
    const RegionParams& region,
    double c_eff);

inline double calibrate_M_cap(double phi_eff, double K0_nc_target,
                              double c_eff,
                              const RegionParams::HsParams& hs,
                              const RegionParams& region) {
  // Schanz (1999) Eq. (10): initial M from K0_nc. This is the closed-
  // form value M = 3 (1 - K0) / sqrt(1 + 2 K0); if the iterative refine
  // fails for any reason (NaN, non-convergence) we ship this value.
  double M_init = 3.0 * (1.0 - K0_nc_target)
                / std::sqrt(std::max(1.0 + 2.0 * K0_nc_target, 1e-6));
  if (!std::isfinite(M_init) || M_init < 0.1) M_init = 0.5;
  double M = M_init;

  double H_guess = std::max(hs.Eoed_ref, 1.0);

  for (int iter = 0; iter < 20; ++iter) {
    const double K0_resulting = simulate_K0_at_pref(
        M, H_guess, phi_eff, hs, region, c_eff);
    if (!std::isfinite(K0_resulting)) break;
    const double residual = K0_resulting - K0_nc_target;
    if (std::abs(residual) < 1e-5) return M;
    const double dM = std::max(0.005 * std::abs(M), 1e-4);
    const double K0_perturbed = simulate_K0_at_pref(
        M + dM, H_guess, phi_eff, hs, region, c_eff);
    if (!std::isfinite(K0_perturbed)) break;
    const double dK0_dM = (K0_perturbed - K0_resulting) / dM;
    if (std::abs(dK0_dM) < 1e-12) break;
    double step = residual / dK0_dM;
    if (!std::isfinite(step)) break;
    if (step > 0.5 * M) step = 0.5 * M;
    if (step < -0.5 * M) step = -0.5 * M;
    M -= step;
    if (!std::isfinite(M) || M < 0.05) { M = M_init; break; }
    if (M > 20.0) M = 20.0;
  }
  if (!std::isfinite(M) || M <= 0.0) M = M_init;
  return M;
}

// ---------------------------------------------------------------------------
// C.2 — H_cap iterative calibration. Run a 1-step oedometric simulation at
// sigma_v = p_ref, measure d_sigma_v / d_eps_v, and Newton-update H_cap
// multiplicatively until it matches Eoed_ref.
// ---------------------------------------------------------------------------
inline double calibrate_H_cap(double M_cap, double phi_eff,
                              double /*K0_nc_target*/,
                              double c_eff,
                              const RegionParams::HsParams& hs,
                              const RegionParams& region) {
  // Closed-form initial guess: dimensional analysis suggests H_cap of
  // order E_oed_ref. Iteratively refine via single-step oedometric
  // simulation; if any step yields a non-finite/non-positive E_oed,
  // fall back to the closed-form value.
  const double H_init = std::max(hs.Eoed_ref, 1.0);
  double H_cap = H_init;
  for (int iter = 0; iter < 20; ++iter) {
    const double E_oed_resulting = simulate_oedometric_tangent_at_pref(
        M_cap, H_cap, phi_eff, hs, region, c_eff);
    if (!std::isfinite(E_oed_resulting) || E_oed_resulting <= 0.0) {
      return H_init;
    }
    const double rel = (E_oed_resulting - hs.Eoed_ref) / std::max(hs.Eoed_ref, 1.0);
    if (std::abs(rel) < 1e-4) return H_cap;
    const double ratio = hs.Eoed_ref / E_oed_resulting;
    if (!std::isfinite(ratio) || ratio <= 0.0) return H_init;
    // Damp the multiplicative step so we don't oscillate when E_oed is
    // far from E_oed_ref (e.g., ratio > 2).
    const double damped_ratio = std::pow(ratio, 0.5);
    H_cap *= damped_ratio;
    if (H_cap < 1.0) H_cap = 1.0;
    if (H_cap > 1e9) H_cap = 1e9;
  }
  if (!std::isfinite(H_cap) || H_cap <= 0.0) H_cap = H_init;
  return H_cap;
}

// ---------------------------------------------------------------------------
// Internal: drive a strain-controlled K0 loading path on a single Gauss
// point. ε_h = 0 (plane-strain-style: ε_xx = ε_zz = 0 here interpreted as
// "no lateral strain"). Stress sign convention: codebase Voigt tension-
// positive. We treat σ_yy as "vertical" (most compressive), σ_xx and σ_zz
// as the lateral pair.
// ---------------------------------------------------------------------------
inline double simulate_K0_at_pref(double M_cap, double H_cap,
                                  double phi_eff,
                                  const RegionParams::HsParams& hs,
                                  const RegionParams& region,
                                  double c_eff) {
  RegionParams r = region;
  r.cEff = c_eff;
  r.phi = phi_eff;
  r.hs.M_cap = M_cap;
  r.hs.H_cap = H_cap;
  r.hs.sin_phi_cv = critical_state_sin_phi_cv(phi_eff, std::atan(std::tan(region.psi)));

  // Initial state at sigma_v = p_ref/2 with K0 trial = 1 - sin(phi) (Jaky).
  const double K0_init = std::max(1.0 - std::sin(phi_eff), 0.1);
  const double sigma_v_start = 0.5 * std::max(hs.p_ref, 1.0);
  const double sigma_h_start = K0_init * sigma_v_start;
  Vec6 sigma{};
  sigma[VOIGT_XX] = -sigma_h_start;
  sigma[VOIGT_YY] = -sigma_v_start;
  sigma[VOIGT_ZZ] = -sigma_h_start;

  // NC seed: p_p such that f_c = 0 at the K0 state.
  const double sphi = std::sin(phi_eff);
  const double delta_w = (3.0 + sphi) / (3.0 - sphi);
  const double q_tilde_seed = sigma_v_start + (delta_w - 1.0) * sigma_h_start - delta_w * sigma_h_start;
  const double p_prime_seed = (sigma_v_start + 2.0 * sigma_h_start) / 3.0;
  const double p_t_seed = tensile_shift_p_t(c_eff, phi_eff);
  const double cap_rhs_seed = (q_tilde_seed * q_tilde_seed) / (M_cap * M_cap)
                            + (p_prime_seed + p_t_seed) * (p_prime_seed + p_t_seed);
  const double p_p_nc = std::max(std::sqrt(std::max(cap_rhs_seed, 0.0)) - p_t_seed, 1e-6);

  MaterialPoint::HsState state{};
  // Force cone inactive during calibration (Phase 2 single-surface
  // assumption — the corner case is Phase 3).
  state.gamma_p = 0.5;
  state.p_p = p_p_nc;
  state.eps_v_p = 0.0;
  state.lastActiveSet = 0;

  Vec6 strain{};
  Vec6 strain_prev{};

  const int n_steps = 12;
  const double d_sigma_v = (hs.p_ref - sigma_v_start) / static_cast<double>(n_steps);

  for (int step = 0; step < n_steps; ++step) {
    // Outer Newton on d_eps_yy to hit the next target sigma_yy. Lateral
    // constraint: d_eps_xx = d_eps_zz = 0 (no lateral strain).
    const double sigma_v_target = sigma_v_start + (step + 1) * d_sigma_v;
    double d_eps_yy = -d_sigma_v / std::max(hs.Eur_ref, 1.0);

    HsUpdateResult res{};
    Vec6 strain_trial = strain;
    for (int inner = 0; inner < 30; ++inner) {
      strain_trial = strain;
      strain_trial[VOIGT_YY] = strain[VOIGT_YY] + d_eps_yy;
      // ε_xx, ε_zz, γ_xy unchanged (zero increment ⇒ no lateral strain).
      res = update(strain_trial, strain, sigma, state, r, 1.0);
      if (res.failureCode != 0) return std::numeric_limits<double>::quiet_NaN();
      const double sigma_yy_now = res.stressUpdated[VOIGT_YY];
      const double residual = sigma_yy_now - (-sigma_v_target);
      if (std::abs(residual) < 1e-6 * std::max(sigma_v_target, 1.0)) break;
      // Numerical derivative ds_yy/de_yy via small perturbation.
      Vec6 strain_perturb = strain_trial;
      const double h = -1e-7 / std::max(hs.Eur_ref, 1.0);
      strain_perturb[VOIGT_YY] = strain_trial[VOIGT_YY] + h;
      HsUpdateResult res_p = update(strain_perturb, strain, sigma, state, r, 1.0);
      if (res_p.failureCode != 0) break;
      const double slope = (res_p.stressUpdated[VOIGT_YY] - sigma_yy_now) / h;
      if (std::abs(slope) < 1e-9) break;
      d_eps_yy -= residual / slope;
    }

    if (res.failureCode != 0) return std::numeric_limits<double>::quiet_NaN();
    // Commit step.
    sigma = res.stressUpdated;
    state = res.stateUpdated;
    strain_prev = strain;
    strain = strain_trial;
  }

  const double sigma_v_final = -sigma[VOIGT_YY];
  const double sigma_h_final = -sigma[VOIGT_XX];
  if (std::abs(sigma_v_final) < 1e-9) return 0.0;
  return sigma_h_final / sigma_v_final;
}

inline double simulate_oedometric_tangent_at_pref(
    double M_cap, double H_cap,
    double phi_eff,
    const RegionParams::HsParams& hs,
    const RegionParams& region,
    double c_eff) {
  RegionParams r = region;
  r.cEff = c_eff;
  r.phi = phi_eff;
  r.hs.M_cap = M_cap;
  r.hs.H_cap = H_cap;
  r.hs.sin_phi_cv = critical_state_sin_phi_cv(phi_eff, std::atan(std::tan(region.psi)));

  // Seed at sigma_v = p_ref with K0 state. For NC, p_p must be calibrated
  // so the cap is exactly on the surface: f_c(σ_K0, p_p) = 0.
  const double K0_init = std::max(1.0 - std::sin(phi_eff), 0.1);
  const double sigma_v_seed = std::max(hs.p_ref, 1.0);
  const double sigma_h_seed = K0_init * sigma_v_seed;
  Vec6 sigma{};
  sigma[VOIGT_XX] = -sigma_h_seed;
  sigma[VOIGT_YY] = -sigma_v_seed;
  sigma[VOIGT_ZZ] = -sigma_h_seed;
  // Compute p_p_NC such that f_c = 0 at the K0 state.
  const double sphi = std::sin(phi_eff);
  const double delta_w = (3.0 + sphi) / (3.0 - sphi);
  const double q_tilde = sigma_v_seed + (delta_w - 1.0) * sigma_h_seed - delta_w * sigma_h_seed;
  const double p_prime = (sigma_v_seed + 2.0 * sigma_h_seed) / 3.0;
  const double p_t = tensile_shift_p_t(c_eff, phi_eff);
  const double cap_rhs = (q_tilde * q_tilde) / (M_cap * M_cap)
                       + (p_prime + p_t) * (p_prime + p_t);
  const double p_p_nc = std::max(std::sqrt(std::max(cap_rhs, 0.0)) - p_t, 1e-6);
  MaterialPoint::HsState state{};
  state.p_p = p_p_nc;
  // Set γ^p high enough that cone stays inactive (matches the Phase 2
  // single-surface verification regime).
  state.gamma_p = 0.5;
  state.eps_v_p = 0.0;
  state.lastActiveSet = 2;

  Vec6 strain{};
  // Use a finite (not infinitesimal) step so the result matches what the
  // load-stepping verifier sees with steps of order 1e-4. The cap return
  // is mildly nonlinear in dλ, so an infinitesimal step over-reports the
  // tangent stiffness.
  const double d_eps_yy = -1e-4;
  Vec6 strain_trial = strain;
  strain_trial[VOIGT_YY] = d_eps_yy;
  HsUpdateResult res = update(strain_trial, strain, sigma, state, r, 1.0);
  if (res.failureCode != 0) return std::numeric_limits<double>::quiet_NaN();
  const double d_sigma_yy = res.stressUpdated[VOIGT_YY] - sigma[VOIGT_YY];
  if (std::abs(d_eps_yy) < 1e-15) return 0.0;
  // In tension-positive Voigt, both d_eps_yy and d_sigma_yy are negative
  // for compressive loading. Their ratio is the (positive) E_oed.
  return d_sigma_yy / d_eps_yy;
}

// ---------------------------------------------------------------------------
// B.8 — Region setup entry point. Computes M_cap, H_cap, sin_phi_cv.
// Idempotent: safe to call multiple times.
// ---------------------------------------------------------------------------
inline void compute_hs_reference_constants(RegionParams& region, double sigmaMsf) {
  const double smsf = std::max(sigmaMsf, 1.0);
  const double c_eff = std::max(region.cEff / smsf, 0.0);
  const double phi_eff = std::atan(std::max(std::tan(region.phi) / smsf, 0.0));
  const double psi_eff = std::min(
      std::atan(std::max(std::tan(region.psi) / smsf, 0.0)),
      phi_eff);
  region.hs.sin_phi_cv = critical_state_sin_phi_cv(phi_eff, psi_eff);

  // F15: default K0_nc.
  double K0_nc = region.hs.K0_nc;
  if (K0_nc <= 0.0) K0_nc = std::max(1.0 - std::sin(phi_eff), 0.05);

  // C.1: M_cap iterative calibration.
  region.hs.M_cap = calibrate_M_cap(phi_eff, K0_nc, c_eff, region.hs, region);
  // C.2: H_cap iterative calibration.
  region.hs.H_cap = calibrate_H_cap(
      region.hs.M_cap, phi_eff, K0_nc, c_eff, region.hs, region);
}

}  // namespace madep::material::hs
