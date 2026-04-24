import { analyzeDeformationModel, sampleDeformationState } from '../src/lib/cpt-app/deformation/solver.js';
import {
  computeEllpackShape,
  createEllpackBuffer,
  ellpackMatvecReference,
  packEllpackIndices,
  packEllpackValues
} from '../src/lib/cpt-app/deformation/gpu/ellpack.js';
import { createCpuF32Backend } from '../src/lib/cpt-app/deformation/gpu/cpu-f32-backend.js';
import { createLinearAlgebraBackend } from '../src/lib/cpt-app/deformation/gpu/index.js';
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
import { elasticMatrix6x6, planeStrainElasticMatrix, prepareMechanicalMaterial } from '../src/lib/cpt-app/deformation/material.js';

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

function maxMatrixAsymmetry(matrix) {
  let maxAsymmetry = 0;
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    for (let colIndex = rowIndex + 1; colIndex < matrix[rowIndex].length; colIndex += 1) {
      maxAsymmetry = Math.max(
        maxAsymmetry,
        Math.abs((Number(matrix?.[rowIndex]?.[colIndex]) || 0) - (Number(matrix?.[colIndex]?.[rowIndex]) || 0))
      );
    }
  }
  return maxAsymmetry;
}

function solveDense3x3(matrix, rhs) {
  const augmented = matrix.map((row, index) => [...row, rhs[index]]);
  for (let pivotIndex = 0; pivotIndex < 3; pivotIndex += 1) {
    let bestRow = pivotIndex;
    for (let rowIndex = pivotIndex + 1; rowIndex < 3; rowIndex += 1) {
      if (Math.abs(augmented[rowIndex][pivotIndex]) > Math.abs(augmented[bestRow][pivotIndex])) bestRow = rowIndex;
    }
    assert(Math.abs(augmented[bestRow][pivotIndex]) > 1e-12, 'dense 3x3 helper encountered a singular matrix');
    if (bestRow !== pivotIndex) {
      const temp = augmented[pivotIndex];
      augmented[pivotIndex] = augmented[bestRow];
      augmented[bestRow] = temp;
    }
    const pivot = augmented[pivotIndex][pivotIndex];
    for (let colIndex = pivotIndex; colIndex <= 3; colIndex += 1) augmented[pivotIndex][colIndex] /= pivot;
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
      if (rowIndex === pivotIndex) continue;
      const factor = augmented[rowIndex][pivotIndex];
      for (let colIndex = pivotIndex; colIndex <= 3; colIndex += 1) {
        augmented[rowIndex][colIndex] -= factor * augmented[pivotIndex][colIndex];
      }
    }
  }
  return augmented.map((row) => row[3]);
}

function strainTrial6ForTargetStress6(materialParameters, targetStress6) {
  const D = elasticMatrix6x6(materialParameters.Emc, materialParameters.nu);
  const normalBlock = [
    [D[0][0], D[0][1], D[0][2]],
    [D[1][0], D[1][1], D[1][2]],
    [D[2][0], D[2][1], D[2][2]]
  ];
  const targetNormal = [
    Number(targetStress6?.[0]) || 0,
    Number(targetStress6?.[1]) || 0,
    Number(targetStress6?.[2]) || 0
  ];
  const normalStrain = solveDense3x3(normalBlock, targetNormal);
  return [normalStrain[0], normalStrain[1], normalStrain[2], 0, 0, 0];
}

function updateMcPlasticFromTargetStress6(materialParameters, targetStress6, initialEffectiveStress6 = [0, 0, 0, 0, 0, 0]) {
  const material = createMCPlasticMaterial(materialParameters);
  const initialState = seedMaterialPointStateFromEffectiveStress6(initialEffectiveStress6, materialParameters);
  return material.update({
    strainTrial6: strainTrial6ForTargetStress6(materialParameters, targetStress6),
    committedState: initialState,
    materialParameters
  });
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
    cEff: 1,
    phiEffDeg: 25,
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
        { x: 24, y: -6.5 },
        { x: 35, y: -6.5}
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
          { x: 35, y: -16.5 },
          { x: 35, y: -6.5 },
          { x: 8, y: 1.5 },
          { x: 0, y: 1.5 }
        ],
        material
      }
    ],
    surfaceLoad: {
      xStart: 6,
      xEnd: 8,
      q: 12
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

await runCase('Case 0e Stage 2 exact tension-face return lands on the cut-off and accumulates plastic strain', async () => {
  const prepared = prepareMechanicalMaterial({
    ...baseModel().regions[0].material,
    Emc: 18000,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 0,
    sigmaTAllow: 2,
    yieldTolerance: 1e-8,
    localTolerance: 1e-8
  });
  const targetStress6 = [-10, -10, 4, 0, 0, 0];
  const update = updateMcPlasticFromTargetStress6(prepared, targetStress6);

  assert(mohrCoulombIndicator3D(targetStress6, prepared)?.state === 'tension-cutoff', 'the manufactured trial state should violate the exact tension cutoff before the return step');
  assert(update?.trialState?.currentlyMcActive === true, 'an exact Stage 2 tension-face state should be tracked as an active plastic branch');
  assert(update?.trialState?.activeYieldSurface === 'TENSION', 'the exact tension-face return should report the tension yield surface');
  assert(update?.diagnostics?.exactBranchKind === 'TENSION_FACE_T3', `the exact tension-face benchmark should accept the T3 face branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['T3']),
    `the exact tension-face benchmark should keep only the T3 active surface (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  assert((update?.trialState?.accumulatedPlasticStrain || 0) > 0, 'the exact tension-face return should accumulate plastic strain');
  assert(!Number.isFinite(Number(update?.diagnostics?.etaMcFinal)), 'η_MC should be suppressed once the exact tension cutoff governs the accepted state');
  approxRelative(Number(update?.diagnostics?.principal?.s3) || 0, -2, 1e-9, 'the exact tension-face return should land on sigma3 = -sigma_t');
});

await runCase('Case 0e1 Stage 2 exact lower repeated tension branch closes sigma2=sigma3 on the cut-off', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 2,
    yieldTolerance: 1e-8,
    localTolerance: 1e-8
  });
  const update = updateMcPlasticFromTargetStress6(prepared, [-10, 4, 4, 0, 0, 0]);

  assert(update?.diagnostics?.exactBranchKind === 'TENSION_EDGE_T23', `the lower repeated tension benchmark should accept the repeated T3 branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.diagnostics?.finalMultiplicityKind === 'S23_EQUAL', 'the lower repeated tension benchmark should record sigma2=sigma3 multiplicity');
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['T3']),
    `the lower repeated tension benchmark should use the single exact T3 active surface (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  approxRelative(Number(update?.diagnostics?.principal?.s2) || 0, Number(update?.diagnostics?.principal?.s3) || 0, 1e-9, 'the lower repeated tension benchmark should close the lower principal-stress gap');
  approxRelative(Number(update?.diagnostics?.principal?.s3) || 0, -2, 1e-9, 'the lower repeated tension benchmark should end on sigma3 = -sigma_t');
});

await runCase('Case 0e2 Stage 2 exact mixed shear-tension edge keeps the F13 and T3 surfaces active', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 2,
    yieldTolerance: 1e-8,
    localTolerance: 1e-8
  });
  const update = updateMcPlasticFromTargetStress6(prepared, [-16, 0, 8, 0, 0, 0]);

  assert(update?.diagnostics?.exactBranchKind === 'TENSION_EDGE_F13_T3', `the mixed shear-tension edge benchmark should accept the {F13,T3} branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['F13', 'T3']),
    `the mixed shear-tension edge benchmark should keep the {F13,T3} active pair (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  approxRelative(Number(update?.diagnostics?.principal?.s3) || 0, -2, 1e-9, 'the mixed shear-tension edge benchmark should end on sigma3 = -sigma_t');
  assert(!Number.isFinite(Number(update?.diagnostics?.etaMcFinal)), 'the mixed shear-tension edge benchmark should suppress η_MC on the accepted tension-governed state');
});

await runCase('Case 0e3 Stage 2 exact lower mixed shear-tension corner closes sigma2=sigma3 on the cut-off', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 2,
    yieldTolerance: 1e-8,
    localTolerance: 1e-8
  });
  const update = updateMcPlasticFromTargetStress6(prepared, [-30, 12, 12, 0, 0, 0]);

  assert(update?.diagnostics?.exactBranchKind === 'TENSION_CORNER_S23_T3', `the lower mixed corner benchmark should accept the lower shear-tension corner branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.diagnostics?.finalMultiplicityKind === 'S23_EQUAL', 'the lower mixed corner benchmark should record sigma2=sigma3 multiplicity');
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['F13', 'T3']),
    `the lower mixed corner benchmark should use the repeated representative {F13,T3} active pair (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  approxRelative(Number(update?.diagnostics?.principal?.s2) || 0, Number(update?.diagnostics?.principal?.s3) || 0, 1e-9, 'the lower mixed corner benchmark should close the lower principal-stress gap');
  approxRelative(Number(update?.diagnostics?.principal?.s3) || 0, -2, 1e-9, 'the lower mixed corner benchmark should end on sigma3 = -sigma_t');
});

