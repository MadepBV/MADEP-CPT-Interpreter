#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH safety dispatch verifier. A non-associated MC c-phi safety solve with
// the consistent tangent enabled must route active plastic Newton iterations to
// GMRES. CG is only valid for SPD systems; the non-associated MC consistent
// tangent is unsymmetric and the safety strength-reduction material table must
// preserve that solver requirement.

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
    return decodeOutputBuffer(outBytes);
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

function buildGrid(rows, cols, lx, ly) {
  const nodes = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      nodes.push({ x: (i / cols) * lx, y: (j / rows) * ly });
    }
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
      elements.push([n00, n10, n11]);
      elements.push([n00, n11, n01]);
      const cellIdx = cells.length;
      cells.push({ regionIndex: 0, centroid: { x: (i + 0.5) * lx / cols, y: (j + 0.5) * ly / rows } });
      elementCell.push(cellIdx, cellIdx);
    }
  }
  const constraintEdges = [];
  for (let i = 0; i < cols; i += 1) {
    constraintEdges.push({ markerType: 'outer', source: 'base', nodeIds: [i, i + 1] });
    constraintEdges.push({
      markerType: 'outer',
      source: 'terrain',
      nodeIds: [rows * (cols + 1) + i, rows * (cols + 1) + i + 1]
    });
  }
  for (let j = 0; j < rows; j += 1) {
    constraintEdges.push({
      markerType: 'outer',
      source: 'side-left',
      nodeIds: [j * (cols + 1), (j + 1) * (cols + 1)]
    });
    constraintEdges.push({
      markerType: 'outer',
      source: 'side-right',
      nodeIds: [j * (cols + 1) + cols, (j + 1) * (cols + 1) + cols]
    });
  }
  return { elementType: 't3', nodes, elements, cells, elementCell, constraintEdges };
}

function makeTopPressureRhs(mesh, pressure) {
  const rhs = new Float64Array(2 * mesh.nodes.length);
  for (const edge of mesh.constraintEdges) {
    if (edge.source !== 'terrain') continue;
    const [aId, bId] = edge.nodeIds;
    const a = mesh.nodes[aId];
    const b = mesh.nodes[bId];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const share = -pressure * length / 2;
    rhs[2 * aId + 1] += share;
    rhs[2 * bId + 1] += share;
  }
  return rhs;
}

function makeGravityRhs(mesh, gamma) {
  const rhs = new Float64Array(2 * mesh.nodes.length);
  for (const el of mesh.elements) {
    const a = mesh.nodes[el[0]];
    const b = mesh.nodes[el[1]];
    const c = mesh.nodes[el[2]];
    const area = 0.5 * Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const share = -gamma * area / 3;
    for (let k = 0; k < 3; k += 1) rhs[2 * el[k] + 1] += share;
  }
  return rhs;
}

function buildFixedDofs(mesh) {
  const fixed = new Set();
  for (const edge of mesh.constraintEdges) {
    if (edge.source === 'base') edge.nodeIds.forEach((n) => fixed.add(2 * n + 1));
    if (edge.source === 'side-left' || edge.source === 'side-right') {
      edge.nodeIds.forEach((n) => fixed.add(2 * n + 0));
    }
  }
  return [...fixed].sort((a, b) => a - b);
}

function buildInput() {
  const mesh = buildGrid(4, 2, 1.0, 2.0);
  const phi = 25;
  const phiRad = (phi * Math.PI) / 180;
  const region = {
    Emc: 20000,
    nu: 0.3,
    cEff: 2,
    phiEffDeg: phi,
    psiEffDeg: 5,
    K0nc: 1 - Math.sin(phiRad),
    gamma: 18,
    gammaSat: 19,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: false,
    symmetrizeEpTangent: false,
    useConsistentTangent: true,
    mc: { useConsistentTangent: true }
  };
  const numGpTotal = mesh.elements.length;
  return encodeInputBuffer({
    mesh,
    options: {
      constitutiveModel: 'mc-plastic',
      analysisType: 'safety-cphi',
      requestedContinuationMode: 'strength-control',
      useK0Init: false,
      hasSurfaceLoad: true,
      useTensionCutoff: false,
      symmetrizeTangent: false,
      nonlinearMaxIter: 48,
      maxLoadSteps: 160,
      initialLoadStep: 0.05,
      minLoadStep: 1 / 4096,
      loadStepGrowthFactor: 1.1,
      plasticLoadStepGrowthFactor: 1.05,
      plasticLoadStepCutbackFactor: 0.5,
      residualRelTol: 1e-5,
      residualAbsTol: 1e-5,
      cgMaxIter: 5000,
      cgRelTol: 1e-12,
      cgAbsTol: 1e-12,
      safetyInitialIncrement: 0.05,
      safetyGrowthFactor: 1.2,
      safetyCutbackFactor: 0.5,
      safetySigmaMax: 1.6,
      safetyBracketTolerance: 0.01,
      safetyMaxSearchTrials: 6
    },
    regions: [region],
    gravityRhsFull: makeGravityRhs(mesh, region.gamma),
    loadRhsFull: makeTopPressureRhs(mesh, 90),
    predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: new Float64Array(6 * numGpTotal),
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs: buildFixedDofs(mesh),
    numGpTotal
  });
}

const mod = await loadWasm();
const decoded = runAnalysis(mod, buildInput());
const safetyCurve = decoded.safety?.curve || [];
const maxCurveActive = safetyCurve.reduce((max, p) => Math.max(max, Number(p.activePlasticElementCount) || 0), 0);

console.log('MC-SH safety dispatch summary:', {
  summary: decoded.summary,
  safety: decoded.safety,
  maxCurveActive
});

assert.equal(decoded.summary.safetyRan, true, 'safety c-phi phase must run');
assert.ok(decoded.safety?.trialCount >= 1, 'safety c-phi must record at least one trial');
assert.ok(maxCurveActive > 0 || decoded.summary.finalActiveCount > 0, 'fixture must activate MC plasticity during safety');
assert.equal(
  decoded.summary.lastLinearSolverKind,
  1,
  'non-associated MC consistent tangent in safety must dispatch to GMRES'
);

console.log('MC-SH safety dispatch verifier PASSED.');
