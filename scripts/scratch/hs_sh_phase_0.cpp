// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-0 residual-sensitivity harness for Hardening Soil.
//
// This file is intentionally harness-only. It is compiled by
// scripts/verify_hs_simo_hughes_phase_0.mjs and is not included in the WASM
// module. The purpose is to establish a local residual-sensitivity oracle:
//
//   F(y, eps_trial) = 0
//   J_y * dy/deps = -J_eps
//   D_alg = d sigma / d eps
//
// Active sets are frozen for each smooth case. Non-smooth probe states are
// rejected by the verifier rather than accepted into tangent validation.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "material_hs.hpp"
#include "material_hs_tangent.hpp"

namespace sh0 {

using madep::Mat6;
using madep::RegionParams;
using madep::Vec6;
using madep::V_XX;
using madep::V_YY;
using madep::V_ZZ;
using madep::V_XY;
using madep::V_YZ;
using madep::V_XZ;
using madep::MaterialPoint;
namespace hs = madep::material::hs;
namespace sht = madep::material::hs::tangent;
namespace lng = madep::linalg;
namespace mce = madep::mc_exact;
namespace jsm = madep::js_mirror;

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::array<std::size_t, 3> kInPlane = {V_XX, V_YY, V_XY};

void require(bool ok, const std::string& msg) {
  if (!ok) throw std::runtime_error(msg);
}

bool close(double a, double b, double tol, double floor = 1.0) {
  return std::abs(a - b) <= tol * std::max({std::abs(a), std::abs(b), floor});
}

void test_voigt_dual_helpers() {
  Vec6 a{1, 2, 3, 4, 5, 6};
  Vec6 b{7, 8, 9, 10, 11, 12};
  const double expected = 1 * 7 + 2 * 8 + 3 * 9
                        + 2.0 * (4 * 10 + 5 * 11 + 6 * 12);
  require(close(sht::stress_covector_dot_stress_vector(a, b), expected, 1e-14),
          "stress covector dot stress vector shear weighting failed");

  Vec6 flow = sht::strain_vector_from_flow_tensor(a);
  require(flow[V_XX] == 1 && flow[V_YY] == 2 && flow[V_ZZ] == 3 &&
          flow[V_XY] == 8 && flow[V_YZ] == 10 && flow[V_XZ] == 12,
          "strain_vector_from_flow_tensor did not double tensor shear slots");

  Mat6 D{};
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) D[i][j] = 10.0 * (i + 1) + (j + 1);
  }
  Vec6 Dt_a = sht::transpose_tangent_times_stress_covector(D, a);
  for (int j = 0; j < 6; ++j) {
    double expected_j = 0.0;
    for (int i = 0; i < 6; ++i) {
      const double weight = (i < 3) ? 1.0 : 2.0;
      expected_j += weight * a[i] * D[i][j];
    }
    require(close(Dt_a[j], expected_j, 1e-14),
            "transpose_tangent_times_stress_covector component mismatch");
  }
}

void test_xi_dense_helpers() {
  const Mat6 D = lng::elastic_matrix_E_nu(90000.0, 0.2);
  Mat6 zero{};
  bool ok = false;
  const Mat6 Xi0 = sht::compute_xi_dense(D, zero, 0.25, ok);
  require(ok, "compute_xi_dense rejected zero dmdsigma");
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      require(close(Xi0[i][j], D[i][j], 1e-12),
              "compute_xi_dense zero derivative did not return D_e");
    }
  }

  Mat6 dmdsigma{};
  dmdsigma[V_XX][V_XX] = 2e-5;
  dmdsigma[V_YY][V_YY] = 3e-5;
  dmdsigma[V_XY][V_XY] = 1e-5;
  ok = false;
  const Mat6 Xi = sht::compute_xi_dense(D, dmdsigma, 0.2, ok);
  require(ok, "compute_xi_dense rejected diagonal dmdsigma");
  bool inv_ok = false;
  Mat6 Xi_inv = sht::invert_dense6(Xi, inv_ok);
  require(inv_ok, "compute_xi_dense returned singular Xi");
  bool D_inv_ok = false;
  Mat6 expected_inv = sht::invert_dense6(D, D_inv_ok);
  require(D_inv_ok, "elastic D_e should be invertible");
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      expected_inv[i][j] += 0.2 * dmdsigma[i][j];
      require(close(Xi_inv[i][j], expected_inv[i][j], 1e-10),
              "compute_xi_dense inverse identity mismatch");
    }
  }

  Mat6 dmc{};
  dmc[V_ZZ][V_ZZ] = 4e-5;
  ok = false;
  const Mat6 Xi2 = sht::compute_xi_dense_two_surface(
      D, dmdsigma, 0.2, dmc, 0.3, ok);
  require(ok, "compute_xi_dense_two_surface rejected diagonal inputs");
  bool xi2_inv_ok = false;
  Mat6 Xi2_inv = sht::invert_dense6(Xi2, xi2_inv_ok);
  require(xi2_inv_ok, "compute_xi_dense_two_surface returned singular Xi");
  Mat6 expected2_inv = expected_inv;
  expected2_inv[V_ZZ][V_ZZ] += 0.3 * dmc[V_ZZ][V_ZZ];
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      require(close(Xi2_inv[i][j], expected2_inv[i][j], 1e-10),
              "compute_xi_dense_two_surface inverse identity mismatch");
    }
  }
}

