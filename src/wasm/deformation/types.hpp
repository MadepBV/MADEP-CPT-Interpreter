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
// stiffness (Stage 1), full elastoplastic MC return mapping (Stage 2),
// or Hardening Soil (WASM-only; implemented incrementally).
enum class ConstitutiveKind : std::uint8_t {
  LinearElastic = 0,
  McReducedStiffness = 1,
  McPlastic = 2,
  HardeningSoil = 3
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

enum class RequestedContinuationMode : std::uint8_t {
  LoadControl = 0,
  StrengthControl = 1,
  ArcLength = 2,
  Auto = 3
};

enum class ActualContinuationMode : std::uint8_t {
  LoadControl = 0,
  StrengthControl = 1,
  ArcLength = 2
};

enum class ArcLengthDerivativeMode : std::uint8_t {
  FiniteDifference = 0,
  Analytic = 1,
  AnalyticVerified = 2
};

enum class ArcLengthMeritMode : std::uint8_t {
  OneNormScaled = 0,
  Quadratic = 1
};

// Workstream B: globalization mode for the Mohr-Coulomb plastic Newton.
//   Default:            current behaviour — Tier-1 modified Newton +
//                       Armijo + adaptive cutback. The Tier-2 rescue is
//                       inert, so the path is byte-identical to HEAD.
//   LmConsistentRescue: enable the Tier-2 Levenberg-Marquardt / trust-region
//                       damped consistent-tangent rescue. It engages ONLY
//                       when Tier-1 has exhausted its cutbacks and the phase
//                       would otherwise abort; converging cases never enter
//                       it, so their telemetry is unchanged.
enum class McGlobalizationMode : std::uint8_t {
  Default = 0,
  LmConsistentRescue = 1
};

// Task #56 Stage C-1 (I-1) — global iteration scheme for staged (wall) MC
// phases.
//   ConsistentNewton: current production behaviour (modified Newton on the
//     per-iteration tangent with Armijo line search, GMRES when unsymmetric).
//   InitialStiffness: the PLAXIS production scheme — constant elastic K_e
//     (soil D_e + interface FULL elastic diag(k_s,k_n) + wall beam) assembled
//     once per phase, all plasticity on the RHS through the unchanged exact
//     return maps, CG-only with the wall preconditioner + coarse correction,
//     PLAXIS compound acceptance (global error vs Active+CSP·Inactive with
//     the L1-of-magnitudes norm, plus the 3+N_plastic/10 local quotas).
// Derived in the wire decoder (stagedExcavationActive && MC-plastic, or the
// forced debug mode) — NOT wire-transmitted; staged runs are WASM-only so
// JS parity is structural.
enum class GlobalScheme : std::uint8_t {
  ConsistentNewton = 0,
  InitialStiffness = 1
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

  // Hardening Soil parameters. These are only read when the global
  // constitutive model is HardeningSoil; non-HS runs keep the fields at
  // their defaults so existing vector copies remain branch-free.
  struct HsParams {
    double E50_ref{ 0.0 };
    double Eoed_ref{ 0.0 };
    double Eur_ref{ 0.0 };
    double m{ 0.5 };
    double nu_ur{ 0.2 };
    double p_ref{ 100.0 };
    double Rf{ 0.9 };
    double K0_nc{ 0.0 };
    double e_init{ -1.0 };
    double e_max{ -1.0 };
    double OCR{ 1.0 };
    // Optional engineer-controlled minimum compression-positive confining
    // stress for near-surface HS points. Zero disables modelling
    // regularization; the constitutive update still keeps tiny numerical
    // denominator guards internally.
    double nearSurfaceMinConfiningStress{ 0.0 };
    double useConsistentTangent{ 0.0 };
    double M_cap{ 0.0 };
    double sin_phi_cv{ 0.0 };
    double H_cap{ 0.0 };
  } hs;
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
  // MC-SH tangent mode: 0 = elastic/modified Newton, 1 = exact continuum
  // tangent. Runtime-only; exposed through an existing GP output pad byte.
  std::uint8_t mcTangentMode{ 0 };
  std::array<std::array<double, 3>, 3> repP1{};
  std::array<std::array<double, 3>, 3> repP2{};
  std::array<std::array<double, 3>, 3> repP3{};

