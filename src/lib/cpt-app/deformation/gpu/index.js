// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Factory for the linear-algebra backend used by the deformation solver.
// By default (no backend requested) this returns null and the solver uses
// its native f64 CPU path. When requested, the factory runs the capability
// probe, applies a size gate, and lazy-loads the WebGL2 GPU.js backend.
// The `cpu-f32` override exists for deterministic verification and
// diagnostics (it exercises the exact same ELLPACK + narrow-to-f32 pipeline
// as the GPU backend but runs on the CPU).

import { createCpuF32Backend } from './cpu-f32-backend.js';
import { probeGpuBackend } from './probe.js';
import { tryCreateWebglBackend } from './webgl-backend.js';

export const GPU_DEFAULT_MIN_DOF = 1500;

function warn(warnings, message) {
  if (!Array.isArray(warnings) || !message) return;
  if (!warnings.includes(message)) warnings.push(message);
}

export async function createLinearAlgebraBackend(setup = {}, warnings = []) {
  const {
    useGpuAcceleration = false,
    linearAlgebraBackend = null,
    ndof = 0,
    gpuMinDof = GPU_DEFAULT_MIN_DOF,
    gpuPrecisionMode = 'auto'
  } = setup;

  const explicit = linearAlgebraBackend ? String(linearAlgebraBackend).toLowerCase() : null;

  // Explicit overrides take precedence. They are primarily for tests and
  // diagnostics; production users drive the feature through the boolean.
  if (explicit === 'cpu-f64' || explicit === 'cpu-f64-fallback') {
    return {
      backend: null,
      info: {
        name: 'cpu-f64',
        reason: 'explicit-cpu-f64',
        precisionMode: null,
        residualRefreshInterval: 0,
        supportsElementKernels: false,
        supportsDoubleSingle: false
      }
    };
  }
  if (explicit === 'cpu-f32') {
    const backend = createCpuF32Backend();
    return {
      backend,
      info: {
        name: backend.name,
        reason: 'explicit-cpu-f32',
        precisionMode: backend.precisionMode,
        residualRefreshInterval: backend.residualRefreshInterval,
        supportsElementKernels: backend.supportsElementKernels === true,
        supportsDoubleSingle: backend.supportsDoubleSingle === true
      }
    };
  }
  if (explicit === 'cpu-double-single' || explicit === 'cpu-ds') {
    const backend = createCpuF32Backend({
      precisionMode: 'double-single',
      residualRefreshInterval: 10
    });
    return {
      backend,
      info: {
        name: backend.name,
        reason: 'explicit-cpu-double-single',
        precisionMode: backend.precisionMode,
        residualRefreshInterval: backend.residualRefreshInterval,
        supportsElementKernels: backend.supportsElementKernels === true,
        supportsDoubleSingle: backend.supportsDoubleSingle === true
      }
    };
  }

  if (
    !useGpuAcceleration
    && explicit !== 'webgl2-f32'
    && explicit !== 'webgl2-double-single'
    && explicit !== 'webgl2-ds'
    && explicit !== 'gpu'
  ) {
    return {
      backend: null,
      info: {
        name: 'cpu-f64',
        reason: 'gpu-disabled',
        precisionMode: null,
        residualRefreshInterval: 0,
        supportsElementKernels: false,
        supportsDoubleSingle: false
      }
    };
  }

  // Size gate: launch overhead dominates below a few thousand DOFs.
  // Silently stay on the CPU f64 path below the threshold, but log one
  // warning so the run record shows why the toggle had no effect.
  if (ndof > 0 && ndof < gpuMinDof) {
    warn(
      warnings,
      `GPU acceleration is enabled but the analysis has only ${ndof} free DOFs (< ${gpuMinDof}), so the solver stayed on the CPU f64 path to avoid launch-overhead penalties.`
    );
    return {
      backend: null,
      info: {
        name: 'cpu-f64',
        reason: 'below-size-gate',
        ndof,
        gpuMinDof,
        precisionMode: null,
        residualRefreshInterval: 0,
        supportsElementKernels: false,
        supportsDoubleSingle: false
      }
    };
  }

  const probe = await probeGpuBackend();
  if (!probe.ok) {
    warn(
      warnings,
      `GPU acceleration requested but the WebGL2 capability probe failed (${probe.reason || 'unknown'}); solver stayed on the CPU f64 path.`
    );
    return {
      backend: null,
      info: {
        name: 'cpu-f64',
        reason: `probe-failed:${probe.reason || 'unknown'}`,
        probeMode: probe.mode || null,
        probeContext: probe.context || null,
        maxTextureSize: probe.maxTextureSize || null,
        precisionMode: null,
        residualRefreshInterval: 0,
        supportsElementKernels: false,
        supportsDoubleSingle: false
      }
    };
  }

  const requestedPrecisionMode = (
    explicit === 'webgl2-double-single'
    || explicit === 'webgl2-ds'
    || String(gpuPrecisionMode || 'auto').toLowerCase() === 'double-single'
  )
    ? 'double-single'
    : 'f32';
  const created = await tryCreateWebglBackend({
    initialPrecisionMode: requestedPrecisionMode
  });
  if (!created.backend) {
    warn(
      warnings,
      `GPU acceleration could not be initialised (${created.reason || 'unknown'}); solver stayed on the CPU f64 path.`
    );
    return {
      backend: null,
      info: {
        name: 'cpu-f64',
        reason: `init-failed:${created.reason || 'unknown'}`,
        probeMode: probe.mode || null,
        probeContext: probe.context || null,
        maxTextureSize: probe.maxTextureSize || null,
        precisionMode: null,
        residualRefreshInterval: 0,
        supportsElementKernels: false,
        supportsDoubleSingle: false
      }
    };
  }

  return {
    backend: created.backend,
    info: {
      name: created.backend.name,
      reason: 'gpu-enabled',
      probeMode: probe.mode,
      probeContext: probe.context,
      maxTextureSize: created.maxTextureSize || probe.maxTextureSize || null,
      precisionMode: created.backend.precisionMode || requestedPrecisionMode,
      residualRefreshInterval: created.backend.residualRefreshInterval || 0,
      supportsElementKernels: created.backend.supportsElementKernels === true,
      supportsDoubleSingle: created.backend.supportsDoubleSingle === true
    }
  };
}

export { probeGpuBackend } from './probe.js';
