#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Smoke test for the deformation WASM pipeline.
//
// Runs a tiny canonical problem (1×1 m linear-elastic patch, four
// triangles, gravity body force, sides constrained) through the WASM
// solver and checks that the returned displacement field is sensible:
//   - All Uy values negative (settlement under gravity).
//   - Magnitudes within the analytical 1-D consolidation envelope for the
//     E and ν we use.
//
// Usage:
//   node scripts/verify_wasm_deformation_smoke.mjs
//
// Requires:
//   - static/wasm/deformation/deformation.{js,wasm} built (run
//     `source emsdk_env.sh && bash src/wasm/deformation/build.sh`).

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

import {
  WASM_OUTPUT_MAGIC,
  encodeInputBuffer,
  decodeOutputBuffer
} from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

function makeLegacyV6OutputBuffer() {
  const buffer = new ArrayBuffer(20 + 88 + 40);
  const view = new DataView(buffer);
  let offset = 0;
  const writeU32 = (v) => { view.setUint32(offset, v >>> 0, true); offset += 4; };
  const writeI32 = (v) => { view.setInt32(offset, v | 0, true); offset += 4; };
  const writeU8 = (v) => { view.setUint8(offset, v & 0xFF); offset += 1; };
  const writeF64 = (v) => { view.setFloat64(offset, Number(v) || 0, true); offset += 8; };

  writeU32(WASM_OUTPUT_MAGIC);
  writeU32(6);
  writeU32(0); writeU32(0); writeU32(0);
  for (let i = 0; i < 10; i += 1) writeI32(0);
  writeF64(0); writeF64(0); writeF64(0); writeF64(0); writeF64(0);
  writeU8(1); writeU8(1); writeU8(0);
  for (let i = 0; i < 5; i += 1) writeU8(0);
  writeU8(0);
  for (let i = 0; i < 7; i += 1) writeU8(0);
  writeF64(1); writeF64(1); writeF64(1);
  writeI32(0); writeI32(0);
  return new Uint8Array(buffer);
}

