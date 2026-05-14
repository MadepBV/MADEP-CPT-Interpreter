// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WASM entry point — wire format v8.
//
// INPUT (uint8_t* in, std::size_t len):
//   Header (offsets in bytes from the start):
//     u32  magic              = 'TDCM' (0x4D434454)
//     u32  version            = 8
//     u32  elementKind        (3 or 6)
//     u32  constitutive       (0 = LE, 1 = MC-RS, 2 = MC-P)
//     u32  analysisMode       (0 = service-only, 1 = geostatic+service,
//                              2 = geostatic+service+safety)
//     u32  numNodes
//     u32  numElements
//     u32  numRegions
//     u32  numConstraints
//     u32  numGpTotal
//     u8   hasSurfaceLoad
//     u8   useTensionCutoff
//     u8   symmetrize
//     u8   bbar
//     u8   useK0Init
//     u8   robustNonlinearMode
//     u8   requestedContinuationMode (0=load, 1=strength, 2=arc-length, 3=auto)
//     u8   arcLengthDerivativeMode   (0=FD, 1=analytic, 2=analytic-verified)
//     u8   arcLengthMeritMode        (0=one-norm-scaled, 1=quadratic)
//     u8[3] reserved
//     u32  nonlinearMaxIter
//     u32  maxLoadSteps
//     u32  cgMaxIter
//     u32  safetyMaxSearchTrials
//     u32  plasticLineSearchMaxBacktracks
//     u32  initialGravityPlasticLineSearchMaxBacktracks
//     u32  arcLengthLineSearchMaxBacktracks
//     f64  initialLoadStep, minLoadStep, growth, cutback,
//          plasticGrowth, plasticCutback, initialGravityPlasticGrowth,
//          initialGravityPlasticCutback,
//          residualRelTol, residualAbsTol, dispRelTol, dispAbsTol,
//          cgRelTol, cgAbsTol,
//          plasticLineSearchReduction, plasticLineSearchMinScale,
//          initialGravityPlasticLineSearchMinScale, plasticLineSearchArmijo,
//          safetyInitialIncrement, safetyGrowthFactor, safetyCutbackFactor,
//          safetySigmaMax, safetyBracketTolerance,
//          arcLengthDisplacementScale, arcLengthInitialRadiusScale,
//          arcLengthMinRadiusScale, arcLengthMaxRadiusScale,
//          arcLengthConstraintToleranceScale
//   Nodes:       numNodes × (f64 x, f64 y)
//   Elements:    numElements × (i32 regionIndex, i32 elementKind, i32 nodeIds[6])
//   Regions:     numRegions × RegionParams (10 f64 + 4 u8 = 84 bytes)
//   Constraints: numConstraints × i32 dofIndex
//   Gravity RHS: 2 * numNodes f64   (full DOF order; -gamma*area lumped already)
//   Load RHS:    2 * numNodes f64   (surface traction; zero when no load)
//   Predictor U: 2 * numNodes f64   (elastic K0 predictor displacement)
//   InitialSigma: numGpTotal × 6 f64  (per-GP K0 effective stress, tension positive)
//   PorePressure: numGpTotal × f64    (per-GP initial pore pressure)
//
// OUTPUT layout (uint8_t*, std::size_t):
//   u32  magic                 = 'TDKM' (0x4D444B54)
//   u32  version               = 8
//   u32  numNodes
//   u32  numElements
//   u32  numGpTotal
//   RunSummary  (10 i32, 5 f64, 4 u8, 4 u8 pad — 96 bytes)
//   Service displacements:   numNodes × (f64 ux, f64 uy)
//   Geostatic displacements: numNodes × (f64 ux, f64 uy)
//   gpStates:                numGpTotal × (
//     6 f64 effectiveStress (Voigt-6),
//     6 f64 plasticStrain,
//     1 f64 accumulatedPlasticStrain,
//     1 f64 eta,
//     6 f64 referenceStress  (the K0 seed),
//     6 f64 geostaticEffectiveStress,
//     6 f64 geostaticPlasticStrain,
//     1 f64 geostaticAccumulatedPlasticStrain,
//     1 f64 comparisonAccumulatedPlasticStrain,
//     1 f64 porePressure,
//     u8 plasticActive,
//     u8 tensionActive,
//     u8 plasticEverActive,
//     u8 _pad
//   )
//   SafetyResult:
//     u8 status, 7 u8 pad,
//     3 f64 fos_lower / fos_upper / strength_retained,
//     i32 trialCount, i32 totalNewton, i32 curveCount, i32 reserved,
//     trialCount × SafetyTrialTargetV7 (40 bytes),
//     curveCount × SafetyCurvePointV8 (200 bytes)
//
// All multi-byte fields are little-endian.

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#include "cg.hpp"
#include "element.hpp"
#include "linalg.hpp"
#include "material_mc.hpp"
#include "material_mc_exact.hpp"
#include "math_js_mirror.hpp"
#include "solver.hpp"
#include "sparse.hpp"
#include "types.hpp"

