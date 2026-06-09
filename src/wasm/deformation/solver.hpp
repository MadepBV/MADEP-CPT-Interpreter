// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Multi-phase Newton-Raphson driver:
//   - Phase A — plastic geostatic equilibration from a K0 stress seed.
//   - Phase B — service-load increment from the geostatic baseline.
//   - Phase C — c-φ strength-reduction safety bracketing.
//
// Each phase calls into a shared `run_nonlinear_phase` that does:
//   assemble K + F_int, solve K δu = r (CG / GMRES), Armijo line search,
//   plastic return mapping at every Gauss point.
//
// Material-point state is split into:
//   - referenceStress: JS `referenceState.effectiveStress6`; starts at the
//     K0 seed and is overwritten with the equilibrated geostatic state when
//     the JS path calls setReferenceStateFromCommittedStates().
//   - committed*: the converged state at the end of the most recent
//     accepted load step. Newton iterations work against this baseline.
//   - trial*: the in-flight state produced by the current Newton iterate
//     (only updated via `assemble_global`, never read by the global
//     solver outside that function).

#pragma once

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <limits>
#include <utility>
#include <vector>

#include "beam.hpp"
#include "cg.hpp"
#include "element.hpp"
#include "material_hs.hpp"
#include "material_mc.hpp"
#include "material_mc_exact.hpp"
#include "sparse.hpp"
#include "types.hpp"

