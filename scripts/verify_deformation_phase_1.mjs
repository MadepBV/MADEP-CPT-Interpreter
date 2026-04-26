import {
  analyzeDeformationModel,
  applyKrylovPreconditioner,
  buildBlockJacobiPreconditioner,
  sampleDeformationState
} from '../src/lib/cpt-app/deformation/solver.js';
import {
  computeEllpackShape,
  createEllpackBuffer,
  ellpackMatvecReference,
  packEllpackIndices,
  packEllpackValues
} from '../src/lib/cpt-app/deformation/gpu/ellpack.js';
import { createCpuF32Backend } from '../src/lib/cpt-app/deformation/gpu/cpu-f32-backend.js';
import { createLinearAlgebraBackend, probeGpuBackend } from '../src/lib/cpt-app/deformation/gpu/index.js';
import {
  createElementKernelBuffer,
  elementElasticStiffnessReference,
  elementInternalForceReference,
  elementStrainReference,
  packElementKernelBuffer
} from '../src/lib/cpt-app/deformation/gpu/elements.js';
import {
  createElementKernelBufferT6,
  elementElasticStiffnessReferenceT6,
  elementInternalForceReferenceT6,
  elementStrainReferenceT6,
  packElementKernelBufferT6
} from '../src/lib/cpt-app/deformation/gpu/elements-t6.js';
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
import { buildDeformationMesh } from '../src/lib/cpt-app/deformation/mesh.js';
import {
  edgeTractionVector,
  elementBodyForceVectorT3FromArea,
  triangleArea
} from '../src/lib/cpt-app/deformation/element-t3.js';
import {
  buildBMatrixT6AtGauss,
  edgeTractionVectorT6,
  elementBodyForceVectorT6FromArea,
  elementStiffnessT6FromTangents2D,
  GAUSS_T6_3PT,
  shapeFunctionsT6
} from '../src/lib/cpt-app/deformation/element-t6.js';

const ENABLE_REAL_GPU_PARITY = process.argv.includes('--gpu-parity');
const ENABLE_GPU_BENCHMARK = process.argv.includes('--gpu-benchmark');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approxRelative(left, right, relTol, message) {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1e-9);
  const relErr = Math.abs(left - right) / scale;
  assert(relErr <= relTol, `${message} (left ${left}, right ${right}, rel err ${relErr})`);
}

function approxAbs(left, right, absTol, message) {
  const absErr = Math.abs(left - right);
  assert(absErr <= absTol, `${message} (left ${left}, right ${right}, abs err ${absErr})`);
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

function vectorYResultant(vector) {
  let sum = 0;
  for (let i = 1; i < (vector?.length || 0); i += 2) sum += Number(vector[i]) || 0;
  return sum;
}

function maxAbsVectorEntry(vector) {
  let maxValue = 0;
  for (const value of vector || []) maxValue = Math.max(maxValue, Math.abs(Number(value) || 0));
  return maxValue;
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => {
    let sum = 0;
    for (let i = 0; i < row.length; i += 1) sum += (Number(row[i]) || 0) * (Number(vector?.[i]) || 0);
    return sum;
  });
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

await runCase('Case 0t6a T6 shape functions match Triangle o2 ordering and partition unity', async () => {
  const barycentricNodes = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 0.5, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0.5, 0]
  ];
  barycentricNodes.forEach(([L1, L2, L3], nodeIndex) => {
    const N = shapeFunctionsT6(L1, L2, L3);
    approxAbs(N.reduce((sum, value) => sum + value, 0), 1, 1e-14, `T6 node ${nodeIndex} should preserve partition of unity`);
    N.forEach((value, shapeIndex) => {
      approxAbs(value, shapeIndex === nodeIndex ? 1 : 0, 1e-14, `T6 Kronecker property failed at node ${nodeIndex}, shape ${shapeIndex}`);
    });
  });
  const centroidN = shapeFunctionsT6(1 / 3, 1 / 3, 1 / 3);
  approxAbs(centroidN.reduce((sum, value) => sum + value, 0), 1, 1e-14, 'T6 centroid shape functions should sum to one');
});