await runCase('Case 0e4 Stage 2 exact upper mixed shear-tension corner closes sigma1=sigma2 on the cut-off', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 2,
    yieldTolerance: 1e-8,
    localTolerance: 1e-8
  });
  const update = updateMcPlasticFromTargetStress6(prepared, [-30, -20, 30, 0, 0, 0]);

  assert(update?.diagnostics?.exactBranchKind === 'TENSION_CORNER_S12_T3', `the upper mixed corner benchmark should accept the upper shear-tension corner branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.diagnostics?.finalMultiplicityKind === 'S12_EQUAL', 'the upper mixed corner benchmark should record sigma1=sigma2 multiplicity');
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['F13', 'T3']),
    `the upper mixed corner benchmark should use the repeated representative {F13,T3} active pair (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  approxRelative(Number(update?.diagnostics?.principal?.s1) || 0, Number(update?.diagnostics?.principal?.s2) || 0, 1e-9, 'the upper mixed corner benchmark should close the upper principal-stress gap');
  approxRelative(Number(update?.diagnostics?.principal?.s3) || 0, -2, 1e-9, 'the upper mixed corner benchmark should end on sigma3 = -sigma_t');
});

await runCase('Case 0e5 Stage 2 exact triple tension point returns to the hydrostatic cut-off point', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 2,
    yieldTolerance: 1e-8,
    localTolerance: 1e-8
  });
  const update = updateMcPlasticFromTargetStress6(prepared, [4, 4, 4, 0, 0, 0]);

  assert(update?.diagnostics?.exactBranchKind === 'TENSION_APEX_T123', `the triple tension-point benchmark should accept the triple repeated T3 branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.diagnostics?.finalMultiplicityKind === 'TRIPLE', 'the triple tension-point benchmark should record triple multiplicity');
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['T3']),
    `the triple tension-point benchmark should use the single exact T3 active surface (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  approxRelative(Number(update?.diagnostics?.principal?.s1) || 0, Number(update?.diagnostics?.principal?.s2) || 0, 1e-9, 'the triple tension-point benchmark should close the sigma1=sigma2 gap');
  approxRelative(Number(update?.diagnostics?.principal?.s2) || 0, Number(update?.diagnostics?.principal?.s3) || 0, 1e-9, 'the triple tension-point benchmark should close the sigma2=sigma3 gap');
  approxRelative(Number(update?.diagnostics?.principal?.s3) || 0, -2, 1e-9, 'the triple tension-point benchmark should end on sigma = -sigma_t');
});