  struct HsState {
    double gamma_p{ 0.0 };
    double p_p{ 0.0 };
    double eps_v_p{ 0.0 };
    std::uint8_t lastActiveSet{ 0 };
    std::uint8_t tangentMode{ 0 };
  } hs;
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

struct WallStation {
  std::int32_t nodeId{ -1 };
  std::int32_t rotationDof{ -1 };
  double s{ 0.0 };
};

struct WallBeam {
  std::int32_t wallIndex{ -1 };
  std::int32_t passiveSign{ 1 };
  double EA{ 0.0 };
  double EI{ 0.0 };
  double GA{ 0.0 };
  double kappa{ 1.0 };
  std::vector<WallStation> stations{};
};

struct BeamElementCache {
  std::int32_t wallIndex{ -1 };
  std::int32_t stationA{ -1 };
  std::int32_t stationB{ -1 };
  std::int32_t nodeA{ -1 };
  std::int32_t nodeB{ -1 };
  std::array<std::int32_t, 6> dofs{};
  double xA{ 0.0 };
  double yA{ 0.0 };
  double xB{ 0.0 };
  double yB{ 0.0 };
  double length{ 0.0 };
  double EA{ 0.0 };
  double EI{ 0.0 };
  double GA{ 0.0 };
  double kappa{ 1.0 };
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
  std::uint8_t robustNonlinearMode{ 0 };
  // Workstream A: wall rigid-body two-level coarse correction. Preconditioning
  // only — never changes the converged solution. Decoded from a reserved wire
  // header byte.
  std::uint8_t useWallCoarseCorrection{ 0 };
  // Staged construction (model C — excavation by stress relaxation). Decoded
  // from a reserved wire header byte; default 0 keeps the legacy single-phase
  // wall-free geostatic path byte-identical. When 1 AND a mechanical wall is
  // present AND the model is MC-plastic, the in-situ K0 state is held supported
  // (the wall is wished-in-place at zero load) and the cut-face support is then
  // relaxed in a wall-active Excavation phase, so the wall carries the cut.
  std::uint8_t stagedExcavationActive{ 0 };
  // Workstream B: Tier-2 LM-damped consistent-tangent rescue gate. Decoded
  // from a reserved wire header byte. Default keeps the rescue inert.
  McGlobalizationMode mcGlobalizationMode{ McGlobalizationMode::Default };
  RequestedContinuationMode requestedContinuationMode{ RequestedContinuationMode::Auto };
  ArcLengthDerivativeMode arcLengthDerivativeMode{ ArcLengthDerivativeMode::FiniteDifference };
  ArcLengthMeritMode arcLengthMeritMode{ ArcLengthMeritMode::OneNormScaled };
  std::int32_t nonlinearMaxIter{ 32 };
  std::int32_t maxLoadSteps{ 384 };
  double initialLoadStep{ 0.25 };
  double minLoadStep{ 1.0 / 4096.0 };
  double loadStepGrowthFactor{ 1.25 };
  double loadStepCutbackFactor{ 0.5 };
  double plasticLoadStepGrowthFactor{ 1.08 };
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
  std::int32_t plasticLineSearchMaxBacktracks{ 6 };
  std::int32_t initialGravityPlasticLineSearchMaxBacktracks{ 5 };
  // c-φ safety parameters
  double safetyInitialIncrement{ 0.1 };
  double safetyGrowthFactor{ 1.5 };
  double safetyCutbackFactor{ 0.5 };
  double safetySigmaMax{ 3.0 };
  double safetyBracketTolerance{ 0.01 };
  std::int32_t safetyMaxSearchTrials{ 32 };
  double arcLengthInitialRadius{ 1e-3 };
  double arcLengthMinRadius{ 1e-6 };
  double arcLengthMaxRadius{ 5e-2 };
  double arcLengthGrowthFactor{ 1.2 };
  double arcLengthShrinkFactor{ 0.7 };
  double arcLengthFailureShrinkFactor{ 0.5 };
  double arcLengthTargetIterations{ 6.0 };
  std::int32_t arcLengthMaxRetries{ 6 };
  std::int32_t arcLengthLineSearchMaxBacktracks{ 6 };
  double arcLengthDisplacementScale{ 1.0 };
  double arcLengthInitialRadiusScale{ 1.0 };
  double arcLengthMinRadiusScale{ 1.0 };
  double arcLengthMaxRadiusScale{ 1.0 };
  double arcLengthConstraintToleranceScale{ 1.0 };
  double arcLengthConstraintTolerance{ 1e-8 };
  double arcLengthAlphaMin{ 1e-8 };
  double arcLengthAlphaMax{ 1e8 };
  double arcLengthFiniteDifferenceStepScale{ 1e-5 };
  double arcLengthFiniteDifferenceMinStep{ 1e-7 };
  std::uint8_t arcLengthAllowPostPeakSafetyPath{ 1 };