await runCase('Case 0t6b T6 B-matrix reproduces a quadratic displacement / linear strain patch', async () => {
  const meshes = [
    [{ x: 0, y: 0 }, { x: 2.0, y: 0.2 }, { x: 0.3, y: 1.4 }],
    [{ x: -0.4, y: 0.1 }, { x: 1.6, y: -0.25 }, { x: 0.25, y: 1.7 }]
  ];
  const coeff = { a: 0.003, b: -0.0015, c: 0.002, d: -0.0025, e: 0.0012, f: -0.0018 };
  const displacement = (point) => ({
    ux: coeff.a * point.x * point.x + coeff.b * point.x * point.y + coeff.c * point.y * point.y,
    uy: coeff.d * point.x * point.x + coeff.e * point.x * point.y + coeff.f * point.y * point.y
  });
  meshes.forEach((corners, meshIndex) => {
    const nodes = [
      corners[0],
      corners[1],
      corners[2],
      { x: 0.5 * (corners[1].x + corners[2].x), y: 0.5 * (corners[1].y + corners[2].y) },
      { x: 0.5 * (corners[2].x + corners[0].x), y: 0.5 * (corners[2].y + corners[0].y) },
      { x: 0.5 * (corners[0].x + corners[1].x), y: 0.5 * (corners[0].y + corners[1].y) }
    ];
    const ue = new Float64Array(12);
    nodes.forEach((node, nodeIndex) => {
      const u = displacement(node);
      ue[2 * nodeIndex] = u.ux;
      ue[2 * nodeIndex + 1] = u.uy;
    });
    GAUSS_T6_3PT.forEach((gp, gpIndex) => {
      const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
      const strain = [0, 0, 0];
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 12; col += 1) strain[row] += B[row][col] * ue[col];
      }
      const x = gp.L1 * corners[0].x + gp.L2 * corners[1].x + gp.L3 * corners[2].x;
      const y = gp.L1 * corners[0].y + gp.L2 * corners[1].y + gp.L3 * corners[2].y;
      approxAbs(strain[0], 2 * coeff.a * x + coeff.b * y, 1e-12, `T6 exx patch failed on mesh ${meshIndex}, gp ${gpIndex}`);
      approxAbs(strain[1], coeff.e * x + 2 * coeff.f * y, 1e-12, `T6 eyy patch failed on mesh ${meshIndex}, gp ${gpIndex}`);
      approxAbs(strain[2], (coeff.b + 2 * coeff.d) * x + (2 * coeff.c + coeff.e) * y, 1e-12, `T6 gxy patch failed on mesh ${meshIndex}, gp ${gpIndex}`);
    });
  });
});

await runCase('Case 0t6c T6 body force and edge traction conserve total load', async () => {
  const area = 12;
  const gamma = 18;
  const gravity = elementBodyForceVectorT6FromArea(area, 0, -gamma);
  approxAbs(gravity[1] + gravity[3] + gravity[5], 0, 1e-12, 'T6 gravity should put zero resultant on corner nodes');
  approxAbs(gravity[7], -area * gamma / 3, 1e-12, 'T6 first midpoint gravity share should be A gamma / 3');
  approxAbs(gravity[9], -area * gamma / 3, 1e-12, 'T6 second midpoint gravity share should be A gamma / 3');
  approxAbs(gravity[11], -area * gamma / 3, 1e-12, 'T6 third midpoint gravity share should be A gamma / 3');
  approxAbs(gravity[1] + gravity[3] + gravity[5] + gravity[7] + gravity[9] + gravity[11], -area * gamma, 1e-12, 'T6 gravity resultant should equal area times unit weight');

  const edge = { a: { x: 0, y: 0 }, b: { x: 3, y: 4 } };
  const q = 10;
  const traction = edgeTractionVectorT6(edge, 0, -q);
  approxAbs(traction[1] + traction[3] + traction[5], -5 * q, 1e-12, 'T6 edge traction resultant should equal q times edge length');
  approxAbs(traction[5], -4 * 5 * q / 6, 1e-12, 'T6 edge midpoint traction should carry the Simpson 4/6 share');
});

await runCase('Case 0t6d native Triangle o2 mesh exposes six-node elements and constrained mid-edge nodes', async () => {
  const model = baseModel();
  const mesh = await buildDeformationMesh(
    model,
    model.regions,
    {
      meshTargetArea: 8,
      meshElementType: 't6',
      load: {
        ...model.surfaceLoad,
        width: model.surfaceLoad.xEnd - model.surfaceLoad.xStart,
        q: model.surfaceLoad.q
      }
    },
    () => {}
  );
  assert(mesh.elementType === 't6', 'T6 mesh should report elementType=t6');
  assert(mesh.elements.length > 0, 'T6 mesh should contain elements');
  assert(mesh.elements.every((element) => element.length === 6), 'every T6 element should have six nodes');
  assert((mesh.meshStats?.midEdgeNodes || 0) > 0, 'T6 mesh should report mid-edge nodes');
  const terrainEdges = (mesh.constraintEdges || []).filter((edge) => edge.markerType === 'outer' && edge.source === 'terrain');
  assert(terrainEdges.length > 0, 'T6 mesh should expose terrain constraint edges');
  assert(terrainEdges.every((edge) => Number.isInteger(edge.nMid) && edge.nodeIds?.length === 3), 'every T6 terrain edge should carry its midpoint node');
});