RegionParams default_region() {
  RegionParams r{};
  r.Emc = 30000.0;
  r.nu = 0.3;
  r.cEff = 0.1;
  r.phi = 30.0 * kPi / 180.0;
  r.psi = 0.0;
  r.K0nc = 0.5;
  r.gamma = 18.0;
  r.gammaSat = 20.0;
  r.sigmaTAllow = 0.0;
  r.rShear = 0.25;
  r.useTensionCutoff = 0;
  r.symmetrize = 0;
  r.hs.E50_ref = 30000.0;
  r.hs.Eoed_ref = 30000.0;
  r.hs.Eur_ref = 90000.0;
  r.hs.m = 0.5;
  r.hs.nu_ur = 0.2;
  r.hs.p_ref = 100.0;
  r.hs.Rf = 0.9;
  r.hs.K0_nc = 0.0;
  r.hs.e_init = -1.0;
  r.hs.e_max = -1.0;
  r.hs.OCR = 1.0;
  hs::compute_hs_reference_constants(r, 1.0);
  return r;
}

Vec6 zero6() { return Vec6{0, 0, 0, 0, 0, 0}; }

Vec6 hydrostatic_stress(double p_compression) {
  return Vec6{-p_compression, -p_compression, -p_compression, 0, 0, 0};
}

double compression_component_in_projector(const Vec6& stress_tension,
                                          const jsm::Mat3& projector) {
  const double sxx = -stress_tension[V_XX];
  const double syy = -stress_tension[V_YY];
  const double szz = -stress_tension[V_ZZ];
  const double txy = -stress_tension[V_XY];
  const double tyz = -stress_tension[V_YZ];
  const double txz = -stress_tension[V_XZ];
  return projector[0][0] * sxx
       + projector[1][1] * syy
       + projector[2][2] * szz
       + 2.0 * (projector[0][1] * txy
              + projector[1][2] * tyz
              + projector[0][2] * txz);
}

struct CaseInput {
  std::string name;
  std::uint8_t expected_active{0};
  RegionParams region{};
  Vec6 stress_committed{};
  Vec6 strain_committed{};
  Vec6 strain_trial{};
  MaterialPoint::HsState state{};
};

double cone_zero_gamma_p(double sigma_v, double K0, const RegionParams& r) {
  const double c = r.cEff;
  const double phi = r.phi;
  const double sphi = std::sin(phi);
  const double cphi = std::cos(phi);
  const double sigma3 = K0 * sigma_v;
  const double num = std::max(c * cphi + sigma3 * sphi, 0.5);
  const double den = std::max(c * cphi + r.hs.p_ref * sphi, 0.5);
  const double ratio = std::pow(num / den, r.hs.m);
  const double E50 = r.hs.E50_ref * ratio;
  const double Eur = r.hs.Eur_ref * ratio;
  const double Ei = 2.0 * E50 / (2.0 - r.hs.Rf);
  const double sphi_safe = std::max(sphi, 1e-6);
  const double qf = (c * hs::cot_safe(phi) + sigma3) * 2.0 * sphi_safe
                  / std::max(1.0 - sphi_safe, 1e-9);
  const double qa = std::max(qf / r.hs.Rf, 1.0);
  const double q = sigma_v - sigma3;
  const double q_clamped = std::min(q, 0.999 * qa);
  const double denom = std::max(1.0 - q_clamped / qa, 1e-3);
  return (2.0 / Ei) * q_clamped / denom - 2.0 * q / Eur;
}

