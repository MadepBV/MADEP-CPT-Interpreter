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
import { probeWebgpuBackend, tryCreateWebgpuBackend } from './webgpu-backend.js';

export const GPU_DEFAULT_MIN_DOF = 1500;

function warn(warnings, message) {
  if (!Array.isArray(warnings) || !message) return;
  if (!warnings.includes(message)) warnings.push(message);
}

function backendCertificationInfo(backend = null) {
  return backend?.certification || {
    residentCg: backend?.residentCgCertified === true ? 'unit' : 'none',
    residentGmres: backend?.residentGmresCertified === true ? 'unit' : 'none',
    nonlinearAssembly: 'none',
    mcMaterial: 'none'
  };
}

function backendCapabilitiesInfo(backend = null) {
  return backend?.capabilities || {
    residentCg: backend?.supportsResidentCg === true,
    residentGmres: backend?.supportsResidentGmres === true,
    residentBicgstab: backend?.supportsResidentBicgstab === true,
    t3ElementKernels: backend?.supportsT3ElementKernels === true,
    t6ElementKernels: backend?.supportsT6ElementKernels === true,
    nonlinearAssembly: backend?.supportsNonlinearAssembly === true,
    materialKernels: backend?.supportsMaterialKernels === true,
    trueResidualOnGpu: backend?.supportsTrueResidualOnGpu === true,
    supportsCancellation: backend?.supportsCancellation === true
  };
}

