#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {
  arcLengthDerivativeModeCode,
  arcLengthMeritModeCode,
  encodeInputBuffer,
  requestedContinuationModeCode
} from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

assert.equal(requestedContinuationModeCode('load-control'), 0);
assert.equal(requestedContinuationModeCode('strength-control'), 1);
assert.equal(requestedContinuationModeCode('arc-length'), 2);
assert.equal(requestedContinuationModeCode('auto'), 3);
assert.equal(requestedContinuationModeCode(undefined), 3);

assert.equal(arcLengthDerivativeModeCode('finite-difference'), 0);
assert.equal(arcLengthDerivativeModeCode('analytic'), 1);
assert.equal(arcLengthDerivativeModeCode('analytic-verified'), 2);
assert.equal(arcLengthDerivativeModeCode(undefined), 0);

assert.equal(arcLengthMeritModeCode('one-norm-scaled'), 0);
assert.equal(arcLengthMeritModeCode('quadratic'), 1);
assert.equal(arcLengthMeritModeCode(undefined), 0);

const buffer = encodeInputBuffer({
  mesh: {
    elementType: 't3',
    nodes: [{ x: 0, y: 0 }],
    elements: [],
    cells: [],
    elementCell: []
  },
  options: {
    constitutiveModel: 'linear-elastic',
    analysisType: 'deformation',
    requestedContinuationMode: 'arc-length',
    arcLengthDerivativeMode: 'analytic-verified',
    arcLengthMeritMode: 'quadratic',
    arcLengthLineSearchMaxBacktracks: 4,
    arcLengthDisplacementScale: 0,
    arcLengthInitialRadiusScale: 2,
    arcLengthMinRadiusScale: 3,
    arcLengthMaxRadiusScale: 4,
    arcLengthConstraintToleranceScale: 5
  },
  regions: [{ Emc: 1000, nu: 0.3 }],
  gravityRhsFull: new Float64Array(2),
  loadRhsFull: new Float64Array(2),
  predictorSolutionFull: new Float64Array(2),
  initialSigmaByGp: new Float64Array(0),
  porePressureByGp: new Float64Array(0),
  fixedDofs: [],
  numGpTotal: 0
});

const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
assert.equal(view.getUint8(46), 2);
assert.equal(view.getUint8(47), 2);
assert.equal(view.getUint8(48), 1);
assert.equal(view.getUint8(49), 0);
assert.equal(view.getUint8(50), 0);
assert.equal(view.getUint8(51), 0);
assert.equal(view.getUint32(76, true), 4);
assert.equal(view.getFloat64(264, true), 0);
assert.equal(view.getFloat64(272, true), 2);
assert.equal(view.getFloat64(280, true), 3);
assert.equal(view.getFloat64(288, true), 4);
assert.equal(view.getFloat64(296, true), 5);

console.log('Arc-length Phase 2 option wire checks passed.');
