// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Wire-format encoder/decoder shared between the JS bridge and the C++
// WASM module. Both sides MUST agree on this layout exactly; the C++
// reader lives in deformation_wasm.cpp. Wire version 10.

const INPUT_MAGIC = 0x4D434454; // 'TDCM'
const OUTPUT_MAGIC = 0x4D444B54; // 'TDKM'
const WIRE_VERSION = 10;
const LEGACY_OUTPUT_WIRE_VERSION = 6;
const SAFETY_HISTORY_OUTPUT_WIRE_VERSION = 7;

const SAFETY_WIRE_LABELS = Object.freeze([
  'not-run',
  'bracketed',
  'mechanism',
  'no-failure-found',
  'numerical-limit',
  'insufficient-mechanism',
  'needs-more-steps'
]);

const SAFETY_FINALIZATION_STATUS_BY_WIRE = Object.freeze([
  'not-run',
  'bracketed-failure',
  'mechanism-developed',
  'no-failure-found',
  'numerical-nonconvergence',
  'insufficient-mechanism',
  'needs-more-steps'
]);

export const CONSTITUTIVE_KIND = Object.freeze({
  LinearElastic: 0,
  McReducedStiffness: 1,
  McPlastic: 2,
  HardeningSoil: 3
});

export const ANALYSIS_MODE = Object.freeze({
  ServiceOnly: 0,
  GeostaticPlusService: 1,
  GeostaticServiceSafety: 2
});

export function constitutiveKindFor(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === 'linear-elastic') return CONSTITUTIVE_KIND.LinearElastic;
  if (lower === 'mc-plastic') return CONSTITUTIVE_KIND.McPlastic;
  if (lower === 'hardening-soil') return CONSTITUTIVE_KIND.HardeningSoil;
  return CONSTITUTIVE_KIND.McReducedStiffness;
}

export function analysisModeFor(analysisType, hasGeostatic) {
  if (analysisType === 'safety-cphi') return ANALYSIS_MODE.GeostaticServiceSafety;
  if (hasGeostatic) return ANALYSIS_MODE.GeostaticPlusService;
  return ANALYSIS_MODE.ServiceOnly;
}

export function requestedContinuationModeCode(value) {
  const mode = String(value || '').toLowerCase();
  if (mode === 'load-control') return 0;
  if (mode === 'strength-control') return 1;
  if (mode === 'arc-length') return 2;
  return 3;
}

export function arcLengthDerivativeModeCode(value) {
  const mode = String(value || '').toLowerCase();
  if (mode === 'analytic') return 1;
  if (mode === 'analytic-verified') return 2;
  return 0;
}

export function arcLengthMeritModeCode(value) {
  const mode = String(value || '').toLowerCase();
  if (mode === 'quadratic') return 1;
  return 0;
}

function clampAngleRad(deg) {
  const d = Math.max(Math.min(Number(deg) || 0, 89.5), 0);
  return (d * Math.PI) / 180;
}

function computeInputSize({ numNodes, numElements, numRegions, numConstraints, numGpTotal }) {
  // Header:
  //   10 u32 (magic, version, elementKind, constitutive, analysisMode,
  //           numNodes, numElements, numRegions, numConstraints, numGpTotal) = 40
  //   12 u8 flags/modes/pad                                                   = 12
  //   7 u32 (nonlinearMaxIter, maxLoadSteps, cgMaxIter, safetyMaxSearchTrials,
  //           plasticLineSearchMaxBacktracks,
  //           initialGravityPlasticLineSearchMaxBacktracks,
  //           arcLengthLineSearchMaxBacktracks)                                = 28
  //   28 f64 (10 standard tolerances + 4 plastic continuation controls +
  //           4 line-search controls + 5 safety params +
  //           5 arc-length scaling controls)                                  = 224
  // Total header = 40 + 12 + 28 + 224 = 304 bytes
  const headerBytes = 40 + 12 + 28 + 28 * 8;
  const nodesBytes = numNodes * 2 * 8;
  const elementsBytes = numElements * (4 + 4 + 6 * 4);
  const regionsBytes = numRegions * (10 * 8 + 4 + 12 * 8);  // 180 bytes per region
  const constraintsBytes = numConstraints * 4;
  const gravityBytes = numNodes * 2 * 8;
  const loadBytes = numNodes * 2 * 8;
  const predictorBytes = numNodes * 2 * 8;
  const initialSigmaBytes = numGpTotal * 6 * 8;
  const porePressureBytes = numGpTotal * 8;
  return headerBytes + nodesBytes + elementsBytes + regionsBytes + constraintsBytes
       + gravityBytes + loadBytes + predictorBytes + initialSigmaBytes + porePressureBytes;
}

