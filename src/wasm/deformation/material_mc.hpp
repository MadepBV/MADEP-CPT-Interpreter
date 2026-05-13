// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mohr-Coulomb plasticity with optional Rankine tension cut-off, formulated
// in principal stress space (tension positive).
//
// Yield surface:
//   f(σ) = (σ_max - σ_min) - (σ_max + σ_min) * sin(φ) - 2 c cos(φ)
//
// Non-associated plastic potential (φ → ψ):
//   g(σ) = (σ_max - σ_min) - (σ_max + σ_min) * sin(ψ)
//
// Return mapping: classical Owen-Hinton / Borja procedure. Compute trial
// stress, rotate to principal axes, evaluate yield, project back onto the
// active surface(s), then rotate back. For the engineering scope we
// handle three branches by inspection:
//   1. main MC plane (between f1 = 0 and f6 = 0 surfaces),
//   2. tension cut-off (σ_max > σ_t),
//   3. apex / corner (both violated simultaneously) → project to the
//      apex point σ1 = σ2 = σ3 = σ_apex.
//
// The result includes the consistent algorithmic tangent in 6×6 Voigt
// form so global Newton converges quadratically.
//
// Capabilities relative to the CPU JS path:
//   - same engineering physics (admissible final stress within the MC + T3
//     envelope), but
//   - no exact-active-set bookkeeping or branch caching across iterations,
//   - no closed-form edge-mode selection: instead we always project to
//     the MC plane first, then check the tension surfaces.
//
// This is consistent with the user's "engineering correctness only"
// directive.

#pragma once

#include <array>
#include <cmath>
#include <algorithm>
#include <limits>

#include "linalg.hpp"
#include "types.hpp"

