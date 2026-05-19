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
  double phi_eff{0.0};
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
  ctx.phi_eff = phi_eff;
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

inline double mat3_inner(const Mat3& A, const Mat3& B) {
  double acc = 0.0;
  for (int r = 0; r < 3; ++r) {
    for (int c = 0; c < 3; ++c) acc += A[r][c] * B[r][c];
  }
  return acc;
}

inline Mat3 mat3_zero() {
  return Mat3{{{0.0, 0.0, 0.0},
               {0.0, 0.0, 0.0},
               {0.0, 0.0, 0.0}}};
}

inline void mat3_add_scaled(Mat3& A, const Mat3& B, double scale) {
  for (int r = 0; r < 3; ++r) {
    for (int c = 0; c < 3; ++c) A[r][c] += scale * B[r][c];
  }
}

inline Mat3 mat3_mul(const Mat3& A, const Mat3& B) {
  Mat3 C = mat3_zero();
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      for (int k = 0; k < 3; ++k) C[i][j] += A[i][k] * B[k][j];
    }
  }
  return C;
}

inline Mat6 mat6_identity() {
  Mat6 I{};
  for (int i = 0; i < 6; ++i) I[i][i] = 1.0;
  return I;
}

inline Mat6 mat6_mul(const Mat6& A, const Mat6& B) {
  Mat6 C{};
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      double acc = 0.0;
      for (int k = 0; k < 6; ++k) acc += A[i][k] * B[k][j];
      C[i][j] = acc;
    }
  }
  return C;
}

inline Mat3 stress_basis_tensor(int col) {
  Mat3 E = mat3_zero();
  switch (col) {
    case V_XX: E[0][0] = 1.0; break;
    case V_YY: E[1][1] = 1.0; break;
    case V_ZZ: E[2][2] = 1.0; break;
    case V_XY: E[0][1] = E[1][0] = 1.0; break;
    case V_YZ: E[1][2] = E[2][1] = 1.0; break;
    case V_XZ: E[0][2] = E[2][0] = 1.0; break;
    default: break;
  }
  return E;
}

inline Vec6 tensor_to_voigt_no_sign(const Mat3& A) {
  return Vec6{A[0][0], A[1][1], A[2][2], A[0][1], A[1][2], A[0][2]};
}

inline void cone_flow_dpsi_outer_product(
    ConeFlowRegime regime,
    double* u_p,
    double* v_p,
    double dpsi_ds1,
    double dpsi_ds3,
    bool cutoff_active) {
  if (cutoff_active) {
    for (int i = 0; i < 3; ++i) {
      u_p[i] = 0.0;
      v_p[i] = 0.0;
    }
    return;
  }

  switch (regime) {
    case ConeFlowRegime::Face13:
      u_p[0] = -0.5;
      u_p[1] = 0.0;
      u_p[2] = -0.5;
      break;
    case ConeFlowRegime::CompressionEdge:
      u_p[0] = -0.5;
      u_p[1] = -0.25;
      u_p[2] = -0.25;
      break;
    case ConeFlowRegime::ExtensionEdge:
      u_p[0] = -0.25;
      u_p[1] = -0.25;
      u_p[2] = -0.5;
      break;
  }
  v_p[0] = dpsi_ds1;
  v_p[1] = 0.0;
  v_p[2] = dpsi_ds3;
}

inline void cone_yield_gradient_with_implicit(
    ConeFlowRegime regime,
    double E_i,
    double E_ur,
    double q_a,
    double q,
    double df_dsigma3_implicit,
    double& n1,
    double& n2,
    double& n3) {
  const double q_clamped = std::min(q, 0.999 * q_a);
  const double denom_qa = std::max(1.0 - q_clamped / q_a, 1e-3);
  const double df_dq = (2.0 / E_i) / (denom_qa * denom_qa)
                     - 2.0 / E_ur;
  cone_yield_gradient(regime, df_dq, n1, n2, n3);
  n3 += df_dsigma3_implicit;
}

