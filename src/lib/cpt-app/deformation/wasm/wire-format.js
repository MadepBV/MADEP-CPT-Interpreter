// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Wire-format encoder/decoder shared between the JS bridge and the C++
// WASM module. Both sides MUST agree on this layout exactly; the C++
// reader lives in deformation_wasm.cpp. Wire version 5.

const INPUT_MAGIC = 0x4D434454; // 'TDCM'
const OUTPUT_MAGIC = 0x4D444B54; // 'TDKM'
const WIRE_VERSION = 5;

export const CONSTITUTIVE_KIND = Object.freeze({
  LinearElastic: 0,
  McReducedStiffness: 1,
  McPlastic: 2
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
  return CONSTITUTIVE_KIND.McReducedStiffness;
}

export function analysisModeFor(analysisType, hasGeostatic) {
  if (analysisType === 'safety-cphi') return ANALYSIS_MODE.GeostaticServiceSafety;
  if (hasGeostatic) return ANALYSIS_MODE.GeostaticPlusService;
  return ANALYSIS_MODE.ServiceOnly;
}

function clampAngleRad(deg) {
  const d = Math.max(Math.min(Number(deg) || 0, 89.5), 0);
  return (d * Math.PI) / 180;
}

function computeInputSize({ numNodes, numElements, numRegions, numConstraints, numGpTotal }) {
  // Header:
  //   10 u32 (magic, version, elementKind, constitutive, analysisMode,
  //           numNodes, numElements, numRegions, numConstraints, numGpTotal) = 40
  //   8 u8 flags                                                              = 8
  //   6 u32 (nonlinearMaxIter, maxLoadSteps, cgMaxIter, safetyMaxSearchTrials,
  //           plasticLineSearchMaxBacktracks,
  //           initialGravityPlasticLineSearchMaxBacktracks)                    = 24
  //   23 f64 (10 standard tolerances + 4 plastic continuation controls +
  //           4 line-search controls + 5 safety params)                       = 184
  // Total header = 40 + 8 + 24 + 184 = 256 bytes
  const headerBytes = 40 + 8 + 24 + 23 * 8;
  const nodesBytes = numNodes * 2 * 8;
  const elementsBytes = numElements * (4 + 4 + 6 * 4);
  const regionsBytes = numRegions * (10 * 8 + 4);  // 84 bytes per region
  const constraintsBytes = numConstraints * 4;
  const gravityBytes = numNodes * 2 * 8;
  const loadBytes = numNodes * 2 * 8;
  const predictorBytes = numNodes * 2 * 8;
  const initialSigmaBytes = numGpTotal * 6 * 8;
  const porePressureBytes = numGpTotal * 8;
  return headerBytes + nodesBytes + elementsBytes + regionsBytes + constraintsBytes
       + gravityBytes + loadBytes + predictorBytes + initialSigmaBytes + porePressureBytes;
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
  writeU8(0); writeU8(0);
  writeU32(Math.max(Math.round(options.nonlinearMaxIter || 32), 1));
  writeU32(Math.max(Math.round(options.maxLoadSteps || 256), 1));
  writeU32(Math.max(Math.round(options.cgMaxIter || 25000), 1));
  writeU32(Math.max(Math.round(options.safetyMaxSearchTrials || 32), 1));
  writeU32(Math.max(Math.round(options.plasticLineSearchMaxBacktracks || 4), 1));
  writeU32(Math.max(Math.round(options.initialGravityPlasticLineSearchMaxBacktracks || 5), 1));
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
  const readU8  = () => { const v = view.getUint8(offset); offset += 1; return v; };
  const readF64 = () => { const v = view.getFloat64(offset, true); offset += 8; return v; };

  const magic = readU32();
  const version = readU32();
  if (magic !== OUTPUT_MAGIC || version !== WIRE_VERSION) {
    throw new Error(`WASM output header mismatch (magic=${magic.toString(16)}, version=${version}).`);
  }
  const numNodes = readU32();
  const numElements = readU32();
  const numGpTotal = readU32();

  // Summary: 10 i32 + 5 f64 + 4 u8 + 4 u8 pad.
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
  for (let i = 0; i < 5; i += 1) readU8();

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
      porePressure: readF64(),
      plasticActive: readU8() === 1,
      tensionActive: readU8() === 1,
      plasticEverActive: readU8() === 1
    };
    readU8();
    gpStates[gp] = state;
  }

  const safetyStatus = readU8();
  for (let i = 0; i < 7; i += 1) readU8();
  const safetyFosLower = readF64();
  const safetyFosUpper = readF64();
  const safetyStrengthRetained = readF64();
  const safetyTrialCount = readI32();
  const safetyTotalNewton = readI32();
  const safetyTrials = new Array(safetyTrialCount);
  for (let i = 0; i < safetyTrialCount; i += 1) {
    safetyTrials[i] = {
      target: readF64(),
      committed: readF64(),
      iterations: readI32(),
      converged: readU8() === 1
    };
    readU8(); readU8(); readU8();
  }

  return {
    numNodes,
    numElements,
    numGpTotal,
    summary,
    serviceDisplacements: serviceDisp,
    geostaticDisplacements: geostaticDisp,
    displacements: serviceDisp,  // alias for backward-compat
    gpStates,
    safety: {
      status: safetyStatus,
      statusLabel: ['not-run', 'bracketed', 'mechanism', 'no-failure-found'][safetyStatus] || 'unknown',
      ran: summary.safetyRan,
      factorOfSafetyLower: safetyFosLower,
      factorOfSafetyUpper: safetyFosUpper,
      strengthRetained: safetyStrengthRetained,
      trialCount: safetyTrialCount,
      totalNewtonIterations: safetyTotalNewton,
      trials: safetyTrials
    }
  };
}

export const WASM_INPUT_MAGIC = INPUT_MAGIC;
export const WASM_OUTPUT_MAGIC = OUTPUT_MAGIC;
export const WASM_WIRE_VERSION = WIRE_VERSION;
