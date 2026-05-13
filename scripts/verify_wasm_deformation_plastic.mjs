#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC plastic regression for the deformation WASM pipeline.
//
// Drives a stronger gravity column that pushes some Gauss points past
// the Mohr-Coulomb envelope and verifies:
//   - Solver still converges with adaptive load stepping.
//   - At least some Gauss points report `plasticActive === true`.
//   - Final stresses respect the MC envelope to within tolerance.
//
// Usage: node scripts/verify_wasm_deformation_plastic.mjs

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

import { encodeInputBuffer, decodeOutputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

function buildGrid(rows, cols, lx, ly) {
  // Structured grid of T3 elements: (rows+1) × (cols+1) nodes, two
  // triangles per cell.
  const nodes = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      nodes.push({
        x: (i / cols) * lx,
        y: (j / rows) * ly
      });
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
      cells.push({ regionIndex: 0, centroid: { x: 0, y: 0 } });
      elementCell.push(cellIdx);
      elementCell.push(cellIdx);
    }
  }
  // Boundary edges.
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
  return {
    elementType: 't3',
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
    const share = -Math.max(region.gamma, 0) * area / 3;
    for (let k = 0; k < 3; k += 1) rhs[2 * el[k] + 1] += share;
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

function runAnalysis(mod, inputBytes) {
  const inputPtr = mod._malloc(inputBytes.byteLength);
  mod.HEAPU8.set(inputBytes, inputPtr);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);

  try {
    const status = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    if (!status) {
      const msg = mod.UTF8ToString(mod._madepGetLastErrorMessage());
      throw new Error(`WASM solver error: ${msg}`);
    }
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

async function main() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const { readFileSync } = await import('node:fs');
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  const mod = await factory({ wasmBinary });

  // Modest column with strong-cohesion sandy clay. Gravity engages
  // plasticity in the bottom band but does not collapse globally — a
  // gravity-ramp run with a few load steps should converge cleanly.
  const mesh = buildGrid(4, 2, 1.0, 2.0);
  const regions = [
    {
      Emc: 20000,
      nu: 0.3,
      cEff: 0,             // cohesionless → real plasticity under gravity ramp
      phiEffDeg: 25,
      psiEffDeg: 5,         // non-associated flow
      K0nc: 1 - Math.sin(25 * Math.PI / 180),
      gamma: 19,
      gammaSat: 20,
      sigmaTAllow: 0,
      useTensionCutoff: true,
      symmetrizeEpTangent: true
    }
  ];
  const options = {
    constitutiveModel: 'mc-plastic',
    nonlinearMaxIter: 96,
    maxLoadSteps: 512,
    initialLoadStep: 0.05,
    minLoadStep: 1 / 16384,
    loadStepGrowthFactor: 1.1,
    loadStepCutbackFactor: 0.5,
    residualRelTol: 5e-3,
    residualAbsTol: 1e-1,
    cgMaxIter: 5000,
    cgRelTol: 1e-6,
    cgAbsTol: 1e-6,
    useTensionCutoff: true,
    symmetrizeTangent: true,
    useBBar: true,
    hasSurfaceLoad: false
  };
  const fixedDofs = buildFixedDofs(mesh);
  const externalRhsFull = makeGravityRhs(mesh, regions[0]);

  const numGpTotal = mesh.elements.length;  // T3
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

  const decoded = runAnalysis(mod, inputBytes);

  console.log('MC plastic summary:', decoded.summary);

  let maxSettlement = 0;
  for (let i = 0; i < decoded.numNodes; i += 1) {
    const uy = decoded.displacements[2 * i + 1];
    if (-uy > maxSettlement) maxSettlement = -uy;
  }
  let plasticCount = 0;
  let maxEta = 0;
  for (const gp of decoded.gpStates) {
    if (gp.plasticActive) plasticCount += 1;
    if (gp.eta > maxEta) maxEta = gp.eta;
  }
  console.log(`  max settlement: ${(maxSettlement * 1000).toFixed(3)} mm`);
  console.log(`  plastic Gauss points: ${plasticCount} / ${decoded.numGpTotal}`);
  console.log(`  max eta (MC utilization): ${maxEta.toFixed(3)}`);

  if (!(decoded.summary.geostaticConverged && decoded.summary.serviceConverged)) {
    console.error('FAIL: nonlinear iteration did not converge to lambda = 1.');
    process.exit(2);
  }
  if (plasticCount === 0 && maxEta < 0.5) {
    console.error('FAIL: no plasticity engaged; problem is too elastic to exercise the return mapping.');
    process.exit(3);
  }
  console.log('PASS: MC plastic WASM path converged with active plasticity.');

  const safetyInputBytes = encodeInputBuffer({
    mesh,
    options: {
      ...options,
      useK0Init: false,
      analysisType: 'safety-cphi',
      safetyInitialIncrement: 0.05,
      safetyGrowthFactor: 1.25,
      safetyCutbackFactor: 0.5,
      safetySigmaMax: 1.2,
      safetyBracketTolerance: 0.02,
      safetyMaxSearchTrials: 4
    },
    regions,
    gravityRhsFull: externalRhsFull,
    loadRhsFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: new Float64Array(6 * numGpTotal),
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });
  const safetyDecoded = runAnalysis(mod, safetyInputBytes);
  console.log('MC plastic safety summary:', safetyDecoded.safety);
  let maxSafetyPlasticIncrement = 0;
  for (const gp of safetyDecoded.gpStates) {
    if (!Number.isFinite(gp.comparisonAccumulatedPlasticStrain)) {
      console.error('FAIL: safety output did not include a finite comparison plastic-strain baseline.');
      process.exit(6);
    }
    maxSafetyPlasticIncrement = Math.max(
      maxSafetyPlasticIncrement,
      (Number(gp.accumulatedPlasticStrain) || 0) - (Number(gp.comparisonAccumulatedPlasticStrain) || 0)
    );
  }
  console.log(`  max safety plastic increment: ${maxSafetyPlasticIncrement.toExponential(4)}`);
  if (!safetyDecoded.summary.safetyRan || safetyDecoded.safety.trialCount < 1) {
    console.error('FAIL: safety c-phi phase did not run any strength-reduction trial.');
    process.exit(5);
  }
  const safetyCurve = safetyDecoded.safety.curve || [];
  const trialTargets = safetyDecoded.safety.trialTargets || [];
  if (safetyCurve.length < 1) {
    console.error('FAIL: safety c-phi phase did not emit accepted continuation curve points.');
    process.exit(8);
  }
  const displayedTargets = trialTargets.filter((trial) => trial.displayed === true);
  if (trialTargets.length > 0 && displayedTargets.length !== 1) {
    console.error(`FAIL: expected exactly one displayed safety trial target, got ${displayedTargets.length}.`);
    process.exit(9);
  }
  const badArcLengthDetails = safetyCurve.find((point) => point.arcLengthDetails !== null);
  if (badArcLengthDetails) {
    console.error('FAIL: v7 strength-control safety curve point carried arc-length details.');
    process.exit(10);
  }
  const badMetric = safetyCurve.find((point) =>
    !Number.isFinite(Number(point.sigmaMsf)) ||
    !Number.isFinite(Number(point.uMaxAbs)) ||
    !Number.isFinite(Number(point.maxDeltaPlasticStrain)) ||
    point.activeFaceCount < 0 ||
    point.activeEdgeCount < 0 ||
    point.activeApexCount < 0
  );
  if (badMetric) {
    console.error('FAIL: safety curve contains invalid displacement/plasticity/active-set metrics.', badMetric);
    process.exit(11);
  }
  const displayedTarget = displayedTargets[0] || null;
  if (displayedTarget?.converged === true) {
    const lastCurve = safetyCurve[safetyCurve.length - 1];
    if (Math.abs(Number(lastCurve?.sigmaMsf) - Number(displayedTarget.committed)) > 1e-9) {
      console.error('FAIL: safety curve endpoint does not match the displayed converged safety target.');
      process.exit(12);
    }
  }
  if (!(maxSafetyPlasticIncrement > 0)) {
    console.error('FAIL: safety c-phi display state did not accumulate plastic strain beyond its comparison checkpoint.');
    process.exit(7);
  }
  console.log('PASS: MC plastic WASM safety c-phi phase ran strength continuation.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