inline Mat6 spectral_flow_derivative_dense(
    const mce::PrincipalState& principal,
    const double flow_p[3],
    const double dflow_ds[3][3],
    bool includePrincipalValueTerms,
    bool includeProjectorTerms,
    bool& ok) {
  Mat6 out{};
  ok = true;
  const Mat3 P[3] = {principal.P1, principal.P2, principal.P3};
  const double s[3] = {principal.s1, principal.s2, principal.s3};
  const double scale = std::max({std::abs(s[0]), std::abs(s[1]), std::abs(s[2]), 1.0});

  for (int col = 0; col < 6; ++col) {
    const Mat3 E = stress_basis_tensor(col);
    Mat3 dM = mat3_zero();

    if (includePrincipalValueTerms) {
      for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
          mat3_add_scaled(dM, P[i], dflow_ds[i][j] * mat3_inner(P[j], E));
        }
      }
    }

    if (includeProjectorTerms) {
      for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
          if (i == j) continue;
          const double denom = s[i] - s[j];
          if (std::abs(denom) <= 1e-10 * scale) {
            ok = false;
            continue;
          }
          const double coeff = (flow_p[i] - flow_p[j]) / denom;
          mat3_add_scaled(dM, mat3_mul(mat3_mul(P[i], E), P[j]), coeff);
        }
      }
    }

    const Vec6 flow_tensor = tensor_to_voigt_no_sign(dM);
    const Vec6 flow_eng = strain_vector_from_flow_tensor(flow_tensor);
    for (int row = 0; row < 6; ++row) out[row][col] = flow_eng[row];
  }

  return out;
}

inline Mat6 spectral_flow_derivative_dense(
    const mce::PrincipalState& principal,
    const double flow_p[3],
    const double dflow_ds[3][3],
    bool& ok) {
  return spectral_flow_derivative_dense(
      principal, flow_p, dflow_ds,
      /*includePrincipalValueTerms=*/true,
      /*includeProjectorTerms=*/true,
      ok);
}

inline Mat6 compute_cone_dmdsigma_dense(
    const mce::PrincipalState& principal,
    const HsAlgorithmicTangentContext& ctx,
    bool& ok) {
  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  cone_flow_gradient(ctx.regime, ctx.sin_psi_mob, m1, m2, m3);
  const double flow_p[3] = {m1, m2, m3};

  double u[3]{};
  double v[3]{};
  cone_flow_dpsi_outer_product(
      ctx.regime, u, v,
      ctx.dpsi_dsigma_1, ctx.dpsi_dsigma_3,
      ctx.dilatancy_cutoff_active || ctx.pre_critical_cutoff_active);
  double dflow_ds[3][3]{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) dflow_ds[i][j] = u[i] * v[j];
  }
  return spectral_flow_derivative_dense(principal, flow_p, dflow_ds, ok);
}

inline Mat6 compute_cone_dmdsigma_principal_dense(
    const mce::PrincipalState& principal,
    const HsAlgorithmicTangentContext& ctx,
    bool& ok) {
  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  cone_flow_gradient(ctx.regime, ctx.sin_psi_mob, m1, m2, m3);
  const double flow_p[3] = {m1, m2, m3};

  double u[3]{};
  double v[3]{};
  cone_flow_dpsi_outer_product(
      ctx.regime, u, v,
      ctx.dpsi_dsigma_1, ctx.dpsi_dsigma_3,
      ctx.dilatancy_cutoff_active || ctx.pre_critical_cutoff_active);
  double dflow_ds[3][3]{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) dflow_ds[i][j] = u[i] * v[j];
  }
  return spectral_flow_derivative_dense(
      principal, flow_p, dflow_ds,
      /*includePrincipalValueTerms=*/true,
      /*includeProjectorTerms=*/false,
      ok);
}