double nc_pp(double M_cap, double q_tilde, double p_prime, double p_t) {
  const double rhs = (q_tilde * q_tilde) / (M_cap * M_cap)
                   + (p_prime + p_t) * (p_prime + p_t);
  return std::max(std::sqrt(std::max(rhs, 0.0)) - p_t, 1e-6);
}

double hs_power_law(double E_ref, double sigma_relevant,
                    double c_eff, double phi_eff,
                    const RegionParams& r) {
  return hs::power_law_stiffness(
      E_ref, sigma_relevant, c_eff, phi_eff, r.hs.p_ref, r.hs.m);
}

double qa_from_sigma3(double sigma3,
                      double c_eff,
                      double phi_eff,
                      double Rf) {
  double sinPhi = std::sin(phi_eff);
  if (sinPhi < 1e-6) sinPhi = 1e-6;
  const double qf = (c_eff * hs::cot_safe(phi_eff) + sigma3) * 2.0 * sinPhi
                  / std::max(1.0 - sinPhi, 1e-9);
  return std::max(qf / std::max(Rf, 1e-6), 1.0);
}

CaseInput elastic_case() {
  CaseInput c{};
  c.name = "elastic";
  c.expected_active = 0;
  c.region = default_region();
  c.stress_committed = hydrostatic_stress(50.0);
  c.strain_committed = zero6();
  c.strain_trial = zero6();
  c.strain_trial[V_XX] = -1e-5;
  c.strain_trial[V_YY] = -1e-5;
  c.state.gamma_p = 1e-3;
  c.state.p_p = 500.0;
  c.state.eps_v_p = 0.0;
  c.state.lastActiveSet = 0;
  return c;
}

CaseInput cone_case() {
  CaseInput c{};
  c.name = "cone";
  c.expected_active = 1;
  c.region = default_region();
  c.region.psi = 20.0 * kPi / 180.0;
  const double sigma3 = 80.0;
  const double sigma_int = 120.0;
  const double q_target = 80.0;
  c.stress_committed = Vec6{-sigma3, -(sigma3 + q_target), -sigma_int, 0, 0, 0};
  c.strain_committed = zero6();
  c.strain_trial = zero6();
  c.strain_trial[V_YY] = -1e-5;

  const double num = std::max(c.region.cEff * std::cos(c.region.phi) +
                                  sigma3 * std::sin(c.region.phi),
                              0.5);
  const double den = std::max(c.region.cEff * std::cos(c.region.phi) +
                                  c.region.hs.p_ref * std::sin(c.region.phi),
                              0.5);
  const double ratio = std::pow(num / den, c.region.hs.m);
  const double E50 = c.region.hs.E50_ref * ratio;
  const double Eur = c.region.hs.Eur_ref * ratio;
  const double Ei = 2.0 * E50 / (2.0 - c.region.hs.Rf);
  const double qf = (c.region.cEff * hs::cot_safe(c.region.phi) + sigma3)
                  * 2.0 * std::sin(c.region.phi)
                  / std::max(1.0 - std::sin(c.region.phi), 1e-9);
  const double qa = qf / c.region.hs.Rf;
  const double q_clamped = std::min(q_target, 0.999 * qa);
  const double denom_q = std::max(1.0 - q_clamped / qa, 1e-3);
  c.state.gamma_p = (2.0 / Ei) * q_clamped / denom_q - 2.0 * q_target / Eur;
  c.state.p_p = 5.0 * sigma3;
  c.state.eps_v_p = 0.0;
  c.state.lastActiveSet = 1;
  return c;
}

CaseInput cap_case() {
  CaseInput c{};
  c.name = "cap";
  c.expected_active = 2;
  c.region = default_region();
  const double sigma_v = 100.0;
  const double K0 = 0.5;
  const double sigma_h_xx = K0 * sigma_v;
  const double sigma_h_zz = K0 * sigma_v + 5.0;
  c.stress_committed = Vec6{-sigma_h_xx, -sigma_v, -sigma_h_zz, 0, 0, 0};
  c.strain_committed = zero6();
  c.strain_trial = zero6();
  c.strain_trial[V_YY] = -1e-4;
  c.state.gamma_p = std::max(
      cone_zero_gamma_p(sigma_v, K0, c.region) + 0.5, 0.5);
  const double sphi = std::sin(c.region.phi);
  const double delta_w = (3.0 + sphi) / (3.0 - sphi);
  const double s1 = sigma_v;
  const double s2 = sigma_h_zz;
  const double s3 = sigma_h_xx;
  const double q_tilde = s1 + (delta_w - 1.0) * s2 - delta_w * s3;
  const double p_prime = (s1 + s2 + s3) / 3.0;
  const double p_t = hs::tensile_shift_p_t(c.region.cEff, c.region.phi);
  c.state.p_p = nc_pp(c.region.hs.M_cap, q_tilde, p_prime, p_t);
  c.state.eps_v_p = 0.0;
  c.state.lastActiveSet = 2;
  return c;
}

