#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-5 D.6 acceptance: run the multi-element oedometer fixture once with the
// legacy continuum/FD tangent path and once with the Simo-Hughes runtime flag.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodeInputBuffer, decodeOutputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

function buildOedometerGrid({ rows, cols, lx, ly }) {
  const nodes = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) nodes.push({ x: (i / cols) * lx, y: (j / rows) * ly });
  }
  const elements = [];
  const elementCell = [];
  const cells = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const n00 = j * (cols + 1) + i;
      const n10 = n00 + 1;
      const n01 = (j + 1) * (cols + 1) + i;
      const n11 = n01 + 1;
      const cellIdx = cells.length;
      cells.push({ regionIndex: 0, centroid: { x: ((i + 0.5) / cols) * lx, y: ((j + 0.5) / rows) * ly } });
      elements.push([n00, n10, n11]);
      elementCell.push(cellIdx);
      elements.push([n00, n11, n01]);
      elementCell.push(cellIdx);
    }
  }
  return { elementType: 't3', nodes, elements, cells, elementCell, rows, cols, lx, ly };
}

function buildOedometerFixedDofs(mesh) {
  const fixed = new Set();
  for (let i = 0; i <= mesh.cols; i += 1) {
    fixed.add(2 * i + 0);
    fixed.add(2 * i + 1);
  }
  for (let j = 0; j <= mesh.rows; j += 1) {
    fixed.add(2 * (j * (mesh.cols + 1)) + 0);
    fixed.add(2 * (j * (mesh.cols + 1) + mesh.cols) + 0);
  }
  return [...fixed].sort((a, b) => a - b);
}

function makeUniformTopPressureRhs(mesh, pressure) {
  const rhs = new Float64Array(2 * mesh.nodes.length);
  const dx = mesh.lx / mesh.cols;
  for (let i = 0; i < mesh.cols; i += 1) {
    const left = mesh.rows * (mesh.cols + 1) + i;
    const right = left + 1;
    rhs[2 * left + 1] += -pressure * dx / 2;
    rhs[2 * right + 1] += -pressure * dx / 2;
  }
  return rhs;
}

function makeUniformK0Seed(numGpTotal, sigmaV, K0) {
  const sigma = new Float64Array(6 * numGpTotal);
  for (let gp = 0; gp < numGpTotal; gp += 1) {
    sigma[6 * gp + 0] = -K0 * sigmaV;
    sigma[6 * gp + 1] = -sigmaV;
    sigma[6 * gp + 2] = -K0 * sigmaV;
  }
  return sigma;
}

function hsRegion(useConsistentTangent) {
  const K0 = 0.5;
  return {
    Emc: 30000,
    nu: 0.3,
    cEff: 0,
    phiEffDeg: 30,
    psiEffDeg: 0,
    K0nc: K0,
    gamma: 0,
    gammaSat: 0,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: false,
    symmetrizeEpTangent: false,
    hs: {
      E50_ref: 30000,
      Eoed_ref: 30000,
      Eur_ref: 90000,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: K0,
      e_init: -1,
      e_max: -1,
      OCR: 1,
      nearSurfaceMinConfiningStress: 0,
      useConsistentTangent: useConsistentTangent ? 1 : 0
    }
  };
}

function defaultOpts() {
  return {
    constitutiveModel: 'hardening-soil',
    analysisType: 'deformation',
    nonlinearMaxIter: 64,
    maxLoadSteps: 256,
    initialLoadStep: 0.1,
    minLoadStep: 1 / 8192,
    loadStepGrowthFactor: 1.2,
    loadStepCutbackFactor: 0.5,
    plasticLoadStepGrowthFactor: 1.1,
    plasticLoadStepCutbackFactor: 0.5,
    residualRelTol: 1e-3,
    residualAbsTol: 1e-2,
    displacementRelTol: 1e-4,
    displacementAbsTol: 1e-7,
    cgMaxIter: 25000,
    cgRelTol: 1e-6,
    cgAbsTol: 1e-6,
    plasticLineSearchReductionFactor: 0.5,
    plasticLineSearchMinScale: 1 / 32,
    plasticLineSearchArmijoCoefficient: 1e-4,
    plasticLineSearchMaxBacktracks: 5,
    useK0Init: true,
    useGeostaticInit: true,
    useTensionCutoff: false,
    symmetrizeTangent: false,
    hasSurfaceLoad: true
  };
}

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
    if (!ok) throw new Error(`WASM solver error: ${mod.UTF8ToString(mod._madepGetLastErrorMessage())}`);
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