inline Mat6 compute_cone_dmdtrial_projector_dense(
    const mce::PrincipalState& principal,
    const HsAlgorithmicTangentContext& ctx,
    bool& ok) {
  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  cone_flow_gradient(ctx.regime, ctx.sin_psi_mob, m1, m2, m3);
  const double flow_p[3] = {m1, m2, m3};
  double dflow_ds[3][3]{};
  return spectral_flow_derivative_dense(
      principal, flow_p, dflow_ds,
      /*includePrincipalValueTerms=*/false,
      /*includeProjectorTerms=*/true,
      ok);
}

inline void cap_flow_gradient_from_context(
    const HsAlgorithmicTangentContext& ctx,
    double& m1,
    double& m2,
    double& m3) {
  const double q_tilde = ctx.dqtilde_ds1 * ctx.s1
                       + ctx.dqtilde_ds2 * ctx.s2
                       + ctx.dqtilde_ds3 * ctx.s3;
  const double two_qt_over_M2 =
      2.0 * q_tilde / std::max(ctx.M_cap * ctx.M_cap, 1e-12);
  const double p_term = (2.0 / 3.0) * (ctx.p_prime + ctx.p_t);
  m1 = two_qt_over_M2 * ctx.dqtilde_ds1 + p_term;
  m2 = two_qt_over_M2 * ctx.dqtilde_ds2 + p_term;
  m3 = two_qt_over_M2 * ctx.dqtilde_ds3 + p_term;
}

inline Mat6 compute_cap_dmdsigma_principal_dense(
    const mce::PrincipalState& principal,
    const HsAlgorithmicTangentContext& ctx,
    bool& ok) {
  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  cap_flow_gradient_from_context(ctx, m1, m2, m3);
  const double flow_p[3] = {m1, m2, m3};
  const double dq[3] = {ctx.dqtilde_ds1, ctx.dqtilde_ds2, ctx.dqtilde_ds3};
  const double scale_q = 2.0 / std::max(ctx.M_cap * ctx.M_cap, 1e-12);

  double dflow_ds[3][3]{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      dflow_ds[i][j] = scale_q * dq[i] * dq[j] + 2.0 / 9.0;
    }
  }

  return spectral_flow_derivative_dense(
      principal, flow_p, dflow_ds,
      /*includePrincipalValueTerms=*/true,
      /*includeProjectorTerms=*/false,
      ok);
}

inline Mat6 compute_cap_dmdtrial_projector_dense(
    const mce::PrincipalState& principal,
    const HsAlgorithmicTangentContext& ctx,
    bool& ok) {
  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  cap_flow_gradient_from_context(ctx, m1, m2, m3);
  const double flow_p[3] = {m1, m2, m3};
  double dflow_ds[3][3]{};
  return spectral_flow_derivative_dense(
      principal, flow_p, dflow_ds,
      /*includePrincipalValueTerms=*/false,
      /*includeProjectorTerms=*/true,
      ok);
}

inline double frobenius_norm6(const Mat6& A) {
  double acc = 0.0;
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) acc += A[i][j] * A[i][j];
  }
  return std::sqrt(acc);
}

inline Mat6 compute_xi_dense(const Mat6& D_e,
                             const Mat6& dmdsigma,
                             double dlambda,
                             bool& ok);

inline Mat6 compute_xi_dense_two_surface(const Mat6& D_e,
                                         const Mat6& dms_dsigma,
                                         double dlambda_s,
                                         const Mat6& dmc_dsigma,
                                         double dlambda_c,
                                         bool& ok);