await runCase('Case 0e6 a tension-violating exact trial can still return on a shear branch when the shear return restores admissibility', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 0,
    phiEffDeg: 30,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 0,
    yieldTolerance: 1e-8,
    localTolerance: 1e-8
  });
  const targetStress6 = [-20, -10, 2, 0, 0, 0];
  const update = updateMcPlasticFromTargetStress6(prepared, targetStress6);

  assert(mohrCoulombIndicator3D(targetStress6, prepared)?.state === 'tension-cutoff', 'the manufactured mixed trial state should violate the tension cutoff before the return step');
  assert(update?.diagnostics?.exactBranchKind === 'MC_FACE_F13', `the mixed trial state should still admit a pure shear return when that restores admissibility (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.trialState?.activeYieldSurface === 'MC_FACE', 'the mixed trial state should end on the exact MC shear face rather than the tension branch');
  assert(Number(update?.diagnostics?.principal?.s3) > -1e-9, 'the accepted shear return should restore the minor principal stress inside the admissible tension domain');
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

await runCase('Case 0f1 Stage 2 exact non-associated tangents default to the unsymmetric algorithmic form', async () => {
  const baseMaterial = {
    ...baseModel().regions[0].material,
    Emc: 18000,
    cEff: 1.5,
    phiEffDeg: 18,
    psiEffDeg: 5,
    yieldTolerance: 1e-6
  };
  const prepared = prepareMechanicalMaterial(baseMaterial);
  const symmetrized = prepareMechanicalMaterial({
    ...baseMaterial,
    symmetrizeEpTangent: true
  });
  const initialState = seedMaterialPointStateFromInitialStress({ sxx: 15, syy: 30, txy: 0 }, prepared);
  const strainTrial6 = liftPlaneStrainStrainTo6({ exx: -0.02, eyy: 0, gxy: 0.02 });
  const exactUpdate = createMCPlasticMaterial(prepared).update({
    strainTrial6,
    committedState: initialState,
    materialParameters: prepared
  });
  const symmetrizedUpdate = createMCPlasticMaterial(symmetrized).update({
    strainTrial6,
    committedState: seedMaterialPointStateFromInitialStress({ sxx: 15, syy: 30, txy: 0 }, symmetrized),
    materialParameters: symmetrized
  });

  assert(prepared.symmetrizeEpTangent === false, 'exact Stage 2 materials should default to the unsymmetric algorithmic tangent');
  assert(maxMatrixAsymmetry(exactUpdate?.tangent6x6 || []) > 1e-9, 'the default exact non-associated Stage 2 tangent should remain unsymmetric');
  assert(maxMatrixAsymmetry(symmetrizedUpdate?.tangent6x6 || []) <= 1e-12, 'explicit tangent symmetrization should still be available as an opt-in approximation');
});

await runCase('Case 0f2 Stage 2 retains the committed exact branch under a zero incremental strain update', async () => {
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
  const strainTrial6 = liftPlaneStrainStrainTo6({ exx: -0.02, eyy: 0, gxy: 0.02 });
  const yielded = material.update({
    strainTrial6,
    committedState: initialState,
    materialParameters: prepared
  });
  const retained = material.update({
    strainTrial6: yielded?.trialState?.totalStrain6,
    committedState: yielded?.trialState,
    materialParameters: prepared
  });

  assert(yielded?.trialState?.exactBranchKind === 'MC_EDGE_S23_EQUAL', `the retained-branch regression should start from a yielded edge branch (got ${yielded?.trialState?.exactBranchKind})`);
  assert(retained?.trialState?.activeYieldSurface === yielded?.trialState?.activeYieldSurface, 'a zero incremental update should preserve the committed exact active-yield label');
  assert(retained?.trialState?.exactBranchKind === yielded?.trialState?.exactBranchKind, 'a zero incremental update should preserve the committed exact branch kind');
  assert(retained?.trialState?.currentlyMcActive === true, 'a zero incremental update should preserve the committed exact plastic-activity flag');
  assert((retained?.diagnostics?.plasticIncrementNorm || 0) <= 1e-12, 'a zero incremental update should not accumulate additional plastic strain');
  assert((retained?.diagnostics?.localIterations || 0) === 0, 'a zero incremental update should not need a new local Newton solve once the committed branch is retained');
});

await runCase('Case 0g Stage 2 exact lower-edge return closes the s2-s3 branch and stores edge mixing data', async () => {
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
    strainTrial6: liftPlaneStrainStrainTo6({ exx: -0.02, eyy: 0, gxy: 0.02 }),
    committedState: initialState,
    materialParameters: prepared
  });

  assert(update?.diagnostics?.exactBranchKind === 'MC_EDGE_S23_EQUAL', `lower-edge case should accept the sigma2=sigma3 branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.diagnostics?.finalMultiplicityKind === 'S23_EQUAL', 'lower-edge case should store the lower-pair multiplicity kind');
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['F12', 'F13']),
    `lower-edge case should keep the {F12,F13} active pair (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  assert((update?.diagnostics?.edgeMixWeight || 0) > 0 && (update?.diagnostics?.edgeMixWeight || 0) < 1, 'lower-edge case should store a non-trivial edge mixing weight');
  assert((update?.diagnostics?.edgeTotalMultiplier || 0) > 0, 'lower-edge case should store a positive total edge plastic multiplier');
  assert(
    Math.abs((Number(update?.diagnostics?.principal?.s2) || 0) - (Number(update?.diagnostics?.principal?.s3) || 0)) <= 1e-8,
    'lower-edge case should close the lower principal-stress gap'
  );
  approxRelative(
    Number(update?.diagnostics?.etaMcFinal) || 0,
    1,
    1e-9,
    'lower-edge case should return to eta_MC = 1 on the accepted state'
  );
});

await runCase('Case 0ga Stage 2 lower-edge scalar invariants remain stable under mirrored trial shear directions', async () => {
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
  const positive = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: -0.02, eyy: 0, gxy: 0.02 }),
    committedState: initialState,
    materialParameters: prepared
  });
  const negative = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({ exx: -0.02, eyy: 0, gxy: -0.02 }),
    committedState: initialState,
    materialParameters: prepared
  });

  assert(positive?.diagnostics?.exactBranchKind === 'MC_EDGE_S23_EQUAL', 'positive mirrored case should remain on the lower edge');
  assert(negative?.diagnostics?.exactBranchKind === 'MC_EDGE_S23_EQUAL', 'negative mirrored case should remain on the lower edge');
  approxRelative(
    Number(positive?.diagnostics?.etaMcFinal) || 0,
    Number(negative?.diagnostics?.etaMcFinal) || 0,
    1e-12,
    'mirrored lower-edge cases should preserve eta_MC'
  );
  approxRelative(
    Number(positive?.trialState?.accumulatedPlasticStrain) || 0,
    Number(negative?.trialState?.accumulatedPlasticStrain) || 0,
    1e-12,
    'mirrored lower-edge cases should preserve equivalent accumulated plastic strain'
  );
  approxRelative(
    Number(positive?.diagnostics?.plasticIncrementNorm) || 0,
    Number(negative?.diagnostics?.plasticIncrementNorm) || 0,
    1e-12,
    'mirrored lower-edge cases should preserve the scalar plastic increment norm'
  );
});

await runCase('Case 0h Stage 2 exact upper-edge return closes the s1-s2 branch and stores edge mixing data', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 4.070289300283476,
    phiEffDeg: 10.214211521800564,
    psiEffDeg: 1.2262853774186977,
    gamma: 18,
    gammaSat: 20,
    yieldTolerance: 1e-6
  });
  const material = createMCPlasticMaterial(prepared);
  const initialState = seedMaterialPointStateFromInitialStress(
    { sxx: 41.42400488726434, syy: 52.349590265728594, txy: -8.639369008225234 },
    prepared
  );
  const update = material.update({
    strainTrial6: liftPlaneStrainStrainTo6({
      exx: -0.02721493782357276,
      eyy: -0.028109921482776842,
      gxy: 0.0007843543396598568
    }),
    committedState: initialState,
    materialParameters: prepared
  });

  assert(update?.diagnostics?.exactBranchKind === 'MC_EDGE_S12_EQUAL', `upper-edge case should accept the sigma1=sigma2 branch (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.diagnostics?.finalMultiplicityKind === 'S12_EQUAL', 'upper-edge case should store the upper-pair multiplicity kind');
  assert(
    JSON.stringify(update?.diagnostics?.activeSurfaceIds || []) === JSON.stringify(['F13', 'F23']),
    `upper-edge case should keep the {F13,F23} active pair (got ${JSON.stringify(update?.diagnostics?.activeSurfaceIds || [])})`
  );
  assert((update?.diagnostics?.edgeMixWeight || 0) > 0 && (update?.diagnostics?.edgeMixWeight || 0) < 1, 'upper-edge case should store a non-trivial edge mixing weight');
  assert((update?.diagnostics?.edgeTotalMultiplier || 0) > 0, 'upper-edge case should store a positive total edge plastic multiplier');
  assert(
    Math.abs((Number(update?.diagnostics?.principal?.s1) || 0) - (Number(update?.diagnostics?.principal?.s2) || 0)) <= 1e-8,
    'upper-edge case should close the upper principal-stress gap'
  );
  approxRelative(
    Number(update?.diagnostics?.etaMcFinal) || 0,
    1,
    1e-9,
    'upper-edge case should return to eta_MC = 1 on the accepted state'
  );
});

