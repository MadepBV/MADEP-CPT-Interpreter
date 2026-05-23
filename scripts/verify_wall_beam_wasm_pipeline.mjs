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
import { buildBishopModelFromStageLayers } from '../src/lib/cpt-app/stage6-bishop.js';

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

function stageLayers() {
  return [{
    top: 0,
    bot: 8,
    type: 'Sand',
    subtype: 'linear test sand',
    c: 0,
    phi: 32,
    psi: 0,
    g: 18,
    gs: 18,
    Emc: 25000,
    nu: 0.3,
    K0nc: 0.47,
    rShear: 0.25,
    kh: 1e-7,
    kv: 1e-7
  }];
}

function bishopUiState(withWall = true, diagonal = false, q = 20) {
  const wall = diagonal
    ? {
        id: 'wall-1',
        head: { x: 3.2, y: 0 },
        tip: { x: 4.4, y: -6.5 },
        x: 3.2,
        yTop: 0,
        yTip: -6.5
      }
    : {
        id: 'wall-1',
        x: 3.6,
        yTop: 0,
        yTip: -6.5
      };
  return {
    terrain: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    activeCptX: 5,
    analysisDepth: 8,
    strengthSet: 'characteristic',
    useCustomRegions: false,
    customRegions: [],
    walls: withWall ? [{
      ...wall,
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
    surfaceLoads: [{ id: 'load-1', xStart: 4.2, xEnd: 5.4, q, active: true }],
    deformation: { options: { outOfPlaneLength: 10, loadMode: 'pressure' } },
    seepage: null
  };
}

function wallFrame(stations) {
  const first = stations[0];
  const last = stations[stations.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy);
  assert.ok(length > 1e-9, 'wall result stations should have finite length');
  const t = { x: dx / length, y: dy / length };
  return {
    length,
    nRight: { x: -t.y, y: t.x }
  };
}

function options(overrides = {}) {
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
    useNewGpuPipeline: false,
    ...overrides
  };
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());
  try {
    const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
    const appModel = buildBishopModelFromStageLayers(stageLayers(), bishopUiState(true));
    assert.equal(
      appModel?.walls?.[0]?.mechanicalActive,
      true,
      'Stage 6 Bishop model builder must preserve mechanicalActive from the drawn wall'
    );
    assert.ok(
      appModel?.walls?.[0]?.material?.mechanical,
      'Stage 6 Bishop model builder must preserve wall mechanical section data'
    );
    const result = await analyzeDeformationModel({ model: appModel, options: options() });
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

    const diagonalModel = buildBishopModelFromStageLayers(stageLayers(), bishopUiState(true, true));
    const diagonalResult = await analyzeDeformationModel({ model: diagonalModel, options: options() });
    assert.equal(diagonalResult?.solver?.converged, true, 'inclined wall-beam app case must converge');
    assert.equal(diagonalResult?.mesh?.mechanicalWalls?.length, 1, 'inclined mechanical wall must be present in mesh');
    const diagonalStations = diagonalResult.wallResults?.[0]?.stations || [];
    assert.ok(diagonalStations.length >= 4, 'inclined wall should recover a multi-station node chain');
    const xSpan = Math.max(...diagonalStations.map((s) => s.x)) - Math.min(...diagonalStations.map((s) => s.x));
    assert.ok(xSpan > 0.5, `inclined wall station x span should be non-zero (got ${xSpan})`);
    const frame = wallFrame(diagonalStations);
    const lastS = diagonalStations[diagonalStations.length - 1].s;
    assert.ok(Math.abs(lastS - frame.length) <= 1e-4, 'inclined wall station coordinate should follow wall length');
    diagonalStations.forEach((station) => {
      const expectedW = (Number(station.ux) || 0) * frame.nRight.x + (Number(station.uy) || 0) * frame.nRight.y;
      assert.ok(
        Math.abs((Number(station.wPassive) || 0) - expectedW) <= 1e-12,
        'inclined wall passive deflection should be projected along the local passive normal'
      );
    });

    const tinyLoadOptions = options({
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      initialLoadStep: 0.25,
      minLoadStep: 1e-4,
      maxLoadSteps: 80,
      nonlinearMaxIterations: 30
    });
    const tinyLoadWithoutWall = await analyzeDeformationModel({
      model: buildBishopModelFromStageLayers(stageLayers(), bishopUiState(false, false, 1e-9)),
      options: tinyLoadOptions
    });
    assert.equal(
      tinyLoadWithoutWall?.solver?.converged,
      true,
      'MC plastic-geostatic tiny-load baseline without wall must converge'
    );
    const tinyLoadWithWall = await analyzeDeformationModel({
      model: buildBishopModelFromStageLayers(stageLayers(), bishopUiState(true, false, 1e-9)),
      options: tinyLoadOptions
    });
    assert.equal(
      tinyLoadWithWall?.solver?.converged,
      true,
      'MC plastic-geostatic tiny-load wall case must converge after wall installation handoff'
    );
    const tinyWallStations = tinyLoadWithWall.wallResults?.[0]?.stations || [];
    const tinyMaxForce = Math.max(0, ...tinyWallStations.map((s) =>
      Math.max(Math.abs(Number(s.N) || 0), Math.abs(Number(s.VPassive) || 0), Math.abs(Number(s.MPassive) || 0))
    ));
    const tinyMaxDeflection = Math.max(0, ...tinyWallStations.map((s) => Math.abs(Number(s.wPassive) || 0)));
    assert.ok(
      tinyMaxForce < 1e-5,
      `wall must not carry locked-in K0 force for a tiny service load (max ${tinyMaxForce})`
    );
    assert.ok(
      tinyMaxDeflection < 1e-8,
      `wall service deflection must be near zero for a tiny service load (max ${tinyMaxDeflection})`
    );

    const serviceLoadWithWall = await analyzeDeformationModel({
      model: buildBishopModelFromStageLayers(stageLayers(), bishopUiState(true, false, 1)),
      options: tinyLoadOptions
    });
    assert.equal(
      serviceLoadWithWall?.solver?.converged,
      true,
      'MC plastic-geostatic wall case must converge for a small real service load'
    );
    assert.equal(
      serviceLoadWithWall?.solver?.lastLinearSolverKind,
      0,
      'default MC wall solve must remain on the production symmetric CG path'
    );
    assert.equal(
      serviceLoadWithWall?.solver?.linearAlgebraBackend?.krylovPath,
      'cg-bj',
      'default MC wall solve telemetry must not report the experimental GMRES path'
    );
    const serviceWallStations = serviceLoadWithWall.wallResults?.[0]?.stations || [];
    const serviceMaxForce = Math.max(0, ...serviceWallStations.map((s) =>
      Math.max(Math.abs(Number(s.N) || 0), Math.abs(Number(s.VPassive) || 0), Math.abs(Number(s.MPassive) || 0))
    ));
    assert.ok(
      Number.isFinite(serviceMaxForce) && serviceMaxForce > 1e-5,
      'wall must develop service-load force after the geostatic handoff'
    );

    console.log('PASS: wall beam WASM pipeline fixtures converged for vertical and inclined walls.');
  } finally {
    __resetDeformationWasmModuleForTests();
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