inline Mat6 compute_simo_hughes_cone_tangent(
    const mce::PrincipalState& principalC,
    const HsAlgorithmicTangentContext& ctx,
    const Mat6& D_e,
    bool& ok) {
  ok = true;
  if (std::abs(ctx.dlambda_s) < 1e-10 * std::max(frobenius_norm6(D_e), 1.0)) {
    return D_e;
  }

  // The implemented HS return map direction-locks the cone flow to the trial
  // eigenbasis. Its exact residual linearisation therefore splits the flow
  // sensitivity in two pieces:
  //
  //   M_sigma = principal-value sensitivity at fixed trial projectors
  //   M_trial = eigenprojector rotation sensitivity of the trial basis
  //
  // The Simo-Hughes modified stiffness uses M_sigma in Xi. M_trial belongs on
  // the strain-side residual sensitivity because sigma_trial = sigma_n + D_e dε.
  bool dmdsigma_ok = false;
  const Mat6 dmdsigma = compute_cone_dmdsigma_principal_dense(
      principalC, ctx, dmdsigma_ok);
  if (!dmdsigma_ok) {
    ok = false;
    return D_e;
  }

  bool xi_ok = false;
  const Mat6 Xi = compute_xi_dense(D_e, dmdsigma, ctx.dlambda_s, xi_ok);
  if (!xi_ok) {
    ok = false;
    return D_e;
  }

  bool dmdtrial_ok = false;
  const Mat6 dmdtrial = compute_cone_dmdtrial_projector_dense(
      principalC, ctx, dmdtrial_ok);
  if (!dmdtrial_ok) {
    ok = false;
    return D_e;
  }
  Mat6 B = mat6_identity();
  const Mat6 dmdtrial_De = mat6_mul(dmdtrial, D_e);
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      B[i][j] -= ctx.dlambda_s * dmdtrial_De[i][j];
    }
  }
  const Mat6 XiB = mat6_mul(Xi, B);

  double n1 = 0.0, n2 = 0.0, n3 = 0.0;
  cone_yield_gradient_with_implicit(
      ctx.regime, ctx.E_i, ctx.E_ur, ctx.q_a, ctx.s1 - ctx.s3,
      ctx.df_dsigma3_implicit, n1, n2, n3);
  const Vec6 n_t = lift_principal_gradient_to_tensor_voigt(
      principalC, n1, n2, n3);

  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  cone_flow_gradient(ctx.regime, ctx.sin_psi_mob, m1, m2, m3);
  const Vec6 m_t = lift_principal_gradient_to_tensor_voigt(
      principalC, m1, m2, m3);
  const Vec6 m_eng = tensor_voigt_to_engineering(m_t);

  const Vec6 Xi_m = lng::mul6x6(Xi, m_eng);
  const Vec6 XiBT_n = transpose_tangent_times_stress_covector(XiB, n_t);
  const double A = stress_covector_dot_stress_vector(n_t, Xi_m) + 1.0;
  ok = std::isfinite(A) && std::abs(A) > 1e-12;
  if (!ok) return D_e;

  Mat6 D_ep = XiB;
  const double invA = 1.0 / A;
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      D_ep[i][j] -= Xi_m[i] * XiBT_n[j] * invA;
    }
  }

  for (int i = 0; i < 6 && ok; ++i) {
    for (int j = 0; j < 6 && ok; ++j) ok = std::isfinite(D_ep[i][j]);
  }
  return ok ? D_ep : D_e;
}

