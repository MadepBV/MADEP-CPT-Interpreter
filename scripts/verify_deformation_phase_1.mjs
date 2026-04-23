import { analyzeDeformationModel, sampleDeformationState } from '../src/lib/cpt-app/deformation/solver.js';
import {
  createMCPlasticMaterial,
  createMCReducedStiffnessMaterial,
  createLinearElasticMaterial,
  extractStress2DFrom6,
  extractTangent2DFrom6,
  liftPlaneStrainStrainTo6,
  mohrCoulombIndicator3D,
  seedMaterialPointStateFromEffectiveStress6,
  seedMaterialPointStateFromInitialStress
} from '../src/lib/cpt-app/deformation/material-models.js';
import { planeStrainElasticMatrix, prepareMechanicalMaterial } from '../src/lib/cpt-app/deformation/material.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approxRelative(left, right, relTol, message) {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1e-9);
  const relErr = Math.abs(left - right) / scale;
  assert(relErr <= relTol, `${message} (left ${left}, right ${right}, rel err ${relErr})`);
}

function applyElasticMatrix(D, strain) {
  return {
    sxx: D[0][0] * strain.exx + D[0][1] * strain.eyy + D[0][2] * strain.gxy,
    syy: D[1][0] * strain.exx + D[1][1] * strain.eyy + D[1][2] * strain.gxy,
    txy: D[2][0] * strain.exx + D[2][1] * strain.eyy + D[2][2] * strain.gxy
  };
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
      q: 40
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

await runCase('Case 0 linear-elastic material points reproduce the old plane-strain elastic response', async () => {
  const prepared = prepareMechanicalMaterial(baseModel().regions[0].material);
  const material = createLinearElasticMaterial(prepared);
  const initialState = seedMaterialPointStateFromInitialStress({ sxx: 40, syy: 90, txy: 6 }, prepared);
  const strain = { exx: 2.5e-4, eyy: -8e-4, gxy: 1.5e-4 };
  const update = material.update({
    strainTrial6: liftPlaneStrainStrainTo6(strain),
    committedState: initialState,
    materialParameters: prepared
  });

  const D2d = planeStrainElasticMatrix(prepared.Emc, prepared.nu);
  const expectedIncrement = applyElasticMatrix(D2d, strain);
  const initialStressFe = extractStress2DFrom6(initialState.effectiveStress6);
  const finalStressFe = extractStress2DFrom6(update.stressTrial6);
  const tangent2d = extractTangent2DFrom6(update.tangent6x6);

  approxRelative(finalStressFe.sxx - initialStressFe.sxx, expectedIncrement.sxx, 1e-9, 'material-point update should reproduce the elastic sxx increment');
  approxRelative(finalStressFe.syy - initialStressFe.syy, expectedIncrement.syy, 1e-9, 'material-point update should reproduce the elastic syy increment');
  approxRelative(finalStressFe.txy - initialStressFe.txy, expectedIncrement.txy, 1e-9, 'material-point update should reproduce the elastic txy increment');
  approxRelative(tangent2d[0][0], D2d[0][0], 1e-12, 'extracted tangent xx-xx entry should match the classic plane-strain matrix');
  approxRelative(tangent2d[1][1], D2d[1][1], 1e-12, 'extracted tangent yy-yy entry should match the classic plane-strain matrix');
  approxRelative(tangent2d[2][2], D2d[2][2], 1e-12, 'extracted tangent xy-xy entry should match the classic plane-strain matrix');
  assert(update?.trialState?.currentlyMcActive === false, 'linear elastic material points should remain non-active in the constitutive state');
  assert(update?.trialState?.plasticStrain6?.every((value) => Math.abs(value) < 1e-12), 'linear elastic material points should not accumulate plastic strain');
  assert(update?.trialState?.totalStrain6?.[0] === strain.exx, 'material-point state should store the trial exx');
  assert(update?.diagnostics?.constitutiveModel === 'linear-elastic', 'linear elastic diagnostics should label the constitutive model');
});

await runCase('Case 0a full effective stress seeding preserves submerged out-of-plane stress', async () => {
  const prepared = prepareMechanicalMaterial(baseModel().regions[0].material);
  const sigmaXxTotal = 120;
  const sigmaYyTotal = 200;
  const porePressure = 60;
  const sigmaZzTotal = prepared.nu * (sigmaXxTotal + sigmaYyTotal);
  const effectiveStress6 = [
    -(sigmaXxTotal - porePressure),
    -(sigmaYyTotal - porePressure),
    -(sigmaZzTotal - porePressure),
    0,
    0,
    0
  ];
  const seeded = seedMaterialPointStateFromEffectiveStress6(effectiveStress6, prepared);
  const naive = seedMaterialPointStateFromInitialStress(
    {
      sxx: sigmaXxTotal - porePressure,
      syy: sigmaYyTotal - porePressure,
      txy: 0
    },
    prepared
  );

  approxRelative(
    seeded.effectiveStress6[2],
    effectiveStress6[2],
    1e-12,
    'full stress_6 seeding should preserve the supplied effective sigma_zz exactly'
  );
  assert(
    Math.abs(seeded.effectiveStress6[2] - naive.effectiveStress6[2]) > 1,
    'full stress_6 seeding should differ from the old naive effective-stress lift under submerged conditions'
  );
});

await runCase('Case 0b Stage 1 activation softens the tangent and records exceedance history', async () => {
  const prepared = prepareMechanicalMaterial({
    ...baseModel().regions[0].material,
    Emc: 18000,
    cEff: 1.5,
    phiEffDeg: 18,
    rShear: 0.05,
    yieldTolerance: 1e-6
  });
  const material = createMCReducedStiffnessMaterial(prepared);
  const initialState = seedMaterialPointStateFromInitialStress({ sxx: 10, syy: 20, txy: 0 }, prepared);
  const elasticD2d = planeStrainElasticMatrix(prepared.Emc, prepared.nu);
  const activated = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: 0, eyy: -0.04, gxy: 0.01 }),
    committedState: initialState,
    materialParameters: prepared
  });
  assert(activated?.trialState?.currentlyMcActive === true, 'the strong trial strain should activate the Stage 1 reduced-stiffness branch');
  assert(activated?.trialState?.hasEverExceededMc === true, 'Stage 1 should retain a diagnostic flag that the material point has exceeded MC');
  approxRelative(
    extractTangent2DFrom6(activated.tangent6x6)[2][2],
    elasticD2d[2][2] * prepared.rShear,
    1e-12,
    'the Stage 1 shear tangent should reduce in proportion to rShear once MC is exceeded'
  );
});

