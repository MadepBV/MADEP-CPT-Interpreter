#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T6 sanity check for the WASM deformation pipeline. Same patch-test
// geometry as the smoke test but with the quadratic element family.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

import { encodeInputBuffer, decodeOutputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

function makeT6Patch() {
  // Two T6 triangles forming a 1×1 m square.
  //
  //   3 -----m23----- 2
  //   |  \         /  |
  //   m31  \  e1 /   m12_e1
  //   |     \ / /     |
  //   |      /  \     |
  //   m31'  /     \  m12_e0
  //   |   /   e0    \ |
  //   |  /             \|
  //   0------ m01 ------1
  //
  // Simpler: just one T6 triangle on a unit triangle, with midpoints.
  // Use two adjacent T6 triangles sharing the diagonal.
  const v0 = { x: 0, y: 0 };
  const v1 = { x: 1, y: 0 };
  const v2 = { x: 1, y: 1 };
  const v3 = { x: 0, y: 1 };
  // Triangle A: v0, v1, v2 → midpoints m12, m02, m01
  // Triangle B: v0, v2, v3 → midpoints m23, m03, m02
  const m01 = { x: 0.5, y: 0 };
  const m12 = { x: 1, y: 0.5 };
  const m02 = { x: 0.5, y: 0.5 };
  const m23 = { x: 0.5, y: 1 };
  const m03 = { x: 0, y: 0.5 };
  const nodes = [v0, v1, v2, v3, m01, m12, m02, m23, m03];
  // Triangle's o2 ordering: [v1, v2, v3, m_{2-3}, m_{3-1}, m_{1-2}].
  // Triangle A nodes (v0=0, v1=1, v2=2):
  //   m_{1-2} = mid(v0,v1) = m01 = node 4
  //   m_{2-3} = mid(v1,v2) = m12 = node 5
  //   m_{3-1} = mid(v0,v2) = m02 = node 6
  // Triangle's order: [v0, v1, v2, m12, m02, m01] = [0, 1, 2, 5, 6, 4]
  // Triangle B nodes (v0=0, v2=2, v3=3):
  //   m_{1-2} = mid(v0,v2) = m02 = node 6
  //   m_{2-3} = mid(v2,v3) = m23 = node 7
  //   m_{3-1} = mid(v3,v0) = m03 = node 8
  // → [0, 2, 3, 7, 8, 6]
  const elements = [
    [0, 1, 2, 5, 6, 4],
    [0, 2, 3, 7, 8, 6]
  ];
  const cells = elements.map(() => ({ regionIndex: 0, centroid: { x: 0, y: 0 } }));
  const elementCell = elements.map((_e, i) => i);
  const constraintEdges = [
    { markerType: 'outer', source: 'base', nodeIds: [0, 1, 4] },
    { markerType: 'outer', source: 'side-right', nodeIds: [1, 2, 5] },
    { markerType: 'outer', source: 'terrain', nodeIds: [2, 3, 7] },
    { markerType: 'outer', source: 'side-left', nodeIds: [3, 0, 8] }
  ];
  return {
    elementType: 't6',
    nodes,
    elements,
    cells,
    elementCell,
    constraintEdges
  };
}

function makeGravityRhs(mesh, region) {
  const ndof = 2 * mesh.nodes.length;
  const rhs = new Float64Array(ndof);
  for (let i = 0; i < mesh.elements.length; i += 1) {
    const el = mesh.elements[i];
    const a = mesh.nodes[el[0]];
    const b = mesh.nodes[el[1]];
    const c = mesh.nodes[el[2]];
    const area = 0.5 * Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const midShare = -region.gamma * area / 3;
    // T6 corner-shape integrals over constant body force are zero; only
    // midpoint nodes get the share.
    for (let k = 3; k < 6; k += 1) {
      const nodeId = el[k];
      rhs[2 * nodeId + 1] += midShare;
    }
  }
  return rhs;
}

function buildFixedDofs(mesh) {
  const set = new Set();
  for (const edge of mesh.constraintEdges) {
    if (edge.source === 'base') edge.nodeIds.forEach((n) => set.add(2 * n + 1));
    if (edge.source === 'side-left' || edge.source === 'side-right')
      edge.nodeIds.forEach((n) => set.add(2 * n + 0));
  }
  return [...set].sort((a, b) => a - b);
}

async function main() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const { readFileSync } = await import('node:fs');
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  const mod = await factory({ wasmBinary });

  const mesh = makeT6Patch();
  const regions = [{
    Emc: 10000,
    nu: 0.3,
    cEff: 0,
    phiEffDeg: 0,
    psiEffDeg: 0,
    K0nc: 0.5,
    gamma: 20,
    gammaSat: 20,
    sigmaTAllow: 0,
    useTensionCutoff: false,
    symmetrizeEpTangent: true
  }];
  const options = {
    constitutiveModel: 'linear-elastic',
    nonlinearMaxIter: 12,
    maxLoadSteps: 4,
    initialLoadStep: 1.0,
    minLoadStep: 1 / 32,
    loadStepGrowthFactor: 1.25,
    loadStepCutbackFactor: 0.5,
    residualRelTol: 1e-7,
    residualAbsTol: 1e-7,
    cgMaxIter: 5000,
    cgRelTol: 1e-9,
    cgAbsTol: 1e-9,
    useTensionCutoff: false,
    symmetrizeTangent: true,
    useBBar: true,
    hasSurfaceLoad: false
  };
  const externalRhsFull = makeGravityRhs(mesh, regions[0]);
  const fixedDofs = buildFixedDofs(mesh);

  const numGpTotal = mesh.elements.length * 3;  // T6 → 3 GP per element
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
  if (!status) throw new Error(mod.UTF8ToString(mod._madepGetLastErrorMessage()));
  const outPtr = mod.HEAPU32[outPtrSlot >> 2];
  const outLen = mod.HEAPU32[outLenSlot >> 2];
  const outBytes = new Uint8Array(outLen);
  outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
  mod._madepFreeBuffer(outPtr);
  mod._free(inputPtr);
  mod._free(outPtrSlot);
  mod._free(outLenSlot);

  const decoded = decodeOutputBuffer(outBytes);
  console.log('T6 summary:', decoded.summary);
  console.log('  numGpTotal:', decoded.numGpTotal);

  // Sanity:
  //   - Solver converged.
  //   - Top corners settle.
  //   - 3 GPs per element → 6 GPs total for two elements.
  if (!(decoded.summary.geostaticConverged && decoded.summary.serviceConverged)) {
    console.error('FAIL: T6 solver did not converge.');
    process.exit(2);
  }
  if (decoded.numGpTotal !== 6) {
    console.error(`FAIL: expected 6 Gauss points (3 per T6 element × 2 elements); got ${decoded.numGpTotal}.`);
    process.exit(3);
  }
  // The top-edge nodes are v3 (index 3) and v2 (index 2) and the midpoint m23 (index 7).
  const uy_v2 = decoded.displacements[2 * 2 + 1];
  const uy_v3 = decoded.displacements[2 * 3 + 1];
  const uy_m23 = decoded.displacements[2 * 7 + 1];
  console.log(`  uy(v2) = ${uy_v2.toExponential(4)}, uy(v3) = ${uy_v3.toExponential(4)}, uy(m23) = ${uy_m23.toExponential(4)}`);
  if (!(uy_v2 < 0 && uy_v3 < 0 && uy_m23 < 0)) {
    console.error('FAIL: top edge nodes did not settle under gravity.');
    process.exit(4);
  }
  console.log('PASS: T6 WASM solver settled the top corners under gravity.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