CaseInput corner_case() {
  CaseInput c{};
  c.name = "corner";
  c.expected_active = 3;
  c.region = default_region();
  const double sigma_v = 100.0;
  const double K0 = 0.5;
  const double sigma_h_xx = K0 * sigma_v;
  const double sigma_h_zz = K0 * sigma_v + 5.0;
  c.stress_committed = Vec6{-sigma_h_xx, -sigma_v, -sigma_h_zz, 0, 0, 0};
  c.strain_committed = zero6();
  c.strain_trial = zero6();
  c.strain_trial[V_YY] = -1e-4;
  c.state.gamma_p = std::max(cone_zero_gamma_p(sigma_v, K0, c.region), 0.0);
  const double sphi = std::sin(c.region.phi);
  const double delta_w = (3.0 + sphi) / (3.0 - sphi);
  const double s1 = sigma_v;
  const double s2 = sigma_h_zz;
  const double s3 = sigma_h_xx;
  const double q_tilde = s1 + (delta_w - 1.0) * s2 - delta_w * s3;
  const double p_prime = (s1 + s2 + s3) / 3.0;
  const double p_t = hs::tensile_shift_p_t(c.region.cEff, c.region.phi);
  c.state.p_p = nc_pp(c.region.hs.M_cap, q_tilde, p_prime, p_t);
  c.state.eps_v_p = 0.0;
  c.state.lastActiveSet = 3;
  return c;
}

struct OracleContext {
  CaseInput c;
  Mat6 D_e{};
  Vec6 sigma_trial{};
  mce::MaterialParameters mp_eig{};
  hs::ConeFlowRegime cone_regime{hs::ConeFlowRegime::Face13};
  double c_eff{0.0};
  double phi_eff{0.0};
  double psi_eff{0.0};
  double sin_phi_cv{0.0};
  double p_t{0.0};
  double M_cap{0.0};
  double H_cap{0.0};
};

OracleContext make_context(const CaseInput& c, const Vec6& strain_trial) {
  OracleContext ctx{};
  ctx.c = c;
  ctx.c.strain_trial = strain_trial;
  ctx.c_eff = std::max(c.region.cEff, 0.0);
  ctx.phi_eff = std::max(c.region.phi, 0.0);
  ctx.psi_eff = std::min(std::max(c.region.psi, 0.0), ctx.phi_eff);
  ctx.sin_phi_cv = hs::critical_state_sin_phi_cv(ctx.phi_eff, ctx.psi_eff);
  ctx.p_t = hs::tensile_shift_p_t(ctx.c_eff, ctx.phi_eff);
  ctx.M_cap = std::max(c.region.hs.M_cap, 1e-6);
  ctx.H_cap = std::max(c.region.hs.H_cap, 1.0);
  ctx.mp_eig = hs::make_mp_for_eig(c.region, ctx.c_eff, ctx.phi_eff);
  const auto principalC =
      mce::principal_stress_projectors_3d_compression_positive(
          c.stress_committed, ctx.mp_eig);
  const double E_ur = hs_power_law(
      c.region.hs.Eur_ref, principalC.s3, ctx.c_eff, ctx.phi_eff, c.region);
  ctx.D_e = hs::elastic_tangent_voigt(E_ur, c.region.hs.nu_ur);
  const Vec6 dEps = lng::sub(strain_trial, c.strain_committed);
  ctx.sigma_trial = lng::add(c.stress_committed, lng::mul6x6(ctx.D_e, dEps));
  const auto principalT =
      mce::principal_stress_projectors_3d_compression_positive(
          ctx.sigma_trial, ctx.mp_eig);
  ctx.cone_regime = hs::classify_cone_regime(principalT);
  return ctx;
}