await runCase('Case 0c tension cut-off remains diagnostic and does not activate the Stage 1 shear branch', async () => {
  const prepared = prepareMechanicalMaterial({
    ...baseModel().regions[0].material,
    cEff: 0,
    phiEffDeg: 30,
    rShear: 0.05
  });
  const material = createMCReducedStiffnessMaterial(prepared);
  const initialState = seedMaterialPointStateFromEffectiveStress6([-25, -25, -15, 0, 0, 0], prepared);
  const elasticD2d = planeStrainElasticMatrix(prepared.Emc, prepared.nu);
  const update = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: 0.02, eyy: 0.02, gxy: 0 }),
    committedState: initialState,
    materialParameters: prepared
  });

  assert(update?.diagnostics?.activeYieldSurface === 'TENSION', 'a tensile trial state should be reported as a tension-cutoff diagnostic');
  assert(update?.trialState?.currentlyMcActive === false, 'tension cutoff should not route the material point into the Stage 1 reduced-shear branch');
  assert(update?.trialState?.hasEverExceededMc === false, 'tension-only states should not set the MC exceedance history flag');
  approxRelative(
    extractTangent2DFrom6(update.tangent6x6)[2][2],
    elasticD2d[2][2],
    1e-12,
    'tension-cutoff diagnostics should keep the elastic tangent in Stage 1'
  );
});

