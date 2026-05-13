#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Single-Gauss-point JS CPU vs C++ WASM MC plastic parity harness.
// This checks the constitutive update in isolation, before global Newton,
// element assembly, or continuation can hide a branch/state mismatch.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  createMCPlasticMaterial,
  createMaterialPointState
} from '../src/lib/cpt-app/deformation/material-models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const LOCAL_IN_MAGIC = 0x504c434d;  // MCLP
const LOCAL_OUT_MAGIC = 0x4f4c434d; // MCLO
const VERSION = 1;

const BRANCH_TO_CODE = new Map([
  ['ELASTIC', 0],
  ['MC_FACE_F13', 1],
  ['MC_EDGE_S23_EQUAL', 2],
  ['MC_EDGE_S12_EQUAL', 3],
  ['MC_APEX_FORMAL', 4],
  ['MC_TENSION_PENDING', 5],
  ['TENSION_FACE_T3', 6],
  ['TENSION_EDGE_T23', 7],
  ['TENSION_EDGE_F13_T3', 8],
  ['TENSION_CORNER_S23_T3', 9],
  ['TENSION_CORNER_S12_T3', 10],
  ['TENSION_APEX_T123', 11],
  ['MC_FALLBACK_SMOOTH', 12]
]);
const CODE_TO_BRANCH = Array.from(BRANCH_TO_CODE.entries()).reduce((out, [label, code]) => {
  out[code] = label;
  return out;
}, []);

const MULT_TO_CODE = new Map([
  ['DISTINCT', 0],
  ['S23_EQUAL', 1],
  ['S12_EQUAL', 2],
  ['TRIPLE', 3],
  ['ALL_EQUAL', 3]
]);
const CODE_TO_MULT = ['DISTINCT', 'S23_EQUAL', 'S12_EQUAL', 'TRIPLE'];
const MODE_TO_CODE = new Map([
  ['elastic', 0],
  ['exact-active-set', 1],
  ['smooth-fallback', 2]
]);
const CODE_TO_MODE = ['elastic', 'exact-active-set', 'smooth-fallback'];

const material = Object.freeze({
  Emc: 30000,
  nu: 0.3,
  cEff: 8,
  phiEffDeg: 30,
  psiEffDeg: 5,
  sigmaTAllow: 0,
  useTensionCutoff: true,
  symmetrizeEpTangent: false
});

