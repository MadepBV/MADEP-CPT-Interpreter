// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH-2 verifier harness: branch-frozen finite-difference checks for the
// exact active-set Mohr-Coulomb tangent in material_mc_exact.hpp.

#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "material_mc_exact.hpp"

namespace mcsh2 {

using madep::Mat6;
using madep::Vec6;
namespace mc = madep::mc_exact;

constexpr int kPlane[3] = {
    static_cast<int>(madep::V_XX),
    static_cast<int>(madep::V_YY),
    static_cast<int>(madep::V_XY)
};
constexpr double kPi = 3.141592653589793238462643383279502884;

void require(bool ok, const std::string& msg) {
  if (!ok) throw std::runtime_error(msg);
}

Mat6 elastic_matrix(double E, double nu) {
  const double G = E / (2.0 * (1.0 + nu));
  const double lambda = E * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
  Mat6 C{};
  C[0][0] = lambda + 2.0 * G; C[0][1] = lambda;           C[0][2] = lambda;
  C[1][0] = lambda;           C[1][1] = lambda + 2.0 * G; C[1][2] = lambda;
  C[2][0] = lambda;           C[2][1] = lambda;           C[2][2] = lambda + 2.0 * G;
  C[3][3] = G;
  C[4][4] = G;
  C[5][5] = G;
  return C;
}

Vec6 matvec(const Mat6& A, const Vec6& x) {
  Vec6 y{};
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) y[i] += A[i][j] * x[j];
  }
  return y;
}

Vec6 add(const Vec6& a, const Vec6& b) {
  Vec6 out{};
  for (int i = 0; i < 6; ++i) out[i] = a[i] + b[i];
  return out;
}

Vec6 scale(const Vec6& a, double f) {
  Vec6 out{};
  for (int i = 0; i < 6; ++i) out[i] = f * a[i];
  return out;
}