await runCase('Case 0d Stage 2 exact MC return accumulates plastic strain and returns to the exact surface', async () => {
  const prepared = prepareMechanicalMaterial({
    ...baseModel().regions[0].material,
    Emc: 18000,
    cEff: 1.5,
    phiEffDeg: 18,
    psiEffDeg: 5,
    yieldTolerance: 1e-6
  });
  const material = createMCPlasticMaterial(prepared);
  const initialState = seedMaterialPointStateFromInitialStress({ sxx: 15, syy: 30, txy: 0 }, prepared);
  const update = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: 0, eyy: -0.03, gxy: 0.008 }),
    committedState: initialState,
    materialParameters: prepared
  });

  assert(update?.diagnostics?.constitutiveModel === 'mc-plastic', 'Stage 2 material diagnostics should label the constitutive model');
  assert((update?.diagnostics?.localIterations || 0) > 0, 'Stage 2 return mapping should take one or more local corrector iterations');
  assert((update?.trialState?.accumulatedPlasticStrain || 0) > 0, 'Stage 2 material points should accumulate equivalent plastic strain after yield');
  assert(
    Math.abs(Number(update?.diagnostics?.fMcFinal) || 0) <= Math.max(Number(update?.diagnostics?.yieldTolerance) || 0, 1e-8),
    `Stage 2 exact return mapping should drive the exact MC residual back inside tolerance (got ${update?.diagnostics?.fMcFinal})`
  );
  assert(
    (update?.trialState?.plasticStrain6 || []).some((value) => Math.abs(Number(value) || 0) > 1e-10),
    'Stage 2 material points should store a non-zero plastic strain increment after yield'
  );
  assert(update?.trialState?.currentlyMcActive === true, 'Stage 2 should mark the yielded trial state as MC-active');
  assert(
    ['MC_FACE', 'MC_EDGE', 'MC_APEX'].includes(update?.trialState?.activeYieldSurface),
    `Stage 2 exact return should report an exact MC active set label (got ${update?.trialState?.activeYieldSurface})`
  );
  approxRelative(
    Number(update?.diagnostics?.etaMcFinal) || 0,
    1,
    1e-9,
    'Stage 2 exact return should leave eta_MC at unity on the accepted plastic state'
  );
});

await runCase('Case 0e Stage 2 keeps tension cut-off diagnostic-only until the dedicated cutoff stage', async () => {
  const prepared = prepareMechanicalMaterial({
    ...baseModel().regions[0].material,
    cEff: 0,
    phiEffDeg: 30,
    sigmaTAllow: 0
  });
  const material = createMCPlasticMaterial(prepared);
  const initialState = seedMaterialPointStateFromEffectiveStress6([-25, -25, -15, 0, 0, 0], prepared);
  const update = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: 0.02, eyy: 0.02, gxy: 0 }),
    committedState: initialState,
    materialParameters: prepared
  });

  assert(update?.trialState?.currentlyMcActive === false, 'Stage 2 should not route pure tension-cutoff states into the MC shear return map');
  assert(update?.trialState?.activeYieldSurface === 'TENSION', 'Stage 2 should preserve the tension-cutoff diagnostic surface');
  assert((update?.trialState?.accumulatedPlasticStrain || 0) === 0, 'Stage 2 should not accumulate plastic strain for tension-diagnostic-only states');
});

await runCase('Case 0ea inadmissible initial stress is audited without being counted as plastic history', async () => {
  const prepared = prepareMechanicalMaterial({
    ...baseModel().regions[0].material,
    Emc: 18000,
    cEff: 2,
    phiEffDeg: 20,
    K0nc: 0.35,
    yieldTolerance: 1e-6
  });
  const initialState = seedMaterialPointStateFromInitialStress({ sxx: 15, syy: 60, txy: 0 }, prepared);

  assert(initialState?.initialStateAdmissible === false, 'inadmissible reference stresses should be flagged explicitly at seeding time');
  assert((initialState?.initialEtaMc || 0) > 1, 'inadmissible reference stresses should carry their exact MC utilization separately');
  assert(initialState?.activeYieldSurface === 'NONE', 'reference-state admissibility should not be stored as an active plastic surface');
  assert(initialState?.hasEverExceededMc === false, 'reference-state inadmissibility should not be counted as plastic-yield history');
});