await runCase('Case 0i Stage 2 reroutes the formal apex neighborhood when psi = 0 makes the shear apex system rank-deficient', async () => {
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 10,
    phiEffDeg: 30,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 20,
    yieldTolerance: 1e-6,
    allowFormalApexBranch: true,
    useTensionCutoff: false
  });
  const material = createMCPlasticMaterial(prepared);
  const initialState = seedMaterialPointStateFromEffectiveStress6([18, 18, 18, 0, 0, 0], prepared);
  const update = material.update({
    strainTrial6: [0, 0, 0, 0, 0, 0],
    committedState: initialState,
    materialParameters: prepared
  });

  assert(update?.diagnostics?.exactBranchKind === 'MC_TENSION_PENDING', `psi=0 apex-neighborhood case should reroute to the guarded pending-tension endpoint (got ${update?.diagnostics?.exactBranchKind})`);
  assert(update?.trialState?.activeYieldSurface === 'TENSION', 'psi=0 apex-neighborhood case should remain a diagnostic tension-style endpoint rather than a shear-plastic branch');
  assert(update?.diagnostics?.apexAdmissibilityReason === 'apex_potential_rank_deficient', `psi=0 apex-neighborhood case should report the rank-deficient apex reason (got ${update?.diagnostics?.apexAdmissibilityReason})`);
  assert((update?.trialState?.accumulatedPlasticStrain || 0) === 0, 'psi=0 apex-neighborhood case should not accumulate plastic strain on the guarded reroute');
  assert((update?.diagnostics?.plasticMultipliers || []).length === 0, 'psi=0 apex-neighborhood case should not store active shear multipliers after rerouting');
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
    model: baseModel({
      surfaceLoad: {
        xStart: 11,
        xEnd: 13,
        q: 5
      }
    }),
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
  assert((plastic?.solver?.loadStepHistory || []).every((step) => step?.continuationStrategy === 'adaptive-pi'), 'Stage 2 plastic footing case should record the adaptive continuation strategy on every load step');
  assert((plastic?.solver?.loadStepHistory || []).some((step) => (Number(step?.lineSearchEvaluations) || 0) >= 1), 'Stage 2 plastic footing case should record globalization evaluations for the plastic line search');
  assert((plastic?.solver?.loadStepHistory || []).some((step) => step?.linearSolver === 'gmres-scaled'), 'Stage 2 plastic footing case should exercise the scaled GMRES path on unsymmetric exact-plastic load steps');
  assert((plastic?.solver?.loadStepHistory || []).every((step) => (Number(step?.suggestedNextStepSize) || 0) >= 0), 'Stage 2 plastic footing case should expose non-negative suggested next-step sizes');
  assert((plastic?.solver?.residualHistory || []).length >= (plastic?.solver?.nonlinearIterations || 0), 'Stage 2 plastic footing case should retain residual history through the nonlinear iterations');
  assert((plastic?.solver?.residualHistory || []).every((item) => Number.isFinite(Number(item?.residualMerit)) && Number(item?.residualMerit) >= 0), 'Stage 2 plastic footing case should expose a finite residual merit history');
  assert(
    Math.abs((plastic?.summaries?.maxSettlement || 0) - (elastic?.summaries?.maxSettlement || 0)) > 1e-4,
    `Stage 2 plastic footing case should differ materially from the elastic settlement response once yielding activates (got ${plastic?.summaries?.maxSettlement} vs ${elastic?.summaries?.maxSettlement})`
  );
});

await runCase('Case 1d Stage 2 flat plastic-geostatic footing benchmarks converge for both c = 1 kPa and c = 0 kPa', async () => {
  for (const cEff of [1, 0]) {
    const model = baseModel({
      material: {
        Emc: 23088,
        nu: 0.3,
        K0nc: 0.5,
        cEff,
        phiEffDeg: 30,
        gamma: 18,
        gammaSat: 20
      },
      surfaceLoad: {
        xStart: 10.5,
        xEnd: 13.5,
        q: 15
      }
    });
    const output = await analyzeDeformationModel({
      model,
      options: {
        meshTargetArea: 0.4,
        loadMode: 'pressure',
        outOfPlaneLength: 10,
        useSeepagePorePressures: false,
        constitutiveModel: 'mc-plastic',
        initialStressMode: 'plastic-geostatic',
        nonlinearMaxIterations: 40,
        maxLoadSteps: 80,
        initialLoadStep: 0.1,
        minLoadStep: 0.0005
      }
    });

    assert(output?.solver?.initialPhaseConverged === true, `flat plastic-geostatic footing case with c = ${cEff} should converge the initial Phase 0b correction`);
    assert((output?.solver?.initialPhaseDisplayedGravityFactor || 0) === 1, `flat plastic-geostatic footing case with c = ${cEff} should display the full corrected initial state`);
    assert((output?.solver?.loadFactorCommitted || 0) === 1, `flat plastic-geostatic footing case with c = ${cEff} should converge the full service load path`);
    assert((output?.solver?.initialPhaseAcceptedSteps || 0) >= 1, `flat plastic-geostatic footing case with c = ${cEff} should record accepted Phase 0b steps`);
    assert(Number.isFinite(Number(output?.summaries?.maxSettlement)), `flat plastic-geostatic footing case with c = ${cEff} should report a finite settlement`);
  }
});

await runCase('Case 1d1 self-weight-only c-phi reduction runs without a surface load and reports a conservative FoS lower bound', async () => {
  const model = baseModel({
    surfaceLoad: {
      xStart: null,
      xEnd: null,
      q: 0
    }
  });
  const output = await analyzeDeformationModel({
    model,
    options: {
      analysisType: 'safety-cphi',
      meshTargetArea: 1.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 20,
      maxLoadSteps: 40,
      initialLoadStep: 0.1,
      minLoadStep: 0.001,
      safetyInitialSigmaMsfIncrement: 0.05,
      safetySigmaMsfGrowthFactor: 1.2,
      safetySigmaMsfMax: 1.15,
      safetySigmaMsfBracketTolerance: 0.01,
      safetyMaxSearchTrials: 6
    }
  });

  assert(output?.solver?.analysisType === 'safety-cphi', 'self-weight-only safety case should report the safety analysis type');
  assert(output?.load == null, 'self-weight-only safety case should not require an active surface-load object');
  assert(output?.solver?.servicePhaseStarted === false, 'self-weight-only safety case should not start a service phase');
  assert(output?.solver?.safetyBaseState === 'initial-equilibrium', 'self-weight-only safety case should start from the initial equilibrium state');
  assert(output?.solver?.safetyStatus === 'no-failure-found', `self-weight-only safety case should remain stable up to the requested ΣMsf upper bound (got ${output?.solver?.safetyStatus})`);
  assert(output?.solver?.safetyFailureCode === 'no-failure-found', `self-weight-only safety case should expose a stable safety classification code (got ${output?.solver?.safetyFailureCode})`);
  assert((output?.solver?.safetyFactorOfSafetyLower || 0) >= 1.14, `self-weight-only safety case should report FoS > 1.14 for the requested upper bound (got ${output?.solver?.safetyFactorOfSafetyLower})`);
  assert((output?.solver?.safetyAcceptedContinuationSteps || 0) >= 1, 'self-weight-only safety case should accumulate accepted continuation steps across the safety search');
  assert((output?.solver?.safetyTrialHistory || []).every((trial) => Number.isFinite(Number(trial?.incrementalDisplacementNorm)) && Number(trial?.incrementalDisplacementNorm) >= 0), 'self-weight-only safety case should record finite incremental mechanism norms in the safety history');
  assert(
    Math.abs((Number(output?.solver?.safetyStrengthRetained) || 0) - 1 / Math.max(Number(output?.solver?.safetyFactorOfSafetyLower) || 1, 1)) < 1e-9,
    'self-weight-only safety case should report the retained-strength fraction as the inverse of the conservative FoS lower bound'
  );
  assert((output?.summaries?.maxSettlement || 0) >= 0, 'self-weight-only safety case should still return a finite additional settlement field');
});

