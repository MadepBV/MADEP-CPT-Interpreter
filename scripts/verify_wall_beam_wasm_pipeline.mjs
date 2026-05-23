#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end regression for active retaining-wall beam plumbing:
// Bishop model -> mechanical PSLG wall constraint -> WASM hybrid DOFs ->
// beam assembly -> wall result payload.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  __resetDeformationWasmModuleForTests,
  __setDeformationWasmModuleForTests
} from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

async function loadWasmModule() {
  const glue = await import(pathToFileURL(resolve('static/wasm/deformation/deformation.js')).href);
  const factory = glue.default || glue.createDeformationModule;
  const wasmBinary = readFileSync(resolve('static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function soilMaterial() {
  return {
    id: 'sand',
    label: 'Linear sand',
    Emc: 25000,
    nu: 0.3,
    cEff: 0,
    phiEffDeg: 32,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 18,
    K0nc: 0.47,
    rShear: 0.25,
    sigmaTAllow: 0,
    useTensionCutoff: true
  };
}

function model(withWall = true) {
  return {
    terrain: { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    phreatic: null,
    regions: [{
      id: 'domain',
      label: 'Domain',
      polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: -8 }, { x: 0, y: -8 }],
      material: soilMaterial()
    }],
    analysisLeftX: 0,
    analysisRightX: 10,
    analysisBottomY: -8,
    analysisTopY: 0,
    walls: withWall ? [{
      id: 'wall-1',
      x: 3.6,
      yTop: 0,
      yTip: -6.5,
      passiveSide: 'right',
      mechanicalActive: true,
      material: {
        label: 'Test diaphragm',
        kAcross: 1e-12,
        kAlong: 1e-12,
        kSource: 'preset',
        mechanical: {
          model: 'rectangular',
          E: 3.0e7,
          nu: 0.2,
          thickness: 0.6,
          kappa: 5 / 6,
          source: 'user'
        }
      },
      anchors: []
    }] : [],
    surfaceLoad: { xStart: 4.2, xEnd: 5.4, q: 20 },
    seepage: null
  };
}

function options() {
  return {
    analysisType: 'deformation',
    meshElementType: 't3',
    meshTargetArea: 0.65,
    loadMode: 'pressure',
    constitutiveModel: 'linear-elastic',
    outOfPlaneLength: 10,
    useSeepagePorePressures: false,
    initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-5,
    residualAbsTol: 1e-6,
    displacementRelTol: 1e-6,
    displacementAbsTol: 1e-9,
    nonlinearMaxIterations: 16,
    initialLoadStep: 1,
    minLoadStep: 1e-4,
    maxLoadSteps: 32,
    useWasmCpuPipeline: true,
    useNewGpuPipeline: false
  };
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());
  try {
    const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
    const result = await analyzeDeformationModel({ model: model(true), options: options() });
    assert.equal(result?.solver?.converged, true, 'wall-beam app case must converge');
    assert.equal(result?.mesh?.mechanicalWalls?.length, 1, 'mechanical wall must be present in mesh');
    assert.ok(result.mesh.mechanicalWalls[0].nodes.length >= 4, 'wall must be recovered as a multi-station node chain');
    assert.equal(result?.wallResults?.length, 1, 'WASM output must expose one wall-result set');
    const wallResult = result.wallResults[0];
    const stations = wallResult.stations;
    assert.equal(stations.length, result.mesh.mechanicalWalls[0].nodes.length, 'wall output station count must match mesh station count');
    assert.equal(wallResult.s_node.length, stations.length, 'wall node station array must match station count');
    assert.equal(wallResult.w_passive.length, stations.length, 'wall node deflection array must match station count');
    assert.equal(wallResult.theta_passive.length, stations.length, 'wall node rotation array must match station count');
    assert.equal(wallResult.s_midpoint.length, stations.length - 1, 'wall midpoint station array must match beam element count');
    assert.equal(wallResult.N.length, stations.length - 1, 'wall axial-force array must match beam element count');
    assert.equal(wallResult.V_passive.length, stations.length - 1, 'wall shear-force array must match beam element count');
    assert.equal(wallResult.M_passive.length, stations.length - 1, 'wall moment array must match beam element count');
    const maxForce = Math.max(...stations.map((s) =>
      Math.max(Math.abs(Number(s.N) || 0), Math.abs(Number(s.VPassive) || 0), Math.abs(Number(s.MPassive) || 0))
    ));
    const interiorStations = stations.slice(1, -1);
    const maxInteriorForce = Math.max(...interiorStations.map((s) =>
      Math.max(Math.abs(Number(s.N) || 0), Math.abs(Number(s.VPassive) || 0), Math.abs(Number(s.MPassive) || 0))
    ));
    assert.ok(Number.isFinite(maxForce) && maxForce > 1e-9, 'wall internal forces must be finite and non-zero');
    assert.ok(
      Number.isFinite(maxInteriorForce) && maxInteriorForce > 1e-9,
      'wall interior section forces must not cancel from inconsistent end-force signs'
    );
    console.log(JSON.stringify({
      converged: result.solver.converged,
      stations: stations.length,
      maxForce,
      maxInteriorForce,
      ndofTotal: result.mesh.ndofTotal,
      wallRotationDofs: Object.keys(result.mesh.wallRotationDofByNode || {}).length
    }, null, 2));
    console.log('PASS: wall beam WASM pipeline fixture converged and exposed wall forces.');
  } finally {
    __resetDeformationWasmModuleForTests();
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