  // Workstream B — Levenberg-Marquardt / trust-region parameters for the
  // Tier-2 consistent-tangent rescue. These are fixed numerical tuning
  // constants (analogous to the existing hard-coded NONLINEAR_* constants in
  // run_nonlinear_phase) and are mirrored verbatim in solver.js. They are NOT
  // wire-transmitted — only the McGlobalizationMode gate is — so enabling
  // Tier-2 does not require a wire-version bump.
  double lmMu0{ 1e-1 };            // initial damping factor on Tier-2 entry
  double lmGrowth{ 4.0 };          // μ growth on a rejected trial (ρ < accept)
  double lmShrink{ 0.25 };         // μ shrink on a very good trial (ρ > shrink)
  std::int32_t lmMaxTrials{ 6 };   // μ-grow trials before the steepest-descent fallback
  double lmCReg{ 1e-2 };           // residual-proportional μ floor coefficient
  double lmAcceptRatio{ 0.20 };    // trust-region ρ accept threshold
  double lmShrinkRatio{ 0.75 };    // trust-region ρ shrink threshold
  // S = SPD diagonal of the elastically-assembled tangent, floored so it is
  // bounded away from 0 where the perfectly-plastic diagonal collapses:
  // S_ii = max(diag(K_alg)_ii, β·S_elastic_ii). β = 1 makes S ≈ the elastic
  // diagonal everywhere (diag(K_alg)_ii ≤ S_elastic_ii at plastic rows), which
  // is what regularizes the indefinite non-associated tangent for the Krylov
  // solve.
  double lmSFloorBeta{ 1.0 };
  double lmMuMax{ 1e8 };           // μ cap before declaring the trial loop failed
  double lmMuSnapToZero{ 1e-9 };   // μ below this collapses to exactly 0 (pure Newton)
  double lmNewtonZoneResidualFactor{ 1e2 };  // residual ≤ factor·target → drop the μ floor to 0
  std::int32_t lmMaxNewtonItersPerStep{ 200 };  // Newton-iterate cap inside a Tier-2 step
  std::int32_t lmMaxLoadSteps{ 1024 };          // load-step cap for the Tier-2 continuation
  double lmInitialLoadStep{ 0.02 };             // Tier-2 continuation initial Δλ (small; grows)
  // GMRES restart for Tier-2 solves. Larger than the production restart (40) so
  // the indefinite consistent tangent does not stagnate restarted GMRES; this
  // lets a lightly/undamped step converge near the solution so μ → 0.
  std::int32_t lmGmresRestart{ 200 };