function activeHistogram(decoded) {
  const counts = new Array(8).fill(0);
  for (const gp of decoded.gpStates || []) counts[gp.hs?.lastActiveSet ?? 0] += 1;
  return counts;
}

function meanTopSettlement(mesh, decoded) {
  let uy = 0;
  for (let i = 0; i <= mesh.cols; i += 1) {
    const top = mesh.rows * (mesh.cols + 1) + i;
    uy += decoded.displacements[2 * top + 1];
  }
  return uy / (mesh.cols + 1);
}

function maxRelArrayDiff(a, b, scale = 1) {
  let max = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    max = Math.max(max, Math.abs((Number(a[i]) || 0) - (Number(b[i]) || 0)) / Math.max(Math.abs(Number(b[i]) || 0), scale));
  }
  return max;
}

async function runD6(mod, useConsistentTangent) {
  const mesh = buildOedometerGrid({ rows: 20, cols: 30, lx: 5, ly: 3 });
  const numGpTotal = mesh.elements.length;
  const input = encodeInputBuffer({
    mesh,
    options: defaultOpts(),
    regions: [hsRegion(useConsistentTangent)],
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: makeUniformTopPressureRhs(mesh, 200),
    predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: makeUniformK0Seed(numGpTotal, 50, 0.5),
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs: buildOedometerFixedDofs(mesh),
    numGpTotal
  });
  const result = runAnalysis(mod, input);
  return { mesh, ...result, histogram: activeHistogram(result.decoded), settlement: meanTopSettlement(mesh, result.decoded) };
}

function assertConverged(label, run) {
  assert.equal(run.decoded.summary.serviceConverged, true, `${label}: service must converge`);
  assert.ok(Math.abs(run.decoded.summary.finalLoadFactor - 1) < 1e-12, `${label}: full service load`);
  assert.equal(run.decoded.hasHsPayload, true, `${label}: HS payload`);
}

const mod = await loadWasm();
const continuum = await runD6(mod, false);
const sh = await runD6(mod, true);

console.log('HS SH-5 D.6 comparison:', {
  continuum: {
    converged: continuum.decoded.summary.serviceConverged,
    newton: continuum.decoded.summary.newtonIterations,
    accepted: continuum.decoded.summary.loadStepsAccepted,
    rejected: continuum.decoded.summary.loadStepsRejected,
    settlement: continuum.settlement,
    histogram: continuum.histogram,
    stepIterations: continuum.stepIterations
  },
  simoHughes: {
    converged: sh.decoded.summary.serviceConverged,
    newton: sh.decoded.summary.newtonIterations,
    accepted: sh.decoded.summary.loadStepsAccepted,
    rejected: sh.decoded.summary.loadStepsRejected,
    settlement: sh.settlement,
    histogram: sh.histogram,
    stepIterations: sh.stepIterations
  }
});

assertConverged('Simo-Hughes', sh);
if (continuum.decoded.summary.serviceConverged) {
  assertConverged('Continuum', continuum);
  assert.ok(Math.abs(continuum.settlement - sh.settlement) / Math.max(Math.abs(continuum.settlement), 1e-9) < 2e-3, 'settlement equivalence');
  assert.ok(maxRelArrayDiff(continuum.decoded.displacements, sh.decoded.displacements, 1e-6) < 2e-3, 'displacement equivalence');
  assert.deepEqual(sh.histogram, continuum.histogram, 'active-set histogram equivalence');
} else {
  console.log('Continuum path did not converge; Simo-Hughes full-load state was reported above.');
}

console.log('HS SH-5 D.6 Simo-Hughes acceptance PASSED.');