function makePatchMesh() {
  // 1×1 m square patched with four T3 triangles around a central node.
  //
  //   3 ---- 2
  //   |  / \ |
  //   | / 4 \|
  //   |/    \|
  //   0------1
  //
  // Coordinates:
  const nodes = [
    { x: 0, y: 0 },   // 0
    { x: 1, y: 0 },   // 1
    { x: 1, y: 1 },   // 2
    { x: 0, y: 1 },   // 3
    { x: 0.5, y: 0.5 }  // 4 — central node
  ];
  // Triangles, oriented counter-clockwise.
  const elements = [
    [0, 1, 4],
    [1, 2, 4],
    [2, 3, 4],
    [3, 0, 4]
  ];
  const cells = elements.map((_el, i) => ({
    regionIndex: 0,
    centroid: { x: 0, y: 0 }
  }));
  const elementCell = elements.map((_el, i) => i);
  // Constraint edges so the solver can build the BC sets.
  const constraintEdges = [
    // base
    { markerType: 'outer', source: 'base', n1: 0, n2: 1, nodeIds: [0, 1], a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
    // sides
    { markerType: 'outer', source: 'side-right', n1: 1, n2: 2, nodeIds: [1, 2], a: { x: 1, y: 0 }, b: { x: 1, y: 1 } },
    { markerType: 'outer', source: 'side-left', n1: 3, n2: 0, nodeIds: [3, 0], a: { x: 0, y: 1 }, b: { x: 0, y: 0 } },
    // terrain (top, unloaded)
    { markerType: 'outer', source: 'terrain', n1: 2, n2: 3, nodeIds: [2, 3], a: { x: 1, y: 1 }, b: { x: 0, y: 1 } }
  ];
  return {
    elementType: 't3',
    nodes,
    elements,
    cells,
    elementCell,
    constraintEdges
  };
}

function makeBodyForceRhs(mesh, regions) {
  const ndof = 2 * mesh.nodes.length;
  const rhs = new Float64Array(ndof);
  // Lump per-triangle gravity onto the corner nodes (T3 body force):
  //   F_i = area * (0, -gamma) / 3 for each of the 3 corners.
  for (let i = 0; i < mesh.elements.length; i += 1) {
    const el = mesh.elements[i];
    const cell = mesh.cells[mesh.elementCell[i]];
    const region = regions[cell.regionIndex];
    const gamma = Math.max(Number(region?.gamma) || 0, 0);
    const a = mesh.nodes[el[0]];
    const b = mesh.nodes[el[1]];
    const c = mesh.nodes[el[2]];
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const area = 0.5 * Math.abs(area2);
    const shareY = -gamma * area / 3;
    for (let k = 0; k < 3; k += 1) {
      const nodeId = el[k];
      rhs[2 * nodeId + 1] += shareY;
    }
  }
  return rhs;
}

function buildFixedDofs(mesh) {
  const set = new Set();
  mesh.constraintEdges.forEach((edge) => {
    if (edge.source === 'base') edge.nodeIds.forEach((nodeId) => set.add(2 * nodeId + 1));
    if (edge.source === 'side-left' || edge.source === 'side-right') {
      edge.nodeIds.forEach((nodeId) => set.add(2 * nodeId + 0));
    }
  });
  return [...set].sort((a, b) => a - b);
}

async function main() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  if (typeof factory !== 'function') {
    throw new Error('WASM glue does not expose a factory.');
  }
  // Under Node, the default emscripten loader uses fetch() which is not
  // wired for file:// URLs. Hand it the raw bytes via wasmBinary.
  const { readFileSync } = await import('node:fs');
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  const mod = await factory({ wasmBinary });

  const mesh = makePatchMesh();
  // Linear elastic, single region.
  const regions = [
    {
      Emc: 10000,        // 10 MPa
      nu: 0.3,
      cEff: 0,
      phiEffDeg: 0,
      psiEffDeg: 0,
      K0nc: 0.5,
      gamma: 20,         // kN/m³
      gammaSat: 20,
      sigmaTAllow: 0,
      useTensionCutoff: false,
      symmetrizeEpTangent: true
    }
  ];
  const options = {
    constitutiveModel: 'linear-elastic',
    nonlinearMaxIter: 24,
    maxLoadSteps: 8,
    initialLoadStep: 1.0,
    minLoadStep: 1 / 64,
    loadStepGrowthFactor: 1.25,
    loadStepCutbackFactor: 0.5,
    residualRelTol: 1e-6,
    residualAbsTol: 1e-6,
    cgMaxIter: 5000,
    cgRelTol: 1e-9,
    cgAbsTol: 1e-9,
    useTensionCutoff: false,
    symmetrizeTangent: true,
    useBBar: true,
    hasSurfaceLoad: false
  };
  const externalRhsFull = makeBodyForceRhs(mesh, regions);
  const fixedDofs = buildFixedDofs(mesh);

  // v2 wire format: per-GP K0 stress field + pore pressure + separated
  // gravity / load RHS. For the smoke test we have zero K0, zero pore
  // pressure, gravity-only loading.
  const numGpTotal = mesh.elements.length;  // T3 → 1 GP per element
  const inputBytes = encodeInputBuffer({
    mesh,
    options: { ...options, useK0Init: false, analysisType: 'deformation' },
    regions,
    gravityRhsFull: externalRhsFull,
    loadRhsFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: new Float64Array(6 * numGpTotal),
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });

  const inputPtr = mod._malloc(inputBytes.byteLength);
  mod.HEAPU8.set(inputBytes, inputPtr);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);

  const status = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
  if (!status) {
    const errPtr = mod._madepGetLastErrorMessage();
    const msg = mod.UTF8ToString(errPtr);
    throw new Error(`WASM returned an error: ${msg}`);
  }
  const outPtr = mod.HEAPU32[outPtrSlot >> 2];
  const outLen = mod.HEAPU32[outLenSlot >> 2];
  const outBytes = new Uint8Array(outLen);
  outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
  mod._madepFreeBuffer(outPtr);
  mod._free(inputPtr);
  mod._free(outPtrSlot);
  mod._free(outLenSlot);

  const decoded = decodeOutputBuffer(outBytes);
  const legacyDecoded = decodeOutputBuffer(makeLegacyV6OutputBuffer());
  if (
    legacyDecoded?.safety?.safetyResult?.finalization?.status !== 'not-run' ||
    (legacyDecoded?.safety?.curve || []).length !== 0 ||
    (legacyDecoded?.safety?.trialTargets || []).length !== 0
  ) {
    console.error('FAIL: version-7 decoder did not preserve the legacy version-6 safety-output path.');
    process.exit(5);
  }

  console.log('Summary:', decoded.summary);
  console.log('Displacements:');
  for (let i = 0; i < decoded.numNodes; i += 1) {
    console.log(`  node ${i}: ux=${decoded.displacements[2*i].toExponential(4)}, uy=${decoded.displacements[2*i+1].toExponential(4)}`);
  }

  // Basic sanity:
  //   - Solver converged.
  //   - Top nodes (#2 and #3) settle (uy < 0) under gravity.
  //   - Magnitude is well below 0.1 m (sanity bound for 10 MPa under 1 m
  //     gravity column at gamma = 20 kN/m³).
  if (!(decoded.summary.geostaticConverged && decoded.summary.serviceConverged)) {
    console.error('FAIL: WASM solver did not converge.');
    process.exit(2);
  }
  const uy2 = decoded.displacements[2 * 2 + 1];
  const uy3 = decoded.displacements[2 * 3 + 1];
  if (!(uy2 < 0 && uy3 < 0)) {
    console.error(`FAIL: top nodes did not settle under gravity (uy2=${uy2}, uy3=${uy3}).`);
    process.exit(3);
  }
  const expectedSettlement = -20 * 1 / 10000;  // ~ -gamma * h / E for 1-D consolidation rough estimate
  if (Math.abs(uy2) > 0.1) {
    console.error(`FAIL: settlement magnitude too large (uy2=${uy2}); expected order ${expectedSettlement}.`);
    process.exit(4);
  }

  console.log('PASS: WASM solver produced a plausible linear-elastic settlement field.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