  // ---------------------------------------------------------------------------
  // Task #56 Stage-B de-risk experiment switches. RUNTIME-ONLY — set via the
  // madepSetDebugSolverMode export before a run, NEVER wire-transmitted. The
  // default (0) is byte-identical to current behaviour; both modes are
  // diagnostic instruments, not production paths.
  //   debugSolverMode == 1: after a staged/service phase fails, run the CLEAN
  //     fixed-point probe (constant K_e = soil D_e + interface ELASTIC
  //     diag(k_s,k_n) at every station + wall beam; ω = 1.0; CG with the wall
  //     preconditioner + coarse correction) from the stalled display state and
  //     log ‖r‖ / α_m / ε_f per iteration into the diagnostics JSON. The probe
  //     runs on state copies and never alters the returned result.
  //   debugSolverMode == 2: Davis associated bracket — the wire decoder
  //     transforms soil (c*, tanφ* = β·{c, tanφ}, ψ* = φ*,
  //     β = cosψcosφ/(1−sinψsinφ)) AND interface (c_i*, tanφ_i*, ψ_i* = φ_i*)
  //     parameters, and `interfaceAssociatedLaw` is set so the (now symmetric)
  //     associated slip tangent no longer forces GMRES.
  // ---------------------------------------------------------------------------
  std::int32_t debugSolverMode{ 0 };
  // 1 = the interface Coulomb law runs with tanψ_i = tanφ_i (associated): the
  // slip tangent is symmetric, so interface slip must NOT route the linear
  // solve to GMRES. Only ever set by the Davis debug mode.
  std::uint8_t interfaceAssociatedLaw{ 0 };

