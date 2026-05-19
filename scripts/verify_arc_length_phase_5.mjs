#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  decodeOutputBuffer,
  encodeInputBuffer,
  WASM_WIRE_VERSION
} from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

function buildGrid(rows, cols, lx, ly) {
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
      cells.push({ regionIndex: 0, centroid: { x: 0, y: 0 } });
      elements.push([n00, n10, n11], [n00, n11, n01]);
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
    constraintEdges.push({ markerType: 'outer', source: 'side-left', nodeIds: [j * (cols + 1), (j + 1) * (cols + 1)] });
    constraintEdges.push({ markerType: 'outer', source: 'side-right', nodeIds: [j * (cols + 1) + cols, (j + 1) * (cols + 1) + cols] });
  }
  return { elementType: 't3', nodes, elements, cells, elementCell, constraintEdges };
}

function makeGravityRhs(mesh, region) {
  const rhs = new Float64Array(2 * mesh.nodes.length);
  for (const el of mesh.elements) {
    const a = mesh.nodes[el[0]];
    const b = mesh.nodes[el[1]];
    const c = mesh.nodes[el[2]];
    const area = 0.5 * Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const share = -Math.max(region.gamma, 0) * area / 3;
    for (const node of el) rhs[2 * node + 1] += share;
  }
  return rhs;
}

function buildFixedDofs(mesh) {
  const fixed = new Set();
  for (const edge of mesh.constraintEdges) {
    if (edge.source === 'base') edge.nodeIds.forEach((n) => fixed.add(2 * n + 1));
    if (edge.source === 'side-left' || edge.source === 'side-right') {
      edge.nodeIds.forEach((n) => fixed.add(2 * n));
    }
  }
  return [...fixed].sort((a, b) => a - b);
}