Vec6 flow_cone_eng(const OracleContext& ctx,
                   const mce::PrincipalState& pr,
                   double s1, double s3, double eps_v_p) {
  const double sin_phi_mob =
      hs::mobilised_sin_phi(s1, s3, ctx.c_eff, ctx.phi_eff);
  const double eps_v_p_max =
      hs::dilatancy_cutoff_threshold(ctx.c.region.hs.e_init,
                                     ctx.c.region.hs.e_max);
  const double sin_psi =
      hs::mobilised_sin_psi(sin_phi_mob, ctx.sin_phi_cv, ctx.psi_eff,
                            eps_v_p, eps_v_p_max);
  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  hs::cone_flow_gradient(ctx.cone_regime, sin_psi, m1, m2, m3);
  return sht::strain_vector_from_flow_tensor(
      hs::lift_principal_gradient_to_tensor_voigt(pr, m1, m2, m3));
}

Vec6 flow_cap_eng(const OracleContext& ctx,
                  const mce::PrincipalState& pr,
                  double s1, double s2, double s3, double p_p) {
  double n1 = 0.0, n2 = 0.0, n3 = 0.0, df_dpp = 0.0;
  hs::cap_yield_gradient(s1, s2, s3, p_p, ctx.M_cap, ctx.p_t,
                         ctx.phi_eff, n1, n2, n3, df_dpp);
  return sht::strain_vector_from_flow_tensor(
      hs::lift_principal_gradient_to_tensor_voigt(pr, n1, n2, n3));
}

std::vector<double> residual(const OracleContext& ctx,
                             std::uint8_t active,
                             const std::vector<double>& y,
                             const Vec6& strain_trial) {
  OracleContext local = make_context(ctx.c, strain_trial);
  // The production HS return map direction-locks all spectral operations to
  // the trial-stress eigenbasis. Freeze the cone-flow regime as part of the
  // active set, but let the trial projectors vary with the strain probe.
  local.cone_regime = ctx.cone_regime;
  Vec6 sigma{};
  for (int i = 0; i < 6; ++i) sigma[i] = y[static_cast<std::size_t>(i)];
  const auto pr =
      mce::principal_stress_projectors_3d_compression_positive(
          local.sigma_trial, local.mp_eig);
  const double s1 = compression_component_in_projector(sigma, pr.P1);
  const double s2 = compression_component_in_projector(sigma, pr.P2);
  const double s3 = compression_component_in_projector(sigma, pr.P3);
  const double Rf = std::clamp(local.c.region.hs.Rf, 1e-3, 0.999);
  std::vector<double> F;

  if (active == 1) {
    const double gamma = y[6];
    const double dl_s = y[7];
    const Vec6 m_s = flow_cone_eng(local, pr, s1, s3, local.c.state.eps_v_p);
    const Vec6 De_m_s = lng::mul6x6(local.D_e, m_s);
    F.resize(8);
    for (int i = 0; i < 6; ++i) {
      F[i] = sigma[i] - local.sigma_trial[i] + dl_s * De_m_s[i];
    }
    F[6] = gamma - local.c.state.gamma_p - dl_s;
    const double E50 = hs_power_law(
        local.c.region.hs.E50_ref, s3, local.c_eff, local.phi_eff,
        local.c.region);
    const double Eur = hs_power_law(
        local.c.region.hs.Eur_ref, s3, local.c_eff, local.phi_eff,
        local.c.region);
    const double Ei = 2.0 * E50 / (2.0 - Rf);
    const double qa = qa_from_sigma3(s3, local.c_eff, local.phi_eff, Rf);
    F[7] = hs::cone_yield_value(s1 - s3, qa, Ei, Eur, gamma);
    return F;
  }

  if (active == 2) {
    const double pp = y[6];
    const double dl_c = y[7];
    const Vec6 m_c = flow_cap_eng(local, pr, s1, s2, s3, pp);
    const Vec6 De_m_c = lng::mul6x6(local.D_e, m_c);
    F.resize(8);
    for (int i = 0; i < 6; ++i) {
      F[i] = sigma[i] - local.sigma_trial[i] + dl_c * De_m_c[i];
    }
    const double p_prime = (s1 + s2 + s3) / 3.0;
    F[6] = pp - local.c.state.p_p
         - dl_c * hs::cap_hardening_rate(local.H_cap, p_prime, local.p_t);
    F[7] = hs::cap_yield_value(
        s1, s2, s3, pp, local.M_cap, local.p_t, local.phi_eff);
    return F;
  }

  if (active == 3) {
    const double gamma = y[6];
    const double pp = y[7];
    const double dl_s = y[8];
    const double dl_c = y[9];
    const Vec6 m_s = flow_cone_eng(local, pr, s1, s3, local.c.state.eps_v_p);
    const Vec6 m_c = flow_cap_eng(local, pr, s1, s2, s3, pp);
    const Vec6 De_m_s = lng::mul6x6(local.D_e, m_s);
    const Vec6 De_m_c = lng::mul6x6(local.D_e, m_c);
    F.resize(10);
    for (int i = 0; i < 6; ++i) {
      F[i] = sigma[i] - local.sigma_trial[i]
           + dl_s * De_m_s[i] + dl_c * De_m_c[i];
    }
    const double p_prime = (s1 + s2 + s3) / 3.0;
    F[6] = gamma - local.c.state.gamma_p - dl_s;
    F[7] = pp - local.c.state.p_p
         - dl_c * hs::cap_hardening_rate(local.H_cap, p_prime, local.p_t);
    const double E50 = hs_power_law(
        local.c.region.hs.E50_ref, s3, local.c_eff, local.phi_eff,
        local.c.region);
    const double Eur = hs_power_law(
        local.c.region.hs.Eur_ref, s3, local.c_eff, local.phi_eff,
        local.c.region);
    const double Ei = 2.0 * E50 / (2.0 - Rf);
    const double qa = qa_from_sigma3(s3, local.c_eff, local.phi_eff, Rf);
    F[8] = hs::cone_yield_value(s1 - s3, qa, Ei, Eur, gamma);
    F[9] = hs::cap_yield_value(
        s1, s2, s3, pp, local.M_cap, local.p_t, local.phi_eff);
    return F;
  }

  throw std::runtime_error("unsupported active set in residual oracle");
}