inline Mat6 compute_simo_hughes_cap_tangent(
    const mce::PrincipalState& principalC,
    const HsAlgorithmicTangentContext& ctx,
    const Mat6& D_e,
    bool& ok) {
  ok = true;
  if (std::abs(ctx.dlambda_c) < 1e-10 * std::max(frobenius_norm6(D_e), 1.0)) {
    return D_e;
  }

  bool dmdsigma_ok = false;
  const Mat6 dmdsigma = compute_cap_dmdsigma_principal_dense(
      principalC, ctx, dmdsigma_ok);
  if (!dmdsigma_ok) {
    ok = false;
    return D_e;
  }

  bool xi_ok = false;
  const Mat6 Xi = compute_xi_dense(D_e, dmdsigma, ctx.dlambda_c, xi_ok);
  if (!xi_ok) {
    ok = false;
    return D_e;
  }

  bool dmdtrial_ok = false;
  const Mat6 dmdtrial = compute_cap_dmdtrial_projector_dense(
      principalC, ctx, dmdtrial_ok);
  if (!dmdtrial_ok) {
    ok = false;
    return D_e;
  }
  Mat6 B = mat6_identity();
  const Mat6 dmdtrial_De = mat6_mul(dmdtrial, D_e);
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      B[i][j] -= ctx.dlambda_c * dmdtrial_De[i][j];
    }
  }
  const Mat6 XiB = mat6_mul(Xi, B);

  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  cap_flow_gradient_from_context(ctx, m1, m2, m3);
  const Vec6 m_t = lift_principal_gradient_to_tensor_voigt(
      principalC, m1, m2, m3);
  const Vec6 m_eng = tensor_voigt_to_engineering(m_t);

  const double normalCorrection =
      (4.0 / 3.0) * ctx.dlambda_c * ctx.H_cap * (ctx.p_p + ctx.p_t);
  const Vec6 n_eff_t = lift_principal_gradient_to_tensor_voigt(
      principalC,
      m1 - normalCorrection,
      m2 - normalCorrection,
      m3 - normalCorrection);

  const Vec6 Xi_m = lng::mul6x6(Xi, m_eng);
  const Vec6 XiBT_n = transpose_tangent_times_stress_covector(XiB, n_eff_t);
  const double H_cap_eff = 4.0 * std::max(ctx.H_cap, 0.0)
                         * (ctx.p_p + ctx.p_t)
                         * (ctx.p_prime + ctx.p_t);
  const double A = stress_covector_dot_stress_vector(n_eff_t, Xi_m)
                 + H_cap_eff;
  ok = std::isfinite(A) && std::abs(A) > 1e-12;
  if (!ok) return D_e;

  Mat6 D_ep = XiB;
  const double invA = 1.0 / A;
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      D_ep[i][j] -= Xi_m[i] * XiBT_n[j] * invA;
    }
  }

  for (int i = 0; i < 6 && ok; ++i) {
    for (int j = 0; j < 6 && ok; ++j) ok = std::isfinite(D_ep[i][j]);
  }
  return ok ? D_ep : D_e;
}

