// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Browser/worker loader for the bundled GPU.js browser runtime. The npm
// package pulls native headless-GL dependencies in Node, which breaks Linux
// arm64 deploys that do not ship a full node-gyp toolchain. By serving the
// UMD browser bundle as a static asset and evaluating it at runtime we keep
// GPU acceleration available in the browser and in module workers without
// asking the server install step to compile `gl`.

const globalScope = typeof globalThis !== 'undefined'
  ? globalThis
  : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));

const baseUrl = String(import.meta?.env?.BASE_URL || '/');
const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
const GPU_RUNTIME_URL = `${normalizedBaseUrl}vendor/gpu-browser.min.js`;

let cachedGpuRuntimePromise = null;

function isGpuJsConstructor(candidate) {
  // GPU.js exposes a `createKernel` instance method on the prototype; the
  // browser's built-in WebGPU `GPU` class (the one returned by
  // `navigator.gpu.constructor` on modern Chrome/Edge) has no such method.
  // This is the only reliable way to tell them apart, since both classes
  // are named `GPU` and both occupy `window.GPU` in modern browsers.
  return !!candidate
    && typeof candidate === 'function'
    && typeof candidate.prototype?.createKernel === 'function';
}

function resolveGpuConstructor() {
  const candidate = globalScope?.GPU;
  return isGpuJsConstructor(candidate) ? candidate : null;
}

async function fetchGpuRuntimeSource() {
  const response = await fetch(GPU_RUNTIME_URL, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`gpu-runtime-fetch-failed:${response.status}`);
  }
  return await response.text();
}

function evaluateGpuRuntime(source) {
  // The UMD wrapper prefers `module.exports` over `window.GPU` when both
  // are visible. We pass a local `module`/`exports` so the bundle takes
  // the CommonJS path and writes the namespace into our slot. This
  // sidesteps the WebGPU collision: in Chrome / Edge / Safari,
  // `window.GPU` is the read-only built-in WebGPU class and the bundle's
  // `window.GPU = e()` assignment silently no-ops, leaving the loader
  // with the wrong constructor (which throws "Illegal constructor" on
  // `new GPU(...)` because WebGPU's class is not user-constructable).
  const moduleStub = { exports: {} };
  const exportsStub = moduleStub.exports;
  const runner = new Function('module', 'exports', source);
  runner.call(globalScope, moduleStub, exportsStub);
  // The npm gpu-browser bundle exports a namespace { GPU, Kernel, ... }
  // via module.exports; older browser-only bundles set the constructor
  // directly. Accept both shapes and validate by prototype shape so the
  // loader can never end up calling `new` on the WebGPU built-in.
  const exported = moduleStub.exports;
  let GPU = null;
  if (isGpuJsConstructor(exported)) {
    GPU = exported;
  } else if (isGpuJsConstructor(exported?.GPU)) {
    GPU = exported.GPU;
  } else {
    GPU = resolveGpuConstructor();
  }
  if (!isGpuJsConstructor(GPU)) {
    throw new Error('gpu-runtime-export-missing');
  }
  return GPU;
}

export async function loadBundledGpuRuntime(force = false) {
  if (!force) {
    const existing = resolveGpuConstructor();
    if (existing) return existing;
    if (cachedGpuRuntimePromise) return cachedGpuRuntimePromise;
  }

  cachedGpuRuntimePromise = (async () => {
    const source = await fetchGpuRuntimeSource();
    return evaluateGpuRuntime(source);
  })();

  try {
    return await cachedGpuRuntimePromise;
  } catch (error) {
    cachedGpuRuntimePromise = null;
    throw error;
  }
}

export default loadBundledGpuRuntime;