std::vector<double> make_y(const OracleContext& ctx,
                           const hs::HsUpdateResult& res) {
  std::vector<double> y;
  const std::uint8_t a = res.activeSurface;
  if (a == 1) {
    y.resize(8);
    for (int i = 0; i < 6; ++i) y[i] = res.stressUpdated[i];
    y[6] = res.stateUpdated.gamma_p;
    y[7] = std::max(res.stateUpdated.gamma_p - ctx.c.state.gamma_p, 0.0);
    return y;
  }
  if (a == 2) {
    y.resize(8);
    for (int i = 0; i < 6; ++i) y[i] = res.stressUpdated[i];
    const auto pr =
        mce::principal_stress_projectors_3d_compression_positive(
            res.stressUpdated, ctx.mp_eig);
    const double p_prime = (pr.s1 + pr.s2 + pr.s3) / 3.0;
    const double rate = hs::cap_hardening_rate(ctx.H_cap, p_prime, ctx.p_t);
    y[6] = res.stateUpdated.p_p;
    y[7] = (std::abs(rate) > 1e-14)
        ? std::max((res.stateUpdated.p_p - ctx.c.state.p_p) / rate, 0.0)
        : 0.0;
    return y;
  }
  if (a == 3) {
    y.resize(10);
    for (int i = 0; i < 6; ++i) y[i] = res.stressUpdated[i];
    const auto pr =
        mce::principal_stress_projectors_3d_compression_positive(
            res.stressUpdated, ctx.mp_eig);
    const double p_prime = (pr.s1 + pr.s2 + pr.s3) / 3.0;
    const double rate = hs::cap_hardening_rate(ctx.H_cap, p_prime, ctx.p_t);
    y[6] = res.stateUpdated.gamma_p;
    y[7] = res.stateUpdated.p_p;
    y[8] = std::max(res.stateUpdated.gamma_p - ctx.c.state.gamma_p, 0.0);
    y[9] = (std::abs(rate) > 1e-14)
        ? std::max((res.stateUpdated.p_p - ctx.c.state.p_p) / rate, 0.0)
        : 0.0;
    return y;
  }
  throw std::runtime_error("make_y only supports plastic active sets");
}

std::vector<std::vector<double>> invert_solve(
    std::vector<std::vector<double>> A,
    std::vector<std::vector<double>> B) {
  const int n = static_cast<int>(A.size());
  const int m = static_cast<int>(B[0].size());
  for (int k = 0; k < n; ++k) {
    int piv = k;
    double best = std::abs(A[k][k]);
    for (int i = k + 1; i < n; ++i) {
      const double v = std::abs(A[i][k]);
      if (v > best) {
        best = v;
        piv = i;
      }
    }
    require(best > 1e-14, "singular residual Jacobian");
    if (piv != k) {
      std::swap(A[piv], A[k]);
      std::swap(B[piv], B[k]);
    }
    const double diag = A[k][k];
    for (int j = k; j < n; ++j) A[k][j] /= diag;
    for (int j = 0; j < m; ++j) B[k][j] /= diag;
    for (int i = 0; i < n; ++i) {
      if (i == k) continue;
      const double f = A[i][k];
      if (f == 0.0) continue;
      for (int j = k; j < n; ++j) A[i][j] -= f * A[k][j];
      for (int j = 0; j < m; ++j) B[i][j] -= f * B[k][j];
    }
  }
  return B;
}