namespace madep::solver {

enum class PhaseKind : std::uint8_t {
  InitialGravity = 0,
  ServiceLoad = 1,
  SafetyCphi = 2,
  // Staged construction (model C): relax the cut-face support that held the
  // in-situ K0 state, with the wall structurally active so it carries the cut.
  // Gravity-like load-stepping (treated as initial-gravity for robustness) but
  // keeps a near-failure display iterate like ServiceLoad so a partial wall
  // diagram is shown honestly if an under-embedded wall reaches a real limit.
  Excavation = 3
};

// Compute strain at a single Gauss point given the global displacement
// vector and the element's DOF map.
inline void strain_at_gauss(
    const ElementCache& el,
    int gpIndex,
    const double* U_global,
    const double* U_base,
    Vec6& strain6) {
  double exx = 0.0, eyy = 0.0, gxy = 0.0;
  const auto& B = el.gp[gpIndex].B;
  const int n = el.numDofs;
  for (int i = 0; i < n; ++i) {
    const std::int32_t dof = el.dofs[i];
    const double ui = U_global[dof] + (U_base ? U_base[dof] : 0.0);
    exx += B[0][i] * ui;
    eyy += B[1][i] * ui;
    gxy += B[2][i] * ui;
  }
  strain6 = linalg::lift_strain_2D(exx, eyy, gxy);
}

// Build the per-region 6×6 elastic stiffness (cached per phase since the
// safety phase scales material parameters).
inline void build_region_elastic_into(
    const std::vector<RegionParams>& regions,
    std::vector<Mat6>& out) {
  out.clear();
  out.reserve(regions.size());
  for (const auto& r : regions) {
    out.push_back(linalg::elastic_matrix_E_nu(r.Emc, r.nu));
  }
}

inline std::vector<Mat6> build_region_elastic(
    const std::vector<RegionParams>& regions) {
  std::vector<Mat6> out;
  build_region_elastic_into(regions, out);
  return out;
}

inline std::vector<Mat6> build_region_reduced_elastic(
    const std::vector<RegionParams>& regions) {
  std::vector<Mat6> out;
  out.reserve(regions.size());
  for (const auto& r : regions) {
    const double E = std::max(r.Emc, 1.0);
    const double nu = std::clamp(r.nu, -0.99, 0.49);
    const double K = E / (3.0 * (1.0 - 2.0 * nu));
    const double G = E / (2.0 * (1.0 + nu));
    const double rShear = std::clamp(r.rShear, 1e-3, 1.0);
    const double Gr = G * rShear;
    const double lam = K - (2.0 * Gr) / 3.0;
    Mat6 D{};
    D[0][0] = lam + 2.0 * Gr; D[0][1] = lam;              D[0][2] = lam;
    D[1][0] = lam;              D[1][1] = lam + 2.0 * Gr; D[1][2] = lam;
    D[2][0] = lam;              D[2][1] = lam;              D[2][2] = lam + 2.0 * Gr;
    D[3][3] = Gr; D[4][4] = Gr; D[5][5] = Gr;
    out.push_back(D);
  }
  return out;
}

struct GpResponse {
  Vec6 stress{};
  Vec6 plasticInc{};
  Mat6 tangent{};
  // Workstream B: the EXACT consistent (algorithmic) tangent for this GP,
  // always populated regardless of the production tangent selector. For an
  // elastic GP this equals C; for an active plastic GP it is the closed-form
  // spectral consistent tangent (Simo-Taylor 1985 / Clausen-Damkilde-Andersen
  // 2007). The Tier-2 rescue assembles K from this, leaving `stress` (the
  // residual) untouched.
  Mat6 consistentTangent{};
  double eta{ 0.0 };
  double equivPlasticInc{ 0.0 };
  std::uint8_t plasticActive{ 0 };
  std::uint8_t tensionActive{ 0 };
  // 1 iff this GP is plastically active AND its consistent-tangent condition
  // is POOR or worse (classify_tangent_quality). Used as a Tier-1 stall
  // diagnostic (trigger (c)); never changes the production path.
  std::uint8_t tangentQualityPoor{ 0 };
};

// Build the exact-return material-parameter bag from the wire-region
// parameters. Defaults mirror JS material-model fallbacks.
inline mc_exact::MaterialParameters material_parameters_from_region(const RegionParams& rp, bool symmetrize) {
  mc_exact::MaterialParameters mp;
  mp.Emc = rp.Emc;
  mp.nu = rp.nu;
  mp.phiEffDeg = rp.phi * 180.0 / M_PI;
  mp.psiEffDeg = rp.psi * 180.0 / M_PI;
  mp.cEff = rp.cEff;
  mp.sigmaTAllow = rp.sigmaTAllow;
  mp.useTensionCutoff = rp.useTensionCutoff != 0u;
  mp.symmetrizeEpTangent = symmetrize;
  return mp;
}

inline double mc_eta_from_stress(const Vec6& stress6, const mc_exact::MaterialParameters& mp) {
  const mc_exact::PrincipalAndValues exact = mc_exact::evaluate_exact_mc_surface_values_from_stress(stress6, mp);
  mc_exact::McTrial trial;
  trial.s1 = exact.principal.s1;
  trial.s2 = exact.principal.s2;
  trial.s3 = exact.principal.s3;
  trial.maxAbsStress = std::max({
      std::abs(stress6[V_XX]), std::abs(stress6[V_YY]), std::abs(stress6[V_ZZ]),
      std::abs(stress6[V_XY]), std::abs(stress6[V_YZ]), std::abs(stress6[V_XZ])});
  const double tol = mc_exact::local_return_tolerance(mp, trial);
  if (exact.values.useTensionCutoff && exact.values.T3 > tol) {
    return std::numeric_limits<double>::infinity();
  }
  const mc_exact::SurfaceParameters sp = mc_exact::exact_mc_surface_parameters(mp);
  const double s1 = exact.principal.s1;
  const double s3 = exact.principal.s3;
  const double rawDenom = (s1 + s3) * sp.sinPhi + 2.0 * sp.c * sp.cosPhi;
  const double denom = std::max(rawDenom, 1e-6);
  return (s1 - s3) / denom;
}

struct SmoothSurfaceValue {
  double f{ 0.0 };
};

inline double smooth_q_scale(const mc_exact::MaterialParameters& mp) {
  const double pRef = std::max(mp.yieldTolerancePref, 1e-6);
  return std::max(1e-8 * pRef, 1e-10);
}

inline std::pair<double, double> pressure_dependent_mc_parameters(double angleDeg, double cohesion) {
  const double angle = mc_exact::clamp_mc_angle_deg(angleDeg) * M_PI / 180.0;
  const double sinA = std::sin(angle);
  const double cosA = std::cos(angle);
  const double denom = std::max(3.0 - sinA, 1e-9);
  return {
    (6.0 * sinA) / denom,
    (6.0 * std::max(cohesion, 0.0) * cosA) / denom
  };
}

inline SmoothSurfaceValue evaluate_smoothed_plastic_surface(
    const Vec6& stress6,
    double angleDeg,
    double cohesion,
    const mc_exact::MaterialParameters& mp,
    bool includeCohesion) {
  const double sxx = -stress6[V_XX];
  const double syy = -stress6[V_YY];
  const double szz = -stress6[V_ZZ];
  const double txy = -stress6[V_XY];
  const double tyz = -stress6[V_YZ];
  const double txz = -stress6[V_XZ];
  const double p = (sxx + syy + szz) / 3.0;
  const double dxx = sxx - p;
  const double dyy = syy - p;
  const double dzz = szz - p;
  const double J2 = 0.5 * (dxx * dxx + dyy * dyy + dzz * dzz +
                           2.0 * (txy * txy + tyz * tyz + txz * txz));
  const double q0 = smooth_q_scale(mp);
  const double q = std::sqrt(std::max(3.0 * J2, 0.0) + q0 * q0) - q0;
  const auto [alpha, kRaw] = pressure_dependent_mc_parameters(
      angleDeg, includeCohesion ? cohesion : 0.0);
  const double k = includeCohesion ? kRaw : 0.0;
  return SmoothSurfaceValue{q - alpha * p - k};
}

inline Vec6 smooth_surface_gradient6(
    const Vec6& stress6,
    double angleDeg,
    double cohesion,
    const mc_exact::MaterialParameters& mp,
    bool includeCohesion) {
  const double sxx = -stress6[V_XX];
  const double syy = -stress6[V_YY];
  const double szz = -stress6[V_ZZ];
  const double txy = -stress6[V_XY];
  const double tyz = -stress6[V_YZ];
  const double txz = -stress6[V_XZ];
  const double p = (sxx + syy + szz) / 3.0;
  const double dxx = sxx - p;
  const double dyy = syy - p;
  const double dzz = szz - p;
  const double J2 = 0.5 * (dxx * dxx + dyy * dyy + dzz * dzz +
                           2.0 * (txy * txy + tyz * tyz + txz * txz));
  const double q0 = smooth_q_scale(mp);
  const double qTilde = std::sqrt(std::max(3.0 * J2, 0.0) + q0 * q0);
  const auto [alpha, unusedK] = pressure_dependent_mc_parameters(
      angleDeg, includeCohesion ? cohesion : 0.0);
  (void)unusedK;
  const double qFactor = qTilde > 1e-12 ? 3.0 / (2.0 * qTilde) : 0.0;
  const Vec6 gComp{
    qFactor * dxx - alpha / 3.0,
    qFactor * dyy - alpha / 3.0,
    qFactor * dzz - alpha / 3.0,
    qFactor * txy,
    qFactor * tyz,
    qFactor * txz
  };
  return Vec6{-gComp[V_XX], -gComp[V_YY], -gComp[V_ZZ],
              -2.0 * gComp[V_XY], -2.0 * gComp[V_YZ], -2.0 * gComp[V_XZ]};
}

inline Mat6 compute_approximate_elastoplastic_tangent(
    const Mat6& De,
    const Vec6& yieldGradient6,
    const Vec6& potentialGradient6,
    const mc_exact::MaterialParameters& mp) {
  const Vec6 Dm = linalg::mul6x6(De, potentialGradient6);
  const Vec6 Dn = linalg::mul6x6(De, yieldGradient6);
  const double denominator = madep::js_mirror::dot_vector6(yieldGradient6, Dm);
  if (!(std::isfinite(denominator) && std::abs(denominator) > 1e-12)) return De;
  const Mat6 outer = madep::js_mirror::outer_product6(Dm, Dn, 1.0 / denominator);
  Mat6 tangent = madep::js_mirror::subtract_matrix6(De, outer);
  return mp.symmetrizeEpTangent ? madep::js_mirror::symmetrize_matrix6(tangent) : tangent;
}

struct SmoothReturnResult {
  bool converged{ false };
  int iterations{ 0 };
  Vec6 stress6{};
  Vec6 plasticStrainIncrement6{};
  Mat6 algorithmicTangent6x6{};
  double yieldResidual{ 0.0 };
};

inline SmoothReturnResult return_map_smooth_mc_plastic(
    const Vec6& stressTrial6,
    const Mat6& elasticTangent6x6,
    const mc_exact::MaterialParameters& mp,
    const mc_exact::McTrial& mcTrial) {
  SmoothReturnResult out;
  Vec6 stress6 = stressTrial6;
  Vec6 deltaPlastic{};
  const double tolerance = std::max(1e-8, mc_exact::local_return_tolerance(mp, mcTrial));
  const int maxIterations = 40;
  const SmoothSurfaceValue smoothTrial = evaluate_smoothed_plastic_surface(
      stressTrial6, mp.phiEffDeg, mp.cEff, mp, true);
  if (std::abs(smoothTrial.f) <= tolerance) {
    const Vec6 n = smooth_surface_gradient6(stressTrial6, mp.phiEffDeg, mp.cEff, mp, true);
    const Vec6 m = smooth_surface_gradient6(stressTrial6, mp.psiEffDeg, 0.0, mp, false);
    out.converged = true;
    out.iterations = 0;
    out.stress6 = stress6;
    out.plasticStrainIncrement6 = deltaPlastic;
    out.algorithmicTangent6x6 = compute_approximate_elastoplastic_tangent(elasticTangent6x6, n, m, mp);
    out.yieldResidual = smoothTrial.f;
    return out;
  }

  for (int iteration = 1; iteration <= maxIterations; ++iteration) {
    const SmoothSurfaceValue current = evaluate_smoothed_plastic_surface(
        stress6, mp.phiEffDeg, mp.cEff, mp, true);
    const double fCurrent = current.f;
    if (std::abs(fCurrent) <= tolerance) {
      const Vec6 n = smooth_surface_gradient6(stress6, mp.phiEffDeg, mp.cEff, mp, true);
      const Vec6 m = smooth_surface_gradient6(stress6, mp.psiEffDeg, 0.0, mp, false);
      out.converged = true;
      out.iterations = iteration;
      out.stress6 = stress6;
      out.plasticStrainIncrement6 = deltaPlastic;
      out.algorithmicTangent6x6 = compute_approximate_elastoplastic_tangent(elasticTangent6x6, n, m, mp);
      out.yieldResidual = fCurrent;
      return out;
    }

    const Vec6 n = smooth_surface_gradient6(stress6, mp.phiEffDeg, mp.cEff, mp, true);
    const Vec6 m = smooth_surface_gradient6(stress6, mp.psiEffDeg, 0.0, mp, false);
    const Vec6 flowStressDirection = linalg::mul6x6(elasticTangent6x6, m);
    const double denominator = madep::js_mirror::dot_vector6(n, flowStressDirection);
    if (!(std::isfinite(denominator) && denominator > 1e-12)) {
      out.yieldResidual = fCurrent;
      return out;
    }
    const double deltaLambda = fCurrent / denominator;
    if (!(std::isfinite(deltaLambda) && deltaLambda >= 0.0)) {
      out.yieldResidual = fCurrent;
      return out;
    }

    bool haveBest = false;
    Vec6 bestStress{};
    Vec6 bestPlasticInc{};
    double bestF = 0.0;
    bool accepted = false;
    Vec6 acceptedStress{};
    Vec6 acceptedPlasticInc{};
    double acceptedF = 0.0;
    double stepScale = 1.0;
    for (int damping = 0; damping < 12; ++damping, stepScale *= 0.5) {
      const double effectiveDeltaLambda = deltaLambda * stepScale;
      if (!(effectiveDeltaLambda > 0.0)) continue;
      const Vec6 candidateStress = linalg::sub(
          stress6, linalg::scale(flowStressDirection, effectiveDeltaLambda));
      const double fCandidate = evaluate_smoothed_plastic_surface(
          candidateStress, mp.phiEffDeg, mp.cEff, mp, true).f;
      if (!std::isfinite(fCandidate)) continue;
      if (!haveBest || std::abs(fCandidate) < std::abs(bestF)) {
        haveBest = true;
        bestStress = candidateStress;
        bestF = fCandidate;
        bestPlasticInc = linalg::scale(m, effectiveDeltaLambda);
      }
      const double armijoTarget =
          (1.0 - 1e-4 * stepScale) * std::abs(fCurrent);
      if (std::abs(fCandidate) <= tolerance || std::abs(fCandidate) <= armijoTarget) {
        accepted = true;
        acceptedStress = candidateStress;
        acceptedPlasticInc = linalg::scale(m, effectiveDeltaLambda);
        acceptedF = fCandidate;
        break;
      }
    }
    const Vec6 nextStress = accepted ? acceptedStress : bestStress;
    const Vec6 nextPlasticInc = accepted ? acceptedPlasticInc : bestPlasticInc;
    const double nextF = accepted ? acceptedF : bestF;
    if ((!accepted && !haveBest) ||
        !(std::abs(nextF) < std::abs(fCurrent) - 1e-12 || std::abs(nextF) <= tolerance)) {
      out.yieldResidual = fCurrent;
      return out;
    }
    stress6 = nextStress;
    deltaPlastic = linalg::add(deltaPlastic, nextPlasticInc);
  }

  out.yieldResidual = evaluate_smoothed_plastic_surface(
      stress6, mp.phiEffDeg, mp.cEff, mp, true).f;
  return out;
}

struct GpResponseExtra {
  std::uint8_t exactBranchKind{ 0 };
  std::uint8_t multiplicityKind{ 0 };
  std::uint8_t stateChanged{ 0 };
  std::uint8_t hasRepresentativeProjectors{ 0 };
  std::uint8_t localReturnMode{ 0 };
  std::uint8_t localFallbackUsed{ 0 };
  std::uint8_t mcTangentMode{ 0 };
  std::array<std::array<double, 3>, 3> repP1{};
  std::array<std::array<double, 3>, 3> repP2{};
  std::array<std::array<double, 3>, 3> repP3{};
  // Hardening Soil per-GP state output. Populated when the constitutive
  // kind is HardeningSoil; left at the committed defaults otherwise.
  MaterialPoint::HsState hsState{};
  std::uint16_t hsFailureCode{ 0 };
  // Phase 5: number of outer σ_zz Newton iterations consumed by the
  // plane-strain wrapper around the HS return mapping (B.7). Set by HS
  // dispatch; left at 0 for other constitutive kinds.
  std::uint8_t hsSigmaZzIterations{ 0 };
};

// Evaluate the constitutive response at a single Gauss point. Treats
// `committed` as the converged state at the start of the current load
// step and `previousTrial` as the last trial state for branch-cache
// selection, matching the JS plugin contract.
inline GpResponse evaluate_gp_response_ex(
    ConstitutiveKind kind,
    const Mat6& C,
    const RegionParams& rp,
    const MaterialPoint* previousTrial,
    const MaterialPoint& committed,
    const Vec6& strainTotal,
    bool symmetrize,
    GpResponseExtra& extra) {
  GpResponse out;
  const Vec6 dStrain = linalg::sub(strainTotal, committed.totalStrain);

  if (kind == ConstitutiveKind::LinearElastic) {
    out.tangent = C;
    out.consistentTangent = C;
    const Vec6 dSigma = linalg::mul6x6(C, dStrain);
    out.stress = linalg::add(committed.effectiveStress, dSigma);
    extra.exactBranchKind = static_cast<std::uint8_t>(mc_exact::BranchKind::ELASTIC);
    extra.multiplicityKind = static_cast<std::uint8_t>(mc_exact::MultiplicityKind::DISTINCT);
    extra.localReturnMode = 0;
    extra.stateChanged = 0;
    return out;
  }

  if (kind == ConstitutiveKind::HardeningSoil) {
    // Phase 5 plane-strain dispatch. The HS update receives the trial
    // strain (committed + dStrain), the committed stress + HS state, and
    // returns updated stress, plastic-strain increment, tangent, and HS
    // state. Region constants (M_cap, H_cap, sin_phi_cv) must have been
    // pre-computed by the caller via
    // material::hs::compute_hs_reference_constants(region, sigmaMsf).
    //
    // `update_plane_strain` wraps the inner `update` with the B.7 outer
    // Newton on σ_zz, enforcing the plane-strain Δε_zz = 0 constraint on
    // the constitutive response. The MC dispatch is naturally plane-strain
    // consistent through its 6-Voigt return; HS's principal-frame return
    // requires the explicit wrapper per the spec §3.7.
    //
    // Phase 7 (c-φ safety): the σ_Msf reduction is applied UPSTREAM by
    // the solver (`reduce_strength` in prepare_*_materials), which mutates
    // region.cEff, region.phi, region.psi, region.sigmaTAllow to their
    // reduced values, and `recompute_hs_constants_for_reduced_regions`
    // re-calibrates M_cap/H_cap/sin_phi_cv on those reduced fields. By
    // the time `update_plane_strain` is called, the region's strength
    // and derived constants ALREADY reflect σ_Msf, so we pass 1.0 here
    // to avoid double-reduction. Geostatic and service phases never
    // reduce, so 1.0 is also correct there.
    const std::uint8_t hsActiveSetHint = previousTrial
        ? previousTrial->hs.lastActiveSet
        : committed.hs.lastActiveSet;
    const material::hs::HsUpdateResult hsRes = material::hs::update_plane_strain(
        strainTotal, committed.totalStrain, committed.effectiveStress,
        committed.hs, rp, 1.0, hsActiveSetHint);
    if (hsRes.failureCode == 999) {
      // Phase 3 corner case — surface a clear marker; outer Newton
      // should cut back the load step.
      extra.hsFailureCode = 999;
    } else if (hsRes.failureCode != 0) {
      extra.hsFailureCode = hsRes.failureCode;
    }
    extra.hsSigmaZzIterations = hsRes.sigmaZzIterations;
    out.tangent = hsRes.tangent;
    out.consistentTangent = hsRes.tangent;
    out.stress = hsRes.stressUpdated;
    out.plasticInc = hsRes.plasticIncrement;
    // Phase 2 (fix plan): compute plastic/tension flags from the RAW
    // active set {0..7}; never collapse before the solver has accounted
    // for both. Internal active-set contract:
    //   0 elastic
    //   1 cone, 2 cap, 3 cone+cap (corner)
    //   4 tension
    //   5 tension+cone, 6 tension+cap, 7 tension+cone+cap
    // update_plane_strain preserves the raw value; this dispatch derives
    // flags from it directly.
    const std::uint8_t raw = hsRes.activeSurface;
    const bool plasticActive = raw == 1 || raw == 2 || raw == 3 ||
                               raw == 5 || raw == 6 || raw == 7;
    const bool tensionActive = raw == 4 || raw == 5 || raw == 6 || raw == 7;
    out.plasticActive = plasticActive ? 1u : 0u;
    out.tensionActive = tensionActive ? 1u : 0u;
    // Reuse the MC equivalent-plastic-strain formula on the same strain
    // increment so the existing `accumulatedPlasticStrain` field stays
    // meaningful for HS as well.
    out.equivPlasticInc =
        madep::js_mirror::equivalent_plastic_strain_increment(hsRes.plasticIncrement);
    // HS mobilisation ratio (spec §5.5.2): η_MC = sin(φ_mob) / sin(φ_eff) ∈ [0, 1].
    // The existing `mcEta` contour mode reads `eta` and aggregates it on the
    // canvas (build-result.js lines 248-251, contour mode 'mcEta'). HS must
    // populate it from the principal decomposition of the corrected stress
    // so that an HS analysis renders mobilisation just like MC does — the
    // alternative (eta = 0) shows a flat-zero contour on the canvas, which
    // matched the user-reported "all 0" symptom for HS runs.
    {
      const mc_exact::MaterialParameters mp_eta = material::hs::make_mp_for_eig(
          rp, std::max(rp.cEff, 0.0), std::max(rp.phi, 0.0));
      const auto pr_for_eta = mc_exact::principal_stress_projectors_3d_compression_positive(
          hsRes.stressUpdated, mp_eta);
      const double s_phi = std::sin(std::max(rp.phi, 0.0));
      if (s_phi > 1e-9) {
        const double s_mob = material::hs::mobilised_sin_phi(
            pr_for_eta.s1, pr_for_eta.s3,
            std::max(rp.cEff, 0.0),
            std::max(rp.phi, 0.0));
        out.eta = std::clamp(s_mob / s_phi, 0.0, 1.0);
      } else {
        out.eta = 0.0;
      }
    }
    extra.exactBranchKind = static_cast<std::uint8_t>(mc_exact::BranchKind::ELASTIC);
    extra.multiplicityKind = static_cast<std::uint8_t>(mc_exact::MultiplicityKind::DISTINCT);
    extra.localReturnMode = (hsRes.activeSurface != 0) ? 1u : 0u;
    extra.stateChanged =
        (committed.hs.lastActiveSet != hsRes.stateUpdated.lastActiveSet) ? 1u : 0u;
    extra.hsState = hsRes.stateUpdated;
    extra.hsState.tangentMode = static_cast<std::uint8_t>(hsRes.tangentMode);
    return out;
  }

  (void)symmetrize;
  const bool materialSymmetrize = rp.symmetrize != 0u;
  const bool mcUseConsistentTangent = rp.hs.useConsistentTangent >= 0.5;
  const mc_exact::MaterialParameters mp = material_parameters_from_region(rp, materialSymmetrize);

  if (kind == ConstitutiveKind::McReducedStiffness) {
    const Vec6 elasticTrial = linalg::add(committed.effectiveStress, linalg::mul6x6(C, dStrain));
    const mc_exact::PrincipalAndValues exactTrial =
        mc_exact::evaluate_exact_mc_surface_values_from_stress(elasticTrial, mp);
    mc_exact::McTrial mcTrial;
    mcTrial.s1 = exactTrial.principal.s1;
    mcTrial.s2 = exactTrial.principal.s2;
    mcTrial.s3 = exactTrial.principal.s3;
    mcTrial.maxAbsStress = std::max({
        std::abs(elasticTrial[V_XX]), std::abs(elasticTrial[V_YY]), std::abs(elasticTrial[V_ZZ]),
        std::abs(elasticTrial[V_XY]), std::abs(elasticTrial[V_YZ]), std::abs(elasticTrial[V_XZ])});
    const double yieldTol = mc_exact::local_return_tolerance(mp, mcTrial);
    const double maxShearViolation = std::max({0.0, exactTrial.values.F12, exactTrial.values.F13, exactTrial.values.F23});
    const bool previousTrialActive = previousTrial && previousTrial->currentlyMcActive != 0u;
    const bool retainedActive = committed.currentlyMcActive != 0u || previousTrialActive;
    const bool currentlyActive = retainedActive || maxShearViolation > yieldTol;
    Mat6 reduced = build_region_reduced_elastic(std::vector<RegionParams>{rp})[0];
    out.tangent = currentlyActive ? reduced : C;
    out.consistentTangent = out.tangent;
    out.stress = currentlyActive
        ? linalg::add(committed.effectiveStress, linalg::mul6x6(reduced, dStrain))
        : elasticTrial;
    out.eta = mc_eta_from_stress(out.stress, mp);
    out.plasticActive = currentlyActive ? 1u : 0u;
    out.tensionActive = 0u;
    out.equivPlasticInc = 0.0;
    extra.exactBranchKind = currentlyActive
        ? static_cast<std::uint8_t>(mc_exact::BranchKind::FACE_F13)
        : static_cast<std::uint8_t>(mc_exact::BranchKind::ELASTIC);
    extra.multiplicityKind = static_cast<std::uint8_t>(mc_exact::MultiplicityKind::DISTINCT);
    extra.localReturnMode = currentlyActive ? 1u : 0u;
    extra.stateChanged = (committed.currentlyMcActive != out.plasticActive) ? 1u : 0u;
    return out;
  }

  const Vec6 stressTrial = linalg::add(committed.effectiveStress, linalg::mul6x6(C, dStrain));
  const mc_exact::PrincipalAndValues exactTrial =
      mc_exact::evaluate_exact_mc_surface_values_from_stress(stressTrial, mp);
  mc_exact::McTrial mcTrial;
  mcTrial.s1 = exactTrial.principal.s1;
  mcTrial.s2 = exactTrial.principal.s2;
  mcTrial.s3 = exactTrial.principal.s3;
  mcTrial.maxAbsStress = std::max({
      std::abs(stressTrial[V_XX]), std::abs(stressTrial[V_YY]), std::abs(stressTrial[V_ZZ]),
      std::abs(stressTrial[V_XY]), std::abs(stressTrial[V_YZ]), std::abs(stressTrial[V_XZ])});

  mc_exact::CommittedStateSummary committedSummary;
  committedSummary.exactBranchKind = static_cast<mc_exact::BranchKind>(committed.exactBranchKind);
  committedSummary.multiplicityKind = static_cast<mc_exact::MultiplicityKind>(committed.multiplicityKind);
  committedSummary.activeYieldSurface = committed.plasticActive
      ? mc_exact::active_yield_surface_from_branch_kind(committedSummary.exactBranchKind)
      : madep::js_mirror::YieldSurface::NONE;
  committedSummary.hasRepresentativeProjectors = committed.hasRepresentativeProjectors != 0u;
  committedSummary.representativeProjectors.P1 = committed.repP1;
  committedSummary.representativeProjectors.P2 = committed.repP2;
  committedSummary.representativeProjectors.P3 = committed.repP3;

  mc_exact::PreviousTrialSummary previousSummary;
  if (previousTrial && previousTrial->plasticActive) {
    previousSummary.hasExactBranchKind = true;
    previousSummary.exactBranchKind = static_cast<mc_exact::BranchKind>(previousTrial->exactBranchKind);
    previousSummary.activeYieldSurface =
        mc_exact::active_yield_surface_from_branch_kind(previousSummary.exactBranchKind);
  }

  bool usedSmoothFallback = false;
  SmoothReturnResult smooth;
  const double yieldTol = mc_exact::local_return_tolerance(mp, mcTrial);
  const double exactTrialMaxResidual = std::max({
      0.0, exactTrial.values.F12, exactTrial.values.F13, exactTrial.values.F23,
      (exactTrial.values.useTensionCutoff ? exactTrial.values.T3 : 0.0)});
  const bool committedHasRetainableExactBranch =
      !mc_exact::active_surface_ids_for_branch_kind(committedSummary.exactBranchKind).empty() &&
      committedSummary.activeYieldSurface != madep::js_mirror::YieldSurface::NONE;
  const bool committedHasRetainableSmoothFallback =
      committed.currentlyMcActive != 0u &&
      committed.localReturnMode == 2u &&
      exactTrial.values.T3 <= yieldTol;

  if (!(exactTrialMaxResidual > yieldTol) &&
      !committedHasRetainableExactBranch &&
      !committedHasRetainableSmoothFallback) {
    out.stress = stressTrial;
    out.plasticInc = Vec6{};
    out.tangent = C;
    out.consistentTangent = C;
    out.plasticActive = 0u;
    out.tensionActive = 0u;
    out.eta = mc_eta_from_stress(stressTrial, mp);
    out.equivPlasticInc = 0.0;
    extra.exactBranchKind = static_cast<std::uint8_t>(mc_exact::BranchKind::ELASTIC);
    extra.multiplicityKind = static_cast<std::uint8_t>(mc_exact::MultiplicityKind::DISTINCT);
    extra.hasRepresentativeProjectors = 1u;
    extra.repP1 = exactTrial.principal.P1;
    extra.repP2 = exactTrial.principal.P2;
    extra.repP3 = exactTrial.principal.P3;
    extra.localReturnMode = 0u;
    extra.localFallbackUsed = 0u;
    extra.stateChanged = 0u;
    return out;
  }

  mc_exact::ActiveSetReturnResult local;
  if (committedHasRetainableSmoothFallback) {
    smooth = return_map_smooth_mc_plastic(stressTrial, C, mp, mcTrial);
    usedSmoothFallback = smooth.converged;
  } else {
    local = mc_exact::solve_exact_mc_active_set_return(
        stressTrial, C, mp, mcTrial,
        &committedSummary,
        previousSummary.hasExactBranchKind ? &previousSummary : nullptr);
  }

  if (!committedHasRetainableSmoothFallback && !local.converged) {
    const bool canAttemptSmoothFallback =
        exactTrial.values.T3 <= yieldTol &&
        !(exactTrial.values.useTensionCutoff && exactTrial.values.T3 > yieldTol);
    if (canAttemptSmoothFallback) {
      smooth = return_map_smooth_mc_plastic(stressTrial, C, mp, mcTrial);
      usedSmoothFallback = smooth.converged;
    }
  }

  if (usedSmoothFallback) {
    out.stress = smooth.stress6;
    out.plasticInc = smooth.plasticStrainIncrement6;
    out.tangent = mcUseConsistentTangent ? smooth.algorithmicTangent6x6 : C;
    out.consistentTangent = smooth.algorithmicTangent6x6;
    out.equivPlasticInc = madep::js_mirror::equivalent_plastic_strain_increment(out.plasticInc);
    out.eta = mc_eta_from_stress(out.stress, mp);
    out.plasticActive = 1u;
    out.tensionActive = 0u;
    const mc_exact::BranchKind retainedBranch =
        mc_exact::active_surface_ids_for_branch_kind(committedSummary.exactBranchKind).empty()
            ? mc_exact::BranchKind::FACE_F13
            : committedSummary.exactBranchKind;
    extra.exactBranchKind = static_cast<std::uint8_t>(retainedBranch);
    extra.multiplicityKind = static_cast<std::uint8_t>(madep::js_mirror::MultiplicityKind::DISTINCT);
    extra.hasRepresentativeProjectors = committed.hasRepresentativeProjectors;
    extra.repP1 = committed.repP1;
    extra.repP2 = committed.repP2;
    extra.repP3 = committed.repP3;
    extra.localReturnMode = 2u;
    extra.localFallbackUsed = 1u;
    extra.mcTangentMode = mcUseConsistentTangent ? 1u : 0u;
    extra.stateChanged = (committed.exactBranchKind != extra.exactBranchKind) ? 1u : 0u;
    return out;
  }

  if (!local.converged) {
    out.stress = stressTrial;
    out.plasticInc = Vec6{};
    out.tangent = C;
    out.consistentTangent = C;
    out.plasticActive = 0u;
    out.tensionActive = 0u;
    out.eta = mc_eta_from_stress(stressTrial, mp);
    out.equivPlasticInc = 0.0;
    extra.exactBranchKind = static_cast<std::uint8_t>(mc_exact::BranchKind::ELASTIC);
    extra.multiplicityKind = static_cast<std::uint8_t>(mc_exact::MultiplicityKind::DISTINCT);
    extra.localReturnMode = 0;
    extra.stateChanged = 1u;
    return out;
  }

  const bool finalIsPlasticActive =
      local.activeYieldSurface == madep::js_mirror::YieldSurface::MC_FACE ||
      local.activeYieldSurface == madep::js_mirror::YieldSurface::MC_EDGE ||
      local.activeYieldSurface == madep::js_mirror::YieldSurface::MC_APEX ||
      local.activeYieldSurface == madep::js_mirror::YieldSurface::TENSION;

  out.stress = local.stress6_tens;
  out.plasticInc = local.plasticStrainIncrement6;
  out.tangent = mcUseConsistentTangent ? local.algorithmicTangent6x6 : C;
  out.consistentTangent = local.algorithmicTangent6x6;
  out.tangentQualityPoor =
      (finalIsPlasticActive &&
       local.tangentQuality <= mc_exact::TangentQuality::POOR) ? 1u : 0u;
  out.plasticActive = finalIsPlasticActive ? 1u : 0u;
  out.tensionActive = mc_exact::is_tension_branch_kind(local.acceptedBranchKind) ? 1u : 0u;
  out.equivPlasticInc = madep::js_mirror::equivalent_plastic_strain_increment(local.plasticStrainIncrement6);
  out.eta = mc_eta_from_stress(local.stress6_tens, mp);
  extra.exactBranchKind = static_cast<std::uint8_t>(local.acceptedBranchKind);
  extra.multiplicityKind = static_cast<std::uint8_t>(local.finalMultiplicityKind);
  extra.hasRepresentativeProjectors = 1u;
  extra.repP1 = local.representativeProjectors.P1;
  extra.repP2 = local.representativeProjectors.P2;
  extra.repP3 = local.representativeProjectors.P3;
  extra.localReturnMode = 1u;
  extra.localFallbackUsed = 0u;
  extra.mcTangentMode = mcUseConsistentTangent ? 1u : 0u;
  extra.stateChanged = (committed.exactBranchKind != extra.exactBranchKind) ? 1u : 0u;
  return out;
}

// Back-compat shim — keeps the existing solver code compiling while we
// migrate callers to the _ex variant. Bypasses previous-trial caching;
// only used by paths that haven't been refactored yet.
inline GpResponse evaluate_gp_response(
    ConstitutiveKind kind,
    const Mat6& C,
    const RegionParams& rp,
    const MaterialPoint& committed,
    const Vec6& strainTotal,
    bool symmetrize) {
  GpResponseExtra extra;
  return evaluate_gp_response_ex(kind, C, rp, nullptr, committed, strainTotal, symmetrize, extra);
}

struct AssembleOutput {
  double residualNorm{ 0.0 };
  double rhsNorm{ 0.0 };
  std::int32_t plasticActiveCount{ 0 };
  std::int32_t activeFaceCount{ 0 };
  std::int32_t activeEdgeCount{ 0 };
  std::int32_t activeApexCount{ 0 };
  std::int32_t tensionCount{ 0 };
  std::int32_t changedCount{ 0 };
  double maxEta{ 0.0 };
  // Workstream B: 1 iff any active plastic GP reported a POOR-or-worse
  // consistent-tangent condition (Tier-1 stall diagnostic, trigger (c)).
  std::uint8_t worstTangentPoor{ 0 };
  // Phase 5: HS-specific diagnostics. `hsFailureCode` is the highest
  // failure code reported by any HS GP this assembly; nonzero values
  // (101=cone, 102=cap, 103=corner, 104=triple-apex, 105=σ_zz) signal a
  // local-return non-convergence that must trigger an outer FE step
  // cutback. σ_zz iteration counts let verifiers audit B.7 convergence.
  std::uint16_t hsFailureCode{ 0 };
  std::int32_t hsActiveCount{ 0 };          // GPs with HS cone/cap/corner active
  std::int32_t hsConeOnlyCount{ 0 };        // surface == 1
  std::int32_t hsCapOnlyCount{ 0 };         // surface == 2
  std::int32_t hsCornerCount{ 0 };          // surface == 3
  std::int32_t hsTensionMixCount{ 0 };      // surface == 4/5/6/7
  std::int32_t hsSigmaZzIterSum{ 0 };       // sum across active HS GPs
  std::int32_t hsSigmaZzMaxIter{ 0 };       // peak across active HS GPs
  std::int32_t hsCapIterSum{ 0 };           // σ_zz iter sum on cap-only GPs
  std::int32_t hsCapIterCount{ 0 };
  std::int32_t hsConeIterSum{ 0 };
  std::int32_t hsConeIterCount{ 0 };
  std::int32_t hsCornerIterSum{ 0 };
  std::int32_t hsCornerIterCount{ 0 };
};

enum class BeamAssemblyMode : std::uint8_t {
  Active = 0,
  InactiveStabilizeRotations = 1
};

inline std::vector<std::array<std::int32_t, 3>> build_wall_preconditioner_triplets(
    const std::vector<BeamElementCache>* beamElements,
    const std::vector<std::int32_t>& freeIndexByDof,
    BeamAssemblyMode beamMode) {
  std::vector<std::array<std::int32_t, 3>> triplets;
  if (!beamElements || beamMode != BeamAssemblyMode::Active) return triplets;
  triplets.reserve(beamElements->size() * 2);
  auto add_node = [&](const BeamElementCache& beamEl, int offset) {
    const std::int32_t uxDof = beamEl.dofs[static_cast<std::size_t>(offset + 0)];
    const std::int32_t uyDof = beamEl.dofs[static_cast<std::size_t>(offset + 1)];
    const std::int32_t thDof = beamEl.dofs[static_cast<std::size_t>(offset + 2)];
    if (uxDof < 0 || uyDof < 0 || thDof < 0 ||
        uxDof >= static_cast<std::int32_t>(freeIndexByDof.size()) ||
        uyDof >= static_cast<std::int32_t>(freeIndexByDof.size()) ||
        thDof >= static_cast<std::int32_t>(freeIndexByDof.size())) {
      return;
    }
    const std::int32_t ux = freeIndexByDof[static_cast<std::size_t>(uxDof)];
    const std::int32_t uy = freeIndexByDof[static_cast<std::size_t>(uyDof)];
    const std::int32_t th = freeIndexByDof[static_cast<std::size_t>(thDof)];
    if (ux < 0 || uy < 0 || th < 0) return;
    triplets.push_back({ux, uy, th});
  };
  for (const auto& beamEl : *beamElements) {
    add_node(beamEl, 0);
    add_node(beamEl, 3);
  }
  std::sort(triplets.begin(), triplets.end());
  triplets.erase(std::unique(triplets.begin(), triplets.end()), triplets.end());
  return triplets;
}

inline std::vector<std::vector<std::int32_t>> build_wall_preconditioner_blocks(
    const std::vector<BeamElementCache>* beamElements,
    const std::vector<std::int32_t>& freeIndexByDof,
    BeamAssemblyMode beamMode) {
  struct NodeBlock {
    std::int32_t wallIndex{ -1 };
    std::int32_t station{ -1 };
    std::array<std::int32_t, 3> free{{-1, -1, -1}};
  };
  std::vector<NodeBlock> nodes;
  if (!beamElements || beamMode != BeamAssemblyMode::Active) return {};
  nodes.reserve(beamElements->size() * 2);
  auto free_index = [&](std::int32_t dof) {
    if (dof < 0 || dof >= static_cast<std::int32_t>(freeIndexByDof.size())) return std::int32_t{-1};
    return freeIndexByDof[static_cast<std::size_t>(dof)];
  };
  auto add_node = [&](const BeamElementCache& beamEl, std::int32_t station, int offset) {
    NodeBlock node;
    node.wallIndex = beamEl.wallIndex;
    node.station = station;
    node.free[0] = free_index(beamEl.dofs[static_cast<std::size_t>(offset + 0)]);
    node.free[1] = free_index(beamEl.dofs[static_cast<std::size_t>(offset + 1)]);
    node.free[2] = free_index(beamEl.dofs[static_cast<std::size_t>(offset + 2)]);
    if (node.free[0] >= 0 || node.free[1] >= 0 || node.free[2] >= 0) nodes.push_back(node);
  };
  for (const auto& beamEl : *beamElements) {
    add_node(beamEl, beamEl.stationA, 0);
    add_node(beamEl, beamEl.stationB, 3);
  }
  std::sort(nodes.begin(), nodes.end(), [](const NodeBlock& a, const NodeBlock& b) {
    if (a.wallIndex != b.wallIndex) return a.wallIndex < b.wallIndex;
    return a.station < b.station;
  });

  std::vector<NodeBlock> uniqueNodes;
  for (const auto& node : nodes) {
    if (!uniqueNodes.empty() &&
        uniqueNodes.back().wallIndex == node.wallIndex &&
        uniqueNodes.back().station == node.station) {
      for (int k = 0; k < 3; ++k) {
        if (uniqueNodes.back().free[k] < 0) uniqueNodes.back().free[k] = node.free[k];
      }
    } else {
      uniqueNodes.push_back(node);
    }
  }

  std::vector<std::vector<std::int32_t>> blocks;
  std::int32_t currentWall = std::numeric_limits<std::int32_t>::min();
  std::vector<std::int32_t> current;
  auto flush = [&]() {
    if (current.size() >= 3) blocks.push_back(current);
    current.clear();
  };
  for (const auto& node : uniqueNodes) {
    if (node.wallIndex != currentWall) {
      flush();
      currentWall = node.wallIndex;
    }
    for (int k = 0; k < 3; ++k) {
      if (node.free[k] >= 0) current.push_back(node.free[k]);
    }
  }
  flush();
  return blocks;
}

// Build the wall rigid-body coarse space Z (workstream A1).
//
// Per active straight wall with centroid (xc,yc), up to 3 deterministic
// columns sampled on the wall DOFs and their 1-ring soil-node neighbours:
//   (a) t_x: ux = 1 on {wall ∪ adjacent soil nodes};
//   (b) t_y: uy = 1 on the same set;
//   (c) r  : ux = -(y-yc), uy = (x-xc), theta_z = 1 on the wall nodes
//            (consistent in-plane rigid rotation).
// Columns with no free entries are dropped. The wall nodes are taken from the
// same beam DOF data the preconditioner blocks use, so the space is
// deterministic. Rank-deficient columns are tolerated by the guarded SPD
// factorisation of Kc downstream.
inline sparse::WallCoarseSpace build_wall_coarse_space(
    const std::vector<ElementCache>& elements,
    const std::vector<BeamElementCache>* beamElements,
    const std::vector<std::int32_t>& freeIndexByDof,
    BeamAssemblyMode beamMode,
    std::int32_t nfree) {
  sparse::WallCoarseSpace Z;
  Z.n = nfree;
  if (!beamElements || beamElements->empty() || beamMode != BeamAssemblyMode::Active) {
    return Z;
  }
  auto free_index = [&](std::int32_t dof) -> std::int32_t {
    if (dof < 0 || dof >= static_cast<std::int32_t>(freeIndexByDof.size())) return -1;
    return freeIndexByDof[static_cast<std::size_t>(dof)];
  };

  struct WNode {
    std::int32_t wallIndex{ -1 };
    std::int32_t nodeId{ -1 };
    double x{ 0.0 };
    double y{ 0.0 };
    std::int32_t uxDof{ -1 };
    std::int32_t uyDof{ -1 };
    std::int32_t thDof{ -1 };
  };
  std::vector<WNode> wallNodes;
  wallNodes.reserve(beamElements->size() * 2);
  for (const auto& be : *beamElements) {
    wallNodes.push_back({be.wallIndex, be.nodeA, be.xA, be.yA,
                         be.dofs[0], be.dofs[1], be.dofs[2]});
    wallNodes.push_back({be.wallIndex, be.nodeB, be.xB, be.yB,
                         be.dofs[3], be.dofs[4], be.dofs[5]});
  }
  std::sort(wallNodes.begin(), wallNodes.end(), [](const WNode& a, const WNode& b) {
    if (a.wallIndex != b.wallIndex) return a.wallIndex < b.wallIndex;
    return a.nodeId < b.nodeId;
  });
  wallNodes.erase(std::unique(wallNodes.begin(), wallNodes.end(),
      [](const WNode& a, const WNode& b) {
        return a.wallIndex == b.wallIndex && a.nodeId == b.nodeId;
      }), wallNodes.end());
  if (wallNodes.empty()) return Z;

  // nodeId -> wallIndex lookup for wall nodes (sorted by nodeId for bsearch).
  std::vector<std::pair<std::int32_t, std::int32_t>> nodeToWall;
  nodeToWall.reserve(wallNodes.size());
  for (const auto& wn : wallNodes) nodeToWall.push_back({wn.nodeId, wn.wallIndex});
  std::sort(nodeToWall.begin(), nodeToWall.end());
  auto wall_of_node = [&](std::int32_t nodeId) -> std::int32_t {
    auto it = std::lower_bound(nodeToWall.begin(), nodeToWall.end(),
                               std::make_pair(nodeId, std::numeric_limits<std::int32_t>::min()));
    if (it != nodeToWall.end() && it->first == nodeId) return it->second;
    return -1;
  };

  // Distinct walls (sorted).
  std::vector<std::int32_t> walls;
  for (const auto& wn : wallNodes) {
    if (walls.empty() || walls.back() != wn.wallIndex) walls.push_back(wn.wallIndex);
  }
  auto wall_slot = [&](std::int32_t wallIndex) -> int {
    auto it = std::lower_bound(walls.begin(), walls.end(), wallIndex);
    if (it != walls.end() && *it == wallIndex) return static_cast<int>(it - walls.begin());
    return -1;
  };

  // 1-ring soil neighbour node ids per wall (any soil-element node sharing an
  // element with one of that wall's nodes; the wall nodes themselves are
  // included and deduplicated below).
  std::vector<std::vector<std::int32_t>> neighbourNodes(walls.size());
  for (const auto& el : elements) {
    bool touches = false;
    for (int i = 0; i < el.numNodes; ++i) {
      if (wall_of_node(el.nodeIds[static_cast<std::size_t>(i)]) >= 0) { touches = true; break; }
    }
    if (!touches) continue;
    // Collect the distinct walls this element touches, then add all its nodes.
    for (int i = 0; i < el.numNodes; ++i) {
      const std::int32_t w = wall_of_node(el.nodeIds[static_cast<std::size_t>(i)]);
      if (w < 0) continue;
      const int slot = wall_slot(w);
      if (slot < 0) continue;
      for (int j = 0; j < el.numNodes; ++j) {
        neighbourNodes[static_cast<std::size_t>(slot)].push_back(
            el.nodeIds[static_cast<std::size_t>(j)]);
      }
    }
  }
  for (auto& list : neighbourNodes) {
    std::sort(list.begin(), list.end());
    list.erase(std::unique(list.begin(), list.end()), list.end());
  }

  // Build the columns wall by wall.
  for (std::size_t s = 0; s < walls.size(); ++s) {
    const std::int32_t wallIndex = walls[s];
    // Wall nodes of this wall (contiguous in the sorted list).
    double xc = 0.0, yc = 0.0;
    int count = 0;
    for (const auto& wn : wallNodes) {
      if (wn.wallIndex != wallIndex) continue;
      xc += wn.x; yc += wn.y; ++count;
    }
    if (count <= 0) continue;
    xc /= count; yc /= count;

    sparse::CoarseColumn tx, ty, rot;
    // Translation columns over wall nodes ∪ 1-ring soil neighbours.
    for (std::int32_t nodeId : neighbourNodes[s]) {
      const std::int32_t fx = free_index(2 * nodeId + 0);
      const std::int32_t fy = free_index(2 * nodeId + 1);
      if (fx >= 0) { tx.rows.push_back(fx); tx.vals.push_back(1.0); }
      if (fy >= 0) { ty.rows.push_back(fy); ty.vals.push_back(1.0); }
    }
    // Rotation column over wall nodes only.
    for (const auto& wn : wallNodes) {
      if (wn.wallIndex != wallIndex) continue;
      const std::int32_t fx = free_index(wn.uxDof);
      const std::int32_t fy = free_index(wn.uyDof);
      const std::int32_t ft = free_index(wn.thDof);
      if (fx >= 0) { rot.rows.push_back(fx); rot.vals.push_back(-(wn.y - yc)); }
      if (fy >= 0) { rot.rows.push_back(fy); rot.vals.push_back(wn.x - xc); }
      if (ft >= 0) { rot.rows.push_back(ft); rot.vals.push_back(1.0); }
    }
    if (!tx.rows.empty()) Z.columns.push_back(std::move(tx));
    if (!ty.rows.empty()) Z.columns.push_back(std::move(ty));
    if (!rot.rows.empty()) Z.columns.push_back(std::move(rot));
  }
  return Z;
}

inline void stabilize_beam_rotation_dofs(
    CsrMatrix& K,
    const std::vector<BeamElementCache>& beamElements,
    const std::vector<std::int32_t>& freeIndexByDof) {
  for (const auto& beamEl : beamElements) {
    for (int rotSlot : {2, 5}) {
      const std::int32_t gDof = beamEl.dofs[static_cast<std::size_t>(rotSlot)];
      if (gDof < 0 ||
          gDof >= static_cast<std::int32_t>(freeIndexByDof.size())) {
        continue;
      }
      const std::int32_t fIdx = freeIndexByDof[static_cast<std::size_t>(gDof)];
      if (fIdx < 0) continue;
      const std::int32_t lo = K.rowPtr[static_cast<std::size_t>(fIdx)];
      const std::int32_t hi = K.rowPtr[static_cast<std::size_t>(fIdx + 1)];
      for (std::int32_t kk = lo; kk < hi; ++kk) {
        if (K.colIdx[static_cast<std::size_t>(kk)] == fIdx) {
          K.values[static_cast<std::size_t>(kk)] = 1.0;
          break;
        }
      }
    }
  }
}

// Re-build internal force, residual, and (optionally) tangent K from
// the trial displacement U, using `committed` as the constitutive
// baseline. Trial responses are written into `trial`.
//
// Target external force = baseRhsFree + loadFactor * rampedRhsFree.
// When the phase has only one component the caller passes the same
// pointer twice (with loadFactor = 0 / 1) or nullptr for the unused side.
inline AssembleOutput assemble_global(
    std::vector<ElementCache>& elements,
    const std::vector<BeamElementCache>* beamElements,
    const std::vector<MaterialPoint>& committed,
    std::vector<MaterialPoint>& trial,
    const std::vector<RegionParams>& regions,
    const std::vector<Mat6>& regionC,
    const std::vector<std::int32_t>& freeIndexByDof,
    const double* U_global,
    const double* U_base,
    const double* baseRhsFree,
    const double* rampedRhsFree,
    double loadFactor,
    ConstitutiveKind kind,
    bool symmetrize,
    bool incrementalStress,
    bool wantTangent,
    CsrMatrix& K,
    std::vector<double>& internalForceFree,
    std::vector<double>& residualFree,
    bool useElasticGlobalizationTangent = false,
    BeamAssemblyMode beamMode = BeamAssemblyMode::Active,
    const double* beamReferenceU = nullptr,
    bool useConsistentGlobalizationTangent = false) {
  const std::int32_t nfree = K.nrows;
  internalForceFree.assign(static_cast<std::size_t>(nfree), 0.0);
  if (wantTangent) K.clear_values();
  AssembleOutput out;
  out.maxEta = 0.0;

  std::array<double, 144> Ke{};
  std::array<double, 12> Fe{};

  for (auto& el : elements) {
    const int n = el.numDofs;
    const auto& C = regionC[el.regionIndex];
    const auto& rp = regions[el.regionIndex];
    bool elementActive = false;
    bool elementFaceActive = false;
    bool elementEdgeActive = false;
    bool elementApexActive = false;
    bool elementTension = false;
    bool elementChanged = false;

    std::array<std::array<std::array<double, 3>, 3>, 3> D2D{};
    std::array<std::array<double, 3>, 3> stress2D{};

    for (int g = 0; g < el.numGp; ++g) {
      const std::int32_t mpIdx = el.mpIdx[g];
      const MaterialPoint& committedMp = committed[mpIdx];
      MaterialPoint& trialMp = trial[mpIdx];
      const MaterialPoint previousTrialMp = trialMp;
      const bool previousTrialActive = previousTrialMp.currentlyMcActive != 0;
      Vec6 strainTotal{};
      strain_at_gauss(el, g, U_global, U_base, strainTotal);

      GpResponseExtra extra;
      GpResponse resp = evaluate_gp_response_ex(
          kind, C, rp, &previousTrialMp, committedMp, strainTotal, symmetrize, extra);

      // Write the trial state — fully derived from the committed
      // baseline + current U.
      trialMp.totalStrain = strainTotal;
      trialMp.effectiveStress = resp.stress;
      trialMp.plasticActive = resp.plasticActive;
      trialMp.tensionCutoffActive = resp.tensionActive;
      trialMp.etaMcCurrent = resp.eta;
      trialMp.etaMcMax = std::max(committedMp.etaMcMax, resp.eta);
      trialMp.plasticEverActive = committedMp.plasticEverActive | resp.plasticActive;
      trialMp.regionIndex = committedMp.regionIndex;
      trialMp.porePressure = committedMp.porePressure;
      trialMp.referenceStress = committedMp.referenceStress;
      trialMp.geostaticEffectiveStress = committedMp.geostaticEffectiveStress;
      trialMp.geostaticTotalStrain = committedMp.geostaticTotalStrain;
      trialMp.geostaticPlasticStrain = committedMp.geostaticPlasticStrain;
      trialMp.geostaticAccumulatedPlasticStrain = committedMp.geostaticAccumulatedPlasticStrain;
      trialMp.plasticStrain = committedMp.plasticStrain;
      trialMp.plasticStrain[V_XX] += resp.plasticInc[V_XX];
      trialMp.plasticStrain[V_YY] += resp.plasticInc[V_YY];
      trialMp.plasticStrain[V_ZZ] += resp.plasticInc[V_ZZ];
      trialMp.plasticStrain[V_XY] += resp.plasticInc[V_XY];
      trialMp.plasticStrain[V_YZ] += resp.plasticInc[V_YZ];
      trialMp.plasticStrain[V_XZ] += resp.plasticInc[V_XZ];
      trialMp.accumulatedPlasticStrain = committedMp.accumulatedPlasticStrain + resp.equivPlasticInc;
      trialMp.exactBranchKind = extra.exactBranchKind;
      trialMp.multiplicityKind = extra.multiplicityKind;
      trialMp.hasRepresentativeProjectors = extra.hasRepresentativeProjectors;
      trialMp.repP1 = extra.repP1;
      trialMp.repP2 = extra.repP2;
      trialMp.repP3 = extra.repP3;
      trialMp.currentlyMcActive = resp.plasticActive;
      trialMp.localReturnMode = extra.localReturnMode;
      trialMp.localFallbackUsed = extra.localFallbackUsed;
      trialMp.mcTangentMode = extra.mcTangentMode;
      if (kind == ConstitutiveKind::HardeningSoil) {
        trialMp.hs = extra.hsState;
        // Phase 5 diagnostics: aggregate per-GP HS failure / iteration
        // counts so the outer Newton can spot non-convergence (failureCode
        // 1xx) and the verifier can audit B.7 σ_zz iteration rates.
        if (extra.hsFailureCode != 0 && extra.hsFailureCode > out.hsFailureCode) {
          out.hsFailureCode = extra.hsFailureCode;
        }
        const std::uint8_t surf = extra.hsState.lastActiveSet;
        if (surf != 0) {
          ++out.hsActiveCount;
          if (surf == 1) {
            ++out.hsConeOnlyCount;
            out.hsConeIterSum += extra.hsSigmaZzIterations;
            ++out.hsConeIterCount;
          } else if (surf == 2) {
            ++out.hsCapOnlyCount;
            out.hsCapIterSum += extra.hsSigmaZzIterations;
            ++out.hsCapIterCount;
          } else if (surf == 3) {
            ++out.hsCornerCount;
            out.hsCornerIterSum += extra.hsSigmaZzIterations;
            ++out.hsCornerIterCount;
          } else {
            ++out.hsTensionMixCount;
          }
          out.hsSigmaZzIterSum += extra.hsSigmaZzIterations;
          if (extra.hsSigmaZzIterations > out.hsSigmaZzMaxIter) {
            out.hsSigmaZzMaxIter = extra.hsSigmaZzIterations;
          }
        }
      }

      if (resp.plasticActive) {
        elementActive = true;
        const auto activeSurface = mc_exact::active_yield_surface_from_branch_kind(
            static_cast<mc_exact::BranchKind>(extra.exactBranchKind));
        if (activeSurface == madep::js_mirror::YieldSurface::MC_FACE) elementFaceActive = true;
        if (activeSurface == madep::js_mirror::YieldSurface::MC_EDGE) elementEdgeActive = true;
        if (activeSurface == madep::js_mirror::YieldSurface::MC_APEX) elementApexActive = true;
      }
      if (resp.tensionActive) elementTension = true;
      if (previousTrialActive != (resp.plasticActive != 0)) elementChanged = true;
      if (resp.eta > out.maxEta) out.maxEta = resp.eta;
      if (resp.tangentQualityPoor) out.worstTangentPoor = 1u;

      const Vec6& referenceStress = incrementalStress
          ? committedMp.referenceStress
          : linalg::zero6();
      stress2D[g][0] = resp.stress[V_XX] - referenceStress[V_XX];
      stress2D[g][1] = resp.stress[V_YY] - referenceStress[V_YY];
      stress2D[g][2] = resp.stress[V_XY] - referenceStress[V_XY];
      // Tangent selection priorities:
      //  - elastic globalization (robust-mode rescue): use C.
      //  - Tier-2 consistent globalization (workstream B): use the EXACT
      //    consistent tangent. MC-only — HS already ships the consistent
      //    tangent as its production `resp.tangent`. The residual/stress are
      //    unchanged; only the Jacobian differs.
      //  - otherwise: the production tangent (modified Newton C for MC).
      const Mat6& tangentForStiffness =
          (useElasticGlobalizationTangent &&
           (kind == ConstitutiveKind::McPlastic ||
            kind == ConstitutiveKind::HardeningSoil))
              ? C
              : (useConsistentGlobalizationTangent &&
                 kind == ConstitutiveKind::McPlastic)
                  ? resp.consistentTangent
                  : resp.tangent;
      D2D[g] = linalg::tangent2D_from_6x6(tangentForStiffness);
    }

    if (elementActive) out.plasticActiveCount += 1;
    if (elementFaceActive) out.activeFaceCount += 1;
    if (elementEdgeActive) out.activeEdgeCount += 1;
    if (elementApexActive) out.activeApexCount += 1;
    if (elementTension) out.tensionCount += 1;
    if (elementChanged) out.changedCount += 1;

    if (wantTangent) {
      elem::element_stiffness(el, D2D, Ke.data());
      sparse::scatter_element_matrix(K, el, freeIndexByDof, Ke.data());
    }
    elem::element_internal_force(el, stress2D, Fe.data());
    sparse::scatter_element_rhs(internalForceFree.data(), el, freeIndexByDof, Fe.data());
  }

  if (beamElements) {
    if (beamMode == BeamAssemblyMode::InactiveStabilizeRotations) {
      if (wantTangent) stabilize_beam_rotation_dofs(K, *beamElements, freeIndexByDof);
    } else {
      double Kb[36]{};
      double Fb[6]{};
      for (const auto& beamEl : *beamElements) {
        if (wantTangent) {
          beam::element_stiffness(beamEl, Kb);
          sparse::scatter_dense_matrix(K, beamEl.dofs.data(), 6, freeIndexByDof, Kb);
        }
        beam::element_internal_force(beamEl, U_global, U_base, Fb, beamReferenceU);
        sparse::scatter_dense_rhs(internalForceFree.data(), beamEl.dofs.data(), 6, freeIndexByDof, Fb);
      }
    }
  }

  // Residual = (base + λ * ramped) - F_int.
  residualFree.assign(static_cast<std::size_t>(nfree), 0.0);
  double r2 = 0.0, b2 = 0.0;
  for (std::int32_t i = 0; i < nfree; ++i) {
    const double base = baseRhsFree ? baseRhsFree[i] : 0.0;
    const double ramped = rampedRhsFree ? rampedRhsFree[i] : 0.0;
    const double rhs = base + loadFactor * ramped;
    const double resid = rhs - internalForceFree[i];
    residualFree[i] = resid;
    r2 += resid * resid;
    b2 += rhs * rhs;
  }
  out.residualNorm = std::sqrt(r2);
  out.rhsNorm = std::sqrt(b2);
  return out;
}

// Phase context shared between the geostatic, service, and safety calls.
struct PhaseContext {
  std::vector<ElementCache>* elements{ nullptr };
  const std::vector<BeamElementCache>* beamElements{ nullptr };
  std::vector<MaterialPoint>* committed{ nullptr };
  std::vector<MaterialPoint>* trial{ nullptr };
  const std::vector<RegionParams>* regions{ nullptr };
  const std::vector<Mat6>* regionC{ nullptr };
  const std::vector<std::int32_t>* freeDofs{ nullptr };
  const std::vector<std::int32_t>* freeIndexByDof{ nullptr };
  CsrMatrix* K{ nullptr };
  std::vector<double>* U_global{ nullptr };
  const std::vector<double>* U_base{ nullptr };
  const std::vector<double>* beamReferenceU{ nullptr };
  BeamAssemblyMode beamMode{ BeamAssemblyMode::Active };
  // External-force decomposition: target(λ) = baseRhsFree + λ * rampedRhsFree.
  const std::vector<double>* baseRhsFree{ nullptr };
  const std::vector<double>* rampedRhsFree{ nullptr };
  std::int32_t ndof{ 0 };
  ConstitutiveKind kind{ ConstitutiveKind::McPlastic };
  PhaseKind phaseKind{ PhaseKind::ServiceLoad };
  bool symmetrize{ true };
  bool incrementalStress{ false };
  const std::vector<RegionParams>* safetyStrengthBaseRegions{ nullptr };
  double safetySigmaMsfStart{ 1.0 };
  double safetySigmaMsfTarget{ 1.0 };
  const std::vector<double>* safetyBaseU{ nullptr };
  const std::vector<MaterialPoint>* safetyComparison{ nullptr };
  std::vector<SafetyCurvePoint>* safetyCurve{ nullptr };
  std::int32_t safetyTrialIndex{ -1 };
  double modelBoundingBoxDiagonal{ 1.0 };
};

inline double model_bounding_box_diagonal(const std::vector<ElementCache>& elements) {
  if (elements.empty()) return 1.0;
  double minX = std::numeric_limits<double>::infinity();
  double minY = std::numeric_limits<double>::infinity();
  double maxX = -std::numeric_limits<double>::infinity();
  double maxY = -std::numeric_limits<double>::infinity();
  bool any = false;
  for (const ElementCache& el : elements) {
    const int nnode = el.kind == ElementKind::T6 ? 6 : 3;
    for (int i = 0; i < nnode; ++i) {
      const Node& node = el.nodes[static_cast<std::size_t>(i)];
      if (!std::isfinite(node.x) || !std::isfinite(node.y)) continue;
      minX = std::min(minX, node.x);
      minY = std::min(minY, node.y);
      maxX = std::max(maxX, node.x);
      maxY = std::max(maxY, node.y);
      any = true;
    }
  }
  if (!any) return 1.0;
  return std::max(std::hypot(maxX - minX, maxY - minY), 1.0);
}

struct ArcLengthRuntimeOptions {
  SolverOptions opts;
  double displacementScale{ 1.0 };
};

inline double positive_arc_length_multiplier(double value) {
  return std::isfinite(value) && value > 0.0 ? value : 1.0;
}

inline ArcLengthRuntimeOptions prepare_arc_length_runtime_options(
    const PhaseContext& ctx,
    const SolverOptions& opts) {
  ArcLengthRuntimeOptions out;
  out.opts = opts;
  const bool autoScale =
      !std::isfinite(opts.arcLengthDisplacementScale) ||
      opts.arcLengthDisplacementScale <= 0.0;
  if (!autoScale) {
    out.displacementScale = opts.arcLengthDisplacementScale;
    return out;
  }

  const double modelLength = std::max(ctx.modelBoundingBoxDiagonal, 1.0);
  out.displacementScale = 1.0 / modelLength;
  const double radiusScale = out.displacementScale;
  const double toleranceScale = radiusScale * radiusScale;
  out.opts.arcLengthInitialRadius *=
      radiusScale * positive_arc_length_multiplier(opts.arcLengthInitialRadiusScale);
  out.opts.arcLengthMinRadius *=
      radiusScale * positive_arc_length_multiplier(opts.arcLengthMinRadiusScale);
  out.opts.arcLengthMaxRadius *=
      radiusScale * positive_arc_length_multiplier(opts.arcLengthMaxRadiusScale);
  out.opts.arcLengthConstraintTolerance *=
      toleranceScale * positive_arc_length_multiplier(opts.arcLengthConstraintToleranceScale);
  return out;
}

struct PhaseStepMaterials {
  const std::vector<RegionParams>* regions{ nullptr };
  const std::vector<Mat6>* regionC{ nullptr };
  std::vector<RegionParams> ownedRegions;
  std::vector<Mat6> ownedRegionC;
};

// C.3 cache-invalidation hook (HS Phase 7). Whenever the safety trial
// changes σ_Msf, the cached HS region constants (M_cap, H_cap,
// sin_phi_cv) are stale: they were calibrated against the BASE strength
// parameters, and the safety reduction changes φ_eff and c_eff. We have
// already applied `reduce_strength` to `regions`, so the strength fields
// (cEff, phi, psi, sigmaTAllow) are at their σ_Msf-reduced values.
// `compute_hs_reference_constants` reads those reduced fields and runs
// the C.1/C.2 calibrations on them; passing `sigmaMsf=1.0` here avoids
// double-reduction (the helper otherwise divides cEff/tan(phi)/... by
// its own σ_Msf argument internally).
//
// The constitutive kind is global per analysis (carried on SolverOptions
// / PhaseContext), not per region; gate on `kind` so non-HS runs pay
// nothing.
inline void recompute_hs_constants_for_reduced_regions(
    std::vector<RegionParams>& regions,
    ConstitutiveKind kind) {
  if (kind != ConstitutiveKind::HardeningSoil) return;
  for (auto& r : regions) {
    material::hs::compute_hs_reference_constants(r, 1.0);
  }
}

inline void prepare_phase_step_materials(
    const PhaseContext& ctx,
    const std::vector<RegionParams>& phaseRegions,
    const std::vector<Mat6>& phaseRegionC,
    double targetLambda,
    PhaseStepMaterials& out) {
  out.ownedRegions.clear();
  out.ownedRegionC.clear();
  out.regions = &phaseRegions;
  out.regionC = &phaseRegionC;
  if (ctx.phaseKind != PhaseKind::SafetyCphi || !ctx.safetyStrengthBaseRegions) return;

  const double sigmaMsf = ctx.safetySigmaMsfStart +
      (ctx.safetySigmaMsfTarget - ctx.safetySigmaMsfStart) * targetLambda;
  out.ownedRegions = *ctx.safetyStrengthBaseRegions;
  for (auto& r : out.ownedRegions) r = reduce_strength(r, sigmaMsf);
  recompute_hs_constants_for_reduced_regions(out.ownedRegions, ctx.kind);
  build_region_elastic_into(out.ownedRegions, out.ownedRegionC);
  out.regions = &out.ownedRegions;
  out.regionC = &out.ownedRegionC;
}

inline void prepare_safety_sigma_msf_materials(
    const PhaseContext& ctx,
    const std::vector<RegionParams>& phaseRegions,
    const std::vector<Mat6>& phaseRegionC,
    double sigmaMsf,
    PhaseStepMaterials& out) {
  out.ownedRegions.clear();
  out.ownedRegionC.clear();
  out.regions = &phaseRegions;
  out.regionC = &phaseRegionC;
  if (ctx.phaseKind != PhaseKind::SafetyCphi || !ctx.safetyStrengthBaseRegions) return;

  out.ownedRegions = *ctx.safetyStrengthBaseRegions;
  for (auto& r : out.ownedRegions) r = reduce_strength(r, std::max(sigmaMsf, 1.0));
  recompute_hs_constants_for_reduced_regions(out.ownedRegions, ctx.kind);
  build_region_elastic_into(out.ownedRegions, out.ownedRegionC);
  out.regions = &out.ownedRegions;
  out.regionC = &out.ownedRegionC;
}

inline cg::LinearSolveResult solve_phase_linear_system(
    const CsrMatrix& K,
    const std::vector<std::int32_t>& freeDofs,
    const std::vector<double>& residualFree,
    std::vector<double>& correctionFree,
    std::vector<double>& diagInv,
    const SolverOptions& opts,
    bool useUnsymmetricSolver,
    bool reuseDiagInv = false,
    cg::GmresScalingCache* gmresCache = nullptr,
    double relTolOverride = std::numeric_limits<double>::quiet_NaN(),
    double absTolOverride = std::numeric_limits<double>::quiet_NaN(),
    const std::vector<std::array<std::int32_t, 3>>* wallPreconditionerTriplets = nullptr,
    const std::vector<std::vector<std::int32_t>>* wallPreconditionerBlocks = nullptr,
    const sparse::WallCoarseSpace* wallCoarseSpace = nullptr,
    std::int32_t gmresRestart = 40) {
  const double relTol = (std::isfinite(relTolOverride) && relTolOverride >= 0.0)
      ? relTolOverride
      : opts.cgRelTol;
  const double absTol = (std::isfinite(absTolOverride) && absTolOverride >= 0.0)
      ? absTolOverride
      : opts.cgAbsTol;
  // Workstream A: the wall rigid-body coarse correction is gated behind
  // `useWallCoarseCorrection`. It is preconditioning/deflation only and never
  // changes the converged solution (the raw-residual stopping test is
  // unchanged); it only crushes the Krylov-iteration count caused by the
  // steel-wall / soft-soil stiffness contrast.
  const sparse::WallCoarseSpace* coarse =
      (opts.useWallCoarseCorrection != 0 && wallCoarseSpace && !wallCoarseSpace->empty())
          ? wallCoarseSpace
          : nullptr;
  if (useUnsymmetricSolver) {
    return cg::solve_gmres_scaled(K, freeDofs,
                                  residualFree.data(), correctionFree.data(),
                                  opts.cgMaxIter, relTol, absTol,
                                  /*restart=*/std::max(gmresRestart, 1),
                                  gmresCache, coarse);
  }
  if (!reuseDiagInv) {
    sparse::build_block_jacobi(K, freeDofs, diagInv, wallPreconditionerTriplets, wallPreconditionerBlocks);
  }
  return cg::solve_cg(K, diagInv, freeDofs,
                      residualFree.data(), correctionFree.data(),
                      opts.cgMaxIter, relTol, absTol, coarse);
}

struct ArcLengthState {
  double lambda{ 0.0 };
  double sigmaMsf{ 1.0 };
  double deltaS{ 1e-3 };
  double alpha{ 1.0 };
  std::vector<double> previousDeltaU;
  double previousDeltaLambda{ 0.0 };
  std::int32_t stepIndex{ 0 };
  std::int32_t acceptedStepCount{ 0 };
  std::int32_t rejectedStepCount{ 0 };
};

struct ContinuationControllerState {
  RequestedContinuationMode requestedMode{ RequestedContinuationMode::Auto };
  ActualContinuationMode actualMode{ ActualContinuationMode::LoadControl };
  ArcLengthState arcLength;
};

struct ArcLengthPredictor {
  std::vector<double> deltaUFree;
  double deltaLambda{ 0.0 };
  double weightedNorm{ 0.0 };
  double scale{ 0.0 };
  std::int32_t linearIterations{ 0 };
  bool converged{ false };
};

struct ArcLengthCorrector {
  std::vector<double> deltaUFree;
  double deltaLambda{ 0.0 };
  double constraintResidual{ 0.0 };
  double denominator{ 0.0 };
  std::int32_t linearIterations{ 0 };
  std::uint16_t failureCode{ 0 };
  bool converged{ false };
};

struct SafetyResidualDerivativeFd {
  std::vector<double> rLambdaFree;
  std::vector<double> continuationRhsFree;
  double sigmaMsf{ 1.0 };
  double lowerSigmaMsf{ 1.0 };
  double upperSigmaMsf{ 1.0 };
  double h{ 0.0 };
  bool usedCentralDifference{ false };
  std::uint16_t failureCode{ 0 };
  bool converged{ false };
};

struct ArcLengthFdScratch {
  std::vector<MaterialPoint> trial;
  std::vector<RegionParams> regions;
  std::vector<Mat6> regionC;
  std::vector<double> internalForce;
  std::vector<double> lowerResidual;
  std::vector<double> upperResidual;
};

inline ActualContinuationMode default_actual_continuation_mode(PhaseKind phaseKind) {
  return phaseKind == PhaseKind::SafetyCphi
      ? ActualContinuationMode::StrengthControl
      : ActualContinuationMode::LoadControl;
}

inline void initialise_arc_length_state(
    ArcLengthState& state,
    const SolverOptions& opts,
    std::int32_t nfree,
    double lambda,
    double sigmaMsf) {
  state.lambda = lambda;
  state.sigmaMsf = std::max(sigmaMsf, 1.0);
  state.deltaS = std::clamp(
      opts.arcLengthInitialRadius,
      std::max(opts.arcLengthMinRadius, 1e-12),
      std::max(opts.arcLengthMaxRadius, opts.arcLengthMinRadius));
  state.alpha = std::clamp(1.0, opts.arcLengthAlphaMin, opts.arcLengthAlphaMax);
  state.previousDeltaU.assign(static_cast<std::size_t>(std::max(nfree, 0)), 0.0);
  state.previousDeltaLambda = 0.0;
  state.stepIndex = 0;
  state.acceptedStepCount = 0;
  state.rejectedStepCount = 0;
}

inline double arc_length_weighted_norm2(const std::vector<double>& v, double displacementScale = 1.0) {
  const double w = std::max(displacementScale, 0.0);
  double out = 0.0;
  for (double x : v) {
    const double wx = w * x;
    out += wx * wx;
  }
  return out;
}

inline double arc_length_sigma_msf_fd_step(double sigmaMsf, const SolverOptions& opts) {
  const double sigma = std::max(sigmaMsf, 1.0);
  const double stepScale = std::max(opts.arcLengthFiniteDifferenceStepScale, 0.0);
  const double minStep = std::max(opts.arcLengthFiniteDifferenceMinStep, 0.0);
  return std::max(stepScale * std::max(sigma, 1.0), minStep);
}

inline double arc_length_path_dot(
    const std::vector<double>& a,
    const std::vector<double>& b,
    double aLambda,
    double bLambda,
    double alpha,
    double displacementScale = 1.0) {
  const std::size_t n = std::min(a.size(), b.size());
  const double w2 = displacementScale * displacementScale;
  double out = 0.0;
  for (std::size_t i = 0; i < n; ++i) out += w2 * a[i] * b[i];
  return out + alpha * alpha * aLambda * bLambda;
}

inline void choose_arc_length_predictor_sign(
    ArcLengthState& state,
    ArcLengthPredictor& predictor,
    double alpha,
    double displacementScale = 1.0) {
  bool flip = false;
  if (state.acceptedStepCount <= 0) {
    flip = predictor.deltaLambda < 0.0;
  } else {
    const double dot = arc_length_path_dot(
        predictor.deltaUFree,
        state.previousDeltaU,
        predictor.deltaLambda,
        state.previousDeltaLambda,
        alpha,
        displacementScale);
    flip = dot < 0.0;
  }
  if (!flip) return;
  predictor.deltaLambda = -predictor.deltaLambda;
  for (double& v : predictor.deltaUFree) v = -v;
}

inline bool arc_length_predictor_direction_allowed(
    const ArcLengthPredictor& predictor,
    const ArcLengthState& state,
    const SolverOptions& opts) {
  const bool descentAllowed =
      opts.arcLengthAllowPostPeakSafetyPath != 0u && state.acceptedStepCount > 0;
  return predictor.converged && (descentAllowed || predictor.deltaLambda > 0.0);
}

inline int arc_length_line_search_max_backtracks(const SolverOptions& opts) {
  return std::max(opts.arcLengthLineSearchMaxBacktracks, 1);
}

inline double arc_length_quadratic_merit_beta(
    double stepInitialResidualNorm,
    double stepInitialConstraintResidual) {
  const double initialResSq = stepInitialResidualNorm * stepInitialResidualNorm;
  const double initialConstraintSq =
      stepInitialConstraintResidual * stepInitialConstraintResidual;
  return std::max(1.0, initialResSq / std::max(initialConstraintSq, 1e-30));
}

inline double arc_length_line_search_merit(
    double residualNorm,
    double constraintResidual,
    double deltaS,
    double quadraticBeta,
    const SolverOptions& opts) {
  if (opts.arcLengthMeritMode == ArcLengthMeritMode::Quadratic) {
    return 0.5 * residualNorm * residualNorm
        + 0.5 * quadraticBeta * constraintResidual * constraintResidual;
  }
  const double currentConstraintScale = std::max(deltaS * deltaS, 1e-16);
  return residualNorm + std::abs(constraintResidual) / currentConstraintScale;
}

inline ArcLengthPredictor make_load_control_arc_length_predictor(
    const CsrMatrix& K,
    const std::vector<std::int32_t>& freeDofs,
    const std::vector<double>& loadRhsFree,
    std::vector<double>& diagInv,
    const SolverOptions& opts,
    ArcLengthState& state,
    double displacementScale = 1.0,
    bool useUnsymmetricSolver = false) {
  ArcLengthPredictor predictor;
  predictor.deltaUFree.assign(static_cast<std::size_t>(K.nrows), 0.0);
  cg::LinearSolveResult lr = solve_phase_linear_system(
      K, freeDofs, loadRhsFree, predictor.deltaUFree, diagInv, opts, useUnsymmetricSolver);
  predictor.linearIterations = lr.iterations;
  predictor.converged = lr.converged;

  const double alpha = std::clamp(state.alpha, opts.arcLengthAlphaMin, opts.arcLengthAlphaMax);
  const double norm2 = arc_length_weighted_norm2(predictor.deltaUFree, displacementScale);
  const double denom = std::sqrt(std::max(norm2 + alpha * alpha, 0.0));
  if (!(denom > 0.0) || !std::isfinite(denom)) {
    predictor.converged = false;
    return predictor;
  }
  predictor.scale = state.deltaS / denom;
  predictor.deltaLambda = predictor.scale;
  for (double& v : predictor.deltaUFree) v *= predictor.scale;
  predictor.weightedNorm = std::sqrt(
      arc_length_weighted_norm2(predictor.deltaUFree, displacementScale));
  choose_arc_length_predictor_sign(state, predictor, alpha, displacementScale);
  return predictor;
}

inline double arc_length_constraint_residual(
    const std::vector<double>& stepDeltaUFree,
    double stepDeltaLambda,
    double deltaS,
    double alpha,
    double displacementScale = 1.0) {
  return arc_length_weighted_norm2(stepDeltaUFree, displacementScale)
      + alpha * alpha * stepDeltaLambda * stepDeltaLambda
      - deltaS * deltaS;
}

inline double arc_length_constraint_directional_derivative_u(
    const std::vector<double>& stepDeltaUFree,
    const std::vector<double>& correctionFree,
    double displacementScale = 1.0) {
  const std::size_t n = std::min(stepDeltaUFree.size(), correctionFree.size());
  const double w2 = displacementScale * displacementScale;
  double out = 0.0;
  for (std::size_t i = 0; i < n; ++i) {
    out += 2.0 * w2 * stepDeltaUFree[i] * correctionFree[i];
  }
  return out;
}

inline ArcLengthCorrector compute_arc_length_corrector(
    const CsrMatrix& K,
    const std::vector<std::int32_t>& freeDofs,
    const std::vector<double>& residualFree,
    const std::vector<double>& continuationRhsFree,
    const std::vector<double>& stepDeltaUFree,
    double stepDeltaLambda,
    ArcLengthState& state,
    std::vector<double>& diagInv,
    const SolverOptions& opts,
    double displacementScale = 1.0,
    bool useUnsymmetricSolver = false) {
  ArcLengthCorrector out;
  out.deltaUFree.assign(static_cast<std::size_t>(K.nrows), 0.0);
  cg::GmresScalingCache gmresCache;
  cg::GmresScalingCache* gmresCachePtr = useUnsymmetricSolver ? &gmresCache : nullptr;

  std::vector<double> duResidual(static_cast<std::size_t>(K.nrows), 0.0);
  cg::LinearSolveResult residualSolve = solve_phase_linear_system(
      K, freeDofs, residualFree, duResidual, diagInv, opts, useUnsymmetricSolver,
      /*reuseDiagInv=*/false,
      gmresCachePtr);
  out.linearIterations += residualSolve.iterations;
  if (!residualSolve.converged) {
    out.failureCode = 1u;
    return out;
  }

  std::vector<double> duContinuation(static_cast<std::size_t>(K.nrows), 0.0);
  cg::LinearSolveResult continuationSolve = solve_phase_linear_system(
      K, freeDofs, continuationRhsFree, duContinuation, diagInv, opts, useUnsymmetricSolver,
      !useUnsymmetricSolver,
      gmresCachePtr);
  out.linearIterations += continuationSolve.iterations;
  if (!continuationSolve.converged) {
    out.failureCode = 2u;
    return out;
  }

  const double alpha = std::clamp(state.alpha, opts.arcLengthAlphaMin, opts.arcLengthAlphaMax);
  out.constraintResidual = arc_length_constraint_residual(
      stepDeltaUFree, stepDeltaLambda, state.deltaS, alpha, displacementScale);
  const double guDuResidual = arc_length_constraint_directional_derivative_u(
      stepDeltaUFree, duResidual, displacementScale);
  const double guDuContinuation = arc_length_constraint_directional_derivative_u(
      stepDeltaUFree, duContinuation, displacementScale);
  const double gLambda = 2.0 * alpha * alpha * stepDeltaLambda;
  out.denominator = guDuContinuation + gLambda;
  const double denominatorTol = std::max(1e-14, 1e-12 * std::max(std::abs(gLambda), 1.0));
  if (!(std::abs(out.denominator) > denominatorTol) || !std::isfinite(out.denominator)) {
    out.failureCode = 3u;
    return out;
  }

  out.deltaLambda = (-out.constraintResidual - guDuResidual) / out.denominator;
  for (std::int32_t i = 0; i < K.nrows; ++i) {
    out.deltaUFree[static_cast<std::size_t>(i)] =
        duResidual[static_cast<std::size_t>(i)]
        + out.deltaLambda * duContinuation[static_cast<std::size_t>(i)];
  }
  out.converged = std::isfinite(out.deltaLambda);
  out.failureCode = out.converged ? 0u : 4u;
  return out;
}

inline SafetyResidualDerivativeFd compute_safety_sigma_msf_residual_derivative_fd(
    PhaseContext& ctx,
    const std::vector<double>& U,
    double loadFactor,
    double sigmaMsf,
    ArcLengthFdScratch& scratch,
    const SolverOptions& opts) {
  SafetyResidualDerivativeFd out;
  const std::int32_t nfree = ctx.K ? ctx.K->nrows : 0;
  out.rLambdaFree.assign(static_cast<std::size_t>(std::max(nfree, 0)), 0.0);
  out.continuationRhsFree.assign(static_cast<std::size_t>(std::max(nfree, 0)), 0.0);
  out.sigmaMsf = std::max(sigmaMsf, 1.0);
  out.h = arc_length_sigma_msf_fd_step(out.sigmaMsf, opts);
  if (ctx.phaseKind != PhaseKind::SafetyCphi || !ctx.safetyStrengthBaseRegions ||
      !ctx.elements || !ctx.committed || !ctx.trial || !ctx.freeIndexByDof ||
      !ctx.K || nfree < 0 || static_cast<std::int32_t>(U.size()) < ctx.ndof) {
    out.failureCode = 1u;
    return out;
  }
  if (!(out.h > 0.0) || !std::isfinite(out.h)) {
    out.failureCode = 2u;
    return out;
  }

  const double candidateLower = out.sigmaMsf - out.h;
  out.usedCentralDifference = candidateLower >= 1.0;
  out.lowerSigmaMsf = out.usedCentralDifference ? candidateLower : out.sigmaMsf;
  out.upperSigmaMsf = out.sigmaMsf + out.h;
  if (out.lowerSigmaMsf < 1.0 || !(out.upperSigmaMsf > out.lowerSigmaMsf)) {
    out.failureCode = 2u;
    return out;
  }

  const std::vector<MaterialPoint> trialBackup = *ctx.trial;
  const std::vector<MaterialPoint>& committedRef = *ctx.committed;
  const std::size_t freeCount = static_cast<std::size_t>(nfree);
  scratch.lowerResidual.assign(freeCount, 0.0);
  scratch.upperResidual.assign(freeCount, 0.0);

  auto assemble_at_sigma = [&](double sigma, std::vector<double>& residualOut) -> bool {
    scratch.regions.assign(
        ctx.safetyStrengthBaseRegions->begin(), ctx.safetyStrengthBaseRegions->end());
    for (auto& r : scratch.regions) r = reduce_strength(r, sigma);
    // C.3 hook: HS region constants (M_cap, H_cap, sin_phi_cv) depend on
    // φ_eff and c_eff. The FD R_λ probes assemble at σ_Msf ± h, so the
    // constants must be re-calibrated for each probe before assembly.
    // Pass sigmaMsf=1.0 because reduce_strength has already reduced the
    // strength parameters; compute_hs_reference_constants would otherwise
    // double-reduce them (see prepare_safety_sigma_msf_materials).
    recompute_hs_constants_for_reduced_regions(scratch.regions, ctx.kind);
    build_region_elastic_into(scratch.regions, scratch.regionC);
    scratch.trial.assign(trialBackup.begin(), trialBackup.end());
    scratch.internalForce.assign(freeCount, 0.0);
    residualOut.assign(freeCount, 0.0);
    AssembleOutput probe = assemble_global(
        *ctx.elements,
        ctx.beamElements,
        committedRef,
        scratch.trial,
        scratch.regions,
        scratch.regionC,
        *ctx.freeIndexByDof,
        U.data(),
        ctx.U_base ? ctx.U_base->data() : nullptr,
        ctx.baseRhsFree ? ctx.baseRhsFree->data() : nullptr,
        ctx.rampedRhsFree ? ctx.rampedRhsFree->data() : nullptr,
        loadFactor,
        ctx.kind,
        ctx.symmetrize,
        ctx.incrementalStress,
        /*wantTangent=*/false,
        *ctx.K,
        scratch.internalForce,
        residualOut,
        /*useElasticGlobalizationTangent=*/false,
        ctx.beamMode,
        ctx.beamReferenceU ? ctx.beamReferenceU->data() : nullptr);
    if (!std::isfinite(probe.residualNorm)) return false;
    for (double v : residualOut) {
      if (!std::isfinite(v)) return false;
    }
    return true;
  };

  const bool lowerOk = assemble_at_sigma(out.lowerSigmaMsf, scratch.lowerResidual);
  const bool upperOk = assemble_at_sigma(out.upperSigmaMsf, scratch.upperResidual);
  *ctx.trial = trialBackup;
  if (!lowerOk || !upperOk) {
    out.failureCode = 3u;
    return out;
  }

  const double denom = out.upperSigmaMsf - out.lowerSigmaMsf;
  if (!(denom > 0.0) || !std::isfinite(denom)) {
    out.failureCode = 2u;
    return out;
  }
  for (std::int32_t i = 0; i < nfree; ++i) {
    const double dR = (scratch.upperResidual[static_cast<std::size_t>(i)] -
                      scratch.lowerResidual[static_cast<std::size_t>(i)]) / denom;
    if (!std::isfinite(dR)) {
      out.failureCode = 3u;
      return out;
    }
    out.rLambdaFree[static_cast<std::size_t>(i)] = dR;
    out.continuationRhsFree[static_cast<std::size_t>(i)] = -dR;
  }
  out.converged = true;
  out.failureCode = 0u;
  return out;
}

inline SafetyResidualDerivativeFd compute_safety_sigma_msf_residual_derivative_analytic(
    PhaseContext& ctx,
    double sigmaMsf) {
  SafetyResidualDerivativeFd out;
  const std::int32_t nfree = ctx.K ? ctx.K->nrows : 0;
  out.rLambdaFree.assign(static_cast<std::size_t>(std::max(nfree, 0)), 0.0);
  out.continuationRhsFree.assign(static_cast<std::size_t>(std::max(nfree, 0)), 0.0);
  out.sigmaMsf = std::max(sigmaMsf, 1.0);
  out.lowerSigmaMsf = out.sigmaMsf;
  out.upperSigmaMsf = out.sigmaMsf;
  out.h = 0.0;
  if (ctx.phaseKind != PhaseKind::SafetyCphi || !ctx.K || nfree < 0) {
    out.failureCode = 1u;
    return out;
  }
  if (ctx.kind != ConstitutiveKind::LinearElastic) {
    out.failureCode = 4u;
    return out;
  }
  // Linear-elastic stress is independent of c, phi, psi, and the tension
  // cap, so the exact safety strength derivative is zero.
  out.converged = true;
  out.failureCode = 0u;
  return out;
}

inline SafetyResidualDerivativeFd compute_safety_sigma_msf_residual_derivative(
    PhaseContext& ctx,
    const std::vector<double>& U,
    double loadFactor,
    double sigmaMsf,
    ArcLengthFdScratch& scratch,
    const SolverOptions& opts) {
  if (opts.arcLengthDerivativeMode != ArcLengthDerivativeMode::FiniteDifference) {
    SafetyResidualDerivativeFd analytic =
        compute_safety_sigma_msf_residual_derivative_analytic(ctx, sigmaMsf);
    if (analytic.converged) return analytic;
  }
  return compute_safety_sigma_msf_residual_derivative_fd(ctx, U, loadFactor, sigmaMsf, scratch, opts);
}

struct PhaseResult {
  std::int32_t accepted{ 0 };
  std::int32_t rejected{ 0 };
  std::int32_t newtonIterations{ 0 };
  std::int32_t cgIterations{ 0 };
  std::int32_t activeCount{ 0 };
  std::int32_t activeFaceCount{ 0 };
  std::int32_t activeEdgeCount{ 0 };
  std::int32_t activeApexCount{ 0 };
  std::int32_t tensionCount{ 0 };
  std::int32_t displayActiveCount{ 0 };
  std::int32_t displayActiveFaceCount{ 0 };
  std::int32_t displayActiveEdgeCount{ 0 };
  std::int32_t displayActiveApexCount{ 0 };
  std::int32_t displayTensionCount{ 0 };
  double maxEta{ 0.0 };
  double residualNorm{ 0.0 };
  double loadFactor{ 0.0 };
  double displayLoadFactor{ 0.0 };
  double displayResidualNorm{ 0.0 };
  bool converged{ false };
  bool hasDisplayState{ false };
  std::vector<double> displayU;
  std::vector<MaterialPoint> displayMp;
  // Phase 7: dispatch telemetry. `gmresIterationCount` totals Krylov
  // iterations consumed by GMRES across all linear solves in this
  // phase; the rest is CG. `gmresInvocations` counts how many Newton
  // iterations dispatched to GMRES at all. `lastLinearSolverKind` is
  // the solver chosen for the LAST global Newton iteration of the
  // LAST accepted step in this phase (0=CG, 1=GMRES). These let the
  // verifier confirm GMRES is used for HS plastic steps.
  //
  // Phase 8 (fix-plan §Phase 8 logging): the diagnostic fields below
  // (active-set change count, per-failure-code local-return rejection
  // tallies, max cone/cap/tension residuals, max plane-strain residual,
  // max tangent symmetry norm) are deferred to a future phase — the
  // wire format `RunSummary` currently has 3 reserved bytes of headroom
  // and adding the new f64/i32 columns would require bumping
  // WIRE_VERSION. The existing fields below are populated correctly for
  // HS analyses and are sufficient to certify the §Phase 8 production
  // hierarchy: accepted/rejected steps, Newton iterations, CG +
  // GMRES iteration counts, the last linear solver kind, and the
  // sticky `hsPlasticUsedGmres` flag in `RunSummary` (set at the
  // dispatch sites in `run_full_analysis` below).
  std::int32_t gmresIterationCount{ 0 };
  std::int32_t gmresInvocations{ 0 };
  std::uint8_t lastLinearSolverKind{ 0 };
  std::uint16_t lastHsFailureCode{ 0 };
  std::vector<std::int32_t> acceptedStepIterations;
  // Workstream B Tier-2 telemetry (runtime-only).
  std::int32_t tier2Activations{ 0 };
  std::int32_t tier2Steps{ 0 };
  double tier2FinalMu{ 0.0 };
  double tier2MaxMu{ 0.0 };
  double tier2LoadFactor{ 0.0 };
  double tier2LastResidual{ 0.0 };
  bool tier2Engaged{ false };
  bool tier2FinalMuZero{ true };
};

inline void accumulate_phase_cost(PhaseResult& total, const PhaseResult& extra) {
  total.accepted += extra.accepted;
  total.rejected += extra.rejected;
  total.newtonIterations += extra.newtonIterations;
  total.cgIterations += extra.cgIterations;
  total.maxEta = std::max(total.maxEta, extra.maxEta);
  total.gmresIterationCount += extra.gmresIterationCount;
  total.gmresInvocations += extra.gmresInvocations;
  if (extra.lastHsFailureCode != 0) total.lastHsFailureCode = extra.lastHsFailureCode;
  total.acceptedStepIterations.insert(
      total.acceptedStepIterations.end(),
      extra.acceptedStepIterations.begin(),
      extra.acceptedStepIterations.end());
  // The most-recent phase wins for the "last solver used" signal.
  total.lastLinearSolverKind = extra.lastLinearSolverKind;
  total.tier2Activations += extra.tier2Activations;
  total.tier2Steps += extra.tier2Steps;
  total.tier2MaxMu = std::max(total.tier2MaxMu, extra.tier2MaxMu);
  if (extra.tier2Engaged) {
    total.tier2Engaged = true;
    total.tier2FinalMu = extra.tier2FinalMu;
    total.tier2FinalMuZero = extra.tier2FinalMuZero;
  }
}

inline void apply_phase_cost_counts(PhaseResult& result, const PhaseResult& cost) {
  result.accepted = cost.accepted;
  result.rejected = cost.rejected;
  result.newtonIterations = cost.newtonIterations;
  result.cgIterations = cost.cgIterations;
  result.maxEta = std::max(result.maxEta, cost.maxEta);
  result.gmresIterationCount = cost.gmresIterationCount;
  result.gmresInvocations = cost.gmresInvocations;
  result.lastHsFailureCode = cost.lastHsFailureCode;
  result.lastLinearSolverKind = cost.lastLinearSolverKind;
  result.acceptedStepIterations = cost.acceptedStepIterations;
}

// Workstream B: fold a phase's Tier-2 telemetry into the run summary. The
// last-engaged phase wins for the final-μ signal; activation/step counts and
// the peak μ accumulate.
inline void merge_tier2_summary(RunSummary& summary, const PhaseResult& phase) {
  summary.tier2Activations += phase.tier2Activations;
  summary.tier2Steps += phase.tier2Steps;
  summary.tier2MaxMu = std::max(summary.tier2MaxMu, phase.tier2MaxMu);
  if (phase.tier2Engaged) {
    summary.tier2Converged = phase.converged ? 1u : 0u;
    summary.tier2FinalMu = phase.tier2FinalMu;
    summary.tier2FinalMuZero = phase.tier2FinalMuZero ? 1u : 0u;
    summary.tier2LoadFactor = phase.tier2LoadFactor;
    summary.tier2LastResidual = phase.tier2LastResidual;
  }
}

inline bool should_attempt_safety_arc_length_auto(
    const PhaseResult& strengthResult,
    const SolverOptions& opts,
    ConstitutiveKind kind,
    double sigmaLow,
    double sigmaTarget,
    double sigmaHigh,
    double safetyBracketTolerance) {
  if (opts.requestedContinuationMode != RequestedContinuationMode::Auto) return false;
  if (kind != ConstitutiveKind::McPlastic) return false;
  if (strengthResult.converged) return false;
  if (sigmaHigh > 0.0) return false;
  if (!std::isfinite(strengthResult.loadFactor) || strengthResult.loadFactor < 0.90) return false;
  if (strengthResult.accepted < 1 || strengthResult.rejected < 2) return false;
  if ((strengthResult.activeCount + strengthResult.tensionCount +
       strengthResult.displayActiveCount + strengthResult.displayTensionCount) <= 0) {
    return false;
  }
  if (!std::isfinite(sigmaLow) || !std::isfinite(sigmaTarget) || !(sigmaTarget > sigmaLow)) return false;
  const double interval = sigmaTarget - sigmaLow;
  const double tol = std::max(safetyBracketTolerance, 1e-12);
  return interval > tol;
}

inline bool hardening_soil_consistent_tangent_enabled(const std::vector<RegionParams>* regions) {
  if (!regions) return false;
  return std::any_of(regions->begin(), regions->end(), [](const RegionParams& region) {
    return region.hs.useConsistentTangent >= 0.5;
  });
}

inline bool mohr_coulomb_consistent_tangent_enabled(const std::vector<RegionParams>* regions) {
  if (!regions) return false;
  return std::any_of(regions->begin(), regions->end(), [](const RegionParams& region) {
    return region.hs.useConsistentTangent >= 0.5;
  });
}

inline bool mohr_coulomb_consistent_tangent_requires_unsymmetric_solver(
    bool symmetrize,
    const std::vector<RegionParams>* regions) {
  if (symmetrize || !regions) return false;
  return std::any_of(regions->begin(), regions->end(), [](const RegionParams& region) {
    return region.hs.useConsistentTangent >= 0.5 &&
        std::abs(region.phi - region.psi) > 1e-12;
  });
}

// Workstream B: the Tier-2 rescue assembles the EXACT consistent tangent
// regardless of the production `useConsistentTangent` selector, so its
// symmetry must be decided directly from the flow rule. The MC consistent
// tangent is unsymmetric whenever the flow is non-associated (φ ≠ ψ) and the
// caller has not opted into symmetrization. Unsymmetric ⇒ GMRES; symmetric
// ⇒ CG.
inline bool tier2_consistent_tangent_unsymmetric(
    bool symmetrize,
    const std::vector<RegionParams>* regions) {
  if (symmetrize || !regions) return false;
  return std::any_of(regions->begin(), regions->end(), [](const RegionParams& region) {
    return std::abs(region.phi - region.psi) > 1e-12;
  });
}

inline bool phase_may_need_unsymmetric_solver_for_regions(
    ConstitutiveKind kind,
    bool symmetrize,
    const std::vector<RegionParams>* regions) {
  if (kind == ConstitutiveKind::HardeningSoil) return true;
  if (kind == ConstitutiveKind::McPlastic) {
    return mohr_coulomb_consistent_tangent_requires_unsymmetric_solver(symmetrize, regions);
  }
  return false;
}

inline bool phase_may_need_unsymmetric_solver(const PhaseContext& ctx) {
  return phase_may_need_unsymmetric_solver_for_regions(
      ctx.kind, ctx.symmetrize, ctx.regions);
}

inline bool mc_plastic_active_tangent_must_use_gmres(
    const PhaseContext& ctx,
    const std::vector<RegionParams>* regions,
    bool hasPlastic) {
  return ctx.kind == ConstitutiveKind::McPlastic &&
      hasPlastic &&
      mohr_coulomb_consistent_tangent_requires_unsymmetric_solver(ctx.symmetrize, regions);
}

inline double nonlinear_absolute_residual_target(
    const SolverOptions& opts,
    std::int32_t nfree) {
  const double absTol = std::max(opts.residualAbsTol, 0.0);
  // The UI default `1e-3` is a nodal force floor.  The assembled residual is
  // a raw global L2 norm, so the equivalent vector target scales with the
  // square root of the number of free equations.  Explicit larger verifier
  // tolerances keep their historical raw-norm meaning.
  if (absTol <= 1.0000001e-3) {
    const double dofScale = std::sqrt(static_cast<double>(std::max<std::int32_t>(nfree, 1)));
    return absTol * dofScale;
  }
  return absTol;
}

inline double nonlinear_residual_target(
    const SolverOptions& opts,
    double rhsNorm,
    std::int32_t nfree) {
  return std::max(
      nonlinear_absolute_residual_target(opts, nfree),
      opts.residualRelTol * std::max(rhsNorm, 0.0));
}

inline SafetyCurvePoint make_safety_curve_point(
    const PhaseContext& ctx,
    const AssembleOutput& assembly,
    const std::vector<double>& U,
    const std::vector<MaterialPoint>& acceptedMp,
    double lambda,
    std::int32_t continuationStepIndex,
    std::int32_t nonlinearIterations,
    std::int32_t linearIterations,
    double initialResidualNorm,
    double lineSearchAcceptedScale,
    const SolverOptions& opts) {
  SafetyCurvePoint point;
  point.trialIndex = ctx.safetyTrialIndex;
  point.continuationStepIndex = continuationStepIndex;
  point.nonlinearIterations = nonlinearIterations;
  point.linearIterations = linearIterations;
  point.activeCount = assembly.plasticActiveCount;
  point.activeFaceCount = assembly.activeFaceCount;
  point.activeEdgeCount = assembly.activeEdgeCount;
  point.activeApexCount = assembly.activeApexCount;
  point.tensionCount = assembly.tensionCount;
  point.activePlasticElementCount = assembly.plasticActiveCount;
  point.sigmaMsf = ctx.safetySigmaMsfStart +
      (ctx.safetySigmaMsfTarget - ctx.safetySigmaMsfStart) * std::clamp(lambda, 0.0, 1.0);
  point.lambda = lambda;
  point.initialResidualNorm = std::isfinite(initialResidualNorm) ? initialResidualNorm : assembly.residualNorm;
  point.residualNorm = assembly.residualNorm;
  point.relativeResidual = assembly.residualNorm /
      std::max(point.initialResidualNorm, opts.residualAbsTol);
  point.lineSearchAcceptedScale = lineSearchAcceptedScale;

  const std::vector<double>& baseU = ctx.safetyBaseU ? *ctx.safetyBaseU : U;
  const std::int32_t ndof = std::min<std::int32_t>(
      static_cast<std::int32_t>(U.size()),
      static_cast<std::int32_t>(baseU.size()));
  double u2 = 0.0;
  double maxAbs = 0.0;
  std::int32_t dominantDofIndex = -1;
  for (std::int32_t dof = 0; dof < ndof; ++dof) {
    const double du = U[static_cast<std::size_t>(dof)] - baseU[static_cast<std::size_t>(dof)];
    u2 += du * du;
    const double a = std::abs(du);
    if (a > maxAbs) {
      maxAbs = a;
      dominantDofIndex = dof;
    }
    if ((dof & 1) == 0) {
      point.uHorizontalMax = std::max(point.uHorizontalMax, a);
    } else {
      point.uSettlementMax = std::max(point.uSettlementMax, -du);
    }
  }
  point.uMaxAbs = maxAbs;
  point.uNorm = std::sqrt(u2);
  if (dominantDofIndex >= 0) {
    point.dominantNode = dominantDofIndex / 2;
    point.dominantDof = dominantDofIndex & 1;
  }

  const std::vector<MaterialPoint>& comparison =
      ctx.safetyComparison ? *ctx.safetyComparison : acceptedMp;
  const std::size_t nmp = std::min(acceptedMp.size(), comparison.size());
  for (std::size_t i = 0; i < nmp; ++i) {
    const double delta = std::max(
        0.0,
        acceptedMp[i].accumulatedPlasticStrain - comparison[i].accumulatedPlasticStrain);
    point.maxDeltaPlasticStrain = std::max(point.maxDeltaPlasticStrain, delta);
    point.totalDeltaPlasticStrain += delta;
  }
  point.mechanismScore = std::numeric_limits<double>::quiet_NaN();
  return point;
}

inline double safety_sigma_to_phase_lambda(const PhaseContext& ctx, double sigmaMsf) {
  const double denom = ctx.safetySigmaMsfTarget - ctx.safetySigmaMsfStart;
  if (std::abs(denom) <= 1e-14) return 1.0;
  return std::clamp((sigmaMsf - ctx.safetySigmaMsfStart) / denom, 0.0, 1.0);
}

inline PhaseResult run_safety_arc_length_phase(
    PhaseContext& ctx,
    const SolverOptions& opts) {
  auto& elements = *ctx.elements;
  auto& committedMp = *ctx.committed;
  auto& trialMp = *ctx.trial;
  auto& regions = *ctx.regions;
  auto& regionC = *ctx.regionC;
  auto& freeDofs = *ctx.freeDofs;
  auto& freeIndexByDof = *ctx.freeIndexByDof;
  auto& K = *ctx.K;
  auto& U = *ctx.U_global;
  const double* U_base = ctx.U_base ? ctx.U_base->data() : nullptr;
  const double* beamReferenceU = ctx.beamReferenceU ? ctx.beamReferenceU->data() : nullptr;
  const BeamAssemblyMode beamMode = ctx.beamMode;
  const double* baseRhs = ctx.baseRhsFree ? ctx.baseRhsFree->data() : nullptr;
  const double* rampedRhs = ctx.rampedRhsFree ? ctx.rampedRhsFree->data() : nullptr;
  const std::int32_t nfree = K.nrows;

  PhaseResult res;
  if (ctx.phaseKind != PhaseKind::SafetyCphi || !ctx.safetyStrengthBaseRegions) {
    res.converged = false;
    return res;
  }

  std::vector<double> internalForceFree(static_cast<std::size_t>(nfree), 0.0);
  std::vector<double> residualFree(static_cast<std::size_t>(nfree), 0.0);
  std::vector<double> diagInv;
  // Safety c-phi rebuilds reduced material tables as SigmaMsf changes. The
  // unsymmetric-solver predicate is therefore evaluated on those active tables,
  // not only on the phase's base regions.
  const double sigmaTarget = std::max(ctx.safetySigmaMsfTarget, 1.0);
  double sigma = std::max(ctx.safetySigmaMsfStart, 1.0);
  double peakSigma = sigma;
  bool overall = true;

  ArcLengthRuntimeOptions arcRuntime = prepare_arc_length_runtime_options(ctx, opts);
  const SolverOptions& arcOpts = arcRuntime.opts;
  const double displacementScale = arcRuntime.displacementScale;

  ArcLengthState arcState;
  initialise_arc_length_state(arcState, arcOpts, nfree, safety_sigma_to_phase_lambda(ctx, sigma), sigma);
  ArcLengthFdScratch fdScratch;
  PhaseStepMaterials startMaterials;
  PhaseStepMaterials candidateMaterials;
  PhaseStepMaterials probeMaterials;
  std::vector<double> lineSearchCandidateDeltaU;
  std::vector<double> lineSearchBestDeltaU;
  std::vector<double> lineSearchBestU;
  std::vector<MaterialPoint> lineSearchBestTrial;
  std::vector<double> stepStartUScratch;
  std::vector<MaterialPoint> stepStartCommittedScratch;
  std::vector<MaterialPoint> stepStartTrialScratch;
  lineSearchCandidateDeltaU.reserve(static_cast<std::size_t>(std::max(nfree, 0)));
  lineSearchBestDeltaU.reserve(static_cast<std::size_t>(std::max(nfree, 0)));
  lineSearchBestU.reserve(U.size());
  lineSearchBestTrial.reserve(trialMp.size());
  stepStartUScratch.reserve(U.size());
  stepStartCommittedScratch.reserve(committedMp.size());
  stepStartTrialScratch.reserve(trialMp.size());

  auto apply_step_delta = [&](const std::vector<double>& startU,
                              const std::vector<double>& deltaFree) {
    U = startU;
    for (std::int32_t i = 0; i < nfree; ++i) {
      U[static_cast<std::size_t>(freeDofs[static_cast<std::size_t>(i)])] +=
          deltaFree[static_cast<std::size_t>(i)];
    }
  };

  auto remember_display_state = [&](double candidateSigma, const AssembleOutput& assembly) {
    const double candidateLambda = safety_sigma_to_phase_lambda(ctx, candidateSigma);
    const bool prefer =
        !res.hasDisplayState ||
        candidateLambda > res.displayLoadFactor + 1e-10 ||
        (std::abs(candidateLambda - res.displayLoadFactor) <= 1e-10 &&
         assembly.residualNorm < res.displayResidualNorm - 1e-12);
    if (!prefer) return;
    res.hasDisplayState = true;
    res.displayLoadFactor = candidateLambda;
    res.displayResidualNorm = assembly.residualNorm;
    res.displayActiveCount = assembly.plasticActiveCount;
    res.displayActiveFaceCount = assembly.activeFaceCount;
    res.displayActiveEdgeCount = assembly.activeEdgeCount;
    res.displayActiveApexCount = assembly.activeApexCount;
    res.displayTensionCount = assembly.tensionCount;
    res.displayU = U;
    res.displayMp = trialMp;
  };

  for (std::int32_t step = 0; step < arcOpts.maxLoadSteps; ++step) {
    if (sigma >= sigmaTarget - 1e-12) break;

    bool stepConverged = false;
    for (std::int32_t retry = 0; retry < std::max(arcOpts.arcLengthMaxRetries, 1); ++retry) {
      const double stepStartSigma = sigma;
      stepStartUScratch.assign(U.begin(), U.end());
      stepStartCommittedScratch.assign(committedMp.begin(), committedMp.end());
      stepStartTrialScratch.assign(trialMp.begin(), trialMp.end());
      const double stepStartLambda = safety_sigma_to_phase_lambda(ctx, stepStartSigma);

      prepare_safety_sigma_msf_materials(ctx, regions, regionC, stepStartSigma, startMaterials);
      trialMp = committedMp;
      AssembleOutput startAssembly = assemble_global(
          elements, ctx.beamElements, committedMp, trialMp, *startMaterials.regions, *startMaterials.regionC,
          freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
          stepStartLambda, ctx.kind, ctx.symmetrize,
          ctx.incrementalStress,
          /*wantTangent=*/true,
          K, internalForceFree, residualFree,
          /*useElasticGlobalizationTangent=*/false,
          beamMode, beamReferenceU);
      res.maxEta = std::max(res.maxEta, startAssembly.maxEta);
      res.activeCount = startAssembly.plasticActiveCount;
      res.activeFaceCount = startAssembly.activeFaceCount;
      res.activeEdgeCount = startAssembly.activeEdgeCount;
      res.activeApexCount = startAssembly.activeApexCount;
      res.tensionCount = startAssembly.tensionCount;
      res.residualNorm = startAssembly.residualNorm;
      const bool startHasPlastic = startAssembly.plasticActiveCount > 0 || startAssembly.tensionCount > 0;
      const bool startMayNeedUnsymmetricSolver =
          phase_may_need_unsymmetric_solver_for_regions(
              ctx.kind, ctx.symmetrize, startMaterials.regions);
      const bool useUnsymmetricSolver =
          startMayNeedUnsymmetricSolver && startHasPlastic;

      SafetyResidualDerivativeFd derivative = compute_safety_sigma_msf_residual_derivative(
          ctx, U, stepStartLambda, stepStartSigma, fdScratch, arcOpts);
      if (!derivative.converged) {
        committedMp = stepStartCommittedScratch;
        trialMp = stepStartTrialScratch;
        U = stepStartUScratch;
        break;
      }

      ArcLengthPredictor predictor = make_load_control_arc_length_predictor(
          K, freeDofs, derivative.continuationRhsFree, diagInv, arcOpts, arcState,
          displacementScale, useUnsymmetricSolver);
      res.cgIterations += predictor.linearIterations;
      if (useUnsymmetricSolver) {
        res.gmresIterationCount += predictor.linearIterations;
        res.gmresInvocations += 1;
      }
      res.lastLinearSolverKind = useUnsymmetricSolver ? std::uint8_t{1} : std::uint8_t{0};
      if (!arc_length_predictor_direction_allowed(predictor, arcState, arcOpts)) {
        committedMp = stepStartCommittedScratch;
        trialMp = stepStartTrialScratch;
        U = stepStartUScratch;
        break;
      }

      double predictorScale = 1.0;
      if (stepStartSigma + predictor.deltaLambda > sigmaTarget) {
        predictorScale = (sigmaTarget - stepStartSigma) / predictor.deltaLambda;
      }
      if (!(predictorScale > 0.0) || !std::isfinite(predictorScale)) {
        committedMp = stepStartCommittedScratch;
        trialMp = stepStartTrialScratch;
        U = stepStartUScratch;
        break;
      }
      if (predictorScale < 1.0) {
        predictor.deltaLambda *= predictorScale;
        for (double& v : predictor.deltaUFree) v *= predictorScale;
      }

      std::vector<double> stepDeltaUFree = std::move(predictor.deltaUFree);
      double stepDeltaSigma = predictor.deltaLambda;
      ArcLengthState stepState = arcState;
      stepState.deltaS = std::sqrt(std::max(
          arc_length_weighted_norm2(stepDeltaUFree, displacementScale) +
          stepState.alpha * stepState.alpha * stepDeltaSigma * stepDeltaSigma,
          0.0));
      if (!(stepState.deltaS > 0.0) || !std::isfinite(stepState.deltaS)) {
        committedMp = stepStartCommittedScratch;
        trialMp = stepStartTrialScratch;
        U = stepStartUScratch;
        break;
      }

      apply_step_delta(stepStartUScratch, stepDeltaUFree);
      double lastAcceptedScale = 1.0;
      double stepInitialResidualNorm = std::numeric_limits<double>::quiet_NaN();
      double lastConstraintResidual = std::numeric_limits<double>::quiet_NaN();
      double lastCorrectionDenominator = std::numeric_limits<double>::quiet_NaN();
      double stepMeritBeta = 1.0;
      bool hasStepMeritBeta = false;
      std::uint16_t lastFailureCode = 0u;
      std::int32_t stepLinearIterations = predictor.linearIterations;
      std::int32_t newtonIterUsed = 0;
      bool invalidStep = false;
      AssembleOutput lastAssembly;
      bool hasLastAssembly = false;

      for (std::int32_t newtonIter = 1; newtonIter <= arcOpts.nonlinearMaxIter; ++newtonIter) {
        const double candidateSigma = stepStartSigma + stepDeltaSigma;
        if (!(candidateSigma >= 1.0) || candidateSigma > sigmaTarget + 1e-10) {
          invalidStep = true;
          break;
        }
        const double candidateLambda = safety_sigma_to_phase_lambda(ctx, candidateSigma);
        prepare_safety_sigma_msf_materials(ctx, regions, regionC, candidateSigma, candidateMaterials);
        AssembleOutput a = assemble_global(
            elements, ctx.beamElements, committedMp, trialMp, *candidateMaterials.regions, *candidateMaterials.regionC,
            freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
            candidateLambda, ctx.kind, ctx.symmetrize,
            ctx.incrementalStress,
            /*wantTangent=*/true,
            K, internalForceFree, residualFree,
            /*useElasticGlobalizationTangent=*/false,
            beamMode, beamReferenceU);
        lastAssembly = a;
        hasLastAssembly = true;
        ++res.newtonIterations;
        newtonIterUsed = newtonIter;
        res.maxEta = std::max(res.maxEta, a.maxEta);
        res.activeCount = a.plasticActiveCount;
        res.activeFaceCount = a.activeFaceCount;
        res.activeEdgeCount = a.activeEdgeCount;
        res.activeApexCount = a.activeApexCount;
        res.tensionCount = a.tensionCount;
        res.residualNorm = a.residualNorm;
        if (!std::isfinite(stepInitialResidualNorm)) stepInitialResidualNorm = a.residualNorm;
        remember_display_state(candidateSigma, a);

        lastConstraintResidual = arc_length_constraint_residual(
            stepDeltaUFree, stepDeltaSigma, stepState.deltaS, stepState.alpha, displacementScale);
        if (!hasStepMeritBeta) {
          stepMeritBeta = arc_length_quadratic_merit_beta(
              a.residualNorm, lastConstraintResidual);
          hasStepMeritBeta = true;
        }
        const double residualTarget = nonlinear_residual_target(arcOpts, a.rhsNorm, nfree);
        const double constraintTarget = std::max(
            arcOpts.arcLengthConstraintTolerance,
            arcOpts.arcLengthConstraintTolerance * std::max(stepState.deltaS * stepState.deltaS, 1.0));
        if (newtonIter > 1 &&
            a.residualNorm <= residualTarget &&
            std::abs(lastConstraintResidual) <= constraintTarget) {
          stepConverged = true;
          break;
        }

        const bool hasPlastic = a.plasticActiveCount > 0 || a.tensionCount > 0;
        const bool candidateMayNeedUnsymmetricSolver =
            phase_may_need_unsymmetric_solver_for_regions(
                ctx.kind, ctx.symmetrize, candidateMaterials.regions);
        const bool tangentAsymmetric =
            candidateMayNeedUnsymmetricSolver && hasPlastic;
        // Exact plastic tangents that are known to be unsymmetric must never be
        // routed to CG. CG requires SPD; non-associated MC-SH and HS plastic
        // tangents use GMRES.
#ifndef NDEBUG
        if (ctx.kind == ConstitutiveKind::HardeningSoil && hasPlastic && !tangentAsymmetric) {
          assert(false && "HS plastic safety arc-length step routed to CG; expected GMRES");
        }
        if (mc_plastic_active_tangent_must_use_gmres(ctx, candidateMaterials.regions, hasPlastic) &&
            !tangentAsymmetric) {
          assert(false && "MC consistent non-associated plastic safety arc-length step routed to CG; expected GMRES");
        }
#endif
        SafetyResidualDerivativeFd correctionDerivative =
            compute_safety_sigma_msf_residual_derivative(
                ctx, U, candidateLambda, candidateSigma, fdScratch, arcOpts);
        if (!correctionDerivative.converged) {
          lastFailureCode = correctionDerivative.failureCode;
          invalidStep = true;
          break;
        }
        ArcLengthCorrector corrector = compute_arc_length_corrector(
            K, freeDofs, residualFree, correctionDerivative.continuationRhsFree,
            stepDeltaUFree, stepDeltaSigma, stepState, diagInv, arcOpts,
            displacementScale, tangentAsymmetric);
        res.cgIterations += corrector.linearIterations;
        stepLinearIterations += corrector.linearIterations;
        if (tangentAsymmetric) {
          res.gmresIterationCount += corrector.linearIterations;
          res.gmresInvocations += 1;
        }
        res.lastLinearSolverKind = tangentAsymmetric ? std::uint8_t{1} : std::uint8_t{0};
        lastCorrectionDenominator = corrector.denominator;
        lastFailureCode = corrector.failureCode;
        if (!corrector.converged) {
          invalidStep = true;
          break;
        }

        const double currentMerit = arc_length_line_search_merit(
            a.residualNorm, lastConstraintResidual, stepState.deltaS, stepMeritBeta, arcOpts);
        double bestMerit = std::numeric_limits<double>::infinity();
        double bestScale = 0.0;
        lineSearchBestDeltaU.assign(stepDeltaUFree.begin(), stepDeltaUFree.end());
        double bestDeltaSigma = stepDeltaSigma;
        lineSearchBestU.assign(U.begin(), U.end());
        lineSearchBestTrial.assign(trialMp.begin(), trialMp.end());
        double bestAssemblyMaxEta = 0.0;

        double eta = 1.0;
        const int kArcLengthLineSearchMaxBacktracks =
            arc_length_line_search_max_backtracks(arcOpts);
        for (int bt = 0; bt < kArcLengthLineSearchMaxBacktracks; ++bt) {
          lineSearchCandidateDeltaU.assign(stepDeltaUFree.begin(), stepDeltaUFree.end());
          for (std::int32_t i = 0; i < nfree; ++i) {
            lineSearchCandidateDeltaU[static_cast<std::size_t>(i)] +=
                eta * corrector.deltaUFree[static_cast<std::size_t>(i)];
          }
          const double candidateDeltaSigma = stepDeltaSigma + eta * corrector.deltaLambda;
          const double probeSigma = stepStartSigma + candidateDeltaSigma;
          if (probeSigma >= 1.0 && probeSigma <= sigmaTarget + 1e-10) {
            apply_step_delta(stepStartUScratch, lineSearchCandidateDeltaU);
            trialMp = committedMp;
            const double probeLambda = safety_sigma_to_phase_lambda(ctx, probeSigma);
            prepare_safety_sigma_msf_materials(ctx, regions, regionC, probeSigma, probeMaterials);
            AssembleOutput probe = assemble_global(
                elements, ctx.beamElements, committedMp, trialMp, *probeMaterials.regions, *probeMaterials.regionC,
                freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
                probeLambda, ctx.kind, ctx.symmetrize,
                ctx.incrementalStress,
                /*wantTangent=*/false,
                K, internalForceFree, residualFree,
                /*useElasticGlobalizationTangent=*/false,
                beamMode, beamReferenceU);
            const double constraint = arc_length_constraint_residual(
                lineSearchCandidateDeltaU, candidateDeltaSigma, stepState.deltaS,
                stepState.alpha, displacementScale);
            const double merit = arc_length_line_search_merit(
                probe.residualNorm, constraint, stepState.deltaS, stepMeritBeta, arcOpts);
            if (std::isfinite(merit) && merit < bestMerit) {
              bestMerit = merit;
              bestScale = eta;
              lineSearchBestDeltaU.assign(
                  lineSearchCandidateDeltaU.begin(), lineSearchCandidateDeltaU.end());
              bestDeltaSigma = candidateDeltaSigma;
              lineSearchBestU.assign(U.begin(), U.end());
              lineSearchBestTrial.assign(trialMp.begin(), trialMp.end());
              bestAssemblyMaxEta = probe.maxEta;
            }
            if (merit <= currentMerit || eta <= arcOpts.plasticLineSearchMinScale + 1e-12) break;
          }
          eta *= 0.5;
        }
        if (!(bestScale > 0.0) || !std::isfinite(bestMerit)) {
          invalidStep = true;
          break;
        }
        std::swap(stepDeltaUFree, lineSearchBestDeltaU);
        stepDeltaSigma = bestDeltaSigma;
        std::swap(U, lineSearchBestU);
        std::swap(trialMp, lineSearchBestTrial);
        lastAcceptedScale = bestScale;
        res.maxEta = std::max(res.maxEta, bestAssemblyMaxEta);
      }

      if (stepConverged) {
        const double acceptedSigma = stepStartSigma + stepDeltaSigma;
        sigma = acceptedSigma;
        peakSigma = std::max(peakSigma, acceptedSigma);
        ++res.accepted;
        committedMp = trialMp;
        const double acceptedLambda = safety_sigma_to_phase_lambda(ctx, acceptedSigma);
        if (!hasLastAssembly) {
          overall = false;
          break;
        }
        assert(hasLastAssembly);
        res.activeCount = lastAssembly.plasticActiveCount;
        res.activeFaceCount = lastAssembly.activeFaceCount;
        res.activeEdgeCount = lastAssembly.activeEdgeCount;
        res.activeApexCount = lastAssembly.activeApexCount;
        res.tensionCount = lastAssembly.tensionCount;
        res.residualNorm = lastAssembly.residualNorm;
        remember_display_state(acceptedSigma, lastAssembly);
        if (ctx.safetyCurve) {
          SafetyCurvePoint point = make_safety_curve_point(
              ctx,
              lastAssembly,
              U,
              committedMp,
              acceptedLambda,
              res.accepted - 1,
              newtonIterUsed,
              stepLinearIterations,
              stepInitialResidualNorm,
              lastAcceptedScale,
              opts);
          point.sigmaMsf = acceptedSigma;
          point.lambda = acceptedLambda;
          point.actualContinuationMode = static_cast<std::uint8_t>(ActualContinuationMode::ArcLength);
          point.hasArcLengthDetails = 1u;
          point.arcLengthFailureCode = lastFailureCode;
          point.arcLengthLinearSolveCount = stepLinearIterations;
          point.arcLengthDeltaLambda = stepDeltaSigma;
          point.arcLengthDeltaS = stepState.deltaS;
          point.arcLengthAlpha = stepState.alpha;
          point.arcLengthConstraintResidual =
              std::isfinite(lastConstraintResidual) ? lastConstraintResidual : 0.0;
          point.arcLengthCorrectionDenominator =
              std::isfinite(lastCorrectionDenominator) ? lastCorrectionDenominator : 0.0;
          ctx.safetyCurve->push_back(point);
        }

        arcState.previousDeltaU = std::move(stepDeltaUFree);
        arcState.previousDeltaLambda = stepDeltaSigma;
        arcState.lambda = acceptedLambda;
        arcState.sigmaMsf = acceptedSigma;
        arcState.acceptedStepCount += 1;
        const double iterFactor = std::pow(
            std::max(arcOpts.arcLengthTargetIterations, 1.0) /
                std::max(static_cast<double>(newtonIterUsed), 1.0),
            0.5);
        const double factor = std::clamp(
            iterFactor,
            std::max(arcOpts.arcLengthShrinkFactor, 1e-3),
            std::max(arcOpts.arcLengthGrowthFactor, 1.0));
        arcState.deltaS = std::clamp(
            arcState.deltaS * factor,
            std::max(arcOpts.arcLengthMinRadius, 1e-12),
            std::max(arcOpts.arcLengthMaxRadius, arcOpts.arcLengthMinRadius));
        break;
      }

      ++res.rejected;
      arcState.rejectedStepCount += 1;
      committedMp = stepStartCommittedScratch;
      trialMp = stepStartTrialScratch;
      U = stepStartUScratch;
      const double shrink = invalidStep
          ? std::clamp(arcOpts.arcLengthFailureShrinkFactor, 1e-3, 1.0)
          : std::clamp(arcOpts.arcLengthShrinkFactor, 1e-3, 1.0);
      arcState.deltaS *= shrink;
      if (arcState.deltaS < std::max(arcOpts.arcLengthMinRadius, 1e-12)) {
        overall = false;
        break;
      }
    }

    if (!stepConverged) {
      overall = false;
      break;
    }
  }

  res.loadFactor = safety_sigma_to_phase_lambda(ctx, peakSigma);
  res.converged = overall && sigma >= sigmaTarget - 1e-6;
  return res;
}

inline PhaseResult run_load_arc_length_phase(
    PhaseContext& ctx,
    const SolverOptions& opts,
    double startLoadFactor) {
  auto& elements = *ctx.elements;
  auto& committedMp = *ctx.committed;
  auto& trialMp = *ctx.trial;
  auto& regions = *ctx.regions;
  auto& regionC = *ctx.regionC;
  auto& freeDofs = *ctx.freeDofs;
  auto& freeIndexByDof = *ctx.freeIndexByDof;
  auto& K = *ctx.K;
  auto& U = *ctx.U_global;
  const double* U_base = ctx.U_base ? ctx.U_base->data() : nullptr;
  const double* beamReferenceU = ctx.beamReferenceU ? ctx.beamReferenceU->data() : nullptr;
  const BeamAssemblyMode beamMode = ctx.beamMode;
  const double* baseRhs = ctx.baseRhsFree ? ctx.baseRhsFree->data() : nullptr;
  const double* rampedRhs = ctx.rampedRhsFree ? ctx.rampedRhsFree->data() : nullptr;
  const std::int32_t nfree = K.nrows;

  PhaseResult res;
  if (!ctx.rampedRhsFree || ctx.phaseKind != PhaseKind::ServiceLoad ||
      ctx.kind != ConstitutiveKind::HardeningSoil) {
    res.converged = false;
    res.loadFactor = std::clamp(startLoadFactor, 0.0, 1.0);
    return res;
  }

  std::vector<double> continuationRhsFree(static_cast<std::size_t>(nfree), 0.0);
  for (std::int32_t i = 0; i < nfree; ++i) {
    continuationRhsFree[static_cast<std::size_t>(i)] =
        (*ctx.rampedRhsFree)[static_cast<std::size_t>(i)];
  }

  std::vector<double> internalForceFree(static_cast<std::size_t>(nfree), 0.0);
  std::vector<double> residualFree(static_cast<std::size_t>(nfree), 0.0);
  std::vector<double> diagInv;
  const bool mayNeedUnsymmetricSolver = true;
  double loadFactor = std::clamp(startLoadFactor, 0.0, 1.0);
  bool overall = true;

  ArcLengthRuntimeOptions arcRuntime = prepare_arc_length_runtime_options(ctx, opts);
  SolverOptions arcOpts = arcRuntime.opts;
  // Service-load arc length uses a dimensionless load factor λ. The
  // displacement part of the constraint is domain-scaled, but λ is not a
  // length-like coordinate; keeping the radius capped by the model-length
  // scaling forces large domains into thousands of tiny load increments.
  arcOpts.arcLengthMinRadius = std::min(arcOpts.arcLengthMinRadius, 1e-6);
  arcOpts.arcLengthMaxRadius = std::max(arcOpts.arcLengthMaxRadius, 5e-2);
  if (arcOpts.arcLengthInitialRadius < 2e-2) {
    arcOpts.arcLengthInitialRadius = std::min(2e-2, arcOpts.arcLengthMaxRadius);
  }
  const double displacementScale = arcRuntime.displacementScale;
  constexpr double kLoadCompletionTol = 1e-6;

  ArcLengthState arcState;
  initialise_arc_length_state(arcState, arcOpts, nfree, loadFactor, 1.0);
  PhaseStepMaterials candidateMaterials;
  PhaseStepMaterials probeMaterials;
  std::vector<double> lineSearchCandidateDeltaU;
  std::vector<double> lineSearchBestDeltaU;
  std::vector<double> lineSearchBestU;
  std::vector<MaterialPoint> lineSearchBestTrial;
  std::vector<double> stepStartUScratch;
  std::vector<MaterialPoint> stepStartCommittedScratch;
  std::vector<MaterialPoint> stepStartTrialScratch;
  lineSearchCandidateDeltaU.reserve(static_cast<std::size_t>(std::max(nfree, 0)));
  lineSearchBestDeltaU.reserve(static_cast<std::size_t>(std::max(nfree, 0)));
  lineSearchBestU.reserve(U.size());
  lineSearchBestTrial.reserve(trialMp.size());
  stepStartUScratch.reserve(U.size());
  stepStartCommittedScratch.reserve(committedMp.size());
  stepStartTrialScratch.reserve(trialMp.size());

  auto apply_step_delta = [&](const std::vector<double>& startU,
                              const std::vector<double>& deltaFree) {
    U = startU;
    for (std::int32_t i = 0; i < nfree; ++i) {
      U[static_cast<std::size_t>(freeDofs[static_cast<std::size_t>(i)])] +=
          deltaFree[static_cast<std::size_t>(i)];
    }
  };

  for (std::int32_t step = 0; step < arcOpts.maxLoadSteps; ++step) {
    if (loadFactor >= 1.0 - kLoadCompletionTol) break;

    bool stepConverged = false;
    for (std::int32_t retry = 0; retry < std::max(arcOpts.arcLengthMaxRetries, 1); ++retry) {
      const double stepStartLambda = loadFactor;
      stepStartUScratch.assign(U.begin(), U.end());
      stepStartCommittedScratch.assign(committedMp.begin(), committedMp.end());
      stepStartTrialScratch.assign(trialMp.begin(), trialMp.end());

      trialMp = committedMp;
      AssembleOutput startAssembly = assemble_global(
          elements, ctx.beamElements, committedMp, trialMp, regions, regionC,
          freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
          stepStartLambda, ctx.kind, ctx.symmetrize,
          ctx.incrementalStress,
          /*wantTangent=*/true,
          K, internalForceFree, residualFree,
          /*useElasticGlobalizationTangent=*/false,
          beamMode, beamReferenceU);
      res.maxEta = std::max(res.maxEta, startAssembly.maxEta);
      res.activeCount = startAssembly.plasticActiveCount;
      res.activeFaceCount = startAssembly.activeFaceCount;
      res.activeEdgeCount = startAssembly.activeEdgeCount;
      res.activeApexCount = startAssembly.activeApexCount;
      res.tensionCount = startAssembly.tensionCount;
      res.residualNorm = startAssembly.residualNorm;
      const bool startHasPlastic = startAssembly.plasticActiveCount > 0 || startAssembly.tensionCount > 0;
      const bool useUnsymmetricSolver =
          mayNeedUnsymmetricSolver && startHasPlastic;

      ArcLengthPredictor predictor = make_load_control_arc_length_predictor(
          K, freeDofs, continuationRhsFree, diagInv, arcOpts, arcState,
          displacementScale, useUnsymmetricSolver);
      res.cgIterations += predictor.linearIterations;
      if (useUnsymmetricSolver) {
        res.gmresIterationCount += predictor.linearIterations;
        res.gmresInvocations += 1;
      }
      res.lastLinearSolverKind = useUnsymmetricSolver ? std::uint8_t{1} : std::uint8_t{0};
      if (!predictor.converged &&
          startHasPlastic &&
          ctx.kind != ConstitutiveKind::HardeningSoil) {
        trialMp = committedMp;
        AssembleOutput elasticPredictorAssembly = assemble_global(
            elements, ctx.beamElements, committedMp, trialMp, regions, regionC,
            freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
            stepStartLambda, ctx.kind, ctx.symmetrize,
            ctx.incrementalStress,
            /*wantTangent=*/true,
            K, internalForceFree, residualFree,
            /*useElasticGlobalizationTangent=*/true,
            beamMode, beamReferenceU);
        res.maxEta = std::max(res.maxEta, elasticPredictorAssembly.maxEta);
        predictor = make_load_control_arc_length_predictor(
            K, freeDofs, continuationRhsFree, diagInv, arcOpts, arcState,
            displacementScale, /*useUnsymmetricSolver=*/false);
        res.cgIterations += predictor.linearIterations;
        res.lastLinearSolverKind = 0;
      }
      if (!predictor.converged || !(predictor.deltaLambda > 0.0)) {
        committedMp = stepStartCommittedScratch;
        trialMp = stepStartTrialScratch;
        U = stepStartUScratch;
        break;
      }

      double predictorScale = 1.0;
      if (stepStartLambda + predictor.deltaLambda > 1.0) {
        predictorScale = (1.0 - stepStartLambda) / predictor.deltaLambda;
      }
      if (!(predictorScale > 0.0) || !std::isfinite(predictorScale)) {
        committedMp = stepStartCommittedScratch;
        trialMp = stepStartTrialScratch;
        U = stepStartUScratch;
        break;
      }
      if (predictorScale < 1.0) {
        predictor.deltaLambda *= predictorScale;
        for (double& v : predictor.deltaUFree) v *= predictorScale;
      }

      std::vector<double> stepDeltaUFree = std::move(predictor.deltaUFree);
      double stepDeltaLambda = predictor.deltaLambda;
      ArcLengthState stepState = arcState;
      stepState.deltaS = std::sqrt(std::max(
          arc_length_weighted_norm2(stepDeltaUFree, displacementScale) +
          stepState.alpha * stepState.alpha * stepDeltaLambda * stepDeltaLambda,
          0.0));
      if (!(stepState.deltaS > 0.0) || !std::isfinite(stepState.deltaS)) {
        committedMp = stepStartCommittedScratch;
        trialMp = stepStartTrialScratch;
        U = stepStartUScratch;
        break;
      }

      apply_step_delta(stepStartUScratch, stepDeltaUFree);
      double lastAcceptedScale = 1.0;
      double stepInitialResidualNorm = std::numeric_limits<double>::quiet_NaN();
      double lastConstraintResidual = std::numeric_limits<double>::quiet_NaN();
      double lastCorrectionDenominator = std::numeric_limits<double>::quiet_NaN();
      double stepMeritBeta = 1.0;
      bool hasStepMeritBeta = false;
      std::int32_t stepLinearIterations = predictor.linearIterations;
      std::int32_t newtonIterUsed = 0;
      bool invalidStep = false;
      AssembleOutput lastAssembly;
      bool hasLastAssembly = false;

      for (std::int32_t newtonIter = 1; newtonIter <= arcOpts.nonlinearMaxIter; ++newtonIter) {
        const double candidateLambda = stepStartLambda + stepDeltaLambda;
        if (!(candidateLambda >= stepStartLambda - 1e-12) || candidateLambda > 1.0 + 1e-10) {
          invalidStep = true;
          break;
        }
        prepare_phase_step_materials(ctx, regions, regionC, candidateLambda, candidateMaterials);
        AssembleOutput a = assemble_global(
            elements, ctx.beamElements, committedMp, trialMp, *candidateMaterials.regions, *candidateMaterials.regionC,
            freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
            candidateLambda, ctx.kind, ctx.symmetrize,
            ctx.incrementalStress,
            /*wantTangent=*/true,
            K, internalForceFree, residualFree,
            /*useElasticGlobalizationTangent=*/false,
            beamMode, beamReferenceU);
        lastAssembly = a;
        hasLastAssembly = true;
        ++res.newtonIterations;
        newtonIterUsed = newtonIter;
        res.maxEta = std::max(res.maxEta, a.maxEta);
        res.activeCount = a.plasticActiveCount;
        res.activeFaceCount = a.activeFaceCount;
        res.activeEdgeCount = a.activeEdgeCount;
        res.activeApexCount = a.activeApexCount;
        res.tensionCount = a.tensionCount;
        res.residualNorm = a.residualNorm;
        if (!std::isfinite(stepInitialResidualNorm)) stepInitialResidualNorm = a.residualNorm;

        const bool hsHardFailure =
            a.hsFailureCode == 101 || a.hsFailureCode == 102 ||
            a.hsFailureCode == 103 || a.hsFailureCode == 104 ||
            a.hsFailureCode == 105 || a.hsFailureCode == 106 ||
            a.hsFailureCode == 999;
        if (hsHardFailure) {
          res.lastHsFailureCode = a.hsFailureCode;
          invalidStep = true;
          break;
        }

        lastConstraintResidual = arc_length_constraint_residual(
            stepDeltaUFree, stepDeltaLambda, stepState.deltaS,
            stepState.alpha, displacementScale);
        if (!hasStepMeritBeta) {
          stepMeritBeta = arc_length_quadratic_merit_beta(
              a.residualNorm, lastConstraintResidual);
          hasStepMeritBeta = true;
        }
        const double residualTarget = nonlinear_residual_target(arcOpts, a.rhsNorm, nfree);
        const double constraintTarget = std::max(
            arcOpts.arcLengthConstraintTolerance,
            arcOpts.arcLengthConstraintTolerance * std::max(stepState.deltaS * stepState.deltaS, 1.0));
        if (newtonIter > 1 &&
            a.residualNorm <= residualTarget &&
            std::abs(lastConstraintResidual) <= constraintTarget) {
          stepConverged = true;
          break;
        }

        const bool hasPlastic = a.plasticActiveCount > 0 || a.tensionCount > 0;
        const bool tangentAsymmetric =
            mayNeedUnsymmetricSolver && hasPlastic;
#ifndef NDEBUG
        if (ctx.kind == ConstitutiveKind::HardeningSoil && hasPlastic && !tangentAsymmetric) {
          assert(false && "HS plastic service arc-length step routed to CG; expected GMRES");
        }
#endif
        ArcLengthCorrector corrector = compute_arc_length_corrector(
            K, freeDofs, residualFree, continuationRhsFree,
            stepDeltaUFree, stepDeltaLambda, stepState, diagInv, arcOpts,
            displacementScale, tangentAsymmetric);
        res.cgIterations += corrector.linearIterations;
        stepLinearIterations += corrector.linearIterations;
        if (tangentAsymmetric) {
          res.gmresIterationCount += corrector.linearIterations;
          res.gmresInvocations += 1;
        }
        res.lastLinearSolverKind = tangentAsymmetric ? std::uint8_t{1} : std::uint8_t{0};
        lastCorrectionDenominator = corrector.denominator;
        if (!corrector.converged) {
          invalidStep = true;
          break;
        }

        const double currentMerit = arc_length_line_search_merit(
            a.residualNorm, lastConstraintResidual, stepState.deltaS, stepMeritBeta, arcOpts);
        double bestMerit = std::numeric_limits<double>::infinity();
        double bestScale = 0.0;
        lineSearchBestDeltaU.assign(stepDeltaUFree.begin(), stepDeltaUFree.end());
        double bestDeltaLambda = stepDeltaLambda;
        lineSearchBestU.assign(U.begin(), U.end());
        lineSearchBestTrial.assign(trialMp.begin(), trialMp.end());
        double bestAssemblyMaxEta = 0.0;

        double eta = 1.0;
        const int maxBacktracks = arc_length_line_search_max_backtracks(arcOpts);
        for (int bt = 0; bt < maxBacktracks; ++bt) {
          lineSearchCandidateDeltaU.assign(stepDeltaUFree.begin(), stepDeltaUFree.end());
          for (std::int32_t i = 0; i < nfree; ++i) {
            lineSearchCandidateDeltaU[static_cast<std::size_t>(i)] +=
                eta * corrector.deltaUFree[static_cast<std::size_t>(i)];
          }
          const double candidateDeltaLambda = stepDeltaLambda + eta * corrector.deltaLambda;
          const double probeLambda = stepStartLambda + candidateDeltaLambda;
          if (probeLambda >= stepStartLambda - 1e-12 && probeLambda <= 1.0 + 1e-10) {
            apply_step_delta(stepStartUScratch, lineSearchCandidateDeltaU);
            trialMp = committedMp;
            prepare_phase_step_materials(ctx, regions, regionC, probeLambda, probeMaterials);
            AssembleOutput probe = assemble_global(
                elements, ctx.beamElements, committedMp, trialMp, *probeMaterials.regions, *probeMaterials.regionC,
                freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
                probeLambda, ctx.kind, ctx.symmetrize,
                ctx.incrementalStress,
                /*wantTangent=*/false,
                K, internalForceFree, residualFree,
                /*useElasticGlobalizationTangent=*/false,
                beamMode, beamReferenceU);
            const bool probeHardFailure =
                probe.hsFailureCode == 101 || probe.hsFailureCode == 102 ||
                probe.hsFailureCode == 103 || probe.hsFailureCode == 104 ||
                probe.hsFailureCode == 105 || probe.hsFailureCode == 106 ||
                probe.hsFailureCode == 999;
            if (!probeHardFailure) {
              const double constraint = arc_length_constraint_residual(
                  lineSearchCandidateDeltaU, candidateDeltaLambda, stepState.deltaS,
                  stepState.alpha, displacementScale);
              const double merit = arc_length_line_search_merit(
                  probe.residualNorm, constraint, stepState.deltaS, stepMeritBeta, arcOpts);
              if (std::isfinite(merit) && merit < bestMerit) {
                bestMerit = merit;
                bestScale = eta;
                lineSearchBestDeltaU.assign(
                    lineSearchCandidateDeltaU.begin(), lineSearchCandidateDeltaU.end());
                bestDeltaLambda = candidateDeltaLambda;
                lineSearchBestU.assign(U.begin(), U.end());
                lineSearchBestTrial.assign(trialMp.begin(), trialMp.end());
                bestAssemblyMaxEta = probe.maxEta;
              }
              if (merit <= currentMerit || eta <= arcOpts.plasticLineSearchMinScale + 1e-12) break;
            }
          }
          eta *= 0.5;
        }
        if (!(bestScale > 0.0) || !std::isfinite(bestMerit)) {
          invalidStep = true;
          break;
        }
        std::swap(stepDeltaUFree, lineSearchBestDeltaU);
        stepDeltaLambda = bestDeltaLambda;
        std::swap(U, lineSearchBestU);
        std::swap(trialMp, lineSearchBestTrial);
        lastAcceptedScale = bestScale;
        (void)lastAcceptedScale;
        res.maxEta = std::max(res.maxEta, bestAssemblyMaxEta);
      }

      if (stepConverged) {
        loadFactor = stepStartLambda + stepDeltaLambda;
        ++res.accepted;
        committedMp = trialMp;
        if (!hasLastAssembly) {
          overall = false;
          break;
        }
        res.activeCount = lastAssembly.plasticActiveCount;
        res.activeFaceCount = lastAssembly.activeFaceCount;
        res.activeEdgeCount = lastAssembly.activeEdgeCount;
        res.activeApexCount = lastAssembly.activeApexCount;
        res.tensionCount = lastAssembly.tensionCount;
        res.residualNorm = lastAssembly.residualNorm;
        arcState.previousDeltaU = std::move(stepDeltaUFree);
        arcState.previousDeltaLambda = stepDeltaLambda;
        arcState.lambda = loadFactor;
        arcState.acceptedStepCount += 1;
        const double iterFactor = std::pow(
            std::max(arcOpts.arcLengthTargetIterations, 1.0) /
                std::max(static_cast<double>(newtonIterUsed), 1.0),
            0.5);
        const double factor = std::clamp(
            iterFactor,
            std::max(arcOpts.arcLengthShrinkFactor, 1e-3),
            std::max(arcOpts.arcLengthGrowthFactor, 1.0));
        arcState.deltaS = std::clamp(
            arcState.deltaS * factor,
            std::max(arcOpts.arcLengthMinRadius, 1e-12),
            std::max(arcOpts.arcLengthMaxRadius, arcOpts.arcLengthMinRadius));
        (void)stepInitialResidualNorm;
        (void)lastCorrectionDenominator;
        break;
      }

      ++res.rejected;
      arcState.rejectedStepCount += 1;
      committedMp = stepStartCommittedScratch;
      trialMp = stepStartTrialScratch;
      U = stepStartUScratch;
      const double shrink = invalidStep
          ? std::clamp(arcOpts.arcLengthFailureShrinkFactor, 1e-3, 1.0)
          : std::clamp(arcOpts.arcLengthShrinkFactor, 1e-3, 1.0);
      arcState.deltaS *= shrink;
      if (arcState.deltaS < std::max(arcOpts.arcLengthMinRadius, 1e-12)) {
        overall = false;
        break;
      }
    }

    if (!stepConverged) {
      overall = false;
      break;
    }
  }

  res.loadFactor = loadFactor;
  (void)overall;
  res.converged = std::isfinite(loadFactor) && loadFactor >= 1.0 - kLoadCompletionTol;
  return res;
}

// Run a single nonlinear Newton-Raphson phase with adaptive load
// stepping from λ = 0 → 1. 1:1 mirror of JS solveNonlinearPhase
// (src/lib/cpt-app/deformation/solver.js:3700) for the algorithmic
// core: outer load-step loop with adaptive continuation, inner Newton
// with active-set certified convergence, Armijo line search on the
// residual merit function, GMRES dispatch when the tangent may be
// unsymmetric.
//
// Per docs/features/hardening-soil-fix.md §Phase 8 the production
// globalization hierarchy for HS (and mc-plastic) is, in order:
//
//   1. Full Newton with the assembled algorithmic tangent. For HS plastic
//      cone/cap/corner states this is currently the Phase 6A finite-
//      difference tangent of the implemented return map; the continuum-form
//      analytic tangent remains diagnostic until the full consistent
//      Simo-Hughes operator lands. Plastic HS tangents may be unsymmetric —
//      see mayNeedUnsymmetricSolver below.
//   2. Armijo line search on the residual merit m(u) = 0.5 |r|^2 —
//      block `requiresPlasticLineSearch` below.
//   3. Load-step cutback — outer `for (step ...)` loop; on Newton
//      failure dLambda is shrunk via the adaptive continuation
//      controller (`compute_step_factor`) and the step is retried
//      from the prior committed state.
//   4. Finite-difference tangent fallback — internal to the constitutive
//      update inside material_hs.hpp; if an FD column cannot be certified,
//      the local tangent falls back to D_e and the global line search/cutback
//      still guards admissibility.
//   5. Elastic-tangent modified Newton — guarded by
//      `canUseRobustElasticFallback`; reserved for service/safety phases
//      of mc-plastic and HS as a diagnostic rescue only. Per fix-plan
//      §Phase 8 this path must NOT be the default for HS plasticity.
//   6. Clean failure — `hsHardFailure` below rejects acceptance when
//      the HS local return reports failureCode 101-106; the outer step
//      cuts back without ever committing an inadmissible Gauss point.
//
// Forbidden behaviors (fix-plan §Phase 8) and where they are blocked:
//   * Accept inadmissible Gauss point — blocked by Phase 4 admissibility
//     certificate (material_hs.hpp returns failureCode == 106 on any
//     local return whose corrected state violates f_cone / f_cap /
//     f_tension > tol). The `hsHardFailure` gate below refuses to
//     accept that Newton iteration.
//   * Symmetrize HS plastic tangent — `material_parameters_from_region`
//     above carries `symmetrizeEpTangent` for mc-plastic ONLY; the HS
//     dispatch in `evaluate_gp_response_ex` returns
//     `hsRes.tangent` directly with no symmetrize call (the only
//     `symmetrize_matrix6` call sites are in MC paths). The
//     `(void)symmetrize` cast in the HS branch documents this.
//   * Use CG on a known-unsymmetric plastic tangent — gated by the
//     per-step unsymmetric-solver predicate and `hasPlastic`; debug
//     assertions below fire under assertions if HS or non-associated
//     MC-SH plasticity is ever routed to CG.
//   * Change ε_zz to make plane-strain work — fixed in Phase 3.
//     `update_plane_strain` in material_hs.hpp passes the FE-prescribed
//     strain unchanged and returns failureCode == 105 if the
//     plane-strain residual exceeds 1e-10 (the entire point of B.7 is
//     now a check, not a mutation).
inline PhaseResult run_nonlinear_phase(
    PhaseContext& ctx,
    const SolverOptions& opts) {
  if (ctx.phaseKind == PhaseKind::SafetyCphi &&
      opts.requestedContinuationMode == RequestedContinuationMode::ArcLength) {
    return run_safety_arc_length_phase(ctx, opts);
  }
  auto& elements = *ctx.elements;
  auto& committedMp = *ctx.committed;
  auto& trialMp = *ctx.trial;
  auto& regions = *ctx.regions;
  auto& regionC = *ctx.regionC;
  auto& freeDofs = *ctx.freeDofs;
  auto& freeIndexByDof = *ctx.freeIndexByDof;
  auto& K = *ctx.K;
  auto& U = *ctx.U_global;
  const double* U_base = ctx.U_base ? ctx.U_base->data() : nullptr;
  const double* beamReferenceU = ctx.beamReferenceU ? ctx.beamReferenceU->data() : nullptr;
  const BeamAssemblyMode beamMode = ctx.beamMode;
  const double* baseRhs = ctx.baseRhsFree ? ctx.baseRhsFree->data() : nullptr;
  const double* rampedRhs = ctx.rampedRhsFree ? ctx.rampedRhsFree->data() : nullptr;

  const std::int32_t nfree = K.nrows;
  const std::vector<std::array<std::int32_t, 3>> wallPreconditionerTriplets =
      build_wall_preconditioner_triplets(ctx.beamElements, freeIndexByDof, beamMode);
  const auto* wallPreconditioner =
      wallPreconditionerTriplets.empty() ? nullptr : &wallPreconditionerTriplets;
  const std::vector<std::vector<std::int32_t>> wallPreconditionerBlocks =
      build_wall_preconditioner_blocks(ctx.beamElements, freeIndexByDof, beamMode);
  const auto* wallLinePreconditioner =
      wallPreconditionerBlocks.empty() ? nullptr : &wallPreconditionerBlocks;
  // Workstream A: wall rigid-body coarse space for the two-level correction.
  const sparse::WallCoarseSpace wallCoarseSpace =
      build_wall_coarse_space(elements, ctx.beamElements, freeIndexByDof, beamMode, nfree);
  const auto* wallCoarse = wallCoarseSpace.empty() ? nullptr : &wallCoarseSpace;
  std::vector<double> internalForceFree(static_cast<std::size_t>(nfree), 0.0);
  std::vector<double> residualFree(static_cast<std::size_t>(nfree), 0.0);
  std::vector<double> deltaUFree(static_cast<std::size_t>(nfree), 0.0);
  std::vector<double> diag_inv;

  trialMp = committedMp;

  // JS solveNonlinearPhase tuning constants (NONLINEAR_*).
  constexpr double kContinuationTargetIterations = 6.0;
  constexpr double kContinuationTargetLineSearchScale = 0.9;
  constexpr double kContinuationIterationExponent = 0.5;
  constexpr double kContinuationLineSearchExponent = 0.25;
  // The Excavation phase (staged construction) is a gravity-like body-load
  // relaxation, so it inherits the initial-gravity load-step robustness
  // (growth/cutback, line-search floor, quasi-convergence) rather than the
  // service-load schedule.
  const bool isInitialGravityPhase =
      ctx.phaseKind == PhaseKind::InitialGravity ||
      ctx.phaseKind == PhaseKind::Excavation;
  const double plasticGrowthFactor = isInitialGravityPhase
      ? std::max(opts.initialGravityPlasticLoadStepGrowthFactor, 1.0)
      : std::max(opts.plasticLoadStepGrowthFactor, 1.0);
  const double plasticCutbackFactor = isInitialGravityPhase
      ? std::clamp(opts.initialGravityPlasticLoadStepCutbackFactor, 0.1, 0.9)
      : std::clamp(opts.plasticLoadStepCutbackFactor, 0.1, 0.9);
  const double kLineSearchReductionFactor =
      std::clamp(opts.plasticLineSearchReductionFactor, 0.1, 0.95);
  const double kLineSearchMinStepScale = isInitialGravityPhase
      ? std::clamp(opts.initialGravityPlasticLineSearchMinScale, 1e-4, 1.0)
      : std::clamp(opts.plasticLineSearchMinScale, 1e-4, 1.0);
  const int kLineSearchMaxBacktracks = std::max(
      isInitialGravityPhase ? opts.initialGravityPlasticLineSearchMaxBacktracks
                            : opts.plasticLineSearchMaxBacktracks,
      1);
  const double kLineSearchArmijoC1 = std::max(opts.plasticLineSearchArmijoCoefficient, 0.0);

  // Plugin capability: mc-plastic does NOT require stable active-set
  // at convergence (the exact return map enforces admissibility per
  // GP). McReducedStiffness does require stable active-set. HS uses the
  // exact per-GP return mapping too — admissibility is certified per
  // GP, no global active-set lock is needed.
  const bool requiresStableActiveSet =
      ctx.kind == ConstitutiveKind::McReducedStiffness;
  // Displacement-norm tolerance dropped for exact return mapping
  // (mc-plastic, HS) per JS line 3743 — the per-GP admissibility
  // certificate already constrains the displacement field once
  // residual ≈ 0.
  const bool requiresDisplacementTolerance =
      ctx.kind != ConstitutiveKind::McPlastic &&
      ctx.kind != ConstitutiveKind::HardeningSoil;
  // Unsymmetric-solver dispatch is evaluated against the active per-step
  // material table below. Safety strength reduction rebuilds reduced MC
  // materials every step, and the consistent-tangent selector is deliberately
  // carried through that reduction.
  // Globalization fallback remains MC-only. HS tangents are unsymmetric and
  // are solved with GMRES; do not hide a local-return/tangent defect behind an
  // elastic modified-Newton rescue.
  const bool hsElasticGlobalizationFallback = false;
  const bool canUseRobustElasticFallback =
      ((opts.robustNonlinearMode != 0 &&
        ctx.kind == ConstitutiveKind::McPlastic &&
        (ctx.phaseKind == PhaseKind::ServiceLoad || ctx.phaseKind == PhaseKind::SafetyCphi)) ||
       hsElasticGlobalizationFallback);

  const double phaseMinLoadStep = opts.minLoadStep;
  const std::int32_t phaseMaxLoadSteps = opts.maxLoadSteps;
  double loadFactor = 0.0;
  double dLambda = std::min(std::max(opts.initialLoadStep, phaseMinLoadStep), 1.0);
  if (ctx.kind == ConstitutiveKind::LinearElastic) dLambda = 1.0;
  constexpr double kLoadCompletionTol = 1e-6;
  ContinuationControllerState continuationState;
  continuationState.requestedMode = opts.requestedContinuationMode;
  continuationState.actualMode = default_actual_continuation_mode(ctx.phaseKind);
  initialise_arc_length_state(
      continuationState.arcLength,
      opts,
      nfree,
      loadFactor,
      ctx.phaseKind == PhaseKind::SafetyCphi ? ctx.safetySigmaMsfStart : 1.0);

  PhaseResult res;
  bool overall = true;
  // Workstream C1: record the best near-failure display state for the
  // ServiceLoad phase as well as SafetyCphi. On a non-converged service solve
  // the live `U_global` is rolled back to the last committed equilibrium (the
  // geostatic beam-reference state when the very first service step stalls),
  // which makes every wall station read ux=uy=θ=0 and the wall diagrams
  // flat-zero. Remembering the highest-fraction assembled iterate lets the
  // driver hand it off so the partial wall response is shown honestly. The
  // InitialGravity phase is deliberately excluded (C2): gravity is the
  // baseline, not a user-dialed load fraction, so its failure stays on the
  // committed state. The Excavation phase IS included: it is a staged step with
  // the wall active, so a partial wall diagram at its achieved excavation
  // fraction is the honest thing to show if an under-embedded wall stalls at a
  // genuine kick-out limit.
  const bool keepDisplayState = ctx.phaseKind == PhaseKind::SafetyCphi ||
                                ctx.phaseKind == PhaseKind::ServiceLoad ||
                                ctx.phaseKind == PhaseKind::Excavation;

  auto remember_display_state = [&](double candidateLoadFactor, const AssembleOutput& assembly) {
    if (!keepDisplayState) return;
    const bool prefer =
        !res.hasDisplayState ||
        candidateLoadFactor > res.displayLoadFactor + 1e-10 ||
        (std::abs(candidateLoadFactor - res.displayLoadFactor) <= 1e-10 &&
         assembly.residualNorm < res.displayResidualNorm - 1e-12);
    if (!prefer) return;
    res.hasDisplayState = true;
    res.displayLoadFactor = candidateLoadFactor;
    res.displayResidualNorm = assembly.residualNorm;
    res.displayActiveCount = assembly.plasticActiveCount;
    res.displayActiveFaceCount = assembly.activeFaceCount;
    res.displayActiveEdgeCount = assembly.activeEdgeCount;
    res.displayActiveApexCount = assembly.activeApexCount;
    res.displayTensionCount = assembly.tensionCount;
    res.displayU = U;
    res.displayMp = trialMp;
  };

  auto evaluate_residual_merit = [](double residualNorm) {
    const double r = std::max(residualNorm, 0.0);
    return 0.5 * r * r;
  };
  auto approximate_newton_merit_dd = [](double residualNorm, double linearizedResidualNorm) {
    const double r = std::max(residualNorm, 0.0);
    const double rl = std::max(linearizedResidualNorm, 0.0);
    const double dd = std::max(r - rl, 0.0);
    return -r * dd;
  };

  // ==========================================================================
  // Workstream B — Tier-2 LM-damped consistent-tangent rescue.
  //
  // Engaged ONLY when Tier-1 (modified Newton + Armijo + adaptive cutback) has
  // exhausted its cutbacks and the phase is about to abort. It re-solves the
  // remaining load with the EXACT consistent tangent (Simo-Taylor 1985), under
  // Levenberg-Marquardt / trust-region damping that guarantees a descent step
  // at a near-singular plastic tangent and reduces to pure Newton near the
  // solution (Nocedal & Wright Ch.10-11). The residual equations and the
  // per-GP exact return map are UNCHANGED — only the Jacobian is replaced and
  // an SPD μ·S shift is added; convergence is declared on the UNDAMPED residual
  // r(u), so the accepted state is the true equilibrium.
  // ==========================================================================
  // Scope strictly to the MC plastic InitialGravity / ServiceLoad phases. The
  // SafetyCphi phase is deliberately EXCLUDED so the rescue can never perturb
  // the c-φ strength-reduction bracketing / arc-length path (dossier (B) scope),
  // even when the mode is enabled.
  const bool tier2Enabled =
      opts.mcGlobalizationMode == McGlobalizationMode::LmConsistentRescue &&
      ctx.kind == ConstitutiveKind::McPlastic &&
      (ctx.phaseKind == PhaseKind::InitialGravity ||
       ctx.phaseKind == PhaseKind::ServiceLoad ||
       ctx.phaseKind == PhaseKind::Excavation);

  // CSR diagonal position cache (sparsity is constant across the phase).
  std::vector<std::int32_t> tier2DiagPos;
  auto tier2_build_diag_positions = [&]() {
    if (tier2DiagPos.size() == static_cast<std::size_t>(nfree)) return;
    tier2DiagPos.assign(static_cast<std::size_t>(nfree), -1);
    for (std::int32_t i = 0; i < nfree; ++i) {
      tier2DiagPos[static_cast<std::size_t>(i)] = sparse::find_col(K, i, i);
    }
  };

  struct Tier2StepResult {
    bool converged{ false };
    double muUsed{ 0.0 };
    bool muZero{ true };
    std::int32_t newtonIters{ 0 };
    double lastResidual{ 0.0 };
  };

  // One LM-damped consistent-tangent Newton solve for a single load target.
  // `sElastic` is the (state-independent) elastic-tangent diagonal used to
  // floor the SPD scaling matrix S. `muCarry` carries the damping between
  // load steps. U / trialMp are advanced in place on success.
  auto tier2_solve_step = [&](
      double targetLambda,
      const std::vector<RegionParams>& stepRegions,
      const std::vector<Mat6>& stepRegionC,
      bool unsymmetric,
      const std::vector<double>& sElastic,
      double r0normRef,
      double& muCarry) -> Tier2StepResult {
    Tier2StepResult sr;
    tier2_build_diag_positions();
    trialMp = committedMp;
    double mu = muCarry;
    double lastAcceptedMu = 0.0;
    std::vector<double> du(static_cast<std::size_t>(nfree), 0.0);
    std::vector<double> Kdu(static_cast<std::size_t>(nfree), 0.0);
    std::vector<double> rVec(static_cast<std::size_t>(nfree), 0.0);
    std::vector<double> sDiag(static_cast<std::size_t>(nfree), 0.0);
    const int maxIters = std::max(opts.lmMaxNewtonItersPerStep, 1);
    const int maxTrials = std::max(opts.lmMaxTrials, 1);
    for (int it = 1; it <= maxIters; ++it) {
      // K_alg + residual at U (exact consistent tangent; residual unchanged).
      AssembleOutput a = assemble_global(
          elements, ctx.beamElements, committedMp, trialMp, stepRegions, stepRegionC,
          freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
          targetLambda, ctx.kind, ctx.symmetrize, ctx.incrementalStress,
          /*wantTangent=*/true, K, internalForceFree, residualFree,
          /*useElasticGlobalizationTangent=*/false, beamMode, beamReferenceU,
          /*useConsistentGlobalizationTangent=*/true);
      ++sr.newtonIters;
      ++res.newtonIterations;
      res.maxEta = std::max(res.maxEta, a.maxEta);
      const double rnorm = a.residualNorm;
      sr.lastResidual = rnorm;
      const double residualTarget = nonlinear_residual_target(opts, a.rhsNorm, nfree);
      if (rnorm <= residualTarget) {
        sr.converged = true;
        sr.muUsed = lastAcceptedMu;
        sr.muZero = (lastAcceptedMu == 0.0);
        res.activeCount = a.plasticActiveCount;
        res.activeFaceCount = a.activeFaceCount;
        res.activeEdgeCount = a.activeEdgeCount;
        res.activeApexCount = a.activeApexCount;
        res.tensionCount = a.tensionCount;
        res.residualNorm = rnorm;
        break;
      }
      rVec.assign(residualFree.begin(), residualFree.end());
      // SPD scaling: S_i = max(diag(K_alg)_i, β·S_elastic_i) > 0 — bounded away
      // from 0 even where the perfectly-plastic diagonal collapses.
      for (std::int32_t i = 0; i < nfree; ++i) {
        const std::int32_t dp = tier2DiagPos[static_cast<std::size_t>(i)];
        const double dAlg = dp >= 0 ? K.values[static_cast<std::size_t>(dp)] : 0.0;
        double s = std::max(dAlg, opts.lmSFloorBeta * sElastic[static_cast<std::size_t>(i)]);
        if (!(s > 0.0)) s = opts.lmSFloorBeta * std::max(sElastic[static_cast<std::size_t>(i)], 1e-30);
        sDiag[static_cast<std::size_t>(i)] = s;
      }
      // Inside the Newton zone (residual near the target) the consistent-tangent
      // direction is descent for ½‖r‖², so we drop the μ floor to 0 and let the
      // LM shrink schedule collapse μ toward 0. We do NOT force μ=0 here: at a
      // near-limit / perfectly-plastic state the undamped step is too aggressive
      // and a little damping is what keeps the final step convergent. The
      // converged state's damping-independence is proven separately by the
      // undamped confirmation in tier2_run_continuation (Gate #2). Outside the
      // zone μ never drops below the residual-proportional floor c_reg·‖r‖/‖r₀‖.
      const bool newtonZone = rnorm <= opts.lmNewtonZoneResidualFactor * residualTarget;
      const double muFloor = newtonZone
          ? 0.0
          : opts.lmCReg * rnorm / std::max(r0normRef, 1e-30);
      double muTry = std::max(mu, muFloor);
      const double linAbsTol = std::max(1e-14, std::min(opts.cgAbsTol, 0.25 * residualTarget));
      const double linRelTol = std::max(
          0.0, std::min(opts.cgRelTol, linAbsTol / std::max(rnorm, 1e-30)));
      bool accepted = false;
      for (int trial = 0; trial < maxTrials; ++trial) {
        // Damped operator in place: (K_alg + μ·S).
        if (muTry > 0.0) {
          for (std::int32_t i = 0; i < nfree; ++i) {
            const std::int32_t dp = tier2DiagPos[static_cast<std::size_t>(i)];
            if (dp >= 0) K.values[static_cast<std::size_t>(dp)] += muTry * sDiag[static_cast<std::size_t>(i)];
          }
        }
        std::fill(du.begin(), du.end(), 0.0);
        cg::LinearSolveResult lr = solve_phase_linear_system(
            K, freeDofs, residualFree, du, diag_inv, opts, unsymmetric,
            /*reuseDiagInv=*/false, /*gmresCache=*/nullptr,
            linRelTol, linAbsTol, wallPreconditioner, wallLinePreconditioner, wallCoarse,
            /*gmresRestart=*/std::max(opts.lmGmresRestart, 1));
        // Restore K → K_alg.
        if (muTry > 0.0) {
          for (std::int32_t i = 0; i < nfree; ++i) {
            const std::int32_t dp = tier2DiagPos[static_cast<std::size_t>(i)];
            if (dp >= 0) K.values[static_cast<std::size_t>(dp)] -= muTry * sDiag[static_cast<std::size_t>(i)];
          }
        }
        res.cgIterations += lr.iterations;
        if (unsymmetric) { res.gmresIterationCount += lr.iterations; ++res.gmresInvocations; }
        res.lastLinearSolverKind = unsymmetric ? std::uint8_t{1} : std::uint8_t{0};
        // Linear-model term for the trust-region ratio: K_alg·du.
        sparse::mat_vec(K, du.data(), Kdu.data());
        // Armijo line search on du (merit = ½‖r‖²) — kept on top of the LM step.
        const std::vector<double> uBackup = U;
        const double currentMerit = evaluate_residual_merit(rnorm);
        const double dd = approximate_newton_merit_dd(rnorm, std::max(lr.residualNorm, 0.0));
        double stepScale = 1.0;
        double bestScale = 0.0;
        double bestResidual = std::numeric_limits<double>::infinity();
        std::vector<double> bestU = U;
        std::vector<MaterialPoint> bestTrialMp = trialMp;
        bool armijoAccepted = false;
        for (int bt = 0; bt < kLineSearchMaxBacktracks; ++bt) {
          U = uBackup;
          trialMp = committedMp;
          for (std::int32_t i = 0; i < nfree; ++i) U[freeDofs[i]] += stepScale * du[i];
          AssembleOutput probe = assemble_global(
              elements, ctx.beamElements, committedMp, trialMp, stepRegions, stepRegionC,
              freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
              targetLambda, ctx.kind, ctx.symmetrize, ctx.incrementalStress,
              /*wantTangent=*/false, K, internalForceFree, residualFree,
              /*useElasticGlobalizationTangent=*/false, beamMode, beamReferenceU,
              /*useConsistentGlobalizationTangent=*/false);
          const double candResidual = probe.residualNorm;
          const double candMerit = evaluate_residual_merit(candResidual);
          const double armijoTarget = currentMerit + kLineSearchArmijoC1 * stepScale * std::min(dd, 0.0);
          if (candResidual < bestResidual) {
            bestResidual = candResidual;
            bestScale = stepScale;
            bestU = U;
            bestTrialMp = trialMp;
          }
          if (candMerit <= std::max(armijoTarget, 0.0)) { armijoAccepted = true; break; }
          if (stepScale <= kLineSearchMinStepScale + 1e-12) break;
          stepScale = std::max(stepScale * kLineSearchReductionFactor, kLineSearchMinStepScale);
        }
        // Trust-region ratio ρ = actual / predicted reduction (scaled step).
        const double actualReduction = 0.5 * (rnorm * rnorm - bestResidual * bestResidual);
        double modelNorm2 = 0.0;
        for (std::int32_t i = 0; i < nfree; ++i) {
          const double m = rVec[static_cast<std::size_t>(i)] - bestScale * Kdu[static_cast<std::size_t>(i)];
          modelNorm2 += m * m;
        }
        const double predictedReduction = 0.5 * (rnorm * rnorm - modelNorm2);
        const double rho = (predictedReduction > 1e-300)
            ? actualReduction / predictedReduction
            : (actualReduction > 0.0 ? 1.0 : -1.0);
        // Accept ANY monotone residual reduction (globally convergent descent on
        // ½‖r‖²); the trust-region ratio ρ only TUNES μ, it never vetoes a
        // residual-reducing step (vetoing one and growing μ caused the damped-
        // Newton direction to collapse to a non-descent ~0 step and stall).
        const bool madeProgress = bestScale > 0.0 && bestResidual < rnorm;
        if (madeProgress) {
          U = bestU;
          trialMp = bestTrialMp;
          accepted = true;
          lastAcceptedMu = muTry;
          res.tier2MaxMu = std::max(res.tier2MaxMu, muTry);
          // μ schedule for the next Newton iterate: shrink on a very good step
          // (ρ high, Armijo satisfied), hold on a fair step, grow on a weak step
          // (progress but the linear model over-predicted). Never below the
          // residual-proportional floor (→ 0 in the Newton zone), then snap to 0.
          double muNext;
          if (armijoAccepted && rho > opts.lmShrinkRatio) muNext = muTry * opts.lmShrink;
          else if (armijoAccepted || rho >= opts.lmAcceptRatio) muNext = muTry;
          else muNext = std::max(muTry, opts.lmMu0) * opts.lmGrowth;
          const double postFloor =
              (bestResidual <= opts.lmNewtonZoneResidualFactor * residualTarget)
                  ? 0.0
                  : opts.lmCReg * bestResidual / std::max(r0normRef, 1e-30);
          muNext = std::max(muNext, postFloor);
          muNext = std::min(muNext, opts.lmMuMax);
          if (muNext < opts.lmMuSnapToZero) muNext = 0.0;
          mu = muNext;
          break;
        }
        // No reduction at this μ: grow μ (smaller, safer step) and retry.
        muTry *= opts.lmGrowth;
        if (muTry < opts.lmMu0) muTry = opts.lmMu0;
        if (muTry > opts.lmMuMax) break;
      }
      if (!accepted) {
        // Preconditioned steepest-descent fallback. d = S⁻¹·(K_algᵀ r) is a
        // guaranteed descent direction for m = ½‖r‖² (∇m·d = −gᵀS⁻¹g < 0). It is
        // engaged only when the damped-Newton direction reduced the residual at
        // NO μ — i.e. the genuinely indefinite-tangent case the residual-system
        // LM step cannot cover. Scaled at the Cauchy point and line-searched.
        std::vector<double> grad(static_cast<std::size_t>(nfree), 0.0);
        std::vector<double> dsd(static_cast<std::size_t>(nfree), 0.0);
        std::fill(grad.begin(), grad.end(), 0.0);
        for (std::int32_t i = 0; i < nfree; ++i) {
          const std::int32_t lo = K.rowPtr[static_cast<std::size_t>(i)];
          const std::int32_t hi = K.rowPtr[static_cast<std::size_t>(i + 1)];
          const double ri = rVec[static_cast<std::size_t>(i)];
          for (std::int32_t k = lo; k < hi; ++k) {
            grad[static_cast<std::size_t>(K.colIdx[static_cast<std::size_t>(k)])] +=
                K.values[static_cast<std::size_t>(k)] * ri;  // grad = K_algᵀ r
          }
        }
        double gTd = 0.0;
        for (std::int32_t i = 0; i < nfree; ++i) {
          dsd[static_cast<std::size_t>(i)] =
              grad[static_cast<std::size_t>(i)] / std::max(sDiag[static_cast<std::size_t>(i)], 1e-30);
          gTd += grad[static_cast<std::size_t>(i)] * dsd[static_cast<std::size_t>(i)];
        }
        if (gTd > 0.0) {
          // Cauchy step s* = gᵀd / ‖K_alg d‖² minimises the quadratic model.
          sparse::mat_vec(K, dsd.data(), Kdu.data());
          double Kd2 = 0.0;
          for (std::int32_t i = 0; i < nfree; ++i) Kd2 += Kdu[static_cast<std::size_t>(i)] * Kdu[static_cast<std::size_t>(i)];
          double stepScale = Kd2 > 1e-300 ? gTd / Kd2 : 1.0;
          const std::vector<double> uBackup2 = U;
          const double currentMerit = evaluate_residual_merit(rnorm);
          double bestResidual = std::numeric_limits<double>::infinity();
          double bestScale = 0.0;
          std::vector<double> bestU = U;
          std::vector<MaterialPoint> bestTrialMp = trialMp;
          for (int bt = 0; bt < kLineSearchMaxBacktracks + 8; ++bt) {
            U = uBackup2;
            trialMp = committedMp;
            for (std::int32_t i = 0; i < nfree; ++i) U[freeDofs[i]] += stepScale * dsd[static_cast<std::size_t>(i)];
            AssembleOutput probe = assemble_global(
                elements, ctx.beamElements, committedMp, trialMp, stepRegions, stepRegionC,
                freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
                targetLambda, ctx.kind, ctx.symmetrize, ctx.incrementalStress,
                /*wantTangent=*/false, K, internalForceFree, residualFree,
                /*useElasticGlobalizationTangent=*/false, beamMode, beamReferenceU,
                /*useConsistentGlobalizationTangent=*/false);
            const double candResidual = probe.residualNorm;
            if (candResidual < bestResidual) {
              bestResidual = candResidual; bestScale = stepScale;
              bestU = U; bestTrialMp = trialMp;
            }
            const double candMerit = evaluate_residual_merit(candResidual);
            const double armijoTarget = currentMerit - kLineSearchArmijoC1 * stepScale * gTd;
            if (candMerit <= std::max(armijoTarget, 0.0)) break;
            stepScale *= kLineSearchReductionFactor;
            if (stepScale < 1e-18) break;
          }
          if (bestScale > 0.0 && bestResidual < rnorm) {
            U = bestU; trialMp = bestTrialMp;
            accepted = true;
            lastAcceptedMu = mu;
            res.tier2MaxMu = std::max(res.tier2MaxMu, mu);
            // Reset μ to a moderate value after a steepest-descent rescue.
            mu = std::clamp(mu, opts.lmMu0, opts.lmMu0 * 10.0);
          } else {
            U = uBackup2; trialMp = committedMp;
          }
        }
      }
      if (!accepted) { sr.converged = false; return sr; }
    }
    if (sr.converged) muCarry = mu;
    return sr;
  };

  // LM-damped continuation: drive the load factor from `startLoadFactor` to 1.
  auto tier2_run_continuation = [&](double startLoadFactor) -> bool {
    res.tier2Activations += 1;
    res.tier2Engaged = true;
    // Elastic-tangent diagonal floor for S — state/λ independent, so assembled
    // once. `useElasticGlobalizationTangent=true` forces the elastic Jacobian
    // while still running the (cheap, discarded) exact return map.
    tier2_build_diag_positions();
    std::vector<double> sElastic(static_cast<std::size_t>(nfree), 1.0);
    {
      std::vector<MaterialPoint> scratchTrial = committedMp;
      AssembleOutput ea = assemble_global(
          elements, ctx.beamElements, committedMp, scratchTrial, regions, regionC,
          freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
          /*loadFactor=*/startLoadFactor, ctx.kind, ctx.symmetrize, ctx.incrementalStress,
          /*wantTangent=*/true, K, internalForceFree, residualFree,
          /*useElasticGlobalizationTangent=*/true, beamMode, beamReferenceU,
          /*useConsistentGlobalizationTangent=*/false);
      (void)ea;
      for (std::int32_t i = 0; i < nfree; ++i) {
        const std::int32_t dp = tier2DiagPos[static_cast<std::size_t>(i)];
        const double d = dp >= 0 ? K.values[static_cast<std::size_t>(dp)] : 0.0;
        sElastic[static_cast<std::size_t>(i)] = std::max(std::abs(d), 1e-30);
      }
    }
    double t2LoadFactor = startLoadFactor;
    // Start the continuation with a SMALL load increment (the stall is at a
    // near-limit, ill-conditioned state) and let it grow adaptively on success.
    double t2dLambda = std::min(std::max(opts.lmInitialLoadStep, phaseMinLoadStep),
                                std::max(1.0 - t2LoadFactor, phaseMinLoadStep));
    double muCarry = opts.lmMu0;
    double r0normRef = 1.0;
    bool haveR0 = false;
    const std::int32_t budget = std::max(opts.lmMaxLoadSteps, 1);
    for (std::int32_t s = 0; s < budget; ++s) {
      if (t2LoadFactor >= 1.0 - kLoadCompletionTol) break;
      const double actualStep = std::min(t2dLambda, 1.0 - t2LoadFactor);
      const double targetLambda = t2LoadFactor + actualStep;
      PhaseStepMaterials sm;
      prepare_phase_step_materials(ctx, regions, regionC, targetLambda, sm);
      const bool stepUnsym = tier2_consistent_tangent_unsymmetric(ctx.symmetrize, sm.regions);
      const std::vector<double> uBefore = U;
      if (!haveR0) {
        AssembleOutput a0 = assemble_global(
            elements, ctx.beamElements, committedMp, trialMp, *sm.regions, *sm.regionC,
            freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
            targetLambda, ctx.kind, ctx.symmetrize, ctx.incrementalStress,
            /*wantTangent=*/false, K, internalForceFree, residualFree,
            /*useElasticGlobalizationTangent=*/false, beamMode, beamReferenceU,
            /*useConsistentGlobalizationTangent=*/false);
        r0normRef = std::max(a0.residualNorm, 1e-30);
        haveR0 = true;
      }
      Tier2StepResult sr = tier2_solve_step(
          targetLambda, *sm.regions, *sm.regionC, stepUnsym, sElastic, r0normRef, muCarry);
      res.tier2LastResidual = sr.lastResidual;
      if (sr.converged) {
        t2LoadFactor = targetLambda;
        committedMp = trialMp;
        ++res.accepted;
        ++res.tier2Steps;
        res.acceptedStepIterations.push_back(sr.newtonIters);
        res.tier2FinalMu = sr.muUsed;
        res.tier2FinalMuZero = sr.muZero;
        res.loadFactor = t2LoadFactor;
        res.tier2LoadFactor = t2LoadFactor;
        t2dLambda = std::min(t2dLambda * std::max(opts.loadStepGrowthFactor, 1.0),
                             std::max(1.0 - t2LoadFactor, phaseMinLoadStep));
        if (t2dLambda < phaseMinLoadStep) t2dLambda = phaseMinLoadStep;
      } else {
        U = uBefore;
        trialMp = committedMp;
        ++res.rejected;
        muCarry = std::min(std::max(muCarry, opts.lmMu0), opts.lmMuMax);
        t2dLambda *= std::clamp(opts.plasticLoadStepCutbackFactor, 0.1, 0.9);
        if (t2dLambda < phaseMinLoadStep) break;
      }
    }
    const bool converged = t2LoadFactor >= 1.0 - kLoadCompletionTol;
    res.tier2LoadFactor = t2LoadFactor;
    if (converged) {
      loadFactor = t2LoadFactor;
      // Undamped confirmation (Gate #2): the damping μ only ever enters the
      // Jacobian / search direction, never the residual or the stress update,
      // and convergence is declared on the UNDAMPED residual. Re-assemble the
      // EXACT consistent tangent + residual at the converged state with NO
      // damping; if the undamped residual is still within tolerance the
      // converged solution is a fixed point of pure consistent Newton — i.e. the
      // unmodified equilibrium, with μ_final = 0.
      AssembleOutput conf = assemble_global(
          elements, ctx.beamElements, committedMp, trialMp, regions, regionC,
          freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
          /*loadFactor=*/1.0, ctx.kind, ctx.symmetrize, ctx.incrementalStress,
          /*wantTangent=*/false, K, internalForceFree, residualFree,
          /*useElasticGlobalizationTangent=*/false, beamMode, beamReferenceU,
          /*useConsistentGlobalizationTangent=*/false);
      const double confTarget = nonlinear_residual_target(opts, conf.rhsNorm, nfree);
      res.tier2LastResidual = conf.residualNorm;
      if (conf.residualNorm <= confTarget) {
        res.tier2FinalMu = 0.0;
        res.tier2FinalMuZero = true;
      }
    }
    return converged;
  };

  std::vector<double> warmStartFreeCorrection;
  std::vector<double> previousAcceptedStepFreeDelta;
  std::vector<double> secondPreviousAcceptedStepFreeDelta;
  double previousAcceptedStepSize = 0.0;
  double secondPreviousAcceptedStepSize = 0.0;
  int previousAcceptedStepNewtonIterations = 0;
  // Both mc-plastic and HS run an exact return-mapping with line search and
  // benefit from a warm-started linear solve (the active-set is stable
  // between iterations for both plugins). Warm start is OFF for linear-
  // elastic (no need) and mc-reduced-stiffness (its tangent toggle makes
  // the warm start a poor predictor).
  const bool shouldWarmStartLinearSolve =
      ctx.kind == ConstitutiveKind::McPlastic ||
      ctx.kind == ConstitutiveKind::HardeningSoil;
  for (std::int32_t step = 0; step < phaseMaxLoadSteps; ++step) {
    if (loadFactor >= 1.0 - kLoadCompletionTol) break;
    const double remaining = 1.0 - loadFactor;
    const double actualStep = std::min(dLambda, remaining);
    const double targetLambda = loadFactor + actualStep;
    PhaseStepMaterials stepMaterials;
    prepare_phase_step_materials(ctx, regions, regionC, targetLambda, stepMaterials);
    const std::vector<RegionParams>* regionsForStep = stepMaterials.regions;
    const std::vector<Mat6>* regionCForStep = stepMaterials.regionC;
    const bool stepMayNeedUnsymmetricSolver =
        phase_may_need_unsymmetric_solver_for_regions(
            ctx.kind, ctx.symmetrize, regionsForStep);
    const bool stepUsesConsistentTangent =
        (ctx.kind == ConstitutiveKind::HardeningSoil &&
         hardening_soil_consistent_tangent_enabled(regionsForStep)) ||
        (ctx.kind == ConstitutiveKind::McPlastic &&
         mohr_coulomb_consistent_tangent_enabled(regionsForStep));
    const std::vector<double> stepStartU = U;
    bool stepUsedSecantPredictor = false;
    if (stepUsesConsistentTangent &&
        previousAcceptedStepFreeDelta.size() == static_cast<std::size_t>(nfree) &&
        previousAcceptedStepSize > 0.0 &&
        previousAcceptedStepNewtonIterations > 0) {
      // Secant predictor for the global continuation unknowns. It changes only
      // the Newton initial guess for the same target λ; the residual equations,
      // return map and accepted load path are still governed by the existing
      // continuation controller below.
      const double predictorScale = std::clamp(
          actualStep / std::max(previousAcceptedStepSize, phaseMinLoadStep),
          0.0,
          1.25);
      std::vector<double> predictor(static_cast<std::size_t>(nfree), 0.0);
      for (std::int32_t i = 0; i < nfree; ++i) {
        predictor[i] = predictorScale * previousAcceptedStepFreeDelta[i];
      }
      if (secondPreviousAcceptedStepFreeDelta.size() == static_cast<std::size_t>(nfree) &&
          secondPreviousAcceptedStepSize > 0.0) {
        // Capped second-order continuation predictor:
        //   Δu_pred = h v_n + h^2 (v_n - v_{n-1}) / (h_n + h_{n-1})
        // where v_k = Δu_k / h_k. The curvature cap prevents a noisy branch
        // transition from dominating the robust first-order secant term.
        const double curvatureFactor =
            (actualStep * actualStep) /
            std::max(previousAcceptedStepSize + secondPreviousAcceptedStepSize, phaseMinLoadStep);
        std::vector<double> curvature(static_cast<std::size_t>(nfree), 0.0);
        double predictorNorm2 = 0.0;
        double curvatureNorm2 = 0.0;
        for (std::int32_t i = 0; i < nfree; ++i) {
          const double vPrev = previousAcceptedStepFreeDelta[i] /
              std::max(previousAcceptedStepSize, phaseMinLoadStep);
          const double vPrevPrev = secondPreviousAcceptedStepFreeDelta[i] /
              std::max(secondPreviousAcceptedStepSize, phaseMinLoadStep);
          curvature[i] = curvatureFactor * (vPrev - vPrevPrev);
          predictorNorm2 += predictor[i] * predictor[i];
          curvatureNorm2 += curvature[i] * curvature[i];
        }
        const double predictorNorm = std::sqrt(predictorNorm2);
        const double curvatureNorm = std::sqrt(curvatureNorm2);
        const double curvatureScale = (predictorNorm > 0.0 && curvatureNorm > 0.0)
            ? std::min(1.0, 0.5 * predictorNorm / curvatureNorm)
            : 1.0;
        for (std::int32_t i = 0; i < nfree; ++i) predictor[i] += curvatureScale * curvature[i];
      }
      for (std::int32_t i = 0; i < nfree; ++i) {
        U[freeDofs[i]] += predictor[i];
      }
      stepUsedSecantPredictor = true;
    }
    trialMp = committedMp;

    bool stepConverged = false;
    double lastAcceptedScale = 1.0;
    int newtonIterUsed = 0;
    std::int32_t stepPeakActiveCount = 0;
    std::vector<double> lastCorrection(static_cast<std::size_t>(nfree), 0.0);
    bool stepUsedUnsymmetricSolver = false;
    bool stepLineSearchEvaluated = false;
    bool stepLineSearchAccepted = false;
    double stepLineSearchAcceptedScale = 1.0;
    double stepSuggestedCutbackFactor = std::numeric_limits<double>::quiet_NaN();
    double stepInitialResidualNorm = std::numeric_limits<double>::quiet_NaN();
    std::int32_t stepLinearIterations = 0;
    std::vector<double> iterationLinearGuess(static_cast<std::size_t>(nfree), 0.0);
    bool hasIterationLinearGuess =
        shouldWarmStartLinearSolve &&
        warmStartFreeCorrection.size() == static_cast<std::size_t>(nfree);
    if (hasIterationLinearGuess) iterationLinearGuess = warmStartFreeCorrection;

    for (std::int32_t newtonIter = 1; newtonIter <= opts.nonlinearMaxIter; ++newtonIter) {
      AssembleOutput a = assemble_global(elements, ctx.beamElements, committedMp, trialMp, *regionsForStep, *regionCForStep,
                                         freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
                                         targetLambda, ctx.kind, ctx.symmetrize,
                                         ctx.incrementalStress,
                                         /*wantTangent=*/true,
                                         K, internalForceFree, residualFree,
                                         /*useElasticGlobalizationTangent=*/false,
                                         beamMode, beamReferenceU);
      const std::vector<MaterialPoint> assembledTrialMp = trialMp;
      remember_display_state(targetLambda, a);
      ++res.newtonIterations;
      newtonIterUsed = newtonIter;
      if (!std::isfinite(stepInitialResidualNorm)) {
        stepInitialResidualNorm = a.residualNorm;
      }
      res.maxEta = std::max(res.maxEta, a.maxEta);
      res.activeCount = a.plasticActiveCount;
      res.activeFaceCount = a.activeFaceCount;
      res.activeEdgeCount = a.activeEdgeCount;
      res.activeApexCount = a.activeApexCount;
      res.tensionCount = a.tensionCount;
      res.residualNorm = a.residualNorm;
      stepPeakActiveCount = std::max(stepPeakActiveCount, a.plasticActiveCount);

      const double residualTarget = nonlinear_residual_target(opts, a.rhsNorm, nfree);
      double solutionNorm = 0.0;
      for (std::int32_t i = 0; i < nfree; ++i) {
        const double v = U[freeDofs[i]];
        solutionNorm += v * v;
      }
      solutionNorm = std::sqrt(solutionNorm);
      double deltaNorm = 0.0;
      for (std::int32_t i = 0; i < nfree; ++i) deltaNorm += lastCorrection[i] * lastCorrection[i];
      deltaNorm = std::sqrt(deltaNorm);
      const double displacementTarget = std::max(opts.displacementAbsTol,
                                                 opts.displacementRelTol * std::max(solutionNorm, 0.0));
      const bool residualConverged = a.residualNorm <= residualTarget;
      const bool displacementConverged = deltaNorm <= displacementTarget;
      const bool toleranceConverged = residualConverged &&
                                      (!requiresDisplacementTolerance || displacementConverged);
      const bool plasticQuasiConverged =
          (ctx.kind == ConstitutiveKind::McPlastic ||
           ctx.kind == ConstitutiveKind::HardeningSoil) &&
          isInitialGravityPhase &&
          a.changedCount == 0 &&
          a.residualNorm <= 1.1 * residualTarget;

      // JS line 4211: converged when residual+disp ok AND (no stable-active-set
      // requirement OR changedCount == 0). For mc-plastic, requiresStableActiveSet
      // is false. For mc-reduced-stiffness it's true. Also requires iteration > 1
      // (first iteration's tangent comes from the elastic predictor; a stable
      // active set must survive at least one true Newton step).
      //
      // Phase 5 HS: if HS local-return reports a hard failure (corner +
      // triple-apex + σ_zz Newton non-convergence and all single-surface
      // fallbacks failed), the dispatcher returns the elastic predictor
      // with failureCode 103/104/105. In that case the assembled state
      // is not constitutive-admissible; refuse to converge so the outer
      // load-step cutback can engage. We discriminate "hard" failure
      // (105 == σ_zz) from "soft" — the dispatcher's least-bad
      // single-surface fallback (Phase 5 patch) maps cleanly back to
      // failureCode = 0 with the active surface set to 1 or 2, so this
      // gate fires only when ALL paths failed.
	      const bool hsHardFailure =
	          ctx.kind == ConstitutiveKind::HardeningSoil &&
	          (a.hsFailureCode == 101 || a.hsFailureCode == 102 ||
	           a.hsFailureCode == 103 || a.hsFailureCode == 104 ||
	           a.hsFailureCode == 105 || a.hsFailureCode == 106 ||
	           a.hsFailureCode == 999);
      const bool hsFirstAssemblyConverged =
          ctx.kind == ConstitutiveKind::HardeningSoil &&
          newtonIter == 1 &&
          toleranceConverged &&
          !hsHardFailure;
      if ((newtonIter > 1 || hsFirstAssemblyConverged) &&
          (toleranceConverged || plasticQuasiConverged) &&
          (!requiresStableActiveSet || a.changedCount == 0) &&
          !hsHardFailure) {
        stepConverged = true;
	        break;
	      }
      if (hsHardFailure) {
        res.lastHsFailureCode = a.hsFailureCode;
        break;
      }

      // Linear solve dispatch.
      if (shouldWarmStartLinearSolve && hasIterationLinearGuess) {
        deltaUFree = iterationLinearGuess;
      } else {
        std::fill(deltaUFree.begin(), deltaUFree.end(), 0.0);
      }
      const bool hasPlastic = (a.plasticActiveCount > 0) || (a.tensionCount > 0);
      const bool tangentAsymmetric =
          stepMayNeedUnsymmetricSolver && hasPlastic;
      if (tangentAsymmetric) stepUsedUnsymmetricSolver = true;
      // Exact plastic tangents that are known to be unsymmetric must never be
      // routed to CG. CG requires SPD; non-associated MC-SH and HS plastic
      // tangents use GMRES.
#ifndef NDEBUG
      if (ctx.kind == ConstitutiveKind::HardeningSoil && hasPlastic && !tangentAsymmetric) {
        assert(false && "HS plastic step routed to CG; expected GMRES");
      }
      if (mc_plastic_active_tangent_must_use_gmres(ctx, regionsForStep, hasPlastic) &&
          !tangentAsymmetric) {
        assert(false && "MC consistent non-associated plastic step routed to CG; expected GMRES");
      }
#endif
      const double linearSolveAbsTol = std::max(
          1e-14,
          std::min(opts.cgAbsTol, 0.25 * residualTarget));
      const double linearSolveRelTol = std::max(
          0.0,
          std::min(opts.cgRelTol,
                   linearSolveAbsTol / std::max(a.residualNorm, 1e-30)));
	      cg::LinearSolveResult lr = solve_phase_linear_system(
	          K, freeDofs, residualFree, deltaUFree, diag_inv, opts, tangentAsymmetric,
	          /*reuseDiagInv=*/false, /*gmresCache=*/nullptr,
	          linearSolveRelTol, linearSolveAbsTol, wallPreconditioner, wallLinePreconditioner,
	          wallCoarse);
	      res.cgIterations += lr.iterations;
	      stepLinearIterations += lr.iterations;
	      if (tangentAsymmetric) {
	        res.gmresIterationCount += lr.iterations;
	        res.gmresInvocations += 1;
	      }
	      res.lastLinearSolverKind = tangentAsymmetric ? std::uint8_t{1} : std::uint8_t{0};
	      double linearRhsNorm = 0.0;
	      for (double v : residualFree) linearRhsNorm += v * v;
	      linearRhsNorm = std::sqrt(linearRhsNorm);
	      const double relativeResidualForForcing = a.rhsNorm > 1e-30
	          ? a.residualNorm / a.rhsNorm
	          : a.residualNorm;
	      const double inexactNewtonForcing = ctx.kind == ConstitutiveKind::LinearElastic
	          ? 1e-8
	          : std::max(isInitialGravityPhase ? 0.1 : 0.05,
	                     std::min(isInitialGravityPhase ? 0.6 : 0.4,
	                              std::sqrt(std::max(relativeResidualForForcing, 0.0))));
	      const double acceptableLinearizedResidual = ctx.kind == ConstitutiveKind::LinearElastic
	          ? linearSolveAbsTol
	          : std::max({linearSolveAbsTol,
	                      0.25 * nonlinear_absolute_residual_target(opts, nfree),
	                      inexactNewtonForcing * linearRhsNorm});
      if (!lr.converged && lr.residualNorm > acceptableLinearizedResidual) {
        if (ctx.kind == ConstitutiveKind::HardeningSoil && a.hsFailureCode != 0) {
          res.lastHsFailureCode = a.hsFailureCode;
        }
        break;
      }
      iterationLinearGuess = deltaUFree;
      hasIterationLinearGuess = shouldWarmStartLinearSolve;
      for (std::int32_t i = 0; i < nfree; ++i) lastCorrection[i] = deltaUFree[i];

      const bool requiresPlasticLineSearch =
          ctx.kind == ConstitutiveKind::McPlastic ||
          ctx.kind == ConstitutiveKind::HardeningSoil;
      double lineSearchStepScale = 1.0;
      if (requiresPlasticLineSearch) {
        // JS performArmijoLineSearch (line 3556): merit-function-based
        // Armijo backtracking. Merit m(u) = 0.5 |r|^2. Directional
        // derivative approximation: -|r| * max(|r| - |r_linearized|, 0).
        // Accept if m(u + s δu) <= m(u) + c1 s · min(dd, 0).
        const std::vector<double> uBackup = U;
        const double currentResidualNorm = a.residualNorm;
        const double currentMerit = evaluate_residual_merit(currentResidualNorm);
        const double linearizedResidualNorm = std::max(lr.residualNorm, 0.0);
        const double dd = approximate_newton_merit_dd(currentResidualNorm, linearizedResidualNorm);

        double stepScale = 1.0;
        double bestScale = 1.0;
        double bestMerit = std::numeric_limits<double>::infinity();
        double bestResidual = std::numeric_limits<double>::infinity();
        double bestRhsNorm = a.rhsNorm;
        std::int32_t bestChangedCount = a.changedCount;
        std::vector<double> bestU = U;
        std::vector<MaterialPoint> bestTrialMp = trialMp;
        bool bestAccepted = false;
	        for (int bt = 0; bt < kLineSearchMaxBacktracks; ++bt) {
	          // Apply scaled correction.
	          U = uBackup;
	          trialMp = committedMp;
	          for (std::int32_t i = 0; i < nfree; ++i) U[freeDofs[i]] += stepScale * deltaUFree[i];
          AssembleOutput probe = assemble_global(elements, ctx.beamElements, committedMp, trialMp, *regionsForStep, *regionCForStep,
                                                 freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
                                                 targetLambda, ctx.kind, ctx.symmetrize,
	                                                 ctx.incrementalStress,
	                                                 /*wantTangent=*/false,
                                                 K, internalForceFree, residualFree,
                                                 /*useElasticGlobalizationTangent=*/false,
                                                 beamMode, beamReferenceU);
          const double candidateResidualNorm = probe.residualNorm;
          const double candidateMerit = evaluate_residual_merit(candidateResidualNorm);
          stepPeakActiveCount = std::max(stepPeakActiveCount, probe.plasticActiveCount);
          const double armijoTarget = currentMerit + kLineSearchArmijoC1 * stepScale * std::min(dd, 0.0);
          const bool hsResidualDescentAccepted =
              ctx.kind == ConstitutiveKind::HardeningSoil &&
              probe.hsFailureCode == 0 &&
              candidateResidualNorm < currentResidualNorm;
          const bool candidateAccepted =
              candidateMerit <= std::max(armijoTarget, 0.0) ||
              hsResidualDescentAccepted;
          const double improveTol = std::max(1e-16, 1e-12 * std::max(bestMerit, 1.0));
          const double tieTol = std::max(1e-16, 1e-12 * std::max({candidateMerit, bestMerit, 1.0}));
          if (candidateMerit < bestMerit - improveTol ||
              (std::abs(candidateMerit - bestMerit) <= tieTol &&
               candidateResidualNorm < bestResidual)) {
            bestMerit = candidateMerit;
            bestResidual = candidateResidualNorm;
            bestRhsNorm = probe.rhsNorm;
            bestChangedCount = probe.changedCount;
            bestScale = stepScale;
            bestU = U;
            bestTrialMp = trialMp;
            bestAccepted = candidateAccepted;
          }
          if (candidateAccepted) {
            break;
          }
          if (stepScale <= kLineSearchMinStepScale + 1e-12) break;
          stepScale = std::max(stepScale * kLineSearchReductionFactor, kLineSearchMinStepScale);
        }
        stepLineSearchEvaluated = true;
        stepSuggestedCutbackFactor = bestScale;
        if (bestAccepted) {
          stepLineSearchAccepted = true;
          stepLineSearchAcceptedScale = bestScale;
        }
	        double correctionNorm = 0.0;
	        for (std::int32_t i = 0; i < nfree; ++i) {
	          const double v = bestScale * deltaUFree[i];
	          correctionNorm += v * v;
	        }
	        correctionNorm = std::sqrt(correctionNorm);
	        double bestSolutionNorm = 0.0;
	        for (std::int32_t i = 0; i < nfree; ++i) {
	          const double v = bestU[freeDofs[i]];
	          bestSolutionNorm += v * v;
	        }
	        bestSolutionNorm = std::sqrt(bestSolutionNorm);
	        const double bestResidualTarget = nonlinear_residual_target(opts, bestRhsNorm, nfree);
	        const double bestDisplacementTarget = std::max(
	            opts.displacementAbsTol, opts.displacementRelTol * std::max(bestSolutionNorm, 0.0));
	        const bool stalledCandidateAcceptable =
	            bestResidual <= bestResidualTarget &&
	            (!requiresDisplacementTolerance || correctionNorm <= bestDisplacementTarget);
	        const bool currentQuasiConverged =
	            (ctx.kind == ConstitutiveKind::McPlastic ||
	             ctx.kind == ConstitutiveKind::HardeningSoil) &&
	            isInitialGravityPhase &&
	            a.changedCount == 0 &&
	            newtonIter >= 2 &&
	            a.residualNorm <= 1.1 * residualTarget;

	        if (!bestAccepted) {
	          if (stalledCandidateAcceptable &&
	              (!requiresStableActiveSet || bestChangedCount == 0)) {
	            U = bestU;
	            trialMp = bestTrialMp;
	            lastAcceptedScale = bestScale;
	            for (std::int32_t i = 0; i < nfree; ++i) {
	              lastCorrection[i] = bestScale * deltaUFree[i];
	            }
	            stepConverged = true;
	            break;
	          }
	          if (currentQuasiConverged) {
	            U = uBackup;
	            trialMp = assembledTrialMp;
	            stepConverged = true;
	            break;
	          }
          bool robustFallbackAccepted = false;
          bool robustFallbackConverged = false;
          if (canUseRobustElasticFallback && (a.plasticActiveCount > 0 || a.tensionCount > 0)) {
            // Robust-mode rescue only: keep the exact plastic stress update,
            // but replace the global tangent with the elastic tangent to get
            // a safer direction through a stalled active-set transition.
            U = uBackup;
            trialMp = assembledTrialMp;
            AssembleOutput fallbackA = assemble_global(
                elements, ctx.beamElements, committedMp, trialMp, *regionsForStep, *regionCForStep,
                freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
                targetLambda, ctx.kind, ctx.symmetrize,
                ctx.incrementalStress,
                /*wantTangent=*/true,
                K, internalForceFree, residualFree,
                /*useElasticGlobalizationTangent=*/true,
                beamMode, beamReferenceU);
            res.maxEta = std::max(res.maxEta, fallbackA.maxEta);
            stepPeakActiveCount = std::max(stepPeakActiveCount, fallbackA.plasticActiveCount);

            std::vector<double> fallbackDeltaUFree(static_cast<std::size_t>(nfree), 0.0);
            // Robust-mode rescue uses the elastic globalization tangent
            // (D_e, symmetric), so CG is correct here even for HS — the
            // dispatcher overrides resp.tangent with C in assemble_global
            // when useElasticGlobalizationTangent=true above.
            const double fallbackLinearResidualTarget =
                nonlinear_residual_target(opts, fallbackA.rhsNorm, nfree);
            const double fallbackLinearSolveAbsTol = std::max(
                1e-14,
                std::min(opts.cgAbsTol, 0.25 * fallbackLinearResidualTarget));
            const double fallbackLinearSolveRelTol = std::max(
                0.0,
                std::min(opts.cgRelTol,
                         fallbackLinearSolveAbsTol / std::max(fallbackA.residualNorm, 1e-30)));
            cg::LinearSolveResult fallbackLr = solve_phase_linear_system(
                K, freeDofs, residualFree, fallbackDeltaUFree, diag_inv, opts,
                /*useUnsymmetricSolver=*/false,
                /*reuseDiagInv=*/false, /*gmresCache=*/nullptr,
                fallbackLinearSolveRelTol, fallbackLinearSolveAbsTol,
                wallPreconditioner, wallLinePreconditioner, wallCoarse);
            res.cgIterations += fallbackLr.iterations;
            stepLinearIterations += fallbackLr.iterations;
            res.lastLinearSolverKind = 0;

            double fallbackLinearRhsNorm = 0.0;
            for (double v : residualFree) fallbackLinearRhsNorm += v * v;
            fallbackLinearRhsNorm = std::sqrt(fallbackLinearRhsNorm);
            const double fallbackRelativeResidualForForcing = fallbackA.rhsNorm > 1e-30
                ? fallbackA.residualNorm / fallbackA.rhsNorm
                : fallbackA.residualNorm;
            const double fallbackInexactNewtonForcing =
                std::max(0.05,
                         std::min(0.4,
                                  std::sqrt(std::max(fallbackRelativeResidualForForcing, 0.0))));
            const double fallbackAcceptableLinearizedResidual =
                std::max({fallbackLinearSolveAbsTol,
                          0.25 * nonlinear_absolute_residual_target(opts, nfree),
                          fallbackInexactNewtonForcing * fallbackLinearRhsNorm});

            if (fallbackLr.converged ||
                fallbackLr.residualNorm <= fallbackAcceptableLinearizedResidual) {
              const double fallbackCurrentResidualNorm = fallbackA.residualNorm;
              const double fallbackCurrentMerit = evaluate_residual_merit(fallbackCurrentResidualNorm);
              const double fallbackLinearizedResidualNorm = std::max(fallbackLr.residualNorm, 0.0);
              const double fallbackDd = approximate_newton_merit_dd(
                  fallbackCurrentResidualNorm, fallbackLinearizedResidualNorm);
              const double fallbackArmijoC1 = std::max(kLineSearchArmijoC1, 1e-3);
              constexpr double kFallbackMinResidualRatio = 0.90;

              double fallbackStepScale = 1.0;
              double fallbackBestScale = 1.0;
              double fallbackBestMerit = std::numeric_limits<double>::infinity();
              double fallbackBestResidual = std::numeric_limits<double>::infinity();
              double fallbackBestRhsNorm = fallbackA.rhsNorm;
              std::int32_t fallbackBestChangedCount = fallbackA.changedCount;
              std::vector<double> fallbackBestU = U;
              std::vector<MaterialPoint> fallbackBestTrialMp = trialMp;
              bool fallbackBestAccepted = false;

              for (int bt = 0; bt < kLineSearchMaxBacktracks; ++bt) {
                U = uBackup;
                trialMp = committedMp;
                for (std::int32_t i = 0; i < nfree; ++i) {
                  U[freeDofs[i]] += fallbackStepScale * fallbackDeltaUFree[i];
                }
                AssembleOutput fallbackProbe = assemble_global(
                    elements, ctx.beamElements, committedMp, trialMp, *regionsForStep, *regionCForStep,
                    freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
                    targetLambda, ctx.kind, ctx.symmetrize,
                    ctx.incrementalStress,
                    /*wantTangent=*/false,
                    K, internalForceFree, residualFree,
                    /*useElasticGlobalizationTangent=*/false,
                    beamMode, beamReferenceU);
                const double candidateResidualNorm = fallbackProbe.residualNorm;
                const double candidateMerit = evaluate_residual_merit(candidateResidualNorm);
                stepPeakActiveCount = std::max(stepPeakActiveCount, fallbackProbe.plasticActiveCount);
                const double armijoTarget =
                    fallbackCurrentMerit + fallbackArmijoC1 * fallbackStepScale * std::min(fallbackDd, 0.0);
                const bool residualImprovementAccepted =
                    candidateResidualNorm <= kFallbackMinResidualRatio * std::max(fallbackCurrentResidualNorm, 0.0) ||
                    fallbackStepScale <= kLineSearchMinStepScale + 1e-12;
                const bool candidateAccepted =
                    candidateMerit <= std::max(armijoTarget, 0.0) && residualImprovementAccepted;
                const double improveTol = std::max(1e-16, 1e-12 * std::max(fallbackBestMerit, 1.0));
                const double tieTol = std::max(
                    1e-16, 1e-12 * std::max({candidateMerit, fallbackBestMerit, 1.0}));
                if (candidateMerit < fallbackBestMerit - improveTol ||
                    (std::abs(candidateMerit - fallbackBestMerit) <= tieTol &&
                     candidateResidualNorm < fallbackBestResidual)) {
                  fallbackBestMerit = candidateMerit;
                  fallbackBestResidual = candidateResidualNorm;
                  fallbackBestRhsNorm = fallbackProbe.rhsNorm;
                  fallbackBestChangedCount = fallbackProbe.changedCount;
                  fallbackBestScale = fallbackStepScale;
                  fallbackBestU = U;
                  fallbackBestTrialMp = trialMp;
                  fallbackBestAccepted = candidateAccepted;
                }
                if (candidateAccepted) break;
                if (fallbackStepScale <= kLineSearchMinStepScale + 1e-12) break;
                fallbackStepScale = std::max(
                    fallbackStepScale * kLineSearchReductionFactor,
                    kLineSearchMinStepScale);
              }

              double fallbackCorrectionNorm = 0.0;
              for (std::int32_t i = 0; i < nfree; ++i) {
                const double v = fallbackBestScale * fallbackDeltaUFree[i];
                fallbackCorrectionNorm += v * v;
              }
              fallbackCorrectionNorm = std::sqrt(fallbackCorrectionNorm);
              double fallbackSolutionNorm = 0.0;
              for (std::int32_t i = 0; i < nfree; ++i) {
                const double v = fallbackBestU[freeDofs[i]];
                fallbackSolutionNorm += v * v;
              }
              fallbackSolutionNorm = std::sqrt(fallbackSolutionNorm);
              const double fallbackResidualTarget =
                  nonlinear_residual_target(opts, fallbackBestRhsNorm, nfree);
              const double fallbackDisplacementTarget = std::max(
                  opts.displacementAbsTol, opts.displacementRelTol * std::max(fallbackSolutionNorm, 0.0));
	              const bool fallbackStalledCandidateAcceptable =
                  fallbackBestResidual <= fallbackResidualTarget &&
                  (!requiresDisplacementTolerance || fallbackCorrectionNorm <= fallbackDisplacementTarget);
              const double fallbackVsConsistentTol =
                  std::max(1e-16, 1e-12 * std::max(bestMerit, 1.0));
              const bool fallbackImprovesConsistentBest =
                  !std::isfinite(bestMerit) ||
                  fallbackBestMerit < bestMerit - fallbackVsConsistentTol ||
                  fallbackBestResidual < bestResidual;
              const bool fallbackMateriallyReducesResidual =
                  fallbackBestResidual < fallbackCurrentResidualNorm;

              if ((fallbackBestAccepted &&
                   fallbackImprovesConsistentBest &&
                   fallbackMateriallyReducesResidual) ||
                  (fallbackStalledCandidateAcceptable &&
                   (!requiresStableActiveSet || fallbackBestChangedCount == 0))) {
                U = fallbackBestU;
                trialMp = fallbackBestTrialMp;
                lastAcceptedScale = fallbackBestScale;
                lineSearchStepScale = fallbackBestScale;
                stepLineSearchAccepted = fallbackBestAccepted;
                stepLineSearchAcceptedScale = fallbackBestAccepted ? fallbackBestScale : 0.0;
                stepSuggestedCutbackFactor = fallbackBestScale;
                for (std::int32_t i = 0; i < nfree; ++i) {
                  lastCorrection[i] = fallbackBestScale * fallbackDeltaUFree[i];
                  iterationLinearGuess[i] = fallbackDeltaUFree[i];
                }
                hasIterationLinearGuess = shouldWarmStartLinearSolve;
                robustFallbackAccepted =
                    fallbackBestAccepted &&
                    fallbackImprovesConsistentBest &&
                    fallbackMateriallyReducesResidual;
                robustFallbackConverged = !robustFallbackAccepted;
              }
            }
          }
          if (robustFallbackConverged) {
            stepConverged = true;
            break;
          }
          if (!robustFallbackAccepted) {
            U = uBackup;
            trialMp = committedMp;
            break;
	          }
	        } else {
	          U = bestU;
	          trialMp = bestTrialMp;
	          lastAcceptedScale = bestScale;
	          lineSearchStepScale = bestScale;
	          for (std::int32_t i = 0; i < nfree; ++i) {
	            lastCorrection[i] = bestScale * deltaUFree[i];
	          }
	        }
	      } else {
	        for (std::int32_t i = 0; i < nfree; ++i) U[freeDofs[i]] += deltaUFree[i];
	        lastAcceptedScale = 1.0;
      }
      if (shouldWarmStartLinearSolve && hasIterationLinearGuess) {
        if (lineSearchStepScale != 1.0) {
          for (double& v : iterationLinearGuess) v *= lineSearchStepScale;
        }
      }
    }

    if (stepConverged) {
      loadFactor = targetLambda;
      ++res.accepted;
      res.acceptedStepIterations.push_back(newtonIterUsed);
      committedMp = trialMp;
      if (stepUsesConsistentTangent) {
        secondPreviousAcceptedStepFreeDelta = previousAcceptedStepFreeDelta;
        secondPreviousAcceptedStepSize = previousAcceptedStepSize;
        previousAcceptedStepFreeDelta.assign(static_cast<std::size_t>(nfree), 0.0);
        for (std::int32_t i = 0; i < nfree; ++i) {
          previousAcceptedStepFreeDelta[i] = U[freeDofs[i]] - stepStartU[freeDofs[i]];
        }
        previousAcceptedStepSize = actualStep;
        previousAcceptedStepNewtonIterations = newtonIterUsed;
      } else {
        previousAcceptedStepFreeDelta.clear();
        secondPreviousAcceptedStepFreeDelta.clear();
        previousAcceptedStepSize = 0.0;
        secondPreviousAcceptedStepSize = 0.0;
        previousAcceptedStepNewtonIterations = 0;
      }
      if (ctx.safetyCurve) {
        std::vector<MaterialPoint> acceptedTrialMp = committedMp;
        AssembleOutput acceptedAssembly = assemble_global(
            elements, ctx.beamElements, committedMp, acceptedTrialMp, *regionsForStep, *regionCForStep,
            freeIndexByDof, U.data(), U_base, baseRhs, rampedRhs,
            targetLambda, ctx.kind, ctx.symmetrize,
            ctx.incrementalStress,
            /*wantTangent=*/false,
            K, internalForceFree, residualFree,
            /*useElasticGlobalizationTangent=*/false,
            beamMode, beamReferenceU);
        res.maxEta = std::max(res.maxEta, acceptedAssembly.maxEta);
        res.activeCount = acceptedAssembly.plasticActiveCount;
        res.activeFaceCount = acceptedAssembly.activeFaceCount;
        res.activeEdgeCount = acceptedAssembly.activeEdgeCount;
        res.activeApexCount = acceptedAssembly.activeApexCount;
        res.tensionCount = acceptedAssembly.tensionCount;
        res.residualNorm = acceptedAssembly.residualNorm;
        ctx.safetyCurve->push_back(make_safety_curve_point(
            ctx,
            acceptedAssembly,
            U,
            committedMp,
            targetLambda,
            res.accepted - 1,
            newtonIterUsed,
            stepLinearIterations,
            stepInitialResidualNorm,
            lastAcceptedScale,
            opts));
      }
      if (shouldWarmStartLinearSolve && stepUsedUnsymmetricSolver && hasIterationLinearGuess) {
        warmStartFreeCorrection = iterationLinearGuess;
      } else if (!stepUsedUnsymmetricSolver) {
        warmStartFreeCorrection.clear();
      }
      // JS adaptive continuation — grow / shrink based on iteration
      // count and accepted line-search scale.
      const int continuationIterUsed =
          stepUsesConsistentTangent && stepUsedSecantPredictor && stepPeakActiveCount > 0
              ? std::max(newtonIterUsed, 4)
              : newtonIterUsed;
      const bool isExactReturnMappingKind =
          ctx.kind == ConstitutiveKind::McPlastic ||
          ctx.kind == ConstitutiveKind::HardeningSoil;
      const bool benignPlasticStep =
          isExactReturnMappingKind &&
          stepPeakActiveCount > 0 &&
          continuationIterUsed > 0 &&
          continuationIterUsed * 2 <= kContinuationTargetIterations &&
          (!stepLineSearchEvaluated ||
           (stepLineSearchAccepted && stepLineSearchAcceptedScale >= 0.999));
      const double effectiveGrowthFactor =
          isExactReturnMappingKind && stepPeakActiveCount > 0 && !benignPlasticStep
              ? std::min(opts.loadStepGrowthFactor, plasticGrowthFactor)
              : opts.loadStepGrowthFactor;
      const double effectiveCutbackFactor =
          isExactReturnMappingKind && stepPeakActiveCount > 0 && !benignPlasticStep
              ? std::min(opts.loadStepCutbackFactor, plasticCutbackFactor)
              : opts.loadStepCutbackFactor;
      // Continuation is deliberately independent of the tangent selector.
      // Simo-Hughes improves the Newton direction, but changing the HS load-step
      // target would alter the path-dependent plastic integration history and
      // break the D.6 tangent-only equivalence contract.
      const double targetIters = (ctx.kind == ConstitutiveKind::HardeningSoil)
          ? 8.0
          : kContinuationTargetIterations;
      auto compute_step_factor = [&](int iterCount, double acceptedLineSearchScale) {
        const double effIter = std::max(static_cast<double>(iterCount), 1.0);
        const double effScale = std::max(std::min(acceptedLineSearchScale, 1.0), 1e-6);
        double raw = std::pow(targetIters / effIter, kContinuationIterationExponent) *
                     std::pow(effScale / kContinuationTargetLineSearchScale, kContinuationLineSearchExponent);
        if (!std::isfinite(raw) || raw <= 0.0) return effectiveCutbackFactor;
        return std::clamp(raw, effectiveCutbackFactor, effectiveGrowthFactor);
      };
      const double factor = compute_step_factor(continuationIterUsed, lastAcceptedScale);
      dLambda = std::min(dLambda * factor, 1.0 - loadFactor);
      if (dLambda < phaseMinLoadStep && loadFactor < 1.0 - 1e-12) {
        dLambda = phaseMinLoadStep;
      }
    } else {
      ++res.rejected;
      U = stepStartU;
      trialMp = committedMp;
      if (shouldWarmStartLinearSolve && hasIterationLinearGuess) {
        warmStartFreeCorrection = iterationLinearGuess;
      }
      const double effectiveCutbackFactor =
          (ctx.kind == ConstitutiveKind::McPlastic ||
           ctx.kind == ConstitutiveKind::HardeningSoil) &&
          stepPeakActiveCount > 0
              ? std::min(opts.loadStepCutbackFactor, plasticCutbackFactor)
              : opts.loadStepCutbackFactor;
      double suggestedCutbackFactor = effectiveCutbackFactor;
      if (std::isfinite(stepSuggestedCutbackFactor) && stepSuggestedCutbackFactor > 0.0) {
        suggestedCutbackFactor = std::max(effectiveCutbackFactor, std::min(0.9, stepSuggestedCutbackFactor));
      }
      const double proposedStep = actualStep * suggestedCutbackFactor;
      dLambda = (proposedStep < phaseMinLoadStep - 1e-12 && actualStep > phaseMinLoadStep + 1e-12)
          ? phaseMinLoadStep
          : proposedStep;
      if (dLambda < phaseMinLoadStep) {
        overall = false;
        break;
      }
    }
  }

  // Tier-2 LM-damped consistent-tangent rescue (workstream B). Engaged ONLY
  // when Tier-1 (modified Newton + Armijo + adaptive cutback / load stepping)
  // failed to reach λ = 1 — i.e. it exhausted its cutbacks (dLambda < min) OR
  // its load-step budget. A converging case never reaches here, so the default
  // path is byte-identical and the worst case is no slower than today. On
  // success the continuation carries the phase to λ = 1 and sets `loadFactor`.
  if (tier2Enabled && loadFactor < 1.0 - kLoadCompletionTol) {
    tier2_run_continuation(loadFactor);
  }

  res.loadFactor = loadFactor;
  (void)overall;
  res.converged = std::isfinite(loadFactor) && loadFactor >= 1.0 - kLoadCompletionTol;
  return res;
}

// Initialise material points from the K0 stress seed.
// `initialSigmaByGp` is `numGpTotal * 6` doubles in Voigt-6 order
// (tension positive). When useK0Init is false, the initial stress is
// zero (gravity-ramp).
//
// When the constitutive model is McPlastic and the supplied K0 seed
// violates the MC envelope at a Gauss point, we run a zero-strain
// return mapping at seed time so the committed state is admissible
// before the plastic Newton starts. This mirrors the CPU path's
// `seedMaterialPointStateFromEffectiveStress6` with
// `projectInadmissibleOntoMc: true`: without it, the plastic Newton
// would have to fix both yield admissibility and force equilibrium
// simultaneously, which stalls in weak shallow soils.
//
// `regions` and `regionC` are needed to run the return mapping per GP.
inline void initialise_material_points(
    std::vector<MaterialPoint>& mp,
    const std::vector<RegionParams>& regions,
    const std::vector<Mat6>& regionC,
    const double* initialSigmaByGp,
    const double* porePressureByGp,
    bool useK0Init,
    ConstitutiveKind kind) {
  for (std::size_t i = 0; i < mp.size(); ++i) {
    auto& m = mp[i];
    Vec6 sigma{};
    if (useK0Init && initialSigmaByGp) {
      for (int k = 0; k < 6; ++k) sigma[k] = initialSigmaByGp[i * 6 + k];
    }
    // Reference stress is the unprojected K0 seed (so consumers see the
    // raw geostatic predictor when they report "initial effective
    // stress"). The committed state stores the projected, admissible
    // stress that the Newton will iterate against.
    for (int k = 0; k < 6; ++k) m.referenceStress[k] = sigma[k];
    Vec6 committedSigma = sigma;

    if (kind == ConstitutiveKind::McPlastic) {
      const std::int32_t r = m.regionIndex >= 0 && static_cast<std::size_t>(m.regionIndex) < regions.size()
          ? m.regionIndex : 0;
      const auto& rp = regions[r];
      const mc_exact::MaterialParameters mp = material_parameters_from_region(rp, rp.symmetrize != 0u);
      const mc_exact::PrincipalAndValues exact = mc_exact::evaluate_exact_mc_surface_values_from_stress(sigma, mp);
      mc_exact::McTrial trial;
      trial.s1 = exact.principal.s1;
      trial.s2 = exact.principal.s2;
      trial.s3 = exact.principal.s3;
      trial.maxAbsStress = std::max({
          std::abs(sigma[V_XX]), std::abs(sigma[V_YY]), std::abs(sigma[V_ZZ]),
          std::abs(sigma[V_XY]), std::abs(sigma[V_YZ]), std::abs(sigma[V_XZ])});
      const double yieldTol = mc_exact::local_return_tolerance(mp, trial);
      const double maxResidual = std::max({
          0.0, exact.values.F12, exact.values.F13, exact.values.F23,
          exact.values.useTensionCutoff ? exact.values.T3 : 0.0});
      if (maxResidual > yieldTol) {
        mc_exact::ActiveSetReturnResult projected = mc_exact::solve_exact_mc_active_set_return(
            sigma, regionC[r], mp, trial, nullptr, nullptr);
        if (projected.converged) committedSigma = projected.stress6_tens;
      }
    }

    // Phase 5 HS seeding (spec §6.5, §6.6, F21).
    // The K0 stress seed `sigma` (compression-negative Voigt → compression-
    // positive principal s_1) supplies the geostatic state. We seed
    //   p_p^{(0)} = OCR · σ_1^{(0)}                              (F21)
    // and γ_p = ε_v_p = 0. If OCR == 1 the cap sits exactly on the K0
    // state; if OCR > 1 the cap is "ahead of" the state, leaving the
    // material elastic for small loads (the OC test in verify_hs_phase_5).
    //
    // Predictor projection (§6.5): if the K0 predictor stress lies
    // outside HS yield surfaces (typically true with OCR == 1 and
    // mobilised friction below sin φ), project onto the cap via a
    // 1D return mapping on cap-only flow. This puts the committed
    // state on the cap manifold before the plastic geostatic Newton
    // begins so the outer iterations only chase displacement
    // equilibrium, not yield admissibility.
    MaterialPoint::HsState hsSeed{};
    if (kind == ConstitutiveKind::HardeningSoil) {
      const std::int32_t r =
          m.regionIndex >= 0 && static_cast<std::size_t>(m.regionIndex) < regions.size()
          ? m.regionIndex : 0;
      const RegionParams& rp = regions[r];
      // Pull principal stress at the K0 seed (compression-positive s1 = most compressive).
      const mc_exact::MaterialParameters mp_eig =
          material::hs::make_mp_for_eig(rp, std::max(rp.cEff, 0.0),
                                        std::max(rp.phi, 0.0));
      const auto principalSeed =
          mc_exact::principal_stress_projectors_3d_compression_positive(sigma, mp_eig);
      const double ocr = std::max(rp.hs.OCR, 1e-6);
      const double phi_eff_cap = std::max(rp.phi, 0.0);
      const double c_eff_cap = std::max(rp.cEff, 0.0);
      const double p_t_seed = material::hs::tensile_shift_p_t(c_eff_cap, phi_eff_cap);
      const double M_cap_seed = std::max(rp.hs.M_cap, 1e-6);
      // Cap history seed: the NC K0 state lies on f_c = 0, so p_p is the
      // cap radius required by this principal stress state. OCR scales that
      // radius. Using OCR * sigma_1 is only valid for special M/K0 pairs and
      // can put cohesionless OCR=1 seeds outside the calibrated cap.
      const double sigma1_seed = std::max(principalSeed.s1, 0.0);
      const double p_p_nc_seed = material::hs::cap_required_p_p(
          principalSeed.s1, principalSeed.s2, principalSeed.s3,
          M_cap_seed, p_t_seed, phi_eff_cap);
      const double p_p_seed = std::max(
          ocr * p_p_nc_seed,
          material::hs::numerical_pressure_floor(rp.hs));
      hsSeed.p_p = p_p_seed;
      hsSeed.eps_v_p = 0.0;
      hsSeed.lastActiveSet = 0;
      hsSeed.gamma_p = 0.0;

      // §6.6 / F21 — geostatic γ_p seed. The K0-consolidated state is the
      // historical maximum cone-engaged state. Seed γ_p from the ACTUAL
      // principal pair carried by the K0 predictor, scaled by the user OCR:
      //
      //   σ_1,history = OCR · σ_1,current
      //   σ_3,history = OCR · σ_3,current
      //
      // This preserves the material history implied by the supplied initial
      // stress field. Reconstructing σ_3 as K0_input·σ_1 can silently seed the
      // wrong cone hardening when the caller supplies a non-Jaky K0 field,
      // seepage-modified effective stress, or any future staged-construction
      // geostatic state. No hidden OCR floor is applied here.
      {
        const double phi_eff = std::max(rp.phi, 0.0);
        const double c_eff = std::max(rp.cEff, 0.0);
        const double sigma1_history = ocr * sigma1_seed;
        const double sigma3_history = ocr * std::max(principalSeed.s3, 0.0);
        if (sigma1_history > 1e-12) {
          hsSeed.gamma_p = std::max(material::hs::cone_zero_gamma_p_for_principal_pair(
              sigma1_history, sigma3_history, c_eff, phi_eff, rp.hs), 0.0);
        }
      }

      // §6.5 predictor projection. Project onto cap if cap violated
      // (OCR < 1 with very low confinement, edge case). With OCR ≥ 1
      // the seed is already inside the cap.
      const double f_c_seed = material::hs::cap_yield_value(
          principalSeed.s1, principalSeed.s2, principalSeed.s3,
          hsSeed.p_p, M_cap_seed, p_t_seed, phi_eff_cap);
      if (f_c_seed > 1e-6 * std::max(hsSeed.p_p, 1.0)) {
        const double E_ur_seed = material::hs::power_law_stiffness(
            rp.hs.Eur_ref, principalSeed.s3, c_eff_cap, phi_eff_cap,
            rp.hs.p_ref, rp.hs.m);
        const Mat6 D_e_seed = material::hs::elastic_tangent_voigt(E_ur_seed, rp.hs.nu_ur);
        const material::hs::HsUpdateResult projection =
            material::hs::return_cap_only(
                principalSeed, hsSeed,
                c_eff_cap, phi_eff_cap,
                M_cap_seed, p_t_seed,
                std::max(rp.hs.H_cap, 1.0), D_e_seed, rp);
        if (projection.failureCode == 0 && projection.activeSurface != 0) {
          committedSigma = projection.stressUpdated;
          hsSeed = projection.stateUpdated;
        }
      }
    }

    for (int k = 0; k < 6; ++k) {
      m.effectiveStress[k] = committedSigma[k];
      m.totalStrain[k] = 0.0;
      m.plasticStrain[k] = 0.0;
      m.geostaticEffectiveStress[k] = committedSigma[k];
      m.geostaticTotalStrain[k] = 0.0;
      m.geostaticPlasticStrain[k] = 0.0;
    }
    m.accumulatedPlasticStrain = 0.0;
    m.geostaticAccumulatedPlasticStrain = 0.0;
    m.porePressure = porePressureByGp ? porePressureByGp[i] : 0.0;
    m.plasticActive = 0;
    m.plasticEverActive = 0;
    m.tensionCutoffActive = 0;
    if (kind == ConstitutiveKind::McPlastic || kind == ConstitutiveKind::McReducedStiffness) {
      const std::int32_t r = m.regionIndex >= 0 && static_cast<std::size_t>(m.regionIndex) < regions.size()
          ? m.regionIndex : 0;
      const mc_exact::MaterialParameters mp = material_parameters_from_region(regions[r], regions[r].symmetrize != 0u);
      m.etaMcCurrent = mc_eta_from_stress(committedSigma, mp);
      m.etaMcMax = m.etaMcCurrent;
    } else {
      m.etaMcCurrent = 0.0;
      m.etaMcMax = 0.0;
    }
    m.exactBranchKind = static_cast<std::uint8_t>(mc_exact::BranchKind::ELASTIC);
    m.multiplicityKind = static_cast<std::uint8_t>(mc_exact::MultiplicityKind::DISTINCT);
    m.currentlyMcActive = 0;
    m.hasRepresentativeProjectors = 0;
    m.localReturnMode = 0;
    m.localFallbackUsed = 0;
    if (kind == ConstitutiveKind::HardeningSoil) {
      m.hs = hsSeed;
    }
  }
}

// Capture the geostatic baseline into MaterialPoint's geostatic*
// fields. Called once at the end of the geostatic phase.
inline void snapshot_geostatic_baseline(std::vector<MaterialPoint>& mp) {
  for (auto& m : mp) {
    m.referenceStress = m.effectiveStress;
    m.geostaticEffectiveStress = m.effectiveStress;
    m.geostaticTotalStrain = m.totalStrain;
    m.geostaticPlasticStrain = m.plasticStrain;
    m.geostaticAccumulatedPlasticStrain = m.accumulatedPlasticStrain;
  }
}

// Top-level driver — runs the geostatic + service + safety phases as
// configured.
struct DriverInput {
  std::vector<ElementCache>* elements{ nullptr };
  const std::vector<BeamElementCache>* beamElements{ nullptr };
  std::vector<MaterialPoint>* materialPoints{ nullptr };
  const std::vector<RegionParams>* regions{ nullptr };
  const std::vector<std::int32_t>* freeDofs{ nullptr };
  const std::vector<std::int32_t>* freeIndexByDof{ nullptr };
  CsrMatrix* K{ nullptr };
  std::int32_t ndof{ 0 };
  const std::vector<double>* gravityRhsFree{ nullptr };
  const std::vector<double>* loadRhsFree{ nullptr };  // surface traction
  std::vector<double>* U_global{ nullptr };           // service displacement
  std::vector<double>* U_geostatic{ nullptr };        // baseline at end of geostatic
  SolverOptions opts{};
};

struct DriverOutput {
  RunSummary summary;
  SafetyResult safety;
  std::vector<double> beamReferenceU;
  std::vector<double> displayComparisonAccumulatedPlasticStrain;
  std::vector<std::int32_t> acceptedStepIterations;
};

inline void append_phase_step_iterations(DriverOutput& out, const PhaseResult& phase) {
  out.acceptedStepIterations.insert(
      out.acceptedStepIterations.end(),
      phase.acceptedStepIterations.begin(),
      phase.acceptedStepIterations.end());
}

inline DriverOutput run_full_analysis(DriverInput& in) {
  DriverOutput out;
  const std::int32_t nfree = in.K->nrows;
  const std::int32_t ndof = in.ndof;
  std::vector<double> beamReferenceU(static_cast<std::size_t>(std::max(ndof, 0)), 0.0);

  // Always-needed combined RHS (gravity + load) at full lambda; used to
  // initialise the safety phase load target.
  std::vector<double> combinedRhs(static_cast<std::size_t>(nfree), 0.0);
  for (std::int32_t i = 0; i < nfree; ++i) {
    combinedRhs[i] = (*in.gravityRhsFree)[i] + (*in.loadRhsFree)[i];
  }

  std::vector<MaterialPoint> trialMp = *in.materialPoints;

  PhaseContext ctx;
  ctx.elements = in.elements;
  ctx.beamElements = in.beamElements;
  ctx.committed = in.materialPoints;
  ctx.trial = &trialMp;
  ctx.regions = in.regions;
  ctx.freeDofs = in.freeDofs;
  ctx.freeIndexByDof = in.freeIndexByDof;
  ctx.K = in.K;
  ctx.U_global = in.U_global;
  // JS exact-plastic uses the K0 predictor as a stress seed only. The
  // nonlinear unknowns are correction displacements from zero; the elastic
  // predictor displacement is stitched back into output fields later for
  // display, not replayed into constitutive strain.
  ctx.U_base = nullptr;
  ctx.beamReferenceU = &beamReferenceU;
  ctx.beamMode = BeamAssemblyMode::Active;
  ctx.ndof = ndof;
  ctx.kind = in.opts.constitutive;
  ctx.symmetrize =
      in.opts.constitutive == ConstitutiveKind::HardeningSoil
          ? false
          : (in.opts.symmetrizeTangent != 0);
  ctx.modelBoundingBoxDiagonal = model_bounding_box_diagonal(*in.elements);

  // ---------------------------------------------------------------------------
  // Phase A — geostatic equilibration under gravity body force.
  // ---------------------------------------------------------------------------
  std::vector<Mat6> regionC = build_region_elastic(*in.regions);
  ctx.regionC = &regionC;
  out.summary.geostaticConverged = 0;
  // §5.6 capability table: MC plasticity supports a nonlinear geostatic
  // equilibration phase. HS uses the K0 predictor as a stress-only baseline
  // and solves the service increment in incremental-stress form. This avoids
  // re-equilibrating a B-bar projected T6 operator against a depth-wise K0
  // stress seed; that combination creates artificial geostatic plasticity
  // before any service load is applied.
  const bool runPlasticGeostatic =
      in.opts.analysisMode != AnalysisMode::ServiceOnly &&
      in.opts.constitutive == ConstitutiveKind::McPlastic;

  if (runPlasticGeostatic) {
    ctx.phaseKind = PhaseKind::InitialGravity;
    ctx.incrementalStress = false;
    ctx.beamMode = BeamAssemblyMode::InactiveStabilizeRotations;
    // Mirror JS initializePlasticPredictorReferenceState: the K0 predictor is
    // a stress seed, not a displacement preload. Assemble and commit that
    // stress-only state, then continue from its internal-force field to the
    // full gravity RHS.
    std::vector<double> predictorInternal(static_cast<std::size_t>(nfree), 0.0);
    std::vector<double> predictorResidual(static_cast<std::size_t>(nfree), 0.0);
    trialMp = *in.materialPoints;
    AssembleOutput predictorAssembly = assemble_global(
        *in.elements, in.beamElements, *in.materialPoints, trialMp, *in.regions, regionC,
        *in.freeIndexByDof, in.U_global->data(),
        nullptr,
        nullptr, nullptr, 0.0,
        in.opts.constitutive, in.opts.symmetrizeTangent != 0,
        /*incrementalStress=*/false,
        /*wantTangent=*/false,
        *in.K, predictorInternal, predictorResidual,
        /*useElasticGlobalizationTangent=*/false,
        BeamAssemblyMode::InactiveStabilizeRotations,
        nullptr);
    (void)predictorAssembly;
    *in.materialPoints = trialMp;
    trialMp = *in.materialPoints;

    std::vector<double> geostaticRamp(static_cast<std::size_t>(nfree), 0.0);
    for (std::int32_t i = 0; i < nfree; ++i) {
      geostaticRamp[static_cast<std::size_t>(i)] =
          (*in.gravityRhsFree)[static_cast<std::size_t>(i)] -
          predictorInternal[static_cast<std::size_t>(i)];
    }
    ctx.baseRhsFree = &predictorInternal;
    ctx.rampedRhsFree = &geostaticRamp;

    // Staged construction (model C — excavation by stress relaxation). The
    // committed K0 stress σ₀ at U = 0 IS the supported in-situ state:
    //   predictorInternal = F_int(σ₀) = gravityRhsFree + R_support,
    // where R_support = predictorInternal − gravityRhsFree (= −geostaticRamp).
    // On a flat-top vertical-cut geometry R_support is EXACTLY the consistent
    // nodal reaction of the in-situ traction σ₀·n on the cut face — the K0
    // "unbalanced force" left because the cut face is the sole non-horizontal
    // free boundary carrying a non-zero σ₀ traction (the horizontal surfaces see
    // σ'_v = 0, the base/sides are constrained). On sloping or strongly layered
    // retained ground the K0 seed is not discretely divergence-free (the seed
    // shear is clipped to the MC envelope), so R_support is PREDOMINANTLY the
    // cut-face support plus a small discrete-equilibrium residue — which relaxes
    // away harmlessly with the support, since the λ_exc = 1 target is exactly
    // gravity regardless (Potts & Zdravković, FEA in Geotechnical Engineering:
    // Theory, §excavation-by-relaxation). The legacy single-phase
    // geostatic ramps this support OFF wall-free (predictorInternal → gravity),
    // which has no equilibrium for an unsupported cohesionless cut. Staged
    // instead: (A) holds the supported in-situ state — the predictor commit IS
    // that state (σ₀ balances gravity + support at U = 0 by construction, so no
    // wall-free gravity solve is run), wishing the wall in place at zero load
    // (beamReferenceU = U ≈ 0); then (B) relaxes the support to zero (ramps
    // predictorInternal → gravity, the SAME target as the legacy phase) in a new
    // Excavation phase with the wall structurally ACTIVE, so the wall carries
    // the cut. The wall sees only the excavation increment, never the
    // establishment of the at-rest field (already in σ₀) — i.e. it is model C,
    // not the at-rest-double-counting model B.
    const bool stagedExcavation =
        in.opts.stagedExcavationActive != 0 &&
        in.beamElements != nullptr && !in.beamElements->empty();

    if (stagedExcavation) {
      // (A) Supported in-situ state: established by the predictor commit above.
      // U_global is still 0 here, so the wished-in-place wall starts unstressed.
      beamReferenceU = *in.U_global;

      // (B) Excavation: relax the cut-face support with the wall active. Same
      // affine target predictorInternal → gravity as the legacy geostatic ramp,
      // but beamMode = Active so the wall resists the unloading.
      ctx.phaseKind = PhaseKind::Excavation;
      ctx.beamMode = BeamAssemblyMode::Active;
      ctx.incrementalStress = false;
      PhaseResult excavation = run_nonlinear_phase(ctx, in.opts);
      // Report the excavation fraction as the initial-phase progress: the
      // wall-free geostatic establishment is trivially complete, so the
      // excavation is the meaningful staged step that can stall at a genuine
      // wall limit.
      out.summary.geostaticAccepted = excavation.accepted;
      out.summary.geostaticRejected = excavation.rejected;
      out.summary.loadStepsAccepted += excavation.accepted;
      out.summary.loadStepsRejected += excavation.rejected;
      out.summary.newtonIterations += excavation.newtonIterations;
      out.summary.cgIterations += excavation.cgIterations;
      out.summary.geostaticLoadFactor = excavation.loadFactor;
      out.summary.geostaticConverged = excavation.converged ? 1 : 0;
      out.summary.lastLinearSolverKind = excavation.lastLinearSolverKind;
      append_phase_step_iterations(out, excavation);
      merge_tier2_summary(out.summary, excavation);
      out.summary.maxEta = std::max(out.summary.maxEta, excavation.maxEta);
      out.summary.finalActiveCount = excavation.activeCount;
      out.summary.finalTensionCount = excavation.tensionCount;
      if (!excavation.converged) {
        // Genuine excavation limit (e.g. an under-embedded wall kicking out):
        // show the honest near-failure iterate at its achieved excavation
        // fraction, with the wall active so the partial diagram is meaningful
        // (mirrors the ServiceLoad handoff below).
        out.summary.residualNorm = excavation.residualNorm;
        out.summary.finalLoadFactor = excavation.loadFactor;
        if (excavation.hasDisplayState &&
            excavation.displayLoadFactor > out.summary.finalLoadFactor + 1e-12) {
          *in.U_global = excavation.displayU;
          *in.materialPoints = excavation.displayMp;
          out.summary.finalLoadFactor = excavation.displayLoadFactor;
          out.summary.finalActiveCount = excavation.displayActiveCount;
          out.summary.finalTensionCount = excavation.displayTensionCount;
        }
        out.beamReferenceU = beamReferenceU;
        return out;
      }
      // Excavation converged: the end-of-excavation state (in-situ + open cut,
      // wall installed) is the baseline the service increment builds on.
      if (in.U_geostatic) *in.U_geostatic = *in.U_global;
      snapshot_geostatic_baseline(*in.materialPoints);
    } else {
      // Legacy single-phase wall-free geostatic equilibration (unchanged).
      PhaseResult geostatic = run_nonlinear_phase(ctx, in.opts);
      out.summary.geostaticAccepted = geostatic.accepted;
      out.summary.geostaticRejected = geostatic.rejected;
      out.summary.loadStepsAccepted += geostatic.accepted;
      out.summary.loadStepsRejected += geostatic.rejected;
      out.summary.newtonIterations += geostatic.newtonIterations;
      out.summary.cgIterations += geostatic.cgIterations;
      out.summary.geostaticLoadFactor = geostatic.loadFactor;
      out.summary.geostaticConverged = geostatic.converged ? 1 : 0;
      // Phase 7 telemetry: latch the most-recent solver kind and the
      // sticky HS-plastic-used-GMRES flag.
      out.summary.lastLinearSolverKind = geostatic.lastLinearSolverKind;
      if (in.opts.constitutive == ConstitutiveKind::HardeningSoil && geostatic.gmresInvocations > 0) {
        out.summary.hsPlasticUsedGmres = 1;
      }
      append_phase_step_iterations(out, geostatic);
      merge_tier2_summary(out.summary, geostatic);
      out.summary.maxEta = std::max(out.summary.maxEta, geostatic.maxEta);
      out.summary.finalActiveCount = geostatic.activeCount;
      out.summary.finalTensionCount = geostatic.tensionCount;
      if (!geostatic.converged) {
        out.summary.residualNorm = geostatic.residualNorm;
        out.summary.maxEta = std::max(out.summary.maxEta, geostatic.maxEta);
        out.summary.finalActiveCount = geostatic.activeCount;
        out.summary.finalTensionCount = geostatic.tensionCount;
        out.summary.finalLoadFactor = geostatic.loadFactor;
        out.beamReferenceU = *in.U_global;
        return out;
      }
      // Snapshot U_geostatic and the geostatic state baseline.
      if (in.U_geostatic) *in.U_geostatic = *in.U_global;
      beamReferenceU = *in.U_global;
      snapshot_geostatic_baseline(*in.materialPoints);
    }
  } else {
    // The JS path only runs a nonlinear plastic geostatic correction for
    // plugins that support it. Linear-elastic and reduced-stiffness analyses
    // use the K0 seed as a stress-only reference and solve the service
    // increment directly.
    if (in.U_geostatic) {
      std::fill(in.U_geostatic->begin(), in.U_geostatic->end(), 0.0);
    }
    out.summary.geostaticConverged = 1;
    std::fill(beamReferenceU.begin(), beamReferenceU.end(), 0.0);
    snapshot_geostatic_baseline(*in.materialPoints);
  }

  // ---------------------------------------------------------------------------
  // Phase B — service-load increment.
  // ---------------------------------------------------------------------------
  // The geostatic phase converged with F_int ≈ gravity. For the normal
  // geostatic+service workflow, mirror JS's incremental formulation:
  // subtract the geostatic reference stress from F_int and solve
  // target(λ_load) = λ_load * surface load.
  //
  // For the ServiceOnly mode we have no geostatic baseline and bake the
  // entire (gravity + load) into the ramped portion, which gives the
  // historical "gravity-ramp from σ = 0" behaviour.

  bool hasService = (*in.loadRhsFree).size() > 0 && std::any_of(
      in.loadRhsFree->begin(), in.loadRhsFree->end(),
      [](double v) { return v != 0.0; });

  if (hasService || in.opts.analysisMode == AnalysisMode::ServiceOnly) {
    ctx.phaseKind = PhaseKind::ServiceLoad;
    ctx.beamMode = BeamAssemblyMode::Active;
    if (in.opts.analysisMode == AnalysisMode::ServiceOnly) {
      ctx.baseRhsFree = nullptr;
      ctx.rampedRhsFree = &combinedRhs;
      ctx.incrementalStress = false;
    } else {
      ctx.baseRhsFree = nullptr;
      ctx.rampedRhsFree = in.loadRhsFree;
      ctx.incrementalStress = true;
    }
    PhaseResult service = run_nonlinear_phase(ctx, in.opts);
    if (!service.converged &&
        in.opts.constitutive == ConstitutiveKind::HardeningSoil &&
        service.loadFactor > 0.0 &&
        service.loadFactor < 1.0 - 1e-6) {
      PhaseResult arcService = run_load_arc_length_phase(ctx, in.opts, service.loadFactor);
      PhaseResult combined = service;
      accumulate_phase_cost(combined, arcService);
      combined.activeCount = arcService.activeCount;
      combined.activeFaceCount = arcService.activeFaceCount;
      combined.activeEdgeCount = arcService.activeEdgeCount;
      combined.activeApexCount = arcService.activeApexCount;
      combined.tensionCount = arcService.tensionCount;
      combined.residualNorm = arcService.residualNorm;
      combined.loadFactor = arcService.loadFactor;
      combined.converged = arcService.converged;
      service = combined;
    }
    out.summary.serviceAccepted = service.accepted;
    out.summary.serviceRejected = service.rejected;
    out.summary.loadStepsAccepted += service.accepted;
    out.summary.loadStepsRejected += service.rejected;
    out.summary.newtonIterations += service.newtonIterations;
    out.summary.cgIterations += service.cgIterations;
    out.summary.finalLoadFactor = service.loadFactor;
    out.summary.residualNorm = service.residualNorm;
    out.summary.maxEta = std::max(out.summary.maxEta, service.maxEta);
    out.summary.finalActiveCount = service.activeCount;
    out.summary.finalTensionCount = service.tensionCount;
    out.summary.serviceConverged = service.converged ? 1 : 0;
    // Phase 7 telemetry — latch service phase's solver kind.
    out.summary.lastLinearSolverKind = service.lastLinearSolverKind;
    out.summary.pad[0] = static_cast<std::uint8_t>(service.lastHsFailureCode & 0xffu);
    out.summary.pad[1] = static_cast<std::uint8_t>((service.lastHsFailureCode >> 8) & 0xffu);
    if (in.opts.constitutive == ConstitutiveKind::HardeningSoil && service.gmresInvocations > 0) {
      out.summary.hsPlasticUsedGmres = 1;
    }
    append_phase_step_iterations(out, service);
    merge_tier2_summary(out.summary, service);
    if (!service.converged) {
      // Workstream C1: mirror the SafetyCphi near-failure display-state handoff
      // (see the SafetyCphi block further below). The service load-step loop
      // rolled `U_global` back to the last committed equilibrium; when the
      // first service step stalls that is the geostatic beam-reference state,
      // so the wall response extracted relative to `beamReferenceU` is
      // identically zero. Instead show the best near-failure iterate the
      // service phase actually assembled, at its truthful achieved load
      // fraction. displayU/displayMp are a matched assembled iterate, so the
      // wire GP stresses stay consistent with the wall displacements (same as
      // safety — no re-assembly).
      //
      // Guard on a strictly higher achieved fraction so the HS service
      // arc-length rescue (above), which advances `U_global` and
      // `finalLoadFactor` past the service stall but does not record display
      // state, is never regressed back to a lower-fraction iterate. For the
      // mc-plastic flat-zero case `finalLoadFactor` is the rolled-back
      // committed fraction (0 when the first step stalls), so the display
      // iterate's higher fraction triggers the handoff. Fires only inside
      // `!service.converged`, so converged results are byte-identical.
      if (service.hasDisplayState &&
          service.displayLoadFactor > out.summary.finalLoadFactor + 1e-12) {
        *in.U_global = service.displayU;
        *in.materialPoints = service.displayMp;
        out.summary.finalLoadFactor = service.displayLoadFactor;
        out.summary.finalActiveCount = service.displayActiveCount;
        out.summary.finalTensionCount = service.displayTensionCount;
      }
      out.beamReferenceU = beamReferenceU;
      return out;
    }
  } else {
    // No service load: take the geostatic state as the final result.
    out.summary.serviceConverged = 1;
    out.summary.finalLoadFactor = 1.0;
  }

  // ---------------------------------------------------------------------------
  // Phase C — c-φ safety bracketing.
  // ---------------------------------------------------------------------------
  if (in.opts.analysisMode != AnalysisMode::GeostaticServiceSafety) {
    out.beamReferenceU = beamReferenceU;
    return out;
  }
  out.summary.safetyRan = 1;
  out.safety.status = 0;
  out.safety.factorOfSafetyLower = 1.0;
  out.safety.factorOfSafetyUpper = 1.0;

  // Save the state at end-of-service as the safety baseline.
  const std::vector<MaterialPoint> safetyBase = *in.materialPoints;
  const std::vector<double> safetyBaseU = *in.U_global;
  std::vector<MaterialPoint> stableMp = safetyBase;
  std::vector<double> stableU = safetyBaseU;
  std::vector<MaterialPoint> displayMp = safetyBase;
  std::vector<double> displayU = safetyBaseU;
  std::vector<MaterialPoint> comparisonMp = safetyBase;
  std::int32_t displayActiveCount = out.summary.finalActiveCount;
  std::int32_t displayTensionCount = out.summary.finalTensionCount;
  std::int32_t displayedTrialIndex = -1;
  auto sigma_at_progress = [](double start, double target, double progress) {
    const double t = std::clamp(progress, 0.0, 1.0);
    return start + (target - start) * t;
  };

  // 1:1 mirror of JS solveSafetyCphi (solver.js:5519) bracketing loop.
  double sigmaLow = 1.0;
  double sigmaHigh = -1.0;  // -1 = unset
  const double sigmaMax = std::max(in.opts.safetySigmaMax, 1.05);
  const double bracketTol = std::max(in.opts.safetyBracketTolerance, 1e-4);
  const double sigmaMinIncrement = std::max(std::min(bracketTol, 0.01), 1e-4);
  double sigmaIncrement = std::max(in.opts.safetyInitialIncrement, sigmaMinIncrement);
  const double sigmaGrowthFactor = std::max(in.opts.safetyGrowthFactor, 1.05);
  const double sigmaCutbackFactor = std::clamp(in.opts.safetyCutbackFactor, 0.1, 0.95);
  const double bracketTolWithRoundoff = bracketTol + 1e-12;

  for (std::int32_t trial = 0; trial < in.opts.safetyMaxSearchTrials; ++trial) {
    if (sigmaHigh > 0 && (sigmaHigh - sigmaLow) <= bracketTolWithRoundoff) break;
    if (sigmaLow >= sigmaMax - bracketTol) break;
    // JS line 5623: target = min(lower + increment, sigmaMax). No
    // bisection — the increment shrinks on failure with a *0.5
    // clamp on the upper-lower band, which acts like a soft bisection
    // without overshooting.
    const double target = std::min(sigmaLow + sigmaIncrement, sigmaMax);
    const std::vector<MaterialPoint> trialStartMp = stableMp;
    const std::vector<double> trialStartU = stableU;
    // JS safety continuation starts each trial from the last converged
    // reduced-strength checkpoint and then interpolates strength from
    // sigmaLow to the target inside solveNonlinearPhase as lambda advances.
    std::vector<RegionParams> trialRegions = *in.regions;
    for (auto& r : trialRegions) r = reduce_strength(r, sigmaLow);
    std::vector<Mat6> trialC = build_region_elastic(trialRegions);

    *in.materialPoints = trialStartMp;
    *in.U_global = trialStartU;
    PhaseContext sctx = ctx;
    sctx.regions = &trialRegions;
    sctx.regionC = &trialC;
    sctx.phaseKind = PhaseKind::SafetyCphi;
    sctx.incrementalStress = false;
    sctx.safetyStrengthBaseRegions = in.regions;
    sctx.safetySigmaMsfStart = sigmaLow;
    sctx.safetySigmaMsfTarget = target;
    sctx.safetyBaseU = &safetyBaseU;
    sctx.safetyComparison = &safetyBase;
    sctx.safetyCurve = &out.safety.curve;
    sctx.safetyTrialIndex = static_cast<std::int32_t>(out.safety.trials.size());
    // Keep safety in the same correction-coordinate displacement frame as
    // geostatic and service. The display layer adds the elastic predictor
    // displacement after the solve, matching the JS CPU path.
    sctx.U_base = nullptr;
    // Safety solves at the full external force while strength is reduced.
    // Keep the RHS constant through the continuation phase; lambda only
    // controls the Newton driver's step bookkeeping.
    std::vector<double> zeroRhs(static_cast<std::size_t>(nfree), 0.0);
    sctx.baseRhsFree = &combinedRhs;  // gravity + load at full strength
    sctx.rampedRhsFree = &zeroRhs;

    const std::size_t curveSizeBeforeTrial = out.safety.curve.size();
    PhaseResult sr = run_nonlinear_phase(sctx, in.opts);
    PhaseResult trialCost = sr;
    if (should_attempt_safety_arc_length_auto(
            sr, in.opts, in.opts.constitutive, sigmaLow, target, sigmaHigh, bracketTol)) {
      const std::vector<MaterialPoint> strengthResultMp = *in.materialPoints;
      const std::vector<double> strengthResultU = *in.U_global;
      const std::vector<MaterialPoint> strengthTrialScratch = trialMp;
      std::vector<SafetyCurvePoint> arcTrialCurve;

      *in.materialPoints = trialStartMp;
      *in.U_global = trialStartU;
      trialMp = trialStartMp;
      PhaseContext arcCtx = sctx;
      arcCtx.safetyCurve = &arcTrialCurve;
      SolverOptions arcOpts = in.opts;
      arcOpts.requestedContinuationMode = RequestedContinuationMode::ArcLength;
      PhaseResult arcSr = run_nonlinear_phase(arcCtx, arcOpts);
      accumulate_phase_cost(trialCost, arcSr);

      if (arcSr.converged) {
        out.safety.curve.resize(curveSizeBeforeTrial);
        out.safety.curve.insert(
            out.safety.curve.end(), arcTrialCurve.begin(), arcTrialCurve.end());
        sr = std::move(arcSr);
      } else {
        *in.materialPoints = strengthResultMp;
        *in.U_global = strengthResultU;
        trialMp = strengthTrialScratch;
      }
      apply_phase_cost_counts(sr, trialCost);
    }
    out.summary.loadStepsAccepted += sr.accepted;
    out.summary.loadStepsRejected += sr.rejected;
    out.summary.newtonIterations += sr.newtonIterations;
    out.summary.cgIterations += sr.cgIterations;
    out.summary.maxEta = std::max(out.summary.maxEta, sr.maxEta);
    // Phase 7 telemetry — latch safety trial's solver kind / HS GMRES.
    out.summary.lastLinearSolverKind = sr.lastLinearSolverKind;
    if (in.opts.constitutive == ConstitutiveKind::HardeningSoil && sr.gmresInvocations > 0) {
      out.summary.hsPlasticUsedGmres = 1;
    }
    append_phase_step_iterations(out, sr);
    out.safety.trialCount += 1;
    out.safety.totalNewtonIterations += sr.newtonIterations;
    SafetyTrial st;
    st.sigmaMsfStart = sigmaLow;
    st.sigmaMsfTarget = target;
    st.sigmaMsfCommitted = sr.converged
        ? target
        : sigma_at_progress(sigmaLow, target, sr.loadFactor);
    st.converged = sr.converged ? 1 : 0;
    st.trialOutcome = sr.converged ? 0u : 1u;
    st.failureCode = sr.converged ? 0u : 1u;
    st.iterations = sr.newtonIterations;
    out.safety.trials.push_back(st);

    if (sr.converged) {
      displayedTrialIndex = static_cast<std::int32_t>(out.safety.trials.size()) - 1;
      sigmaLow = target;
      stableMp = *in.materialPoints;
      stableU = *in.U_global;
      displayMp = stableMp;
      displayU = stableU;
      comparisonMp = safetyBase;
      displayActiveCount = sr.activeCount;
      displayTensionCount = sr.tensionCount;
      // JS line 5698: grow the increment after a successful trial,
      // capped at the remaining headroom to sigmaMax.
      sigmaIncrement = std::min(
          std::max(sigmaIncrement * sigmaGrowthFactor, sigmaMinIncrement),
          std::max(sigmaMax - sigmaLow, sigmaMinIncrement));
    } else {
      displayedTrialIndex = static_cast<std::int32_t>(out.safety.trials.size()) - 1;
      displayMp = sr.hasDisplayState ? sr.displayMp : *in.materialPoints;
      displayU = sr.hasDisplayState ? sr.displayU : *in.U_global;
      comparisonMp = trialStartMp;
      displayActiveCount = sr.hasDisplayState ? sr.displayActiveCount : sr.activeCount;
      displayTensionCount = sr.hasDisplayState ? sr.displayTensionCount : sr.tensionCount;
      sigmaHigh = (sigmaHigh < 0) ? target : std::min(sigmaHigh, target);
      // JS line 5703: shrink increment, clamped by half the bracket band.
      const double bandHalf = (sigmaHigh > 0) ? std::max((sigmaHigh - sigmaLow) * 0.5, sigmaMinIncrement) : sigmaIncrement;
      sigmaIncrement = std::max(
          std::min(sigmaIncrement * sigmaCutbackFactor, bandHalf),
          sigmaMinIncrement);
      if (sigmaIncrement < 1e-4) break;
    }
  }
  // For safety runs the displayed field is the active safety phase:
  // a failed probe when failure is bracketed, or the highest converged
  // reduced-strength state when no upper failure was found. Displacements are
  // shown relative to the original safety base equilibrium; plastic strain
  // increments are compared against the lower-bound checkpoint for bracketed
  // failures, matching the JS CPU result builder.
  *in.materialPoints = displayMp;
  *in.U_global = displayU;
  if (in.U_geostatic) *in.U_geostatic = safetyBaseU;
  out.displayComparisonAccumulatedPlasticStrain.resize(displayMp.size(), 0.0);
  for (std::size_t i = 0; i < displayMp.size(); ++i) {
    out.displayComparisonAccumulatedPlasticStrain[i] =
        i < comparisonMp.size() ? comparisonMp[i].accumulatedPlasticStrain : 0.0;
  }
  out.summary.finalActiveCount = displayActiveCount;
  out.summary.finalTensionCount = displayTensionCount;
  for (std::size_t i = 0; i < out.safety.trials.size(); ++i) {
    out.safety.trials[i].displayed =
        static_cast<std::int32_t>(i) == displayedTrialIndex ? 1u : 0u;
  }

  out.safety.factorOfSafetyLower = sigmaLow;
  out.safety.factorOfSafetyUpper = sigmaHigh > 0 ? sigmaHigh : sigmaMax;
  out.safety.strengthRetained = 1.0 / std::max(sigmaLow, 1.0);
  if (sigmaHigh > 0) {
    out.safety.status = 1;  // bracketed
  } else if (sigmaHigh < 0 && sigmaLow >= sigmaMax - bracketTol) {
    out.safety.status = 3;  // no failure found
  } else {
    out.safety.status = 2;  // mechanism
  }

  out.beamReferenceU = beamReferenceU;
  return out;
}

}  // namespace madep::solver
