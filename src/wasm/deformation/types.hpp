// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared data structures for the deformation WASM solver.
//
// Layout: pure POD where possible so callers (JS bridge) can stitch
// inputs/outputs together as flat Float64 / Int32 buffers. The "binary
// contract" enforced by deformation_wasm.cpp lives in this file.

#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstddef>
#include <vector>

namespace madep {

// Element family: 3-node linear or 6-node quadratic triangle.
enum class ElementKind : std::uint8_t {
  T3 = 3,
  T6 = 6
};

// Constitutive model: linear elastic (no plasticity), MC with reduced
// stiffness (Stage 1), or full elastoplastic MC return mapping (Stage 2).
enum class ConstitutiveKind : std::uint8_t {
  LinearElastic = 0,
  McReducedStiffness = 1,
  McPlastic = 2
};

// Analysis mode — picked by the user via the UI / options bundle.
//   ServiceOnly:           gravity-ramp from σ = 0; one Newton pass.
//   GeostaticPlusService:  K0 seed → plastic geostatic equilibration →
//                          service-load increment.
//   GeostaticServiceSafety: as above, plus c-φ strength reduction with
//                          bisection-style bracketing at the end.
enum class AnalysisMode : std::uint8_t {
  ServiceOnly = 0,
  GeostaticPlusService = 1,
  GeostaticServiceSafety = 2
};

// Boundary condition flags per node DOF. The CPU solver locks Ux on the
// side boundaries and Uy on the base; we pass an explicit list of fixed
// DOF indices so the WASM module is agnostic to how the BCs were derived.
constexpr std::uint8_t BC_FIX_UX = 1u << 0;
constexpr std::uint8_t BC_FIX_UY = 1u << 1;

// Per-region material parameters. The JS bridge prepares one of these
// entries for every active region in the mesh and feeds them in via the
// "regionParams" buffer. Units: stresses in kPa, angles in radians,
// unit weights in kN/m³.
struct RegionParams {
  double Emc{ 0.0 };          // Young modulus
  double nu{ 0.3 };           // Poisson ratio
  double cEff{ 0.0 };         // effective cohesion
  double phi{ 0.0 };          // friction angle (rad)
  double psi{ 0.0 };          // dilation angle (rad)
  double K0nc{ 0.5 };         // at-rest earth pressure coefficient
  double gamma{ 18.0 };       // bulk unit weight above water
  double gammaSat{ 20.0 };    // saturated unit weight
  double sigmaTAllow{ 0.0 };  // tension cut-off (kPa, positive = allowed tension)
  double rShear{ 0.25 };      // MC reduced-stiffness shear multiplier
  std::uint8_t useTensionCutoff{ 1 };  // 1 = active, 0 = disabled
  std::uint8_t symmetrize{ 0 };        // 1 = symmetrize Ep tangent → CG ok
  std::uint8_t pad0{ 0 };
  std::uint8_t pad1{ 0 };
};

// Convert a c-φ-style strength reduction factor (ΣMsf) into a reduced
// RegionParams suitable for the safety phase. Replicates
// reduceMaterialStrengthForSafety in material.js: c is divided by SMR,
// tan φ and tan ψ are divided by SMR, ψ is clamped at φ_reduced, and the
// tension cut-off is reduced proportionally but capped at c/tan φ.
inline RegionParams reduce_strength(const RegionParams& base, double sigmaMsf) {
  RegionParams reduced = base;
  const double smr = std::max(sigmaMsf, 1.0);
  const double tanPhi = std::tan(base.phi) / smr;
  const double tanPsi = std::tan(base.psi) / smr;
  reduced.cEff = base.cEff / smr;
  reduced.phi = std::atan(std::max(tanPhi, 0.0));
  const double psiClamped = std::atan(std::max(tanPsi, 0.0));
  reduced.psi = std::min(psiClamped, reduced.phi);
  // Original cap: σ_T <= c / tan φ on the base parameters.
  double sigmaTCap = (std::tan(base.phi) > 1e-12) ? base.cEff / std::tan(base.phi) : 1e18;
  double sigmaTBase = std::min(base.sigmaTAllow, sigmaTCap);
  reduced.sigmaTAllow = sigmaTBase / smr;
  return reduced;
}

// 2D node coordinate.
struct Node {
  double x{ 0.0 };
  double y{ 0.0 };
};

// Compressed Sparse Row format.
// rowPtr: size nrows + 1
// colIdx: size nnz
// values: size nnz
struct CsrMatrix {
  std::int32_t nrows{ 0 };
  std::vector<std::int32_t> rowPtr;
  std::vector<std::int32_t> colIdx;
  std::vector<double> values;