std::array<std::array<double, 3>, 6> residual_oracle_tangent(
    const OracleContext& ctx,
    const hs::HsUpdateResult& res) {
  const std::uint8_t active = res.activeSurface;
  std::vector<double> y0 = make_y(ctx, res);
  const int n = static_cast<int>(y0.size());
  const std::vector<double> F0 = residual(ctx, active, y0, ctx.c.strain_trial);
  require(static_cast<int>(F0.size()) == n, "residual size mismatch");
  double rnorm = 0.0;
  for (double v : F0) rnorm += v * v;
  rnorm = std::sqrt(rnorm);
  double yscale = 0.0;
  for (double v : y0) yscale += v * v;
  yscale = std::max(std::sqrt(yscale), 1.0);
  const double residual_tol = 1e-6 * yscale;
  if (!(rnorm < residual_tol)) {
    std::ostringstream oss;
    oss << "base residual is not near zero for " << ctx.c.name
        << " rnorm=" << std::scientific << rnorm
        << " tol=" << residual_tol << " F=[";
    for (std::size_t i = 0; i < F0.size(); ++i) {
      if (i) oss << ", ";
      oss << F0[i];
    }
    oss << "]";
    throw std::runtime_error(oss.str());
  }

  std::vector<std::vector<double>> Jy(n, std::vector<double>(n, 0.0));
  for (int j = 0; j < n; ++j) {
    const double scale = j < 6 ? std::max(std::abs(y0[j]), 1.0)
                               : std::max(std::abs(y0[j]), 1e-3);
    const double h = (j < 6 ? 1e-7 : 1e-7) * scale;
    std::vector<double> yp = y0, ym = y0;
    yp[j] += h;
    ym[j] -= h;
    const std::vector<double> Fp = residual(ctx, active, yp, ctx.c.strain_trial);
    const std::vector<double> Fm = residual(ctx, active, ym, ctx.c.strain_trial);
    for (int i = 0; i < n; ++i) Jy[i][j] = (Fp[i] - Fm[i]) / (2.0 * h);
  }

  std::vector<std::vector<double>> rhs(n, std::vector<double>(3, 0.0));
  const double strain_mag = std::max({
      std::abs(ctx.c.strain_trial[V_XX]),
      std::abs(ctx.c.strain_trial[V_YY]),
      std::abs(ctx.c.strain_trial[V_XY]),
      1e-5});
  const double heps = std::max(1e-3 * strain_mag, 1e-8);
  for (int ccol = 0; ccol < 3; ++ccol) {
    Vec6 ep = ctx.c.strain_trial;
    Vec6 em = ctx.c.strain_trial;
    ep[kInPlane[ccol]] += heps;
    em[kInPlane[ccol]] -= heps;
    const std::vector<double> Fp = residual(ctx, active, y0, ep);
    const std::vector<double> Fm = residual(ctx, active, y0, em);
    for (int i = 0; i < n; ++i) {
      const double J_eps = (Fp[i] - Fm[i]) / (2.0 * heps);
      rhs[i][ccol] = -J_eps;
    }
  }

  const auto dy = invert_solve(Jy, rhs);
  std::array<std::array<double, 3>, 6> D{};
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 3; ++j) D[i][j] = dy[i][j];
  }
  return D;
}

hs::HsUpdateResult run_update(const CaseInput& c, const Vec6& strain_trial) {
  return hs::update_plane_strain(
      strain_trial, c.strain_committed, c.stress_committed,
      c.state, c.region, 1.0);
}

