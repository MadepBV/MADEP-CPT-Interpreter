#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  __setDeformationWasmModuleForTests,
  __resetDeformationWasmModuleForTests
} from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

async function loadWasmModule() {
  const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function buildModel(surfacePressure = 80) {
  return {
    terrain: { vertices: [{ x: 0, y: 10 }, { x: 20, y: 10 }] },
    phreatic: { vertices: [{ x: 0, y: 8.5 }, { x: 20, y: 8.5 }] },
    regions: [
      { id: 'sand-1', label: 'Sand 1',
        polygon: [{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 7.5 }, { x: 0, y: 7.5 }],
        material: { id: 's1', label: 'S1', Emc: 30000, nu: 0.3, cEff: 1, phiEffDeg: 32, psiEffDeg: 2,
          gamma: 19, gammaSat: 20, K0nc: 1 - Math.sin(32 * Math.PI / 180), sigmaTAllow: 0 } },
      { id: 'clay-1', label: 'Clay 1',
        polygon: [{ x: 0, y: 7.5 }, { x: 20, y: 7.5 }, { x: 20, y: 4.5 }, { x: 0, y: 4.5 }],
        material: { id: 'c1', label: 'C1', Emc: 8000, nu: 0.35, cEff: 18, phiEffDeg: 22, psiEffDeg: 0,
          gamma: 18, gammaSat: 19, K0nc: 1 - Math.sin(22 * Math.PI / 180), sigmaTAllow: 0 } },
      { id: 'sand-2', label: 'Sand 2',
        polygon: [{ x: 0, y: 4.5 }, { x: 20, y: 4.5 }, { x: 20, y: 0 }, { x: 0, y: 0 }],
        material: { id: 's2', label: 'S2', Emc: 60000, nu: 0.3, cEff: 0, phiEffDeg: 36, psiEffDeg: 6,
          gamma: 20, gammaSat: 21, K0nc: 1 - Math.sin(36 * Math.PI / 180), sigmaTAllow: 0 } }
    ],
    analysisLeftX: 0, analysisRightX: 20, analysisBottomY: 0, analysisTopY: 10,
    walls: [], surfaceLoad: { xStart: 8, xEnd: 12, q: surfacePressure }, seepage: null
  };
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const wasmRobustNonlinearMode = process.env.WASM_ROBUST === '1';
  const surfacePressure = Number.isFinite(Number(process.env.PROBE_Q))
    ? Number(process.env.PROBE_Q)
    : 80;
  const maxLoadSteps = Number.isFinite(Number(process.env.PROBE_MAX_STEPS))
    ? Math.max(Math.round(Number(process.env.PROBE_MAX_STEPS)), 1)
    : 256;
  const input = {
    model: buildModel(surfacePressure),
    options: {
      analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 0.5,
      loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 10,
      useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
      residualRelTol: 1e-4, residualAbsTol: 1e-3, nonlinearMaxIterations: 32,
      initialLoadStep: 0.25, minLoadStep: 1 / 2048, maxLoadSteps,
      useUnsymmetricPlasticSolver: false, useWasmCpuPipeline: true, useNewGpuPipeline: false,
      wasmRobustNonlinearMode
    }
  };
  const r = await analyzeDeformationModel(input);
  console.log('surfacePressure:', surfacePressure);
  console.log('maxLoadSteps:', maxLoadSteps);
  console.log('wasmRobustNonlinearMode:', wasmRobustNonlinearMode);
  console.log('CONVERGED:', r?.solver?.converged);
  console.log('loadFactorCommitted:', r?.solver?.loadFactorCommitted);
  console.log('accepted/rejected steps:', r?.solver?.acceptedLoadSteps, '/', r?.solver?.rejectedLoadSteps);
  console.log('newton iters:', r?.solver?.nonlinearIterations);
  console.log('linear iters:', r?.solver?.linearIterations);
  console.log('finalActive:', r?.solver?.finalActiveMcElements);
  console.log('peakActive:', r?.solver?.peakActiveMcElements);
  console.log('residual:', r?.solver?.residualNorm);
  console.log('geostatic conv:', r?.solver?.initialPhaseConvergenceState);
  console.log('service conv:', r?.solver?.servicePhaseConvergenceState);
  __resetDeformationWasmModuleForTests();
}

main().catch((e) => { console.error(e); process.exit(1); });
