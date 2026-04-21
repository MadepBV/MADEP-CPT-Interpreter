import { analyzeSeepageModel, sampleSeepageHead } from '../src/lib/cpt-app/seepage/solver.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approxLE(value, limit, message) {
  assert(Number.isFinite(value) && value <= limit, `${message} (got ${value}, limit ${limit})`);
}

function assertFlowErrorWithinTolerance(solved, message) {
  const error = Number(solved?.result?.flowError);
  const tolerance = Number(solved?.result?.solver?.flowErrorTolerance);
  assert(solved?.result?.solver?.converged !== false, `${message} should converge before checking the flow-error target`);
  assert(Number.isFinite(error), `${message} should report a finite flow error`);
  assert(Number.isFinite(tolerance), `${message} should report a finite flow-error tolerance`);
  approxLE(error, tolerance, `${message} should satisfy the configured flow-error tolerance`);
}

function assertContiguousActiveSeepageBlock(faces, activeMask, message) {
  const sorted = faces
    .map((face, index) => ({ face, active: !!activeMask[index] }))
    .sort((left, right) => left.face.mid.y - right.face.mid.y);
  let seenInactiveAboveActive = false;
  let seenActive = false;
  sorted.forEach((item) => {
    if (item.active) {
      seenActive = true;
      assert(!seenInactiveAboveActive, message);
      return;
    }
    if (seenActive) seenInactiveAboveActive = true;
  });
}

function distancePointToSegment(point, a, b) {
  const abx = (b?.x || 0) - (a?.x || 0);
  const aby = (b?.y || 0) - (a?.y || 0);
  const len2 = abx * abx + aby * aby;
  if (!(len2 > 0)) return Math.hypot((point?.x || 0) - (a?.x || 0), (point?.y || 0) - (a?.y || 0));
  const t = Math.min(Math.max((((point?.x || 0) - (a?.x || 0)) * abx + ((point?.y || 0) - (a?.y || 0)) * aby) / len2, 0), 1);
  const qx = (a?.x || 0) + abx * t;
  const qy = (a?.y || 0) + aby * t;
  return Math.hypot((point?.x || 0) - qx, (point?.y || 0) - qy);
}

function verticalSegmentIntersections(segments, x, tol = 1e-6) {
  const hits = [];
  (segments || []).forEach((segment) => {
    if (!Array.isArray(segment) || segment.length !== 2) return;
    const [a, b] = segment;
    const xMin = Math.min(a?.x || 0, b?.x || 0) - tol;
    const xMax = Math.max(a?.x || 0, b?.x || 0) + tol;
    if (x < xMin || x > xMax) return;
    const dx = (b?.x || 0) - (a?.x || 0);
    if (Math.abs(dx) <= tol) {
      if (Math.abs(x - (a?.x || 0)) <= tol) hits.push(0.5 * ((a?.y || 0) + (b?.y || 0)));
      return;
    }
    const t = (x - (a?.x || 0)) / dx;
    if (t < -tol || t > 1 + tol) return;
    hits.push((a?.y || 0) + ((b?.y || 0) - (a?.y || 0)) * t);
  });
  return hits
    .sort((left, right) => left - right)
    .filter((value, index, array) => index === 0 || Math.abs(value - array[index - 1]) > 1e-4);
}

function homogeneousRegion(xMin, xMax, yMin, yMax, id = 'soil') {
  return {
    id,
    polygon: [
      { x: xMin, y: yMin },
      { x: xMax, y: yMin },
      { x: xMax, y: yMax },
      { x: xMin, y: yMax }
    ],
    material: {
      id,
      label: id,
      kx: 1e-5,
      ky: 1e-5,
      gamma: 18,
      gammaSat: 20
    }
  };
}