function runAnalysis(mod, inputBytes) {
  const inputPtr = mod._malloc(inputBytes.byteLength);
  mod.HEAPU8.set(inputBytes, inputPtr);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    const status = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    assert.equal(status, 1, 'WASM analysis should succeed');
    const outPtr = mod.HEAPU32[outPtrSlot >> 2];
    const outLen = mod.HEAPU32[outLenSlot >> 2];
    const outBytes = new Uint8Array(outLen);
    outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._madepFreeBuffer(outPtr);
    return {
      version: new DataView(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength).getUint32(4, true),
      decoded: decodeOutputBuffer(outBytes)
    };
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

function minimalV7Output() {
  const bytes = new Uint8Array(20 + 88 + 48);
  const view = new DataView(bytes.buffer);
  let o = 0;
  const u32 = (v) => { view.setUint32(o, v >>> 0, true); o += 4; };
  const i32 = (v) => { view.setInt32(o, v | 0, true); o += 4; };
  const u8 = (v) => { view.setUint8(o, v & 0xff); o += 1; };
  const f64 = (v) => { view.setFloat64(o, Number(v) || 0, true); o += 8; };
  u32(0x4d444b54); // TDKM
  u32(7);
  u32(0); u32(0); u32(0);
  for (let i = 0; i < 10; i += 1) i32(0);
  f64(0); f64(0); f64(0); f64(0); f64(0);
  u8(1); u8(1); u8(0); for (let i = 0; i < 5; i += 1) u8(0);
  u8(0); for (let i = 0; i < 7; i += 1) u8(0);
  f64(1); f64(1); f64(1);
  i32(0); i32(0); i32(0); i32(0);
  assert.equal(o, bytes.length);
  return bytes;
}

async function main() {
  assert.equal(WASM_WIRE_VERSION, 11);
  const legacyDecoded = decodeOutputBuffer(minimalV7Output());
  assert.deepEqual(legacyDecoded.safety.curve, []);
  assert.deepEqual(legacyDecoded.safety.trialTargets, []);

  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  const mod = await factory({ wasmBinary });

  const mesh = buildGrid(3, 2, 1.0, 1.5);
  const regions = [{
    Emc: 18000,
    nu: 0.3,
    cEff: 2.0,
    phiEffDeg: 25,
    psiEffDeg: 2,
    K0nc: 1 - Math.sin(25 * Math.PI / 180),
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 0,
    useTensionCutoff: true,
    symmetrizeEpTangent: false
  }];
  const numGpTotal = mesh.elements.length;
  const baseOptions = {
    constitutiveModel: 'mc-plastic',
    analysisType: 'safety-cphi',
    useK0Init: false,
    nonlinearMaxIter: 64,
    maxLoadSteps: 512,
    initialLoadStep: 0.05,
    minLoadStep: 1 / 8192,
    residualRelTol: 5e-3,
    residualAbsTol: 1e-1,
    cgMaxIter: 8000,
    cgRelTol: 1e-6,
    cgAbsTol: 1e-6,
    safetyInitialIncrement: 0.02,
    safetyGrowthFactor: 1.1,
    safetyCutbackFactor: 0.5,
    safetySigmaMax: 1.03,
    safetyBracketTolerance: 0.02,
    safetyMaxSearchTrials: 2,
    useTensionCutoff: true,
    symmetrizeTangent: false
  };
  const commonInput = {
    mesh,
    regions,
    gravityRhsFull: makeGravityRhs(mesh, regions[0]),
    loadRhsFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: new Float64Array(6 * numGpTotal),
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs: buildFixedDofs(mesh),
    numGpTotal
  };

  const strength = runAnalysis(mod, encodeInputBuffer({
    ...commonInput,
    options: { ...baseOptions, requestedContinuationMode: 'strength-control' }
  }));
  const arc = runAnalysis(mod, encodeInputBuffer({
    ...commonInput,
    options: { ...baseOptions, requestedContinuationMode: 'arc-length' }
  }));
  const arcTuned = runAnalysis(mod, encodeInputBuffer({
    ...commonInput,
    options: {
      ...baseOptions,
      requestedContinuationMode: 'arc-length',
      arcLengthLineSearchMaxBacktracks: 4,
      arcLengthMeritMode: 'quadratic',
      arcLengthDisplacementScale: 0,
      arcLengthInitialRadiusScale: 1,
      arcLengthMinRadiusScale: 1,
      arcLengthMaxRadiusScale: 1,
      arcLengthConstraintToleranceScale: 1
    }
  }));

  assert.equal(strength.version, 10);
  assert.equal(arc.version, 10);
  assert.equal(arcTuned.version, 10);
  assert.ok(strength.decoded.safety.curve.length > 0, 'strength-control safety curve should exist');
  assert.ok(arc.decoded.safety.curve.length > 0, 'arc-length safety curve should exist');
  assert.ok(arcTuned.decoded.safety.curve.length > 0, 'tuned arc-length safety curve should exist');
  assert.equal(strength.decoded.safety.curve.some((p) => p.arcLengthDetails !== null), false);
  assert.equal(arc.decoded.safety.curve.every((p) => p.arcLengthDetails !== null), true);
  assert.equal(arcTuned.decoded.safety.curve.every((p) => p.arcLengthDetails !== null), true);
  assert.ok(Math.abs(strength.decoded.safety.factorOfSafetyLower - arc.decoded.safety.factorOfSafetyLower) <= 0.02);
  assert.ok(Number.isFinite(arcTuned.decoded.safety.factorOfSafetyLower));
  assert.ok(arcTuned.decoded.safety.factorOfSafetyLower >= 1.0);
  for (const point of arc.decoded.safety.curve) {
    assert.equal(point.arcLengthDetails.actualContinuationMode, 'arc-length');
    assert.ok(Number.isFinite(point.arcLengthDetails.deltaLambda));
    assert.ok(Number.isFinite(point.arcLengthDetails.deltaS));
    assert.ok(Number.isFinite(point.arcLengthDetails.alpha));
    assert.ok(Number.isFinite(point.arcLengthDetails.constraintResidual));
    assert.ok(Number.isFinite(point.arcLengthDetails.correctionDenominator));
    assert.ok(Number.isInteger(point.arcLengthDetails.failureCode));
    assert.ok(point.sigmaMsf >= 1);
  }
  const defaultFirstDeltaS = arc.decoded.safety.curve[0]?.arcLengthDetails?.deltaS;
  const tunedFirstDeltaS = arcTuned.decoded.safety.curve[0]?.arcLengthDetails?.deltaS;
  assert.ok(Number.isFinite(defaultFirstDeltaS));
  assert.ok(Number.isFinite(tunedFirstDeltaS));
  assert.ok(
    tunedFirstDeltaS < defaultFirstDeltaS,
    'auto displacement scale should reduce the first accepted arc-length radius on this >1m model'
  );

  console.log('Arc-length Phase 5 safety-curve checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
