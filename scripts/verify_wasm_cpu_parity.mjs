#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end parity verification: run the CPU JS path and the WASM CPU
// path on the same synthetic-but-realistic Stage 6 model, compare nodal
// displacements, stress fields, and plasticity diagnostics.
//
// The goal is to surface the "vastly different outcomes" the user
// reported by reproducing them on a controlled input.
//
// Usage:
//   npm run build:wasm:deformation
//   node scripts/verify_wasm_cpu_parity.mjs

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  __setDeformationWasmModuleForTests,
  __resetDeformationWasmModuleForTests
} from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

// Polyfill performance.now for the Stage6 model code that uses it.
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
// Polyfill self for any worker-only code paths exercised during model
// construction.
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

async function loadWasmModule() {
  const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function buildSyntheticModel() {
  // Three-layer flat profile, 20 m wide × 10 m deep, with a 4 m wide
  // strip load at the surface in the middle. The materials roughly
  // mirror typical CPT-derived parameters: stiff sand on top, soft
  // clay in the middle, dense sand below.
  const xMin = 0;
  const xMax = 20;
  const yTop = 10;
  const yBottom = 0;
  const layerTops = [10, 7.5, 4.5];
  const terrain = {
    vertices: [{ x: xMin, y: yTop }, { x: xMax, y: yTop }]
  };
  const phreatic = { vertices: [{ x: xMin, y: 8.5 }, { x: xMax, y: 8.5 }] };
  const regions = [
    {
      id: 'sand-1', label: 'Sand 1',
      polygon: [{ x: xMin, y: layerTops[0] }, { x: xMax, y: layerTops[0] }, { x: xMax, y: layerTops[1] }, { x: xMin, y: layerTops[1] }],
      material: {
        id: 'sand-1', label: 'Sand 1',
        Emc: 30000, nu: 0.3, cEff: 1, phiEffDeg: 32, psiEffDeg: 2,
        gamma: 19, gammaSat: 20, K0nc: 1 - Math.sin(32 * Math.PI / 180),
        sigmaTAllow: 0
      }
    },
    {
      id: 'clay-1', label: 'Clay 1',
      polygon: [{ x: xMin, y: layerTops[1] }, { x: xMax, y: layerTops[1] }, { x: xMax, y: layerTops[2] }, { x: xMin, y: layerTops[2] }],
      material: {
        id: 'clay-1', label: 'Clay 1',
        Emc: 8000, nu: 0.35, cEff: 18, phiEffDeg: 22, psiEffDeg: 0,
        gamma: 18, gammaSat: 19, K0nc: 1 - Math.sin(22 * Math.PI / 180),
        sigmaTAllow: 0
      }
    },
    {
      id: 'sand-2', label: 'Sand 2',
      polygon: [{ x: xMin, y: layerTops[2] }, { x: xMax, y: layerTops[2] }, { x: xMax, y: yBottom }, { x: xMin, y: yBottom }],
      material: {
        id: 'sand-2', label: 'Sand 2',
        Emc: 60000, nu: 0.3, cEff: 0, phiEffDeg: 36, psiEffDeg: 6,
        gamma: 20, gammaSat: 21, K0nc: 1 - Math.sin(36 * Math.PI / 180),
        sigmaTAllow: 0
      }
    }
  ];
  return {
    terrain,
    phreatic,
    regions,
    analysisLeftX: xMin,
    analysisRightX: xMax,
    analysisBottomY: yBottom,
    analysisTopY: yTop,
    walls: [],
    surfaceLoad: { xStart: 8, xEnd: 12, q: 80 },   // 80 kPa strip load
    seepage: null
  };
}

function buildInput(model, constitutiveModel, useWasm, meshElementType = 't3', analysisType = 'deformation') {
  return {
    model,
    options: {
      analysisType,
      meshElementType,
      meshTargetArea: 0.5,
      loadMode: 'pressure',
      constitutiveModel,
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      initialStressMode: 'plastic-geostatic',
      residualRelTol: 1e-4,
      residualAbsTol: 1e-3,
      nonlinearMaxIterations: 32,
      initialLoadStep: 0.25,
      minLoadStep: 1 / 2048,
      maxLoadSteps: 256,
      useUnsymmetricPlasticSolver: false,
      useWasmCpuPipeline: !!useWasm,
      useNewGpuPipeline: false
    }
  };
}

async function runCpu(model, constitutiveModel, meshElementType, analysisType) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  return analyzeDeformationModel(buildInput(model, constitutiveModel, false, meshElementType, analysisType));
}

async function runWasm(model, constitutiveModel, meshElementType, analysisType) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  return analyzeDeformationModel(buildInput(model, constitutiveModel, true, meshElementType, analysisType));
}

