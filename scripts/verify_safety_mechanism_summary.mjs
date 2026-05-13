#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {
  buildSafetyMechanismElementNeighbors,
  buildSafetyMechanismSummary
} from '../src/lib/cpt-app/deformation/safety-mechanism.js';

function makeMesh() {
  return {
    nodes: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: 2, y: -1 },
      { x: 3, y: -1 }
    ],
    elements: [
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6]
    ],
    constraintEdges: [
      { markerType: 'outer', source: 'terrain', nodeIds: [0, 1] },
      { markerType: 'outer', source: 'terrain', nodeIds: [1, 2] },
      { markerType: 'outer', source: 'terrain', nodeIds: [2, 3] },
      { markerType: 'outer', source: 'left', nodeIds: [0, 4] },
      { markerType: 'outer', source: 'base', nodeIds: [4, 5] },
      { markerType: 'outer', source: 'base', nodeIds: [5, 6] },
      { markerType: 'outer', source: 'base', nodeIds: [6, 7] },
      { markerType: 'outer', source: 'right', nodeIds: [3, 7] }
    ]
  };
}

function makeElementResults(activeIndices, increment = 1e-4) {
  const active = new Set(activeIndices);
  return Array.from({ length: 6 }, (_item, elementIndex) => {
    const value = active.has(elementIndex) ? increment : 0;
    return {
      elementIndex,
      area: 0.5,
      materialDiagnostics: {
        safetyEquivalentPlasticIncrement: value
      },
      gaussPoints: [
        {
          areaWeight: 0.5,
          materialDiagnostics: {
            safetyEquivalentPlasticIncrement: value
          }
        }
      ]
    };
  });
}

function makeDisplacements() {
  return Array.from({ length: 8 }, () => ({ ux: 0.001, uy: -0.001 }));
}

const mesh = makeMesh();
const load = { q: 50, xStart: 0.8, xEnd: 2.2 };
const safetyCurve = [
  { maxDeltaPlasticStrain: 0 },
  { maxDeltaPlasticStrain: 1e-4 }
];

const neighbors = buildSafetyMechanismElementNeighbors(mesh);
assert.ok(neighbors[0].includes(3), 'edge-shared neighbors must include triangle across edge 1:5');
assert.ok(!neighbors[0].includes(2), 'node-only contact must not create a mechanism neighbor');

const localized = buildSafetyMechanismSummary({
  mesh,
  load,
  elementResults: makeElementResults([0, 3, 2, 5]),
  nodalDisplacements: makeDisplacements(),
  safetyCurve,
  options: {}
});
const scattered = buildSafetyMechanismSummary({
  mesh,
  load,
  elementResults: makeElementResults([0, 4]),
  nodalDisplacements: makeDisplacements(),
  safetyCurve,
  options: {}
});

assert.equal(localized.connectedComponentCount, 1, 'localized band should be one connected component');
assert.equal(scattered.connectedComponentCount, 2, 'scattered points should remain disconnected');
assert.ok(localized.score > scattered.score, 'localized connected band must score higher than scattered points');
assert.ok(localized.largestConnectedComponentElementCount > scattered.largestConnectedComponentElementCount);

const linearElastic = buildSafetyMechanismSummary({
  mesh,
  load,
  elementResults: makeElementResults([]),
  nodalDisplacements: makeDisplacements(),
  safetyCurve,
  options: {}
});
assert.equal(linearElastic.status, 'none', 'linear-elastic zero safety increment must not create a mechanism');
assert.equal(linearElastic.activePlasticElementCount, 0);

const servicePlasticOnly = buildSafetyMechanismSummary({
  mesh,
  load,
  elementResults: Array.from({ length: 6 }, (_item, elementIndex) => ({
    elementIndex,
    area: 0.5,
    materialState: { accumulatedPlasticStrain: 0.02 },
    materialDiagnostics: { safetyEquivalentPlasticIncrement: 0 },
    gaussPoints: [
      {
        areaWeight: 0.5,
        materialState: { accumulatedPlasticStrain: 0.02 },
        materialDiagnostics: { safetyEquivalentPlasticIncrement: 0 }
      }
    ]
  })),
  nodalDisplacements: makeDisplacements(),
  safetyCurve,
  options: {}
});
assert.equal(servicePlasticOnly.status, 'none', 'service plasticity without safety increment must not create a mechanism');

console.log('Safety mechanism summary checks passed.');