await runCase('Case 0f Stage 2 unloads elastically around a plastic strain state', async () => {
  const prepared = prepareMechanicalMaterial({
    ...baseModel().regions[0].material,
    Emc: 18000,
    cEff: 1.5,
    phiEffDeg: 18,
    psiEffDeg: 5,
    yieldTolerance: 1e-6
  });
  const material = createMCPlasticMaterial(prepared);
  const initialState = seedMaterialPointStateFromInitialStress({ sxx: 15, syy: 30, txy: 0 }, prepared);
  const plasticLoading = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: 0, eyy: -0.03, gxy: 0.008 }),
    committedState: initialState,
    materialParameters: prepared
  });
  const unloaded = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: 0, eyy: -0.015, gxy: 0.002 }),
    committedState: plasticLoading.trialState,
    materialParameters: prepared
  });
  const elasticD2d = planeStrainElasticMatrix(prepared.Emc, prepared.nu);

  assert((plasticLoading?.trialState?.accumulatedPlasticStrain || 0) > 0, 'Stage 2 unload/reload test should first create a plastic strain state');
  assert((unloaded?.diagnostics?.localIterations || 0) === 0, 'elastic unloading from a plastic state should not trigger another local return map');
  assert(unloaded?.trialState?.currentlyMcActive === false, 'elastic unloading should leave the Stage 2 material point off the active plastic surface');
  approxRelative(
    extractTangent2DFrom6(unloaded.tangent6x6)[2][2],
    elasticD2d[2][2],
    1e-12,
    'elastic unloading from a plastic state should recover the elastic tangent'
  );
  approxRelative(
    unloaded?.trialState?.accumulatedPlasticStrain || 0,
    plasticLoading?.trialState?.accumulatedPlasticStrain || 0,
    1e-12,
    'elastic unloading should preserve the committed equivalent plastic strain'
  );
});

await runCase('Case 1 pressure-mode Stage 1 deformation solves and settles beneath the load', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
    }
  });

  assert(output?.mesh?.elements?.length > 0, 'pressure-mode solve should build a mechanical mesh');
  assert(output?.solver?.freeDofs > 0, 'pressure-mode solve should leave free displacement DOFs');
  assert(output?.solver?.constitutiveModel === 'mc-reduced-stiffness-material-point', 'pressure-mode solve should report the Stage 1 constitutive integration path by default');
  assert(output?.solver?.materialPointCount === output?.mesh?.elements?.length, 'pressure-mode solve should build one material point per T3 element');
  assert((output?.solver?.acceptedLoadSteps || 0) >= 1, 'pressure-mode solve should finish through one or more accepted nonlinear load steps');
  assert((output?.summaries?.maxSettlement || 0) > 0, 'pressure-mode solve should produce positive settlement');
  assert((output?.summaries?.maxMcEta || 0) >= 0, 'pressure-mode solve should report MC utilization');
  assert(output?.elementResults?.every((item) => item?.materialState && item?.materialDiagnostics), 'pressure-mode solve should carry material-point snapshots and diagnostics into postprocessing');

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
  assert(
    typeof sampled?.mcEta === 'number' && !Number.isNaN(sampled.mcEta),
    'line-probe deformation sampling should expose a valid MC utilization or tension-cutoff diagnostic value'
  );
});

await runCase('Case 1a Stage 2 pressure-mode deformation solves through the elastoplastic path in the elastic range', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.3,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialLoadStep: 1,
      maxLoadSteps: 8
    }
  });

  assert(output?.solver?.constitutiveModel === 'mc-plastic-material-point', 'Stage 2 pressure-mode solve should report the elastoplastic constitutive path');
  assert((output?.solver?.acceptedLoadSteps || 0) === 1, 'Stage 2 elastic-range solve should accept the full load in one step');
  assert((output?.summaries?.maxSettlement || 0) > 0, 'Stage 2 elastic-range solve should still produce settlement');
  assert((output?.solver?.peakActiveMcElements || 0) === 0, 'Stage 2 elastic-range solve should stay below the MC surface');
  assert(
    !(output?.elementResults || []).some((item) => (Number(item?.materialState?.accumulatedPlasticStrain) || 0) > 0),
    'Stage 2 elastic-range solve should not accumulate plastic strain when the trial state stays inside the surface'
  );
});

