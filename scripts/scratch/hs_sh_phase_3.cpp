// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-3 cap Simo-Hughes tangent verifier.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "material_hs_tangent.hpp"

namespace sh3 {

using madep::Mat6;
using madep::MaterialPoint;
using madep::RegionParams;
using madep::Vec6;
using madep::V_XX;
using madep::V_YY;
using madep::V_XY;
namespace hs = madep::material::hs;
namespace sht = madep::material::hs::tangent;
namespace lng = madep::linalg;
namespace mce = madep::mc_exact;

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr int kPlane[3] = {static_cast<int>(V_XX), static_cast<int>(V_YY), static_cast<int>(V_XY)};

void require(bool ok, const std::string& msg) {
  if (!ok) throw std::runtime_error(msg);
}

RegionParams default_region() {
  RegionParams r{};
  r.Emc = 300.0;
  r.nu = 0.3;
  r.cEff = 0.1;
  r.phi = 30.0 * kPi / 180.0;
  r.psi = 0.0;
  r.K0nc = 0.5;
  r.gamma = 18.0;
  r.gammaSat = 20.0;
  r.rShear = 0.25;
  r.useTensionCutoff = 0;
  r.symmetrize = 0;
  r.hs.E50_ref = 300.0;
  r.hs.Eoed_ref = 300.0;
  r.hs.Eur_ref = 900.0;
  r.hs.m = 0.5;
  r.hs.nu_ur = 0.2;
  r.hs.p_ref = 100.0;
  r.hs.Rf = 0.9;
  r.hs.K0_nc = 0.0;
  r.hs.e_init = -1.0;
  r.hs.e_max = -1.0;
  r.hs.OCR = 1.0;
  hs::compute_hs_reference_constants(r, 1.0);
  r.hs.H_cap = 1.0;
  return r;
}

double compression_component_in_projector(const Vec6& stress_tension,
                                          const madep::js_mirror::Mat3& P) {
  return -P[0][0] * stress_tension[V_XX]
       - P[1][1] * stress_tension[V_YY]
       - P[2][2] * stress_tension[madep::V_ZZ]
       - 2.0 * (P[0][1] * stress_tension[V_XY]
              + P[1][2] * stress_tension[madep::V_YZ]
              + P[0][2] * stress_tension[madep::V_XZ]);
}

double relerr_inplane(const Mat6& A, const Mat6& B) {
  double num = 0.0;
  double den = 0.0;
  for (int r = 0; r < 3; ++r) {
    for (int c = 0; c < 3; ++c) {
      const double d = A[kPlane[r]][kPlane[c]] - B[kPlane[r]][kPlane[c]];
      num += d * d;
      den += B[kPlane[r]][kPlane[c]] * B[kPlane[r]][kPlane[c]];
    }
  }
  return std::sqrt(num) / std::max(std::sqrt(den), 1.0);
}

double nc_pp(double M_cap,
             double q_tilde,
             double p_prime,
             double p_t) {
  const double rhs = (q_tilde * q_tilde) / (M_cap * M_cap)
                   + (p_prime + p_t) * (p_prime + p_t);
  return std::max(std::sqrt(std::max(rhs, 0.0)) - p_t, 1e-6);
}

double cone_zero_gamma_p(double sigma_v, double K0, const RegionParams& r) {
  const double sigma3 = K0 * sigma_v;
  const double E50 = hs::power_law_stiffness(
      r.hs.E50_ref, hs::effective_confining_stress(sigma3, r.hs),
      r.cEff, r.phi, r.hs.p_ref, r.hs.m);
  const double Eur = hs::power_law_stiffness(
      r.hs.Eur_ref, hs::effective_confining_stress(sigma3, r.hs),
      r.cEff, r.phi, r.hs.p_ref, r.hs.m);
  const double Ei = 2.0 * E50 / (2.0 - r.hs.Rf);
  const double qa = hs::hs_q_a_from_sigma3(
      sigma3, r.cEff, r.phi, r.hs.Rf, r.hs);
  const double q = sigma_v - sigma3;
  const double q_clamped = std::min(q, 0.999 * qa);
  const double denom = std::max(1.0 - q_clamped / qa, 1e-3);
  return (2.0 / Ei) * q_clamped / denom - 2.0 * q / Eur;
}

Vec6 cap_flow_eng_locked(const mce::PrincipalState& pr,
                         double s1,
                         double s2,
                         double s3,
                         double p_p,
                         const RegionParams& r) {
  double m1 = 0.0, m2 = 0.0, m3 = 0.0, dpp = 0.0;
  hs::cap_yield_gradient(
      s1, s2, s3, p_p, r.hs.M_cap,
      hs::tensile_shift_p_t(r.cEff, r.phi),
      r.phi, m1, m2, m3, dpp);
  const Vec6 m_t = hs::lift_principal_gradient_to_tensor_voigt(
      pr, m1, m2, m3);
  return hs::tensor_voigt_to_engineering(m_t);
}

std::vector<double> cap_residual_locked(
    const std::vector<double>& y,
    const Vec6& strain_trial,
    const Vec6& strain_committed,
    const Vec6& stress_committed,
    const MaterialPoint::HsState& state,
    const RegionParams& r,
    const Mat6& D_e) {
  const auto mp = hs::make_mp_for_eig(r, r.cEff, r.phi);
  const Vec6 sigma_trial = lng::add(
      stress_committed, lng::mul6x6(D_e, lng::sub(strain_trial, strain_committed)));
  const auto pr = mce::principal_stress_projectors_3d_compression_positive(
      sigma_trial, mp);
  Vec6 sigma{};
  for (int i = 0; i < 6; ++i) sigma[i] = y[static_cast<std::size_t>(i)];
  const double s1 = compression_component_in_projector(sigma, pr.P1);
  const double s2 = compression_component_in_projector(sigma, pr.P2);
  const double s3 = compression_component_in_projector(sigma, pr.P3);
  const double p_p = y[6];
  const double dlambda = y[7];
  const double p_t = hs::tensile_shift_p_t(r.cEff, r.phi);
  const Vec6 m = cap_flow_eng_locked(pr, s1, s2, s3, p_p, r);
  const Vec6 De_m = lng::mul6x6(D_e, m);

  std::vector<double> F(8, 0.0);
  for (int i = 0; i < 6; ++i) {
    F[static_cast<std::size_t>(i)] =
        sigma[i] - sigma_trial[i] + dlambda * De_m[i];
  }
  const double p_prime = (s1 + s2 + s3) / 3.0;
  F[6] = p_p - state.p_p
       - dlambda * hs::cap_hardening_rate(r.hs.H_cap, p_prime, p_t);
  F[7] = hs::cap_yield_value(s1, s2, s3, p_p, r.hs.M_cap, p_t, r.phi);
  return F;
}

std::vector<std::vector<double>> solve_dense(
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

Mat6 residual_oracle_cap_tangent(
    const Vec6& strain_trial,
    const Vec6& strain_committed,
    const Vec6& stress_committed,
    const MaterialPoint::HsState& state,
    const RegionParams& r,
    const Mat6& D_e,
    const hs::HsUpdateResult& res) {
  std::vector<double> y0(8, 0.0);
  for (int i = 0; i < 6; ++i) y0[static_cast<std::size_t>(i)] = res.stressUpdated[i];
  y0[6] = res.stateUpdated.p_p;
  y0[7] = res.activeDlambdaC;
  const auto F0 = cap_residual_locked(
      y0, strain_trial, strain_committed, stress_committed,
      state, r, D_e);
  double rnorm = 0.0;
  for (double v : F0) rnorm += v * v;
  const double pp_scale = std::max(res.stateUpdated.p_p + hs::tensile_shift_p_t(r.cEff, r.phi), 1.0);
  require(std::sqrt(rnorm) < 1e-6 * pp_scale * pp_scale,
          "cap residual oracle base state is not converged");

  constexpr int n = 8;
  std::vector<std::vector<double>> Jy(n, std::vector<double>(n, 0.0));
  for (int j = 0; j < n; ++j) {
    const double scale = j < 6 ? std::max(std::abs(y0[j]), 1.0)
                               : std::max(std::abs(y0[j]), 1e-3);
    const double h = 1e-7 * scale;
    std::vector<double> yp = y0;
    std::vector<double> ym = y0;
    yp[j] += h;
    ym[j] -= h;
    const auto Fp = cap_residual_locked(
        yp, strain_trial, strain_committed, stress_committed, state, r, D_e);
    const auto Fm = cap_residual_locked(
        ym, strain_trial, strain_committed, stress_committed, state, r, D_e);
    for (int i = 0; i < n; ++i) Jy[i][j] = (Fp[i] - Fm[i]) / (2.0 * h);
  }

  std::vector<std::vector<double>> rhs(n, std::vector<double>(3, 0.0));
  const double strain_mag = std::max({
      std::abs(strain_trial[V_XX]), std::abs(strain_trial[V_YY]),
      std::abs(strain_trial[V_XY]), 1e-5});
  const double heps = std::max(1e-3 * strain_mag, 1e-8);
  for (int col = 0; col < 3; ++col) {
    Vec6 ep = strain_trial;
    Vec6 em = strain_trial;
    ep[kPlane[col]] += heps;
    em[kPlane[col]] -= heps;
    const auto Fp = cap_residual_locked(
        y0, ep, strain_committed, stress_committed, state, r, D_e);
    const auto Fm = cap_residual_locked(
        y0, em, strain_committed, stress_committed, state, r, D_e);
    for (int i = 0; i < n; ++i) {
      rhs[i][col] = -(Fp[i] - Fm[i]) / (2.0 * heps);
    }
  }

  const auto dy = solve_dense(Jy, rhs);
  Mat6 D_oracle = D_e;
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 3; ++j) D_oracle[i][kPlane[j]] = dy[i][j];
  }
  return D_oracle;
}