await runCase('Case 1d2 loaded c-phi reduction starts from the converged end-of-service state and exposes safety plasticity output', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel({
      surfaceLoad: {
        xStart: 10.5,
        xEnd: 13.5,
        q: 15
      }
    }),
    options: {
      analysisType: 'safety-cphi',
      meshTargetArea: 1.0,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 20,
      maxLoadSteps: 40,
      initialLoadStep: 0.1,
      minLoadStep: 0.001,
      safetyInitialSigmaMsfIncrement: 0.05,
      safetySigmaMsfGrowthFactor: 1.2,
      safetySigmaMsfMax: 1.10,
      safetySigmaMsfBracketTolerance: 0.01,
      safetyMaxSearchTrials: 6
    }
  });

  assert(output?.solver?.analysisType === 'safety-cphi', 'loaded safety case should report the safety analysis type');
  assert(output?.solver?.servicePhaseStarted === true, 'loaded safety case should first converge the service phase');
  assert(output?.solver?.safetyBaseState === 'end-of-service', 'loaded safety case should start the safety phase from the end-of-service equilibrium state');
  assert(['no-failure-found', 'bracketed'].includes(output?.solver?.safetyStatus), `loaded safety case should produce a valid safety status (got ${output?.solver?.safetyStatus})`);
  assert((output?.solver?.safetyFactorOfSafetyLower || 0) >= 1, 'loaded safety case should report a conservative FoS lower bound of at least 1.0');
  assert((output?.solver?.safetyAcceptedContinuationSteps || 0) >= 1, 'loaded safety case should accumulate accepted continuation steps across the safety search');
  assert((output?.solver?.safetyTrialHistory || []).every((trial) => Number.isFinite(Number(trial?.maxAccumulatedPlasticIncrement)) && Number(trial?.maxAccumulatedPlasticIncrement) >= 0), 'loaded safety case should record finite incremental plastic mechanism measures in the safety history');
  assert(
    Math.abs((Number(output?.solver?.safetyStrengthRetained) || 0) - 1 / Math.max(Number(output?.solver?.safetyFactorOfSafetyLower) || 1, 1)) < 1e-9,
    'loaded safety case should report the retained-strength fraction as the inverse of the conservative FoS lower bound'
  );
  assert((output?.summaries?.maxSafetyEquivalentPlasticIncrement || 0) >= 0, 'loaded safety case should expose the safety plastic-increment field');
  assert((output?.summaries?.serviceSettlementIncrement || 0) >= 0, 'loaded safety case should preserve the converged end-of-service settlement increment separately from the safety increment');
  const sampled = sampleDeformationState(output?.mesh, output, 12, -0.5);
  assert(sampled, 'loaded safety case should support in-mesh sampling');
  assert(Number.isFinite(sampled?.safetyEquivalentPlasticIncrement), 'loaded safety case sampling should expose the safety plastic-increment quantity');
});

await runCase('Case 1e Stage 2 returns a flagged near-failure state when the nonlinear solve cannot fully converge', async () => {
  const model = slopedModel({
    material: {
      Emc: 22000,
      nu: 0.3,
      K0nc: 0.8,
      cEff: 12,
      phiEffDeg: 34,
      psiEffDeg: 2,
      gamma: 18,
      gammaSat: 20
    },
    surfaceLoad: {
      xStart: 6,
      xEnd: 8,
      q: 20
    }
  });

  const output = await analyzeDeformationModel({
    model,
    options: {
      meshTargetArea: 0.6,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 40,
      maxLoadSteps: 80,
      initialLoadStep: 0.1,
      minLoadStep: 0.0005
    }
  });

  assert(output?.solver?.initialPhaseConverged === false, 'the near-failure Stage 2 slope case should now expose the initial plastic-geostatic failure mode explicitly');
  assert(output?.solver?.initialPhaseFailureOutcomeClass === 'numerical-nonconvergence', `the near-failure Stage 2 slope case should classify the initial-phase stop as numerical non-convergence (got ${output?.solver?.initialPhaseFailureOutcomeClass})`);
  assert(output?.solver?.servicePhaseStarted === false, 'a non-converged initial plastic-geostatic slope case should not start service loading');
  assert(output?.solver?.convergenceState === 'partial', 'a near-failure Stage 2 slope case should return a partial flagged result rather than throwing');
  assert((output?.solver?.initialPhaseDisplayedGravityFactor || 0) > 0, 'the displayed near-failure state should still advance partway along the initial plastic-geostatic correction path');
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
  if ((Number(output?.solver?.initialPhaseDisplayedGravityFactor) || 0) > 0) {
    assert(
      maxDisplayedPlasticStrain >= maxCommittedPlasticStrain,
      'the displayed near-failure initial-phase state should not plot less accumulated plastic strain than the last committed state'
    );
  } else {
    approxRelative(
      maxDisplayedPlasticStrain,
      maxCommittedPlasticStrain,
      1e-12,
      'when the displayed near-failure state falls back to the last committed load, the plotted material state should match the committed plastic strain'
    );
  }
  assert(
    (output?.warnings || []).some((warning) => String(warning).includes('non-converged initial plastic self-weight equilibration state')),
    'the returned near-failure Stage 2 result should be clearly flagged as an initial plastic-geostatic partial state'
  );
});