std::array<std::array<double, 3>, 6> direct_fd_tangent(
    const CaseInput& c,
    const hs::HsUpdateResult& base) {
  std::array<std::array<double, 3>, 6> D{};
  const double strain_mag = std::max({
      std::abs(c.strain_trial[V_XX]),
      std::abs(c.strain_trial[V_YY]),
      std::abs(c.strain_trial[V_XY]),
      1e-5});
  const double h = std::max(1e-3 * strain_mag, 1e-8);
  for (int col = 0; col < 3; ++col) {
    Vec6 ep = c.strain_trial;
    Vec6 em = c.strain_trial;
    ep[kInPlane[col]] += h;
    em[kInPlane[col]] -= h;
    const auto rp = run_update(c, ep);
    const auto rm = run_update(c, em);
    require(rp.failureCode == 0 && rm.failureCode == 0,
            c.name + " direct FD probe failed");
    require(rp.activeSurface == base.activeSurface &&
            rm.activeSurface == base.activeSurface,
            c.name + " direct FD probe changed active set");
    require(rp.stateUpdated.lastActiveSet == base.stateUpdated.lastActiveSet &&
            rm.stateUpdated.lastActiveSet == base.stateUpdated.lastActiveSet,
            c.name + " direct FD probe changed lastActiveSet branch");
    for (int i = 0; i < 6; ++i) {
      D[i][col] = (rp.stressUpdated[i] - rm.stressUpdated[i]) / (2.0 * h);
    }
  }
  return D;
}

double relerr_inplane(const std::array<std::array<double, 3>, 6>& A,
                      const std::array<std::array<double, 3>, 6>& B) {
  double num = 0.0, den = 0.0;
  for (int rr = 0; rr < 3; ++rr) {
    const int i = static_cast<int>(kInPlane[rr]);
    for (int j = 0; j < 3; ++j) {
      const double d = A[i][j] - B[i][j];
      num += d * d;
      den += B[i][j] * B[i][j];
    }
  }
  return std::sqrt(num) / std::max(std::sqrt(den), 1.0);
}

void run_case(const CaseInput& c) {
  const auto base = run_update(c, c.strain_trial);
  require(base.failureCode == 0, c.name + " base update failed");
  require(base.activeSurface == c.expected_active,
          c.name + " active set mismatch");
  if (c.expected_active == 0) {
    OracleContext ctx = make_context(c, c.strain_trial);
    Mat6 De = ctx.D_e;
    const auto fd = direct_fd_tangent(c, base);
    double num = 0.0, den = 0.0;
    for (int rr = 0; rr < 3; ++rr) {
      const int i = static_cast<int>(kInPlane[rr]);
      for (int cc = 0; cc < 3; ++cc) {
        const int j = static_cast<int>(kInPlane[cc]);
        const double d = De[i][j] - fd[i][cc];
        num += d * d;
        den += fd[i][cc] * fd[i][cc];
      }
    }
    const double rel = std::sqrt(num) / std::max(std::sqrt(den), 1.0);
    std::cout << "  [" << c.name << "] active=0 relErr="
              << std::scientific << rel << "\n";
    require(rel < 1e-6, c.name + " elastic tangent mismatch");
    return;
  }

  OracleContext ctx = make_context(c, c.strain_trial);
  const auto D_oracle = residual_oracle_tangent(ctx, base);
  const auto D_fd = direct_fd_tangent(c, base);
  const double rel = relerr_inplane(D_oracle, D_fd);
  std::cout << "  [" << c.name << "] active=" << int(c.expected_active)
            << " relErr=" << std::scientific << rel << "\n";
  if (!(rel < 1e-4)) {
    std::cout << "    oracle 3x3 / direct-FD 3x3:\n";
    for (int rr = 0; rr < 3; ++rr) {
      const int i = static_cast<int>(kInPlane[rr]);
      std::cout << "      row " << i << "  O=[";
      for (int cc = 0; cc < 3; ++cc) {
        if (cc) std::cout << ", ";
        std::cout << D_oracle[i][cc];
      }
      std::cout << "]  FD=[";
      for (int cc = 0; cc < 3; ++cc) {
        if (cc) std::cout << ", ";
        std::cout << D_fd[i][cc];
      }
      std::cout << "]\n";
    }
    throw std::runtime_error(c.name + " residual oracle mismatch");
  }
}

}  // namespace sh0

int main() {
  try {
    sh0::test_voigt_dual_helpers();
    sh0::test_xi_dense_helpers();
    std::cout << "HS SH-0 residual-sensitivity oracle:\n";
    sh0::run_case(sh0::elastic_case());
    sh0::run_case(sh0::cone_case());
    sh0::run_case(sh0::cap_case());
    sh0::run_case(sh0::corner_case());
    std::cout << "HS SH-0 residual-sensitivity oracle PASSED.\n";
    return 0;
  } catch (const std::exception& ex) {
    std::cerr << "FAIL: " << ex.what() << "\n";
    return 1;
  }
}