// Read an HS parameter from a region. The HS stiffness fields
// (E50_ref / Eoed_ref / Eur_ref / m / ν_ur / K0_nc) live on the MATERIAL'S
// TOP LEVEL because they are inherited from the upstream layer /
// classification model (CUR 2003-7 / SB260-21-6.4.10 / Schanz, Vermeer &
// Bonnier (1999)) and exposed read-only in the HS panel.  The HS-only
// fields (R_f, OCR, p_ref, e_init, e_max) live inside `region.hs`.
//
// Lookup order: material top-level wins, with `region.hs[name]` as a
// fallback. The fallback keeps backward compatibility with older fixtures
// and verifiers that still set the legacy `region.hs.E50_ref` shape — the
// wire layout (12 f64, name-keyed by index on the C++ side) is unchanged.
function hsParam(region, name, fallback = 0) {
  const hs = region?.hs && typeof region.hs === 'object' ? region.hs : {};
  const value = region?.[name] ?? hs[name];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function writeHsParams(writeF64, region, isHs) {
  if (!isHs) {
    for (let i = 0; i < 12; i += 1) writeF64(0);
    return;
  }
  const e50 = Math.max(hsParam(region, 'E50_ref', region?.Emc || 0), 0);
  const eoed = Math.max(hsParam(region, 'Eoed_ref', e50), 0);
  const eur = Math.max(hsParam(region, 'Eur_ref', Math.max(3 * e50, e50)), 0);
  writeF64(e50);
  writeF64(eoed);
  writeF64(eur);
  writeF64(Math.min(Math.max(hsParam(region, 'm', 0.5), 0), 1));
  writeF64(Math.min(Math.max(hsParam(region, 'nu_ur', 0.2), -0.99), 0.49));
  writeF64(Math.max(hsParam(region, 'p_ref', 100), 1e-6));
  writeF64(Math.min(Math.max(hsParam(region, 'Rf', 0.9), 1e-6), 0.999999));
  // K0_nc lives on the material as `K0nc` (Jaky-derived from φ' upstream).
  // The HS sub-block may carry an explicit `K0_nc` override that wins; if
  // neither is positive we emit 0 so the C++ side falls back to Jaky.
  const k0ncMaterial = Number(region?.K0nc);
  const k0ncHs = Number(region?.hs?.K0_nc);
  const k0ncResolved = Number.isFinite(k0ncHs) && k0ncHs > 0
    ? k0ncHs
    : (Number.isFinite(k0ncMaterial) ? k0ncMaterial : 0);
  writeF64(Math.max(k0ncResolved, 0));
  writeF64(hsParam(region, 'e_init', -1));
  writeF64(hsParam(region, 'e_max', -1));
  writeF64(Math.max(hsParam(region, 'OCR', 1), 1e-6));
  writeF64(hsParam(region, 'reserved', 0));
}

function readHsState(readF64, readU8, isHs) {
  if (!isHs) return null;
  const hs = {
    gammaP: readF64(),
    pP: readF64(),
    epsVP: readF64(),
    lastActiveSet: readU8()
  };
  for (let i = 0; i < 7; i += 1) readU8();
  return hs;
}

/**
 * Build the WASM input byte buffer.
 *
 * @param {Object} input
 * @param {Object} input.mesh
 * @param {Object} input.options
 * @param {Array<Object>} input.regions
 * @param {Float64Array} input.gravityRhsFull
 * @param {Float64Array} input.loadRhsFull
 * @param {Float64Array} input.predictorSolutionFull - length 2 * numNodes, elastic K0 predictor U
 * @param {Float64Array} input.initialSigmaByGp - length 6 * numGpTotal, Voigt-6 per GP
 * @param {Float64Array} input.porePressureByGp - length numGpTotal
 * @param {Array<number>} input.fixedDofs
 * @param {number} input.numGpTotal
 * @returns {Uint8Array}
 */
export function encodeInputBuffer({
  mesh, options, regions,
  gravityRhsFull, loadRhsFull,
  predictorSolutionFull,
  initialSigmaByGp, porePressureByGp,
  fixedDofs, numGpTotal
}) {
  const numNodes = mesh.nodes.length;
  const numElements = mesh.elements.length;
  const numRegions = regions.length;
  const numConstraints = fixedDofs.length;
  const elementKind = mesh.elementType === 't6' ? 6 : 3;
  const constitutiveU = constitutiveKindFor(options.constitutiveModel);
  const analysisModeU = analysisModeFor(
    options.analysisType,
    options.useK0Init === false ? false : options.useGeostaticInit !== false
  );

  const size = computeInputSize({ numNodes, numElements, numRegions, numConstraints, numGpTotal });
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let offset = 0;
  const writeU32 = (v) => { view.setUint32(offset, v >>> 0, true); offset += 4; };
  const writeI32 = (v) => { view.setInt32(offset, v | 0, true); offset += 4; };
  const writeU8 = (v) => { view.setUint8(offset, v & 0xFF); offset += 1; };
  const writeF64 = (v) => { view.setFloat64(offset, Number(v) || 0, true); offset += 8; };

  // Header.
  writeU32(INPUT_MAGIC);
  writeU32(WIRE_VERSION);
  writeU32(elementKind);
  writeU32(constitutiveU);
  writeU32(analysisModeU);
  writeU32(numNodes);
  writeU32(numElements);
  writeU32(numRegions);
  writeU32(numConstraints);
  writeU32(numGpTotal);
  writeU8(options.hasSurfaceLoad ? 1 : 0);
  writeU8(options.useTensionCutoff !== false ? 1 : 0);
  // Symmetrize flag: matches the JS contract where `symmetrizeEpTangent`
  // defaults to false (unsymmetric consistent tangent + scaled GMRES).
  // Set `options.symmetrizeTangent: true` to force symmetric tangent +
  // CG (legacy modified-Newton diagnostics path).
  writeU8(options.symmetrizeTangent === true ? 1 : 0);
  writeU8(elementKind === 6 && options.useBBar !== false ? 1 : 0);
  writeU8(options.useK0Init !== false ? 1 : 0);
  writeU8(options.robustNonlinearMode === true ? 1 : 0);
  writeU8(requestedContinuationModeCode(options.requestedContinuationMode));
  writeU8(arcLengthDerivativeModeCode(options.arcLengthDerivativeMode));
  writeU8(arcLengthMeritModeCode(options.arcLengthMeritMode));
  writeU8(0);
  writeU8(0);
  writeU8(0);
  writeU32(Math.max(Math.round(options.nonlinearMaxIter || 32), 1));
  writeU32(Math.max(Math.round(options.maxLoadSteps || 256), 1));
  writeU32(Math.max(Math.round(options.cgMaxIter || 25000), 1));
  writeU32(Math.max(Math.round(options.safetyMaxSearchTrials || 32), 1));
  writeU32(Math.max(Math.round(options.plasticLineSearchMaxBacktracks || 4), 1));
  writeU32(Math.max(Math.round(options.initialGravityPlasticLineSearchMaxBacktracks || 5), 1));
  writeU32(Math.max(Math.round(options.arcLengthLineSearchMaxBacktracks ?? 6), 1));
  writeF64(options.initialLoadStep ?? 0.25);
  writeF64(options.minLoadStep ?? (1 / 2048));
  writeF64(options.loadStepGrowthFactor ?? 1.25);
  writeF64(options.loadStepCutbackFactor ?? 0.5);
  writeF64(options.plasticLoadStepGrowthFactor ?? 1.05);
  writeF64(options.plasticLoadStepCutbackFactor ?? 0.4);
  writeF64(options.initialGravityPlasticLoadStepGrowthFactor ?? 1.12);
  writeF64(options.initialGravityPlasticLoadStepCutbackFactor ?? 0.5);
  writeF64(options.residualRelTol ?? 1e-4);
  writeF64(options.residualAbsTol ?? 1e-3);
  writeF64(options.displacementRelTol ?? 1e-5);
  writeF64(options.displacementAbsTol ?? 1e-8);
  writeF64(options.cgRelTol ?? 1e-5);
  writeF64(options.cgAbsTol ?? 5e-5);
  writeF64(options.plasticLineSearchReductionFactor ?? 0.5);
  writeF64(options.plasticLineSearchMinScale ?? (1 / 64));
  writeF64(options.initialGravityPlasticLineSearchMinScale ?? (1 / 32));
  writeF64(options.plasticLineSearchArmijoCoefficient ?? 1e-4);
  writeF64(options.safetyInitialIncrement ?? 0.1);
  writeF64(options.safetyGrowthFactor ?? 1.5);
  writeF64(options.safetyCutbackFactor ?? 0.5);
  writeF64(options.safetySigmaMax ?? 3.0);
  writeF64(options.safetyBracketTolerance ?? 0.01);
  writeF64(options.arcLengthDisplacementScale ?? 1.0);
  writeF64(options.arcLengthInitialRadiusScale ?? 1.0);
  writeF64(options.arcLengthMinRadiusScale ?? 1.0);
  writeF64(options.arcLengthMaxRadiusScale ?? 1.0);
  writeF64(options.arcLengthConstraintToleranceScale ?? 1.0);

  // Nodes.
  for (let i = 0; i < numNodes; i += 1) {
    writeF64(mesh.nodes[i].x);
    writeF64(mesh.nodes[i].y);
  }

  // Elements.
  for (let i = 0; i < numElements; i += 1) {
    const el = mesh.elements[i];
    const cellIndex = mesh.elementCell?.[i] ?? 0;
    const regionIndex = Math.max(0, Number(mesh.cells?.[cellIndex]?.regionIndex ?? 0));
    writeI32(regionIndex);
    writeI32(elementKind);
    for (let k = 0; k < 6; k += 1) {
      const nodeId = el?.[k];
      writeI32(Number.isInteger(nodeId) ? nodeId : -1);
    }
  }

  // Regions.
  const isHsModel = constitutiveU === CONSTITUTIVE_KIND.HardeningSoil;
  for (let i = 0; i < numRegions; i += 1) {
    const r = regions[i] || {};
    writeF64(Math.max(Number(r.Emc) || 1, 1));
    writeF64(Number.isFinite(Number(r.nu)) ? Number(r.nu) : 0.3);
    writeF64(Math.max(Number(r.cEff) || 0, 0));
    writeF64(clampAngleRad(r.phiEffDeg));
    writeF64(clampAngleRad(r.psiEffDeg));
    writeF64(Math.max(Number(r.K0nc) || 0.5, 0));
    writeF64(Math.max(Number(r.gamma) || 18, 0));
    writeF64(Math.max(Number(r.gammaSat) || Number(r.gamma) || 20, 0));
    writeF64(Math.max(Number(r.sigmaTAllow) || 0, 0));
    writeF64(Math.min(Math.max(Number(r.rShear) || 0.25, 1e-3), 1));
    writeU8(r.useTensionCutoff !== false ? 1 : 0);
    writeU8(r.symmetrizeEpTangent === true ? 1 : 0);
    writeU8(0);
    writeU8(0);
    writeHsParams(writeF64, r, isHsModel);
  }

  // Constraints.
  for (let i = 0; i < numConstraints; i += 1) writeI32(fixedDofs[i] | 0);

  // Gravity RHS (full DOF).
  for (let i = 0; i < 2 * numNodes; i += 1) writeF64(gravityRhsFull?.[i] || 0);
  // Surface load RHS (full DOF).
  for (let i = 0; i < 2 * numNodes; i += 1) writeF64(loadRhsFull?.[i] || 0);
  // Elastic K0 predictor displacement (full DOF). WASM solves correction
  // displacements, but constitutive strain is evaluated at predictor + correction.
  for (let i = 0; i < 2 * numNodes; i += 1) writeF64(predictorSolutionFull?.[i] || 0);
  // Initial sigma (per GP, Voigt-6).
  for (let i = 0; i < 6 * numGpTotal; i += 1) writeF64(initialSigmaByGp?.[i] || 0);
  // Pore pressure (per GP).
  for (let i = 0; i < numGpTotal; i += 1) writeF64(porePressureByGp?.[i] || 0);

  return new Uint8Array(buffer);
}

/**
 * Decode the WASM output buffer (v2).
 */
export function decodeOutputBuffer(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readU32 = () => { const v = view.getUint32(offset, true); offset += 4; return v; };
  const readI32 = () => { const v = view.getInt32(offset, true); offset += 4; return v; };
  const readU16 = () => { const v = view.getUint16(offset, true); offset += 2; return v; };
  const readU8  = () => { const v = view.getUint8(offset); offset += 1; return v; };
  const readF64 = () => { const v = view.getFloat64(offset, true); offset += 8; return v; };

  const magic = readU32();
  const version = readU32();
  if (
    magic !== OUTPUT_MAGIC ||
    (version !== WIRE_VERSION &&
      version !== SAFETY_HISTORY_OUTPUT_WIRE_VERSION &&
      version !== LEGACY_OUTPUT_WIRE_VERSION)
  ) {
    throw new Error(`WASM output header mismatch (magic=${magic.toString(16)}, version=${version}).`);
  }
  const numNodes = readU32();
  const numElements = readU32();
  const numGpTotal = readU32();

  // Summary: 10 i32 + 5 f64 + 4 u8 (converged flags + hasHsPayload) +
  // 2 u8 (Phase 7 dispatch telemetry) + 2 u8 reserved pad.
  const summary = {
    loadStepsAccepted: readI32(),
    loadStepsRejected: readI32(),
    newtonIterations: readI32(),
    cgIterations: readI32(),
    finalActiveCount: readI32(),
    finalTensionCount: readI32(),
    geostaticAccepted: readI32(),
    geostaticRejected: readI32(),
    serviceAccepted: readI32(),
    serviceRejected: readI32(),
    finalLoadFactor: readF64(),
    geostaticLoadFactor: readF64(),
    residualNorm: readF64(),
    maxEta: readF64(),
    elapsedMs: readF64(),
    geostaticConverged: readU8() === 1,
    serviceConverged: readU8() === 1,
    safetyRan: readU8() === 1
  };
  const hasHsPayload = version >= 10 ? readU8() === 1 : (readU8(), false);
  // Phase 7 (hardening-soil-fix.md §Phase 7): linear-solver dispatch
  // telemetry. `lastLinearSolverKind` is 0=CG, 1=GMRES for the last
  // global Newton iteration of the last completed phase.
  // `hsPlasticUsedGmres` is a sticky flag: 1 iff any HS plastic
  // Newton iteration in the run dispatched to GMRES.
  summary.lastLinearSolverKind = readU8();
  summary.hsPlasticUsedGmres = readU8() === 1;
  // 2 trailing reserved pad bytes.
  for (let i = 0; i < 2; i += 1) readU8();

  const serviceDisp = new Float64Array(numNodes * 2);
  for (let i = 0; i < numNodes; i += 1) {
    serviceDisp[2 * i + 0] = readF64();
    serviceDisp[2 * i + 1] = readF64();
  }
  const geostaticDisp = new Float64Array(numNodes * 2);
  for (let i = 0; i < numNodes; i += 1) {
    geostaticDisp[2 * i + 0] = readF64();
    geostaticDisp[2 * i + 1] = readF64();
  }

  const gpStates = new Array(numGpTotal);
  for (let gp = 0; gp < numGpTotal; gp += 1) {
    const state = {
      stress: {
        sxx: readF64(), syy: readF64(), szz: readF64(),
        sxy: readF64(), syz: readF64(), sxz: readF64()
      },
      plasticStrain: {
        exx: readF64(), eyy: readF64(), ezz: readF64(),
        exy: readF64(), eyz: readF64(), exz: readF64()
      },
      accumulatedPlasticStrain: readF64(),
      eta: readF64(),
      referenceStress: {
        sxx: readF64(), syy: readF64(), szz: readF64(),
        sxy: readF64(), syz: readF64(), sxz: readF64()
      },
      geostaticStress: {
        sxx: readF64(), syy: readF64(), szz: readF64(),
        sxy: readF64(), syz: readF64(), sxz: readF64()
      },
      geostaticPlasticStrain: {
        exx: readF64(), eyy: readF64(), ezz: readF64(),
        exy: readF64(), eyz: readF64(), exz: readF64()
      },
      geostaticAccumulatedPlasticStrain: readF64(),
      comparisonAccumulatedPlasticStrain: readF64(),
      porePressure: readF64(),
      plasticActive: readU8() === 1,
      tensionActive: readU8() === 1,
      plasticEverActive: readU8() === 1
    };
    readU8();
    state.hs = readHsState(readF64, readU8, hasHsPayload);
    gpStates[gp] = state;
  }

  const wireStatus = readU8();
  for (let i = 0; i < 7; i += 1) readU8();
  const safetyFosLower = readF64();
  const safetyFosUpper = readF64();
  const safetyStrengthRetained = readF64();
  const safetyTrialCount = readI32();
  const safetyTotalNewton = readI32();
  const safetyCurveCount = version >= 7 ? readI32() : 0;
  if (version >= 7) readI32();
  const safetyTrials = new Array(safetyTrialCount);
  const safetyTrialTargets = version >= 7 ? new Array(safetyTrialCount) : [];
  for (let i = 0; i < safetyTrialCount; i += 1) {
    if (version >= 7) {
      const sigmaMsfStart = readF64();
      const sigmaMsfTarget = readF64();
      const sigmaMsfCommitted = readF64();
      const iterations = readI32();
      const failureCode = readU16();
      const converged = readU8() === 1;
      const trialOutcome = readU8();
      const displayed = readU8() === 1;
      for (let pad = 0; pad < 7; pad += 1) readU8();
      const trial = {
        index: i,
        sigmaMsfStart,
        sigmaMsfTarget,
        sigmaMsfCommitted,
        target: sigmaMsfTarget,
        committed: sigmaMsfCommitted,
        iterations,
        converged,
        trialOutcome,
        failureCode,
        displayed
      };
      safetyTrials[i] = trial;
      safetyTrialTargets[i] = trial;
    } else {
      safetyTrials[i] = {
        target: readF64(),
        committed: readF64(),
        iterations: readI32(),
        converged: readU8() === 1
      };
      readU8(); readU8(); readU8();
    }
  }

  const safetyCurve = new Array(safetyCurveCount);
  for (let i = 0; i < safetyCurveCount; i += 1) {
    const trialIndex = readI32();
    const continuationStepIndex = readI32();
    const nonlinearIterations = readI32();
    const linearIterations = readI32();
    const activeCount = readI32();
    const activeFaceCount = readI32();
    const activeEdgeCount = readI32();
    const activeApexCount = readI32();
    const tensionCount = readI32();
    const dominantNode = readI32();
    const dominantDof = readI32();
    const activePlasticElementCount = readI32();
    const sigmaMsf = readF64();
    const lambda = readF64();
    const initialResidualNorm = readF64();
    const residualNorm = readF64();
    const relativeResidual = readF64();
    const lineSearchAcceptedScale = readF64();
    const uMaxAbs = readF64();
    const uNorm = readF64();
    const uSettlementMax = readF64();
    const uHorizontalMax = readF64();
    const maxDeltaPlasticStrain = readF64();
    const totalDeltaPlasticStrain = readF64();
    const mechanismScoreRaw = readF64();
    let actualContinuationModeCode = 1;
    let arcLengthDetails = null;
    if (version >= 8) {
      actualContinuationModeCode = readU8();
      const hasArcLengthDetails = readU8() === 1;
      const failureCode = readU16();
      const linearSolveCount = readI32();
      const deltaLambda = readF64();
      const deltaS = readF64();
      const alpha = readF64();
      const constraintResidual = readF64();
      const correctionDenominator = readF64();
      if (hasArcLengthDetails) {
        arcLengthDetails = {
          actualContinuationMode: 'arc-length',
          deltaLambda,
          deltaS,
          alpha,
          constraintResidual,
          linearSolveCount,
          correctionDenominator,
          failureCode
        };
      }
    }
    if (arcLengthDetails === null && actualContinuationModeCode === 2) {
      throw new Error('WASM safety curve invariant violated: arc-length point has no details.');
    }
    if (arcLengthDetails !== null && actualContinuationModeCode !== 2) {
      throw new Error('WASM safety curve invariant violated: non-arc point has arc-length details.');
    }
    safetyCurve[i] = {
      index: i,
      trialIndex,
      continuationStepIndex,
      sigmaMsf,
      lambda,
      converged: true,
      initialResidualNorm,
      residualNorm,
      relativeResidual,
      nonlinearIterations,
      linearIterations,
      lineSearchAcceptedScale,
      activeCount,
      activeFaceCount,
      activeEdgeCount,
      activeApexCount,
      tensionCount,
      uMaxAbs,
      uNorm,
      uSettlementMax,
      uHorizontalMax,
      dominantNode,
      dominantDof,
      activePlasticElementCount,
      maxDeltaPlasticStrain,
      totalDeltaPlasticStrain,
      mechanismScore: Number.isFinite(mechanismScoreRaw) ? mechanismScoreRaw : null,
      arcLengthDetails
    };
  }

  const finalizationStatus = SAFETY_FINALIZATION_STATUS_BY_WIRE[wireStatus] || 'numerical-nonconvergence';
  const factorOfSafetyUpper = wireStatus === 3 ? null : safetyFosUpper;
  const bracketWidth = factorOfSafetyUpper !== null
    ? Math.max(0, safetyFosUpper - safetyFosLower)
    : null;
  const emptyMechanism = {
    status: 'none',
    score: 0,
    threshold: 0.65,
    maxDeltaPlasticStrain: 0,
    totalDeltaPlasticStrain: 0,
    activePlasticPointCount: 0,
    activePlasticElementCount: 0,
    connectedComponentCount: 0,
    largestConnectedComponentElementCount: 0,
    largestConnectedComponentPlasticMass: 0,
    componentMassRatio: 0,
    mechanismLength: 0,
    plasticGrowthOverWindow: 0,
    mechanismTouchesLoadedZone: false,
    mechanismTouchesFreeSurface: false,
    mechanismTouchesBoundary: false,
    mechanismCrossesSlopeOrFoundationZone: false,
    displacementDirectionCoherence: 0
  };
  const safetyResult = {
    finalizationMode: 'legacy-bracket',
    finalization: {
      status: summary.safetyRan ? finalizationStatus : 'not-run',
      factorOfSafety: safetyFosLower,
      factorOfSafetyLower: safetyFosLower,
      factorOfSafetyUpper,
      factorOfSafetyIsOpenEnded: wireStatus === 3,
      bracketWidth,
      strengthRetained: safetyStrengthRetained,
      displayedSigmaMsf: safetyFosLower,
      plateauDetected: false,
      plateauWindowStart: null,
      plateauWindowEnd: null
    },
    mechanism: emptyMechanism,
    curve: summary.safetyRan ? safetyCurve : [],
    trialTargets: summary.safetyRan ? safetyTrialTargets : []
  };

  return {
    numNodes,
    numElements,
    numGpTotal,
    summary,
    hasHsPayload,
    serviceDisplacements: serviceDisp,
    geostaticDisplacements: geostaticDisp,
    displacements: serviceDisp,  // alias for backward-compat
    gpStates,
    safety: {
      status: wireStatus,
      statusLabel: SAFETY_WIRE_LABELS[wireStatus] || 'unknown',
      ran: summary.safetyRan,
      factorOfSafetyLower: safetyFosLower,
      factorOfSafetyUpper: safetyFosUpper,
      strengthRetained: safetyStrengthRetained,
      trialCount: safetyTrialCount,
      totalNewtonIterations: safetyTotalNewton,
      trials: safetyTrials,
      curve: summary.safetyRan ? safetyCurve : [],
      trialTargets: summary.safetyRan ? safetyTrialTargets : [],
      safetyResult
    }
  };
}

export const WASM_INPUT_MAGIC = INPUT_MAGIC;
export const WASM_OUTPUT_MAGIC = OUTPUT_MAGIC;
export const WASM_WIRE_VERSION = WIRE_VERSION;