await runCase('Case 1b linear-elastic comparison path converges in one full Newton step', async () => {
  const elastic = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  assert(elastic?.solver?.constitutiveModel === 'linear-elastic-material-point', 'elastic comparison path should report the linear-elastic constitutive model');
  assert((elastic?.solver?.acceptedLoadSteps || 0) === 1, 'linear-elastic path should accept the full load in one load step');
  assert((elastic?.solver?.rejectedLoadSteps || 0) === 0, 'linear-elastic path should not need cutbacks');
  assert((elastic?.solver?.nonlinearIterations || 0) <= 2, 'linear-elastic path should converge in one solve plus at most one refreshed equilibrium check');
  assert((elastic?.solver?.loadFactorCommitted || 0) === 1, 'linear-elastic path should commit the full load factor');
  assert((elastic?.solver?.relativeResidualNorm || 0) <= 1.5e-5, `linear-elastic path should leave a small final relative residual (got ${elastic?.solver?.relativeResidualNorm})`);
});

await runCase('Case 1c Stage 2 plastic footing departs materially from the elastic comparison', async () => {
  const model = baseModel({
    material: {
      Emc: 25000,
      nu: 0.3,
      K0nc: 0.5,
      cEff: 5,
      phiEffDeg: 30,
      psiEffDeg: 5,
      gamma: 18,
      gammaSat: 20
    },
    surfaceLoad: {
      xStart: 11,
      xEnd: 13,
      q: 160
    }
  });

  const elastic = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.4,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  const plastic = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.4,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      nonlinearMaxIterations: 30,
      maxLoadSteps: 20,
      initialLoadStep: 0.25,
      minLoadStep: 0.001
    }
  });

  const plasticElementCount = (plastic?.elementResults || []).filter((item) => (Number(item?.materialState?.accumulatedPlasticStrain) || 0) > 0).length;

  assert((plastic?.solver?.peakActiveMcElements || 0) > 0, 'Stage 2 plastic footing case should activate plastic zones');
  assert(plasticElementCount > 0, 'Stage 2 plastic footing case should accumulate plastic strain in one or more elements');
  assert((plastic?.summaries?.maxEquivalentPlasticStrain || 0) > 0, 'Stage 2 plastic footing case should report non-zero accumulated equivalent plastic strain');
  assert((plastic?.solver?.acceptedLoadSteps || 0) > 1, 'Stage 2 plastic footing case should require multiple accepted load steps once yielding starts');
  assert((plastic?.solver?.loadStepHistory || []).some((step) => step?.accepted), 'Stage 2 plastic footing case should record accepted load steps');
  assert((plastic?.solver?.residualHistory || []).length >= (plastic?.solver?.nonlinearIterations || 0), 'Stage 2 plastic footing case should retain residual history through the nonlinear iterations');
  assert(
    Math.abs((plastic?.summaries?.maxSettlement || 0) - (elastic?.summaries?.maxSettlement || 0)) > 1e-4,
    `Stage 2 plastic footing case should differ materially from the elastic settlement response once yielding activates (got ${plastic?.summaries?.maxSettlement} vs ${elastic?.summaries?.maxSettlement})`
  );
});

await runCase('Case 1d Stage 2 plastic slope converges with yielding and accumulated plastic strain', async () => {
  const model = slopedModel({
    material: {
      Emc: 22000,
      nu: 0.3,
      K0nc: 0.8,
      cEff: 8,
      phiEffDeg: 32,
      psiEffDeg: 2,
      gamma: 18,
      gammaSat: 20
    },
    surfaceLoad: {
      xStart: 6,
      xEnd: 8,
      q: 70
    }
  });

  const elastic = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.45,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  const plastic = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.45,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      nonlinearMaxIterations: 40,
      maxLoadSteps: 80,
      initialLoadStep: 0.1,
      minLoadStep: 0.0005
    }
  });

  assert((plastic?.solver?.loadFactorCommitted || 0) === 1, 'Stage 2 plastic slope benchmark should converge the full target load');
  assert((plastic?.solver?.peakActiveMcElements || 0) > 0, 'Stage 2 plastic slope benchmark should activate one or more yielded zones');
  assert((plastic?.summaries?.maxEquivalentPlasticStrain || 0) > 0, 'Stage 2 plastic slope benchmark should accumulate non-zero equivalent plastic strain');
  assert((plastic?.solver?.acceptedLoadSteps || 0) > 1, 'Stage 2 plastic slope benchmark should use multiple nonlinear load steps once yielding starts');
  assert(
    Math.abs((plastic?.summaries?.maxSettlement || 0) - (elastic?.summaries?.maxSettlement || 0)) > 1e-5,
    'Stage 2 plastic slope benchmark should not collapse back to the elastic settlement response once plasticity activates'
  );
});

