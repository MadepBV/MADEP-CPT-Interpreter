#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workstream C (partial-solution wall diagrams + load-fraction reporting).
//
// Regression for the "flat-zero wall" bug: on a NON-converged mc-plastic
// SERVICE solve the WASM driver used to roll `U_global` back to the geostatic
// beam-reference state, so every wall station read ux=uy=θ=0 and the wall
// M/V/deflection diagrams were identically zero even though the nodal field
// still held the partial state. C1 mirrors the SafetyCphi near-failure
// display-state handoff for the ServiceLoad phase, so the partial wall
// response is shown honestly at its achieved load fraction.
//
// Two fixtures, both run against the SHIPPED WASM:
//   1. SERVICE-partial: flat terrain (geostatic + wall install CONVERGE) with a
//      large one-sided surface load so the service phase stalls partway.
//      Asserts convergenceState 'partial', displayedLoadFactor strictly in
//      (0,1), and NON-ZERO wall w/M/V wherever the nodal field is non-zero.
//   2. GEOSTATIC-collapse (C2 guard): a c=1 cohesionless excavation step that
//      has no self-weight equilibrium, so the geostatic phase fails before the
//      wall is installed. Asserts the wall diagrams stay flat-zero (NO
//      fabricated partial-gravity field) — C2 keeps gravity on the committed
//      state.

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

function mcOptions(overrides = {}) {
  return {
    analysisType: 'deformation',
    meshElementType: 't3',
    meshTargetArea: 0.5,
    loadMode: 'pressure',
    constitutiveModel: 'mc-plastic',
    outOfPlaneLength: 10,
    useSeepagePorePressures: false,
    initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-5,
    residualAbsTol: 1e-6,
    displacementRelTol: 1e-6,
    displacementAbsTol: 1e-9,
    nonlinearMaxIterations: 30,
    initialLoadStep: 0.25,
    minLoadStep: 1e-4,
    maxLoadSteps: 60,
    useWasmCpuPipeline: true,
    useNewGpuPipeline: false,
    // Workstreams A/B stay at their shipped defaults (OFF) so the service phase
    // genuinely stalls and C's display handoff is exercised.
    ...overrides
  };
}

// Fixture 1 — geostatic converges (flat terrain), service stalls under a large
// one-sided surface load near a stiff embedded wall.
function servicePartialLayers() {
  return [{
    top: 0, bot: 8, type: 'Sand', subtype: 'service-partial sand',
    c: 2, phi: 30, psi: 0, g: 18, gs: 18,
    Emc: 25000, nu: 0.3, K0nc: 0.47, rShear: 0.25, kh: 1e-7, kv: 1e-7
  }];
}
function servicePartialUi() {
  const xw = 3.6;
  return {
    terrain: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    activeCptX: 5, analysisDepth: 8, strengthSet: 'characteristic', useCustomRegions: false, customRegions: [],
    walls: [{
      id: 'wall-1', x: xw, yTop: 0, yTip: -6.5, passiveSide: 'right', mechanicalActive: true,
      material: { label: 'Sheet pile', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 3.0e7, nu: 0.2, thickness: 0.6, kappa: 5 / 6, source: 'user' } },
      anchors: []
    }],
    // A heavy one-sided surface load: the first service load step (λ=0.25) is far
    // beyond what the perfectly-plastic soil can equilibrate, so NO service step
    // commits. Pre-C the driver rolls U_global back to the committed geostatic
    // state (loadFactor = 0), giving flat-zero wall diagrams; post-C it hands off
    // the best near-failure iterate at its achieved fraction.
    surfaceLoads: [{ id: 'load-1', xStart: 4.2, xEnd: 6.5, q: 2500, active: true }],
    deformation: { options: { outOfPlaneLength: 10, loadMode: 'pressure' } }, seepage: null
  };
}

// Fixture 2 — c=1 cohesionless excavation step: no self-weight equilibrium, the
// plastic geostatic phase collapses before the wall beam is installed.
function geoCollapseLayers() {
  return [{
    top: 0, bot: 14, type: 'Sand', subtype: 'cohesionless',
    c: 1, phi: 30, psi: 0, g: 18, gs: 20,
    Emc: 25000, nu: 0.3, K0nc: 0.5, rShear: 0.25, kh: 1e-7, kv: 1e-7
  }];
}
function geoCollapseUi() {
  const xw = 4;
  return {
    terrain: [{ x: 0, y: 0 }, { x: xw, y: 0 }, { x: xw, y: -3 }, { x: 12, y: -3 }],
    activeCptX: 7, analysisDepth: 12, strengthSet: 'characteristic', useCustomRegions: false, customRegions: [],
    walls: [{
      id: 'wall-1', x: xw, yTop: 0, yTip: -7, passiveSide: 'right', mechanicalActive: true,
      material: { label: 'Sheet pile', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 2.1e8, nu: 0.3, thickness: 0.4, kappa: 5 / 6, source: 'user' } },
      anchors: []
    }],
    surfaceLoads: [{ id: 'l1', xStart: 1, xEnd: 3, q: 50, active: true }],
    deformation: { options: { outOfPlaneLength: 10, loadMode: 'pressure' } }, seepage: null
  };
}

