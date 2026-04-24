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

function resolveGpuConstructor() {
  return globalScope?.GPU || null;
}

async function fetchGpuRuntimeSource() {
  const response = await fetch(GPU_RUNTIME_URL, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`gpu-runtime-fetch-failed:${response.status}`);
  }
  return await response.text();
}

function evaluateGpuRuntime(source) {
  const runner = new Function(source);
  runner.call(globalScope);
  const GPU = resolveGpuConstructor();
  if (!GPU) {
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