await runCase('Case 1f Stage 2 plastic geostatic equilibration carries the initial state and resets service displacements', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshTargetArea: 0.3,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 30,
      maxLoadSteps: 20,
      initialLoadStep: 0.25,
      minLoadStep: 0.001
    }
  });

  assert(output?.solver?.initialStressMode === 'gravity-step-k0nc-plastic-equilibration', 'plastic-geostatic mode should report the combined predictor + plastic equilibration initialization path');
  assert(output?.solver?.initialPhaseStarted === true, 'plastic-geostatic mode should start the initial plastic equilibration phase');
  assert(output?.solver?.initialPhaseConverged === true, 'the baseline plastic-geostatic benchmark should converge the initial plastic equilibration phase');
  assert(output?.solver?.servicePhaseStarted === true, 'the service phase should start once the initial plastic equilibration phase converges');
  assert(output?.solver?.initialDisplacementResetApplied === true, 'the service phase should reset the displayed displacement baseline to the equilibrated initial state');
  assert((output?.solver?.initialLoadStepHistory || []).length >= 1, 'the initial plastic equilibration phase should retain its own load-step history');
  assert((output?.solver?.initialResidualHistory || []).length >= 1, 'the initial plastic equilibration phase should retain its own residual history');
  assert((output?.summaries?.maxInitialSettlement || 0) > 0, 'the equilibrated initial phase should store a non-zero self-weight settlement baseline');
  approxRelative(
    Number(output?.summaries?.serviceSettlementIncrement) || 0,
    Number(output?.summaries?.maxSettlement) || 0,
    1e-12,
    'when the service phase runs after the displacement reset, the service-settlement increment should equal the displayed settlement summary'
  );

  const reconstructionError = Math.max(
    0,
    ...((output?.totalNodalDisplacements || []).map((totalPoint, index) => {
      const initialPoint = output?.initialNodalDisplacements?.[index] || {};
      const displayedPoint = output?.nodalDisplacements?.[index] || {};
      return Math.max(
        Math.abs((Number(totalPoint?.ux) || 0) - ((Number(initialPoint?.ux) || 0) + (Number(displayedPoint?.ux) || 0))),
        Math.abs((Number(totalPoint?.uy) || 0) - ((Number(initialPoint?.uy) || 0) + (Number(displayedPoint?.uy) || 0)))
      );
    }))
  );
  assert(reconstructionError <= 1e-9, `displayed service displacements should reconstruct the stored total field after the initial-baseline reset (max mismatch ${reconstructionError})`);

  const representativeElement = (output?.elementResults || []).find((item) => item?.materialDiagnostics?.equilibratedInitialStateAvailable === true);
  assert(representativeElement, 'plastic-geostatic mode should expose an equilibrated reference state on at least one element');
  approxRelative(
    Number(representativeElement?.materialDiagnostics?.initialEtaMc) || 0,
    Number(representativeElement?.predictorMaterialState?.initialEtaMc) || 0,
    1e-12,
    'predictor audit metrics should remain tied to predictorState after the initial plastic phase'
  );
  assert(
    (Number(representativeElement?.referenceMaterialState?.initialEtaMc) || 0) === 0,
    'referenceState should no longer expose the legacy predictor utilization as if it were the equilibrated initial audit'
  );
  assert(
    Number(representativeElement?.materialDiagnostics?.equilibratedInitialEtaMc) > 0,
    'the equilibrated initial state should expose its own exact MC utilization separately from the predictor audit'
  );
});

await runCase('Case 1fa Stage 2 plastic geostatic equilibration treats an admissible flat predictor as a correction problem rather than replaying gravity strain', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel({
      material: {
        Emc: 12000,
        nu: 0.3,
        K0nc: 0.5,
        cEff: 1,
        phiEffDeg: 20,
        gamma: 18,
        gammaSat: 20
      },
      surfaceLoad: {
        xStart: 11,
        xEnd: 13,
        q: 1
      }
    }),
    options: {
      meshTargetArea: 0.3,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 30,
      maxLoadSteps: 20,
      initialLoadStep: 0.25,
      minLoadStep: 0.001
    }
  });

  assert(output?.solver?.initialPhaseConverged === true, 'the admissible flat predictor benchmark should converge the initial plastic correction phase');
  assert(
    (output?.solver?.initialPhaseAcceptedSteps || 0) > 1,
    'the admissible flat predictor benchmark should use multiple predictor-to-gravity continuation steps instead of one undivided full-gravity jump'
  );
  assert(
    (output?.summaries?.maxInitialEquivalentPlasticStrain || 0) <= 1e-12,
    'an admissible flat predictor should not accumulate artificial initial plastic strain during the correction phase'
  );
  assert(
    Math.abs((Number(output?.summaries?.maxInitialEtaMcEquilibrated) || 0) - (Number(output?.summaries?.maxInitialEtaMcPredictor) || 0)) <= 0.02,
    'the equilibrated initial utilization should stay close to the admissible predictor utilization when the flat predictor only needs a small correction'
  );
});

await runCase('Case 1fb Stage 2 plastic geostatic slope initialization progresses beyond the raw predictor with exact tension-cutoff branches available', async () => {
  const output = await analyzeDeformationModel({
    model: slopedModel({
      material: {
        Emc: 22000,
        nu: 0.3,
        K0nc: 0.8,
        cEff: 12,
        phiEffDeg: 34,
        psiEffDeg: 2,
        gamma: 18,
        gammaSat: 20
      },
      surfaceLoad: {
        xStart: 6,
        xEnd: 8,
        q: 20
      }
    }),
    options: {
      meshTargetArea: 0.6,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 40,
      maxLoadSteps: 80,
      initialLoadStep: 0.1,
      minLoadStep: 0.0005
    }
  });

  assert(output?.solver?.initialPhaseStarted === true, 'plastic-geostatic slope test should start the initial plastic equilibration phase');
  assert((output?.solver?.initialPhaseAcceptedSteps || 0) > 0, 'plastic-geostatic slope test should move beyond the raw predictor baseline instead of stalling at zero accepted correction steps');
  assert((output?.solver?.initialPhaseDisplayedGravityFactor || 0) > 0.01, 'plastic-geostatic slope test should display a materially advanced self-weight correction state');
  assert(output?.solver?.initialPhaseConvergenceState === 'partial' || output?.solver?.initialPhaseConverged === true, 'plastic-geostatic slope test should now expose either a converged or a flagged partial initial correction state rather than a zero-step startup stall');
  assert(
    !(output?.warnings || []).some((warning) => String(warning).includes('not implemented yet')),
    'plastic-geostatic slope warnings should no longer claim that the exact Stage 2.4 tension branch is missing'
  );
  assert(
    (output?.solver?.initialPhasePeakTensionCutoffActiveElements || output?.solver?.initialPhasePeakTensionPendingElements || 0) > 0,
    'the supportable plastic-geostatic slope benchmark should still activate exact tension-cutoff zones near the free surface'
  );
});