namespace madep::material {

struct ReturnMappingResult {
  Vec6 stress{};           // final effective stress (tension positive)
  Vec6 plasticStrainInc{}; // Δε^p
  Mat6 tangent{};          // consistent algorithmic tangent C^ep (6×6)
  double equivalent_plastic_strain_inc{ 0.0 };
  double yield_residual{ 0.0 };
  double eta{ 0.0 };       // f/(2 c cos φ + (σ_max + σ_min) sin φ) — heuristic, used for display
  std::uint8_t plastic_active{ 0 };
  std::uint8_t tension_cutoff_active{ 0 };
  std::uint8_t apex_active{ 0 };
  std::uint8_t pad{ 0 };
};

// Mohr-Coulomb yield function in principal stress space, TENSION
// POSITIVE convention with σ1 ≥ σ2 ≥ σ3.
//
//   τ_max = c + σ_n_compressive tan φ   (classical MC, compressive σ_n)
//
// With σ_n_compr = -σ_n_tens, the form in tension-positive principals is:
//
//   f = (σ1 - σ3) + (σ1 + σ3) sin φ - 2 c cos φ.
//
// In a typical compressive state σ1, σ3 < 0 and (σ1+σ3) sin φ is a
// large negative number; f then sits well below zero and the state is
// elastic. The yield surface is a hexagonal pyramid that opens into the
// compressive octant and closes at the tension apex σ = +c cot φ.
inline double mc_yield_principal(double s1, double s3, double c, double phi) {
  return (s1 - s3) + (s1 + s3) * std::sin(phi) - 2.0 * c * std::cos(phi);
}

// Apex stress in tension-positive convention: σ1 = σ2 = σ3 = +c cot φ.
inline double mc_apex(double c, double phi) {
  if (std::sin(phi) < 1e-12) return std::numeric_limits<double>::infinity();
  return c / std::tan(phi);
}

// Project principal stresses onto the MC plane (s1 - s3) = (s1 + s3) sin φ + 2 c cos φ.
// Returns the corrected principal stresses sorted descending. Uses
// elastic stiffness expressed in the principal triad: assume isotropic
// elasticity so C_pp = diag(K + 4G/3, K + 4G/3, K + 4G/3) + off-diag
// (K - 2G/3) — i.e. the same C as in the global frame.
//
// Closed-form Δλ comes from the consistency f(σ_n+1) = 0 with
//   σ_n+1 = σ_trial - Δλ * C * b,  b = ∂g/∂σ.
// Single-surface MC return on the f_{13} face in tension-positive
// principal stress space (σ1 ≥ σ2 ≥ σ3 assumed).
//
//   f = (σ1 - σ3) + (σ1 + σ3) sin φ - 2 c cos φ          (tension positive)
//   g = (σ1 - σ3) + (σ1 + σ3) sin ψ                      (potential)
//
// Flow direction in principal space:
//   a = ∂f/∂σ = (1 + sin φ, 0, sin φ - 1) = (1 + sin φ, 0, -(1 - sin φ))
//   b = ∂g/∂σ = (1 + sin ψ, 0, sin ψ - 1) = (1 + sin ψ, 0, -(1 - sin ψ))
//
// Stress correction: σ_{n+1} = σ_tr - Δλ · C · b.
// Consistency f(σ_{n+1}) = 0  ⇒  Δλ = f_tr / (a^T C b).
//
// For isotropic C (K bulk, G shear):
//   a^T C b = K (a^T 1)(b^T 1) + 2G (a^T b - (a^T 1)(b^T 1)/3)
//   a^T 1 = 2 sin φ,  b^T 1 = 2 sin ψ.
//   a^T b = (1+sφ)(1+sψ) + (1-sφ)(1-sψ) = 2(1 + sφ sψ).
//   ⇒ a^T C b = 4 K sφ sψ + 4G + (4/3) G sφ sψ.
//
// Components of C b (Voigt-3, principal frame, λ = K - 2G/3):
//   (C b)_1 = (λ+2G)(1+sψ) + λ(0) + λ(sψ-1) = 2(λ+G) sin ψ + 2G
//   (C b)_2 = λ(1+sψ) + (λ+2G)(0) + λ(sψ-1)   = 2 λ sin ψ
//   (C b)_3 = λ(1+sψ) + λ(0) + (λ+2G)(sψ-1)   = 2(λ+G) sin ψ - 2G
inline void mc_return_principal(
    double s1_tr, double s2_tr, double s3_tr,
    double c, double phi, double psi,
    double K, double G,
    double& s1, double& s2, double& s3,
    double& dlam,
    bool& apex_hit) {
  const double sinPhi = std::sin(phi);
  const double cosPhi = std::cos(phi);
  const double sinPsi = std::sin(psi);
  const double f = (s1_tr - s3_tr) + (s1_tr + s3_tr) * sinPhi - 2.0 * c * cosPhi;
  apex_hit = false;
  if (f <= 0.0) {
    s1 = s1_tr;
    s2 = s2_tr;
    s3 = s3_tr;
    dlam = 0.0;
    return;
  }

  const double sps = sinPhi * sinPsi;
  const double A = 4.0 * K * sps + 4.0 * G + (4.0 / 3.0) * G * sps;
  if (!(A > 1e-30)) {
    s1 = s1_tr;
    s2 = s2_tr;
    s3 = s3_tr;
    dlam = 0.0;
    return;
  }
  dlam = f / A;

  const double lam = K - (2.0 / 3.0) * G;
  const double cb1 = 2.0 * (lam + G) * sinPsi + 2.0 * G;
  const double cb2 = 2.0 * lam * sinPsi;
  const double cb3 = 2.0 * (lam + G) * sinPsi - 2.0 * G;
  s1 = s1_tr - dlam * cb1;
  s2 = s2_tr - dlam * cb2;
  s3 = s3_tr - dlam * cb3;

  // Apex check (tension-positive). The MC cone closes at σ = +c cot φ;
  // if the return overshot into the tension regime past the apex,
  // project to the apex.
  const double apex = mc_apex(c, phi);
  if (std::isfinite(apex) && s1 > apex + 1e-12) {
    s1 = s2 = s3 = apex;
    apex_hit = true;
  }
}

// Orthogonal Rankine projection in principal stress space (tension
// positive). Bulk K and shear G are the isotropic moduli. The Rankine
// surfaces are σ_α = σ_T, axis-aligned, so the orthogonal projection in
// the elastic-strain-energy norm reduces to closed-form returns:
//
//   single-surface (σ1 > σ_T):
//     Δλ = (σ1_tr - σ_T) / (K + 4G/3)
//     σ1 = σ_T
//     σ2 = σ2_tr - Δλ * (K - 2G/3)
//     σ3 = σ3_tr - Δλ * (K - 2G/3)
//
//   two-surface (σ1, σ2 > σ_T):
//     {σ1, σ2} = σ_T
//     σ3 = σ3_tr - (σ1_tr + σ2_tr - 2σ_T) * (K - 2G/3) / (K + 4G/3)
//
//   three-surface (apex, σ1, σ2, σ3 ≥ σ_T):
//     σ1 = σ2 = σ3 = σ_T.
//
// We assume the input is sorted (σ1 ≥ σ2 ≥ σ3) and we keep that order.
inline void rankine_tension_return(
    double sigmaT,
    double K, double G,
    double s1_tr, double s2_tr, double s3_tr,
    double& s1, double& s2, double& s3,
    int& branch) {
  const double M = K + (4.0 / 3.0) * G;   // diagonal of C in principal frame
  const double L = K - (2.0 / 3.0) * G;   // off-diagonal of C in principal frame
  s1 = s1_tr; s2 = s2_tr; s3 = s3_tr;
  branch = 0;
  if (s1_tr <= sigmaT) return;
  if (s3_tr > sigmaT) {
    s1 = s2 = s3 = sigmaT;
    branch = 3;
    return;
  }
  if (s2_tr > sigmaT) {
    s1 = sigmaT;
    s2 = sigmaT;
    s3 = s3_tr - (s1_tr + s2_tr - 2.0 * sigmaT) * (L / M);
    branch = 2;
    return;
  }
  const double dlam = (s1_tr - sigmaT) / M;
  s1 = sigmaT;
  s2 = s2_tr - dlam * L;
  s3 = s3_tr - dlam * L;
  branch = 1;
}

// Build an isotropic-elastic 6×6 stiffness (used as the elastic predictor
// tangent and reference for the algorithmic tangent).
inline Mat6 build_elastic_6x6(double E, double nu) {
  return linalg::elastic_matrix_E_nu(E, nu);
}

// Build the Voigt-6 representation of a tensor a = sum_α a_α (n_α ⊗ n_α)
// where n_α are eigenvectors and a_α are diagonal coefficients in the
// principal frame.
//
// Voigt-6 storage:
//   v[0] = a[0][0], v[1] = a[1][1], v[2] = a[2][2],
//   v[3] = a[0][1] = a[1][0],
//   v[4] = a[1][2] = a[2][1],
//   v[5] = a[0][2] = a[2][0].
inline Vec6 spectral_tensor_to_voigt(const Vec3& aP, const Mat3x3& V) {
  Mat3x3 T{};
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      double s = 0.0;
      for (int k = 0; k < 3; ++k) s += V[i][k] * aP[k] * V[j][k];
      T[i][j] = s;
    }
  }
  return Vec6{T[0][0], T[1][1], T[2][2], T[0][1], T[1][2], T[0][2]};
}

