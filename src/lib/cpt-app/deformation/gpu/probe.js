// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Capability probe for the WebGL2 GPU.js backend. Callable from both main
// thread and worker contexts. The cheap sync probe is enough to decide whether
// a canvas + float render target exists; the async detailed probe also loads
// the bundled browser GPU runtime and compiles a tiny kernel so the UI can
// disable the toggle before a run starts.

const GPU_RUNTIME_MODULE = './gpujs-runtime.js';
let cachedGpuJsPromise = null;

export function newProbeCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return canvas;
  }
  return null;
}

export async function loadGpuJs() {
  if (cachedGpuJsPromise) return cachedGpuJsPromise;
  cachedGpuJsPromise = (async () => {
    try {
      const mod = await import(GPU_RUNTIME_MODULE);
      const loader = mod?.loadBundledGpuRuntime || mod?.default || null;
      if (typeof loader !== 'function') return null;
      return await loader();
    } catch {
      return null;
    }
  })();
  try {
    return await cachedGpuJsPromise;
  } catch {
    return null;
  }
}

function hasWebGL2OnCanvas(canvas) {
  if (!canvas) return false;
  try {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) return false;
    const extOk = !!gl.getExtension('EXT_color_buffer_float');
    const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
    // Release immediately - probe is non-destructive.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose && typeof lose.loseContext === 'function') {
      try { lose.loseContext(); } catch { /* ignore */ }
    }
    return {
      ok: extOk,
      maxTextureSize
    };
  } catch {
    return { ok: false, maxTextureSize: 0 };
  }
}

export function probeGpuBackendBasic() {
  try {
    // Explicit capability gates. Each failure mode is reported with a
    // distinct `reason` so the UI can show an actionable tooltip.
    const canvas = newProbeCanvas();
    const context = typeof OffscreenCanvas !== 'undefined' ? 'offscreen' : 'document';
    if (!canvas) {
      return { ok: false, reason: 'no-canvas-in-context' };
    }
    const canvasInfo = hasWebGL2OnCanvas(canvas);
    if (!canvasInfo.ok) {
      return { ok: false, reason: 'webgl2-float-rt-missing' };
    }
    return {
      ok: true,
      reason: '',
      mode: 'webgl2',
      context,
      maxTextureSize: canvasInfo.maxTextureSize
    };
  } catch (error) {
    return {
      ok: false,
      reason: `probe-threw:${error?.message || 'unknown'}`
    };
  }
}

let cachedDetailedProbePromise = null;

export async function probeGpuBackend(force = false) {
  if (!force && cachedDetailedProbePromise) return cachedDetailedProbePromise;
  cachedDetailedProbePromise = (async () => {
    const basic = probeGpuBackendBasic();
    if (!basic.ok) return basic;

    const GPU = await loadGpuJs();
    if (!GPU) {
      return {
        ok: false,
        reason: 'gpu-js-load-failed',
        mode: basic.mode,
        context: basic.context,
        maxTextureSize: basic.maxTextureSize
      };
    }

    const canvas = newProbeCanvas();
    if (!canvas) {
      return {
        ok: false,
        reason: 'no-canvas-in-context'
      };
    }

    let gpu = null;
    try {
      gpu = new GPU({ mode: 'webgl2', canvas });
      const probe = gpu.createKernel(function (a) {
        return a[this.thread.x] * 2.0;
      }).setOutput([4]);
      const out = probe([1, 2, 3, 4]);
      const ok = Math.abs((Number(out?.[0]) || 0) - 2) < 1e-4
        && Math.abs((Number(out?.[1]) || 0) - 4) < 1e-4
        && Math.abs((Number(out?.[2]) || 0) - 6) < 1e-4
        && Math.abs((Number(out?.[3]) || 0) - 8) < 1e-4;
      try { probe.destroy?.(); } catch { /* ignore */ }
      if (!ok) {
        return {
          ok: false,
          reason: 'probe-kernel-mismatch',
          mode: basic.mode,
          context: basic.context,
          maxTextureSize: basic.maxTextureSize
        };
      }
      return {
        ok: true,
        reason: '',
        mode: typeof gpu.getMode === 'function' ? gpu.getMode() : basic.mode,
        context: basic.context,
        maxTextureSize: basic.maxTextureSize
      };
    } catch (error) {
      return {
        ok: false,
        reason: `probe-kernel-threw:${error?.message || 'unknown'}`,
        mode: basic.mode,
        context: basic.context,
        maxTextureSize: basic.maxTextureSize
      };
    } finally {
      try { gpu?.destroy?.(); } catch { /* ignore */ }
    }
  })();
  return cachedDetailedProbePromise;
}
