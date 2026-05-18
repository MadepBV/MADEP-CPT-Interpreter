// Regression: drain must lower the computed head field even when its
// gating is the default ('when-saturated') and the user runs the seepage
// solver in 'fixed' (pinned-phreatic) mode.
//
// Background: the original 'fixed' branch in solveSeepage() called
// buildDirichletValues() with activeDrainNodes=null. drainEntryIsActive()
// returns false for any gating other than 'always' when the mask is null,
// so a default-gating drain was silently disabled in fixed mode — the
// solved head field showed no drain influence, the totalInflow stayed at
// zero, and the "long-runtime" complaint had no effect because the bug
// was in 'fixed' mode (no flow-error loop runs there).
//
// This script reproduces a small canonical model that exercises:
//   - 'fixed' phreatic mode  with default 'when-saturated' drain gating,
//   - 'iterate' mode with the same drain (free-surface response sanity),
//   - all three gating modes inside fixed mode (always / head-cap /
//     when-saturated must all activate when the drain sits below the
//     pinned phreatic).
//
// Pass criteria:
//   - 'fixed' mode: drain near h_d=3 must observe head ≈ h_d across the
//     drain footprint, drain totalInflow > 0, and head field above the
//     drain must drop materially below the pinned phreatic level (y=8).
//   - 'iterate' mode: computed phreatic line must drop toward y≈h_d.

import {
  analyzeSeepageModel,
  sampleSeepageHead
} from '../src/lib/cpt-app/seepage/solver.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const HEIGHT = 10;
const WIDTH = 20;
const PHREATIC_Y = 8;
const DRAIN_Y = 3;
const DRAIN_H = 3;
const UPSTREAM_HEAD = 8;
const K = 1e-5;

function homogeneousRegion() {
  return {
    id: 'soil',
    polygon: [
      { x: 0, y: 0 },
      { x: WIDTH, y: 0 },
      { x: WIDTH, y: HEIGHT },
      { x: 0, y: HEIGHT }
    ],
    material: { id: 'soil', label: 'soil', kx: K, ky: K, gamma: 18, gammaSat: 20 }
  };
}

function buildModel({ freeSurface = 'iterate', gating = 'when-saturated' } = {}) {
  return {
    terrain: {
      vertices: [
        { x: 0, y: HEIGHT },
        { x: WIDTH, y: HEIGHT }
      ]
    },
    analysisBottomY: 0,
    phreatic: {
      vertices: [
        { x: 0, y: PHREATIC_Y },
        { x: WIDTH, y: PHREATIC_Y }
      ]
    },
    walls: [],
    drains: [
      {
        id: 'drain-1',
        label: 'low drain',
        vertices: [
          { x: 5, y: DRAIN_Y },
          { x: 15, y: DRAIN_Y }
        ],
        closed: false,
        head: { kind: 'constant', value: DRAIN_H },
        gating
      }
    ],
    regions: [homogeneousRegion()],
    seepage: {
      bcs: [
        // Upstream supply on the left wall keeps the drain extracting in
        // steady state. Other walls remain no-flow.
        { edgeKey: 'side-left:0', type: 'head', head: UPSTREAM_HEAD, status: 'active' }
      ],
      options: {
        freeSurface,
        meshTargetArea: 0.25,
        usePhreaticAsSeed: true,
        maxRuntimeMs: 30000,
        flowErrorTolerance: 1e-4
      }
    }
  };
}

function phreaticYRange(result) {
  const segs = result?.phreaticSegments || [];
  let ymin = Infinity;
  let ymax = -Infinity;
  segs.forEach((seg) => {
    const pts = Array.isArray(seg) ? seg : seg ? [seg.a, seg.b] : [];
    pts.forEach((pt) => {
      const y = Number(pt?.y);
      if (!Number.isFinite(y)) return;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    });
  });
  return { ymin: Number.isFinite(ymin) ? ymin : null, ymax: Number.isFinite(ymax) ? ymax : null };
}