  // -------------------------------------------------------------------------
  // Task #56 Stage C-1 (I-1/I-2) — initial-stiffness mode controls. Runtime-
  // only (derived in the decoder / set by verify configs), never wire bytes.
  // -------------------------------------------------------------------------
  GlobalScheme globalScheme{ GlobalScheme::ConsistentNewton };
  // PLAXIS Tolerated error for the I-2 compound acceptance (global error and
  // the per-point local-error quota threshold). PLAXIS default 0.01.
  double plaxisToleratedError{ 0.01 };
  // Iteration cap per load step in the initial-stiffness mode (PLAXIS
  // "Maximum iterations" default 60).
  std::int32_t initialStiffnessMaxIter{ 60 };
  // Over-relaxation ω (PLAXIS default 1.2). Auto-clamped to 1.0 whenever a
  // non-associated plastic point / slipping or gapping interface station is
  // active — van Langen: over-relaxation "may even destroy the convergence"
  // for non-associated plasticity.
  double overRelaxation{ 1.2 };
  // PLAXIS desired-minimum / desired-maximum iteration band for the in-mode
  // step controller (×2 growth below the band, ×0.5 next-step cut above it).
  std::int32_t desiredMinIter{ 6 };
  std::int32_t desiredMaxIter{ 15 };
  // Max load fraction per step in this mode (PLAXIS default 0.5).
  double maxLoadFraction{ 0.5 };
  // Interim collapse discriminator (plan review item 5): when the step size
  // hits the floor AND the last accepted step's CSP is below this threshold,
  // the failure is classified as soil-body COLLAPSE; otherwise as numerical
  // non-convergence.
  double collapseCspThreshold{ 0.015 };
};

// ============================================================================
// Task #56 I-0 — per-phase convergence telemetry. RUNTIME-ONLY: exported via
// the out-of-band diagnostic JSON route (madepGetLastConvergenceDiagnosticsJson,
// same precedent as the Tier-2 diagnostics) — NEVER part of the wire-encoded
// RunSummary. Pure observation: populating these fields must not change any
// solver decision.
//
// Conventions (locked by the adversarial plan review):
//  * "node force magnitude sum" = Σ over nodes of ‖(F_x,F_y)‖₂ plus Σ|M_θ|
//    over wall rotation DOFs — the PLAXIS L1-of-magnitudes norm, NEVER the
//    norm of the vector sum.
//  * PLAXIS global error = residualNodeMagSum /
//      (activeAppliedNodeMagSum + CSP·inactiveNodeMagSum), with
//    Active = λ_target·(phase ramped load delta) and Inactive = the committed
//    pre-phase external load vector.
//  * Local error per soil point uses σ_eq = σ_c^(i−1) + D_e·Δε^(i) (the
//    PREVIOUS-iterate constitutive stress plus the elastic increment of THIS
//    iterate), never the full-step elastic trial; T_max =
//    max(0.5(σ'₁−σ'₃), c·cosφ, kTmaxFloor).
//  * Interface local error denominator = max(τ_max, c_i, 1 kPa).
//  * alphaM is the van Langen eq 3.16 Rayleigh quotient of successive
//    residual VECTORS at the same load target; epsF/epsA are the out-of-
//    solution force/displacement errors of eqs 3.25/3.27.
// ============================================================================
struct PhaseConvergenceTelemetry {
  std::uint8_t valid{ 0 };
  std::uint8_t phaseKind{ 0 };          // solver::PhaseKind cast
  std::uint8_t converged{ 0 };
  std::uint8_t lastBindingArmAbs{ 0 };  // 1 = absolute residual floor bound last
  double lambdaCommitted{ 0.0 };
  double lambdaTarget{ 0.0 };           // target λ of the last assembled iteration
  // Last-iteration snapshot (top-of-iteration assembly).
  double residualNorm{ 0.0 };           // raw L2 (existing convention)
  double residualTarget{ 0.0 };
  double residualNodeMagSum{ 0.0 };     // L1-of-magnitudes numerator
  double activeFullNodeMagSum{ 0.0 };   // Σ‖ramped_node‖ (full phase delta)
  double inactiveNodeMagSum{ 0.0 };     // Σ‖committed external_node‖
  double plaxisGlobalError{ 0.0 };      // numerator / (λ·activeFull + CSP·inactive)
  double csp{ 1.0 };                    // last ACCEPTED step CSP (Δε·Δσ / Δε·D_e·Δε)
  double cspMin{ 1.0 };                 // min over accepted steps of the phase
  // CSP of the increment that was being attempted when the phase failed (the
  // PLAXIS collapse rule tests the CURRENT step's CSP, not the last accepted
  // one). 1.0 when the phase converged.
  double cspAtFailure{ 1.0 };
  // PLAXIS local-error audit (last assembled iteration).
  std::int32_t soilPlasticPointCount{ 0 };
  std::int32_t soilInaccurateCount{ 0 };
  std::int32_t interfacePlasticPointCount{ 0 };
  std::int32_t interfaceInaccurateCount{ 0 };
  double maxSoilLocalError{ 0.0 };
  double maxInterfaceLocalError{ 0.0 };
  std::int32_t interfaceStickCount{ 0 };
  std::int32_t interfaceSlipCount{ 0 };
  std::int32_t interfaceGapCount{ 0 };
  // Residual-discontinuity injectors.
  std::int32_t elasticPassthroughCount{ 0 };   // phase total (I-7a trigger audit)
  std::int32_t lastIterElasticPassthrough{ 0 };
  std::int32_t branchChangeEvents{ 0 };        // fingerprint changed vs previous iteration
  std::int32_t branchPeriod2Cycles{ 0 };       // fp_k == fp_{k-2} != fp_{k-1}
  std::uint64_t lastBranchFingerprint{ 0 };
  // Contraction / out-of-solution estimates (van Langen).
  double alphaM{ 0.0 };
  double epsF{ 0.0 };
  double epsA{ 0.0 };
  std::int32_t absArmBindCount{ 0 };
  std::int32_t relArmBindCount{ 0 };
  std::int32_t newtonIterations{ 0 };
  std::int32_t acceptedSteps{ 0 };
  std::int32_t rejectedSteps{ 0 };
  // Task #56 Stage C-1: 1 when the phase ran the initial-stiffness scheme.
  std::uint8_t usedInitialStiffness{ 0 };
  // Failure classification for a non-converged phase (0 = none/converged,
  // 1 = soil-body collapse: step floor + CSP < collapseCspThreshold,
  // 2 = numerical non-convergence: step floor with CSP above the threshold).
  std::uint8_t verdict{ 0 };
  // Honesty labels for the final accepted state of a CONVERGED phase:
  // which acceptance criterion the λ=1 state actually satisfies.
  std::uint8_t finalStatePlaxisConverged{ 0 };
  std::uint8_t finalStateResearchConverged{ 0 };
  // Bounded history tails (most recent last; capped in the solver).
  std::vector<double> alphaMHistory;
  std::vector<double> residualHistory;
  std::vector<double> plaxisErrorHistory;
};

// Task #56 Stage-B — clean fixed-point probe record (debugSolverMode == 1).
// RUNTIME-ONLY, exported via the diagnostics JSON. The probe iterates
// U += K_e⁻¹·r with the CONSTANT elastic operator (soil D_e + interface full
// elastic diag(k_s,k_n) + wall beam), ω = 1.0, CG + wall preconditioner +
// coarse correction, from the stalled display state — the de-confounded H1
// test from the adversarial plan review (§4 correction).
struct FixedPointProbeTelemetry {
  std::uint8_t valid{ 0 };
  std::uint8_t phaseKind{ 0 };
  std::uint8_t converged{ 0 };
  std::uint8_t startedFromDisplayState{ 0 };
  double lambdaProbe{ 0.0 };
  std::int32_t iterations{ 0 };
  double residual0{ 0.0 };
  double residualFinal{ 0.0 };
  double residualTarget{ 0.0 };
  double alphaMFinal{ 0.0 };
  double epsFFinal{ 0.0 };
  double plaxisGlobalErrorFinal{ 0.0 };
  std::int32_t cgIterationsTotal{ 0 };
  std::vector<double> residualHistory;
  std::vector<double> alphaMHistory;
  std::vector<double> epsFHistory;
  // λ-march after contraction at the stalled target (existence probe; commits
  // on a PRIVATE copy of the committed state — never the run's state).
  std::vector<double> marchLambdas;
  std::vector<std::int32_t> marchIterations;
  double marchLambdaMax{ 0.0 };
  std::uint8_t marchReachedOne{ 0 };
};

// One accepted c-φ safety continuation point. This is a dense history record,
// emitted for accepted continuation steps only.
struct SafetyCurvePoint {
  std::int32_t trialIndex{ -1 };
  std::int32_t continuationStepIndex{ 0 };
  std::int32_t nonlinearIterations{ 0 };
  std::int32_t linearIterations{ 0 };
  std::int32_t activeCount{ 0 };
  std::int32_t activeFaceCount{ 0 };
  std::int32_t activeEdgeCount{ 0 };
  std::int32_t activeApexCount{ 0 };
  std::int32_t tensionCount{ 0 };
  std::int32_t dominantNode{ -1 };
  std::int32_t dominantDof{ -1 };
  std::int32_t activePlasticElementCount{ 0 };
  double sigmaMsf{ 1.0 };
  double lambda{ 0.0 };
  double initialResidualNorm{ 0.0 };
  double residualNorm{ 0.0 };
  double relativeResidual{ 0.0 };
  double lineSearchAcceptedScale{ 1.0 };
  double uMaxAbs{ 0.0 };
  double uNorm{ 0.0 };
  double uSettlementMax{ 0.0 };
  double uHorizontalMax{ 0.0 };
  double maxDeltaPlasticStrain{ 0.0 };
  double totalDeltaPlasticStrain{ 0.0 };
  double mechanismScore{ 0.0 };  // NaN means "not evaluated on this point".
  std::uint8_t actualContinuationMode{ 1 };  // 0=load, 1=strength, 2=arc-length.
  std::uint8_t hasArcLengthDetails{ 0 };
  std::uint16_t arcLengthFailureCode{ 0 };
  std::int32_t arcLengthLinearSolveCount{ 0 };
  double arcLengthDeltaLambda{ 0.0 };
  double arcLengthDeltaS{ 0.0 };
  double arcLengthAlpha{ 1.0 };
  double arcLengthConstraintResidual{ 0.0 };
  double arcLengthCorrectionDenominator{ 0.0 };
};

// One safety c-φ trial target record.
struct SafetyTrial {
  double sigmaMsfStart{ 1.0 };
  double sigmaMsfTarget{ 1.0 };
  double sigmaMsfCommitted{ 1.0 };
  std::uint8_t converged{ 0 };
  std::uint8_t trialOutcome{ 0 };  // 0=converged, 1=newton-failed, 2=cutback-exhausted, 3=rejected.
  std::uint8_t displayed{ 0 };
  std::uint8_t pad[5]{};
  std::uint16_t failureCode{ 0 };
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
  std::vector<SafetyCurvePoint> curve;
};

// Summary stats returned with the result.
//
// Phase 7 (hardening-soil-fix.md §Phase 7): two of the trailing pad
// bytes are now repurposed to expose the linear-solver dispatch
// decision. `lastLinearSolverKind` records the solver used for the
// LAST global Newton iteration of the last completed phase (0=CG,
// 1=GMRES). `hsPlasticUsedGmres` is a derived sticky flag: 1 iff any
// HS plastic Newton iteration in the run dispatched to GMRES. Both
// fields default to 0 for non-HS / elastic-only analyses; the wire
// size is unchanged.
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
  std::uint8_t lastLinearSolverKind{ 0 };
  std::uint8_t hsPlasticUsedGmres{ 0 };
  // Workstream B Tier-2 telemetry. RUNTIME-ONLY — these are not part of the
  // wire-encoded summary (the encoder in deformation_wasm.cpp writes a fixed
  // field list); they are surfaced for verification via a dedicated diagnostic
  // export. `tier2Activations` counts Tier-2 rescue engagements; `tier2Steps`
  // counts accepted Tier-2 load steps; `tier2FinalMu` is the damping used on
  // the last accepted Tier-2 step (Gate #2 expects 0 at convergence);
  // `tier2MaxMu` is the peak μ ever used; `tier2FinalMuZero` is 1 iff the last
  // accepted Tier-2 step used μ == 0.
  std::int32_t tier2Activations{ 0 };
  std::int32_t tier2Steps{ 0 };
  double tier2FinalMu{ 0.0 };
  double tier2MaxMu{ 0.0 };
  double tier2LoadFactor{ 0.0 };
  double tier2LastResidual{ 0.0 };
  std::uint8_t tier2FinalMuZero{ 1 };
  std::uint8_t tier2Converged{ 0 };
  // Phase 8 (docs/features/hardening-soil-fix.md §Phase 8 logging):
  // diagnostic-only fields (active-set change count, local-return
  // failure-code histogram for codes 101-106, max cone / cap / tension /
  // plane-strain residuals, max tangent symmetry norm) are deferred to a
  // future wire-format revision. The current `pad[3]` reserves three
  // bytes for additional u8 status flags; adding the full diagnostic
  // bundle would require bumping the wire-format version and updating
  // both `wire-format.js` and the WASM encoder. Existing fields above
  // are populated for HS at every dispatch site (geostatic, service,
  // safety + safety arc-length) so Phase 8 logging is complete within
  // the current schema's headroom.
  std::uint8_t pad[3]{};
};

}  // namespace madep
