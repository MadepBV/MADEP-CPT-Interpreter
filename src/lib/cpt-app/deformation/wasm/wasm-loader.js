// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Loads the deformation WASM module exactly once per worker and caches
// the resulting Emscripten instance. `getDeformationWasmModule()` is the
// public entry point; everything else lives at module scope so two
// concurrent analyses share the same instance.

let modulePromise = null;

/**
 * Resolve the URL of the WASM glue script so it works from a Web Worker
 * (where `import.meta.url` for the bridge module is the worker URL, not
 * the page URL). We do this by combining the asset path (relative to the
 * site root, served by SvelteKit's static adapter) with the worker's
 * origin.
 */
function resolveDeformationWasmUrl() {
  if (typeof self === 'undefined') return '/wasm/deformation/deformation.js';
  const origin = self.location?.origin || '';
  return `${origin}/wasm/deformation/deformation.js`;
}

export async function getDeformationWasmModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const moduleUrl = resolveDeformationWasmUrl();
    // Dynamic ES module import — the build sets EXPORT_ES6=1 so the glue
    // file exports a default function `createDeformationModule`.
    const glue = await import(/* @vite-ignore */ moduleUrl);
    const factory = glue.default || glue.createDeformationModule;
    if (typeof factory !== 'function') {
      throw new Error('Deformation WASM glue did not expose a factory function.');
    }
    const instance = await factory({
      // The emscripten module needs to find the .wasm next to its glue.
      // Override the default resolver to be safe across worker contexts.
      locateFile(path) {
        if (path.endsWith('.wasm')) {
          const origin = typeof self !== 'undefined' && self.location?.origin
            ? self.location.origin
            : '';
          return `${origin}/wasm/deformation/${path}`;
        }
        return path;
      }
    });
    return instance;
  })();
  try {
    return await modulePromise;
  } catch (err) {
    modulePromise = null;
    throw err;
  }
}

/**
 * Useful for tests / verification scripts running in Node — they need
 * to be able to hand-feed the loader a pre-instantiated module.
 */
export function __setDeformationWasmModuleForTests(instance) {
  modulePromise = Promise.resolve(instance);
}

export function __resetDeformationWasmModuleForTests() {
  modulePromise = null;
}
