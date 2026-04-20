import { analyzeSeepageModel, sampleSeepageHead } from '../src/lib/cpt-app/seepage/solver.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approxLE(value, limit, message) {
  assert(Number.isFinite(value) && value <= limit, `${message} (got ${value}, limit ${limit})`);
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

function runCase(name, fn) {
  fn();
  console.log(`${name}: ok`);
}

runCase('Case 1 head/head disables exit gradient', () => {
  const solved = analyzeSeepageModel({ model: baseFixedModel('head') });
  approxLE(solved.result.maxExitGradient, 1e-9, 'head/head case should not report an exit gradient');
  const seepageFaces = solved.mesh.boundaryFaces.filter((face) => face.type === 'seepage-face');
  assert(seepageFaces.length === 0, 'head/head case should not carry seepage-face boundary edges');
});

runCase('Case 2 seepage face enables exit gradient', () => {
  const solved = analyzeSeepageModel({ model: baseFixedModel('seepage-face') });
  assert(solved.result.maxExitGradient > 0.05, 'seepage-face case should report a positive exit gradient');
  const seepageFaces = solved.mesh.boundaryFaces.filter((face) => face.type === 'seepage-face');
  assert(seepageFaces.length > 0, 'seepage-face case should expose seepage-face boundary edges');
});

runCase('Case 3 iterate mode converges and matches Dupuit profile', () => {
  const H = 5;
  const L = 10;
  const solved = analyzeSeepageModel({
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

  [2.5, 5, 7.5].forEach((x) => {
    const yExpected = Math.sqrt(H * H * (1 - x / L));
    const sampledHead = sampleSeepageHead(solved.mesh, solved.result, x, yExpected);
    const delta = Math.abs((sampledHead ?? NaN) - yExpected);
    approxLE(delta, 0.05 * H, `iterate case should match the Dupuit phreatic profile at x=${x}`);
  });
});

runCase('Case 4 moderate mesh stays under target size and runtime', () => {
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
  const solved = analyzeSeepageModel({
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

console.log('Seepage Phase 2 verification passed.');