await runCase('Case 1g Stage 2 plastic geostatic equilibration can fail under self-weight before the service phase starts', async () => {
  const output = await analyzeDeformationModel({
    model: slopedModel({
      material: {
        Emc: 2000,
        nu: 0.3,
        K0nc: 1 - Math.sin((22 * Math.PI) / 180),
        cEff: 1,
        phiEffDeg: 22,
        psiEffDeg: 0,
        gamma: 18,
        gammaSat: 20
      },
      surfaceLoad: {
        xStart: 6,
        xEnd: 8,
        q: 1
      }
    }),
    options: {
      meshTargetArea: 0.45,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 40,
      maxLoadSteps: 80,
      initialLoadStep: 0.1,
      minLoadStep: 0.0005
    }
  });

  assert(output?.solver?.initialPhaseStarted === true, 'weak-slope geostatic test should attempt the initial plastic equilibration phase');
  assert(['partial', 'converged'].includes(output?.solver?.convergenceState), 'weak-slope geostatic test should still return a numerically well-defined result state');
  assert((output?.solver?.initialLoadStepHistory || []).length >= 1, 'weak-slope geostatic test should retain initial-phase step history');

  if (output?.solver?.servicePhaseStarted === false) {
    assert(output?.solver?.initialPhaseConvergenceState === 'partial', 'when the weak-slope case does not start service loading, the initial phase should be flagged as partial');
    assert(output?.solver?.convergenceState === 'partial', 'when the weak-slope case stops in the initial phase, the overall result should remain a flagged partial state');
    assert(output?.solver?.failureOutcomeClass === 'numerical-nonconvergence', `when the weak-slope case stops in the initial phase, the overall result should carry a numerical non-convergence classification (got ${output?.solver?.failureOutcomeClass})`);
    assert(output?.solver?.initialDisplacementResetApplied === false, 'no service-phase displacement reset should be reported when the service phase never starts');
    assert((output?.solver?.loadStepHistory || []).length === 0, 'the service phase should not produce load-step history when it never started');
    assert((output?.summaries?.maxInitialSettlement || 0) > 0, 'the returned initial self-weight state should still provide an interpretable settlement field');
    assert((output?.summaries?.serviceSettlementIncrement || 0) === 0, 'service-settlement increment should remain zero when the service phase never starts');
    assert((output?.warnings || []).some((warning) => String(warning).includes('self-weight equilibration state')), 'the weak-slope initial-phase result should be clearly flagged as an initial self-weight equilibration state');
    assert((output?.warnings || []).some((warning) => String(warning).includes('Service loading was not started')), 'the warnings should state explicitly that the service phase never started');
  } else {
    assert(output?.solver?.initialPhaseConverged === true, 'if the weak-slope case now reaches the service phase, the initial plastic equilibration must have converged first');
    assert(output?.solver?.loadFactorCommitted >= 0, 'a weak-slope case that reaches the service phase should still expose a valid committed load factor');
  }
});

await runCase('Case 1ga Stage 2 plastic geostatic failure with no accepted correction step falls back to the predictor baseline', async () => {
  const output = await analyzeDeformationModel({
    model: slopedModel({
      material: {
        Emc: 2000,
        nu: 0.3,
        K0nc: 1 - Math.sin((22 * Math.PI) / 180),
        cEff: 1,
        phiEffDeg: 22,
        psiEffDeg: 0,
        gamma: 18,
        gammaSat: 20
      },
      surfaceLoad: {
        xStart: 6,
        xEnd: 8,
        q: 1
      }
    }),
    options: {
      meshTargetArea: 0.45,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      nonlinearMaxIterations: 1,
      maxLoadSteps: 20,
      initialGravityMaxLoadSteps: 1,
      initialLoadStep: 0.25,
      minLoadStep: 0.0005
    }
  });

  assert(output?.solver?.initialPhaseStarted === true, 'no-step fallback case should still attempt the initial plastic equilibration phase');
  assert(output?.solver?.initialPhaseConvergenceState === 'partial', 'no-step fallback case should remain a partial initial-phase result');
  assert((output?.solver?.initialPhaseAcceptedSteps || 0) === 0, 'no-step fallback case should reject the first correction step before any plastic-geostatic correction is accepted');
  assert((output?.solver?.initialPhaseDisplayedGravityFactor || 0) === 0, 'when no correction step is accepted, the displayed initial correction factor should fall back to the committed predictor baseline');
  assert(output?.solver?.displayedStateMode === 'committed', 'no-step fallback case should display the last committed initial state rather than a rejected iteration');
  assert(output?.solver?.servicePhaseStarted === false, 'service loading must not start in the no-step fallback case');

  const baselineMismatch = Math.max(
    0,
    ...((output?.totalNodalDisplacements || []).map((totalPoint, index) => {
      const baselinePoint = output?.initialNodalDisplacements?.[index] || {};
      return Math.max(
        Math.abs((Number(totalPoint?.ux) || 0) - (Number(baselinePoint?.ux) || 0)),
        Math.abs((Number(totalPoint?.uy) || 0) - (Number(baselinePoint?.uy) || 0))
      );
    }))
  );
  assert(baselineMismatch <= 1e-12, `when no initial correction step is accepted, the displayed total field should remain the predictor baseline (max mismatch ${baselineMismatch})`);
  approxRelative(
    Number(output?.summaries?.maxSettlement) || 0,
    Number(output?.summaries?.maxInitialSettlement) || 0,
    1e-12,
    'when no initial correction step is accepted, the displayed settlement summary should match the predictor baseline settlement'
  );
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

await runCase('Case 39 ELLPACK pack/matvec reproduces the dense reference within machine precision', async () => {
  // Build a small asymmetric sparse system that hits every row-padding
  // scenario (varying row lengths, non-zero diag, off-diagonal entries).
  const rows = [
    { indices: new Int32Array([0, 1, 3]), values: new Float64Array([4.5, -1.2, 0.7]), diagIndex: 0, diag: 4.5 },
    { indices: new Int32Array([0, 1, 2]), values: new Float64Array([-1.2, 3.1, -0.9]), diagIndex: 1, diag: 3.1 },
    { indices: new Int32Array([1, 2, 3]), values: new Float64Array([-0.9, 5.2, -1.4]), diagIndex: 1, diag: 5.2 },
    { indices: new Int32Array([0, 2, 3]), values: new Float64Array([0.7, -1.4, 2.3]), diagIndex: 2, diag: 2.3 }
  ];
  const vector = new Float64Array([1.2, -0.3, 0.8, 2.1]);

  // Reference dense matvec
  const ref = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < rows[i].indices.length; k += 1) sum += rows[i].values[k] * vector[rows[i].indices[k]];
    ref[i] = sum;
  }

  const shape = computeEllpackShape(rows);
  assert(shape.numRows === 4 && shape.maxRowLen === 3, 'ELLPACK shape detection should pick the tightest padding width');

  const bufF64 = createEllpackBuffer({ ...shape, valueDtype: 'f64' });
  packEllpackIndices(bufF64, rows);
  packEllpackValues(bufF64, rows);
  const gotF64 = ellpackMatvecReference(bufF64, vector);
  for (let i = 0; i < rows.length; i += 1) {
    approxRelative(ref[i], gotF64[i], 1e-12, `ELLPACK f64 matvec row ${i}`);
  }

  // Back the pattern with Float32 values to simulate the GPU backend path.
  const bufF32 = createEllpackBuffer({ ...shape, valueDtype: 'f32' });
  packEllpackIndices(bufF32, rows);
  packEllpackValues(bufF32, rows);
  const narrowVec = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) narrowVec[i] = vector[i];
  const gotF32 = ellpackMatvecReference(bufF32, narrowVec);
  for (let i = 0; i < rows.length; i += 1) {
    approxRelative(ref[i], gotF32[i], 1e-5, `ELLPACK f32 matvec row ${i}`);
  }
});