function baseFixedModel(rightBcType) {
  return {
    terrain: {
      vertices: [
        { x: 0, y: 5 },
        { x: 10, y: 5 }
      ]
    },
    analysisBottomY: 0,
    phreatic: {
      vertices: [
        { x: 0, y: 5 },
        { x: 10, y: 2 }
      ]
    },
    walls: [],
    regions: [homogeneousRegion(0, 10, 0, 5)],
    seepage: {
      bcs: [
        { edgeKey: 'side-left:0', type: 'head', head: 5, status: 'active' },
        { edgeKey: 'side-right:0', type: rightBcType, head: rightBcType === 'head' ? 2 : null, status: 'active' }
      ],
      options: {
        freeSurface: 'fixed',
        meshTargetArea: 0.4,
        maxFreeSurfaceIter: 20,
        usePhreaticAsSeed: true
      }
    }
  };
}

function layeredIterateModel(kMid) {
  return {
    terrain: {
      vertices: [
        { x: 0, y: 5 },
        { x: 20, y: 5 }
      ]
    },
    analysisBottomY: 0,
    phreatic: {
      vertices: [
        { x: 0, y: 5 },
        { x: 20, y: 0 }
      ]
    },
    walls: [],
    regions: [
      {
        id: 'bot',
        polygon: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 2 },
          { x: 0, y: 2 }
        ],
        material: {
          id: 'bot',
          label: 'bot',
          kx: 1e-5,
          ky: 1e-5,
          gamma: 18,
          gammaSat: 20
        }
      },
      {
        id: 'mid',
        polygon: [
          { x: 0, y: 2 },
          { x: 20, y: 2 },
          { x: 20, y: 3 },
          { x: 0, y: 3 }
        ],
        material: {
          id: 'mid',
          label: 'mid',
          kx: kMid,
          ky: kMid,
          gamma: 18,
          gammaSat: 20
        }
      },
      {
        id: 'top',
        polygon: [
          { x: 0, y: 3 },
          { x: 20, y: 3 },
          { x: 20, y: 5 },
          { x: 0, y: 5 }
        ],
        material: {
          id: 'top',
          label: 'top',
          kx: 1e-5,
          ky: 1e-5,
          gamma: 18,
          gammaSat: 20
        }
      }
    ],
    seepage: {
      bcs: [
        { edgeKey: 'side-left:0', type: 'head', head: 5, status: 'active' },
        { edgeKey: 'side-right:0', type: 'seepage-face', status: 'active' }
      ],
      options: {
        freeSurface: 'iterate',
        meshTargetArea: 0.2,
        maxFreeSurfaceIter: 80,
        usePhreaticAsSeed: true
      }
    }
  };
}

async function runCase(name, fn) {
  await fn();
  console.log(`${name}: ok`);
}

await runCase('Case 1 head/head disables exit gradient', async () => {
  const solved = await analyzeSeepageModel({ model: baseFixedModel('head') });
  approxLE(solved.result.maxExitGradient, 1e-9, 'head/head case should not report an exit gradient');
  const seepageFaces = solved.mesh.boundaryFaces.filter((face) => face.type === 'seepage-face');
  assert(seepageFaces.length === 0, 'head/head case should not carry seepage-face boundary edges');
});

await runCase('Case 2 seepage face enables exit gradient', async () => {
  const solved = await analyzeSeepageModel({ model: baseFixedModel('seepage-face') });
  assert(solved.result.maxExitGradient > 0.05, 'seepage-face case should report a positive exit gradient');
  const seepageFaces = solved.mesh.boundaryFaces.filter((face) => face.type === 'seepage-face');
  assert(seepageFaces.length > 0, 'seepage-face case should expose seepage-face boundary edges');
  assert((solved.result.flowLines || []).length > 0, 'seepage-face case should generate flow lines from the solved discharge field');
});

