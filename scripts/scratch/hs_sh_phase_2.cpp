// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-2 cone Simo-Hughes tangent verifier.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "material_hs_tangent.hpp"

namespace sh2 {

using madep::Mat6;
using madep::MaterialPoint;
using madep::RegionParams;
using madep::Vec6;
using madep::V_XX;
using madep::V_YY;
using madep::V_ZZ;
using madep::V_XY;
using madep::V_YZ;
using madep::V_XZ;
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
  r.Emc = 30000.0;
  r.nu = 0.3;
  r.cEff = 0.1;
  r.phi = 30.0 * kPi / 180.0;
  r.psi = 20.0 * kPi / 180.0;
  r.K0nc = 0.5;
  r.gamma = 18.0;
  r.gammaSat = 20.0;
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

double compression_component_in_projector(const Vec6& stress_tension,
                                          const madep::js_mirror::Mat3& P) {
  return -P[0][0] * stress_tension[V_XX]
       - P[1][1] * stress_tension[V_YY]
       - P[2][2] * stress_tension[V_ZZ]
       - 2.0 * (P[0][1] * stress_tension[V_XY]
              + P[1][2] * stress_tension[V_YZ]
              + P[0][2] * stress_tension[V_XZ]);
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

Vec6 cone_flow_eng_locked(const mce::PrincipalState& pr,
                          hs::ConeFlowRegime regime,
                          double s1,
                          double s3,
                          const RegionParams& r,
                          double c_eff,
                          double phi_eff,
                          double psi_eff,
                          double sinPhiCv,
                          double eps_v_p) {
  const double sinPhiMob = hs::mobilised_sin_phi(s1, s3, c_eff, phi_eff);
  const double eps_v_p_max =
      hs::dilatancy_cutoff_threshold(r.hs.e_init, r.hs.e_max);
  const double sinPsi = hs::mobilised_sin_psi(
      sinPhiMob, sinPhiCv, psi_eff, eps_v_p, eps_v_p_max);
  double m1 = 0.0, m2 = 0.0, m3 = 0.0;
  hs::cone_flow_gradient(regime, sinPsi, m1, m2, m3);
  const Vec6 m_t = hs::lift_principal_gradient_to_tensor_voigt(
      pr, m1, m2, m3);
  return hs::tensor_voigt_to_engineering(m_t);
}

std::vector<double> cone_residual_locked(
    const std::vector<double>& y,
    const Vec6& strain_trial,
    const Vec6& strain_committed,
    const Vec6& stress_committed,
    const MaterialPoint::HsState& state,
    const RegionParams& r,
    const Mat6& D_e,
    hs::ConeFlowRegime regime) {
  const double c_eff = r.cEff;
  const double phi_eff = r.phi;
  const double psi_eff = r.psi;
  const double sinPhiCv = hs::critical_state_sin_phi_cv(phi_eff, psi_eff);
  const auto mp = hs::make_mp_for_eig(r, c_eff, phi_eff);
  const Vec6 sigma_trial = lng::add(
      stress_committed, lng::mul6x6(D_e, lng::sub(strain_trial, strain_committed)));
  const auto pr = mce::principal_stress_projectors_3d_compression_positive(
      sigma_trial, mp);
  Vec6 sigma{};
  for (int i = 0; i < 6; ++i) sigma[i] = y[static_cast<std::size_t>(i)];
  const double s1 = compression_component_in_projector(sigma, pr.P1);
  const double s3 = compression_component_in_projector(sigma, pr.P3);
  const double gamma = y[6];
  const double dlambda = y[7];
  const Vec6 m = cone_flow_eng_locked(
      pr, regime, s1, s3, r, c_eff, phi_eff, psi_eff,
      sinPhiCv, state.eps_v_p);
  const Vec6 De_m = lng::mul6x6(D_e, m);

  std::vector<double> F(8, 0.0);
  for (int i = 0; i < 6; ++i) {
    F[static_cast<std::size_t>(i)] =
        sigma[i] - sigma_trial[i] + dlambda * De_m[i];
  }
  F[6] = gamma - state.gamma_p - dlambda;

  const double Rf = std::clamp(r.hs.Rf, 1e-3, 0.999);
  const double E50 = hs::power_law_stiffness(
      r.hs.E50_ref, hs::effective_confining_stress(s3, r.hs),
      c_eff, phi_eff, r.hs.p_ref, r.hs.m);
  const double Eur = hs::power_law_stiffness(
      r.hs.Eur_ref, hs::effective_confining_stress(s3, r.hs),
      c_eff, phi_eff, r.hs.p_ref, r.hs.m);
  const double Ei = 2.0 * E50 / (2.0 - Rf);
  const double qa = hs::hs_q_a_from_sigma3(s3, c_eff, phi_eff, Rf, r.hs);
  F[7] = hs::cone_yield_value(s1 - s3, qa, Ei, Eur, gamma);
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

Mat6 residual_oracle_cone_tangent(
    const Vec6& strain_trial,
    const Vec6& strain_committed,
    const Vec6& stress_committed,
    const MaterialPoint::HsState& state,
    const RegionParams& r,
    const Mat6& D_e,
    const hs::HsUpdateResult& res,
    hs::ConeFlowRegime regime) {
  std::vector<double> y0(8, 0.0);
  for (int i = 0; i < 6; ++i) y0[static_cast<std::size_t>(i)] = res.stressUpdated[i];
  y0[6] = res.stateUpdated.gamma_p;
  y0[7] = res.activeDlambdaS;
  const auto F0 = cone_residual_locked(
      y0, strain_trial, strain_committed, stress_committed,
      state, r, D_e, regime);
  double rnorm = 0.0;
  for (double v : F0) rnorm += v * v;
  require(std::sqrt(rnorm) < 1e-5, "cone residual oracle base state is not converged");

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
    const auto Fp = cone_residual_locked(
        yp, strain_trial, strain_committed, stress_committed,
        state, r, D_e, regime);
    const auto Fm = cone_residual_locked(
        ym, strain_trial, strain_committed, stress_committed,
        state, r, D_e, regime);
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
    const auto Fp = cone_residual_locked(
        y0, ep, strain_committed, stress_committed,
        state, r, D_e, regime);
    const auto Fm = cone_residual_locked(
        y0, em, strain_committed, stress_committed,
        state, r, D_e, regime);
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

void run_cone_case() {
  RegionParams r = default_region();
  const double sigma3 = 80.0;
  const double sigma2 = 120.0;
  const double q0 = 80.0;
  const double sigma1 = sigma3 + q0;
  Vec6 stress_committed{-sigma3, -sigma1, -sigma2, 0.0, 0.0, 0.0};
  Vec6 strain_committed{0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  Vec6 strain_trial = strain_committed;
  strain_trial[V_YY] = -2.5e-4;
  strain_trial[V_XY] = 1.0e-5;

  MaterialPoint::HsState state{};
  state.gamma_p = hs::cone_zero_gamma_p_for_principal_pair(
      sigma1, sigma3, r.cEff, r.phi, r.hs);
  state.p_p = 5.0 * sigma3;
  state.eps_v_p = 0.0;
  state.lastActiveSet = 1;

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
  require(res.failureCode == 0, "cone update failed");
  require(res.stateUpdated.lastActiveSet == 1, "case did not stay cone-active");
  std::cout << "  active=" << static_cast<int>(res.stateUpdated.lastActiveSet)
            << " tangentMode=" << static_cast<int>(res.tangentMode)
            << " dlambda=" << res.activeDlambdaS << "\n";
  require(res.activeDlambdaS > 0.0, "cone return did not expose dlambda_s");
  bool fdOk = false;
  const Mat6 D_fd = hs::fd_algorithmic_tangent(
      strain_trial, strain_committed, stress_committed,
      state, r, 1.0, D_e, fdOk);
  require(fdOk, "direct FD oracle failed");

  const double s1 = compression_component_in_projector(res.stressUpdated, principalT.P1);
  const double s2 = compression_component_in_projector(res.stressUpdated, principalT.P2);
  const double s3 = compression_component_in_projector(res.stressUpdated, principalT.P3);
  const double sinPhiCv = hs::critical_state_sin_phi_cv(r.phi, r.psi);
  const auto ctx = sht::build_sh_context(
      principalT,
      s1, s2, s3,
      res.stateUpdated.gamma_p,
      res.stateUpdated.p_p,
      res.stateUpdated.eps_v_p,
      res.activeDlambdaS,
      0.0,
      r.cEff, r.phi, r.psi, sinPhiCv,
      r.hs.M_cap,
      hs::tensile_shift_p_t(r.cEff, r.phi),
      r.hs.H_cap,
      r);
  std::cout << "  s=(" << s1 << "," << s2 << "," << s3 << ")"
            << " sinphiMob=" << ctx.sin_phi_mob
            << " sinpsi=" << ctx.sin_psi_mob
            << " dpsi=(" << ctx.dpsi_dsigma_1 << "," << ctx.dpsi_dsigma_3 << ")"
            << " cutoff=" << ctx.pre_critical_cutoff_active
            << "/" << ctx.dilatancy_cutoff_active << "\n";
  const hs::ConeFlowRegime regime = hs::classify_cone_regime(principalT);
  const Mat6 D_residual = residual_oracle_cone_tangent(
      strain_trial, strain_committed, stress_committed,
      state, r, D_e, res, regime);

  bool ok = false;
  const Mat6 D_sh = sht::compute_simo_hughes_cone_tangent(
      principalT, ctx, D_e, ok);
  require(ok, "cone Simo-Hughes tangent returned not-ok");

  const double relResidual = relerr_inplane(D_sh, D_residual);
  const double relDirect = relerr_inplane(D_sh, D_fd);
  std::cout << "HS SH-2 cone tangent residualRelErr_3x3="
            << std::scientific << relResidual
            << " directFdRelErr_3x3=" << relDirect
            << " dlambda=" << res.activeDlambdaS << "\n";
  require(relResidual < 1e-4, "cone Simo-Hughes tangent did not match residual oracle");
  require(relDirect < 1e-4, "cone Simo-Hughes tangent did not match FD oracle");
}

}  // namespace sh2

int main() {
  try {
    sh2::run_cone_case();
    std::cout << "HS SH-2 cone Simo-Hughes tangent PASSED.\n";
    return EXIT_SUCCESS;
  } catch (const std::exception& ex) {
    std::cerr << "HS SH-2 verifier failed: " << ex.what() << "\n";
    return EXIT_FAILURE;
  }
}
