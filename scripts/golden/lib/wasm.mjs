// SPDX-License-Identifier: AGPL-3.0-or-later
// Instantiates the committed WASM engines from static/wasm/** for the Node tiers
// (design §2.1, §2.4): the retaining engine via its Emscripten glue exactly as
// scripts/verify_retaining_ui.mjs:36-38 does, and the deformation engine for the
// __setDeformationWasmModuleForTests hook (deformation/wasm/wasm-loader.js:62).
// The binaries' SHA-256 are pinned by wasm-hash.mjs so these are honest goldens.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './store.mjs';

let retainingPromise = null;
let deformationPromise = null;

export async function retainingModule() {
  if (!retainingPromise) {
    retainingPromise = (async () => {
      const glue = await import(pathToFileURL(resolve(ROOT, 'static/wasm/retaining/retaining.js')).href);
      const factory = glue.default || glue.createRetainingModule;
      return factory({ wasmBinary: readFileSync(resolve(ROOT, 'static/wasm/retaining/retaining.wasm')) });
    })();
  }
  return retainingPromise;
}

/** Synchronous JSON-in / JSON-out call into the retaining engine (mirrors retaining/wasm-loader.js:49-66). */
export function runRetaining(M, request) {
  const json = JSON.stringify(request || {});
  const len = M.lengthBytesUTF8(json);
  const ptr = M._malloc(len + 1);
  M.stringToUTF8(json, ptr, len + 1);
  let resPtr = 0;
  try {
    resPtr = M._madepRunRetainingAnalysis(ptr, len);
    return JSON.parse(M.UTF8ToString(resPtr));
  } finally {
    if (resPtr) M._madepFreeBuffer(resPtr);
    M._free(ptr);
  }
}

export async function deformationModule() {
  if (!deformationPromise) {
    deformationPromise = (async () => {
      const glue = await import(pathToFileURL(resolve(ROOT, 'static/wasm/deformation/deformation.js')).href);
      const factory = glue.default || glue.createDeformationModule;
      return factory({ wasmBinary: readFileSync(resolve(ROOT, 'static/wasm/deformation/deformation.wasm')) });
    })();
  }
  return deformationPromise;
}
