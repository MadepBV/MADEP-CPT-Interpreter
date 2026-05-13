import { seepageGeometryHash } from '../src/lib/cpt-app/seepage/boundary.js';
import { WALL_DEFAULT_K } from '../src/lib/cpt-app/seepage/material.js';
import { analyzeSeepageModel, sampleSeepageHead } from '../src/lib/cpt-app/seepage/solver.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertClose(actual, expected, tolerance, message) {
  const delta = Math.abs(Number(actual) - Number(expected));
  assert(Number.isFinite(delta) && delta <= tolerance, `${message} (got ${actual}, expected ${expected}, tol ${tolerance})`);
}

function assertRelClose(actual, expected, tolerance, message) {
  const scale = Math.max(Math.abs(Number(actual)), Math.abs(Number(expected)), 1e-12);
  const rel = Math.abs(Number(actual) - Number(expected)) / scale;
  assert(Number.isFinite(rel) && rel <= tolerance, `${message} (rel ${rel}, tol ${tolerance})`);
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

function baseModel({
  height = 2,
  head = 10,
  drains = [],
  walls = [],
  meshTargetArea = 0.08,
  flowErrorTolerance = 1e-5
} = {}) {
  return {
    terrain: {
      vertices: [
        { x: 0, y: height },
        { x: 10, y: height }
      ]
    },
    analysisBottomY: 0,
    phreatic: {
      vertices: [
        { x: 0, y: height },
        { x: 10, y: height }
      ]
    },
    walls,
    drains,
    regions: [homogeneousRegion(0, 10, 0, height)],
    seepage: {
      bcs: [
        { edgeKey: 'terrain:0', type: 'head', head, status: 'active' },
        { edgeKey: 'side-left:0', type: 'head', head, status: 'active' },
        { edgeKey: 'side-right:0', type: 'head', head, status: 'active' }
      ],
      options: {
        freeSurface: 'iterate',
        meshTargetArea,
        usePhreaticAsSeed: true,
        maxRuntimeMs: 5000,
        flowErrorTolerance
      }
    }
  };
}

function drain(gating, head = 4, vertices = [{ x: 2, y: 1 }, { x: 8, y: 1 }]) {
  return {
    id: `drain-${gating}`,
    label: `${gating} drain`,
    vertices,
    closed: false,
    head: { kind: 'constant', value: head },
    gating
  };
}

function solvedDrain(solved) {
  const item = solved?.result?.drains?.[0];
  assert(item, 'solve should return a drain result');
  return item;
}

function drainReactionExtraction(drainResult) {
  return (drainResult.nodes || []).reduce((sum, node) => sum + Math.max(-(Number(node?.reaction) || 0), 0), 0);
}

function drainReactionInjection(drainResult) {
  return (drainResult.nodes || []).reduce((sum, node) => sum + Math.max(Number(node?.reaction) || 0, 0), 0);
}

function assertDrainMassClosure(result, tolerance = 2e-5) {
  const flux = result?.solver?.boundaryFlux || {};
  const left = (Number(flux.totalOutflow) || 0) + (Number(flux.drainOutflow) || 0);
  const right = (Number(flux.totalInflow) || 0) + (Number(flux.drainInflow) || 0);
  const rel = Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), 1e-12);
  assert(rel <= tolerance, `global drain mass balance should close (rel ${rel}, tol ${tolerance})`);
}

async function checkWallConductivity() {
  const legacyWall = { id: 'w1', x: 5, yTop: 2, yTip: 0, passiveSide: 'right' };
  const explicitLegacyWall = {
    ...legacyWall,
    material: {
      id: 'wall-legacy-w1',
      label: 'Legacy impermeable',
      kAcross: WALL_DEFAULT_K,
      kAlong: WALL_DEFAULT_K,
      gamma: 20,
      gammaSat: 20,
      kSource: 'legacy-impermeable'
    }
  };
  const userWall = {
    ...explicitLegacyWall,
    material: {
      ...explicitLegacyWall.material,
      kSource: 'user'
    }
  };
  const leakyWall = {
    ...explicitLegacyWall,
    material: {
      ...explicitLegacyWall.material,
      kAcross: 1e-7
    }
  };

  const legacyModel = baseModel({ walls: [legacyWall], meshTargetArea: 0.12 });
  const explicitModel = baseModel({ walls: [explicitLegacyWall], meshTargetArea: 0.12 });
  const legacy = await analyzeSeepageModel({ model: legacyModel });
  const explicit = await analyzeSeepageModel({ model: explicitModel });
  assert(legacy.result.heads.length === explicit.result.heads.length, 'legacy wall mesh should match explicit legacy material mesh');
  const maxHeadDelta = legacy.result.heads.reduce(
    (max, head, index) => Math.max(max, Math.abs(Number(head) - Number(explicit.result.heads[index]))),
    0
  );
  assert(maxHeadDelta <= 1e-12, `legacy wall material parity should hold (max head delta ${maxHeadDelta})`);

  const options = legacyModel.seepage.options;
  const legacyHash = seepageGeometryHash(legacyModel, options);
  assert(legacyHash !== seepageGeometryHash(baseModel({ walls: [userWall] }), options), 'kSource should invalidate seepage hash');
  assert(legacyHash !== seepageGeometryHash(baseModel({ walls: [leakyWall] }), options), 'kAcross should invalidate seepage hash');
}