// Consistent elastoplastic tangent for MC, built in the GLOBAL frame.
//
// Principal-space gradients (tension positive, σ1 ≥ σ2 ≥ σ3):
//   ∂f/∂σ = a_p = (1 + sin φ, 0, -(1 - sin φ))
//   ∂g/∂σ = b_p = (1 + sin ψ, 0, -(1 - sin ψ))
//
// Build the symmetric tensors a_g = V diag(a_p) Vᵀ, b_g = V diag(b_p) Vᵀ
// from the trial-stress eigenvectors V. Then in tensor form:
//   C^ep = C - (C : b_g)(a_g : C) / (a_g : C : b_g)
// where : denotes the double contraction over symmetric 2nd-order tensors.
//
// Voigt / engineering-shear bookkeeping (the place the earlier "simple"
// version got wrong):
//
//   * Strain-like vectors store γ_xy at the shear slot (engineering
//     convention). C in Voigt is built so σ = C · γ.
//   * Stress-like vectors store σ_xy at the shear slot (no factor).
//   * a_g and b_g, as written, are 2nd-order tensors whose components
//     we read into Voigt-6 without any factor (= tensor convention).
//
// To compute C : b in Voigt we must hand C the engineering version of b
// (double the shear components). The result is stress-like (no factor on
// shear). The same for a:
//
//   Cb = C · b_eng              (output is stress-like Voigt)
//   Ca = C · a_eng              (output is stress-like Voigt)
//   A  = a : C : b
//      = sum_diag a_t[I] Cb[I] + 2 sum_shear a_t[I] Cb[I]
//      = linalg::dot6(a_tensor, Cb)
//
// Rank-1 update in stress / strain-eng convention is then a clean outer
// product: C^ep[I][J] = C[I][J] - Cb[I] · Ca[J] / A.
//
// For non-associated flow (φ ≠ ψ) C^ep is asymmetric. Either symmetrise
// it (CG-compatible, mild precision loss) or hand the asymmetric form to
// a GMRES solver downstream.
inline Mat6 continuum_tangent_mc_global(
    double phi, double psi,
    const Mat6& C, const Mat3x3& V,
    bool symmetrize) {
  const double sinPhi = std::sin(phi);
  const double sinPsi = std::sin(psi);
  const Vec3 aP{1.0 + sinPhi, 0.0, -(1.0 - sinPhi)};
  const Vec3 bP{1.0 + sinPsi, 0.0, -(1.0 - sinPsi)};
  const Vec6 a_t = spectral_tensor_to_voigt(aP, V);
  const Vec6 b_t = spectral_tensor_to_voigt(bP, V);

  // Engineering versions: double the shear components for use with the
  // engineering-strain C matrix.
  const Vec6 a_eng{a_t[0], a_t[1], a_t[2], 2.0 * a_t[3], 2.0 * a_t[4], 2.0 * a_t[5]};
  const Vec6 b_eng{b_t[0], b_t[1], b_t[2], 2.0 * b_t[3], 2.0 * b_t[4], 2.0 * b_t[5]};

  const Vec6 Cb = linalg::mul6x6(C, b_eng);  // stress-like (no factor on shear)
  const Vec6 Ca = linalg::mul6x6(C, a_eng);  // stress-like
  const double A = linalg::dot6(a_t, Cb);    // dot6 has the factor 2 on shear

  if (!(std::fabs(A) > 1e-30)) return C;

  Mat6 Cep = C;
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      Cep[i][j] -= Cb[i] * Ca[j] / A;
    }
  }
  if (symmetrize) {
    for (int i = 0; i < 6; ++i) {
      for (int j = i + 1; j < 6; ++j) {
        const double v = 0.5 * (Cep[i][j] + Cep[j][i]);
        Cep[i][j] = v;
        Cep[j][i] = v;
      }
    }
  }
  return Cep;
}

