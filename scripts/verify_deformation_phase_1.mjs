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

function slopedModel(overrides = {}) {
  const material = {
    id: 'slope-soil',
    label: 'slope-soil',
    Emc: 22000,
    nu: 0.3,
    K0nc: 0.55,
    cEff: 6,
    phiEffDeg: 28,
    gamma: 18,
    gammaSat: 20,
    ...(overrides.material || {})
  };
  return {
    terrain: {
      vertices: [
        { x: 0, y: 1.5 },
        { x: 8, y: 1.5 },
        { x: 24, y: -6.5 }
      ]
    },
    analysisBottomY: -16.5,
    phreatic: {
      vertices: [
        { x: 0, y: -20 },
        { x: 24, y: -20 }
      ]
    },
    walls: [],
    regions: [
      {
        id: 'slope-soil',
        polygon: [
          { x: 0, y: -16.5 },
          { x: 24, y: -16.5 },
          { x: 24, y: -6.5 },
          { x: 8, y: 1.5 },
          { x: 0, y: 1.5 }
        ],
        material
      }
    ],
    surfaceLoad: {
      xStart: 6,
      xEnd: 8,
      q: 120
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

await runCase('Case 2b low pressure still converges and stays in the linear range', async () => {
  const highLoad = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false
    }
  });

  const lowQ = 0.1;
  const lowLoad = await analyzeDeformationModel({
    model: baseModel({
      surfaceLoad: { xStart: 11, xEnd: 13, q: lowQ }
    }),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false
    }
  });

  assert((lowLoad?.summaries?.maxSettlement || 0) > 0, 'low-pressure case should still produce a small positive settlement');
  approxRelative(
    lowLoad?.summaries?.maxSettlement || 0,
    (highLoad?.summaries?.maxSettlement || 0) * (lowQ / 80),
    0.08,
    'low-pressure settlement should stay close to linear-elastic scaling'
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
  assert(output?.solver?.initialStressMode === 'gravity-step', 'warning case should still use the geostatic gravity-step initialization');
});

await runCase('Case 4 slope geometry uses gravity initialization and develops initial shear stress', async () => {
  const output = await analyzeDeformationModel({
    model: slopedModel(),
    options: {
      meshTargetArea: 0.3,
      loadMode: 'pressure',
      outOfPlaneLength: 12,
      useSeepagePorePressures: false
    }
  });

  assert(output?.solver?.initialStressMode === 'gravity-step', 'slope case should use the geostatic gravity-step initialization');
  const warnings = output?.warnings || [];
  assert(
    !warnings.some((warning) => warning.toLowerCase().includes('flat-ground k0 initialization')),
    'successful gravity initialization should not emit the old flat-ground K0 warning'
  );
  const maxInitialShear = (output?.elementResults || []).reduce(
    (max, item) => Math.max(max, Math.abs(Number(item?.initialEffectiveStress?.txy) || 0)),
    0
  );
  assert(maxInitialShear > 0.1, `slope gravity initialization should develop non-zero initial shear stress (got ${maxInitialShear})`);
});

await runCase('Case 5 deformation sampling exposes total/effective stresses and shear stress', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel({
      phreatic: {
        vertices: [
          { x: 0, y: -0.4 },
          { x: 24, y: -0.4 }
        ]
      }
    }),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false
    }
  });

  const sampled = sampleDeformationState(output.mesh, output, 12, -2);
  assert(sampled, 'stress-view case should sample a valid point inside the deformation mesh');
  assert(Number.isFinite(sampled?.uTotal), 'stress-view sampling should expose total displacement magnitude');
  assert(Number.isFinite(sampled?.sigmaYyEffInit), 'stress-view sampling should expose initial effective vertical stress');
  assert(Number.isFinite(sampled?.sigmaYyEff), 'stress-view sampling should expose effective vertical stress');
  assert(Number.isFinite(sampled?.sigmaYyTotalInit), 'stress-view sampling should expose initial total vertical stress');
  assert(Number.isFinite(sampled?.sigmaYyTotal), 'stress-view sampling should expose total vertical stress');
  assert(Number.isFinite(sampled?.sigmaXxEffInit), 'stress-view sampling should expose initial effective horizontal stress');
  assert(Number.isFinite(sampled?.sigmaXxEff), 'stress-view sampling should expose effective horizontal stress');
  assert(Number.isFinite(sampled?.sigmaXxTotalInit), 'stress-view sampling should expose initial total horizontal stress');
  assert(Number.isFinite(sampled?.sigmaXxTotal), 'stress-view sampling should expose total horizontal stress');
  assert(Number.isFinite(sampled?.tauXy), 'stress-view sampling should expose shear stress');
  assert(
    sampled.sigmaYyTotal > sampled.sigmaYyEff + 5,
    `total vertical stress should exceed effective vertical stress below the phreatic line (got ${sampled.sigmaYyTotal} vs ${sampled.sigmaYyEff})`
  );
  assert(
    sampled.sigmaXxTotal > sampled.sigmaXxEff + 5,
    `total horizontal stress should exceed effective horizontal stress below the phreatic line (got ${sampled.sigmaXxTotal} vs ${sampled.sigmaXxEff})`
  );
  assert(
    sampled.sigmaYyEff > sampled.sigmaYyEffInit + 1,
    `final effective vertical stress should include the load increment (got ${sampled.sigmaYyEff} vs ${sampled.sigmaYyEffInit})`
  );
  assert(
    sampled.sigmaYyTotal > sampled.sigmaYyTotalInit + 1,
    `final total vertical stress should include the load increment (got ${sampled.sigmaYyTotal} vs ${sampled.sigmaYyTotalInit})`
  );
});

console.log('Deformation Phase 1 verification passed.');
