#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH-1 verifier: live WASM MC dispatch exposes an explicit
// consistent-tangent selector. With the selector ON, the local tangent must
// match a central finite-difference derivative of the exact stress return.
// With it OFF, the same stress return must use the elastic modified-Newton
// tangent.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

const LOCAL_IN_MAGIC = 0x504c434d;
const LOCAL_OUT_MAGIC = 0x4f4c434d;
const VERSION = 1;
const PLANE = [0, 1, 3];

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
const CODE_TO_MODE = ['elastic', 'exact-active-set', 'smooth-fallback'];

const material = Object.freeze({
  Emc: 30000,
  nu: 0.3,
  cEff: 8,
  phiEffDeg: 32,
  psiEffDeg: 7,
  sigmaTAllow: 0,
  useTensionCutoff: false,
  symmetrizeEpTangent: false
});

function elastic6(E, nu) {
  const g = E / (2 * (1 + nu));
  const k = E / (3 * (1 - 2 * nu));
  const l = k - (2 * g) / 3;
  return [
    [l + 2 * g, l, l, 0, 0, 0],
    [l, l + 2 * g, l, 0, 0, 0],
    [l, l, l + 2 * g, 0, 0, 0],
    [0, 0, 0, g, 0, 0],
    [0, 0, 0, 0, g, 0],
    [0, 0, 0, 0, 0, g]
  ];
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

function makeState(effectiveStress6) {
  return {
    totalStrain6: zero6(),
    plasticStrain6: zero6(),
    effectiveStress6,
    accumulatedPlasticStrain: 0,
    plasticActive: 0,
    plasticEverActive: 0,
    tensionActive: 0,
    localReturnMode: 0,
    exactBranchKind: 0,
    multiplicityKind: 0,
    hasRepresentativeProjectors: 0,
    currentlyMcActive: 0,
    localFallbackUsed: 0,
    representativeProjectors: identityProjectors()
  };
}

function encodeState(writer, state) {
  writer.f64s(state.totalStrain6);
  writer.f64s(state.plasticStrain6);
  writer.f64s(state.effectiveStress6);
  writer.f64(state.accumulatedPlasticStrain);
  writer.u8(state.plasticActive);
  writer.u8(state.plasticEverActive);
  writer.u8(state.tensionActive);
  writer.u8(state.localReturnMode);
  writer.u8(state.exactBranchKind);
  writer.u8(state.multiplicityKind);
  writer.u8(state.hasRepresentativeProjectors);
  writer.u8(state.currentlyMcActive);
  writer.u8(state.localFallbackUsed);
  writer.u8(0); writer.u8(0); writer.u8(0);
  for (const key of ['P1', 'P2', 'P3']) {
    for (const row of state.representativeProjectors[key]) writer.f64s(row);
  }
}

function encodeLocalInput({ committedState, strainTrial6, useConsistentTangent }) {
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
  writer.u8(0);
  writer.u8(useConsistentTangent ? 1 : 0);
  encodeState(writer, committedState);
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
  const magic = u32();
  const version = u32();
  assert.equal(magic, LOCAL_OUT_MAGIC, 'bad MC local output magic');
  assert.equal(version, VERSION, 'bad MC local output version');
  return {
    stress6: vec6(),
    plasticStrainIncrement6: vec6(),
    tangent6x6: mat6(),
    eta: f64(),
    equivalentPlasticIncrement: f64(),
    plasticActive: u8() !== 0,
    tensionActive: u8() !== 0,
    exactBranchKind: CODE_TO_BRANCH[u8()] || 'UNKNOWN',
    multiplicityKind: u8(),
    hasRepresentativeProjectors: u8() !== 0,
    localReturnMode: CODE_TO_MODE[u8()] || 'unknown',
    localFallbackUsed: u8() !== 0,
    stateChanged: u8() !== 0
  };
}

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function runLocal(mod, input) {
  const inputBytes = encodeLocalInput(input);
  const inputPtr = mod._malloc(inputBytes.byteLength);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    mod.HEAPU8.set(inputBytes, inputPtr);
    const ok = mod._madepRunMcPlasticMaterialPoint(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    if (!ok) throw new Error(mod.UTF8ToString(mod._madepGetLastErrorMessage()));
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

function inPlaneRelErr(analytic, fd) {
  let num = 0;
  let den = 0;
  for (const i of PLANE) {
    for (const j of PLANE) {
      const d = analytic[i][j] - fd[i][j];
      num += d * d;
      den += fd[i][j] * fd[i][j];
    }
  }
  return Math.sqrt(num) / Math.max(Math.sqrt(den), 1);
}

function maxMatrixDiff(a, b) {
  let max = 0;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 6; j += 1) max = Math.max(max, Math.abs(a[i][j] - b[i][j]));
  }
  return max;
}

function fdTangent(mod, baseInput, h = 1e-7) {
  const out = Array.from({ length: 6 }, () => Array(6).fill(0));
  const base = runLocal(mod, { ...baseInput, useConsistentTangent: true });
  for (const col of PLANE) {
    const plus = [...baseInput.strainTrial6];
    const minus = [...baseInput.strainTrial6];
    plus[col] += h;
    minus[col] -= h;
    const rp = runLocal(mod, { ...baseInput, strainTrial6: plus, useConsistentTangent: true });
    const rm = runLocal(mod, { ...baseInput, strainTrial6: minus, useConsistentTangent: true });
    assert.equal(rp.exactBranchKind, base.exactBranchKind, `+FD branch changed for col ${col}`);
    assert.equal(rm.exactBranchKind, base.exactBranchKind, `-FD branch changed for col ${col}`);
    assert.equal(rp.localReturnMode, base.localReturnMode, `+FD mode changed for col ${col}`);
    assert.equal(rm.localReturnMode, base.localReturnMode, `-FD mode changed for col ${col}`);
    for (let row = 0; row < 6; row += 1) {
      out[row][col] = (rp.stress6[row] - rm.stress6[row]) / (2 * h);
    }
  }
  return out;
}

function assertCase(mod, label, committedStress6, strainTrial6) {
  const input = { committedState: makeState(committedStress6), strainTrial6 };
  const on = runLocal(mod, { ...input, useConsistentTangent: true });
  const off = runLocal(mod, { ...input, useConsistentTangent: false });
  assert.equal(on.plasticActive, true, `${label}: base must be plastic`);
  assert.equal(on.tensionActive, false, `${label}: tension branch not part of phase-1 oracle`);
  assert.equal(on.localReturnMode, 'exact-active-set', `${label}: exact active set expected`);
  const fd = fdTangent(mod, input);
  const rel = inPlaneRelErr(on.tangent6x6, fd);
  console.log(`MC-SH-1 ${label}: branch=${on.exactBranchKind} rel=${rel.toExponential(6)}`);
  assert.ok(rel < 1e-4, `${label}: consistent tangent rel ${rel} >= 1e-4`);

  const stressDiff = Math.max(...on.stress6.map((value, i) => Math.abs(value - off.stress6[i])));
  assert.ok(stressDiff < 1e-10, `${label}: tangent selector changed stress by ${stressDiff}`);
  assert.ok(maxMatrixDiff(off.tangent6x6, elastic6(material.Emc, material.nu)) < 1e-10,
    `${label}: OFF path must return elastic modified-Newton tangent`);
}

const mod = await loadWasm();
assertCase(
  mod,
  'triaxial-face',
  [-100, -100, -100, 0, 0, 0],
  [0.005, -0.005, 0, 0, 0, 0]
);
assertCase(
  mod,
  'oedometric-face',
  [-20, -220, -40, 0, 0, 0],
  [0, 0, 0, 0, 0, 0]
);
assertCase(
  mod,
  'rotated-footing-face',
  [-85, -135, -95, 18, 0, 0],
  [0.004, -0.004, 0, 0.010, 0, 0]
);
console.log('MC-SH-1 local FD oracle PASSED.');
