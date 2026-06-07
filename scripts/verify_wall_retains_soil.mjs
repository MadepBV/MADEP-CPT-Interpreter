#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reproduces the user scenario: a PERFECTLY VERTICAL wall retaining soil over a height
// (stepped ground line) where the excavated-side terrain vertex is slightly off the wall
// (the "little jump"). Before the terrain->wall snap + marker-priority fix this produced a
// tall narrow sliver triangle beside the wall and the solve did not converge.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
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
    top: 0, bot: 14, type: 'Sand', subtype: 'retained sand',
    c: 2, phi: 30, psi: 0, g: 18, gs: 20,
    Emc: 25000, nu: 0.3, K0nc: 0.5, rShear: 0.25, kh: 1e-7, kv: 1e-7
  }];
}

// Vertical wall at x=4; retained ground at y=0 (left), excavated at y=-2 (right). The
// excavated terrain vertex is placed at x=4.3 — the "little jump" off the wall line.
function steppedUiState(jump) {
  const xw = 4;
  return {
    terrain: [{ x: 0, y: 0 }, { x: xw, y: 0 }, { x: xw + jump, y: -2 }, { x: 10, y: -2 }],
    activeCptX: 6,
    analysisDepth: 12,
    strengthSet: 'characteristic',
    useCustomRegions: false,
    customRegions: [],
    walls: [{
      id: 'wall-1', x: xw, yTop: 0, yTip: -6.5,
      passiveSide: 'right', mechanicalActive: true,
      material: {
        label: 'Sheet pile', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 2.1e8, nu: 0.3, thickness: 0.4, kappa: 5 / 6, source: 'user' }
      },
      anchors: []
    }],
    surfaceLoads: [{ id: 'load-1', xStart: 1, xEnd: 3, q: 20, active: true }],
    deformation: { options: { outOfPlaneLength: 10, loadMode: 'pressure' } },
    seepage: null
  };
}

function options() {
  return {
    analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 0.5,
    loadMode: 'pressure', constitutiveModel: 'linear-elastic', outOfPlaneLength: 10,
    useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-5, residualAbsTol: 1e-6, displacementRelTol: 1e-6, displacementAbsTol: 1e-9,
    nonlinearMaxIterations: 16, initialLoadStep: 1, minLoadStep: 1e-4, maxLoadSteps: 32,
    useWasmCpuPipeline: true, useNewGpuPipeline: false
  };
}

function minTriangleAngleDeg(mesh) {
  let minAng = 180;
  const nd = mesh.nodes;
  for (const el of mesh.elements || []) {
    const ids = el.nodeIds || el.nodes || el;
    const p = [nd[ids[0]], nd[ids[1]], nd[ids[2]]];
    if (p.some((q) => !q)) continue;
    for (let i = 0; i < 3; i++) {
      const a = p[i], b = p[(i + 1) % 3], c = p[(i + 2) % 3];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - a.x, v2y = c.y - a.y;
      const dot = v1x * v2x + v1y * v2y;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y))))) * 180 / Math.PI;
      if (ang < minAng) minAng = ang;
    }
  }
  return minAng;
}

let fails = 0;
function check(name, cond, detail = '') { console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }

async function run(jump, label) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const model = buildBishopModelFromStageLayers(stageLayers(), steppedUiState(jump));
  const result = await analyzeDeformationModel({ model, options: options() });
  const minAng = result?.mesh ? minTriangleAngleDeg(result.mesh) : 0;
  const nWall = result?.mesh?.mechanicalWalls?.length || 0;
  const nWallNodes = result?.mesh?.mechanicalWalls?.[0]?.nodes?.length || 0;
  console.log(`\n-- ${label} (jump=${jump} m) --  converged=${result?.solver?.converged} walls=${nWall} wallNodes=${nWallNodes} minAngle=${minAng.toFixed(2)}°`);
  check(`${label}: wall recovered as a node chain`, nWall === 1 && nWallNodes >= 3, `nodes=${nWallNodes}`);
  check(`${label}: no sliver triangles (min angle > 12°)`, minAng > 12, `minAngle=${minAng.toFixed(2)}°`);
  check(`${label}: deformation solve converged`, result?.solver?.converged === true);
  // Wall deflection must VARY along the wall (a quadratic-M field cannot give a constant w) and be
  // Timoshenko-consistent with the rotation (dw/ds ≈ θ). Locks the user-reported "flat w" symptom,
  // which was a downstream artefact of a degenerate sliver mesh, not a beam-kernel defect.
  const wr = (result?.wallResults || result?.retainingWallResults || [])[0];
  if (wr && (wr.w_passive || []).length >= 4) {
    const w = wr.w_passive, th = wr.theta_passive || [], s = wr.s_node || [];
    const wspan = Math.max(...w) - Math.min(...w);
    const rel = wspan / Math.max(1e-30, ...w.map((v) => Math.abs(v)));
    check(`${label}: wall deflection w varies (not constant)`, rel > 0.1, `span/max|w|=${rel.toFixed(2)}`);
    let sumErr = 0, n = 0, maxTh = Math.max(1e-30, ...th.map((v) => Math.abs(v)));
    for (let i = 0; i < s.length - 1; i += 1) {
      const ds = s[i + 1] - s[i];
      if (Math.abs(ds) < 1e-6) continue;            // skip a coincident pair
      sumErr += Math.abs((w[i + 1] - w[i]) / ds - 0.5 * (th[i] + th[i + 1])); n += 1;
    }
    check(`${label}: dw/ds ≈ θ (Timoshenko-consistent)`, n > 0 && (sumErr / n) / maxTh < 0.4, `meanErr/maxθ=${((sumErr / Math.max(1, n)) / maxTh).toFixed(2)}`);
  }
  return result;
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());
  await run(0.3, 'vertical wall, stepped terrain with jump');
  await run(0.0, 'vertical wall, stepped terrain aligned');
  console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('THREW:', e?.message || e); process.exit(2); });
