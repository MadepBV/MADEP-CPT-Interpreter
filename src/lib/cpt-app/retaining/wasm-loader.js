// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Loads the retaining-wall WASM module once and caches the Emscripten instance.
// Mirrors the deformation wasm-loader. The engine is lightweight (sub-millisecond
// per analysis) so it runs on the main thread — no worker required.

let modulePromise = null;

function resolveRetainingWasmUrl() {
  if (typeof self === 'undefined') return '/wasm/retaining/retaining.js';
  const origin = self.location?.origin || '';
  return `${origin}/wasm/retaining/retaining.js`;
}

export async function getRetainingWasmModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const moduleUrl = resolveRetainingWasmUrl();
    const glue = await import(/* @vite-ignore */ moduleUrl);
    const factory = glue.default || glue.createRetainingModule;
    if (typeof factory !== 'function') {
      throw new Error('Retaining WASM glue did not expose a factory function.');
    }
    return factory({
      locateFile(path) {
        if (path.endsWith('.wasm')) {
          const origin = typeof self !== 'undefined' && self.location?.origin
            ? self.location.origin
            : '';
          return `${origin}/wasm/retaining/${path}`;
        }
        return path;
      }
    });
  })();
  try {
    return await modulePromise;
  } catch (err) {
    modulePromise = null;
    throw err;
  }
}

/**
 * Run one retaining-wall analysis. `request` is a plain JS object (see the engine
 * JSON schema); returns the parsed result object. Throws on a wasm-reported error.
 */
export async function runRetainingAnalysis(request) {
  const Module = await getRetainingWasmModule();
  const json = JSON.stringify(request || {});
  const len = Module.lengthBytesUTF8(json);
  const ptr = Module._malloc(len + 1);
  Module.stringToUTF8(json, ptr, len + 1);
  let resPtr = 0;
  try {
    resPtr = Module._madepRunRetainingAnalysis(ptr, len);
    const text = Module.UTF8ToString(resPtr);
    const result = JSON.parse(text);
    if (result && result.ok === false) {
      throw new Error(`Retaining engine: ${result.error || 'unknown error'}`);
    }
    return result;
  } finally {
    if (resPtr) Module._madepFreeBuffer(resPtr);
    Module._free(ptr);
  }
}

export function __resetRetainingWasmModuleForTests() {
  modulePromise = null;
}
