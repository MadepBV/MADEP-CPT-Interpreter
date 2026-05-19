#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH-1 global Newton-count verifier for the live WASM path. Uses a tiny
// non-associated MC fixture with `useConsistentTangent=true`; plastic steps
// must dispatch to GMRES and converge in a small number of Newton iterations.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodeInputBuffer, decodeOutputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function runAnalysis(mod, inputBytes) {
  const inputPtr = mod._malloc(inputBytes.byteLength);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    mod.HEAPU8.set(inputBytes, inputPtr);
    const ok = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    if (!ok) throw new Error(mod.UTF8ToString(mod._madepGetLastErrorMessage()));
    const outPtr = mod.HEAPU32[outPtrSlot >> 2];
    const outLen = mod.HEAPU32[outLenSlot >> 2];
    const outBytes = new Uint8Array(outLen);
    outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._madepFreeBuffer(outPtr);
    const stepPtr = mod._madepGetLastNewtonStepIterationsJson();
    let end = stepPtr;
    while (mod.HEAPU8[end] !== 0) end += 1;
    const stepJson = new TextDecoder().decode(mod.HEAPU8.subarray(stepPtr, end));
    return {
      decoded: decodeOutputBuffer(outBytes),
      stepIterations: JSON.parse(stepJson)
    };
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

function buildInput() {
  const mesh = {
    elementType: 't3',
    nodes: [
      { x: 0, y: 0 }, { x: 1, y: 0 },
      { x: 1, y: 1 }, { x: 0, y: 1 }
    ],
    elements: [[0, 1, 2], [0, 2, 3]],
    cells: [
      { regionIndex: 0, centroid: { x: 2 / 3, y: 1 / 3 } },
      { regionIndex: 0, centroid: { x: 1 / 3, y: 2 / 3 } }
    ],
    elementCell: [0, 1],
    constraintEdges: [
      { markerType: 'outer', source: 'base', nodeIds: [0, 1] },
      { markerType: 'outer', source: 'side-right', nodeIds: [1, 2] },
      { markerType: 'outer', source: 'side-left', nodeIds: [3, 0] },
      { markerType: 'outer', source: 'terrain', nodeIds: [2, 3] }
    ]
  };
  const phi = 25;
  const phiRad = (phi * Math.PI) / 180;
  const k0 = 1 - Math.sin(phiRad);
  const sigmaV = 0;
  const sigmaH = 0;
  const sigmaZ = 0;
  const numGpTotal = 2;
  const initialSigma = new Float64Array(6 * numGpTotal);
  for (let gp = 0; gp < numGpTotal; gp += 1) {
    initialSigma[6 * gp + 0] = sigmaH;
    initialSigma[6 * gp + 1] = sigmaV;
    initialSigma[6 * gp + 2] = sigmaZ;
  }
  return encodeInputBuffer({
    mesh,
    options: {
      constitutiveModel: 'mc-plastic',
      analysisType: 'deformation',
      useK0Init: false,
      hasSurfaceLoad: true,
      useTensionCutoff: false,
      symmetrizeTangent: false,
      nonlinearMaxIter: 24,
      maxLoadSteps: 80,
      initialLoadStep: 0.015625,
      minLoadStep: 1 / 128,
      loadStepGrowthFactor: 1,
      plasticLoadStepGrowthFactor: 1,
      residualRelTol: 1e-6,
      residualAbsTol: 1e-6,
      cgMaxIter: 4000,
      cgRelTol: 1e-13,
      cgAbsTol: 1e-13
    },
    regions: [{
      Emc: 20000,
      nu: 0.3,
      cEff: 8,
      phiEffDeg: phi,
      psiEffDeg: 5,
      K0nc: k0,
      gamma: 19,
      gammaSat: 19,
      sigmaTAllow: 0,
      rShear: 0.25,
      useTensionCutoff: false,
      symmetrizeEpTangent: false,
      useConsistentTangent: true
    }],
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: (() => {
      const rhs = new Float64Array(2 * mesh.nodes.length);
      rhs[2 * 2 + 1] = -120;
      rhs[2 * 3 + 1] = 0;
      return rhs;
    })(),
    predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: initialSigma,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs: [0, 1, 2, 3, 4, 6],
    numGpTotal
  });
}

const mod = await loadWasm();
const run = runAnalysis(mod, buildInput());
console.log('MC-SH-1 Newton summary:', {
  summary: run.decoded.summary,
  stepIterations: run.stepIterations
});

assert.equal(run.decoded.summary.serviceConverged, true, 'consistent ON service must converge');
assert.equal(run.decoded.summary.finalActiveCount > 0, true, 'fixture must activate MC plasticity');
assert.equal(run.decoded.summary.lastLinearSolverKind, 1, 'consistent ON non-associated MC must use GMRES');
assert.ok(run.stepIterations.length > 0, 'must record accepted step iterations');
assert.ok(Math.max(...run.stepIterations) <= 3, 'consistent ON must converge in <= 3 Newton iterations per accepted step');
console.log('MC-SH-1 Newton-count verifier PASSED.');