void run_cap_case() {
  RegionParams r = default_region();
  const double sigma_v = 100.0;
  const double K0 = 0.5;
  const double sigma_h_xx = K0 * sigma_v;
  const double sigma_h_zz = K0 * sigma_v + 5.0;
  Vec6 stress_committed{-sigma_h_xx, -sigma_v, -sigma_h_zz, 0.0, 0.0, 0.0};
  Vec6 strain_committed{0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  Vec6 strain_trial = strain_committed;
  strain_trial[V_YY] = -1.0e-4;
  strain_trial[V_XY] = 1.0e-5;

  MaterialPoint::HsState state{};
  state.gamma_p = std::max(cone_zero_gamma_p(sigma_v, K0, r) + 0.5, 0.5);
  double dq1 = 0.0, dq2 = 0.0, dq3 = 0.0;
  sht::compute_cap_qtilde_gradient(
      sigma_v, sigma_h_zz, sigma_h_xx, r.phi, dq1, dq2, dq3);
  const double q_tilde = dq1 * sigma_v + dq2 * sigma_h_zz + dq3 * sigma_h_xx;
  const double p_prime = (sigma_v + sigma_h_zz + sigma_h_xx) / 3.0;
  const double p_t = hs::tensile_shift_p_t(r.cEff, r.phi);
  state.p_p = nc_pp(r.hs.M_cap, q_tilde, p_prime, p_t);
  state.eps_v_p = 0.0;
  state.lastActiveSet = 2;

  const auto mp = hs::make_mp_for_eig(r, r.cEff, r.phi);
  const auto principalC =
      mce::principal_stress_projectors_3d_compression_positive(
          stress_committed, mp);
  const double E_ur = hs::power_law_stiffness(
      r.hs.Eur_ref,
      hs::effective_confining_stress(principalC.s3, r.hs),
      r.cEff, r.phi, r.hs.p_ref, r.hs.m);
  const Mat6 D_e = hs::elastic_tangent_voigt(E_ur, r.hs.nu_ur);
  const Vec6 sigma_trial = lng::add(
      stress_committed, lng::mul6x6(D_e, lng::sub(strain_trial, strain_committed)));
  const auto principalT =
      mce::principal_stress_projectors_3d_compression_positive(
          sigma_trial, mp);

  const hs::HsUpdateResult res = hs::update_plane_strain(
      strain_trial, strain_committed, stress_committed, state, r, 1.0);
  require(res.failureCode == 0, "cap update failed");
  require(res.stateUpdated.lastActiveSet == 2, "case did not stay cap-active");
  require(res.activeDlambdaC > 0.0, "cap return did not expose dlambda_c");
  std::cout << "  active=" << static_cast<int>(res.stateUpdated.lastActiveSet)
            << " tangentMode=" << static_cast<int>(res.tangentMode)
            << " dlambda=" << res.activeDlambdaC << "\n";

  bool fdOk = false;
  const Mat6 D_fd = hs::fd_algorithmic_tangent(
      strain_trial, strain_committed, stress_committed,
      state, r, 1.0, D_e, fdOk);
  require(fdOk, "direct FD oracle failed");

  const double s1 = compression_component_in_projector(res.stressUpdated, principalT.P1);
  const double s2 = compression_component_in_projector(res.stressUpdated, principalT.P2);
  const double s3 = compression_component_in_projector(res.stressUpdated, principalT.P3);
  const auto ctx = sht::build_sh_context(
      principalT,
      s1, s2, s3,
      res.stateUpdated.gamma_p,
      res.stateUpdated.p_p,
      res.stateUpdated.eps_v_p,
      0.0,
      res.activeDlambdaC,
      r.cEff, r.phi, r.psi, hs::critical_state_sin_phi_cv(r.phi, r.psi),
      r.hs.M_cap,
      p_t,
      r.hs.H_cap,
      r);
  const Mat6 D_residual = residual_oracle_cap_tangent(
      strain_trial, strain_committed, stress_committed, state, r, D_e, res);

  bool ok = false;
  const Mat6 D_sh = sht::compute_simo_hughes_cap_tangent(
      principalT, ctx, D_e, ok);
  require(ok, "cap Simo-Hughes tangent returned not-ok");

  const double relResidual = relerr_inplane(D_sh, D_residual);
  const double relDirect = relerr_inplane(D_sh, D_fd);
  std::cout << "HS SH-3 cap tangent residualRelErr_3x3="
            << std::scientific << relResidual
            << " directFdRelErr_3x3=" << relDirect
            << " dlambda=" << res.activeDlambdaC << "\n";
  require(relResidual < 1e-4, "cap Simo-Hughes tangent did not match residual oracle");
  require(relDirect < 1e-4, "cap Simo-Hughes tangent did not match FD oracle");
}

}  // namespace sh3

int main() {
  try {
    sh3::run_cap_case();
    std::cout << "HS SH-3 cap Simo-Hughes tangent PASSED.\n";
    return EXIT_SUCCESS;
  } catch (const std::exception& ex) {
    std::cerr << "HS SH-3 verifier failed: " << ex.what() << "\n";
    return EXIT_FAILURE;
  }
}