function cpuF64Info(reason, extra = {}) {
  return {
    name: 'cpu-f64',
    reason,
    precisionMode: null,
    residualRefreshInterval: 0,
    supportsElementKernels: false,
    supportsT3ElementKernels: false,
    supportsT6ElementKernels: false,
    supportsDoubleSingle: false,
    supportsResidentCg: false,
    supportsResidentGmres: false,
    residentCgCertified: false,
    residentGmresCertified: false,
    capabilities: backendCapabilitiesInfo(null),
    certification: backendCertificationInfo(null),
    ...extra
  };
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
      info: cpuF64Info('explicit-cpu-f64')
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
        supportsT3ElementKernels: backend.supportsT3ElementKernels === true,
        supportsT6ElementKernels: backend.supportsT6ElementKernels === true,
        supportsDoubleSingle: backend.supportsDoubleSingle === true,
        supportsResidentCg: backend.supportsResidentCg === true,
        supportsResidentGmres: backend.supportsResidentGmres === true,
        residentCgCertified: backend.residentCgCertified === true,
        residentGmresCertified: backend.residentGmresCertified === true,
        capabilities: backendCapabilitiesInfo(backend),
        certification: backendCertificationInfo(backend)
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
        supportsT3ElementKernels: backend.supportsT3ElementKernels === true,
        supportsT6ElementKernels: backend.supportsT6ElementKernels === true,
        supportsDoubleSingle: backend.supportsDoubleSingle === true,
        supportsResidentCg: backend.supportsResidentCg === true,
        supportsResidentGmres: backend.supportsResidentGmres === true,
        residentCgCertified: backend.residentCgCertified === true,
        residentGmresCertified: backend.residentGmresCertified === true,
        capabilities: backendCapabilitiesInfo(backend),
        certification: backendCertificationInfo(backend)
      }
    };
  }

  if (
    !useGpuAcceleration
    && explicit !== 'webgl2-f32'
    && explicit !== 'webgl2-double-single'
    && explicit !== 'webgl2-ds'
    && explicit !== 'webgpu'
    && explicit !== 'webgpu-f32'
    && explicit !== 'gpu'
  ) {
    return {
      backend: null,
      info: cpuF64Info('gpu-disabled')
    };
  }

  // Size gate: launch overhead dominates below a few thousand DOFs.
  // Silently stay on the CPU f64 path below the threshold, but log one
  // warning so the run record shows why the toggle had no effect.
  if (ndof > 0 && ndof < gpuMinDof) {
    warn(
      warnings,
      `Linear-algebra GPU acceleration is enabled but the analysis has only ${ndof} free DOFs (< ${gpuMinDof}), so the solver stayed on the CPU f64 path to avoid launch-overhead penalties.`
    );
    return {
      backend: null,
      info: cpuF64Info('below-size-gate', {
        ndof,
        gpuMinDof
      })
    };
  }

  // Preference order:
  //   1. WebGPU (modern compute API; sub-100 µs dispatch latency, real DS-grade
  //      reduction in WGSL). Tried first whenever the platform exposes
  //      `navigator.gpu`. Falls through to WebGL2 on probe / device failure.
  //   2. WebGL2 + GPU.js (legacy fallback for browsers without WebGPU).
  //   3. CPU f64 (always available).
  // Explicit overrides skip the auto-selection: `webgpu` forces WebGPU and
  // returns CPU f64 if it can't initialise; `webgl2-*` forces the legacy path.
  const wantsWebgpu = explicit === 'webgpu' || explicit === 'webgpu-f32';
  const wantsWebgl2 = explicit === 'webgl2-f32'
    || explicit === 'webgl2-double-single'
    || explicit === 'webgl2-ds';
  const tryWebgpuFirst = wantsWebgpu || (!wantsWebgl2 && (useGpuAcceleration || explicit === 'gpu'));

  let webgpuProbe = null;
  if (tryWebgpuFirst) {
    webgpuProbe = await probeWebgpuBackend();
    if (webgpuProbe.ok) {
      const created = await tryCreateWebgpuBackend({});
      if (created.backend) {
        return {
          backend: created.backend,
          info: {
            name: created.backend.name,
            reason: 'gpu-enabled',
            probeMode: 'webgpu',
            probeContext: webgpuProbe.context || 'navigator-gpu',
            maxTextureSize: 0,
            precisionMode: created.backend.precisionMode || 'f32',
            residualRefreshInterval: created.backend.residualRefreshInterval || 0,
            supportsElementKernels: created.backend.supportsElementKernels === true,
            supportsT3ElementKernels: created.backend.supportsT3ElementKernels === true,
            supportsT6ElementKernels: created.backend.supportsT6ElementKernels === true,
            supportsDoubleSingle: created.backend.supportsDoubleSingle === true,
            supportsResidentCg: created.backend.supportsResidentCg === true,
            supportsResidentGmres: created.backend.supportsResidentGmres === true,
            residentCgCertified: created.backend.residentCgCertified === true,
            residentGmresCertified: created.backend.residentGmresCertified === true,
            capabilities: backendCapabilitiesInfo(created.backend),
            certification: backendCertificationInfo(created.backend)
          }
        };
      }
      // WebGPU init failed even though probe passed. Record the reason and
      // fall through to WebGL2 unless the user explicitly requested WebGPU.
      if (wantsWebgpu) {
        warn(
          warnings,
          `WebGPU linear-algebra acceleration could not be initialised (${created.reason || 'unknown'}); solver stayed on the CPU f64 path.`
        );
        return {
          backend: null,
          info: cpuF64Info(`webgpu-init-failed:${created.reason || 'unknown'}`, {
            probeMode: 'webgpu',
            probeContext: webgpuProbe.context || 'navigator-gpu'
          })
        };
      }
      warn(
        warnings,
        `WebGPU linear-algebra acceleration could not be initialised (${created.reason || 'unknown'}); falling back to WebGL2.`
      );
    } else if (wantsWebgpu) {
      warn(
        warnings,
        `WebGPU linear-algebra acceleration requested but the capability probe failed (${webgpuProbe.reason || 'unknown'}); solver stayed on the CPU f64 path.`
      );
      return {
        backend: null,
        info: cpuF64Info(`webgpu-probe-failed:${webgpuProbe.reason || 'unknown'}`)
      };
    }
    // Otherwise (auto path, no WebGPU): silently continue to WebGL2.
  }

  const probe = await probeGpuBackend();
  if (!probe.ok) {
    warn(
      warnings,
      `Linear-algebra GPU acceleration requested but the WebGL2 capability probe failed (${probe.reason || 'unknown'}); solver stayed on the CPU f64 path.`
    );
    return {
      backend: null,
      info: cpuF64Info(`probe-failed:${probe.reason || 'unknown'}`, {
        probeMode: probe.mode || null,
        probeContext: probe.context || null,
        maxTextureSize: probe.maxTextureSize || null,
        webgpuProbeReason: webgpuProbe?.ok ? null : (webgpuProbe?.reason || null)
      })
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
      `Linear-algebra GPU acceleration could not be initialised (${created.reason || 'unknown'}); solver stayed on the CPU f64 path.`
    );
    return {
      backend: null,
      info: cpuF64Info(`init-failed:${created.reason || 'unknown'}`, {
        probeMode: probe.mode || null,
        probeContext: probe.context || null,
        maxTextureSize: probe.maxTextureSize || null
      })
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
      supportsT3ElementKernels: created.backend.supportsT3ElementKernels === true,
      supportsT6ElementKernels: created.backend.supportsT6ElementKernels === true,
      supportsDoubleSingle: created.backend.supportsDoubleSingle === true,
      supportsResidentCg: created.backend.supportsResidentCg === true,
      supportsResidentGmres: created.backend.supportsResidentGmres === true,
      residentCgCertified: created.backend.residentCgCertified === true,
      residentGmresCertified: created.backend.residentGmresCertified === true,
      capabilities: backendCapabilitiesInfo(created.backend),
      certification: backendCertificationInfo(created.backend)
    }
  };
}

export { probeGpuBackend } from './probe.js';
export { probeWebgpuBackend } from './webgpu-backend.js';