await runCase('Case 3 iterate mode converges and matches Dupuit profile', async () => {
  const H = 5;
  const L = 10;
  const solved = await analyzeSeepageModel({
    model: {
      terrain: {
        vertices: [
          { x: 0, y: H },
          { x: L, y: H }
        ]
      },
      analysisBottomY: 0,
      phreatic: {
        vertices: [
          { x: 0, y: H },
          { x: L, y: 0 }
        ]
      },
      walls: [],
      regions: [homogeneousRegion(0, L, 0, H)],
      seepage: {
        bcs: [
          { edgeKey: 'side-left:0', type: 'head', head: H, status: 'active' },
          { edgeKey: 'side-right:0', type: 'seepage-face', status: 'active' }
        ],
        options: {
          freeSurface: 'iterate',
          meshTargetArea: 0.4,
          maxFreeSurfaceIter: 80,
          usePhreaticAsSeed: true
        }
      }
    }
  });

  assert(solved.result.solver.iterations >= 1, 'iterate case should report outer iterations');
  assert(solved.result.phreaticSegments.length > 0, 'iterate case should produce a phreatic isoline');
  assertFlowErrorWithinTolerance(solved, 'iterate case');

  [2.5, 5, 7.5].forEach((x) => {
    const yExpected = Math.sqrt(H * H * (1 - x / L));
    const sampledHead = sampleSeepageHead(solved.mesh, solved.result, x, yExpected);
    const delta = Math.abs((sampledHead ?? NaN) - yExpected);
    approxLE(delta, 0.05 * H, `iterate case should match the Dupuit phreatic profile at x=${x}`);
  });
});

await runCase('Case 3b iterate mode returns a usable result when the runtime limit is reached', async () => {
  const solved = await analyzeSeepageModel({
    model: {
      terrain: {
        vertices: [
          { x: 0, y: 5 },
          { x: 10, y: 5 }
        ]
      },
      analysisBottomY: 0,
      phreatic: {
        vertices: [
          { x: 0, y: 5 },
          { x: 10, y: 0 }
        ]
      },
      walls: [],
      regions: [homogeneousRegion(0, 10, 0, 5)],
      seepage: {
        bcs: [
          { edgeKey: 'side-left:0', type: 'head', head: 5, status: 'active' },
          { edgeKey: 'side-right:0', type: 'seepage-face', status: 'active' }
        ],
        options: {
          freeSurface: 'iterate',
          meshTargetArea: 0.08,
          maxFreeSurfaceIter: 80,
          flowErrorTolerance: 1e-4,
          maxRuntimeMs: 1,
          usePhreaticAsSeed: true
        }
      }
    }
  });

  assert(solved.result.solver.terminationReason === 'time-limit', 'runtime-limited iterate case should report a time-limit termination');
  assert(solved.result.solver.converged === false, 'runtime-limited iterate case should report non-convergence');
  assert(solved.result.solver.iterations >= 1, 'runtime-limited iterate case should still complete at least one outer iteration');
  assert(Number.isFinite(solved.result.headMin) && Number.isFinite(solved.result.headMax), 'runtime-limited iterate case should still return a solved head field');
});

await runCase('Case 4 moderate mesh stays under target size and runtime', async () => {
  const terrain = {
    vertices: Array.from({ length: 41 }, (_, i) => ({
      x: i * 0.5,
      y: 8 - 0.03 * i + 0.6 * Math.sin(i / 4)
    }))
  };
  const xMax = terrain.vertices.at(-1).x;
  const regions = [];
  for (let k = 0; k < 6; k += 1) {
    const yTop = 8 - k * 1.2;
    const yBot = k === 5 ? 0 : 8 - (k + 1) * 1.2;
    regions.push({
      id: `r${k}`,
      polygon: [
        { x: 0, y: yBot },
        { x: xMax, y: yBot },
        { x: xMax, y: yTop },
        { x: 0, y: yTop }
      ],
      material: {
        id: `m${k}`,
        label: `m${k}`,
        kx: 1e-5 / (k + 1),
        ky: 5e-6 / (k + 1),
        gamma: 18,
        gammaSat: 20
      }
    });
  }

  const started = Date.now();
  const solved = await analyzeSeepageModel({
    model: {
      terrain,
      analysisBottomY: 0,
      phreatic: {
        vertices: [
          { x: 0, y: 7.2 },
          { x: xMax, y: 2.4 }
        ]
      },
      walls: [{ x: 7.8, yTop: 7.5, yTip: 1.0, passiveSide: 'right' }],
      regions,
      seepage: {
        bcs: [
          { edgeKey: 'side-left:0', type: 'head', head: 7.2, status: 'active' },
          { edgeKey: 'side-right:0', type: 'seepage-face', status: 'active' }
        ],
        options: {
          freeSurface: 'fixed',
          meshTargetArea: 0.35,
          maxFreeSurfaceIter: 20,
          usePhreaticAsSeed: true
        }
      }
    }
  });
  const runtimeMs = Date.now() - started;
  approxLE(runtimeMs, 3000, 'moderate seepage probe should solve within 3 s');
  approxLE(solved.mesh.elements.length, 5000, 'moderate seepage probe should stay under 5000 triangles');
});