  inline void clear_values() {
    std::fill(values.begin(), values.end(), 0.0);
  }
};

// Local Gauss point data on an element. For T3 there is exactly one,
// for T6 there are three. The B matrix is 3×(2*nNodes).
struct GaussPoint {
  double x{ 0.0 };
  double y{ 0.0 };
  double weight_det_j{ 0.0 };  // gp.weight * det(J), so integral = sum(weight_det_j * f)
  std::array<std::array<double, 12>, 3> B{};  // up to T6 (12 cols)
};

// Stress and strain in Voigt-3D order:
//   index 0 = xx, 1 = yy, 2 = zz, 3 = xy, 4 = yz, 5 = xz.
// Plane strain implies γ_yz = γ_xz = ε_yz = ε_xz = 0 and ε_zz = 0 always.
// Sign convention: tension-positive.

inline constexpr std::size_t V_XX = 0;
inline constexpr std::size_t V_YY = 1;
inline constexpr std::size_t V_ZZ = 2;
inline constexpr std::size_t V_XY = 3;
inline constexpr std::size_t V_YZ = 4;
inline constexpr std::size_t V_XZ = 5;

using Vec6 = std::array<double, 6>;
using Mat6 = std::array<std::array<double, 6>, 6>;
using Mat3x3 = std::array<std::array<double, 3>, 3>;
using Vec3 = std::array<double, 3>;

// Material point state at a Gauss point.
struct MaterialPoint {
  // The JS `referenceState.effectiveStress6`: initially the K0 seed, then
  // overwritten with the equilibrated geostatic state once the plastic
  // initial phase converges.
  Vec6 referenceStress{};

  // Pore pressure at the integration point. Hydrostatic from the
  // phreatic line by default; from the seepage solver if
  // `useSeepagePorePressures` is enabled. Constant within an analysis run.
  double porePressure{ 0.0 };

  // Committed state — the converged state at the end of the most
  // recently accepted load step. Newton iterations work against this.
  Vec6 totalStrain{};       // ε (full)
  Vec6 plasticStrain{};     // ε^p
  Vec6 effectiveStress{};   // σ' (tension positive)

  double accumulatedPlasticStrain{ 0.0 };
  double etaMcCurrent{ 0.0 };
  double etaMcMax{ 0.0 };

  // State snapshot captured at the end of the geostatic phase. Used by
  // the result builder to subtract the geostatic baseline from the
  // service result so consumers see the service-induced increment only.
  Vec6 geostaticEffectiveStress{};
  Vec6 geostaticTotalStrain{};
  Vec6 geostaticPlasticStrain{};
  double geostaticAccumulatedPlasticStrain{ 0.0 };

  std::int32_t regionIndex{ -1 };
  std::uint8_t plasticActive{ 0 };
  std::uint8_t plasticEverActive{ 0 };
  std::uint8_t tensionCutoffActive{ 0 };
  // JS localReturnMode: 0 = elastic, 1 = exact-active-set,
  // 2 = smooth-fallback. Runtime-only continuation state.
  std::uint8_t localReturnMode{ 0 };