mc::MaterialParameters base_material() {
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
  return mp;
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

std::string branch_name(mc::BranchKind b) {
  switch (b) {
    case mc::BranchKind::FACE_F13: return "MC_FACE_F13";
    case mc::BranchKind::EDGE_S23_EQUAL: return "MC_EDGE_S23_EQUAL";
    case mc::BranchKind::EDGE_S12_EQUAL: return "MC_EDGE_S12_EQUAL";
    case mc::BranchKind::APEX_FORMAL: return "MC_APEX_FORMAL";
    case mc::BranchKind::TENSION_FACE_T3: return "TENSION_FACE_T3";
    case mc::BranchKind::TENSION_EDGE_T23: return "TENSION_EDGE_T23";
    case mc::BranchKind::TENSION_EDGE_F13_T3: return "TENSION_EDGE_F13_T3";
    case mc::BranchKind::TENSION_CORNER_S23_T3: return "TENSION_CORNER_S23_T3";
    case mc::BranchKind::TENSION_CORNER_S12_T3: return "TENSION_CORNER_S12_T3";
    case mc::BranchKind::TENSION_APEX_T123: return "TENSION_APEX_T123";
    default: return "OTHER";
  }
}

struct CaseDef {
  std::string label;
  mc::MaterialParameters mp;
  Vec6 committedStress{};
  Vec6 strain{};
  mc::BranchKind expected{mc::BranchKind::ELASTIC};
  double h{1e-7};
};

struct ReturnEval {
  mc::CandidateBranchResult result;
  Vec6 trialStress{};
};

ReturnEval run_return(const CaseDef& c, const Vec6& strainOffset = Vec6{}) {
  const Mat6 C = elastic_matrix(c.mp.Emc, c.mp.nu);
  const Vec6 strain = add(c.strain, strainOffset);
  const Vec6 trialStress = add(c.committedStress, matvec(C, strain));
  const mc::McTrial trial = make_trial(trialStress, c.mp);
  const mc::PrincipalState principalTrial =
      mc::principal_stress_projectors_3d_compression_positive(trialStress, c.mp);
  const mc::Vec3 trialPrincipalValues{principalTrial.s1, principalTrial.s2, principalTrial.s3};
  const double localTolerance = mc::local_return_tolerance(c.mp, trial);
  const double edgeTolerance = mc::resolve_corner_stress_gap_tolerance(
      c.mp, trialPrincipalValues, trial, false);
  const double apexTolerance = mc::resolve_corner_stress_gap_tolerance(
      c.mp, trialPrincipalValues, trial, true);
  mc::ToleranceState toleranceState;
  toleranceState.localTolerance = localTolerance;
  toleranceState.edgeTolerance = edgeTolerance;
  toleranceState.apexTolerance = apexTolerance;
  toleranceState.apexHydrostaticTolerance = mc::resolve_apex_hydrostatic_tolerance(
      c.mp, trialPrincipalValues, trial, apexTolerance);
  toleranceState.eigenSubspaceTolerance = mc::resolve_eigen_subspace_tolerance(
      c.mp, trialPrincipalValues, trial, edgeTolerance);
  ReturnEval out;
  out.trialStress = trialStress;
  out.result = mc::solve_exact_mc_candidate_branch(
      c.expected, trialStress, principalTrial, C, c.mp, trial, nullptr, toleranceState);
  return out;
}

double min_trial_gap(const CaseDef& c) {
  const ReturnEval ev = run_return(c);
  const mc::McTrial trial = make_trial(ev.trialStress, c.mp);
  return std::min({
      std::abs(trial.s1 - trial.s2),
      std::abs(trial.s2 - trial.s3),
      std::abs(trial.s1 - trial.s3)});
}

bool has_distinct_trial_spectrum(const CaseDef& c) {
  return min_trial_gap(c) > 0.25;
}

bool stable_branch_fixture(const CaseDef& c) {
  const ReturnEval base = run_return(c);
  if (!base.result.converged || base.result.acceptedBranchKind != c.expected) return false;
  if (!has_distinct_trial_spectrum(c)) return false;
  for (int col : kPlane) {
    Vec6 plus{};
    Vec6 minus{};
    plus[col] = c.h;
    minus[col] = -c.h;
    const ReturnEval rp = run_return(c, plus);
    const ReturnEval rm = run_return(c, minus);
    if (!rp.result.converged || !rm.result.converged) return false;
    if (rp.result.acceptedBranchKind != c.expected ||
        rm.result.acceptedBranchKind != c.expected) {
      return false;
    }
  }
  return true;
}

CaseDef find_stable_nearby_fixture(const CaseDef& seed) {
  if (stable_branch_fixture(seed)) return seed;
  const std::array<double, 7> diagOffsets{-3.0, -1.0, -0.25, 0.0, 0.25, 1.0, 3.0};
  const std::array<double, 5> shearOffsets{-1.0, -0.25, 0.0, 0.25, 1.0};
  for (double dx : diagOffsets) {
    for (double dy : diagOffsets) {
      for (double dz : diagOffsets) {
        for (double dxy : shearOffsets) {
          CaseDef c = seed;
          c.committedStress[static_cast<int>(madep::V_XX)] += dx;
          c.committedStress[static_cast<int>(madep::V_YY)] += dy;
          c.committedStress[static_cast<int>(madep::V_ZZ)] += dz;
          c.committedStress[static_cast<int>(madep::V_XY)] += dxy;
          if (stable_branch_fixture(c)) return c;
        }
      }
    }
  }
  throw std::runtime_error(seed.label + ": failed to find nearby differentiable fixture");
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

Mat6 fd_tangent(const CaseDef& c, mc::BranchKind branch) {
  Mat6 D{};
  for (int col : kPlane) {
    Vec6 plus{};
    Vec6 minus{};
    plus[col] = c.h;
    minus[col] = -c.h;
    const ReturnEval rp = run_return(c, plus);
    const ReturnEval rm = run_return(c, minus);
    require(rp.result.converged, c.label + ": +FD return failed");
    require(rm.result.converged, c.label + ": -FD return failed");
    require(rp.result.acceptedBranchKind == branch,
            c.label + ": +FD branch changed to " + branch_name(rp.result.acceptedBranchKind));
    require(rm.result.acceptedBranchKind == branch,
            c.label + ": -FD branch changed to " + branch_name(rm.result.acceptedBranchKind));
    for (int row = 0; row < 6; ++row) {
      D[row][col] = (rp.result.stress6_tens[row] - rm.result.stress6_tens[row]) / (2.0 * c.h);
    }
  }
  return D;
}

void run_case(const CaseDef& c) {
  const ReturnEval base = run_return(c);
  if (!base.result.converged) {
    std::cout << "MC-SH-2 " << c.label
              << " base failed promote=" << (base.result.promote ? 1 : 0)
              << " promoteTo=" << branch_name(base.result.promoteTo)
              << " tangentQuality=" << static_cast<int>(base.result.tangentQuality)
              << " branchResidual=" << base.result.branchAcceptanceResidual
              << "\n";
  }
  require(base.result.converged, c.label + ": base return failed");
  require(base.result.acceptedBranchKind == c.expected,
          c.label + ": expected " + branch_name(c.expected) + " got " +
              branch_name(base.result.acceptedBranchKind));
  const Mat6 Dfd = fd_tangent(c, base.result.acceptedBranchKind);
  const double rel = relerr_inplane(base.result.algorithmicTangent6x6, Dfd);
  std::cout << std::scientific << std::setprecision(6)
            << "MC-SH-2 " << c.label
            << " branch=" << branch_name(base.result.acceptedBranchKind)
            << " rel=" << rel
            << " h=" << c.h << "\n";
  require(rel < 1e-4, c.label + ": tangent/FD relative error exceeds 1e-4");
}

Vec6 plane_seed(double sxx, double syy, double txy, double nu) {
  return Vec6{-sxx, -syy, -nu * (sxx + syy), -txy, 0.0, 0.0};
}

std::vector<CaseDef> cases() {
  std::vector<CaseDef> out;

  mc::MaterialParameters face;
  face.Emc = 30000.0;
  face.nu = 0.3;
  face.cEff = 8.0;
  face.phiEffDeg = 32.0;
  face.psiEffDeg = 7.0;
  face.useTensionCutoff = false;
  out.push_back(CaseDef{
      "face_f13",
      face,
      Vec6{-100.0, -100.0, -100.0, 0.0, 0.0, 0.0},
      Vec6{0.005, -0.005, 0.0, 0.0, 0.0, 0.0},
      mc::BranchKind::FACE_F13,
      1e-7});

  mc::MaterialParameters lowerEdge;
  lowerEdge.Emc = 18000.0;
  lowerEdge.nu = 0.3;
  lowerEdge.cEff = 1.5;
  lowerEdge.phiEffDeg = 18.0;
  lowerEdge.psiEffDeg = 5.0;
  lowerEdge.useTensionCutoff = true;
  out.push_back(CaseDef{
      "edge_s23",
      lowerEdge,
      plane_seed(15.0, 30.0, 0.0, lowerEdge.nu),
      Vec6{-0.02, 0.0, 0.0, 0.02, 0.0, 0.0},
      mc::BranchKind::EDGE_S23_EQUAL,
      1e-7});

  mc::MaterialParameters upperEdge;
  upperEdge.Emc = 18000.0;
  upperEdge.nu = 0.3;
  upperEdge.cEff = 4.070289300283476;
  upperEdge.phiEffDeg = 10.214211521800564;
  upperEdge.psiEffDeg = 1.2262853774186977;
  upperEdge.useTensionCutoff = true;
  out.push_back(CaseDef{
      "edge_s12",
      upperEdge,
      plane_seed(41.42400488726434, 52.349590265728594, -8.639369008225234, upperEdge.nu),
      Vec6{-0.02721493782357276, -0.028109921482776842, 0.0, 0.0007843543396598568, 0.0, 0.0},
      mc::BranchKind::EDGE_S12_EQUAL,
      1e-7});

  mc::MaterialParameters apex;
  apex.Emc = 18000.0;
  apex.nu = 0.3;
  apex.cEff = 10.0;
  apex.phiEffDeg = 30.0;
  apex.psiEffDeg = 5.0;
  apex.useTensionCutoff = false;
  apex.allowFormalApexBranch = true;
  const double formalApexStress = apex.cEff / std::tan(apex.phiEffDeg * kPi / 180.0);
  CaseDef apexCase{
      "apex_formal",
      apex,
      Vec6{},
      Vec6{},
      mc::BranchKind::APEX_FORMAL,
      1e-8};
  bool apexFound = false;
  for (double a : {-6.0, -4.0, -2.0, -1.0, -0.5, 0.5, 1.0, 2.0, 4.0, 6.0}) {
    for (double b : {-6.0, -4.0, -2.0, -1.0, -0.5, 0.5, 1.0, 2.0, 4.0, 6.0}) {
      for (double c : {-6.0, -4.0, -2.0, -1.0, -0.5, 0.5, 1.0, 2.0, 4.0, 6.0}) {
        apexCase.committedStress =
            Vec6{formalApexStress + a, formalApexStress + b, formalApexStress + c, 0.0, 0.0, 0.0};
        const ReturnEval probe = run_return(apexCase);
        const mc::McTrial trial = make_trial(probe.trialStress, apexCase.mp);
        const double gap12 = std::abs(trial.s1 - trial.s2);
        const double gap23 = std::abs(trial.s2 - trial.s3);
        const double gap13 = std::abs(trial.s1 - trial.s3);
        const bool distinctTrialSpectrum = std::min({gap12, gap23, gap13}) > 0.25;
        if (probe.result.converged &&
            probe.result.acceptedBranchKind == mc::BranchKind::APEX_FORMAL &&
            distinctTrialSpectrum) {
          apexFound = true;
          break;
        }
      }
      if (apexFound) break;
    }
    if (apexFound) break;
  }
  require(apexFound, "failed to find a valid formal-apex branch fixture");
  out.push_back(apexCase);

  const mc::MaterialParameters tension = base_material();
  out.push_back(find_stable_nearby_fixture(CaseDef{
      "tension_face_t3",
      tension,
      Vec6{-10.0, -10.0, 4.0, 0.0, 0.0, 0.0},
      Vec6{},
      mc::BranchKind::TENSION_FACE_T3,
      1e-8}));
  out.push_back(find_stable_nearby_fixture(CaseDef{
      "tension_edge_t23",
      tension,
      Vec6{-10.0, 4.0, 4.0, 0.0, 0.0, 0.0},
      Vec6{},
      mc::BranchKind::TENSION_EDGE_T23,
      1e-8}));
  out.push_back(find_stable_nearby_fixture(CaseDef{
      "tension_edge_f13_t3",
      tension,
      Vec6{-16.0, 0.0, 8.0, 0.0, 0.0, 0.0},
      Vec6{},
      mc::BranchKind::TENSION_EDGE_F13_T3,
      1e-8}));
  out.push_back(find_stable_nearby_fixture(CaseDef{
      "tension_corner_s23_t3",
      tension,
      Vec6{-30.0, 12.0, 12.0, 0.0, 0.0, 0.0},
      Vec6{},
      mc::BranchKind::TENSION_CORNER_S23_T3,
      1e-8}));
  out.push_back(find_stable_nearby_fixture(CaseDef{
      "tension_corner_s12_t3",
      tension,
      Vec6{-30.0, -20.0, 30.0, 0.0, 0.0, 0.0},
      Vec6{},
      mc::BranchKind::TENSION_CORNER_S12_T3,
      1e-8}));
  out.push_back(find_stable_nearby_fixture(CaseDef{
      "tension_apex_t123",
      tension,
      Vec6{4.0, 4.0, 4.0, 0.0, 0.0, 0.0},
      Vec6{},
      mc::BranchKind::TENSION_APEX_T123,
      1e-8}));

  return out;
}

int main_impl() {
  for (const CaseDef& c : cases()) run_case(c);
  std::cout << "MC-SH-2 exact tangent invariant PASSED.\n";
  return 0;
}

}  // namespace mcsh2

int main() {
  try {
    return mcsh2::main_impl();
  } catch (const std::exception& ex) {
    std::cerr << "MC-SH-2 exact tangent invariant failed: " << ex.what() << "\n";
    return 1;
  }
}