async function checkAlwaysDrain() {
  const solved = await analyzeSeepageModel({ model: baseModel({ drains: [drain('always', 4)] }) });
  const result = solved.result;
  const item = solvedDrain(solved);
  const edgeCount = [...(solved.mesh.drainEdgesByDrain?.values?.() || [])].reduce((sum, edges) => sum + edges.length, 0);
  assert(edgeCount > 0, 'drain PSLG edges should survive Triangle meshing');
  assert(item.nodes.length > 2, 'drain should have recovered nodes from constraint edges');
  assert(item.nodes.every((node) => node.isActive && !node.gated), 'always drain nodes should be active');
  assert(item.nodes.every((node) => node.reaction <= 1e-12), 'extracting always drain should have R_i <= 0');
  assertClose(Math.max(...item.nodes.map((node) => Math.abs(node.head - 4))), 0, 1e-10, 'always drain nodes should sit at H_d');
  assertRelClose(item.totalInflow, drainReactionExtraction(item), 1e-10, 'Q_drain = -sum R_i should hold');
  assert(result.solver.activeSetSummary.drains.perEdgeReactionDelta <= 1e-10, 'edge/reaction drain cross-check should pass');
  assertDrainMassClosure(result);
}

async function checkDrainGates() {
  const activeCap = await analyzeSeepageModel({ model: baseModel({ drains: [drain('head-cap', 4)] }) });
  let item = solvedDrain(activeCap);
  assert(activeCap.result.solver.activeSetSummary.drains.activeNodes === item.nodes.length, 'head-cap in high field should stay active');
  assert(item.nodes.every((node) => node.reaction <= 1e-12), 'active head-cap nodes should not inject');
  assertClose(Math.max(...item.nodes.map((node) => Math.abs(node.head - 4))), 0, 1e-10, 'head-cap active nodes should sit at cap');
  assertDrainMassClosure(activeCap.result);

  const inactiveCap = await analyzeSeepageModel({
    model: baseModel({ drains: [drain('head-cap', 12)], flowErrorTolerance: 1 })
  });
  item = solvedDrain(inactiveCap);
  assert(inactiveCap.result.solver.activeSetSummary.drains.activeNodes === 0, 'head-cap above field should demote inactive');
  assert(item.totalInflow <= 1e-12, 'inactive head-cap should collect no flow');

  const saturated = await analyzeSeepageModel({ model: baseModel({ drains: [drain('when-saturated', 4)] }) });
  item = solvedDrain(saturated);
  assert(saturated.result.solver.activeSetSummary.drains.activeNodes === item.nodes.length, 'when-saturated drain should stay active in positive pressure field');
  assert(item.nodes.every((node) => node.reaction <= 1e-12), 'when-saturated extraction fixture should keep R_i <= 0');

  const perchedModel = baseModel({
    height: 10,
    head: 5,
    drains: [drain('when-saturated', 8, [{ x: 2, y: 8 }, { x: 8, y: 8 }])],
    meshTargetArea: 0.4,
    flowErrorTolerance: 1
  });
  perchedModel.phreatic = { vertices: [{ x: 0, y: 5 }, { x: 10, y: 5 }] };
  perchedModel.seepage.bcs = [
    { edgeKey: 'side-left:0', type: 'head', head: 5, status: 'active' },
    { edgeKey: 'side-right:0', type: 'head', head: 5, status: 'active' }
  ];
  const perched = await analyzeSeepageModel({ model: perchedModel });
  item = solvedDrain(perched);
  assert(perched.result.solver.activeSetSummary.drains.activeNodes === 0, 'perched when-saturated drain should be inactive');
  assert(item.totalInflow <= 1e-12, 'perched inactive drain should collect no flow');
}

async function checkVerticalDrainSymmetry() {
  const vertical = drain('head-cap', 4, [{ x: 5, y: 0.4 }, { x: 5, y: 1.6 }]);
  const solved = await analyzeSeepageModel({ model: baseModel({ drains: [vertical], meshTargetArea: 0.05 }) });
  const samples = [
    [4, 0.5],
    [4, 1.0],
    [4, 1.5]
  ];
  samples.forEach(([x, y]) => {
    const left = sampleSeepageHead(solved.mesh, solved.result, x, y);
    const right = sampleSeepageHead(solved.mesh, solved.result, 10 - x, y);
    assertRelClose(left, right, 5e-3, `vertical drain solution should be symmetric at y=${y}`);
  });
}

async function checkRoundTripDeterminism() {
  const model = baseModel({ drains: [drain('always', 4)] });
  const first = await analyzeSeepageModel({ model });
  const roundTripped = JSON.parse(JSON.stringify(model));
  const second = await analyzeSeepageModel({ model: roundTripped });
  assertRelClose(
    first.result.solver.boundaryFlux.drainInflow,
    second.result.solver.boundaryFlux.drainInflow,
    1e-12,
    'save/load JSON round-trip should reproduce drain inflow'
  );
}

const checks = [
  ['wall conductivity + hash', checkWallConductivity],
  ['always drain sign/discharge', checkAlwaysDrain],
  ['drain gates', checkDrainGates],
  ['vertical drain symmetry', checkVerticalDrainSymmetry],
  ['round-trip determinism', checkRoundTripDeterminism]
];

for (const [name, fn] of checks) {
  await fn();
  console.log(`${name}: ok`);
}

console.log('Seepage drains and walls verification passed.');