const maxAbs = (a) => Math.max(0, ...(a || []).map((v) => Math.abs(Number(v) || 0)));

let fails = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) fails += 1;
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());
  try {
    const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');

    // ---- Fixture 1: SERVICE-partial, the fix must SHOW the partial diagram ----
    const partial = await analyzeDeformationModel({
      model: buildBishopModelFromStageLayers(servicePartialLayers(), servicePartialUi()),
      options: mcOptions()
    });
    const ps = partial?.solver || {};
    const pwr = (partial?.wallResults || [])[0] || {};
    const wallMax = Math.max(maxAbs(pwr.w_passive), maxAbs(pwr.M_passive), maxAbs(pwr.V_passive));
    const stations = pwr.stations || [];
    let maxStationDisp = 0;
    for (const st of stations) {
      const m = Math.hypot(Number(st.ux) || 0, Number(st.uy) || 0);
      if (m > maxStationDisp) maxStationDisp = m;
    }
    let maxNodal = 0;
    for (const nd of partial?.nodalDisplacements || []) {
      const m = Math.hypot(Number(nd.ux) || 0, Number(nd.uy) || 0);
      if (m > maxNodal) maxNodal = m;
    }
    const dispLF = Number(ps.displayedLoadFactor) || 0;
    console.log(`\n-- SERVICE-partial --  geo=${ps.initialPhaseConvergenceState} service=${ps.servicePhaseConvergenceState} state=${ps.convergenceState} dispLF=${dispLF.toFixed(4)} wallMax=${wallMax.toExponential(3)} maxStationDisp=${maxStationDisp.toExponential(3)} maxNodal=${maxNodal.toExponential(3)}`);
    check('service-partial: geostatic phase converged (wall installed)', ps.initialPhaseConvergenceState === 'converged');
    check('service-partial: service phase did NOT converge', ps.servicePhaseConvergenceState === 'partial');
    check('service-partial: solver.convergenceState is partial', ps.convergenceState === 'partial');
    check('service-partial: displayedLoadFactor strictly in (0,1)', dispLF > 1e-9 && dispLF < 1 - 1e-6, `dispLF=${dispLF}`);
    check('service-partial: nodal displacement field is non-zero', maxNodal > 1e-9, `maxNodal=${maxNodal.toExponential(3)}`);
    check('service-partial: wall stations moved with the field', maxStationDisp > 1e-9, `maxStationDisp=${maxStationDisp.toExponential(3)}`);
    // THE FIX: wall response is non-zero wherever the nodal field is non-zero.
    check('service-partial: wall w/M/V diagrams are NON-ZERO (the C1 fix)', wallMax > 1e-9, `wallMax=${wallMax.toExponential(3)}`);
    check('service-partial: wPassive varies along the wall (not flat)', (maxAbs(pwr.w_passive) > 1e-12) && ((Math.max(...(pwr.w_passive || [0])) - Math.min(...(pwr.w_passive || [0]))) > 1e-12));

    // ---- Fixture 2: GEOSTATIC-collapse, C2 must NOT fabricate a wall diagram ----
    const collapse = await analyzeDeformationModel({
      model: buildBishopModelFromStageLayers(geoCollapseLayers(), geoCollapseUi()),
      options: mcOptions()
    });
    const cs = collapse?.solver || {};
    const cwr = (collapse?.wallResults || [])[0] || {};
    const collapseWallMax = Math.max(maxAbs(cwr.w_passive), maxAbs(cwr.M_passive), maxAbs(cwr.V_passive));
    console.log(`\n-- GEOSTATIC-collapse --  geo=${cs.initialPhaseConvergenceState} state=${cs.convergenceState} dispLF=${(Number(cs.displayedLoadFactor) || 0).toFixed(4)} wallMax=${collapseWallMax.toExponential(3)}`);
    check('geo-collapse: geostatic phase did NOT converge', cs.initialPhaseConvergenceState === 'partial');
    check('geo-collapse: NO fabricated wall diagram (C2 stays on committed state)', collapseWallMax < 1e-9, `wallMax=${collapseWallMax.toExponential(3)}`);

    console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
    process.exit(fails ? 1 : 0);
  } finally {
    __resetDeformationWasmModuleForTests();
  }
}

main().catch((err) => { console.error(err?.stack || err); process.exit(2); });