await runCase('Case 1e Stage 2 returns a flagged near-failure state when the nonlinear solve cannot fully converge', async () => {
  const model = slopedModel({
    material: {
      Emc: 22000,
      nu: 0.3,
      K0nc: 0.8,
      cEff: 8,
      phiEffDeg: 32,
      psiEffDeg: 2,
      gamma: 18,
      gammaSat: 20
    },
    surfaceLoad: {
      xStart: 6,
      xEnd: 8,
      q: 95
    }
  });

  const output = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.45,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      nonlinearMaxIterations: 40,
      maxLoadSteps: 80,
      initialLoadStep: 0.1,
      minLoadStep: 0.0005
    }
  });

  assert(output?.solver?.convergenceState === 'partial', 'a near-failure Stage 2 slope case should return a partial flagged result rather than throwing');
  assert((output?.solver?.displayedLoadFactor || 0) >= (output?.solver?.loadFactorCommitted || 0), 'the displayed near-failure state should be at or beyond the last fully converged load factor');
  assert((output?.summaries?.maxEquivalentPlasticStrain || 0) > 0, 'the near-failure Stage 2 result should still carry accumulated plastic strain');
  const maxDisplayedPlasticStrain = Math.max(
    0,
    ...(output?.elementResults || []).map((item) => Number(item?.materialState?.accumulatedPlasticStrain) || 0)
  );
  const maxCommittedPlasticStrain = Math.max(
    0,
    ...(output?.elementResults || []).map((item) => Number(item?.committedMaterialState?.accumulatedPlasticStrain) || 0)
  );
  assert(
    maxDisplayedPlasticStrain >= maxCommittedPlasticStrain,
    'the displayed Stage 2 near-failure state should not plot less accumulated plastic strain than the last committed state'
  );
  assert(
    maxDisplayedPlasticStrain > maxCommittedPlasticStrain + 1e-12,
    'the plotted Stage 2 near-failure material state should reflect the displayed state beyond the last committed state'
  );
  assert((output?.warnings || []).some((warning) => String(warning).includes('non-converged near-failure state')), 'the returned near-failure Stage 2 result should be clearly flagged in the warnings');
});