await runCase('Case 5 embankment seepage face stays contiguous and converges', async () => {
  const solved = await analyzeSeepageModel({
    model: {
      terrain: {
        vertices: [
          { x: 0, y: 8 },
          { x: 4, y: 8 },
          { x: 10, y: 4 }
        ]
      },
      analysisBottomY: 0,
      phreatic: {
        vertices: [
          { x: 0, y: 8 },
          { x: 4, y: 7.6 },
          { x: 10, y: 4.2 }
        ]
      },
      walls: [],
      regions: [homogeneousRegion(0, 10, 0, 8)],
      seepage: {
        bcs: [
          { edgeKey: 'side-left:0', type: 'head', head: 8, status: 'active' },
          { edgeKey: 'terrain:1', type: 'seepage-face', status: 'active' }
        ],
        options: {
          freeSurface: 'iterate',
          meshTargetArea: 0.2,
          maxFreeSurfaceIter: 80,
          usePhreaticAsSeed: true
        }
      }
    }
  });

  const slopeFaces = solved.mesh.boundaryFaces.filter((face) => face.edgeKey === 'terrain:1');
  const slopeMask = solved.result.activeSeepageFaceMask.filter((_, index) => solved.mesh.boundaryFaces[index]?.edgeKey === 'terrain:1');
  assert(slopeFaces.length > 0, 'embankment case should split the downstream slope into seepage boundary faces');
  assert(slopeMask.some(Boolean), 'embankment case should activate at least one downstream seepage face');
  assertFlowErrorWithinTolerance(solved, 'embankment case');
  assertContiguousActiveSeepageBlock(
    slopeFaces,
    slopeMask,
    'embankment case should not reactivate isolated seepage-face edges above an inactive downstream slope segment'
  );

  (solved.result.equipotentialSegments || []).forEach((group) => {
    (group.segments || []).forEach((segment) => {
      const mid = {
        x: 0.5 * (segment[0].x + segment[1].x),
        y: 0.5 * (segment[0].y + segment[1].y)
      };
      const head = sampleSeepageHead(solved.mesh, solved.result, mid.x, mid.y);
      assert(Number.isFinite(head), 'embankment equipotential midpoint should remain inside the solved seepage domain');
      approxLE(
        mid.y - head,
        0.02,
        'embankment equipotential segments should not be shown materially above the computed free surface'
      );
    });
  });

  assert((solved.result.flowLines || []).length > 0, 'embankment case should produce visible flow lines');
  (solved.result.flowLines || []).forEach((line) => {
    line.forEach((point) => {
      const head = sampleSeepageHead(solved.mesh, solved.result, point.x, point.y);
      assert(Number.isFinite(head), 'flowline point should remain inside the solved seepage domain');
      approxLE(
        point.y - head,
        0.02,
        'flowline points should not be shown materially above the computed free surface'
      );
    });
    const end = line[line.length - 1];
    const nearBoundary = (solved.mesh.boundaryFaces || []).some((face) => distancePointToSegment(end, face.a, face.b) <= 0.06);
    const endHead = sampleSeepageHead(solved.mesh, solved.result, end.x, end.y);
    const nearFreeSurface = Number.isFinite(endHead) ? Math.abs(endHead - end.y) <= 0.03 : false;
    assert(
      nearBoundary || nearFreeSurface,
      'flowlines should terminate at a boundary or at the computed free surface, not stop arbitrarily inside the embankment'
    );
  });

  const crestHead = sampleSeepageHead(solved.mesh, solved.result, 4.6, 7.4);
  approxLE(
    crestHead - 7.4,
    0.02,
    'embankment case should not create a materially positive pressure head pocket at the downstream crest'
  );
});