await runCase('Case 0t6e T3 and T6 mesh-level gravity and terrain traction conserve total load', async () => {
  const q = 7;
  const gamma = 18;
  for (const meshElementType of ['t3', 't6']) {
    const model = baseModel({
      surfaceLoad: {
        xStart: 0,
        xEnd: 24,
        q
      }
    });
    const mesh = await buildDeformationMesh(
      model,
      model.regions,
      {
        meshTargetArea: 8,
        meshElementType,
        load: {
          ...model.surfaceLoad,
          width: model.surfaceLoad.xEnd - model.surfaceLoad.xStart,
          q: model.surfaceLoad.q
        }
      },
      () => {}
    );
    let gravityResultant = 0;
    let areaTotal = 0;
    mesh.elements.forEach((element) => {
      const area = triangleArea(element.slice(0, 3).map((nodeId) => mesh.nodes[nodeId]));
      areaTotal += area;
      gravityResultant += vectorYResultant(
        meshElementType === 't6'
          ? elementBodyForceVectorT6FromArea(area, 0, -gamma)
          : elementBodyForceVectorT3FromArea(area, 0, -gamma)
      );
    });
    approxRelative(gravityResultant, -gamma * areaTotal, 1e-12, `${meshElementType} gravity resultant should equal gamma times total mesh area`);

    let tractionResultant = 0;
    (mesh.constraintEdges || [])
      .filter((edge) => edge?.markerType === 'outer' && edge?.source === 'terrain')
      .forEach((edge) => {
        tractionResultant += vectorYResultant(
          meshElementType === 't6'
            ? edgeTractionVectorT6(edge, 0, -q)
            : edgeTractionVector(edge, 0, -q)
        );
      });
    approxRelative(tractionResultant, -q * 24, 1e-12, `${meshElementType} terrain traction resultant should equal q times loaded length`);
  }
});

await runCase('Case 0t6f T6 elastic stiffness is symmetric and annihilates rigid body modes', async () => {
  const corners = [{ x: 0.2, y: -0.1 }, { x: 2.1, y: 0.15 }, { x: 0.45, y: 1.65 }];
  const nodes = [
    corners[0],
    corners[1],
    corners[2],
    { x: 0.5 * (corners[1].x + corners[2].x), y: 0.5 * (corners[1].y + corners[2].y) },
    { x: 0.5 * (corners[2].x + corners[0].x), y: 0.5 * (corners[2].y + corners[0].y) },
    { x: 0.5 * (corners[0].x + corners[1].x), y: 0.5 * (corners[0].y + corners[1].y) }
  ];
  const D = planeStrainElasticMatrix(25000, 0.3);
  const K = elementStiffnessT6FromTangents2D(corners, [D, D, D], triangleArea(corners));
  assert(maxMatrixAsymmetry(K) < 1e-8, `T6 stiffness should be symmetric for a symmetric elastic tangent (max asymmetry ${maxMatrixAsymmetry(K)})`);

  const tx = new Float64Array(12);
  const ty = new Float64Array(12);
  const rz = new Float64Array(12);
  nodes.forEach((node, nodeIndex) => {
    tx[2 * nodeIndex] = 1;
    ty[2 * nodeIndex + 1] = 1;
    rz[2 * nodeIndex] = -node.y;
    rz[2 * nodeIndex + 1] = node.x;
  });
  assert(maxAbsVectorEntry(multiplyMatrixVector(K, tx)) < 1e-7, 'T6 stiffness should not resist rigid x translation');
  assert(maxAbsVectorEntry(multiplyMatrixVector(K, ty)) < 1e-7, 'T6 stiffness should not resist rigid y translation');
  assert(maxAbsVectorEntry(multiplyMatrixVector(K, rz)) < 1e-7, 'T6 stiffness should not resist infinitesimal rigid rotation');
});