await runCase('Case 2 total-load mode matches the equivalent pressure solve', async () => {
  const pressure = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
    }
  });

  const totalLoad = 40 * (13 - 11) * 10;
  const total = await analyzeDeformationModel({
    model: baseModel({ surfaceLoad: { xStart: 11, xEnd: 13, q: 0 } }),
    options: {
      meshTargetArea: 0.2,
      loadMode: 'total',
      totalLoad,
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
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
  const lowQ = 0.1;
  const lowModel = baseModel({
    surfaceLoad: { xStart: 11, xEnd: 13, q: lowQ }
  });
  const lowLoad = await analyzeDeformationModel({
    model: lowModel,
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
    }
  });
  const lowElastic = await analyzeDeformationModel({
    model: lowModel,
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  assert((lowLoad?.summaries?.maxSettlement || 0) > 0, 'low-pressure case should still produce a small positive settlement');
  assert((lowLoad?.solver?.peakActiveMcElements || 0) === 0, 'low-pressure case should stay below the Stage 1 MC-active threshold');
  approxRelative(
    lowLoad?.summaries?.maxSettlement || 0,
    lowElastic?.summaries?.maxSettlement || 0,
    0.03,
    'low-pressure settlement should stay close to the elastic fallback'
  );
});

await runCase('Case 2c Stage 1 activates reduced-stiffness zones and softens relative to the elastic fallback', async () => {
  const model = baseModel({
    material: {
      Emc: 18000,
      cEff: 1.5,
      phiEffDeg: 18
    },
    surfaceLoad: {
      xStart: 10.5,
      xEnd: 13.5,
      q: 350
    }
  });

  const stage1 = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.22,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness',
      nonlinearMaxIterations: 40
    }
  });

  const elastic = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.22,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  assert((stage1?.solver?.peakActiveMcElements || 0) > 0, 'Stage 1 should activate one or more reduced-stiffness elements under the heavy load case');
  assert((stage1?.summaries?.activeMcElementCount || 0) > 0, 'Stage 1 summaries should report active reduced-stiffness elements');
  assert(
    (stage1?.summaries?.maxSettlement || 0) > (elastic?.summaries?.maxSettlement || 0) * 1.01,
    `Stage 1 should soften the response relative to the elastic fallback (got ${stage1?.summaries?.maxSettlement} vs ${elastic?.summaries?.maxSettlement})`
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
      useSeepagePorePressures: true,
      constitutiveModel: 'mc-reduced-stiffness'
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
  assert(output?.solver?.initialStressMode === 'gravity-step-k0nc', 'warning case should still use the K0-controlled geostatic initialization');
});

await runCase('Case 2d Stage 2 low-pressure response stays close to the elastic range', async () => {
  const model = baseModel({
    surfaceLoad: { xStart: 11, xEnd: 13, q: 0.1 }
  });
  const stage1 = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
    }
  });
  const plastic = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic'
    }
  });

  const stage1Settlement = stage1?.summaries?.maxSettlement || 0;
  const plasticSettlement = plastic?.summaries?.maxSettlement || 0;
  assert(plasticSettlement > 0, 'Stage 2 low-pressure case should still produce a positive settlement');
  approxRelative(
    plasticSettlement,
    stage1Settlement,
    0.1,
    'Stage 2 low-pressure response should stay close to the Stage 1 elastic-like result when no plasticity activates'
  );
  assert((plastic?.solver?.peakActiveMcElements || 0) === 0, 'Stage 2 low-pressure case should not activate plastic zones');
});

await runCase('Case 3b submerged initialization now carries K0nc-controlled sigma_zz rather than a nu-based lift', async () => {
  const model = baseModel({
    phreatic: {
      vertices: [
        { x: 0, y: 0.5 },
        { x: 24, y: 0.5 }
      ]
    },
    surfaceLoad: { xStart: 11, xEnd: 13, q: 40 }
  });
  const output = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  const submergedElement = (output?.elementResults || [])
    .filter((item) => (Number(item?.porePressure) || 0) > 1 && Number(item?.centroid?.y) < -1)
    .sort((left, right) => Number(right?.porePressure || 0) - Number(left?.porePressure || 0))[0];

  assert(submergedElement, 'submerged case should include at least one element below the phreatic line');
  const prepared = prepareMechanicalMaterial(model.regions[0].material);
  const expectedSigmaZzEff = prepared.K0nc * (Number(submergedElement?.initialEffectiveStress?.syy) || 0);
  const actualSigmaZzEff = Number(submergedElement?.initialEffectiveStress3D?.szz || 0);
  const oldNuLiftSigmaZzEff =
    prepared.nu * (
      (Number(submergedElement?.initialEffectiveStress?.sxx) || 0) +
      (Number(submergedElement?.initialEffectiveStress?.syy) || 0)
    );

  approxRelative(
    actualSigmaZzEff,
    expectedSigmaZzEff,
    1e-6,
    'submerged initialization should set effective sigma_zz from K0nc-controlled confinement'
  );
  assert(
    Math.abs(actualSigmaZzEff - oldNuLiftSigmaZzEff) > 1,
    'submerged sigma_zz should differ measurably from the old nu-based lift'
  );
});

