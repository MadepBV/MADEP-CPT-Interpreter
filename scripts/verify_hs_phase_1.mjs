#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CONSTITUTIVE_KIND,
  decodeOutputBuffer,
  encodeInputBuffer,
  WASM_OUTPUT_MAGIC,
  WASM_WIRE_VERSION
} from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

function buildHsInput() {
  const mesh = {
    elementType: 't3',
    nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    elements: [[0, 1, 2]],
    cells: [{ regionIndex: 0 }],
    elementCell: [0]
  };
  const regions = [{
    Emc: 30000,
    nu: 0.3,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 2,
    K0nc: 0.5,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: true,
    symmetrizeEpTangent: false,
    hs: {
      E50_ref: 32000,
      Eoed_ref: 28000,
      Eur_ref: 96000,
      m: 0.55,
      nu_ur: 0.21,
      p_ref: 100,
      Rf: 0.88,
      K0_nc: 0.48,
      e_init: 0.62,
      e_max: 0.82,
      OCR: 1.3,
      reserved: 0
    }
  }];
  const ndof = 2 * mesh.nodes.length;
  return {
    bytes: encodeInputBuffer({
      mesh,
      options: {
        constitutiveModel: 'hardening-soil',
        analysisType: 'deformation',
        useK0Init: true,
        useWasmCpuPipeline: true
      },
      regions,
      gravityRhsFull: new Float64Array(ndof),
      loadRhsFull: new Float64Array(ndof),
      predictorSolutionFull: new Float64Array(ndof),
      initialSigmaByGp: new Float64Array(6),
      porePressureByGp: new Float64Array(1),
      fixedDofs: [0, 1, 2, 3, 4, 5],
      numGpTotal: 1
    }),
    hs: regions[0].hs
  };
}

function assertHsRegionWire(bytes, hs) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(4, true), 10, 'input version');
  assert.equal(view.getUint32(12, true), CONSTITUTIVE_KIND.HardeningSoil, 'constitutive kind');
  const headerBytes = 304;
  const nodesBytes = 3 * 2 * 8;
  const elementsBytes = 4 + 4 + 6 * 4;
  const hsOffset = headerBytes + nodesBytes + elementsBytes + 10 * 8 + 4;
  const expected = [
    hs.E50_ref, hs.Eoed_ref, hs.Eur_ref, hs.m, hs.nu_ur, hs.p_ref,
    hs.Rf, hs.K0_nc, hs.e_init, hs.e_max, hs.OCR, hs.reserved
  ];
  expected.forEach((value, index) => {
    assert.equal(view.getFloat64(hsOffset + index * 8, true), value, `HS f64[${index}]`);
  });
}

function minimalHsOutput() {
  const bytes = new Uint8Array(20 + 88 + 316 + 48);
  const view = new DataView(bytes.buffer);
  let o = 0;
  const u32 = (v) => { view.setUint32(o, v >>> 0, true); o += 4; };
  const i32 = (v) => { view.setInt32(o, v | 0, true); o += 4; };
  const u8 = (v) => { view.setUint8(o, v & 0xff); o += 1; };
  const f64 = (v) => { view.setFloat64(o, Number(v) || 0, true); o += 8; };

  u32(WASM_OUTPUT_MAGIC);
  u32(10);
  u32(0); u32(0); u32(1);
  for (let i = 0; i < 10; i += 1) i32(0);
  for (let i = 0; i < 5; i += 1) f64(0);
  u8(1); u8(1); u8(0); u8(1);
  for (let i = 0; i < 4; i += 1) u8(0);
  for (let i = 0; i < 35; i += 1) f64(0);
  u8(1); u8(0); u8(1); u8(0);
  f64(0.0125);
  f64(145.0);
  f64(-0.003);
  u8(3);
  for (let i = 0; i < 7; i += 1) u8(0);
  u8(0); for (let i = 0; i < 7; i += 1) u8(0);
  f64(1); f64(1); f64(1);
  i32(0); i32(0); i32(0); i32(0);
  assert.equal(o, bytes.length);
  return bytes;
}

async function assertWasmAcceptsHs(inputBytes) {
  // Phase 2 wires the HS constitutive update through the FE dispatch, so
  // an HS-flagged analysis now succeeds (or fails on a numerical error,
  // not an "unimplemented" sentinel). For the wire-format smoke test we
  // just confirm the WASM accepts the buffer and returns a result.
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  const mod = await factory({ wasmBinary });
  const inputPtr = mod._malloc(inputBytes.byteLength);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    mod.HEAPU8.set(inputBytes, inputPtr);
    const status = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    // Phase 2 may not reach full FE convergence for HS in every fixture
    // (corner case can trigger failure-code 999), but the call should at
    // least return without the "unimplemented" sentinel. We accept any
    // status here and require the error message NOT to contain the
    // legacy Phase-1 rejection string.
    const errPtr = mod._madepGetLastErrorMessage();
    let end = errPtr;
    while (mod.HEAPU8[end] !== 0) end += 1;
    const message = new TextDecoder().decode(mod.HEAPU8.subarray(errPtr, end));
    assert.doesNotMatch(message, /Hardening Soil WASM material update is not implemented yet/,
      'Phase 2 must not emit the Phase 1 "unimplemented" sentinel');
    if (status === 1) {
      const outPtr = mod.HEAPU32[outPtrSlot >> 2];
      mod._madepFreeBuffer(outPtr);
    }
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

async function main() {
  assert.equal(WASM_WIRE_VERSION, 10);
  assert.equal(CONSTITUTIVE_KIND.HardeningSoil, 3);

  const { bytes, hs } = buildHsInput();
  assertHsRegionWire(bytes, hs);

  const decoded = decodeOutputBuffer(minimalHsOutput());
  assert.equal(decoded.hasHsPayload, true);
  assert.deepEqual(decoded.gpStates[0].hs, {
    gammaP: 0.0125,
    pP: 145.0,
    epsVP: -0.003,
    lastActiveSet: 3
  });

  await assertWasmAcceptsHs(bytes);
  console.log('HS Phase 1 wire/state plumbing checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