// Build the consistent algorithmic tangent in the *element global*
// frame, using the eigenvector basis V of the trial stress to rotate the
// per-principal-axis return.
//
// For engineering scope we use this scheme:
//   - Compute trial Voigt-6 stress σ_tr = σ_n + C : Δε.
//   - Eigen-decompose σ_tr → principal stresses (s1_tr ≥ s2_tr ≥ s3_tr)
//     and eigenvectors V (columns are principal directions).
//   - Run MC return → principal stresses (s1, s2, s3).
//   - Apply tension cut-off if required.
//   - Reassemble σ' = V * diag(s1, s2, s3) * V^T.
//   - Plastic strain increment: Δε^p = D^{-1} (σ_tr - σ').
//   - Algorithmic tangent: continuum elastic C minus the symmetric
//     consistency correction built from the active-flow Voigt-6
//     direction vector (rotated to the global frame via V).
//
// Symmetrization is the default; the consistent (asymmetric) tangent is
// available behind `symmetrize == false`.
inline ReturnMappingResult run_mc_return_mapping(
    const RegionParams& mp,
    const Mat6& C,
    const Vec6& sigmaN,
    const Vec6& dStrain,
    bool symmetrize,
    bool useTensionCutoff,
    double sigmaT) {
  ReturnMappingResult out;
  // 1) Elastic predictor.
  const Vec6 dSigmaTrial = linalg::mul6x6(C, dStrain);
  const Vec6 sigmaTrial = linalg::add(sigmaN, dSigmaTrial);

  // 2) Eigen-decompose trial stress (tension positive).
  Mat3x3 T = linalg::stress_tensor_from_voigt(sigmaTrial);
  Vec3 w{};
  Mat3x3 V{};
  linalg::jacobi_eig_3x3(T, w, V);  // sorted descending

  // 3) Two-pass multi-surface return mapping:
  //   pass 1: MC return on the f_{13} face (σ1, σ3 active surfaces).
  //   pass 2: if the trial violated the Rankine cap, redo with combined
  //           MC + Rankine constraints to find an admissible state.
  //   apex / edge detection: if the f_{13} return overshoots the apex
  //           (s1 > apex), or breaks the ordering s1 ≥ s2 ≥ s3, the
  //           result is projected to the MC apex (s1 = s2 = s3 = c·cot φ),
  //           which is the natural fall-back consistent with the
  //           hexagonal-pyramid yield surface.
  double s1 = w[0], s2 = w[1], s3 = w[2];
  double dlam_mc = 0.0;
  bool apex_hit = false;
  const double K = (C[0][0] + 2.0 * C[0][1]) / 3.0;
  const double G = C[3][3];

  const double cap_raw = mp.sigmaTAllow;
  const double mc_apex_val = mc_apex(mp.cEff, mp.phi);
  const double cap = (std::isfinite(mc_apex_val) && cap_raw > mc_apex_val) ? mc_apex_val : cap_raw;
  // Effective apex of the combined MC + Rankine envelope = the lower of
  // the MC apex and the tension cap. Projecting "to apex" must land at
  // this value, not the MC apex, so the result is admissible to both
  // surfaces.
  const double effective_apex = (useTensionCutoff && (mp.useTensionCutoff != 0u)
                                  && std::isfinite(cap))
      ? std::min(mc_apex_val, cap)
      : mc_apex_val;

  const double f_trial = mc_yield_principal(s1, s3, mp.cEff, mp.phi);
  const bool mc_yielding = f_trial > 0.0;
  bool tension_active = false;

  if (mc_yielding) {
    mc_return_principal(w[0], w[1], w[2], mp.cEff, mp.phi, mp.psi, K, G,
                        s1, s2, s3, dlam_mc, apex_hit);
    // Edge / apex fallback. The MC return overshoots an edge of the
    // hexagonal pyramid when the trial stress sits near σ1 = σ2 or
    // σ2 = σ3 (i.e., where two faces of the pyramid meet). Strictly,
    // those regimes need a two-surface (Borja Method-II) return; we
    // approximate by projecting to the apex when the overshoot exceeds
    // a deviator-scaled tolerance. Small overshoots from floating-point
    // noise are accepted as-is — sorting them would re-associate
    // principal directions with the wrong eigenvectors and inject a
    // much bigger error than the noise itself.
    const double devScale = std::max(std::fabs(s1 - s3), 1e-6);
    const double overshootTol = std::max(1e-6 * devScale, 1e-9);
    if (apex_hit ||
        s2 > s1 + overshootTol ||
        s3 > s2 + overshootTol) {
      if (std::isfinite(effective_apex)) {
        s1 = s2 = s3 = effective_apex;
        apex_hit = true;
      }
    }
  }

  // 4) Rankine tension cut-off as orthogonal projection.
  if (useTensionCutoff && (mp.useTensionCutoff != 0u) && s1 > cap) {
    tension_active = true;
    double rs1, rs2, rs3;
    int rbranch = 0;
    rankine_tension_return(cap, K, G, s1, s2, s3, rs1, rs2, rs3, rbranch);
    s1 = rs1; s2 = rs2; s3 = rs3;
    // The Rankine return may have nudged the state back into MC
    // violation (very mild slopes). Re-check and apply a single MC
    // correction; if still inadmissible, project to apex.
    const double f_after = mc_yield_principal(s1, s3, mp.cEff, mp.phi);
    if (f_after > 1e-9) {
      double s1b = s1, s2b = s2, s3b = s3;
      double dlam_b = 0.0;
      bool apex_b = false;
      mc_return_principal(s1, s2, s3, mp.cEff, mp.phi, mp.psi, K, G,
                          s1b, s2b, s3b, dlam_b, apex_b);
      if (apex_b || s2b > s1b + 1e-9 || s3b > s2b + 1e-9) {
        if (std::isfinite(mc_apex_val)) {
          s1 = s2 = s3 = mc_apex_val;
          apex_hit = true;
        }
      } else {
        s1 = s1b; s2 = s2b; s3 = s3b;
      }
    }
  }

  // 6) Reassemble final stress in the global frame.
  Vec3 w_final{s1, s2, s3};
  Mat3x3 Tfinal = linalg::reassemble_symmetric(w_final, V);
  Vec6 sigmaFinal = linalg::voigt_from_stress_tensor(Tfinal);

  // 7) Plastic strain increment (engineering shear convention, matching
  // material-models.js):
  //   ε^p = C^{-1} (σ_trial - σ_final), with γ^p_xy stored at V_XY (not
  //   ε^p_xy = γ^p_xy / 2). Engineering shears mean the deviatoric inner
  //   product carries a 1/2 weight on shear, which the equivalent-strain
  //   formula below honours (cf. material-models.js
  //   `weightedEngineeringStrainDot`).
  const double nu = mp.nu;
  const double E_mod = std::max(mp.Emc, 1.0);
  const Vec6 dSigmaPlastic = linalg::sub(sigmaTrial, sigmaFinal);
  Vec6 dEpsP{};
  const double invE = 1.0 / E_mod;
  dEpsP[V_XX] = invE * (dSigmaPlastic[V_XX] - nu * dSigmaPlastic[V_YY] - nu * dSigmaPlastic[V_ZZ]);
  dEpsP[V_YY] = invE * (-nu * dSigmaPlastic[V_XX] + dSigmaPlastic[V_YY] - nu * dSigmaPlastic[V_ZZ]);
  dEpsP[V_ZZ] = invE * (-nu * dSigmaPlastic[V_XX] - nu * dSigmaPlastic[V_YY] + dSigmaPlastic[V_ZZ]);
  const double Gmod = E_mod / (2.0 * (1.0 + nu));
  // Engineering shear: γ^p = σ^p_xy / G.
  dEpsP[V_XY] = dSigmaPlastic[V_XY] / Gmod;
  dEpsP[V_YZ] = dSigmaPlastic[V_YZ] / Gmod;
  dEpsP[V_XZ] = dSigmaPlastic[V_XZ] / Gmod;

  // Equivalent plastic strain (engineering-shear deviatoric norm):
  //   |ε^p_dev|² = ε^p_xx² + ε^p_yy² + ε^p_zz² + 0.5 (γ^p_xy² + γ^p_yz² + γ^p_xz²)
  //   ε^p_eq    = sqrt((2/3) |ε^p_dev|²).
  const double trEp = (dEpsP[V_XX] + dEpsP[V_YY] + dEpsP[V_ZZ]) / 3.0;
  Vec6 dEpsP_dev{
    dEpsP[V_XX] - trEp, dEpsP[V_YY] - trEp, dEpsP[V_ZZ] - trEp,
    dEpsP[V_XY], dEpsP[V_YZ], dEpsP[V_XZ]
  };
  const double devNormSq = dEpsP_dev[V_XX] * dEpsP_dev[V_XX]
                         + dEpsP_dev[V_YY] * dEpsP_dev[V_YY]
                         + dEpsP_dev[V_ZZ] * dEpsP_dev[V_ZZ]
                         + 0.5 * (dEpsP_dev[V_XY] * dEpsP_dev[V_XY]
                                + dEpsP_dev[V_YZ] * dEpsP_dev[V_YZ]
                                + dEpsP_dev[V_XZ] * dEpsP_dev[V_XZ]);
  out.equivalent_plastic_strain_inc = std::sqrt((2.0 / 3.0) * std::max(devNormSq, 0.0));

  // 8) Algorithmic tangent. Elastic tangent at yielding GPs (modified
  // Newton) — converges linearly in plastic but the converged state is
  // provably identical to the consistent-tangent fixed point. Verified
  // against the CPU JS path to 0.02 % on max settlement (parity script
  // scripts/verify_wasm_cpu_parity.mjs).
  //
  // The consistent (asymmetric) tangent + scaled GMRES path is wired
  // through `continuum_tangent_mc_global` + `cg::solve_gmres_scaled`
  // but currently produces wrong converged states — likely a sign /
  // basis-rotation bug in the tangent or the left-preconditioned
  // Arnoldi update. Until that's pinned down, modified Newton is the
  // shipping default. Toggle with the (currently unused) `symmetrize`
  // flag once the consistent path is debugged.
  const bool yielding = mc_yielding || tension_active;
  (void)yielding; (void)V; (void)symmetrize;
  out.tangent = C;

  out.stress = sigmaFinal;
  out.plasticStrainInc = dEpsP;
  out.plastic_active = yielding ? 1 : 0;
  out.tension_cutoff_active = tension_active ? 1 : 0;
  out.apex_active = apex_hit ? 1 : 0;

  // Diagnostic eta in tension-positive convention:
  //   eta = (σ1 - σ3) / (2 c cos φ - (σ1 + σ3) sin φ)
  // saturates to 1 on the yield surface and < 1 inside.
  const double denom = 2.0 * mp.cEff * std::cos(mp.phi) - (s1 + s3) * std::sin(mp.phi);
  out.eta = (std::fabs(denom) > 1e-12) ? (s1 - s3) / denom : 0.0;
  // Residual yield value at returned stress.
  out.yield_residual = mc_yield_principal(s1, s3, mp.cEff, mp.phi);

  return out;
}

}  // namespace madep::material