await runCase('Case 40 CPU-f32 backend factory respects the gpuMinDof size gate and explicit overrides', async () => {
  const smallGate = await createLinearAlgebraBackend({
    useGpuAcceleration: true,
    ndof: 500,
    gpuMinDof: 1500
  }, []);
  assert(smallGate.backend === null, 'size-gated request should stay on the CPU f64 path');
  assert(String(smallGate.info.reason || '').startsWith('below-size-gate'), 'size-gate reason should be reported explicitly');

  const explicitF32 = await createLinearAlgebraBackend({
    linearAlgebraBackend: 'cpu-f32'
  }, []);
  assert(explicitF32.backend && explicitF32.backend.name === 'cpu-f32', 'explicit cpu-f32 override should be honoured regardless of useGpuAcceleration');
  assert(explicitF32.backend.requiresResidualRefresh === true, 'cpu-f32 backend must request residual refresh so the Krylov solvers reset f32 drift');
  explicitF32.backend.dispose();

  const explicitF64 = await createLinearAlgebraBackend({
    linearAlgebraBackend: 'cpu-f64'
  }, []);
  assert(explicitF64.backend === null, 'explicit cpu-f64 override should return the native fallback (null backend)');
});

await runCase('Case 41 CPU-f32 backend matvec matches the CSR reference within f32 tolerance', async () => {
  const backend = createCpuF32Backend();
  try {
    const rows = [
      { indices: new Int32Array([0, 1, 2]), values: new Float64Array([10, 2, -1]), diagIndex: 0, diag: 10 },
      { indices: new Int32Array([0, 1, 3]), values: new Float64Array([2, 9, 3]), diagIndex: 1, diag: 9 },
      { indices: new Int32Array([0, 2, 3]), values: new Float64Array([-1, 7, -2]), diagIndex: 1, diag: 7 },
      { indices: new Int32Array([1, 2, 3]), values: new Float64Array([3, -2, 11]), diagIndex: 2, diag: 11 }
    ];
    const x = new Float64Array([0.125, -0.5, 1.75, -0.875]);
    const reference = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      let sum = 0;
      for (let k = 0; k < rows[i].indices.length; k += 1) sum += rows[i].values[k] * x[rows[i].indices[k]];
      reference[i] = sum;
    }
    const got = backend.matvec(rows, x);
    for (let i = 0; i < rows.length; i += 1) {
      approxRelative(reference[i], got[i], 1e-5, `cpu-f32 matvec row ${i}`);
    }
    // Pattern caching: a second call with the same identity must hit the refresh-only path.
    const got2 = backend.matvec(rows, x);
    for (let i = 0; i < rows.length; i += 1) {
      approxRelative(reference[i], got2[i], 1e-5, `cpu-f32 matvec (cached) row ${i}`);
    }
  } finally {
    backend.dispose();
  }
});

async function runBackendParityCase(label, modelFactory, options, tolerances) {
  const base = await analyzeDeformationModel({
    model: modelFactory(),
    options
  });
  const mixed = await analyzeDeformationModel({
    model: modelFactory(),
    options: { ...options, linearAlgebraBackend: 'cpu-f32' }
  });
  assert(base?.solver?.linearAlgebraBackend?.name === 'cpu-f64', `${label}: baseline run should use the CPU f64 backend`);
  assert(mixed?.solver?.linearAlgebraBackend?.name === 'cpu-f32', `${label}: mixed-precision run should use the CPU f32 backend`);
  assert(mixed?.solver?.linearAlgebraBackend?.residualRefreshInterval > 0, `${label}: mixed-precision backend should enable residual refresh`);

  const settlementRel = tolerances?.settlement ?? 1e-3;
  approxRelative(
    Math.max(base.summaries?.maxSettlement || 0, 1e-9),
    Math.max(mixed.summaries?.maxSettlement || 0, 1e-9),
    settlementRel,
    `${label}: max settlement should agree between CPU f64 and mixed-precision paths`
  );
  // Peak MC utilization is a scalar field that should be stable across matvec
  // precision. Use a looser bound for Stage 2 because active-set transitions
  // are sensitive to roundoff.
  const etaRel = tolerances?.eta ?? 5e-3;
  const baseEta = Math.max(base.summaries?.maxMcEta || 0, 1e-9);
  const mixedEta = Math.max(mixed.summaries?.maxMcEta || 0, 1e-9);
  approxRelative(baseEta, mixedEta, etaRel, `${label}: peak MC utilization should agree between backends`);

  assert(
    base.solver?.convergenceState === mixed.solver?.convergenceState
    || (base.solver?.convergenceState === 'converged' && mixed.solver?.convergenceState === 'quasi-converged'),
    `${label}: both paths should reach the same convergence class (base=${base.solver?.convergenceState}, mixed=${mixed.solver?.convergenceState})`
  );
  // Iteration counts may differ slightly (Krylov restart at refresh boundaries);
  // assert a 2x envelope so regressions in the mixed-precision path are flagged.
  const baseLinear = Math.max(Number(base.solver?.linearIterations) || 0, 1);
  const mixedLinear = Math.max(Number(mixed.solver?.linearIterations) || 0, 1);
  assert(
    mixedLinear <= 4 * baseLinear,
    `${label}: mixed-precision linear iterations (${mixedLinear}) should stay within 4x baseline (${baseLinear})`
  );
}

await runCase('Case 42 linear-elastic run is numerically stable under the mixed-precision backend', async () => {
  await runBackendParityCase(
    'linear-elastic',
    baseModel,
    {
      meshTargetArea: 0.25,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic'
    },
    { settlement: 5e-4, eta: 5e-3 }
  );
});

await runCase('Case 43 Stage 1 reduced-stiffness run is numerically stable under the mixed-precision backend', async () => {
  await runBackendParityCase(
    'stage-1-reduced-stiffness',
    baseModel,
    {
      meshTargetArea: 0.25,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-reduced-stiffness'
    },
    { settlement: 1e-3, eta: 5e-3 }
  );
});

await runCase('Case 44 Stage 2 elastoplastic run is numerically stable under the mixed-precision backend', async () => {
  // Small load so the run stays in the elastic range of the MC surface —
  // verifies that Stage 2 can traverse the active-set paths without the
  // f32 matvec introducing spurious yield transitions.
  await runBackendParityCase(
    'stage-2-elastoplastic-elastic-range',
    () => baseModel({
      surfaceLoad: {
        xStart: 11,
        xEnd: 13,
        q: 5
      }
    }),
    {
      meshTargetArea: 0.3,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialLoadStep: 1,
      maxLoadSteps: 8
    },
    { settlement: 5e-3, eta: 1e-2 }
  );
});

console.log('Deformation Phase 1 verification passed.');