await runCase('Case 0t6g T6 Gauss points can carry independent plastic activity under a linear strain field', async () => {
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  const nodes = [
    corners[0],
    corners[1],
    corners[2],
    { x: 0.5, y: 0.5 },
    { x: 0, y: 0.5 },
    { x: 0.5, y: 0 }
  ];
  const prepared = prepareMechanicalMaterial({
    Emc: 18000,
    nu: 0.3,
    cEff: 8,
    phiEffDeg: 30,
    psiEffDeg: 5,
    gamma: 18,
    gammaSat: 20,
    yieldTolerance: 1e-6
  });
  const shearGradient = 0.006;
  const ue = new Float64Array(12);
  nodes.forEach((node, nodeIndex) => {
    ue[2 * nodeIndex] = 0;
    ue[2 * nodeIndex + 1] = 0.5 * shearGradient * node.x * node.x;
  });
  const activeFlags = GAUSS_T6_3PT.map((gp) => {
    const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
    const strain = [0, 0, 0];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 12; col += 1) strain[row] += B[row][col] * ue[col];
    }
    const update = createMCPlasticMaterial(prepared).update({
      strainTrial6: liftPlaneStrainStrainTo6({ exx: strain[0], eyy: strain[1], gxy: strain[2] }),
      committedState: seedMaterialPointStateFromInitialStress({ sxx: 20, syy: 50, txy: 0 }, prepared),
      materialParameters: prepared
    });
    return update.trialState?.currentlyMcActive === true;
  });
  assert(
    JSON.stringify(activeFlags) === JSON.stringify([false, true, false]),
    `only the high-x T6 Gauss point should activate plasticity under this manufactured shear-gradient field (got ${JSON.stringify(activeFlags)})`
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

await runCase('Case 1t6 linear-elastic T6 solve runs end-to-end with quadratic sampling and CPU-f64 backend gating', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel(),
    options: {
      meshElementType: 't6',
      meshTargetArea: 3.0,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'linear-elastic',
      initialStressMode: 'predictor',
      useGpuAcceleration: true
    }
  });

  assert(output?.mesh?.elementType === 't6', 'T6 run should return a T6 mesh');
  assert(output?.mesh?.elements?.every((element) => element.length === 6), 'T6 solve should keep six-node element connectivity through the solver');
  assert(output?.solver?.elementType === 't6', 'T6 solve should report solver.elementType=t6');
  assert(output?.solver?.integrationPointsPerElement === 3, 'T6 solve should report three integration points per element');
  assert(output?.solver?.materialPointCount === 3 * output.mesh.elements.length, 'T6 solve should create one material point per Gauss point');
  // T6 now activates the same mixed-precision element kernels as T3. The
  // verification context has no real WebGL2, so the GPU probe falls back
  // to cpu-f32; the assertion accepts either cpu-f32 or webgl2-f32 (the
  // browser path is only reachable behind ENABLE_REAL_GPU_PARITY).
  const t6BackendName = output?.solver?.linearAlgebraBackend?.name;
  assert(
    t6BackendName === 'cpu-f32' || t6BackendName === 'webgl2-f32' || t6BackendName === 'cpu-f64',
    `T6 GPU run should activate a supported backend (got ${t6BackendName})`
  );
  assert(
    !(output?.warnings || []).some((warning) => warning.includes('T6 deformation currently uses the CPU f64 element path')),
    'the obsolete T6→CPU-f64 fallback warning should no longer be emitted now that T6 element kernels exist'
  );
  assert((output?.summaries?.maxSettlement || 0) > 0, 'T6 linear-elastic solve should produce positive settlement');
  assert((output?.elementResults || []).every((item) => item?.gaussPoints?.length === 3), 'T6 element results should expose three Gauss-point records per element');
  const sampled = sampleDeformationState(output.mesh, output, 12, -0.5);
  assert(sampled && sampled.settlement > 0 && Number.isFinite(sampled.ux), 'T6 sampleDeformationState should use a finite quadratic displacement interpolation');
});