function summariseDisplacement(label, displacements) {
  let maxUx = 0, maxUy = 0, maxAbs = 0;
  for (const d of displacements) {
    const ux = Math.abs(d.ux || 0);
    const uy = Math.abs(d.uy || 0);
    if (ux > maxUx) maxUx = ux;
    if (uy > maxUy) maxUy = uy;
    const a = Math.hypot(ux, uy);
    if (a > maxAbs) maxAbs = a;
  }
  return { label, count: displacements.length, maxUx, maxUy, maxAbs };
}

function diffDisplacements(a, b) {
  // Both arrays must agree on length (same mesh). If not, return Infinity.
  if (a.length !== b.length) return { ok: false, reason: `mesh size mismatch ${a.length} vs ${b.length}` };
  let maxDelta = 0;
  let sumDelta2 = 0;
  for (let i = 0; i < a.length; i += 1) {
    const dx = (a[i].ux || 0) - (b[i].ux || 0);
    const dy = (a[i].uy || 0) - (b[i].uy || 0);
    const d = Math.hypot(dx, dy);
    if (d > maxDelta) maxDelta = d;
    sumDelta2 += d * d;
  }
  return { ok: true, maxDelta, rmsDelta: Math.sqrt(sumDelta2 / a.length) };
}

async function main() {
  const wasmInstance = await loadWasmModule();
  __setDeformationWasmModuleForTests(wasmInstance);

  const model = buildSyntheticModel();

  console.log('Model: 20×10 m three-layer profile with 4 m strip load q=80 kPa.');

  const cases = [
    { constitutiveModel: 'linear-elastic', meshElementType: 't3', analysisType: 'deformation' },
    { constitutiveModel: 'mc-plastic',      meshElementType: 't3', analysisType: 'deformation' },
    { constitutiveModel: 'linear-elastic', meshElementType: 't6', analysisType: 'deformation' },
    { constitutiveModel: 'mc-plastic',      meshElementType: 't6', analysisType: 'deformation' },
    { constitutiveModel: 'mc-plastic',      meshElementType: 't3', analysisType: 'safety-cphi' }
  ];

  for (const tc of cases) {
    const { constitutiveModel, meshElementType, analysisType } = tc;
    console.log(`\n=== ${analysisType} / ${meshElementType} / ${constitutiveModel} ===`);
    const cpu = await runCpu(model, constitutiveModel, meshElementType, analysisType);
    const wasm = await runWasm(model, constitutiveModel, meshElementType, analysisType);

    const cpuSummary = summariseDisplacement('CPU', cpu.nodalDisplacements);
    const wasmSummary = summariseDisplacement('WASM', wasm.nodalDisplacements);
    console.log(' CPU:', cpuSummary);
    console.log('WASM:', wasmSummary);

    const diff = diffDisplacements(cpu.nodalDisplacements, wasm.nodalDisplacements);
    if (!diff.ok) {
      console.error('FAIL:', diff.reason);
      continue;
    }
    const rel = cpuSummary.maxAbs > 1e-12 ? diff.maxDelta / cpuSummary.maxAbs : 0;
    console.log(` max |ΔU| = ${diff.maxDelta.toExponential(3)} m`);
    console.log(` rms |ΔU| = ${diff.rmsDelta.toExponential(3)} m`);
    console.log(` relative = ${rel.toExponential(3)}`);

    // CPU max settlement vs WASM max settlement.
    const cpuMaxSettlement = Math.max(0, ...cpu.nodalDisplacements.map((d) => -(d.uy || 0)));
    const wasmMaxSettlement = Math.max(0, ...wasm.nodalDisplacements.map((d) => -(d.uy || 0)));
    console.log(` CPU max settlement: ${(cpuMaxSettlement * 1000).toFixed(3)} mm`);
    console.log(`WASM max settlement: ${(wasmMaxSettlement * 1000).toFixed(3)} mm`);

    // Plastic counts.
    const cpuActive = Number(cpu?.solver?.finalActiveMcElements) || 0;
    const wasmActive = Number(wasm?.solver?.finalActiveMcElements) || 0;
    console.log(` plastic elements — CPU: ${cpuActive}, WASM: ${wasmActive}`);
    if (analysisType === 'safety-cphi') {
      const cpuFos = Number(cpu?.solver?.safetyFactorOfSafetyLower) || 0;
      const wasmFos = Number(wasm?.solver?.safetyFactorOfSafetyLower) || 0;
      console.log(` factor of safety — CPU: ${cpuFos.toFixed(3)}, WASM: ${wasmFos.toFixed(3)}`);
    }
  }

  __resetDeformationWasmModuleForTests();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
