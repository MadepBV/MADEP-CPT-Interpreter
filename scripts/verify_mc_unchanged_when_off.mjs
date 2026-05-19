#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH default-OFF gate. The phase-1 oracle explicitly checks that toggling
// `useConsistentTangent` does not change the local stress return, and that the
// OFF path returns the elastic modified-Newton tangent. The existing WASM MC
// unit fixture is run afterward as a narrow live-pipeline smoke check for the
// default-OFF wire path.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeInputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

function sharedSlotForRegion(region) {
  const mesh = {
    elementType: 't3',
    nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    elements: [[0, 1, 2]],
    cells: [{ regionIndex: 0, centroid: { x: 1 / 3, y: 1 / 3 } }],
    elementCell: [0],
    constraintEdges: []
  };
  const bytes = encodeInputBuffer({
    mesh,
    options: {
      constitutiveModel: 'mc-plastic',
      analysisType: 'deformation',
      useK0Init: false
    },
    regions: [region],
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: new Float64Array(2 * mesh.nodes.length),
    predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: new Float64Array(6),
    porePressureByGp: new Float64Array(1),
    fixedDofs: [],
    numGpTotal: 1
  });
  const headerBytes = 40 + 12 + 28 + 28 * 8;
  const nodesBytes = mesh.nodes.length * 2 * 8;
  const elementsBytes = mesh.elements.length * (4 + 4 + 6 * 4);
  const regionOffset = headerBytes + nodesBytes + elementsBytes;
  const sharedSlotOffset = regionOffset + 10 * 8 + 4 + 12 * 8;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getFloat64(sharedSlotOffset, true);
}

assert.equal(
  sharedSlotForRegion({
    Emc: 20000,
    nu: 0.3,
    cEff: 8,
    phiEffDeg: 25,
    psiEffDeg: 5,
    hs: { useConsistentTangent: true }
  }),
  0,
  'MC wire slot must not inherit HS useConsistentTangent'
);
assert.equal(
  sharedSlotForRegion({
    Emc: 20000,
    nu: 0.3,
    cEff: 8,
    phiEffDeg: 25,
    psiEffDeg: 5,
    mc: { useConsistentTangent: true }
  }),
  1,
  'MC wire slot must honor explicit MC useConsistentTangent'
);

for (const script of [
  'scripts/verify_mc_simo_hughes_phase_1.mjs',
  'scripts/verify_wasm_mc_unit.mjs'
]) {
  const run = spawnSync(process.execPath, [resolve(repoRoot, script)], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  assert.equal(run.status, 0, `${script} failed`);
}

console.log('MC unchanged-when-off verifier PASSED.');
