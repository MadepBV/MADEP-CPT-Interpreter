// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-1 scalar derivative verifier for the Hardening Soil Simo-Hughes tangent.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>

#include "material_hs_tangent.hpp"

namespace sh1 {

using madep::RegionParams;
namespace hs = madep::material::hs;
namespace sht = madep::material::hs::tangent;
namespace mce = madep::mc_exact;

constexpr double kPi = 3.141592653589793238462643383279502884;

void require(bool ok, const std::string& msg) {
  if (!ok) throw std::runtime_error(msg);
}

double relerr(double analytic, double fd) {
  return std::abs(analytic - fd) / std::max({std::abs(fd), 1.0});
}

void check_close(const std::string& name, double analytic, double fd,
                 double tol = 1e-5) {
  const double err = relerr(analytic, fd);
  std::cout << "  " << std::left << std::setw(36) << name
            << " analytic=" << std::scientific << analytic
            << " fd=" << fd
            << " rel=" << err << "\n";
  require(err < tol, name + " derivative mismatch");
}

RegionParams region() {
  RegionParams r{};
  r.cEff = 0.2;
  r.phi = 30.0 * kPi / 180.0;
  r.psi = 25.0 * kPi / 180.0;
  r.hs.E50_ref = 32000.0;
  r.hs.Eoed_ref = 36000.0;
  r.hs.Eur_ref = 96000.0;
  r.hs.m = 0.58;
  r.hs.nu_ur = 0.2;
  r.hs.p_ref = 100.0;
  r.hs.Rf = 0.88;
  r.hs.K0_nc = 0.5;
  r.hs.e_init = -1.0;
  r.hs.e_max = -1.0;
  r.hs.OCR = 1.0;
  r.hs.nearSurfaceMinConfiningStress = 0.0;
  hs::compute_hs_reference_constants(r, 1.0);
  return r;
}

double power_value(double E_ref, double sigma3, const RegionParams& r) {
  return E_ref * sht::hs_power_ratio_at_sigma3(
      sigma3, r.cEff, r.phi, r.hs);
}

double qf_value(double sigma3, const RegionParams& r) {
  double sinPhi = std::sin(r.phi);
  if (sinPhi < 1e-6) sinPhi = 1e-6;
  const double sigma_eff = hs::effective_confining_stress(sigma3, r.hs);
  return (r.cEff * hs::cot_safe(r.phi) + sigma_eff) * 2.0 * sinPhi
       / std::max(1.0 - sinPhi, 1e-9);
}

double cone_f_from_scalars(double E_i, double E_ur, double q_a, double q) {
  return hs::cone_yield_value(q, q_a, E_i, E_ur, 0.0);
}

void test_sigma3_derivatives() {
  RegionParams r = region();
  const double sigma3 = 80.0;
  const double h = 1e-3;
  const double Rf = std::clamp(r.hs.Rf, 1e-3, 0.999);

  const double dE50 = sht::compute_dE_50_d_sigma_3(
      r.hs.E50_ref, sigma3, r.cEff, r.phi, r.hs);
  const double fdE50 = (power_value(r.hs.E50_ref, sigma3 + h, r)
                      - power_value(r.hs.E50_ref, sigma3 - h, r)) / (2.0 * h);
  check_close("dE50/dsigma3", dE50, fdE50);

  const double dEur = sht::compute_dE_ur_d_sigma_3(
      r.hs.Eur_ref, sigma3, r.cEff, r.phi, r.hs);
  const double fdEur = (power_value(r.hs.Eur_ref, sigma3 + h, r)
                      - power_value(r.hs.Eur_ref, sigma3 - h, r)) / (2.0 * h);
  check_close("dEur/dsigma3", dEur, fdEur);

  const double dEi = sht::compute_dE_i_d_sigma_3(
      r.hs.E50_ref, sigma3, r.cEff, r.phi, Rf, r.hs);
  const double fdEi = (2.0 * power_value(r.hs.E50_ref, sigma3 + h, r) / (2.0 - Rf)
                     - 2.0 * power_value(r.hs.E50_ref, sigma3 - h, r) / (2.0 - Rf))
                    / (2.0 * h);
  check_close("dEi/dsigma3", dEi, fdEi);

  const double dqf = sht::compute_dq_f_d_sigma_3(sigma3, r.cEff, r.phi, r.hs);
  const double fdqf = (qf_value(sigma3 + h, r) - qf_value(sigma3 - h, r))
                    / (2.0 * h);
  check_close("dqf/dsigma3", dqf, fdqf);

  const double dqa = sht::compute_dq_a_d_sigma_3(
      sigma3, r.cEff, r.phi, Rf, r.hs);
  check_close("dqa/dsigma3", dqa, fdqf / Rf);

  r.hs.nearSurfaceMinConfiningStress = 100.0;
  const double floorSigma = 50.0;
  require(sht::compute_dE_50_d_sigma_3(
              r.hs.E50_ref, floorSigma, r.cEff, r.phi, r.hs) == 0.0,
          "dE50 did not gate off at near-surface floor");
  require(sht::compute_dq_f_d_sigma_3(floorSigma, r.cEff, r.phi, r.hs) == 0.0,
          "dqf did not gate off at near-surface floor");
}

void test_cone_implicit_partials() {
  RegionParams r = region();
  const double sigma3 = 80.0;
  const double q = 55.0;
  const double Rf = std::clamp(r.hs.Rf, 1e-3, 0.999);
  const double E50 = power_value(r.hs.E50_ref, sigma3, r);
  const double Eur = power_value(r.hs.Eur_ref, sigma3, r);
  const double Ei = 2.0 * E50 / (2.0 - Rf);
  const double qa = std::max(qf_value(sigma3, r) / Rf,
                             hs::numerical_pressure_floor(r.hs));

  const double hE = 1e-3;
  check_close("partial df/dEi",
      sht::compute_df_dE_i_cone(Ei, qa, q),
      (cone_f_from_scalars(Ei + hE, Eur, qa, q)
     - cone_f_from_scalars(Ei - hE, Eur, qa, q)) / (2.0 * hE));
  check_close("partial df/dEur",
      sht::compute_df_dE_ur_cone(Eur, qa, q),
      (cone_f_from_scalars(Ei, Eur + hE, qa, q)
     - cone_f_from_scalars(Ei, Eur - hE, qa, q)) / (2.0 * hE));
  check_close("partial df/dqa",
      sht::compute_df_dq_a_cone(Ei, qa, q),
      (cone_f_from_scalars(Ei, Eur, qa + hE, q)
     - cone_f_from_scalars(Ei, Eur, qa - hE, q)) / (2.0 * hE));

  const double dEi = sht::compute_dE_i_d_sigma_3(
      r.hs.E50_ref, sigma3, r.cEff, r.phi, Rf, r.hs);
  const double dEur = sht::compute_dE_ur_d_sigma_3(
      r.hs.Eur_ref, sigma3, r.cEff, r.phi, r.hs);
  const double dqa = sht::compute_dq_a_d_sigma_3(
      sigma3, r.cEff, r.phi, Rf, r.hs);
  const double analytic = sht::compute_df_dsigma3_implicit_cone(
      Ei, Eur, qa, q, dEi, dEur, dqa);

  auto f_at_sigma3 = [&](double s3) {
    const double E50_s = power_value(r.hs.E50_ref, s3, r);
    const double Eur_s = power_value(r.hs.Eur_ref, s3, r);
    const double Ei_s = 2.0 * E50_s / (2.0 - Rf);
    const double qa_s = std::max(qf_value(s3, r) / Rf,
                                 hs::numerical_pressure_floor(r.hs));
    return cone_f_from_scalars(Ei_s, Eur_s, qa_s, q);
  };
  const double h = 1e-3;
  const double fd = (f_at_sigma3(sigma3 + h) - f_at_sigma3(sigma3 - h))
                  / (2.0 * h);
  check_close("df/dsigma3 implicit", analytic, fd);
}

void test_rowe_derivatives() {
  const RegionParams r = region();
  const double s1 = 150.0;
  const double s3 = 80.0;
  const double sinPhiCv = 0.12;
  const double h = 1e-3;

  auto sinpsi = [&](double a, double b) {
    const double sinPhiMob = hs::mobilised_sin_phi(a, b, r.cEff, r.phi);
    return hs::mobilised_sin_psi(
        sinPhiMob, sinPhiCv, 60.0 * kPi / 180.0, 0.0, -1.0e9);
  };

  const double d1 = sht::compute_dsin_psi_dsigma1_cone(
      s1, s3, r.cEff, r.phi, sinPhiCv,
      /*pre_critical_cutoff=*/false,
      /*dilatancy_cutoff=*/false);
  const double fd1 = (sinpsi(s1 + h, s3) - sinpsi(s1 - h, s3)) / (2.0 * h);
  check_close("d sinpsi/dsigma1", d1, fd1);

  const double d3 = sht::compute_dsin_psi_dsigma3_cone(
      s1, s3, r.cEff, r.phi, sinPhiCv,
      /*pre_critical_cutoff=*/false,
      /*dilatancy_cutoff=*/false);
  const double fd3 = (sinpsi(s1, s3 + h) - sinpsi(s1, s3 - h)) / (2.0 * h);
  check_close("d sinpsi/dsigma3", d3, fd3);

  require(sht::compute_dsin_psi_dsigma1_cone(
              s1, s3, r.cEff, r.phi, sinPhiCv, true, false) == 0.0,
          "pre-critical Rowe cutoff did not zero dpsi/dsigma1");
  require(sht::compute_dsin_psi_dsigma3_cone(
              s1, s3, r.cEff, r.phi, sinPhiCv, false, true) == 0.0,
          "dilatancy Rowe cutoff did not zero dpsi/dsigma3");
}

void test_context_builder() {
  RegionParams r = region();
  const madep::Vec6 stress{-150.0, -110.0, -80.0, 0.0, 0.0, 0.0};
  mce::MaterialParameters mp = hs::make_mp_for_eig(r, r.cEff, r.phi);
  const auto principal =
      mce::principal_stress_projectors_3d_compression_positive(stress, mp);
  const auto ctx = sht::build_sh_context(
      principal,
      150.0, 110.0, 80.0,
      0.012, 180.0, 0.0,
      2e-4, 1e-4,
      r.cEff, r.phi, r.psi, r.hs.sin_phi_cv,
      r.hs.M_cap, hs::tensile_shift_p_t(r.cEff, r.phi), r.hs.H_cap,
      r);
  require(ctx.E_50 > 0.0 && ctx.E_ur > 0.0 && ctx.E_i > 0.0,
          "context stiffness constants were not populated");
  require(ctx.q_a > 0.0 && ctx.q_f > 0.0,
          "context q constants were not populated");
  require(std::isfinite(ctx.df_dsigma3_implicit),
          "context implicit derivative is not finite");
  require(std::isfinite(ctx.dpsi_dsigma_1) &&
          std::isfinite(ctx.dpsi_dsigma_3),
          "context Rowe derivatives are not finite");
}

}  // namespace sh1

int main() {
  try {
    std::cout << "HS SH-1 sigma_3 derivative helpers:\n";
    sh1::test_sigma3_derivatives();
    sh1::test_cone_implicit_partials();
    sh1::test_rowe_derivatives();
    sh1::test_context_builder();
    std::cout << "HS SH-1 sigma_3 derivative helpers PASSED.\n";
    return EXIT_SUCCESS;
  } catch (const std::exception& ex) {
    std::cerr << "HS SH-1 verifier failed: " << ex.what() << "\n";
    return EXIT_FAILURE;
  }
}