async function loadWasm() {
  const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function zero6() {
  return [0, 0, 0, 0, 0, 0];
}

function identityProjectors() {
  return {
    P1: [[1, 0, 0], [0, 0, 0], [0, 0, 0]],
    P2: [[0, 0, 0], [0, 1, 0], [0, 0, 0]],
    P3: [[0, 0, 0], [0, 0, 0], [0, 0, 1]]
  };
}

function normaliseProjectors(projectors) {
  return projectors || identityProjectors();
}

function writeState(writer, state) {
  const source = createMaterialPointState(state);
  writer.f64s(source.totalStrain6 || zero6());
  writer.f64s(source.plasticStrain6 || zero6());
  writer.f64s(source.effectiveStress6 || zero6());
  writer.f64(Number(source.accumulatedPlasticStrain) || 0);
  writer.u8(source.currentlyMcActive === true ? 1 : 0);
  writer.u8(source.hasEverExceededMc === true ? 1 : 0);
  writer.u8(source.activeYieldSurface === 'TENSION' ? 1 : 0);
  writer.u8(MODE_TO_CODE.get(source.localReturnMode || 'elastic') ?? 0);
  writer.u8(BRANCH_TO_CODE.get(source.exactBranchKind || 'ELASTIC') ?? 0);
  writer.u8(MULT_TO_CODE.get(source.multiplicityKind || 'DISTINCT') ?? 0);
  const projectors = normaliseProjectors(source.representativeProjectors);
  writer.u8(source.representativeProjectors ? 1 : 0);
  writer.u8(source.currentlyMcActive === true ? 1 : 0);
  writer.u8(source.localFallbackUsed === true ? 1 : 0);
  writer.u8(0); writer.u8(0); writer.u8(0);
  for (const key of ['P1', 'P2', 'P3']) {
    for (const row of projectors[key]) writer.f64s(row);
  }
}

function encodeLocalInput({ strainTrial6, committedState, previousTrialState = null }) {
  const bytes = [];
  const scratch = new ArrayBuffer(8);
  const view = new DataView(scratch);
  const writer = {
    u32(value) {
      view.setUint32(0, value >>> 0, true);
      bytes.push(...new Uint8Array(scratch, 0, 4));
    },
    u8(value) {
      bytes.push(value & 0xff);
    },
    f64(value) {
      view.setFloat64(0, Number(value) || 0, true);
      bytes.push(...new Uint8Array(scratch, 0, 8));
    },
    f64s(values) {
      for (const value of values) writer.f64(value);
    }
  };
  writer.u32(LOCAL_IN_MAGIC);
  writer.u32(VERSION);
  writer.f64(material.Emc);
  writer.f64(material.nu);
  writer.f64(material.cEff);
  writer.f64(material.phiEffDeg);
  writer.f64(material.psiEffDeg);
  writer.f64(material.sigmaTAllow);
  writer.u8(material.useTensionCutoff !== false ? 1 : 0);
  writer.u8(material.symmetrizeEpTangent === true ? 1 : 0);
  writer.u8(previousTrialState ? 1 : 0);
  writer.u8(0);
  writeState(writer, committedState);
  if (previousTrialState) writeState(writer, previousTrialState);
  writer.f64s(strainTrial6);
  return Uint8Array.from(bytes);
}

function decodeLocalOutput(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const u32 = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const u8 = () => bytes[offset++];
  const f64 = () => {
    const value = view.getFloat64(offset, true);
    offset += 8;
    return value;
  };
  const vec6 = () => Array.from({ length: 6 }, f64);
  const mat6 = () => Array.from({ length: 6 }, () => vec6());
  const projectors = () => {
    const readP = () => Array.from({ length: 3 }, () => Array.from({ length: 3 }, f64));
    return { P1: readP(), P2: readP(), P3: readP() };
  };
  const magic = u32();
  const version = u32();
  if (magic !== LOCAL_OUT_MAGIC || version !== VERSION) {
    throw new Error(`Bad local MC output header: magic=${magic.toString(16)} version=${version}`);
  }
  return {
    stress6: vec6(),
    plasticStrainIncrement6: vec6(),
    tangent6x6: mat6(),
    eta: f64(),
    equivalentPlasticIncrement: f64(),
    plasticActive: u8() !== 0,
    tensionActive: u8() !== 0,
    exactBranchKind: CODE_TO_BRANCH[u8()] || 'UNKNOWN',
    multiplicityKind: CODE_TO_MULT[u8()] || 'UNKNOWN',
    hasRepresentativeProjectors: u8() !== 0,
    localReturnMode: CODE_TO_MODE[u8()] || 'unknown',
    localFallbackUsed: u8() !== 0,
    stateChanged: u8() !== 0,
    representativeProjectors: projectors()
  };
}

function runWasmLocal(mod, input) {
  const inputBytes = encodeLocalInput(input);
  const inputPtr = mod._malloc(inputBytes.byteLength);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    mod.HEAPU8.set(inputBytes, inputPtr);
    const status = mod._madepRunMcPlasticMaterialPoint(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    if (!status) throw new Error(mod.UTF8ToString(mod._madepGetLastErrorMessage()));
    const outPtr = mod.HEAPU32[outPtrSlot >> 2];
    const outLen = mod.HEAPU32[outLenSlot >> 2];
    const outBytes = new Uint8Array(outLen);
    outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._madepFreeBuffer(outPtr);
    return decodeLocalOutput(outBytes);
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

function runJsLocal(input) {
  const update = createMCPlasticMaterial(material).update({
    strainTrial6: input.strainTrial6,
    committedState: input.committedState,
    analysisContext: input.previousTrialState ? { previousTrialState: input.previousTrialState } : null
  });
  return {
    stress6: update.trialState.effectiveStress6,
    plasticStrainIncrement6: update.trialState.plasticStrain6.map((value, index) =>
      value - (input.committedState.plasticStrain6?.[index] || 0)),
    tangent6x6: update.tangent6x6,
    eta: update.diagnostics.etaMcFinal,
    equivalentPlasticIncrement: update.trialState.accumulatedPlasticStrain - (input.committedState.accumulatedPlasticStrain || 0),
    plasticActive: update.trialState.currentlyMcActive === true,
    tensionActive: update.diagnostics.tensionCutoffActive === true,
    exactBranchKind: update.trialState.exactBranchKind,
    multiplicityKind: update.trialState.multiplicityKind,
    hasRepresentativeProjectors: !!update.trialState.representativeProjectors,
    localReturnMode: update.trialState.localReturnMode,
    localFallbackUsed: update.trialState.localFallbackUsed === true,
    representativeProjectors: update.trialState.representativeProjectors
  };
}

function maxAbsDiff(a, b) {
  let max = 0;
  const walk = (x, y) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < x.length; i += 1) walk(x[i], y[i]);
      return;
    }
    const dx = Number(x);
    const dy = Number(y);
    if (Number.isFinite(dx) && Number.isFinite(dy)) max = Math.max(max, Math.abs(dx - dy));
  };
  walk(a, b);
  return max;
}

