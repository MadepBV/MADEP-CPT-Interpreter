#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {
  arcLengthDerivativeModeCode,
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
    arcLengthDerivativeMode: 'analytic-verified'
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

console.log('Arc-length Phase 2 option wire checks passed.');
