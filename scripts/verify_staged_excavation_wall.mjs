#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Staged construction (model C — excavation by stress relaxation), Stage 1.
//
// THEORY (Potts & Zdravković, FEA in Geotechnical Engineering: Theory). A
// retaining-wall deformation model meshes the FINAL (post-cut) geometry. The
// legacy single-phase geostatic equilibrates that mesh under gravity WALL-FREE,
// i.e. it asks the vertical cut face — here almost entirely in the cohesionless
// top sand (c≈1, φ=30) — to stand on its own. A vertical cut in c≈1 sand has
// critical height < 1 m, so a multi-metre cut has NO static equilibrium: the
// phase stalls at a genuine limit.
//
// The committed K0 stress σ₀ at U=0 satisfies F_int(σ₀)=gravity+R_support, where
// R_support = (predictorInternal − gravity) is the consistent nodal reaction of
// the in-situ traction on the cut face. Staged construction HOLDS that supported
// in-situ state (wall wished-in-place at zero load), then RELAXES R_support to
// zero in a wall-ACTIVE Excavation phase, so the wall carries the cut — exactly
// the canonical Plaxis embedded-wall sequence.
//
// Gates:
//   #1  OFF (legacy) stalls on an unsupported cohesionless cut (initial phase
//       partial) — proves the problem is real and the staged path is opt-in.
//   #2  ON (staged) FULLY solves a cut the legacy path stalls on (here a 1.5 m
//       cut): geostatic+service converge to λ=1 with bounded SLS deformation.
//       This is the proof the staged machinery is correct.
//   #3  ON (staged) SUBSTANTIALLY improves the deep 3 m cohesionless cut over
//       the legacy stall (the wall now carries part of the cut). Full λ=1 on the
//       deepest cohesionless cuts additionally needs the Phase-2 zero-tension
//       soil-wall interface, which removes the residual glued-band barrier.
//   #4  Non-wall byte-identity: staging is inert without a wall (the wire byte
//       is gated on wall presence), so an MC non-wall fixture is identical
//       ON vs OFF.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { __setDeformationWasmModuleForTests } from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';
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

// The user's CPT_CPT1_demo_layers.csv, as Stage 6 ingests it.
function stageLayers() {
  return [
    { top: 0.00, bot: 2.98,  type: 'Sand',       subtype: 'zand, matig',      c: 1, phi: 30, psi: 0, g: 17, gs: 19, Emc: 23448, nu: 0.3, K0nc: 0.500, rShear: 0.33, kh: 4e-5, kv: 4e-5 },
    { top: 2.98, bot: 6.98,  type: 'Sandy clay', subtype: 'klei, matig vast', c: 4, phi: 20, psi: 0, g: 17, gs: 17, Emc: 5316,  nu: 0.4, K0nc: 0.658, rShear: 0.15, kh: 5e-7, kv: 1.7e-7, cu: 50 },
    { top: 6.98, bot: 21.72, type: 'Silty sand', subtype: 'leem, vast',       c: 8, phi: 22, psi: 0, g: 20, gs: 20, Emc: 11374, nu: 0.3, K0nc: 0.625, rShear: 0.25, kh: 3e-6, kv: 1e-6, cu: 100 }
  ];
}

// Vertical RC wall retaining a `cut` m step, tip at `tip` m.
function steppedUiState(cut, tip, q = 0.2) {
  const xw = 8.5;
  return {
    terrain: [{ x: 0, y: 0 }, { x: xw, y: 0 }, { x: xw, y: -cut }, { x: 20, y: -cut }],
    activeCptX: 4, analysisDepth: 20, strengthSet: 'characteristic',
    useCustomRegions: false, customRegions: [],
    walls: [{ id: 'wall-1', x: xw, yTop: 0, yTip: tip, passiveSide: 'right', mechanicalActive: true,
      material: { label: 'RC wall', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 3e7, nu: 0.2, thickness: 0.5, kappa: 5 / 6, source: 'user' } }, anchors: [] }],
    surfaceLoads: [{ id: 'load-1', xStart: 3, xEnd: xw, q, active: true }],
    deformation: { options: { outOfPlaneLength: 1, loadMode: 'pressure' } }, seepage: null
  };
}

