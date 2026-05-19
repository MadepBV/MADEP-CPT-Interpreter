#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-5 §6.4 Newton-count verifier. This uses the WASM debug hook added in
// SH-5 to inspect accepted-step Newton iterations with the HS
// Simo-Hughes runtime flag enabled.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodeInputBuffer, decodeOutputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

function buildGrid({ rows, cols, lx, ly }) {
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

function fixedOedometerDofs(mesh) {
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

function topPressureRhs(mesh, pressure) {
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

function uniformK0Seed(numGpTotal, sigmaV, K0) {
  const sigma = new Float64Array(6 * numGpTotal);
  for (let gp = 0; gp < numGpTotal; gp += 1) {
    sigma[6 * gp + 0] = -K0 * sigmaV;
    sigma[6 * gp + 1] = -sigmaV;
    sigma[6 * gp + 2] = -K0 * sigmaV;
  }
  return sigma;
}

function hsRegion({
  E = 30000,
  cEff = 0,
  phiEffDeg = 30,
  psiEffDeg = 0,
  K0 = 0.5,
  gamma = 0,
  gammaSat = 0
} = {}) {
  return {
    Emc: E,
    nu: 0.3,
    cEff,
    phiEffDeg,
    psiEffDeg,
    K0nc: K0,
    gamma,
    gammaSat,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: false,
    symmetrizeEpTangent: false,
    hs: {
      E50_ref: E,
      Eoed_ref: E,
      Eur_ref: 3 * E,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: K0,
      e_init: -1,
      e_max: -1,
      OCR: 1,
      nearSurfaceMinConfiningStress: 0,
      useConsistentTangent: 1
    }
  };
}

function deformationOptions(extra = {}) {
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
    initialGravityPlasticLoadStepGrowthFactor: 1.1,
    initialGravityPlasticLoadStepCutbackFactor: 0.5,
    residualRelTol: 1e-3,
    residualAbsTol: 1e-2,
    displacementRelTol: 1e-4,
    displacementAbsTol: 1e-7,
    cgMaxIter: 25000,
    cgRelTol: 1e-6,
    cgAbsTol: 1e-6,
    plasticLineSearchReductionFactor: 0.5,
    plasticLineSearchMinScale: 1 / 32,
    initialGravityPlasticLineSearchMinScale: 1 / 16,
    plasticLineSearchArmijoCoefficient: 1e-4,
    plasticLineSearchMaxBacktracks: 5,
    initialGravityPlasticLineSearchMaxBacktracks: 5,
    useK0Init: true,
    useGeostaticInit: true,
    useTensionCutoff: false,
    symmetrizeTangent: false,
    hasSurfaceLoad: true,
    ...extra
  };
}

function safetyOptions(extra = {}) {
  return deformationOptions({
    analysisType: 'safety-cphi',
    residualRelTol: 5e-3,
    residualAbsTol: 1e-1,
    useTensionCutoff: true,
    safetyInitialIncrement: 0.02,
    safetyGrowthFactor: 1.2,
    safetyCutbackFactor: 0.5,
    safetySigmaMax: 2.0,
    safetyBracketTolerance: 0.02,
    safetyMaxSearchTrials: 32,
    requestedContinuationMode: 'strength-control',
    ...extra
  });
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

function encodeOedometer({ rows, cols, lx, ly, pressure, sigmaV, K0, options, region }) {
  const mesh = buildGrid({ rows, cols, lx, ly });
  const numGpTotal = mesh.elements.length;
  return {
    mesh,
    input: encodeInputBuffer({
      mesh,
      options,
      regions: [region],
      gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
      loadRhsFull: topPressureRhs(mesh, pressure),
      predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
      initialSigmaByGp: uniformK0Seed(numGpTotal, sigmaV, K0),
      porePressureByGp: new Float64Array(numGpTotal),
      fixedDofs: fixedOedometerDofs(mesh),
      numGpTotal
    })
  };
}

function summarize(stepIterations) {
  assert.ok(stepIterations.length > 0, 'must record at least one accepted step');
  const sorted = [...stepIterations].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    count: sorted.length,
    median: percentile(0.5),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1]
  };
}

function assertStats(label, stepIterations, limits) {
  const stats = summarize(stepIterations);
  console.log(`${label}:`, { ...stats, stepIterations });
  assert.ok(stats.median <= limits.median, `${label}: median ${stats.median} > ${limits.median}`);
  assert.ok(stats.p99 <= limits.p99, `${label}: p99 ${stats.p99} > ${limits.p99}`);
  return stats;
}

async function runD3(mod) {
  const { input } = encodeOedometer({
    rows: 1,
    cols: 1,
    lx: 1,
    ly: 1,
    pressure: 40,
    sigmaV: 50,
    K0: 0.5,
    options: deformationOptions(),
    region: hsRegion()
  });
  const run = runAnalysis(mod, input);
  assert.equal(run.decoded.summary.serviceConverged, true, 'D.3 service must converge');
  assert.ok(Math.abs(run.decoded.summary.finalLoadFactor - 1) < 1e-12, 'D.3 full load');
  return run.stepIterations;
}

async function runD6(mod) {
  const { input } = encodeOedometer({
    rows: 20,
    cols: 30,
    lx: 5,
    ly: 3,
    pressure: 200,
    sigmaV: 50,
    K0: 0.5,
    options: deformationOptions(),
    region: hsRegion()
  });
  const run = runAnalysis(mod, input);
  assert.equal(run.decoded.summary.serviceConverged, true, 'D.6 service must converge');
  assert.ok(Math.abs(run.decoded.summary.finalLoadFactor - 1) < 1e-12, 'D.6 full load');
  return run.stepIterations;
}

async function runD7(mod) {
  const K0 = 0.5;
  const { input } = encodeOedometer({
    rows: 2,
    cols: 2,
    lx: 1,
    ly: 1,
    pressure: 200,
    sigmaV: 50,
    K0,
    options: safetyOptions(),
    region: hsRegion({
      E: 18000,
      cEff: 5,
      phiEffDeg: 25,
      psiEffDeg: 0,
      K0,
      gamma: 18,
      gammaSat: 20
    })
  });
  const run = runAnalysis(mod, input);
  assert.equal(run.decoded.summary.serviceConverged, true, 'D.7 service must converge');
  assert.equal(run.decoded.safety.ran, true, 'D.7 safety phase must run');
  return run.stepIterations;
}

const mod = await loadWasm();
assertStats('D.3 single-element oedometer', await runD3(mod), { median: 3, p99: 4 });
assertStats('D.6 multi-element oedometer', await runD6(mod), { median: 5, p99: 8 });
assertStats('D.7 safety FoS parity fixture', await runD7(mod), { median: 7, p99: 12 });
console.log('HS SH-5 Newton-count acceptance PASSED.');
