import { analyzeDeformationModel } from '../src/lib/cpt-app/deformation/solver.js';
import { buildDeformationMesh } from '../src/lib/cpt-app/deformation/mesh.js';
import { debugSurfaceLoadContributionForTest } from '../src/lib/cpt-app/stage6-bishop.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approxAbs(left, right, absTol, message) {
  const diff = Math.abs(left - right);
  assert(diff <= absTol, `${message} (left ${left}, right ${right}, diff ${diff}, tol ${absTol})`);
}

function approxRelative(left, right, relTol, absTol, message) {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  const diff = Math.abs(left - right);
  assert(diff <= Math.max(absTol, relTol * scale), `${message} (left ${left}, right ${right}, diff ${diff})`);
}

const baseLoads = [
  {
    id: 'footing-a',
    label: 'Footing A',
    xStart: 7,
    xEnd: 9,
    q: 8,
    totalLoad: 0,
    loadMode: 'pressure',
    active: false
  },
  {
    id: 'footing-b',
    label: 'Footing B',
    xStart: 13,
    xEnd: 15,
    q: 12,
    totalLoad: 0,
    loadMode: 'pressure',
    active: false
  },
  {
    id: 'staged-future',
    label: 'Future surcharge',
    xStart: 18,
    xEnd: 20,
    q: 60,
    totalLoad: 0,
    loadMode: 'pressure',
    active: false
  }
];

function surfaceLoads(activeIds, overrides = {}) {
  const active = new Set(activeIds);
  return baseLoads.map((load) => ({
    ...load,
    ...(overrides[load.id] || {}),
    active: active.has(load.id)
  }));
}

function firstActive(loads) {
  return loads.find((load) => load.active !== false) || loads[0] || null;
}

function modelFor(loads) {
  return {
    terrain: {
      vertices: [
        { x: 0, y: 0 },
        { x: 28, y: 0 }
      ]
    },
    analysisBottomY: -12,
    phreatic: {
      vertices: [
        { x: 0, y: -20 },
        { x: 28, y: -20 }
      ]
    },
    walls: [],
    regions: [
      {
        id: 'soil',
        polygon: [
          { x: 0, y: -12 },
          { x: 28, y: -12 },
          { x: 28, y: 0 },
          { x: 0, y: 0 }
        ],
        material: {
          id: 'soil',
          label: 'linear elastic sand',
          Emc: 30000,
          nu: 0.3,
          K0nc: 0.5,
          cEff: 25,
          phiEffDeg: 32,
          gamma: 0,
          gammaSat: 0
        }
      }
    ],
    surfaceLoad: firstActive(loads)
      ? {
          xStart: firstActive(loads).xStart,
          xEnd: firstActive(loads).xEnd,
          q: firstActive(loads).q
        }
      : { xStart: null, xEnd: null, q: 0 },
    surfaceLoads: loads,
    seepage: { mesh: null, result: null }
  };
}

const analysisOptions = {
  meshTargetArea: 2.5,
  meshElementType: 't3',
  loadMode: 'pressure',
  outOfPlaneLength: 10,
  useSeepagePorePressures: false,
  constitutiveModel: 'linear-elastic',
  initialLoadStep: 1,
  maxLoadSteps: 4,
  nonlinearMaxIterations: 8,
  residualRelTol: 1e-8,
  residualAbsTol: 1e-10,
  displacementRelTol: 1e-8,
  displacementAbsTol: 1e-12,
  useWasmCpuPipeline: false
};

function compareMeshes(left, right, label) {
  assert(left?.nodes?.length === right?.nodes?.length, `${label}: node count changed`);
  assert(left?.elements?.length === right?.elements?.length, `${label}: element count changed`);
  for (let index = 0; index < left.nodes.length; index += 1) {
    approxAbs(left.nodes[index].x, right.nodes[index].x, 1e-10, `${label}: node ${index} x changed`);
    approxAbs(left.nodes[index].y, right.nodes[index].y, 1e-10, `${label}: node ${index} y changed`);
  }
}

function maxDisplacementMagnitude(output) {
  let max = 0;
  (output?.nodalDisplacements || []).forEach((node) => {
    max = Math.max(max, Math.abs(Number(node?.ux) || 0), Math.abs(Number(node?.uy) || 0));
  });
  return max;
}