async function checkFixedModeDrainActivates(gating) {
  const solved = await analyzeSeepageModel({ model: buildModel({ freeSurface: 'fixed', gating }) });
  const result = solved.result;
  const drain = result.drains?.[0];
  assert(drain, `fixed/${gating}: drain summary should be present`);
  const activeNodes = drain.nodes.filter((node) => node.isActive).length;
  const gatedNodes = drain.nodes.filter((node) => node.gated).length;
  assert(
    activeNodes > 0,
    `fixed/${gating}: at least one drain node must be active when the drain sits below the pinned phreatic ` +
    `(got ${activeNodes} active, ${gatedNodes} gated)`
  );
  assert(
    drain.totalInflow > 1e-12,
    `fixed/${gating}: drain totalInflow must be positive (got ${drain.totalInflow})`
  );
  // Active drain nodes must sit at H_d.
  const maxHeadDeviation = Math.max(
    ...drain.nodes.filter((node) => node.isActive).map((node) => Math.abs(node.head - DRAIN_H))
  );
  assert(
    maxHeadDeviation <= 1e-6,
    `fixed/${gating}: active drain nodes must satisfy h = h_d (max deviation ${maxHeadDeviation})`
  );
  // Head field above the drain (x=10, y=6, midway between the rigid phreatic at y=8 and the drain at y=3)
  // must show drawdown — strictly below the input phreatic level and strictly above the drain head.
  const headAbove = sampleSeepageHead(solved.mesh, result, 10, 6);
  assert(
    Number.isFinite(headAbove) && headAbove < PHREATIC_Y - 0.5,
    `fixed/${gating}: head field above the drain must drop materially below the pinned phreatic ` +
    `(h at (10,6) = ${headAbove})`
  );
  assert(
    headAbove > DRAIN_H + 0.1,
    `fixed/${gating}: head field above the drain must stay above the drain head (h at (10,6) = ${headAbove})`
  );
  // Head at the drain itself should be exactly H_d.
  const headAtDrain = sampleSeepageHead(solved.mesh, result, 10, DRAIN_Y);
  assert(
    Math.abs(headAtDrain - DRAIN_H) <= 1e-3,
    `fixed/${gating}: head sampled at drain centre must equal h_d (got ${headAtDrain}, expected ${DRAIN_H})`
  );
}

async function checkIterateModePhreaticDrops() {
  const solved = await analyzeSeepageModel({
    model: buildModel({ freeSurface: 'iterate', gating: 'when-saturated' })
  });
  const result = solved.result;
  assert(result.solver.converged, `iterate: solver should converge (term=${result.solver.terminationReason})`);
  const drain = result.drains?.[0];
  assert(drain && drain.totalInflow > 1e-12, `iterate: drain must extract flow (got ${drain?.totalInflow})`);
  const range = phreaticYRange(result);
  assert(
    Number.isFinite(range.ymin) && range.ymin <= DRAIN_H + 0.5,
    `iterate: computed phreatic envelope must reach near the drain head (ymin=${range.ymin}, expected ≤ ${DRAIN_H + 0.5})`
  );
  assert(
    Number.isFinite(range.ymax) && range.ymax <= PHREATIC_Y + 1e-3,
    `iterate: phreatic envelope must not exceed the upstream supply (ymax=${range.ymax}, expected ≤ ${PHREATIC_Y})`
  );
  // The drop from the upstream supply (y=8) toward the drain (y=3) must be material.
  const drop = range.ymax - range.ymin;
  assert(
    drop >= 3,
    `iterate: free surface must drop materially between upstream and drain (drop=${drop}, expected ≥ 3 m)`
  );
}

async function checkLongRuntimeStillLowersSurface() {
  // The user-reported failure mode was "long runtime, flow error small,
  // free surface not affected by drain". Reproduce with a tighter
  // tolerance and a longer runtime budget — the phreatic must still drop.
  const model = buildModel({ freeSurface: 'iterate', gating: 'when-saturated' });
  model.seepage.options.flowErrorTolerance = 1e-5;
  model.seepage.options.maxRuntimeMs = 60000;
  const solved = await analyzeSeepageModel({ model });
  const range = phreaticYRange(solved.result);
  assert(
    Number.isFinite(range.ymin) && range.ymin <= DRAIN_H + 0.3,
    `long-runtime iterate: phreatic must drop toward the drain (ymin=${range.ymin})`
  );
}

const checks = [
  ['fixed mode + always drain activates', () => checkFixedModeDrainActivates('always')],
  ['fixed mode + head-cap drain activates', () => checkFixedModeDrainActivates('head-cap')],
  ['fixed mode + when-saturated drain activates', () => checkFixedModeDrainActivates('when-saturated')],
  ['iterate mode + drain lowers phreatic', checkIterateModePhreaticDrops],
  ['long-runtime iterate keeps phreatic drop', checkLongRuntimeStillLowersSurface]
];

for (const [name, fn] of checks) {
  await fn();
  console.log(`${name}: ok`);
}

console.log('Drain free-surface response verification passed.');
