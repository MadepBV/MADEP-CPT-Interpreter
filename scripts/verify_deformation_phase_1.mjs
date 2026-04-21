import { analyzeDeformationModel, sampleDeformationState } from '../src/lib/cpt-app/deformation/solver.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approxRelative(left, right, relTol, message) {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1e-9);
  const relErr = Math.abs(left - right) / scale;
  assert(relErr <= relTol, `${message} (left ${left}, right ${right}, rel err ${relErr})`);
}

function nearestProfilePoint(profile, x) {
  return (profile || []).reduce((best, point) => {
    if (!best) return point;
    return Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best;
  }, null);
}

function baseModel(overrides = {}) {
  const material = {
    id: 'soil',
    label: 'soil',
    Emc: 25000,
    nu: 0.3,
    K0nc: 0.5,
    cEff: 5,
    phiEffDeg: 30,
    gamma: 18,
    gammaSat: 20,
    ...(overrides.material || {})
  };
  return {
    terrain: {
      vertices: [
        { x: 0, y: 0 },
        { x: 24, y: 0 }
      ]
    },
    analysisBottomY: -12,
    phreatic: {
      vertices: [
        { x: 0, y: -20 },
        { x: 24, y: -20 }
      ]
    },
    walls: [],
    regions: [
      {
        id: 'soil',
        polygon: [
          { x: 0, y: -12 },
          { x: 24, y: -12 },
          { x: 24, y: 0 },
          { x: 0, y: 0 }
        ],
        material
      }
    ],
    surfaceLoad: {
      xStart: 11,
      xEnd: 13,
      q: 80
    },
    seepage: overrides.seepage || { mesh: null, result: null },
    ...overrides
  };
}

async function runCase(name, fn) {
  await fn();
  console.log(`${name}: ok`);
}

await runCase('Case 1 pressure-mode deformation solves and settles beneath the load', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false
    }
  });

  assert(output?.mesh?.elements?.length > 0, 'pressure-mode solve should build a mechanical mesh');
  assert(output?.solver?.freeDofs > 0, 'pressure-mode solve should leave free displacement DOFs');
  assert((output?.summaries?.maxSettlement || 0) > 0, 'pressure-mode solve should produce positive settlement');
  assert((output?.summaries?.maxMcEta || 0) >= 0, 'pressure-mode solve should report MC utilization');

  const center = nearestProfilePoint(output?.terrainSettlementProfile, 12);
  const left = nearestProfilePoint(output?.terrainSettlementProfile, 1);
  const right = nearestProfilePoint(output?.terrainSettlementProfile, 23);
  assert(center && left && right, 'terrain settlement profile should include both the loaded area and far-field points');
  assert(
    center.settlement > left.settlement && center.settlement > right.settlement,
    'settlement should peak beneath the applied load rather than at the far boundaries'
  );

  const sampled = sampleDeformationState(output.mesh, output, 12, -0.5);
  assert(sampled && sampled.settlement > 0, 'line-probe deformation sampling should recover positive settlement beneath the load');
  assert(Number.isFinite(sampled?.mcEta), 'line-probe deformation sampling should expose a finite MC utilization value');
});

await runCase('Case 2 total-load mode matches the equivalent pressure solve', async () => {
  const pressure = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false
    }
  });

  const totalLoad = 80 * (13 - 11) * 10;
  const total = await analyzeDeformationModel({
    model: baseModel({ surfaceLoad: { xStart: 11, xEnd: 13, q: 0 } }),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'total',
      totalLoad,
      outOfPlaneLength: 10,
      useSeepagePorePressures: false
    }
  });

  approxRelative(
    total?.summaries?.maxSettlement || 0,
    pressure?.summaries?.maxSettlement || 0,
    0.04,
    'total-load mode should reproduce the equivalent pressure-mode settlement'
  );
  approxRelative(
    total?.summaries?.maxHorizontalDisplacement || 0,
    pressure?.summaries?.maxHorizontalDisplacement || 0,
    0.04,
    'total-load mode should reproduce the equivalent pressure-mode displacement field'
  );
});

await runCase('Case 3 capped nu and seepage fallback warnings still allow a deformation solve', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel({
      material: {
        nu: 0.495
      }
    }),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: true
    }
  });

  const warnings = output?.warnings || [];
  assert(
    warnings.some((warning) => warning.toLowerCase().includes('poisson ratio was capped')),
    'near-incompressible input should emit the Poisson-ratio cap warning'
  );
  assert(
    warnings.some((warning) => warning.toLowerCase().includes('hydrostatic phreatic line')),
    'requesting seepage pore pressures without a seepage result should emit the hydrostatic fallback warning'
  );
  assert((output?.summaries?.maxSettlement || 0) > 0, 'warning case should still produce a valid settlement result');
});

console.log('Deformation Phase 1 verification passed.');