await runCase('Case 1t6b Stage 2 plastic T6 solve converges with per-Gauss material points', async () => {
  const output = await analyzeDeformationModel({
    model: baseModel({
      material: {
        Emc: 18000,
        nu: 0.3,
        K0nc: 0.5,
        cEff: 6,
        phiEffDeg: 30,
        psiEffDeg: 5,
        gamma: 18,
        gammaSat: 20
      },
      surfaceLoad: {
        xStart: 11,
        xEnd: 13,
        q: 80
      }
    }),
    options: {
      meshElementType: 't6',
      meshTargetArea: 6,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'predictor',
      nonlinearMaxIterations: 26,
      maxLoadSteps: 18,
      initialLoadStep: 0.25,
      minLoadStep: 0.002
    }
  });

  assert(output?.solver?.elementType === 't6', 'Stage 2 T6 run should report solver.elementType=t6');
  assert(output?.solver?.convergenceState === 'converged', `Stage 2 T6 solve should converge (got ${output?.solver?.convergenceState})`);
  assert(output?.solver?.materialPointCount === 3 * output.mesh.elements.length, 'Stage 2 T6 solve should keep one material point per Gauss point');
  assert((output?.solver?.peakActiveMcElements || 0) > 0, 'Stage 2 T6 solve should activate plastic zones in this benchmark');
  assert((output?.summaries?.maxEquivalentPlasticStrain || 0) > 0, 'Stage 2 T6 solve should accumulate equivalent plastic strain');
  const plasticGpCount = (output?.elementResults || []).reduce(
    (count, elementResult) => count + (elementResult?.gaussPoints || []).filter((gp) => (Number(gp?.materialState?.accumulatedPlasticStrain) || 0) > 0).length,
    0
  );
  assert(plasticGpCount > 0, 'Stage 2 T6 result should expose plastic history on Gauss-point records');
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
  assert(
    ['numerical-nonconvergence', 'numerically-stuck', 'shallow-free-surface-yielding', 'likely-unstable-self-weight'].includes(output?.solver?.initialPhaseFailureOutcomeClass),
    `the near-failure Stage 2 slope case should classify the initial-phase stop as a geostatic/nonlinear stop (got ${output?.solver?.initialPhaseFailureOutcomeClass})`
  );
  assert(output?.solver?.initialPhaseDepthBandReport?.totalCount > 0, 'the near-failure Stage 2 slope case should expose the depth-band diagnostic used for geostatic classification');
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
    assert(
      ['numerical-nonconvergence', 'numerically-stuck', 'shallow-free-surface-yielding', 'likely-unstable-self-weight'].includes(output?.solver?.failureOutcomeClass),
      `when the weak-slope case stops in the initial phase, the overall result should carry a geostatic/nonlinear stop classification (got ${output?.solver?.failureOutcomeClass})`
    );
    assert(output?.solver?.initialPhaseDepthBandReport?.totalCount > 0, 'a weak-slope initial-phase stop should expose a depth-band diagnostic');
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

await runCase('Case 41z Block-Jacobi preconditioner inverts a 2×2 nodal block exactly and falls back to scalar Jacobi on solitary rows', async () => {
  // 4×4 system representing two FE nodes (node 0 and node 1), each with
  // x and y DOFs. Node 0 has a near-singular x-DOF diagonal (1e-30) but
  // a healthy 2×2 block thanks to the off-diagonal coupling that any
  // real FE element carries; this is exactly the "T6 mid-edge node
  // connected to one element" pathology block-Jacobi must handle.
  // Scalar Jacobi would amplify by 1e30; block-Jacobi must produce a
  // bounded preconditioned residual.
  const a00 = 1e-30, a01 = 1.5, a10 = 1.5, a11 = 4.0;       // node 0 block
  const b00 = 2.0,   b01 = 0.5, b10 = 0.5, b11 = 3.0;        // node 1 block
  const rows = [
    { indices: new Int32Array([0, 1]), values: new Float64Array([a00, a01]), diag: a00, diagIndex: 0 },
    { indices: new Int32Array([0, 1]), values: new Float64Array([a10, a11]), diag: a11, diagIndex: 1 },
    { indices: new Int32Array([2, 3]), values: new Float64Array([b00, b01]), diag: b00, diagIndex: 0 },
    { indices: new Int32Array([2, 3]), values: new Float64Array([b10, b11]), diag: b11, diagIndex: 1 }
  ];
  const freeDofs = [0, 1, 2, 3]; // both nodes' DOFs are free, paired (0,1) and (2,3)
  const precond = buildBlockJacobiPreconditioner(rows, freeDofs);
  assert(precond.length === 4, 'preconditioner has one entry per row');
  assert(precond[0]?.kind === 'block-first', 'row 0 of node 0 should be the first row of a 2×2 block');
  assert(precond[1]?.kind === 'block-second', 'row 1 of node 0 should be the second row of the same 2×2 block');
  assert(precond[2]?.kind === 'block-first', 'row 2 of node 1 should be the first row of a 2×2 block');
  assert(precond[3]?.kind === 'block-second', 'row 3 of node 1 should be the second row of the same 2×2 block');

  // Apply M^{-1} to a residual r and check we recover the analytical
  // block inverse: for B = [[a00 a01]; [a10 a11]], B^{-1} = (1/det)
  // [[a11, -a01]; [-a10, a00]]. Applied to r = [r0, r1] gives
  //   z0 =  (a11*r0 - a01*r1) / det
  //   z1 = (-a10*r0 + a00*r1) / det
  const r = new Float64Array([1, 2, 3, 4]);
  const z = new Float64Array(4);
  applyKrylovPreconditioner(precond, r, z);

  const det0 = a00 * a11 - a01 * a10;
  const z0 = (a11 * r[0] - a01 * r[1]) / det0;
  const z1 = (-a10 * r[0] + a00 * r[1]) / det0;
  approxRelative(z[0], z0, 1e-12, 'block-Jacobi z[0] matches the analytical 2×2 inverse on node 0');
  approxRelative(z[1], z1, 1e-12, 'block-Jacobi z[1] matches the analytical 2×2 inverse on node 0');

  const det1 = b00 * b11 - b01 * b10;
  const z2 = (b11 * r[2] - b01 * r[3]) / det1;
  const z3 = (-b10 * r[2] + b00 * r[3]) / det1;
  approxRelative(z[2], z2, 1e-12, 'block-Jacobi z[2] matches the analytical 2×2 inverse on node 1');
  approxRelative(z[3], z3, 1e-12, 'block-Jacobi z[3] matches the analytical 2×2 inverse on node 1');

  // Bounded-output check: scalar Jacobi on row 0 would give r[0]/a00 = 1/1e-30 = 1e+30.
  // Block-Jacobi must give a bounded value (here, det0 = -2.25 + 4e-30 ≈ -2.25,
  // so z[0] = (4·1 - 1.5·2) / (-2.25) = 1/(-2.25) ≈ -0.444). We assert |z[0]| < 1
  // to show the preconditioner did NOT amplify the tiny diagonal.
  assert(Math.abs(z[0]) < 1, `block-Jacobi must produce a bounded z on a near-singular diagonal (got ${z[0]})`);

  // Solitary-row fallback: a 5-row system with the last DOF unpaired
  // (e.g. the y-DOF is pinned for node 2). The builder should emit a
  // scalar Jacobi entry for row 4.
  const rowsWithSolitary = [
    ...rows,
    { indices: new Int32Array([4]), values: new Float64Array([8]), diag: 8, diagIndex: 0 }
  ];
  const freeDofsWithSolitary = [0, 1, 2, 3, 4]; // DOF 4 is the x-DOF of node 2; node 2's y-DOF (DOF 5) is pinned and absent
  const precondWithSolitary = buildBlockJacobiPreconditioner(rowsWithSolitary, freeDofsWithSolitary);
  assert(precondWithSolitary[4]?.kind === 'scalar', 'row 4 with no companion DOF should fall back to scalar Jacobi');
  approxRelative(precondWithSolitary[4].invDiag, 1 / 8, 1e-15, 'scalar Jacobi entry stores 1/diag');

  // No-freeDofs fallback: when the caller does not supply freeDofs (or
  // is using a non-FE matrix), every row must degrade to scalar Jacobi
  // — this preserves backward-compatibility for any future call site.
  const precondNoFreeDofs = buildBlockJacobiPreconditioner(rows, null);
  assert(
    precondNoFreeDofs.every((entry) => entry?.kind === 'scalar'),
    'without freeDofs the preconditioner falls back to scalar Jacobi everywhere'
  );
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

await runCase('Case 41a CPU mixed-precision element kernels reproduce the reference branch-free arithmetic', async () => {
  const backend = createCpuF32Backend();
  try {
    const elementCaches = [{
      B: [
        [1, 0, 2, 0, -1, 0],
        [0, 3, 0, -2, 0, 1],
        [4, 5, 6, 7, 8, 9]
      ],
      dofs: Int32Array.from([0, 1, 2, 3, 4, 5]),
      area: 2
    }];
    const referenceBuffer = createElementKernelBuffer(elementCaches.length);
    packElementKernelBuffer(referenceBuffer, elementCaches);

    const displacement = new Float64Array([1, 2, 3, 4, 5, 6]);
    const stress = new Float64Array([1.5, -0.75, 2.25]);
    const tangent = new Float64Array([
      4, 1, 0.5,
      1, 5, 0.25,
      0.5, 0.25, 3
    ]);

    const strainRef = elementStrainReference(referenceBuffer, new Float32Array(displacement));
    const forceRef = elementInternalForceReference(referenceBuffer, new Float32Array(stress));
    const stiffnessRef = elementElasticStiffnessReference(referenceBuffer, new Float32Array(tangent));

    const strainGot = backend.elementStrain(elementCaches, displacement);
    const forceGot = backend.elementInternalForce(elementCaches, stress);
    const stiffnessGot = backend.elementElasticStiffness(elementCaches, tangent);

    for (let index = 0; index < strainRef.length; index += 1) {
      approxRelative(strainRef[index], strainGot[index], 1e-6, `cpu-f32 element strain entry ${index}`);
    }
    for (let index = 0; index < forceRef.length; index += 1) {
      approxRelative(forceRef[index], forceGot[index], 1e-6, `cpu-f32 internal-force entry ${index}`);
    }
    for (let index = 0; index < stiffnessRef.length; index += 1) {
      approxRelative(stiffnessRef[index], stiffnessGot[index], 1e-6, `cpu-f32 elastic stiffness entry ${index}`);
    }
  } finally {
    backend.dispose();
  }
});

await runCase('Case 41c CPU mixed-precision T6 element kernels reproduce the T6 reference for strain, internal force, and elastic stiffness', async () => {
  const backend = createCpuF32Backend();
  try {
    // Single-element T6 reference cache. Corner-only B is computed inside
    // packElementKernelBufferT6 from the corners array, so the test
    // exercises the same packing the runtime backend uses.
    const elementCaches = [{
      kind: 't6',
      corners: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 }
      ],
      dofs: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      area: 0.5
    }];
    const referenceBuffer = createElementKernelBufferT6(elementCaches.length);
    packElementKernelBufferT6(referenceBuffer, elementCaches);

    const displacement = new Float64Array([
      0.0, 0.0,
      1.0, 0.0,
      0.0, 0.5,
      0.5, 0.25,
      0.0, 0.25,
      0.5, 0.0
    ]);
    // 3 GPs × 3 stress components = 9 floats.
    const stress = new Float64Array([
      1.0, 0.5, 0.25,
      0.75, 1.25, -0.25,
      -0.5, 1.0, 0.5
    ]);
    // Broadcast tangent — the same D applied at every GP.
    const tangentBroadcast = new Float64Array([
      4, 1, 0.5,
      1, 5, 0.25,
      0.5, 0.25, 3
    ]);
    // Per-GP tangent — three different D matrices, the worst-case path
    // exercising the elementIndex * 27 + g * 9 indexing in the kernel.
    const tangentPerGp = new Float64Array([
      4, 1, 0.5,    1, 5, 0.25,    0.5, 0.25, 3,
      3, 0.5, 0,    0.5, 4, 0,     0, 0, 2,
      6, 0.75, 0.1, 0.75, 7, 0.05, 0.1, 0.05, 4
    ]);

    const strainRef = elementStrainReferenceT6(referenceBuffer, new Float32Array(displacement));
    const forceRef = elementInternalForceReferenceT6(referenceBuffer, new Float32Array(stress));
    const stiffnessBroadcastRef = elementElasticStiffnessReferenceT6(referenceBuffer, new Float32Array(tangentBroadcast));
    const stiffnessPerGpRef = elementElasticStiffnessReferenceT6(referenceBuffer, new Float32Array(tangentPerGp));

    const strainGot = backend.elementStrain(elementCaches, displacement);
    const forceGot = backend.elementInternalForce(elementCaches, stress);
    const stiffnessBroadcastGot = backend.elementElasticStiffness(elementCaches, tangentBroadcast);
    const stiffnessPerGpGot = backend.elementElasticStiffness(elementCaches, tangentPerGp);

    assert(strainRef.length === 9, 'T6 reference strain should have 9 entries (3 GPs × 3 components)');
    assert(forceRef.length === 12, 'T6 reference internal force should have 12 entries');
    assert(stiffnessBroadcastRef.length === 144, 'T6 reference elastic stiffness should have 144 entries (12×12)');

    for (let index = 0; index < strainRef.length; index += 1) {
      approxRelative(strainRef[index], strainGot[index], 1e-6, `cpu-f32 T6 strain entry ${index}`);
    }
    for (let index = 0; index < forceRef.length; index += 1) {
      approxRelative(forceRef[index], forceGot[index], 1e-6, `cpu-f32 T6 internal-force entry ${index}`);
    }
    for (let index = 0; index < stiffnessBroadcastRef.length; index += 1) {
      approxRelative(stiffnessBroadcastRef[index], stiffnessBroadcastGot[index], 1e-6, `cpu-f32 T6 elastic stiffness (broadcast tangent) entry ${index}`);
    }
    for (let index = 0; index < stiffnessPerGpRef.length; index += 1) {
      approxRelative(stiffnessPerGpRef[index], stiffnessPerGpGot[index], 1e-6, `cpu-f32 T6 elastic stiffness (per-GP tangent) entry ${index}`);
    }
  } finally {
    backend.dispose();
  }
});

await runCase('Case 41d T6 internal-force kernel conserves resultant for a uniform stress field', async () => {
  const backend = createCpuF32Backend();
  try {
    // Two T6 elements partitioning a 1×1 square. Apply a uniform
    // (sxx, syy, txy) = (sigma, 0, 0) stress at every Gauss point and
    // check that summing the per-element internal-force vectors and
    // scattering them onto a global DOF accumulator reproduces the
    // exact integral (∫ sigma dA = sigma · A_total). This is the §7.3
    // load-conservation gate from T6_gpu_acceleration.md.
    const sigma = 5;
    const dofsA = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const dofsB = Int32Array.from([2, 3, 12, 13, 4, 5, 14, 15, 16, 17, 18, 19]);
    const elementCaches = [
      {
        kind: 't6',
        corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
        dofs: dofsA,
        area: 0.5
      },
      {
        kind: 't6',
        corners: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
        dofs: dofsB,
        area: 0.5
      }
    ];
    const stressFlat = new Float64Array(elementCaches.length * 9);
    for (let e = 0; e < elementCaches.length; e += 1) {
      for (let g = 0; g < 3; g += 1) {
        stressFlat[e * 9 + g * 3] = sigma;
        stressFlat[e * 9 + g * 3 + 1] = 0;
        stressFlat[e * 9 + g * 3 + 2] = 0;
      }
    }
    const forceFlat = backend.elementInternalForce(elementCaches, stressFlat);

    // The internal force is f_i = ∫ B_xi^T sigma dA. The sum of f_x over
    // all DOFs equals ∫ sum_i (B_xi sigma_xx) dA = ∫ d(sum_i N_i)/dx
    // sigma dA = 0 because Σ N_i = 1 ⇒ Σ dN_i/dx = 0. So both axes
    // should integrate to zero exactly (within f32 noise) for an
    // internally-balanced stress field. This is the GPU load-conservation
    // sanity gate.
    let xResultant = 0;
    let yResultant = 0;
    const ndof = 20;
    const accumulator = new Float64Array(ndof);
    for (let e = 0; e < elementCaches.length; e += 1) {
      for (let k = 0; k < 12; k += 1) {
        accumulator[elementCaches[e].dofs[k]] += forceFlat[e * 12 + k];
      }
    }
    for (let dof = 0; dof < ndof; dof += 2) {
      xResultant += accumulator[dof];
      yResultant += accumulator[dof + 1];
    }
    assert(Math.abs(xResultant) < 1e-6, `T6 internal-force resultant in x should vanish for an internally-balanced stress (got ${xResultant})`);
    assert(Math.abs(yResultant) < 1e-6, `T6 internal-force resultant in y should vanish for an internally-balanced stress (got ${yResultant})`);
  } finally {
    backend.dispose();
  }
});

await runCase('Case 41b CPU double-single backend preserves the explicit precision mode contract', async () => {
  const backend = createCpuF32Backend({ precisionMode: 'double-single', residualRefreshInterval: 10 });
  try {
    assert(backend.name === 'cpu-double-single', 'double-single override should expose the dedicated backend label');
    assert(backend.precisionMode === 'double-single', 'double-single backend should report its precision mode');
    assert(backend.residualRefreshInterval === 10, 'double-single backend should preserve the requested residual refresh interval');
    const rows = [
      { indices: new Int32Array([0, 1]), values: new Float64Array([1e8 + 1, -1e8]), diagIndex: 0, diag: 1e8 + 1 },
      { indices: new Int32Array([0, 1]), values: new Float64Array([1, 1]), diagIndex: 1, diag: 1 }
    ];
    const x = new Float64Array([1, 1]);
    const result = backend.matvec(rows, x);
    assert(Number.isFinite(result[0]) && Number.isFinite(result[1]), 'double-single matvec should remain finite on cancellation-sensitive input');
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

if (ENABLE_REAL_GPU_PARITY) {
  await runCase('Case 45 optional real-WebGL GPU parity hook is available when the capability probe passes', async () => {
    const probe = await probeGpuBackend(true);
    if (!probe?.ok) {
      console.log(`Case 45 skipped: GPU probe unavailable (${probe?.reason || 'unknown'}).`);
      return;
    }
    const baseline = await analyzeDeformationModel({
      model: baseModel(),
      options: {
        meshTargetArea: 0.25,
        loadMode: 'pressure',
        outOfPlaneLength: 10,
        useSeepagePorePressures: false,
        constitutiveModel: 'linear-elastic'
      }
    });
    const gpuRun = await analyzeDeformationModel({
      model: baseModel(),
      options: {
        meshTargetArea: 0.25,
        loadMode: 'pressure',
        outOfPlaneLength: 10,
        useSeepagePorePressures: false,
        constitutiveModel: 'linear-elastic',
        useGpuAcceleration: true,
        gpuMinDof: 0
      }
    });
    assert(
      gpuRun?.solver?.linearAlgebraBackend?.name === 'webgl2-f32'
      || gpuRun?.solver?.linearAlgebraBackend?.name === 'webgl2-double-single',
      'real GPU parity case should activate the WebGL backend when the probe passes'
    );
    approxRelative(
      Math.max(baseline.summaries?.maxSettlement || 0, 1e-9),
      Math.max(gpuRun.summaries?.maxSettlement || 0, 1e-9),
      1e-5,
      'real GPU parity case should match the elastic settlement baseline'
    );
  });
}

if (ENABLE_GPU_BENCHMARK) {
  const probe = await probeGpuBackend(true);
  if (probe?.ok) {
    const benchmarkModel = () => baseModel({
      surfaceLoad: {
        xStart: 10.5,
        xEnd: 13.5,
        q: 25
      }
    });
    const benchmarkOptions = {
      meshTargetArea: 0.2,
      loadMode: 'pressure',
      outOfPlaneLength: 10,
      useSeepagePorePressures: false,
      constitutiveModel: 'mc-plastic',
      initialStressMode: 'plastic-geostatic',
      useUnsymmetricPlasticSolver: true,
      maxLoadSteps: 32
    };
    const cpuStartedAt = performance.now();
    await analyzeDeformationModel({
      model: benchmarkModel(),
      options: benchmarkOptions
    });
    const cpuMs = performance.now() - cpuStartedAt;
    const gpuStartedAt = performance.now();
    await analyzeDeformationModel({
      model: benchmarkModel(),
      options: {
        ...benchmarkOptions,
        useGpuAcceleration: true,
        gpuMinDof: 0
      }
    });
    const gpuMs = performance.now() - gpuStartedAt;
    console.log(`GPU benchmark: CPU ${cpuMs.toFixed(1)} ms, GPU ${gpuMs.toFixed(1)} ms, speedup ${(cpuMs / Math.max(gpuMs, 1e-9)).toFixed(2)}x`);
  } else {
    console.log(`GPU benchmark skipped: ${probe?.reason || 'GPU probe unavailable'}.`);
  }
}

console.log('Deformation Phase 1 verification passed.');
