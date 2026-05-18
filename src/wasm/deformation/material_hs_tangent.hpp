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
#include "material_hs.hpp"
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

inline double hs_power_ratio_at_sigma3(double sigma_3,
                                       double c_eff,
                                       double phi_eff,
                                       const RegionParams::HsParams& hs) {
  const double p_ref = std::max(hs.p_ref, 1.0);
  const double mu_3 = hs_stress_power_term(c_eff, phi_eff, sigma_3, hs);
  const double mu_p = hs_stress_power_term(c_eff, phi_eff, p_ref, hs);
  const double exponent = std::clamp(hs.m, 0.0, 1.0);
  return std::pow(mu_3 / mu_p, exponent);
}

inline double hs_power_ratio_derivative_sigma3(
    double sigma_3,
    double c_eff,
    double phi_eff,
    const RegionParams::HsParams& hs) {
  const double mu_3 = hs_stress_power_term(c_eff, phi_eff, sigma_3, hs);
  const double ratio = hs_power_ratio_at_sigma3(sigma_3, c_eff, phi_eff, hs);
  const double dsigma_eff_ds3 =
      effective_confining_stress_derivative(sigma_3, hs);
  if (!(mu_3 > numerical_pressure_floor(hs) && ratio > 0.0)) return 0.0;
  return std::clamp(hs.m, 0.0, 1.0)
       * ratio
       * std::sin(phi_eff)
       * dsigma_eff_ds3
       / mu_3;
}

inline double compute_dE_50_d_sigma_3(double E50_ref,
                                      double sigma_3,
                                      double c_eff,
                                      double phi_eff,
                                      const RegionParams::HsParams& hs) {
  return E50_ref * hs_power_ratio_derivative_sigma3(
      sigma_3, c_eff, phi_eff, hs);
}

inline double compute_dE_ur_d_sigma_3(double Eur_ref,
                                      double sigma_3,
                                      double c_eff,
                                      double phi_eff,
                                      const RegionParams::HsParams& hs) {
  return Eur_ref * hs_power_ratio_derivative_sigma3(
      sigma_3, c_eff, phi_eff, hs);
}

inline double compute_dE_i_d_sigma_3(double E50_ref,
                                     double sigma_3,
                                     double c_eff,
                                     double phi_eff,
                                     double Rf,
                                     const RegionParams::HsParams& hs) {
  const double dE50_ds3 = compute_dE_50_d_sigma_3(
      E50_ref, sigma_3, c_eff, phi_eff, hs);
  return 2.0 * dE50_ds3 / std::max(2.0 - Rf, 1e-9);
}

inline double compute_dq_f_d_sigma_3(double sigma_3,
                                     double c_eff,
                                     double phi_eff,
                                     const RegionParams::HsParams& hs) {
  (void)c_eff;
  const double dsigma_eff_ds3 =
      effective_confining_stress_derivative(sigma_3, hs);
  double sinPhi = std::sin(phi_eff);
  if (sinPhi < 1e-6) sinPhi = 1e-6;
  return dsigma_eff_ds3 * 2.0 * sinPhi / std::max(1.0 - sinPhi, 1e-9);
}

inline double compute_dq_a_d_sigma_3(double sigma_3,
                                     double c_eff,
                                     double phi_eff,
                                     double Rf,
                                     const RegionParams::HsParams& hs) {
  return compute_dq_f_d_sigma_3(sigma_3, c_eff, phi_eff, hs)
       / std::max(Rf, 1e-6);
}

inline double compute_df_dE_i_cone(double E_i, double q_a, double q) {
  const double q_clamped = std::min(q, 0.999 * q_a);
  const double denom_qa = std::max(1.0 - q_clamped / q_a, 1e-3);
  return -2.0 * q_clamped / (E_i * E_i * denom_qa);
}

inline double compute_df_dE_ur_cone(double E_ur, double q_a, double q) {
  const double q_clamped = std::min(q, 0.999 * q_a);
  return 2.0 * q_clamped / (E_ur * E_ur);
}

inline double compute_df_dq_a_cone(double E_i, double q_a, double q) {
  const double q_clamped = std::min(q, 0.999 * q_a);
  const double denom_qa = std::max(1.0 - q_clamped / q_a, 1e-3);
  return -2.0 * q_clamped * q_clamped
       / (E_i * q_a * q_a * denom_qa * denom_qa);
}

inline double compute_df_dsigma3_implicit_cone(
    double E_i,
    double E_ur,
    double q_a,
    double q,
    double dE_i_ds3,
    double dE_ur_ds3,
    double dq_a_ds3) {
  return compute_df_dE_i_cone(E_i, q_a, q) * dE_i_ds3
       + compute_df_dE_ur_cone(E_ur, q_a, q) * dE_ur_ds3
       + compute_df_dq_a_cone(E_i, q_a, q) * dq_a_ds3;
}