function makeCommitted(effectiveStress6, overrides = {}) {
  return createMaterialPointState({
    totalStrain6: zero6(),
    plasticStrain6: zero6(),
    effectiveStress6,
    activeYieldSurface: 'NONE',
    exactBranchKind: 'ELASTIC',
    multiplicityKind: 'DISTINCT',
    representativeProjectors: null,
    localReturnMode: 'elastic',
    localFallbackUsed: false,
    currentlyMcActive: false,
    hasEverExceededMc: false,
    ...overrides
  });
}

function stressFromCompressionPrincipal(s1, s2, s3, txy = 0) {
  return [-s1, -s2, -s3, -txy, 0, 0];
}

function* deterministicCases() {
  const cases = [
    ['elastic-compression', stressFromCompressionPrincipal(120, 90, 80)],
    ['face-f13', stressFromCompressionPrincipal(160, 95, 20)],
    ['lower-edge-s23', stressFromCompressionPrincipal(160, 35, 34.999999)],
    ['upper-edge-s12', stressFromCompressionPrincipal(120.000001, 120, 10)],
    ['near-apex', stressFromCompressionPrincipal(25.000001, 25, 24.999999)],
    ['tension-face', stressFromCompressionPrincipal(80, 45, -6)],
    ['tension-edge-f13', stressFromCompressionPrincipal(130, 40, -8)],
    ['tension-lower-repeated', stressFromCompressionPrincipal(70, -5, -5.0000001)],
    ['shear-with-shear-component', stressFromCompressionPrincipal(120, 80, 25, 12)]
  ];
  for (const [name, stress] of cases) {
    yield { name, committedState: makeCommitted(stress), strainTrial6: zero6() };
  }

  const activeCommitted = makeCommitted(stressFromCompressionPrincipal(160, 95, 20), {
    activeYieldSurface: 'MC_FACE',
    exactBranchKind: 'MC_FACE_F13',
    multiplicityKind: 'DISTINCT',
    representativeProjectors: identityProjectors(),
    localReturnMode: 'exact-active-set',
    currentlyMcActive: true,
    hasEverExceededMc: true
  });
  yield {
    name: 'active-retention-face',
    committedState: activeCommitted,
    previousTrialState: activeCommitted,
    strainTrial6: zero6()
  };
}

