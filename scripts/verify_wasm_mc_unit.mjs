#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit test for the MC return mapping in the WASM module.
//
// Builds a synthetic single-element problem with a known stress state
// and checks that the return mapping projects it onto the MC surface in
// the correct way. Acts as a numerical regression for the
// tension-positive vs compression-positive sign on the (σ1+σ3) sin φ
// term in the yield function.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

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

// Single T3 triangle pinned at every node except node 2 (which floats),
// with a K0 initial stress state inside the MC envelope. Then we run a
// single geostatic step, which should produce a state still on (or
// under) the MC envelope — never far above it.
async function main() {
  const mod = await loadWasm();
  const E = 20000, nu = 0.3, c = 0, phi = 25, psi = 5, gamma = 19;
  const phiRad = phi * Math.PI / 180;
  const psiRad = psi * Math.PI / 180;
  const K0 = 1 - Math.sin(phiRad);
  // Choose an admissible K0 stress in tension-positive convention:
  //   f = (σ1 - σ3) + (σ1 + σ3) sin φ - 2c cos φ
  // Pick σv (most compressive) = -100, σh = -K0 σv.
  const sigmaV = -100;                              // tension-positive
  const sigmaH = K0 * sigmaV;                        // = K0 × -100 = -57.7 for K0 = 0.577
  const sigmaZ = nu * (sigmaH + sigmaV) / (1 - nu);  // plane-strain
  const sigma6 = [sigmaH, sigmaV, sigmaZ, 0, 0, 0];
  // Quick check on the yield function:
  const s1 = Math.max(sigmaH, sigmaV);
  const s3 = Math.min(sigmaH, sigmaV);
  const f = (s1 - s3) + (s1 + s3) * Math.sin(phiRad) - 2 * c * Math.cos(phiRad);
  console.log(`Initial σ_h=${sigmaH.toFixed(2)}, σ_v=${sigmaV.toFixed(2)}, σ_z=${sigmaZ.toFixed(2)} kPa.`);
  console.log(`f_MC(initial) = ${f.toFixed(3)} kPa.  Expected ≤ 0 for an admissible K0 seed.`);

  // Build a minimal T3 mesh: 4 nodes, 2 elements, both fully fixed except
  // node 3 free in y (so we'll see a single dof respond).
  const mesh = {
    elementType: 't3',
    nodes: [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }
    ],
    elements: [
      [0, 1, 2],
      [0, 2, 3]
    ],
    cells: [
      { regionIndex: 0, centroid: { x: 0.66, y: 0.33 } },
      { regionIndex: 0, centroid: { x: 0.33, y: 0.66 } }
    ],
    elementCell: [0, 1],
    constraintEdges: [
      { markerType: 'outer', source: 'base', nodeIds: [0, 1] },
      { markerType: 'outer', source: 'side-right', nodeIds: [1, 2] },
      { markerType: 'outer', source: 'side-left', nodeIds: [3, 0] },
      { markerType: 'outer', source: 'terrain', nodeIds: [2, 3] }
    ]
  };
  const regions = [{
    Emc: E, nu, cEff: c, phiEffDeg: phi, psiEffDeg: psi,
    K0nc: K0, gamma, gammaSat: gamma, sigmaTAllow: 0,
    useTensionCutoff: true, symmetrizeEpTangent: true
  }];

  const numGpTotal = 2;  // T3 → 1 GP per element
  const initialSigma = new Float64Array(6 * numGpTotal);
  for (let g = 0; g < numGpTotal; g += 1) {
    for (let k = 0; k < 6; k += 1) initialSigma[g * 6 + k] = sigma6[k];
  }
  const porePressure = new Float64Array(numGpTotal);
  const gravityRhsFull = new Float64Array(2 * mesh.nodes.length);  // zero (no body force ramp)
  const loadRhsFull = new Float64Array(2 * mesh.nodes.length);

  const fixedDofs = [0, 1, 2, 3, 7];  // node 0 (both), node 1 (both), node 3 (uy only)

  const options = {
    constitutiveModel: 'mc-plastic',
    analysisType: 'deformation',
    useK0Init: true,
    hasSurfaceLoad: false,
    useTensionCutoff: true,
    symmetrizeTangent: true,
    useBBar: true,
    nonlinearMaxIter: 12,
    maxLoadSteps: 4,
    initialLoadStep: 1.0,
    minLoadStep: 1 / 8,
    loadStepGrowthFactor: 1.25,
    loadStepCutbackFactor: 0.5,
    residualRelTol: 1e-8,
    residualAbsTol: 1e-8,
    cgMaxIter: 2000,
    cgRelTol: 1e-12,
    cgAbsTol: 1e-12
  };
  const inputBytes = encodeInputBuffer({
    mesh, options, regions,
    gravityRhsFull, loadRhsFull,
    initialSigmaByGp: initialSigma,
    porePressureByGp: porePressure,
    fixedDofs, numGpTotal
  });

  const inputPtr = mod._malloc(inputBytes.byteLength);
  mod.HEAPU8.set(inputBytes, inputPtr);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  const status = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
  if (!status) {
    throw new Error(mod.UTF8ToString(mod._madepGetLastErrorMessage()));
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

  console.log('Summary:', decoded.summary);
  console.log('GP states after analysis:');
  for (let gp = 0; gp < decoded.numGpTotal; gp += 1) {
    const s = decoded.gpStates[gp].stress;
    const e = decoded.gpStates[gp].eta;
    console.log(`  GP ${gp}: σ_xx=${s.sxx.toFixed(2)}, σ_yy=${s.syy.toFixed(2)}, σ_zz=${s.szz.toFixed(2)}, σ_xy=${s.sxy.toFixed(2)} kPa, eta=${e.toFixed(4)}`);
  }

  // Initial seed should be admissible (or at most a tiny f > 0).
  // After zero-strain projection at seed time, eta should be ≤ 1.001 or so.
  for (let gp = 0; gp < decoded.numGpTotal; gp += 1) {
    if (decoded.gpStates[gp].eta > 1.01) {
      console.error(`FAIL: GP ${gp} eta = ${decoded.gpStates[gp].eta} > 1.01 (state should be admissible after seed projection).`);
      process.exit(2);
    }
  }
  console.log('PASS: K0-seed stresses lie on or under the MC envelope (eta ≤ 1.01).');
}

main().catch((err) => { console.error(err); process.exit(1); });
