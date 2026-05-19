// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH-3 verifier harness: damped local Newton, exact-return
// admissibility, and plane-strain sigma_zz reaction recovery.

#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>

#include "solver.hpp"

namespace mcsh3 {

using madep::Mat6;
using madep::Vec6;
namespace mc = madep::mc_exact;
namespace solver = madep::solver;

void require(bool ok, const std::string& msg) {
  if (!ok) throw std::runtime_error(msg);
}

Mat6 elastic_matrix(double E, double nu) {
  return madep::linalg::elastic_matrix_E_nu(E, nu);
}

double norm6(const Vec6& v) {
  return madep::js_mirror::vector_norm6(v);
}

Vec6 add(const Vec6& a, const Vec6& b) {
  return madep::js_mirror::add_vector6(a, b);
}

Vec6 sub(const Vec6& a, const Vec6& b) {
  return madep::js_mirror::subtract_vector6(a, b);
}

Vec6 matvec(const Mat6& A, const Vec6& x) {
  return madep::js_mirror::multiply_matrix6x6_vector6(A, x);
}

mc::McTrial make_trial(const Vec6& stress, const mc::MaterialParameters& mp) {
  const mc::PrincipalAndValues exact =
      mc::evaluate_exact_mc_surface_values_from_stress(stress, mp);
  mc::McTrial trial;
  trial.s1 = exact.principal.s1;
  trial.s2 = exact.principal.s2;
  trial.s3 = exact.principal.s3;
  trial.maxAbsStress = 0.0;
  for (double v : stress) trial.maxAbsStress = std::max(trial.maxAbsStress, std::abs(v));
  return trial;
}

mc::ToleranceState tolerances_for(const mc::MaterialParameters& mp,
                                  const Vec6& stressTrial,
                                  const mc::McTrial& trial) {
  const mc::PrincipalState principalTrial =
      mc::principal_stress_projectors_3d_compression_positive(stressTrial, mp);
  const mc::Vec3 trialPrincipalValues{principalTrial.s1, principalTrial.s2, principalTrial.s3};
  mc::ToleranceState ts;
  ts.localTolerance = mc::local_return_tolerance(mp, trial);
  ts.edgeTolerance = mc::resolve_corner_stress_gap_tolerance(
      mp, trialPrincipalValues, trial, false);
  ts.apexTolerance = mc::resolve_corner_stress_gap_tolerance(
      mp, trialPrincipalValues, trial, true);
  ts.apexHydrostaticTolerance = mc::resolve_apex_hydrostatic_tolerance(
      mp, trialPrincipalValues, trial, ts.apexTolerance);
  ts.eigenSubspaceTolerance = mc::resolve_eigen_subspace_tolerance(
      mp, trialPrincipalValues, trial, ts.edgeTolerance);
  ts.complementarityTolerance = mc::resolve_active_set_complementarity_tolerance(
      mp, trialPrincipalValues, trial, ts.edgeTolerance);
  return ts;
}

mc::CandidateBranchResult solve_candidate(mc::BranchKind branch,
                                          const Vec6& stressTrial,
                                          const Mat6& C,
                                          const mc::MaterialParameters& mp) {
  const mc::McTrial trial = make_trial(stressTrial, mp);
  const mc::PrincipalState principalTrial =
      mc::principal_stress_projectors_3d_compression_positive(stressTrial, mp);
  return mc::solve_exact_mc_candidate_branch(
      branch, stressTrial, principalTrial, C, mp, trial, nullptr,
      tolerances_for(mp, stressTrial, trial));
}

std::pair<Vec6, mc::CandidateBranchResult> find_branch_fixture(
    mc::BranchKind branch,
    const Vec6& seed,
    const Mat6& C,
    const mc::MaterialParameters& mp) {
  const std::array<double, 7> diagOffsets{-3.0, -1.0, -0.25, 0.0, 0.25, 1.0, 3.0};
  const std::array<double, 5> shearOffsets{-1.0, -0.25, 0.0, 0.25, 1.0};
  for (double dx : diagOffsets) {
    for (double dy : diagOffsets) {
      for (double dz : diagOffsets) {
        for (double dxy : shearOffsets) {
          Vec6 stress = seed;
          stress[madep::V_XX] += dx;
          stress[madep::V_YY] += dy;
          stress[madep::V_ZZ] += dz;
          stress[madep::V_XY] += dxy;
          mc::CandidateBranchResult res = solve_candidate(branch, stress, C, mp);
          if (res.converged && res.acceptedBranchKind == branch) return {stress, res};
        }
      }
    }
  }
  throw std::runtime_error("failed to find accepted exact active-set fixture");
}

void verify_plane_strain_recovery(const Mat6& C,
                                  const Vec6& stressTrial,
                                  const Vec6& stressReturned,
                                  const Vec6& plasticIncrement,
                                  const mc::MaterialParameters& mp) {
  const Vec6 restitution =
      mc::plastic_increment_from_stress_correction(stressTrial, stressReturned, mp);
  require(norm6(sub(restitution, plasticIncrement)) < 1e-12,
          "plastic increment must equal elastic restitution from returned stress");

  const Vec6 planeStrainIncrement{1.0e-4, -4.0e-5, 0.0, 2.0e-5, 0.0, 0.0};
  const Vec6 sigmaN = sub(stressTrial, matvec(C, planeStrainIncrement));
  const Vec6 elasticRecovered =
      mc::elastic_strain_from_stress_increment(sub(stressReturned, sigmaN), mp);
  const Vec6 totalRecovered = add(elasticRecovered, plasticIncrement);
  require(std::abs(totalRecovered[madep::V_ZZ]) < 1e-9,
          "plane-strain epsilon_zz recovery residual must stay below 1e-9");
  require(std::abs(totalRecovered[madep::V_YZ]) < 1e-12,
          "plane-strain gamma_yz recovery residual must stay zero");
  require(std::abs(totalRecovered[madep::V_XZ]) < 1e-12,
          "plane-strain gamma_xz recovery residual must stay zero");
}

void verify_exact_active_set_certificate() {
  mc::MaterialParameters mp;
  mp.Emc = 18000.0;
  mp.nu = 0.3;
  mp.cEff = 5.0;
  mp.phiEffDeg = 30.0;
  mp.psiEffDeg = 0.0;
  mp.sigmaTAllow = 2.0;
  mp.useTensionCutoff = true;
  mp.yieldToleranceAbsolute = 1e-8;
  mp.yieldToleranceRelative = 1e-10;
  const Mat6 C = elastic_matrix(mp.Emc, mp.nu);

  const std::array<std::pair<mc::BranchKind, Vec6>, 3> cases{{
      {mc::BranchKind::TENSION_EDGE_T23, Vec6{-10.0, 4.0, 4.0, 0.0, 0.0, 0.0}},
      {mc::BranchKind::TENSION_CORNER_S23_T3, Vec6{-30.0, 12.0, 12.0, 0.0, 0.0, 0.0}},
      {mc::BranchKind::TENSION_APEX_T123, Vec6{4.0, 4.0, 4.0, 0.0, 0.0, 0.0}}
  }};

  for (const auto& item : cases) {
    const auto [stressTrial, res] = find_branch_fixture(item.first, item.second, C, mp);
    require(res.admissibilityCertified != 0u, "admissibility certificate did not pass");
    for (double multiplier : res.plasticMultipliers) {
      require(multiplier >= -1e-10, "plastic multiplier must be non-negative");
    }
    require(std::abs(res.planeStrainResidualZz) < 1e-12,
            "stored plane-strain residual must be zero");
    verify_plane_strain_recovery(C, stressTrial, res.stress6_tens,
                                 res.plasticStrainIncrement6, mp);
  }
}

void verify_damped_smooth_newton() {
  mc::MaterialParameters mp;
  mp.Emc = 18000.0;
  mp.nu = 0.3;
  mp.cEff = 0.1;
  mp.phiEffDeg = 35.0;
  mp.psiEffDeg = 5.0;
  mp.sigmaTAllow = 0.0;
  mp.useTensionCutoff = false;
  mp.yieldToleranceAbsolute = 1e-10;
  mp.yieldToleranceRelative = 1e-10;
  const Mat6 C = elastic_matrix(mp.Emc, mp.nu);
  const Vec6 stressTrial{-5.0, -1.0, -1.0, 0.2, 0.0, 0.0};
  const mc::McTrial trial = make_trial(stressTrial, mp);
  const solver::SmoothReturnResult smooth =
      solver::return_map_smooth_mc_plastic(stressTrial, C, mp, trial);
  const double tol = mc::local_return_tolerance(mp, trial);
  require(smooth.converged, "damped smooth MC return did not converge");
  require(smooth.iterations <= 30, "damped smooth MC return exceeded 30 iterations");
  require(std::abs(smooth.yieldResidual) <= 10.0 * tol,
          "damped smooth MC return residual exceeds tolerance");
  verify_plane_strain_recovery(C, stressTrial, smooth.stress6,
                               smooth.plasticStrainIncrement6, mp);
}

int main_impl() {
  verify_exact_active_set_certificate();
  verify_damped_smooth_newton();
  std::cout << std::scientific << std::setprecision(6)
            << "MC-SH-3 damped Newton/admissibility/plane-strain PASSED.\n";
  return 0;
}

}  // namespace mcsh3

int main() {
  try {
    return mcsh3::main_impl();
  } catch (const std::exception& ex) {
    std::cerr << "MC-SH-3 verifier failed: " << ex.what() << "\n";
    return 1;
  }
}