inline Mat6 compute_simo_hughes_corner_tangent(
    const mce::PrincipalState& principalC,
    const HsAlgorithmicTangentContext& ctx,
    const Mat6& D_e,
    bool& ok) {
  ok = true;
  const double dl_norm = std::abs(ctx.dlambda_s) + std::abs(ctx.dlambda_c);
  if (dl_norm < 1e-10 * std::max(frobenius_norm6(D_e), 1.0)) {
    return D_e;
  }

  bool dms_ok = false;
  const Mat6 dmsigma_s = compute_cone_dmdsigma_principal_dense(
      principalC, ctx, dms_ok);
  if (!dms_ok) {
    ok = false;
    return D_e;
  }
  bool dmc_ok = false;
  const Mat6 dmsigma_c = compute_cap_dmdsigma_principal_dense(
      principalC, ctx, dmc_ok);
  if (!dmc_ok) {
    ok = false;
    return D_e;
  }

  bool xi_ok = false;
  const Mat6 Xi = compute_xi_dense_two_surface(
      D_e, dmsigma_s, ctx.dlambda_s,
      dmsigma_c, ctx.dlambda_c,
      xi_ok);
  if (!xi_ok) {
    ok = false;
    return D_e;
  }

  bool dtrial_s_ok = false;
  const Mat6 dtrial_s = compute_cone_dmdtrial_projector_dense(
      principalC, ctx, dtrial_s_ok);
  if (!dtrial_s_ok) {
    ok = false;
    return D_e;
  }
  bool dtrial_c_ok = false;
  const Mat6 dtrial_c = compute_cap_dmdtrial_projector_dense(
      principalC, ctx, dtrial_c_ok);
  if (!dtrial_c_ok) {
    ok = false;
    return D_e;
  }
  Mat6 dtrial{};
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      dtrial[i][j] = ctx.dlambda_s * dtrial_s[i][j]
                   + ctx.dlambda_c * dtrial_c[i][j];
    }
  }
  Mat6 B = mat6_identity();
  const Mat6 dtrial_De = mat6_mul(dtrial, D_e);
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) B[i][j] -= dtrial_De[i][j];
  }
  const Mat6 XiB = mat6_mul(Xi, B);

  double n_s1 = 0.0, n_s2 = 0.0, n_s3 = 0.0;
  cone_yield_gradient_with_implicit(
      ctx.regime, ctx.E_i, ctx.E_ur, ctx.q_a, ctx.s1 - ctx.s3,
      ctx.df_dsigma3_implicit, n_s1, n_s2, n_s3);
  const Vec6 n_s_t = lift_principal_gradient_to_tensor_voigt(
      principalC, n_s1, n_s2, n_s3);

  double m_s1 = 0.0, m_s2 = 0.0, m_s3 = 0.0;
  cone_flow_gradient(ctx.regime, ctx.sin_psi_mob, m_s1, m_s2, m_s3);
  const Vec6 m_s_t = lift_principal_gradient_to_tensor_voigt(
      principalC, m_s1, m_s2, m_s3);
  const Vec6 m_s_eng = tensor_voigt_to_engineering(m_s_t);

  double m_c1 = 0.0, m_c2 = 0.0, m_c3 = 0.0;
  cap_flow_gradient_from_context(ctx, m_c1, m_c2, m_c3);
  const Vec6 m_c_t = lift_principal_gradient_to_tensor_voigt(
      principalC, m_c1, m_c2, m_c3);
  const Vec6 m_c_eng = tensor_voigt_to_engineering(m_c_t);

  const double normalCorrection =
      (4.0 / 3.0) * ctx.dlambda_c * ctx.H_cap * (ctx.p_p + ctx.p_t);
  const Vec6 n_c_eff_t = lift_principal_gradient_to_tensor_voigt(
      principalC,
      m_c1 - normalCorrection,
      m_c2 - normalCorrection,
      m_c3 - normalCorrection);

  const Vec6 Xi_m_s = lng::mul6x6(Xi, m_s_eng);
  const Vec6 Xi_m_c = lng::mul6x6(Xi, m_c_eng);
  const Vec6 XiBT_n_s = transpose_tangent_times_stress_covector(XiB, n_s_t);
  const Vec6 XiBT_n_c = transpose_tangent_times_stress_covector(XiB, n_c_eff_t);

  const double a00 = stress_covector_dot_stress_vector(n_s_t, Xi_m_s) + 1.0;
  const double a01 = stress_covector_dot_stress_vector(n_s_t, Xi_m_c);
  const double a10 = stress_covector_dot_stress_vector(n_c_eff_t, Xi_m_s);
  const double a11 = stress_covector_dot_stress_vector(n_c_eff_t, Xi_m_c)
                   + 4.0 * std::max(ctx.H_cap, 0.0)
                         * (ctx.p_p + ctx.p_t) * (ctx.p_prime + ctx.p_t);
  const double det = a00 * a11 - a01 * a10;
  ok = std::isfinite(det) && std::abs(det) > 1e-12;
  if (!ok) return D_e;

  const double inv_det = 1.0 / det;
  const double ai00 =  a11 * inv_det;
  const double ai01 = -a01 * inv_det;
  const double ai10 = -a10 * inv_det;
  const double ai11 =  a00 * inv_det;

  Mat6 D_ep = XiB;
  for (int j = 0; j < 6; ++j) {
    const double r0 = ai00 * XiBT_n_s[j] + ai01 * XiBT_n_c[j];
    const double r1 = ai10 * XiBT_n_s[j] + ai11 * XiBT_n_c[j];
    for (int i = 0; i < 6; ++i) {
      D_ep[i][j] -= Xi_m_s[i] * r0 + Xi_m_c[i] * r1;
    }
  }

  for (int i = 0; i < 6 && ok; ++i) {
    for (int j = 0; j < 6 && ok; ++j) ok = std::isfinite(D_ep[i][j]);
  }
  return ok ? D_ep : D_e;
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
