// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Top-level orchestrator for the WASM CPU pipeline.
//
// The caller (`_analyzeDeformationModelImpl` in solver.js) has already
// computed:
//   - mesh, elementCaches, regionConstitutiveByRegion, fixedValues,
//   - gravity body force RHS (full DOF),
//   - surface traction RHS (full DOF),
//   - geostatic K0 stress field (per integration point) via the same
//     elastic gravity + slope-aware K0 recovery the CPU plastic path
//     consumes,
//   - geostatic predictor displacement (per DOF) from that same elastic
//     gravity step,
//   - pore pressure per integration point.
//
// We pass all of this into the C++ WASM module, which owns the plastic
// geostatic equilibration, the service-load Newton, and (when
// analysisType === 'safety-cphi') the c-φ strength-reduction
// bracketing. The result is then assembled with the same nodal /
// element-result / summary shape the CPU path returns, so consumers
// (sampleDeformationState, the report UI, etc.) cannot tell the paths
// apart from the output.

import { runDeformationOnWasm } from './wasm-runner.js';
import { buildWasmDeformationResult } from './build-result.js';

function flattenInitialField(initialField, numGpTotal) {
  const out = new Float64Array(6 * numGpTotal);
  if (!Array.isArray(initialField)) return out;
  for (let gp = 0; gp < initialField.length && gp < numGpTotal; gp += 1) {
    const s6 = initialField[gp];
    if (!s6) continue;
    for (let k = 0; k < 6; k += 1) out[gp * 6 + k] = Number(s6[k]) || 0;
  }
  return out;
}

function countIntegrationPoints(elementCaches) {
  let n = 0;
  for (const ec of elementCaches) {
    n += ec?.numGaussPoints || (ec?.integrationPoints?.length || 0) || 1;
  }
  return n;
}

export async function runWasmDeformationPipeline(ctx) {
  const {
    mesh,
    elementCaches,
    regionConstitutiveByRegion,
    fixedValues,
    gravityRhs,
    loadRhs,
    initialField,
    predictorSolution,
    geostatic,
    porePressureByIntegrationPoint,
    options,
    load,
    warnings,
    onProgress,
    startedAt,
    analysisType
  } = ctx;

  // Region table, indexed by regionIndex.
  const numRegions = Math.max(...mesh.cells.map((c) => Number(c.regionIndex) || 0), -1) + 1;
  const regionsArray = new Array(numRegions);
  const firstConstitutive = regionConstitutiveByRegion.values().next().value || null;
  const useMcConsistentTangent =
    String(options?.constitutiveModel || '').toLowerCase() === 'mc-plastic' &&
    options?.useMcConsistentTangent !== false;
  for (let r = 0; r < numRegions; r += 1) {
    const constitutive = regionConstitutiveByRegion.get(r) || firstConstitutive;
    const materialParameters = constitutive?.materialParameters || {};
    regionsArray[r] = useMcConsistentTangent
      ? {
          ...materialParameters,
          useConsistentTangent: true,
          mc: {
            ...(materialParameters.mc || {}),
            useConsistentTangent: true
          }
        }
      : materialParameters;
  }

  const fixedDofs = Array.from(fixedValues.keys()).sort((a, b) => a - b);
  const numGpTotal = countIntegrationPoints(elementCaches);
  const initialSigmaByGp = flattenInitialField(initialField, numGpTotal);
  const porePressureByGp = porePressureByIntegrationPoint instanceof Float64Array
    ? porePressureByIntegrationPoint
    : Float64Array.from(porePressureByIntegrationPoint || new Float64Array(numGpTotal));

  // Decide analysis mode from analysisType + whether the CPU path would
  // run the plastic geostatic phase.
  const isSafety = analysisType === 'safety-cphi';
  // The WASM driver treats `analysisType === 'safety-cphi'` as Mode 2
  // (geostatic + service + safety) and everything else as Mode 1
  // (geostatic + service). Mode 0 (ServiceOnly, gravity-ramp from σ = 0)
  // is reserved for tests / synthetic inputs that bypass the CPU
  // geostatic init.

  onProgress({ stage: 'wasm', percent: 70, message: 'Running WASM elastoplastic solver...' });

  const wasmResult = await runDeformationOnWasm({
    mesh,
    regions: regionsArray,
    gravityRhsFull: gravityRhs,
    loadRhsFull: loadRhs,
    predictorSolutionFull: predictorSolution,
    initialSigmaByGp,
    porePressureByGp,
    fixedDofs,
    numGpTotal,
    options: {
      ...options,
      analysisType,
      hasSurfaceLoad: Boolean(loadRhs && loadRhs.some((v) => v !== 0)),
      useK0Init: true,
      useTensionCutoff: options.useTensionCutoff !== false,
      // Match JS CPU: exact non-associated MC plasticity keeps the
      // unsymmetric tangent unless the material explicitly opts into
      // symmetrization.
      symmetrizeTangent: options.symmetrizeEpTangent === true,
      // Match the CPU path's default: B-bar only when explicitly opted
      // into via `useBBarFormulationT6: true`. Without the flag the
      // standard B matrix is used at every Gauss point.
      useBBar: options.useBBarFormulationT6 === true,
      robustNonlinearMode: options.wasmRobustNonlinearMode === true
    },
    onProgress
  });

  onProgress({
    stage: 'post',
    percent: 90,
    message: 'Building deformation result from WASM output...'
  });

  const result = buildWasmDeformationResult({
    mesh,
    load,
    warnings,
    elementCaches,
    options,
    wasmResult,
    startedAt,
    predictorSolution,
    initialField,
    geostatic,
    porePressureByIntegrationPoint,
    analysisType
  });

  onProgress({
    stage: 'post',
    percent: 96,
    message: 'Finalizing WASM deformation output...'
  });

  return result;
}