  // Rich active-set state. Matches the fields the JS createMaterialPointState
  // populates and that solveExactMcActiveSetReturn consumes as
  // committedState / previousTrialState. Runtime-only — not in wire
  // format v3; runtime-only fields are derived during the solve.
  std::uint8_t exactBranchKind{ 0 };       // mc_exact::BranchKind code
  std::uint8_t multiplicityKind{ 0 };      // mc_exact::MultiplicityKind code
  std::uint8_t hasRepresentativeProjectors{ 0 };
  std::uint8_t currentlyMcActive{ 0 };
  std::uint8_t localFallbackUsed{ 0 };
  std::array<std::array<double, 3>, 3> repP1{};
  std::array<std::array<double, 3>, 3> repP2{};
  std::array<std::array<double, 3>, 3> repP3{};
};

// Element-level cached data (precomputed once at startup).
struct ElementCache {
  std::int32_t elementIndex{ 0 };
  std::int32_t cellIndex{ 0 };
  std::int32_t regionIndex{ 0 };
  ElementKind kind{ ElementKind::T3 };
  std::int32_t numNodes{ 3 };
  std::int32_t numDofs{ 6 };
  std::int32_t numGp{ 1 };
  double area{ 0.0 };
  // up to T6 → 6 node indices; for T3 only the first three are valid.
  std::array<std::int32_t, 6> nodeIds{};
  // up to 12 DOF indices.
  std::array<std::int32_t, 12> dofs{};
  // Gauss points: up to 3 for T6.
  std::array<GaussPoint, 3> gp{};
  // Material point indices into the global material-point array.
  std::array<std::int32_t, 3> mpIdx{};
  // Pre-baked node coordinates for the corner nodes (used by stress recovery).
  std::array<Node, 6> nodes{};
};

// Run-time options forwarded from JS.
struct SolverOptions {
  ConstitutiveKind constitutive{ ConstitutiveKind::McPlastic };
  ElementKind elementKind{ ElementKind::T3 };
  AnalysisMode analysisMode{ AnalysisMode::GeostaticPlusService };
  std::uint8_t hasSurfaceLoad{ 0 };
  std::uint8_t useTensionCutoff{ 1 };
  std::uint8_t symmetrizeTangent{ 0 };
  std::uint8_t enableLoadStepping{ 1 };
  std::uint8_t bbarForT6{ 1 };
  std::uint8_t pad0{ 0 };
  std::uint8_t pad1{ 0 };
  std::uint8_t pad2{ 0 };
  std::int32_t nonlinearMaxIter{ 32 };
  std::int32_t maxLoadSteps{ 256 };
  double initialLoadStep{ 0.25 };
  double minLoadStep{ 1.0 / 2048.0 };
  double loadStepGrowthFactor{ 1.25 };
  double loadStepCutbackFactor{ 0.5 };
  double plasticLoadStepGrowthFactor{ 1.05 };
  double plasticLoadStepCutbackFactor{ 0.4 };
  double initialGravityPlasticLoadStepGrowthFactor{ 1.12 };
  double initialGravityPlasticLoadStepCutbackFactor{ 0.5 };
  double residualRelTol{ 1e-4 };
  double residualAbsTol{ 1e-3 };
  double displacementRelTol{ 1e-5 };
  double displacementAbsTol{ 1e-8 };
  std::int32_t cgMaxIter{ 25000 };
  double cgRelTol{ 1e-5 };
  double cgAbsTol{ 5e-5 };
  double plasticLineSearchReductionFactor{ 0.5 };
  double plasticLineSearchMinScale{ 1.0 / 64.0 };
  double initialGravityPlasticLineSearchMinScale{ 1.0 / 32.0 };
  double plasticLineSearchArmijoCoefficient{ 1e-4 };
  std::int32_t plasticLineSearchMaxBacktracks{ 4 };
  std::int32_t initialGravityPlasticLineSearchMaxBacktracks{ 5 };
  // c-φ safety parameters
  double safetyInitialIncrement{ 0.1 };
  double safetyGrowthFactor{ 1.5 };
  double safetyCutbackFactor{ 0.5 };
  double safetySigmaMax{ 3.0 };
  double safetyBracketTolerance{ 0.01 };
  std::int32_t safetyMaxSearchTrials{ 32 };
};

// One safety c-φ trial record.
struct SafetyTrial {
  double sigmaMsfTarget{ 1.0 };
  double sigmaMsfCommitted{ 1.0 };
  std::uint8_t converged{ 0 };
  std::uint8_t pad[7]{};
  std::int32_t iterations{ 0 };
};

// Safety analysis output.
struct SafetyResult {
  std::uint8_t status{ 0 };    // 0=not run, 1=bracketed, 2=mechanism, 3=no-failure-found
  std::uint8_t pad[7]{};
  double factorOfSafetyLower{ 1.0 };
  double factorOfSafetyUpper{ 1.0 };
  double strengthRetained{ 1.0 };
  std::int32_t trialCount{ 0 };
  std::int32_t totalNewtonIterations{ 0 };
  std::vector<SafetyTrial> trials;
};

// Summary stats returned with the result.
struct RunSummary {
  std::int32_t loadStepsAccepted{ 0 };
  std::int32_t loadStepsRejected{ 0 };
  std::int32_t newtonIterations{ 0 };
  std::int32_t cgIterations{ 0 };
  std::int32_t finalActiveCount{ 0 };
  std::int32_t finalTensionCount{ 0 };
  std::int32_t geostaticAccepted{ 0 };
  std::int32_t geostaticRejected{ 0 };
  std::int32_t serviceAccepted{ 0 };
  std::int32_t serviceRejected{ 0 };
  double finalLoadFactor{ 0.0 };
  double geostaticLoadFactor{ 0.0 };
  double residualNorm{ 0.0 };
  double maxEta{ 0.0 };
  double elapsed_ms{ 0.0 };
  std::uint8_t geostaticConverged{ 0 };
  std::uint8_t serviceConverged{ 0 };
  std::uint8_t safetyRan{ 0 };
  std::uint8_t pad[5]{};
};

}  // namespace madep