await runCase('Case 5b embankment iterate mode stays close across phreatic seeds', async () => {
  const solveEmbankment = (phreaticVertices, usePhreaticAsSeed) =>
    analyzeSeepageModel({
      model: {
        terrain: {
          vertices: [
            { x: 0, y: 8 },
            { x: 4, y: 8 },
            { x: 10, y: 4 }
          ]
        },
        analysisBottomY: 0,
        phreatic: phreaticVertices ? { vertices: phreaticVertices } : null,
        walls: [],
        regions: [homogeneousRegion(0, 10, 0, 8)],
        seepage: {
          bcs: [
            { edgeKey: 'side-left:0', type: 'head', head: 8, status: 'active' },
            { edgeKey: 'terrain:1', type: 'seepage-face', status: 'active' }
          ],
          options: {
            freeSurface: 'iterate',
            meshTargetArea: 0.2,
            maxFreeSurfaceIter: 80,
            usePhreaticAsSeed
          }
        }
      }
    });

  const seeded = await solveEmbankment(
    [
      { x: 0, y: 8 },
      { x: 4, y: 7.6 },
      { x: 10, y: 4.2 }
    ],
    true
  );
  const unseeded = await solveEmbankment(
    [
      { x: 0, y: 8 },
      { x: 4, y: 7.6 },
      { x: 10, y: 4.2 }
    ],
    false
  );
  assertFlowErrorWithinTolerance(seeded, 'seeded embankment case');
  assertFlowErrorWithinTolerance(unseeded, 'unseeded embankment case');

  assert(
    seeded.result.activeSeepageFaceMask.length === unseeded.result.activeSeepageFaceMask.length,
    'seeded and unseeded embankment solves should expose the same seepage-face mask length'
  );
  seeded.result.activeSeepageFaceMask.forEach((value, index) => {
    assert(
      !!value === !!unseeded.result.activeSeepageFaceMask[index],
      `embankment seepage-face activation should not depend on the initial phreatic seed at face ${index}`
    );
  });

  const samplePoints = [
    { x: 4.6, y: 7.4 },
    { x: 6, y: 6.6 },
    { x: 8, y: 5.3 },
    { x: 9.2, y: 4.45 }
  ];
  let maxHeadDelta = 0;
  samplePoints.forEach((point) => {
    const seededHead = sampleSeepageHead(seeded.mesh, seeded.result, point.x, point.y);
    const unseededHead = sampleSeepageHead(unseeded.mesh, unseeded.result, point.x, point.y);
    assert(Number.isFinite(seededHead) && Number.isFinite(unseededHead), 'embankment seed-sensitivity probe should stay inside the solved domain');
    maxHeadDelta = Math.max(maxHeadDelta, Math.abs(seededHead - unseededHead));
  });
  approxLE(maxHeadDelta, 0.03, 'embankment head field should stay materially consistent when the iterative seed is disabled');

  const flowReference = Math.max(Math.abs(unseeded.result.throughFlow), 1e-12);
  approxLE(
    Math.abs(seeded.result.throughFlow - unseeded.result.throughFlow) / flowReference,
    0.02,
    'embankment through-flow should stay close when the iterative seed is disabled'
  );
});

await runCase('Case 6 layered iterate mode keeps low-k precision and a single phreatic envelope', async () => {
  const solved = await analyzeSeepageModel({ model: layeredIterateModel(1e-12) });
  assertFlowErrorWithinTolerance(solved, 'layered iterate case');

  const midElementKx = solved.mesh.elementData
    .filter((_, index) => solved.mesh.cells[solved.mesh.elementCell[index]]?.material?.id === 'mid')
    .map((item) => Number(item?.kx))
    .filter(Number.isFinite);
  assert(midElementKx.length > 0, 'layered iterate case should contain middle-layer elements');
  assert(
    Math.max(...midElementKx) < 5e-12 && Math.max(...midElementKx) > 5e-13,
    'layered iterate case should preserve a 1e-12 m/s sublayer instead of flooring it to the wall permeability'
  );

  [4, 8, 12, 16, 18].forEach((x) => {
    const hits = verticalSegmentIntersections(solved.result.phreaticSegments, x);
    assert(
      hits.length <= 1,
      `layered iterate case should export only the top phreatic envelope at x=${x} (got ${hits.join(', ')})`
    );
  });
});