function* randomCases(count) {
  let seed = 0x12345678;
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < count; i += 1) {
    const s1 = -20 + rand() * 220;
    const s2 = -20 + rand() * 220;
    const s3 = -20 + rand() * 220;
    const sorted = [s1, s2, s3].sort((a, b) => b - a);
    const txy = (rand() - 0.5) * 50;
    yield {
      name: `random-${i}`,
      committedState: makeCommitted(stressFromCompressionPrincipal(sorted[0], sorted[1], sorted[2], txy)),
      strainTrial6: zero6()
    };
  }
}

function* randomIncrementCases(count) {
  let seed = 0xdecafbad;
  const rand = () => {
    seed = (1103515245 * seed + 12345) >>> 0;
    return seed / 0x100000000;
  };
  const baseStates = [
    makeCommitted(stressFromCompressionPrincipal(100, 70, 55)),
    makeCommitted(stressFromCompressionPrincipal(160, 90, 35), {
      activeYieldSurface: 'MC_FACE',
      exactBranchKind: 'MC_FACE_F13',
      multiplicityKind: 'DISTINCT',
      representativeProjectors: identityProjectors(),
      localReturnMode: 'exact-active-set',
      currentlyMcActive: true,
      hasEverExceededMc: true
    }),
    makeCommitted(stressFromCompressionPrincipal(95, 30, 30), {
      activeYieldSurface: 'MC_EDGE',
      exactBranchKind: 'MC_EDGE_S23_EQUAL',
      multiplicityKind: 'S23_EQUAL',
      representativeProjectors: identityProjectors(),
      localReturnMode: 'exact-active-set',
      currentlyMcActive: true,
      hasEverExceededMc: true
    })
  ];
  for (let i = 0; i < count; i += 1) {
    const committedState = baseStates[i % baseStates.length];
    const strainTrial6 = [
      (rand() - 0.75) * 0.01,
      (rand() - 0.75) * 0.01,
      0,
      (rand() - 0.5) * 0.012,
      0,
      0
    ];
    yield {
      name: `random-increment-${i}`,
      committedState,
      previousTrialState: i % 3 === 0 ? committedState : null,
      strainTrial6
    };
  }
}

function compareCase(name, js, wasm) {
  const branchOk = js.exactBranchKind === wasm.exactBranchKind;
  const modeOk = js.localReturnMode === wasm.localReturnMode;
  const plasticOk = js.plasticActive === wasm.plasticActive && js.tensionActive === wasm.tensionActive;
  const stressDiff = maxAbsDiff(js.stress6, wasm.stress6);
  const plasticDiff = maxAbsDiff(js.plasticStrainIncrement6, wasm.plasticStrainIncrement6);
  const tangentDiff = maxAbsDiff(js.tangent6x6, wasm.tangent6x6);
  const hardFail = !branchOk || !modeOk || !plasticOk || stressDiff > 1e-7 || plasticDiff > 1e-10 || tangentDiff > 1e-5;
  if (!hardFail) return null;
  return {
    name,
    branch: [js.exactBranchKind, wasm.exactBranchKind],
    mode: [js.localReturnMode, wasm.localReturnMode],
    plastic: [js.plasticActive, wasm.plasticActive],
    tension: [js.tensionActive, wasm.tensionActive],
    stressDiff,
    plasticDiff,
    tangentDiff,
    jsStress: js.stress6,
    wasmStress: wasm.stress6
  };
}

async function main() {
  const mod = await loadWasm();
  const failures = [];
  const cases = [...deterministicCases(), ...randomCases(300), ...randomIncrementCases(300)];
  for (const input of cases) {
    let js;
    let wasm;
    try {
      js = runJsLocal(input);
      wasm = runWasmLocal(mod, input);
    } catch (error) {
      failures.push({ name: input.name, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const failure = compareCase(input.name, js, wasm);
    if (failure) failures.push(failure);
    if (failures.length >= 12) break;
  }

  if (failures.length) {
    console.error(`FAIL: ${failures.length} local MC parity mismatch(es).`);
    console.error(JSON.stringify(failures, null, 2));
    process.exit(1);
  }
  console.log(`PASS: ${cases.length} JS/WASM local MC material updates match branch, stress, plastic increment, and tangent tolerances.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