function baseOptions(extra) {
  return {
    analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 1.2,
    loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 1,
    useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-4, residualAbsTol: 1e-3, displacementRelTol: 1e-4, displacementAbsTol: 1e-6,
    nonlinearMaxIterations: 32, initialLoadStep: 0.25, minLoadStep: 1 / 4096, maxLoadSteps: 384,
    useWasmCpuPipeline: true, useNewGpuPipeline: false,
    ...extra
  };
}

function maxAbsU(result) {
  const nd = result?.nodalDisplacements || result?.solver?.nodalDisplacements || null;
  let m = 0;
  if (Array.isArray(nd)) for (const d of nd) m = Math.max(m, Math.abs(d?.ux ?? d?.[0] ?? 0), Math.abs(d?.uy ?? d?.[1] ?? 0));
  return m;
}
function wallStationCount(result) {
  const W = result?.wallResults || result?.solver?.wallResults || [];
  return W.reduce((n, w) => n + (w?.stations?.length || 0), 0);
}

async function runWall(cut, tip, extra, q = 0.2) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const model = buildBishopModelFromStageLayers(stageLayers(), steppedUiState(cut, tip, q));
  const result = await analyzeDeformationModel({ model, options: baseOptions(extra) });
  return { result, s: result?.solver || {} };
}

function wallMaxMoment(result) {
  const W = result?.wallResults || result?.solver?.wallResults || [];
  let m = 0;
  for (const w of W) for (const v of (w?.M_passive || [])) m = Math.max(m, Math.abs(Number(v) || 0));
  return m;
}

let fails = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) fails++;
}
const lam = (s) => Number(s.loadFactorCommitted ?? s.displayedLoadFactor) || 0;
const fmt = (s) => `geo=${s.initialPhaseConvergenceState} svc=${s.servicePhaseConvergenceState} conv=${s.converged} λ=${lam(s).toFixed(4)}`;

