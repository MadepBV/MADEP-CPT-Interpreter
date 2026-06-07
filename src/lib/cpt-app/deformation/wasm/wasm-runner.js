// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// High-level runner: takes the same input bundle the CPU path consumes
// (mesh + regions + options + load + BCs + K0 stress field + pore
// pressure), encodes it for the WASM module, calls into the native
// solver, and returns the decoded output.

import { getDeformationWasmModule } from './wasm-loader.js';
import { encodeInputBuffer, decodeOutputBuffer } from './wire-format.js';

// Decode a NUL-terminated UTF-8 C string from the module heap. The deformation
// build exports only the HEAP typed-array views (not UTF8ToString), so reads of
// the diagnostic JSON getters go through here.
function readCStringFromHeap(mod, ptr) {
  if (!ptr || !mod || !mod.HEAPU8) return null;
  const heap = mod.HEAPU8;
  let end = ptr;
  while (end < heap.length && heap[end] !== 0) end += 1;
  const bytes = heap.subarray(ptr, end);
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

export async function runDeformationOnWasm({
  mesh,
  regions,
  gravityRhsFull,
  loadRhsFull,
  predictorSolutionFull,
  initialSigmaByGp,
  porePressureByGp,
  fixedDofs,
  numGpTotal,
  options,
  onProgress = () => {}
}) {
  onProgress({ stage: 'wasm', percent: 50, message: 'Encoding inputs for WASM solver...' });

  const inputBytes = encodeInputBuffer({
    mesh,
    options,
    regions,
    gravityRhsFull,
    loadRhsFull,
    predictorSolutionFull,
    initialSigmaByGp,
    porePressureByGp,
    fixedDofs,
    numGpTotal
  });

  onProgress({ stage: 'wasm', percent: 60, message: 'Running WASM elastoplastic solver...' });

  const mod = await getDeformationWasmModule();

  const inputPtr = mod._malloc(inputBytes.byteLength);
  if (!inputPtr) throw new Error('WASM allocation failed for input buffer.');
  mod.HEAPU8.set(inputBytes, inputPtr);

  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  if (!outPtrSlot || !outLenSlot) {
    mod._free(inputPtr);
    if (outPtrSlot) mod._free(outPtrSlot);
    if (outLenSlot) mod._free(outLenSlot);
    throw new Error('WASM allocation failed for output handles.');
  }

  let status = 0;
  try {
    status = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
  } catch (err) {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
    throw err;
  }
  if (!status) {
    const errPtr = mod._madepGetLastErrorMessage();
    let msg = 'WASM solver returned an error.';
    try {
      msg = mod.UTF8ToString ? mod.UTF8ToString(errPtr) : msg;
    } catch (_) { /* ignore */ }
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
    throw new Error(`WASM solver: ${msg}`);
  }

  const outPtr = mod.HEAPU32[outPtrSlot >> 2];
  const outLen = mod.HEAPU32[outLenSlot >> 2];
  if (!outPtr || !outLen) {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
    throw new Error('WASM solver returned an empty result.');
  }

  const outBytes = new Uint8Array(outLen);
  outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
  mod._madepFreeBuffer(outPtr);
  mod._free(inputPtr);
  mod._free(outPtrSlot);
  mod._free(outLenSlot);

  onProgress({ stage: 'wasm', percent: 84, message: 'Decoding WASM solver result...' });

  const decoded = decodeOutputBuffer(outBytes);

  // Workstream B: attach Tier-2 LM-rescue diagnostics (out-of-band JSON; not in
  // the wire-encoded summary). Gates read `tier2.activations` and
  // `tier2.finalMu` / `tier2.finalMuZero`. The build only exports the HEAP
  // views (not UTF8ToString), so decode the C string from HEAPU8 directly.
  if (typeof mod._madepGetLastTier2DiagnosticsJson === 'function') {
    try {
      const ptr = mod._madepGetLastTier2DiagnosticsJson();
      const json = readCStringFromHeap(mod, ptr);
      if (json) decoded.tier2 = JSON.parse(json);
    } catch (_) { /* diagnostics are best-effort */ }
  }

  return decoded;
}
