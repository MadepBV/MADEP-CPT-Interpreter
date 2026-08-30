// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Loads the retaining-wall WASM module once and caches the Emscripten instance.
// Mirrors the deformation wasm-loader. The engine is lightweight (sub-millisecond
// per analysis) so it runs on the main thread — no worker required.

let modulePromise = null;

/**
 * Major version of the engine this build of the app speaks to (JSON schema v2: soldier piles,
 * Belgian design branches, T_lat sets). A page that has been open across an engine rebuild keeps the
 * *old* instance in memory while HMR swaps the JS around it — that used to surface as a cryptic
 * "unknown wallType: soldierpile". The check below turns it into an instruction to reload.
 */
const REQUIRED_ENGINE_MAJOR = 2;

/** Cache-buster so a rebuilt engine is never served from the HTTP cache of a long-lived tab. */
const BUILD_TAG = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev');

function resolveRetainingWasmUrl() {
  if (typeof self === 'undefined') return `/wasm/retaining/retaining.js?v=${BUILD_TAG}`;
  const origin = self.location?.origin || '';
  return `${origin}/wasm/retaining/retaining.js?v=${BUILD_TAG}`;
}

/** Engine version string, or null for a pre-2.0 build (the export did not exist yet). */
function engineVersion(Module) {
  const fn = Module && Module._madepRetainingVersion;
  if (typeof fn !== 'function') return null;
  try { return Module.UTF8ToString(fn()); } catch { return null; }
}

function assertEngineVersion(Module) {
  const version = engineVersion(Module);
  const major = version ? Number.parseInt(version.split('.')[0], 10) : NaN;
  if (Number.isFinite(major) && major >= REQUIRED_ENGINE_MAJOR) return Module;
  throw new Error(
    `Retaining engine ${version || '(pre-2.0)'} is older than this app expects (v${REQUIRED_ENGINE_MAJOR}). ` +
    'The page is running an engine cached from an earlier session — reload with a hard refresh ' +
    '(⇧⌘R on macOS, Ctrl-F5 on Windows).'
  );
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
          return `${origin}/wasm/retaining/${path}?v=${BUILD_TAG}`;
        }
        return path;
      }
    });
  })().then(assertEngineVersion);
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