function compareSuperposition(sumOutput, leftOutput, rightOutput) {
  assert(sumOutput?.nodalDisplacements?.length === leftOutput?.nodalDisplacements?.length, 'superposition: left node count changed');
  assert(sumOutput?.nodalDisplacements?.length === rightOutput?.nodalDisplacements?.length, 'superposition: right node count changed');
  const scale = Math.max(maxDisplacementMagnitude(sumOutput), maxDisplacementMagnitude(leftOutput), maxDisplacementMagnitude(rightOutput), 1e-9);
  const tol = Math.max(2e-5 * scale, 1e-9);
  for (let index = 0; index < sumOutput.nodalDisplacements.length; index += 1) {
    const expectedUx = (Number(leftOutput.nodalDisplacements[index]?.ux) || 0) + (Number(rightOutput.nodalDisplacements[index]?.ux) || 0);
    const expectedUy = (Number(leftOutput.nodalDisplacements[index]?.uy) || 0) + (Number(rightOutput.nodalDisplacements[index]?.uy) || 0);
    approxAbs(sumOutput.nodalDisplacements[index].ux, expectedUx, tol, `superposition: node ${index} ux`);
    approxAbs(sumOutput.nodalDisplacements[index].uy, expectedUy, tol, `superposition: node ${index} uy`);
  }
}

async function runAnalysis(loads, options = analysisOptions) {
  return analyzeDeformationModel({
    model: modelFor(loads),
    options
  });
}

async function main() {
  const activeA = surfaceLoads(['footing-a']);
  const activeB = surfaceLoads(['footing-b']);
  const activeAB = surfaceLoads(['footing-a', 'footing-b']);

  const meshA = await buildDeformationMesh(modelFor(activeA), modelFor(activeA).regions, analysisOptions);
  const meshB = await buildDeformationMesh(modelFor(activeB), modelFor(activeB).regions, analysisOptions);
  const meshAB = await buildDeformationMesh(modelFor(activeAB), modelFor(activeAB).regions, analysisOptions);
  compareMeshes(meshA, meshB, 'inactive-load mesh refinement');
  compareMeshes(meshA, meshAB, 'multi-load mesh refinement');

  const outputA = await runAnalysis(activeA);
  const outputB = await runAnalysis(activeB);
  const outputAB = await runAnalysis(activeAB);
  assert((outputA?.summaries?.maxSettlement || 0) > 0, 'single load A should settle the surface');
  assert((outputB?.summaries?.maxSettlement || 0) > 0, 'single load B should settle the surface');
  assert((outputAB?.summaries?.maxSettlement || 0) > 0, 'combined loads should settle the surface');
  compareMeshes(outputA.mesh, outputB.mesh, 'single-load analysis mesh');
  compareMeshes(outputA.mesh, outputAB.mesh, 'combined-load analysis mesh');
  compareSuperposition(outputAB, outputA, outputB);

  const totalLoadA = baseLoads[0].q * (baseLoads[0].xEnd - baseLoads[0].xStart) * analysisOptions.outOfPlaneLength;
  const totalModeA = surfaceLoads(['footing-a'], {
    'footing-a': {
      q: 0,
      loadMode: 'total',
      totalLoad: totalLoadA
    }
  });
  const outputTotalA = await runAnalysis(totalModeA, {
    ...analysisOptions,
    loadMode: 'total',
    totalLoad: 999999
  });
  compareSuperposition(outputTotalA, outputA, { nodalDisplacements: outputA.nodalDisplacements.map(() => ({ ux: 0, uy: 0 })) });
  approxRelative(
    outputTotalA.summaries.maxSettlement,
    outputA.summaries.maxSettlement,
    1e-5,
    1e-9,
    'per-load total mode should use the load-local totalLoad, not the global fallback'
  );

  const contribution = debugSurfaceLoadContributionForTest(
    [
      { xStart: 6, xEnd: 10, q: 10, active: true },
      { xStart: 8, xEnd: 12, q: 5, active: true },
      { xStart: 7, xEnd: 13, q: 100, active: false }
    ],
    7,
    13
  );
  approxAbs(contribution.width, 7, 1e-12, 'Bishop surcharge overlap width should sum active overlaps');
  approxAbs(contribution.force, 50, 1e-12, 'Bishop surcharge force should sum active pressures and ignore inactive loads');

  console.log('Multiple surface loads verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
