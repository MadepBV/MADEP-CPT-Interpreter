// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Capability probe for the WebGL2 GPU.js backend. Callable from both main
// thread and worker contexts. Returns a plain object so the result can be
// serialised via postMessage / structuredClone without losing detail.

function hasWebGL2OnCanvas(canvas) {
  if (!canvas) return false;
  try {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) return false;
    const extOk = !!gl.getExtension('EXT_color_buffer_float');
    // Release immediately - probe is non-destructive.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose && typeof lose.loseContext === 'function') {
      try { lose.loseContext(); } catch { /* ignore */ }
    }
    return extOk;
  } catch {
    return false;
  }
}

export function probeGpuBackend() {
  try {
    // Explicit capability gates. Each failure mode is reported with a
    // distinct `reason` so the UI can show an actionable tooltip.
    const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
    const hasDomCanvas = typeof document !== 'undefined' && typeof document.createElement === 'function';
    if (!hasOffscreen && !hasDomCanvas) {
      return { ok: false, reason: 'no-canvas-in-context' };
    }
    let canvas = null;
    if (hasOffscreen) {
      canvas = new OffscreenCanvas(1, 1);
    } else if (hasDomCanvas) {
      canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
    }
    if (!hasWebGL2OnCanvas(canvas)) {
      return { ok: false, reason: 'webgl2-float-rt-missing' };
    }
    return {
      ok: true,
      reason: '',
      mode: 'webgl2',
      context: hasOffscreen ? 'offscreen' : 'document'
    };
  } catch (error) {
    return {
      ok: false,
      reason: `probe-threw:${error?.message || 'unknown'}`
    };
  }
}