await runCase('Case 7 extreme low-k layer remains numerically stable in JavaScript', async () => {
  const solved = await analyzeSeepageModel({ model: layeredIterateModel(1e-18) });
  assertFlowErrorWithinTolerance(solved, 'extreme low-k case');
  const midElementKx = solved.mesh.elementData
    .filter((_, index) => solved.mesh.cells[solved.mesh.elementCell[index]]?.material?.id === 'mid')
    .map((item) => Number(item?.kx))
    .filter(Number.isFinite);
  assert(midElementKx.length > 0, 'extreme low-k case should contain middle-layer elements');
  assert(
    Math.max(...midElementKx) < 5e-18 && Math.max(...midElementKx) > 5e-19,
    'extreme low-k case should preserve a 1e-18 m/s sublayer within JavaScript Number precision'
  );
  assert(Number.isFinite(solved.result.solver.residualNorm), 'extreme low-k case should report a finite linear residual');
  assert(solved.result.solver.innerIterations > 0, 'extreme low-k case should still solve the linear system');
  [4, 12, 18].forEach((x) => {
    const hits = verticalSegmentIntersections(solved.result.phreaticSegments, x);
    assert(
      hits.length <= 1,
      `extreme low-k case should keep a single phreatic envelope at x=${x} (got ${hits.join(', ')})`
    );
  });
});

await runCase('Case 8 partially submerged head edge only constrains the wetted upstream face', async () => {
  const solved = await analyzeSeepageModel({
    model: {
      terrain: {
        vertices: [
          { x: 0, y: 0 },
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 10, y: 0 }
        ]
      },
      analysisBottomY: -2,
      phreatic: {
        vertices: [
          { x: 0, y: 2.5 },
          { x: 10, y: 0 }
        ]
      },
      walls: [],
      regions: [homogeneousRegion(0, 10, -2, 4)],
      seepage: {
        bcs: [
          { edgeKey: 'terrain:0', type: 'head', head: 2.5, status: 'active' },
          { edgeKey: 'terrain:2', type: 'seepage-face', status: 'active' }
        ],
        options: {
          freeSurface: 'iterate',
          meshTargetArea: 0.12,
          maxFreeSurfaceIter: 80,
          usePhreaticAsSeed: true
        }
      }
    }
  });

  const upstreamFaces = (solved.mesh.boundaryFaces || []).filter((face) => face.edgeKey === 'terrain:0');
  assertFlowErrorWithinTolerance(solved, 'partially submerged head case');
  assert(upstreamFaces.length > 1, 'partially submerged head case should split the upstream slope into multiple boundary faces');
  const wetFaces = upstreamFaces.filter((face) => face.headSubmerged === true);
  const dryFaces = upstreamFaces.filter((face) => face.headSubmerged === false);
  assert(wetFaces.length > 0, 'partially submerged head case should keep wetted upstream head faces');
  assert(dryFaces.length > 0, 'partially submerged head case should leave a dry upstream segment above the waterline');
  assert(
    dryFaces.every((face) => face.mid.y >= 2.5 - 1e-6),
    'dry upstream head faces should lie at or above the waterline'
  );
  assert(
    wetFaces.every((face) => face.mid.y <= 2.5 + 1e-6),
    'wetted upstream head faces should lie at or below the waterline'
  );

  const dryNodeIds = [...new Set(dryFaces.flatMap((face) => [face.n1, face.n2]))];
  assert(
    dryNodeIds.some((nodeId) => Math.abs((solved.result.heads?.[nodeId] ?? NaN) - 2.5) > 0.05),
    'dry upstream nodes should not be clamped to the prescribed reservoir head'
  );
});

console.log('Seepage Phase 2 verification passed.');