inline double compute_dsin_phi_mob_dsigma1(double s1,
                                           double s3,
                                           double c_eff,
                                           double phi_eff) {
  const double denom = s1 + s3 + 2.0 * c_eff * cot_safe(phi_eff);
  if (denom <= 1e-6) return 0.0;
  const double raw = (s1 - s3) / denom;
  const double sinPhi = std::sin(phi_eff);
  if (raw <= 0.0 || raw >= sinPhi) return 0.0;
  return (1.0 - raw) / denom;
}

inline double compute_dsin_phi_mob_dsigma3(double s1,
                                           double s3,
                                           double c_eff,
                                           double phi_eff) {
  const double denom = s1 + s3 + 2.0 * c_eff * cot_safe(phi_eff);
  if (denom <= 1e-6) return 0.0;
  const double raw = (s1 - s3) / denom;
  const double sinPhi = std::sin(phi_eff);
  if (raw <= 0.0 || raw >= sinPhi) return 0.0;
  return -(1.0 + raw) / denom;
}

inline double rowe_dsinpsi_dsinphi(double sin_phi_mob,
                                   double sin_phi_cv) {
  double denom = 1.0 - sin_phi_mob * sin_phi_cv;
  if (denom < 1e-12) denom = 1e-12;
  return (1.0 - sin_phi_cv * sin_phi_cv) / (denom * denom);
}

inline double compute_dsin_psi_dsigma1_cone(
    double s1,
    double s3,
    double c_eff,
    double phi_eff,
    double sin_phi_cv,
    bool pre_critical_cutoff,
    bool dilatancy_cutoff) {
  if (pre_critical_cutoff || dilatancy_cutoff) return 0.0;
  const double sin_phi_mob = mobilised_sin_phi(s1, s3, c_eff, phi_eff);
  return rowe_dsinpsi_dsinphi(sin_phi_mob, sin_phi_cv)
       * compute_dsin_phi_mob_dsigma1(s1, s3, c_eff, phi_eff);
}

inline double compute_dsin_psi_dsigma3_cone(
    double s1,
    double s3,
    double c_eff,
    double phi_eff,
    double sin_phi_cv,
    bool pre_critical_cutoff,
    bool dilatancy_cutoff) {
  if (pre_critical_cutoff || dilatancy_cutoff) return 0.0;
  const double sin_phi_mob = mobilised_sin_phi(s1, s3, c_eff, phi_eff);
  return rowe_dsinpsi_dsinphi(sin_phi_mob, sin_phi_cv)
       * compute_dsin_phi_mob_dsigma3(s1, s3, c_eff, phi_eff);
}

struct HsAlgorithmicTangentContext {
  double s1{0.0};
  double s2{0.0};
  double s3{0.0};
  double gamma_p{0.0};
  double p_p{0.0};
  double eps_v_p{0.0};
  double E_50{0.0};
  double E_ur{0.0};
  double E_i{0.0};
  double q_a{0.0};
  double q_f{0.0};
  double dE_50_ds3{0.0};
  double dE_ur_ds3{0.0};
  double dE_i_ds3{0.0};
  double dq_a_ds3{0.0};
  double dq_f_ds3{0.0};
  double df_dsigma3_implicit{0.0};
  double sin_phi_mob{0.0};
  double sin_psi_mob{0.0};
  double sin_phi_cv{0.0};
  double dpsi_dsigma_1{0.0};
  double dpsi_dsigma_3{0.0};
  double dlambda_s{0.0};
  double dlambda_c{0.0};
  double dqtilde_ds1{0.0};
  double dqtilde_ds2{0.0};
  double dqtilde_ds3{0.0};
  double M_cap{0.0};
  double p_t{0.0};
  double H_cap{0.0};
  double p_prime{0.0};
  bool dilatancy_cutoff_active{false};
  bool pre_critical_cutoff_active{false};
  ConeFlowRegime regime{ConeFlowRegime::Face13};
};

inline void compute_cap_qtilde_gradient(double s1,
                                        double s2,
                                        double s3,
                                        double phi_eff,
                                        double& dq_d1,
                                        double& dq_d2,
                                        double& dq_d3) {
  const double sphi = std::sin(phi_eff);
  const double delta = (3.0 + sphi) / (3.0 - sphi);
  const double dm1 = delta - 1.0;
  const double neg_d = -delta;
  dq_d1 = 1.0;
  dq_d2 = dm1;
  dq_d3 = neg_d;

  const double mag = std::max({std::abs(s1), std::abs(s2), std::abs(s3), 1.0});
  const double edge_tol = 1e-6 * mag;
  const bool edge_23 = std::abs(s2 - s3) <= edge_tol;
  const bool edge_12 = std::abs(s1 - s2) <= edge_tol;

  if (edge_23 && edge_12) {
    const double avg = (1.0 + dm1 + neg_d) / 3.0;
    dq_d1 = avg;
    dq_d2 = avg;
    dq_d3 = avg;
  } else if (edge_23) {
    dq_d1 = 1.0;
    const double avg23 = 0.5 * (dm1 + neg_d);
    dq_d2 = avg23;
    dq_d3 = avg23;
  } else if (edge_12) {
    const double avg12 = 0.5 * (1.0 + dm1);
    dq_d1 = avg12;
    dq_d2 = avg12;
    dq_d3 = neg_d;
  }
}