#if defined(__EMSCRIPTEN__)
#  include <emscripten.h>
#  define MADEP_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#  define MADEP_EXPORT
#endif

namespace madep {

namespace {

std::string g_last_error;

const std::uint8_t* read_u32(const std::uint8_t* p, std::uint32_t& v) { std::memcpy(&v, p, 4); return p + 4; }
const std::uint8_t* read_i32(const std::uint8_t* p, std::int32_t& v) { std::memcpy(&v, p, 4); return p + 4; }
const std::uint8_t* read_u8 (const std::uint8_t* p, std::uint8_t&  v) { v = *p; return p + 1; }
const std::uint8_t* read_f64(const std::uint8_t* p, double& v)          { std::memcpy(&v, p, 8); return p + 8; }

std::uint8_t* write_u32(std::uint8_t* p, std::uint32_t v) { std::memcpy(p, &v, 4); return p + 4; }
std::uint8_t* write_i32(std::uint8_t* p, std::int32_t v)  { std::memcpy(p, &v, 4); return p + 4; }
std::uint8_t* write_u16(std::uint8_t* p, std::uint16_t v) { std::memcpy(p, &v, 2); return p + 2; }
std::uint8_t* write_u8 (std::uint8_t* p, std::uint8_t v)  { *p = v; return p + 1; }
std::uint8_t* write_f64(std::uint8_t* p, double v)         { std::memcpy(p, &v, 8); return p + 8; }

RequestedContinuationMode requested_continuation_mode_from_wire(std::uint8_t value) {
  if (value == 0u) return RequestedContinuationMode::LoadControl;
  if (value == 1u) return RequestedContinuationMode::StrengthControl;
  if (value == 2u) return RequestedContinuationMode::ArcLength;
  return RequestedContinuationMode::Auto;
}

ArcLengthDerivativeMode arc_length_derivative_mode_from_wire(std::uint8_t value) {
  if (value == 1u) return ArcLengthDerivativeMode::Analytic;
  if (value == 2u) return ArcLengthDerivativeMode::AnalyticVerified;
  return ArcLengthDerivativeMode::FiniteDifference;
}

ArcLengthMeritMode arc_length_merit_mode_from_wire(std::uint8_t value) {
  if (value == 1u) return ArcLengthMeritMode::Quadratic;
  return ArcLengthMeritMode::OneNormScaled;
}

constexpr std::uint32_t INPUT_MAGIC  = 0x4D434454u;  // 'TDCM'
constexpr std::uint32_t OUTPUT_MAGIC = 0x4D444B54u;  // 'TDKM'
constexpr std::uint32_t WIRE_VERSION = 8u;

constexpr std::size_t kInputHeaderBytes = 40 + 12 + 7 * 4 + 28 * 8;  // 304 bytes
constexpr std::size_t kSummaryBytes = 10 * 4 + 5 * 8 + 4 + 4;  // 88 bytes
constexpr std::size_t kGpStateBytes = (6 + 6 + 1 + 1 + 6 + 6 + 6 + 1 + 1 + 1) * 8 + 4;  // 35 f64 + 4 u8 = 284 bytes
constexpr std::size_t kSafetyHeaderBytes = 1 + 7 + 3 * 8 + 4 * 4;  // 48 bytes
constexpr std::size_t kSafetyTrialBytes = 3 * 8 + 4 + 2 + 3 + 7;   // 40 bytes
constexpr std::size_t kSafetyCurvePointBytes = 12 * 4 + 13 * 8 + 8 + 5 * 8;   // 200 bytes
constexpr std::uint32_t LOCAL_MC_INPUT_MAGIC  = 0x504C434Du;  // 'MCLP'
constexpr std::uint32_t LOCAL_MC_OUTPUT_MAGIC = 0x4F4C434Du;  // 'MCLO'
constexpr std::uint32_t LOCAL_MC_VERSION = 1u;

const std::uint8_t* read_vec6(const std::uint8_t* p, Vec6& v) {
  for (double& x : v) p = read_f64(p, x);
  return p;
}

std::uint8_t* write_vec6(std::uint8_t* p, const Vec6& v) {
  for (double x : v) p = write_f64(p, x);
  return p;
}

std::uint8_t* write_mat6(std::uint8_t* p, const Mat6& m) {
  for (const auto& row : m) {
    for (double x : row) p = write_f64(p, x);
  }
  return p;
}

const std::uint8_t* read_projectors(const std::uint8_t* p, MaterialPoint& mp) {
  for (auto* P : {&mp.repP1, &mp.repP2, &mp.repP3}) {
    for (auto& row : *P) {
      for (double& x : row) p = read_f64(p, x);
    }
  }
  return p;
}

std::uint8_t* write_projectors(std::uint8_t* p, const solver::GpResponseExtra& extra) {
  for (const auto* P : {&extra.repP1, &extra.repP2, &extra.repP3}) {
    for (const auto& row : *P) {
      for (double x : row) p = write_f64(p, x);
    }
  }
  return p;
}

const std::uint8_t* read_material_point_state(const std::uint8_t* p, MaterialPoint& mp) {
  p = read_vec6(p, mp.totalStrain);
  p = read_vec6(p, mp.plasticStrain);
  p = read_vec6(p, mp.effectiveStress);
  p = read_f64(p, mp.accumulatedPlasticStrain);
  p = read_u8(p, mp.plasticActive);
  p = read_u8(p, mp.plasticEverActive);
  p = read_u8(p, mp.tensionCutoffActive);
  p = read_u8(p, mp.localReturnMode);
  p = read_u8(p, mp.exactBranchKind);
  p = read_u8(p, mp.multiplicityKind);
  p = read_u8(p, mp.hasRepresentativeProjectors);
  p = read_u8(p, mp.currentlyMcActive);
  p = read_u8(p, mp.localFallbackUsed);
  std::uint8_t pad = 0;
  p = read_u8(p, pad);
  p = read_u8(p, pad);
  p = read_u8(p, pad);
  p = read_projectors(p, mp);
  return p;
}

}  // namespace

extern "C" {

MADEP_EXPORT
int madepRunDeformationAnalysis(
    const std::uint8_t* inputPtr,
    std::uint32_t inputLen,
    std::uint8_t** outPtrPtr,
    std::uint32_t* outLenPtr) {
  using clock = std::chrono::steady_clock;
  const auto startTime = clock::now();

  g_last_error.clear();
  if (!inputPtr || inputLen < kInputHeaderBytes || !outPtrPtr || !outLenPtr) {
    g_last_error = "invalid arguments to madepRunDeformationAnalysis";
    return 0;
  }
  const std::uint8_t* p = inputPtr;
  std::uint32_t magic, version, elementKindU, constitutiveU, analysisModeU;
  std::uint32_t numNodes, numElements, numRegions, numConstraints, numGpTotalU;
  std::uint8_t hasSurfaceLoad, useTensionCutoff, symmetrize, bbar, useK0Init;
  std::uint8_t robustNonlinearMode, requestedContinuationModeU, arcLengthDerivativeModeU;
  std::uint8_t arcLengthMeritModeU, pad0, pad1, pad2;
  std::uint32_t nonlinearMaxIter, maxLoadSteps, cgMaxIter, safetyMaxSearchTrials;
  std::uint32_t plasticLineSearchMaxBacktracks, initialGravityPlasticLineSearchMaxBacktracks;
  std::uint32_t arcLengthLineSearchMaxBacktracks;
  double initialLoadStep, minLoadStep, growth, cutback;
  double plasticGrowth, plasticCutback, initialGravityPlasticGrowth, initialGravityPlasticCutback;
  double resRel, resAbs, dispRel, dispAbs;
  double cgRel, cgAbs;
  double plasticLineSearchReduction, plasticLineSearchMinScale;
  double initialGravityPlasticLineSearchMinScale, plasticLineSearchArmijo;
  double safetyInitialIncrement, safetyGrowthFactor, safetyCutbackFactor, safetySigmaMax, safetyBracketTolerance;
  double arcLengthDisplacementScale, arcLengthInitialRadiusScale, arcLengthMinRadiusScale;
  double arcLengthMaxRadiusScale, arcLengthConstraintToleranceScale;

  p = read_u32(p, magic);
  p = read_u32(p, version);
  if (magic != INPUT_MAGIC || version != WIRE_VERSION) {
    g_last_error = "WASM input header magic/version mismatch";
    return 0;
  }
  p = read_u32(p, elementKindU);
  p = read_u32(p, constitutiveU);
  p = read_u32(p, analysisModeU);
  p = read_u32(p, numNodes);
  p = read_u32(p, numElements);
  p = read_u32(p, numRegions);
  p = read_u32(p, numConstraints);
  p = read_u32(p, numGpTotalU);
  p = read_u8(p, hasSurfaceLoad);
  p = read_u8(p, useTensionCutoff);
  p = read_u8(p, symmetrize);
  p = read_u8(p, bbar);
  p = read_u8(p, useK0Init);
  p = read_u8(p, robustNonlinearMode);
  p = read_u8(p, requestedContinuationModeU);
  p = read_u8(p, arcLengthDerivativeModeU);
  p = read_u8(p, arcLengthMeritModeU);
  p = read_u8(p, pad0);
  p = read_u8(p, pad1);
  p = read_u8(p, pad2);
  (void)pad0;
  (void)pad1;
  (void)pad2;
  p = read_u32(p, nonlinearMaxIter);
  p = read_u32(p, maxLoadSteps);
  p = read_u32(p, cgMaxIter);
  p = read_u32(p, safetyMaxSearchTrials);
  p = read_u32(p, plasticLineSearchMaxBacktracks);
  p = read_u32(p, initialGravityPlasticLineSearchMaxBacktracks);
  p = read_u32(p, arcLengthLineSearchMaxBacktracks);
  p = read_f64(p, initialLoadStep);
  p = read_f64(p, minLoadStep);
  p = read_f64(p, growth);
  p = read_f64(p, cutback);
  p = read_f64(p, plasticGrowth);
  p = read_f64(p, plasticCutback);
  p = read_f64(p, initialGravityPlasticGrowth);
  p = read_f64(p, initialGravityPlasticCutback);
  p = read_f64(p, resRel);
  p = read_f64(p, resAbs);
  p = read_f64(p, dispRel);
  p = read_f64(p, dispAbs);
  p = read_f64(p, cgRel);
  p = read_f64(p, cgAbs);
  p = read_f64(p, plasticLineSearchReduction);
  p = read_f64(p, plasticLineSearchMinScale);
  p = read_f64(p, initialGravityPlasticLineSearchMinScale);
  p = read_f64(p, plasticLineSearchArmijo);
  p = read_f64(p, safetyInitialIncrement);
  p = read_f64(p, safetyGrowthFactor);
  p = read_f64(p, safetyCutbackFactor);
  p = read_f64(p, safetySigmaMax);
  p = read_f64(p, safetyBracketTolerance);
  p = read_f64(p, arcLengthDisplacementScale);
  p = read_f64(p, arcLengthInitialRadiusScale);
  p = read_f64(p, arcLengthMinRadiusScale);
  p = read_f64(p, arcLengthMaxRadiusScale);
  p = read_f64(p, arcLengthConstraintToleranceScale);

  const ElementKind elementKind = (elementKindU == 6) ? ElementKind::T6 : ElementKind::T3;
  const int nodesPerEl = (elementKind == ElementKind::T6) ? 6 : 3;
  const ConstitutiveKind constitutive =
      (constitutiveU == 2) ? ConstitutiveKind::McPlastic :
      (constitutiveU == 1) ? ConstitutiveKind::McReducedStiffness :
                             ConstitutiveKind::LinearElastic;
  const AnalysisMode analysisMode =
      (analysisModeU == 2) ? AnalysisMode::GeostaticServiceSafety :
      (analysisModeU == 1) ? AnalysisMode::GeostaticPlusService :
                             AnalysisMode::ServiceOnly;
  const int numGpPerEl = (elementKind == ElementKind::T6) ? 3 : 1;

  // Nodes.
  std::vector<Node> nodes(numNodes);
  for (std::uint32_t i = 0; i < numNodes; ++i) {
    p = read_f64(p, nodes[i].x);
    p = read_f64(p, nodes[i].y);
  }

  // Elements.
  std::vector<ElementCache> elements(numElements);
  for (std::uint32_t i = 0; i < numElements; ++i) {
    std::int32_t region, kindStored;
    p = read_i32(p, region);
    p = read_i32(p, kindStored);
    auto& el = elements[i];
    el.elementIndex = static_cast<std::int32_t>(i);
    el.regionIndex = region;
    el.kind = (kindStored == 6) ? ElementKind::T6 : ElementKind::T3;
    std::int32_t nids[6];
    for (int k = 0; k < 6; ++k) p = read_i32(p, nids[k]);
    for (int k = 0; k < 6; ++k) el.nodeIds[k] = (k < nodesPerEl) ? nids[k] : -1;
    for (int k = 0; k < nodesPerEl; ++k) {
      el.dofs[2 * k + 0] = 2 * el.nodeIds[k] + 0;
      el.dofs[2 * k + 1] = 2 * el.nodeIds[k] + 1;
    }
  }

  // Regions.
  std::vector<RegionParams> regions(numRegions);
  for (std::uint32_t i = 0; i < numRegions; ++i) {
    auto& r = regions[i];
    p = read_f64(p, r.Emc);
    p = read_f64(p, r.nu);
    p = read_f64(p, r.cEff);
    p = read_f64(p, r.phi);
    p = read_f64(p, r.psi);
    p = read_f64(p, r.K0nc);
    p = read_f64(p, r.gamma);
    p = read_f64(p, r.gammaSat);
    p = read_f64(p, r.sigmaTAllow);
    p = read_f64(p, r.rShear);
    p = read_u8(p, r.useTensionCutoff);
    p = read_u8(p, r.symmetrize);
    p = read_u8(p, r.pad0);
    p = read_u8(p, r.pad1);
  }

  // Constraints.
  std::vector<std::uint8_t> isFixed(2 * numNodes, 0u);
  for (std::uint32_t i = 0; i < numConstraints; ++i) {
    std::int32_t dof;
    p = read_i32(p, dof);
    if (dof >= 0 && static_cast<std::uint32_t>(dof) < 2 * numNodes) isFixed[dof] = 1u;
  }

  // Gravity + Load RHS (full DOF).
  const std::uint32_t ndof = 2 * numNodes;
  std::vector<double> gravityRhsFull(ndof, 0.0);
  std::vector<double> loadRhsFull(ndof, 0.0);
  std::vector<double> predictorUFull(ndof, 0.0);
  for (std::uint32_t i = 0; i < ndof; ++i) p = read_f64(p, gravityRhsFull[i]);
  for (std::uint32_t i = 0; i < ndof; ++i) p = read_f64(p, loadRhsFull[i]);
  for (std::uint32_t i = 0; i < ndof; ++i) p = read_f64(p, predictorUFull[i]);

  // Initial sigma (per GP, Voigt-6) — only consumed when useK0Init.
  const std::size_t numGpTotal = static_cast<std::size_t>(numGpTotalU);
  std::vector<double> initialSigma(numGpTotal * 6, 0.0);
  for (std::size_t i = 0; i < initialSigma.size(); ++i) p = read_f64(p, initialSigma[i]);

  // Pore pressure (per GP).
  std::vector<double> porePressureByGp(numGpTotal, 0.0);
  for (std::size_t i = 0; i < porePressureByGp.size(); ++i) p = read_f64(p, porePressureByGp[i]);

  if (static_cast<std::size_t>(p - inputPtr) > inputLen) {
    g_last_error = "WASM input buffer truncated";
    return 0;
  }

  // Build element caches.
  for (auto& el : elements) {
    if (el.kind == ElementKind::T3) {
      elem::build_T3(nodes[el.nodeIds[0]], nodes[el.nodeIds[1]], nodes[el.nodeIds[2]], el);
    } else {
      elem::build_T6(
          nodes[el.nodeIds[0]], nodes[el.nodeIds[1]], nodes[el.nodeIds[2]],
          nodes[el.nodeIds[3]], nodes[el.nodeIds[4]], nodes[el.nodeIds[5]],
          bbar != 0,
          el);
    }
  }

  // Tag orphans.
  std::vector<std::uint8_t> referenced(numNodes, 0u);
  for (const auto& el : elements) for (int k = 0; k < el.numNodes; ++k) referenced[el.nodeIds[k]] = 1u;
  for (std::uint32_t i = 0; i < numNodes; ++i) {
    if (!referenced[i]) { isFixed[2 * i + 0] = 1u; isFixed[2 * i + 1] = 1u; }
  }

  // Build free DOF mapping.
  std::vector<std::int32_t> freeIndexByDof(ndof, -1);
  std::vector<std::int32_t> freeDofs;
  freeDofs.reserve(ndof);
  for (std::uint32_t i = 0; i < ndof; ++i) {
    if (!isFixed[i]) {
      freeIndexByDof[i] = static_cast<std::int32_t>(freeDofs.size());
      freeDofs.push_back(static_cast<std::int32_t>(i));
    }
  }
  const std::int32_t nfree = static_cast<std::int32_t>(freeDofs.size());

  std::vector<double> gravityRhsFree(nfree, 0.0);
  std::vector<double> loadRhsFree(nfree, 0.0);
  for (std::int32_t i = 0; i < nfree; ++i) {
    gravityRhsFree[i] = gravityRhsFull[freeDofs[i]];
    loadRhsFree[i] = loadRhsFull[freeDofs[i]];
  }

  // Material points and element ↔ MP mapping.
  std::vector<MaterialPoint> materialPoints(numGpTotal);
  {
    std::int32_t idx = 0;
    for (std::uint32_t e = 0; e < numElements; ++e) {
      auto& el = elements[e];
      for (int g = 0; g < numGpPerEl; ++g) {
        el.mpIdx[g] = idx;
        materialPoints[static_cast<std::size_t>(idx)].regionIndex = el.regionIndex;
        ++idx;
      }
    }
  }

  // Build elastic C per region; needed for the seed-time MC projection.
  const ConstitutiveKind constitutiveEarly = constitutive;
  std::vector<Mat6> regionC = solver::build_region_elastic(regions);
  solver::initialise_material_points(
      materialPoints, regions, regionC,
      initialSigma.data(), porePressureByGp.data(),
      useK0Init != 0, constitutiveEarly);

  // Build CSR pattern.
  CsrMatrix K;
  sparse::build_pattern(elements, freeIndexByDof, nfree, K);

  std::vector<double> U_global(ndof, 0.0);
  std::vector<double> U_geostatic(ndof, 0.0);

  SolverOptions opts;
  opts.constitutive = constitutive;
  opts.elementKind = elementKind;
  opts.analysisMode = analysisMode;
  opts.hasSurfaceLoad = hasSurfaceLoad;
  opts.useTensionCutoff = useTensionCutoff;
  opts.symmetrizeTangent = symmetrize;
  opts.bbarForT6 = bbar;
  opts.robustNonlinearMode = robustNonlinearMode;
  opts.requestedContinuationMode = requested_continuation_mode_from_wire(requestedContinuationModeU);
  opts.arcLengthDerivativeMode = arc_length_derivative_mode_from_wire(arcLengthDerivativeModeU);
  opts.arcLengthMeritMode = arc_length_merit_mode_from_wire(arcLengthMeritModeU);
  opts.nonlinearMaxIter = static_cast<std::int32_t>(nonlinearMaxIter);
  opts.maxLoadSteps = static_cast<std::int32_t>(maxLoadSteps);
  opts.initialLoadStep = initialLoadStep;
  opts.minLoadStep = minLoadStep;
  opts.loadStepGrowthFactor = growth;
  opts.loadStepCutbackFactor = cutback;
  opts.plasticLoadStepGrowthFactor = plasticGrowth;
  opts.plasticLoadStepCutbackFactor = plasticCutback;
  opts.initialGravityPlasticLoadStepGrowthFactor = initialGravityPlasticGrowth;
  opts.initialGravityPlasticLoadStepCutbackFactor = initialGravityPlasticCutback;
  opts.residualRelTol = resRel;
  opts.residualAbsTol = resAbs;
  opts.displacementRelTol = dispRel;
  opts.displacementAbsTol = dispAbs;
  opts.cgMaxIter = static_cast<std::int32_t>(cgMaxIter);
  opts.cgRelTol = cgRel;
  opts.cgAbsTol = cgAbs;
  opts.plasticLineSearchReductionFactor = plasticLineSearchReduction;
  opts.plasticLineSearchMinScale = plasticLineSearchMinScale;
  opts.initialGravityPlasticLineSearchMinScale = initialGravityPlasticLineSearchMinScale;
  opts.plasticLineSearchArmijoCoefficient = plasticLineSearchArmijo;
  opts.plasticLineSearchMaxBacktracks = static_cast<std::int32_t>(plasticLineSearchMaxBacktracks);
  opts.initialGravityPlasticLineSearchMaxBacktracks =
      static_cast<std::int32_t>(initialGravityPlasticLineSearchMaxBacktracks);
  opts.arcLengthLineSearchMaxBacktracks =
      static_cast<std::int32_t>(arcLengthLineSearchMaxBacktracks);
  opts.safetyInitialIncrement = safetyInitialIncrement;
  opts.safetyGrowthFactor = safetyGrowthFactor;
  opts.safetyCutbackFactor = safetyCutbackFactor;
  opts.safetySigmaMax = safetySigmaMax;
  opts.safetyBracketTolerance = safetyBracketTolerance;
  opts.safetyMaxSearchTrials = static_cast<std::int32_t>(safetyMaxSearchTrials);
  opts.arcLengthDisplacementScale = arcLengthDisplacementScale;
  opts.arcLengthInitialRadiusScale = arcLengthInitialRadiusScale;
  opts.arcLengthMinRadiusScale = arcLengthMinRadiusScale;
  opts.arcLengthMaxRadiusScale = arcLengthMaxRadiusScale;
  opts.arcLengthConstraintToleranceScale = arcLengthConstraintToleranceScale;

  solver::DriverInput drv;
  drv.elements = &elements;
  drv.materialPoints = &materialPoints;
  drv.regions = &regions;
  drv.freeDofs = &freeDofs;
  drv.freeIndexByDof = &freeIndexByDof;
  drv.K = &K;
  drv.ndof = static_cast<std::int32_t>(ndof);
  drv.gravityRhsFree = &gravityRhsFree;
  drv.loadRhsFree = &loadRhsFree;
  drv.predictorUFull = &predictorUFull;
  drv.U_global = &U_global;
  drv.U_geostatic = &U_geostatic;
  drv.opts = opts;

  solver::DriverOutput result = solver::run_full_analysis(drv);

  const auto endTime = clock::now();
  result.summary.elapsed_ms = std::chrono::duration<double, std::milli>(endTime - startTime).count();

  // ---- pack output ------------------------------------------------------
  const std::size_t outLen =
      5 * 4 +                                  // header
      kSummaryBytes +                          // summary
      static_cast<std::size_t>(numNodes) * 16 + // service displacements
	      static_cast<std::size_t>(numNodes) * 16 + // geostatic displacements
	      static_cast<std::size_t>(numGpTotal) * kGpStateBytes +
	      kSafetyHeaderBytes +
	      static_cast<std::size_t>(result.safety.trials.size()) * kSafetyTrialBytes +
	      static_cast<std::size_t>(result.safety.curve.size()) * kSafetyCurvePointBytes;

  std::uint8_t* out = new (std::nothrow) std::uint8_t[outLen];
  if (!out) { g_last_error = "WASM output allocation failed"; return 0; }
  std::uint8_t* q = out;
  q = write_u32(q, OUTPUT_MAGIC);
  q = write_u32(q, WIRE_VERSION);
  q = write_u32(q, numNodes);
  q = write_u32(q, numElements);
  q = write_u32(q, static_cast<std::uint32_t>(numGpTotal));

  // Summary — keep this exactly in sync with kSummaryBytes.
  q = write_i32(q, result.summary.loadStepsAccepted);
  q = write_i32(q, result.summary.loadStepsRejected);
  q = write_i32(q, result.summary.newtonIterations);
  q = write_i32(q, result.summary.cgIterations);
  q = write_i32(q, result.summary.finalActiveCount);
  q = write_i32(q, result.summary.finalTensionCount);
  q = write_i32(q, result.summary.geostaticAccepted);
  q = write_i32(q, result.summary.geostaticRejected);
  q = write_i32(q, result.summary.serviceAccepted);
  q = write_i32(q, result.summary.serviceRejected);
  q = write_f64(q, result.summary.finalLoadFactor);
  q = write_f64(q, result.summary.geostaticLoadFactor);
  q = write_f64(q, result.summary.residualNorm);
  q = write_f64(q, result.summary.maxEta);
  q = write_f64(q, result.summary.elapsed_ms);
  q = write_u8(q, result.summary.geostaticConverged);
  q = write_u8(q, result.summary.serviceConverged);
  q = write_u8(q, result.summary.safetyRan);
  q = write_u8(q, 0); q = write_u8(q, 0); q = write_u8(q, 0); q = write_u8(q, 0); q = write_u8(q, 0);

  // Service displacements.
  for (std::uint32_t n = 0; n < numNodes; ++n) {
    q = write_f64(q, U_global[2 * n + 0]);
    q = write_f64(q, U_global[2 * n + 1]);
  }
  // Geostatic displacements.
  for (std::uint32_t n = 0; n < numNodes; ++n) {
    q = write_f64(q, U_geostatic[2 * n + 0]);
    q = write_f64(q, U_geostatic[2 * n + 1]);
  }

  // Gauss-point states.
  for (std::size_t gp = 0; gp < numGpTotal; ++gp) {
    const auto& mp = materialPoints[gp];
    for (int k = 0; k < 6; ++k) q = write_f64(q, mp.effectiveStress[k]);
    for (int k = 0; k < 6; ++k) q = write_f64(q, mp.plasticStrain[k]);
    q = write_f64(q, mp.accumulatedPlasticStrain);
    q = write_f64(q, mp.etaMcCurrent);
    for (int k = 0; k < 6; ++k) q = write_f64(q, mp.referenceStress[k]);
    for (int k = 0; k < 6; ++k) q = write_f64(q, mp.geostaticEffectiveStress[k]);
    for (int k = 0; k < 6; ++k) q = write_f64(q, mp.geostaticPlasticStrain[k]);
    q = write_f64(q, mp.geostaticAccumulatedPlasticStrain);
    const double comparisonAccumulatedPlasticStrain =
        gp < result.displayComparisonAccumulatedPlasticStrain.size()
            ? result.displayComparisonAccumulatedPlasticStrain[gp]
            : mp.geostaticAccumulatedPlasticStrain;
    q = write_f64(q, comparisonAccumulatedPlasticStrain);
    q = write_f64(q, mp.porePressure);
    q = write_u8(q, mp.plasticActive);
    q = write_u8(q, mp.tensionCutoffActive);
    q = write_u8(q, mp.plasticEverActive);
    q = write_u8(q, 0);
  }

  // Safety.
  q = write_u8(q, result.safety.status);
  for (int i = 0; i < 7; ++i) q = write_u8(q, 0);
  q = write_f64(q, result.safety.factorOfSafetyLower);
  q = write_f64(q, result.safety.factorOfSafetyUpper);
	  q = write_f64(q, result.safety.strengthRetained);
	  q = write_i32(q, result.safety.trialCount);
	  q = write_i32(q, result.safety.totalNewtonIterations);
	  q = write_i32(q, static_cast<std::int32_t>(result.safety.curve.size()));
	  q = write_i32(q, 0);
	  for (const auto& trial : result.safety.trials) {
	    q = write_f64(q, trial.sigmaMsfStart);
	    q = write_f64(q, trial.sigmaMsfTarget);
	    q = write_f64(q, trial.sigmaMsfCommitted);
	    q = write_i32(q, trial.iterations);
	    q = write_u16(q, trial.failureCode);
	    q = write_u8(q, trial.converged);
	    q = write_u8(q, trial.trialOutcome);
	    q = write_u8(q, trial.displayed);
	    for (int i = 0; i < 7; ++i) q = write_u8(q, 0);
	  }
	  for (const auto& point : result.safety.curve) {
	    q = write_i32(q, point.trialIndex);
	    q = write_i32(q, point.continuationStepIndex);
	    q = write_i32(q, point.nonlinearIterations);
	    q = write_i32(q, point.linearIterations);
	    q = write_i32(q, point.activeCount);
	    q = write_i32(q, point.activeFaceCount);
	    q = write_i32(q, point.activeEdgeCount);
	    q = write_i32(q, point.activeApexCount);
	    q = write_i32(q, point.tensionCount);
	    q = write_i32(q, point.dominantNode);
	    q = write_i32(q, point.dominantDof);
	    q = write_i32(q, point.activePlasticElementCount);
	    q = write_f64(q, point.sigmaMsf);
	    q = write_f64(q, point.lambda);
	    q = write_f64(q, point.initialResidualNorm);
	    q = write_f64(q, point.residualNorm);
	    q = write_f64(q, point.relativeResidual);
	    q = write_f64(q, point.lineSearchAcceptedScale);
	    q = write_f64(q, point.uMaxAbs);
	    q = write_f64(q, point.uNorm);
	    q = write_f64(q, point.uSettlementMax);
	    q = write_f64(q, point.uHorizontalMax);
	    q = write_f64(q, point.maxDeltaPlasticStrain);
	    q = write_f64(q, point.totalDeltaPlasticStrain);
	    q = write_f64(q, point.mechanismScore);
	    q = write_u8(q, point.actualContinuationMode);
	    q = write_u8(q, point.hasArcLengthDetails);
	    q = write_u16(q, point.arcLengthFailureCode);
	    q = write_i32(q, point.arcLengthLinearSolveCount);
	    q = write_f64(q, point.arcLengthDeltaLambda);
	    q = write_f64(q, point.arcLengthDeltaS);
	    q = write_f64(q, point.arcLengthAlpha);
	    q = write_f64(q, point.arcLengthConstraintResidual);
	    q = write_f64(q, point.arcLengthCorrectionDenominator);
	  }

  *outPtrPtr = out;
  *outLenPtr = static_cast<std::uint32_t>(outLen);
  return 1;
}

MADEP_EXPORT
int madepRunMcPlasticMaterialPoint(
    const std::uint8_t* inputPtr,
    std::uint32_t inputLen,
    std::uint8_t** outPtrPtr,
    std::uint32_t* outLenPtr) {
  if (!inputPtr || !outPtrPtr || !outLenPtr) {
    g_last_error = "invalid arguments to madepRunMcPlasticMaterialPoint";
    return 0;
  }
  const std::uint8_t* p = inputPtr;
  const std::uint8_t* end = inputPtr + inputLen;
  auto remaining = [&]() -> std::size_t { return static_cast<std::size_t>(end - p); };
  if (remaining() < 8) {
    g_last_error = "local MC input too short";
    return 0;
  }
  std::uint32_t magic = 0, version = 0;
  p = read_u32(p, magic);
  p = read_u32(p, version);
  if (magic != LOCAL_MC_INPUT_MAGIC || version != LOCAL_MC_VERSION) {
    g_last_error = "bad local MC input header";
    return 0;
  }

  RegionParams rp;
  double phiDeg = 0.0;
  double psiDeg = 0.0;
  p = read_f64(p, rp.Emc);
  p = read_f64(p, rp.nu);
  p = read_f64(p, rp.cEff);
  p = read_f64(p, phiDeg);
  p = read_f64(p, psiDeg);
  p = read_f64(p, rp.sigmaTAllow);
  rp.phi = phiDeg * M_PI / 180.0;
  rp.psi = psiDeg * M_PI / 180.0;
  rp.K0nc = 0.5;
  rp.gamma = 18.0;
  rp.gammaSat = 20.0;
  rp.rShear = 0.25;
  std::uint8_t previousPresent = 0;
  p = read_u8(p, rp.useTensionCutoff);
  p = read_u8(p, rp.symmetrize);
  p = read_u8(p, previousPresent);
  std::uint8_t pad = 0;
  p = read_u8(p, pad);

  MaterialPoint committed;
  p = read_material_point_state(p, committed);
  MaterialPoint previous;
  if (previousPresent != 0u) p = read_material_point_state(p, previous);
  Vec6 strainTrial{};
  p = read_vec6(p, strainTrial);
  if (p > end) {
    g_last_error = "local MC input truncated";
    return 0;
  }

  const Mat6 C = linalg::elastic_matrix_E_nu(rp.Emc, rp.nu);
  solver::GpResponseExtra extra;
  const solver::GpResponse response = solver::evaluate_gp_response_ex(
      ConstitutiveKind::McPlastic,
      C,
      rp,
      previousPresent != 0u ? &previous : nullptr,
      committed,
      strainTrial,
      false,
      extra);

  constexpr std::size_t outLen =
      2 * 4 +
      6 * 8 + 6 * 8 + 36 * 8 +
      2 * 8 +
      8 +
      27 * 8;
  std::uint8_t* out = new (std::nothrow) std::uint8_t[outLen];
  if (!out) {
    g_last_error = "local MC output allocation failed";
    return 0;
  }
  std::uint8_t* q = out;
  q = write_u32(q, LOCAL_MC_OUTPUT_MAGIC);
  q = write_u32(q, LOCAL_MC_VERSION);
  q = write_vec6(q, response.stress);
  q = write_vec6(q, response.plasticInc);
  q = write_mat6(q, response.tangent);
  q = write_f64(q, response.eta);
  q = write_f64(q, response.equivPlasticInc);
  q = write_u8(q, response.plasticActive);
  q = write_u8(q, response.tensionActive);
  q = write_u8(q, extra.exactBranchKind);
  q = write_u8(q, extra.multiplicityKind);
  q = write_u8(q, extra.hasRepresentativeProjectors);
  q = write_u8(q, extra.localReturnMode);
  q = write_u8(q, extra.localFallbackUsed);
  q = write_u8(q, extra.stateChanged);
  q = write_projectors(q, extra);
  *outPtrPtr = out;
  *outLenPtr = static_cast<std::uint32_t>(outLen);
  return 1;
}

MADEP_EXPORT
const char* madepGetLastErrorMessage() {
  return g_last_error.c_str();
}

MADEP_EXPORT
void madepFreeBuffer(std::uint8_t* ptr) {
  delete[] ptr;
}

}  // extern "C"

}  // namespace madep