// Non-wall MC fixture (flat ground + surcharge). Staging must be inert here.
function nonWallModel(q) {
  const k0 = (deg) => 1 - Math.sin(deg * Math.PI / 180);
  return {
    terrain: { vertices: [{ x: 0, y: 10 }, { x: 20, y: 10 }] },
    phreatic: { vertices: [{ x: 0, y: 8.5 }, { x: 20, y: 8.5 }] },
    regions: [
      { id: 'sand-1', label: 'Sand 1', polygon: [{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 6 }, { x: 0, y: 6 }],
        material: { id: 's1', label: 'S1', Emc: 30000, nu: 0.3, cEff: 5, phiEffDeg: 30, psiEffDeg: 0, gamma: 18, gammaSat: 20, K0nc: k0(30), sigmaTAllow: 0 } },
      { id: 'clay-1', label: 'Clay 1', polygon: [{ x: 0, y: 6 }, { x: 20, y: 6 }, { x: 20, y: 0 }, { x: 0, y: 0 }],
        material: { id: 'c1', label: 'C1', Emc: 9000, nu: 0.35, cEff: 12, phiEffDeg: 24, psiEffDeg: 0, gamma: 19, gammaSat: 20, K0nc: k0(24), sigmaTAllow: 0 } }
    ],
    analysisLeftX: 0, analysisRightX: 20, analysisBottomY: 0, analysisTopY: 10,
    walls: [], surfaceLoad: { xStart: 8, xEnd: 12, q }, seepage: null
  };
}
async function runNonWall(extra) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const result = await analyzeDeformationModel({ model: nonWallModel(40), options: baseOptions({ meshTargetArea: 0.8, ...extra }) });
  return result?.solver || {};
}
function nodalSignature(s) {
  let sig = 0;
  for (const d of (s?.nodalDisplacements || [])) sig += Math.abs(d?.ux ?? d?.[0] ?? 0) + Math.abs(d?.uy ?? d?.[1] ?? 0);
  return sig;
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());

  // ---- Gate #2: staged FULLY solves a cut the legacy path stalls on. --------
  // Task #56 re-baseline: with the initial-stiffness scheme (PLAXIS-style
  // constant elastic K_e + Anderson acceleration + compound acceptance) the
  // staged phases now CONVERGE to λ=1, both glued and with the interface.
  // The Stage-B experiment proved the old stalls were machinery artifacts
  // (the fixed-point operator marched the stalled states to λ=1 at the full
  // research tolerance), so λ=1 is asserted here — no KNOWN-OPEN remains for
  // this fixture.
  console.log('== Moderate cut (1.5 m): legacy stalls, staged converges ==');
  const m15off = await runWall(1.5, -8, { useStagedExcavation: false });
  const m15on  = await runWall(1.5, -8, { useStagedExcavation: true });
  console.log(`  OFF: ${fmt(m15off.s)}  maxU=${(maxAbsU(m15off.result) * 1000).toFixed(2)}mm`);
  console.log(`  ON : ${fmt(m15on.s)}  maxU=${(maxAbsU(m15on.result) * 1000).toFixed(2)}mm`);
  check('#1 legacy (1.5 m cut) stalls wall-free (initial phase partial)',
    m15off.s.initialPhaseConvergenceState !== 'converged' && lam(m15off.s) < 0.95,
    `geo=${m15off.s.initialPhaseConvergenceState} λ=${lam(m15off.s).toFixed(4)}`);
  const m15u = maxAbsU(m15on.result);
  check('#2 staged (1.5 m cut): excavation converges (wall carries the cut)',
    m15on.s.initialPhaseConvergenceState === 'converged', fmt(m15on.s));
  check('#2 staged (1.5 m cut): service converges to λ=1 (task #56 C-1)',
    m15on.s.servicePhaseConvergenceState === 'converged' && lam(m15on.s) >= 1 - 1e-6,
    fmt(m15on.s));
  check('#2 staged converged with bounded SLS deformation (0 < maxU < 50 mm)', m15u > 0 && m15u < 0.05,
    `maxU=${(m15u * 1000).toFixed(2)}mm`);
  check('#2 staged result carries the wall (stations present)', wallStationCount(m15on.result) > 0,
    `stations=${wallStationCount(m15on.result)}`);
  const m15i = await runWall(1.5, -8, { useStagedExcavation: true, useWallInterface: true });
  console.log(`  ON+IF: ${fmt(m15i.s)}  maxU=${(maxAbsU(m15i.result) * 1000).toFixed(2)}mm`);
  check('#2b staged+interface (1.5 m cut): geo AND service converge to λ=1 (task #56 C-1)',
    m15i.s.initialPhaseConvergenceState === 'converged' &&
    m15i.s.servicePhaseConvergenceState === 'converged' && lam(m15i.s) >= 1 - 1e-6,
    fmt(m15i.s));
  const m15iConv = m15i.s.convergence || null;
  const m15iPhases = m15iConv?.phases || [];
  check('#2b staged+interface used the initial-stiffness scheme with honest final-state labels',
    m15iPhases.length >= 2 &&
    m15iPhases.every((p) => p.usedInitialStiffness === true) &&
    m15iPhases.every((p) => p.finalStateResearchConverged === true || p.finalStatePlaxisConverged === true),
    JSON.stringify(m15iPhases.map((p) => ({ phase: p.phase, research: p.finalStateResearchConverged, plaxis: p.finalStatePlaxisConverged }))));

  // ---- Gate #5 (C2 regression): service must not bleed the wall's
  // excavation-phase forces. The incremental service residual differences the
  // beam from the SAME end-of-excavation baseline as the soil, so as q → 0
  // the committed state — and the wall moment diagram — must be continuous
  // in q (single-baseline equilibrium). Pre-fix, the beam force was absolute
  // while the soil was incremental and max|M| collapsed ~8× the moment any
  // service load was applied. Both runs now converge to λ=1 (task #56 C-1),
  // so the comparison is at the full-load state.
  console.log('\n== Service continuity as q → 0 (wall must keep excavation forces) ==');
  const cTiny = await runWall(1.5, -8, { useStagedExcavation: true, useWallInterface: true }, 1e-6);
  const cRef  = m15i;
  const mTiny = wallMaxMoment(cTiny.result);
  const mRef  = wallMaxMoment(cRef.result);
  console.log(`  q=1e-6: ${fmt(cTiny.s)}  max|M|=${mTiny.toFixed(3)} kNm/m   q=0.2: max|M|=${mRef.toFixed(3)} kNm/m`);
  check('#5 q=1e-6 and q=0.2 reach matching committed fractions',
    Math.abs(lam(cTiny.s) - lam(cRef.s)) <= 0.02,
    `λ(1e-6)=${lam(cTiny.s).toFixed(4)} λ(0.2)=${lam(cRef.s).toFixed(4)}`);
  check('#5 wall max|M| continuous as q → 0 (within 5% of q=0.2)',
    mRef > 0 && Math.abs(mTiny - mRef) <= 0.05 * mRef,
    `q→0: ${mTiny.toFixed(3)} vs q=0.2: ${mRef.toFixed(3)} kNm/m`);
  check('#5 wall carries a non-trivial moment (rigid-wall pinning regression)', mTiny > 0.5,
    `max|M|=${mTiny.toFixed(3)} kNm/m`);

  // ---- Gate #3: staged fully solves the deep cohesionless cut. --------------
  // Task #56 re-baseline: the staged (glued-wall) 3 m cut historically capped
  // at λ≈0.557; under the initial-stiffness scheme it converges to λ=1 with
  // PLAXIS+research-converged final states. The legacy wall-free stall stays
  // asserted — it is the genuine unsupported-cut limit (the adversarial
  // control of the task #56 experiment, CSP < 0.015 at its floor).
  console.log('\n== Deep cut (3 m cohesionless): staged converges, legacy stalls ==');
  const m3off = await runWall(3, -8, { useStagedExcavation: false });
  const m3on  = await runWall(3, -8, { useStagedExcavation: true });
  console.log(`  OFF: ${fmt(m3off.s)}  maxU=${(maxAbsU(m3off.result) * 1000).toFixed(2)}mm`);
  console.log(`  ON : ${fmt(m3on.s)}  maxU=${(maxAbsU(m3on.result) * 1000).toFixed(2)}mm`);
  check('#1 legacy (3 m cut) stalls at the unsupported-cut limit (0.2 < λ < 0.6)',
    m3off.s.initialPhaseConvergenceState !== 'converged' && lam(m3off.s) > 0.2 && lam(m3off.s) < 0.6,
    `λ=${lam(m3off.s).toFixed(4)}`);
  check('#3 staged (3 m cut, glued wall): geo AND service converge to λ=1 (task #56 C-1)',
    m3on.s.initialPhaseConvergenceState === 'converged' &&
    m3on.s.servicePhaseConvergenceState === 'converged' && lam(m3on.s) >= 1 - 1e-6,
    fmt(m3on.s));

  // ---- Gate #4: staging inert without a wall (byte-identity). ---------------
  console.log('\n== Non-wall byte-identity (staging must be inert) ==');
  const nwOff = await runNonWall({ useStagedExcavation: false });
  const nwOn  = await runNonWall({ useStagedExcavation: true });
  const sigOff = nodalSignature(nwOff), sigOn = nodalSignature(nwOn);
  console.log(`  OFF sig=${sigOff.toExponential(6)}  ON sig=${sigOn.toExponential(6)}`);
  check('#4 non-wall ON==OFF (staging inert without a wall)',
    Math.abs(sigOff - sigOn) <= 1e-9 * Math.max(1, Math.abs(sigOff)) &&
    nwOff.initialPhaseConvergenceState === nwOn.initialPhaseConvergenceState &&
    Number(nwOff.loadFactorCommitted) === Number(nwOn.loadFactorCommitted),
    `Δsig=${Math.abs(sigOff - sigOn).toExponential(2)}`);

  console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('THREW:', e?.stack || e?.message || e); process.exit(2); });