inline HsAlgorithmicTangentContext build_sh_context(
    const mce::PrincipalState& principalC,
    double s1,
    double s2,
    double s3,
    double gamma_p_new,
    double p_p_new,
    double eps_v_p_new,
    double dlambda_s,
    double dlambda_c,
    double c_eff,
    double phi_eff,
    double psi_eff,
    double sin_phi_cv,
    double M_cap,
    double p_t,
    double H_cap,
    const RegionParams& region) {
  HsAlgorithmicTangentContext ctx{};
  ctx.s1 = s1;
  ctx.s2 = s2;
  ctx.s3 = s3;
  ctx.gamma_p = gamma_p_new;
  ctx.p_p = p_p_new;
  ctx.eps_v_p = eps_v_p_new;
  ctx.dlambda_s = dlambda_s;
  ctx.dlambda_c = dlambda_c;
  ctx.M_cap = M_cap;
  ctx.p_t = p_t;
  ctx.H_cap = H_cap;
  ctx.p_prime = (s1 + s2 + s3) / 3.0;
  ctx.sin_phi_cv = sin_phi_cv;
  ctx.regime = classify_cone_regime(principalC);

  const double Rf = std::clamp(region.hs.Rf, 1e-3, 0.999);
  const double ratio = hs_power_ratio_at_sigma3(s3, c_eff, phi_eff, region.hs);
  ctx.E_50 = region.hs.E50_ref * ratio;
  ctx.E_ur = region.hs.Eur_ref * ratio;
  ctx.E_i = 2.0 * ctx.E_50 / (2.0 - Rf);
  double sinPhi = std::sin(phi_eff);
  if (sinPhi < 1e-6) sinPhi = 1e-6;
  const double sigma3_eff = effective_confining_stress(s3, region.hs);
  ctx.q_f = (c_eff * cot_safe(phi_eff) + sigma3_eff) * 2.0 * sinPhi
          / std::max(1.0 - sinPhi, 1e-9);
  ctx.q_a = std::max(ctx.q_f / Rf, numerical_pressure_floor(region.hs));

  ctx.dE_50_ds3 = compute_dE_50_d_sigma_3(
      region.hs.E50_ref, s3, c_eff, phi_eff, region.hs);
  ctx.dE_ur_ds3 = compute_dE_ur_d_sigma_3(
      region.hs.Eur_ref, s3, c_eff, phi_eff, region.hs);
  ctx.dE_i_ds3 = compute_dE_i_d_sigma_3(
      region.hs.E50_ref, s3, c_eff, phi_eff, Rf, region.hs);
  ctx.dq_f_ds3 = compute_dq_f_d_sigma_3(s3, c_eff, phi_eff, region.hs);
  ctx.dq_a_ds3 = compute_dq_a_d_sigma_3(
      s3, c_eff, phi_eff, Rf, region.hs);
  ctx.df_dsigma3_implicit = compute_df_dsigma3_implicit_cone(
      ctx.E_i, ctx.E_ur, ctx.q_a, s1 - s3,
      ctx.dE_i_ds3, ctx.dE_ur_ds3, ctx.dq_a_ds3);

  ctx.sin_phi_mob = mobilised_sin_phi(s1, s3, c_eff, phi_eff);
  const double eps_v_p_max = dilatancy_cutoff_threshold(
      region.hs.e_init, region.hs.e_max);
  ctx.sin_psi_mob = mobilised_sin_psi(
      ctx.sin_phi_mob, sin_phi_cv, psi_eff, eps_v_p_new, eps_v_p_max);

  double roweDenom = 1.0 - ctx.sin_phi_mob * sin_phi_cv;
  if (roweDenom < 1e-12) roweDenom = 1e-12;
  const double rawRowe = (ctx.sin_phi_mob - sin_phi_cv) / roweDenom;
  const double psiLimit = std::sin(psi_eff);
  ctx.dilatancy_cutoff_active = eps_v_p_new <= eps_v_p_max;
  ctx.pre_critical_cutoff_active =
      ctx.sin_phi_mob <= sin_phi_cv || rawRowe <= 0.0 || rawRowe >= psiLimit;
  ctx.dpsi_dsigma_1 = compute_dsin_psi_dsigma1_cone(
      s1, s3, c_eff, phi_eff, sin_phi_cv,
      ctx.pre_critical_cutoff_active,
      ctx.dilatancy_cutoff_active);
  ctx.dpsi_dsigma_3 = compute_dsin_psi_dsigma3_cone(
      s1, s3, c_eff, phi_eff, sin_phi_cv,
      ctx.pre_critical_cutoff_active,
      ctx.dilatancy_cutoff_active);

  compute_cap_qtilde_gradient(
      s1, s2, s3, phi_eff,
      ctx.dqtilde_ds1, ctx.dqtilde_ds2, ctx.dqtilde_ds3);
  return ctx;
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
