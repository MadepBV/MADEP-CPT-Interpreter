// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH-0 diagnostic: compare the engineering MC continuum tangent against a
// finite-difference derivative of the implemented return map.

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>

#include "material_mc.hpp"

namespace mcsh0 {

using madep::Mat3x3;
using madep::Mat6;
using madep::RegionParams;
using madep::Vec3;
using madep::Vec6;
using madep::V_XX;
using madep::V_YY;
using madep::V_ZZ;
using madep::V_XY;
using madep::V_YZ;
using madep::V_XZ;
namespace lng = madep::linalg;
namespace mc = madep::material;

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr int kPlane[3] = {static_cast<int>(V_XX), static_cast<int>(V_YY), static_cast<int>(V_XY)};

void require(bool ok, const std::string& msg) {
  if (!ok) throw std::runtime_error(msg);
}

RegionParams default_region() {
  RegionParams r{};
  r.Emc = 30000.0;
  r.nu = 0.3;
  r.cEff = 8.0;
  r.phi = 32.0 * kPi / 180.0;
  r.psi = 7.0 * kPi / 180.0;
  r.K0nc = 0.5;
  r.sigmaTAllow = 0.0;
  r.rShear = 0.25;
  r.useTensionCutoff = 0;
  r.symmetrize = 0;
  return r;
}

double relerr_inplane(const Mat6& A, const Mat6& B) {
  double num = 0.0;
  double den = 0.0;
  for (int rr = 0; rr < 3; ++rr) {
    for (int cc = 0; cc < 3; ++cc) {
      const int i = kPlane[rr];
      const int j = kPlane[cc];
      const double d = A[i][j] - B[i][j];
      num += d * d;
      den += B[i][j] * B[i][j];
    }
  }
  return std::sqrt(num) / std::max(std::sqrt(den), 1.0);
}

Mat6 fd_tangent(const RegionParams& r,
                const Mat6& C,
                const Vec6& sigmaN,
                const Vec6& dStrain,
                double h) {
  Mat6 D{};
  for (int col = 0; col < 6; ++col) {
    Vec6 plus = dStrain;
    Vec6 minus = dStrain;
    plus[col] += h;
    minus[col] -= h;
    const auto rp = mc::run_mc_return_mapping(
        r, C, sigmaN, plus, /*symmetrize=*/false,
        /*useTensionCutoff=*/false, r.sigmaTAllow);
    const auto rm = mc::run_mc_return_mapping(
        r, C, sigmaN, minus, /*symmetrize=*/false,
        /*useTensionCutoff=*/false, r.sigmaTAllow);
    require(rp.plastic_active == 1 && rm.plastic_active == 1,
            "FD probe left the MC plastic face");
    require(rp.tension_cutoff_active == 0 && rm.tension_cutoff_active == 0,
            "FD probe entered tension cutoff");
    require(rp.apex_active == 0 && rm.apex_active == 0,
            "FD probe entered apex");
    for (int row = 0; row < 6; ++row) {
      D[row][col] = (rp.stress[row] - rm.stress[row]) / (2.0 * h);
    }
  }
  return D;
}

struct PrincipalBasis {
  Vec3 w{};
  Mat3x3 V{};
};

PrincipalBasis principal_basis_for_stress(const Vec6& stress) {
  PrincipalBasis out{};
  lng::jacobi_eig_3x3(lng::stress_tensor_from_voigt(stress), out.w, out.V);
  return out;
}

Mat6 tangent_with_trial_basis(const RegionParams& r,
                              const Mat6& C,
                              const Vec6& sigmaN,
                              const Vec6& dStrain,
                              const Vec6& stressReturned) {
  const Vec6 sigmaTrial = lng::add(sigmaN, lng::mul6x6(C, dStrain));
  const PrincipalBasis trial = principal_basis_for_stress(sigmaTrial);
  const PrincipalBasis returned = principal_basis_for_stress(stressReturned);
  return mc::continuum_tangent_mc_global(
      r.phi, r.psi, C, trial.V, trial.w, returned.w,
      /*symmetrize=*/false);
}

Mat6 tangent_with_converged_basis(const RegionParams& r,
                                  const Mat6& C,
                                  const Vec6& sigmaN,
                                  const Vec6& dStrain,
                                  const Vec6& stressReturned) {
  const Vec6 sigmaTrial = lng::add(sigmaN, lng::mul6x6(C, dStrain));
  const PrincipalBasis trial = principal_basis_for_stress(sigmaTrial);
  const PrincipalBasis returned = principal_basis_for_stress(stressReturned);
  return mc::continuum_tangent_mc_global(
      r.phi, r.psi, C, returned.V, trial.w, returned.w,
      /*symmetrize=*/false);
}

double run_case(const std::string& label,
                const Vec6& sigmaN,
                const Vec6& dStrain,
                double fdStep) {
  const RegionParams r = default_region();
  const Mat6 C = mc::build_elastic_6x6(r.Emc, r.nu);
  const auto base = mc::run_mc_return_mapping(
      r, C, sigmaN, dStrain, /*symmetrize=*/false,
      /*useTensionCutoff=*/false, r.sigmaTAllow);
  require(base.plastic_active == 1, label + ": base state must be plastic");
  require(base.tension_cutoff_active == 0, label + ": base must avoid tension cutoff");
  require(base.apex_active == 0, label + ": base must avoid apex");
  require(std::abs(base.yield_residual) < 1e-8, label + ": returned stress must be on MC face");

  const Mat6 Dfd = fd_tangent(r, C, sigmaN, dStrain, fdStep);
  const Mat6 Dtrial = tangent_with_trial_basis(r, C, sigmaN, dStrain, base.stress);
  const Mat6 Dconv = tangent_with_converged_basis(r, C, sigmaN, dStrain, base.stress);
  const double relTrial = relerr_inplane(Dtrial, Dfd);
  const double relConv = relerr_inplane(Dconv, Dfd);

  std::cout << std::scientific << std::setprecision(6)
            << "MC-SH-0 " << label
            << " relTrial=" << relTrial
            << " relConverged=" << relConv
            << " yieldResidual=" << base.yield_residual
            << "\n";
  return relConv;
}

int main() {
  const double axisRel = run_case(
      "axis-face",
      Vec6{-100.0, -100.0, -100.0, 0.0, 0.0, 0.0},
      Vec6{0.005, -0.005, 0.0, 0.0, 0.0, 0.0},
      1e-7);
  const double rotatedRel = run_case(
      "rotated-face",
      Vec6{-85.0, -135.0, -95.0, 18.0, 0.0, 0.0},
      Vec6{0.004, -0.004, 0.0, 0.010, 0.0, 0.0},
      1e-7);
  require(axisRel < 1e-4, "axis-face tangent must FD-validate");
  require(rotatedRel < 1e-4, "rotated-face tangent must FD-validate");
  std::cout << "MC-SH-0 tangent diagnostic PASSED.\n";
  return 0;
}

}  // namespace mcsh0

int main() {
  try {
    return mcsh0::main();
  } catch (const std::exception& ex) {
    std::cerr << "MC-SH-0 diagnostic failed: " << ex.what() << "\n";
    return 1;
  }
}