await runCase('Case 3c K0nc controls the initial horizontal confinement even when nu implies a different elastic ratio', async () => {
  const model = baseModel({
    material: {
      nu: 0.22,
      K0nc: 0.68
    },
    surfaceLoad: { xStart: 11, xEnd: 13, q: 40 }
  });
  const output = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  const target = prepareMechanicalMaterial(model.regions[0].material).K0nc;
  const nuElasticRatio = prepareMechanicalMaterial(model.regions[0].material).nu / (1 - prepareMechanicalMaterial(model.regions[0].material).nu);
  const deepElement = (output?.elementResults || [])
    .filter((item) => Number(item?.centroid?.y) < -3)
    .sort((left, right) => Math.abs(Number(left?.centroid?.x || 0) - 12) - Math.abs(Number(right?.centroid?.x || 0) - 12))[0];

  assert(deepElement, 'K0-controlled initialization case should include a representative deep element');
  const ratioX = (Number(deepElement?.initialEffectiveStress?.sxx) || 0) / Math.max(Number(deepElement?.initialEffectiveStress?.syy) || 0, 1e-9);
  const ratioZ = (Number(deepElement?.initialEffectiveStress3D?.szz) || 0) / Math.max(Number(deepElement?.initialEffectiveStress?.syy) || 0, 1e-9);

  approxRelative(ratioX, target, 0.03, 'initial effective sigma_xx / sigma_yy should follow K0nc rather than elastic nu');
  approxRelative(ratioZ, target, 0.03, 'initial effective sigma_zz / sigma_yy should follow K0nc rather than elastic nu');
  assert(
    Math.abs(ratioX - nuElasticRatio) > 0.1,
    'initial confinement ratio should clearly differ from the old nu / (1 - nu) elastic gravity ratio in this mismatch case'
  );
});

await runCase('Case 3d weak low-load soil should not start in blanket MC failure when K0nc provides the initial confinement', async () => {
  const model = baseModel({
    material: {
      Emc: 2541,
      nu: 0.3,
      K0nc: 0.66,
      cEff: 2,
      phiEffDeg: 20,
      gamma: 16,
      gammaSat: 16
    },
    surfaceLoad: { xStart: 11, xEnd: 13, q: 30 }
  });
  const output = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
    }
  });

  const prepared = prepareMechanicalMaterial(model.regions[0].material);
  const initialYielded = (output?.elementResults || []).reduce((count, item) => {
    const mc = mohrCoulombIndicator3D(item?.referenceMaterialState?.effectiveStress6, prepared);
    return count + (mc?.state === 'mc-yield' ? 1 : 0);
  }, 0);

  assert(initialYielded === 0, `weak low-load case should not already violate MC in the initial state (got ${initialYielded} yielded elements)`);
  assert(
    (output?.solver?.peakActiveMcElements || 0) < Math.max(1, Math.floor((output?.mesh?.elements?.length || 0) * 0.5)),
    'weak low-load case should not activate most of the mesh under the corrected K0-controlled initialization'
  );
  assert(
    (output?.summaries?.maxSettlement || 0) < 1,
    `weak low-load case should not produce collapse-scale settlements under 30 kPa (got ${output?.summaries?.maxSettlement} m)`
  );
});

await runCase('Case 4 slope geometry uses gravity initialization and develops initial shear stress', async () => {
  const output = await analyzeDeformationModel({
    model: slopedModel(),
    options: {
      meshTargetArea: 0.3,
      loadMode: 'pressure',
      outOfPlaneLength: 12,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    }
  });

  assert(output?.solver?.initialStressMode === 'gravity-step-k0nc', 'slope case should use the K0-controlled geostatic initialization');
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
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
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
    Math.abs(sampled.sigmaYyEff - sampled.sigmaYyEffInit) > 1,
    `final effective vertical stress should reflect a non-trivial load-induced change (got ${sampled.sigmaYyEff} vs ${sampled.sigmaYyEffInit})`
  );
  assert(
    Math.abs(sampled.sigmaYyTotal - sampled.sigmaYyTotalInit) > 1,
    `final total vertical stress should reflect a non-trivial load-induced change (got ${sampled.sigmaYyTotal} vs ${sampled.sigmaYyTotalInit})`
  );
});

console.log('Deformation Phase 1 verification passed.');
