// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Build the `analyzeDeformationModel`-shaped result object from a WASM
// v2 solver output. The result reuses the same field structure consumers
// (sampleDeformationState, the report panel, contour rendering) read in
// the CPU JS path, so the two backends are interchangeable from the
// outside.

const GEOM_EPS = 1e-6;

function negateNormalAndShear(s) {
  return {
    sxx: -(Number(s?.sxx) || 0),
    syy: -(Number(s?.syy) || 0),
    txy: -(Number(s?.txy) || 0)
  };
}

function negateStress3D({ sxx, syy, szz, txy }) {
  return {
    sxx: -(Number(sxx) || 0),
    syy: -(Number(syy) || 0),
    szz: -(Number(szz) || 0),
    txy: -(Number(txy) || 0)
  };
}

function principalStress2D(s) {
  const sxx = Number(s?.sxx) || 0;
  const syy = Number(s?.syy) || 0;
  const txy = Number(s?.txy) || 0;
  const mean = 0.5 * (sxx + syy);
  const half = 0.5 * (sxx - syy);
  const r = Math.hypot(half, txy);
  return { s1: mean + r, s3: mean - r, mean, radius: r };
}

function strainAtGpFromU(elementCache, gp, U) {
  let exx = 0, eyy = 0, gxy = 0;
  const B = gp.B;
  const dofs = elementCache.dofs;
  for (let i = 0; i < dofs.length; i += 1) {
    const ui = Number(U[dofs[i]]) || 0;
    exx += B[0][i] * ui;
    eyy += B[1][i] * ui;
    gxy += B[2][i] * ui;
  }
  return { exx, eyy, gxy };
}

function applyPredictorToSolution(serviceDisp, predictor) {
  if (!predictor || !predictor.length) return serviceDisp;
  const out = new Float64Array(serviceDisp.length);
  for (let i = 0; i < serviceDisp.length; i += 1) {
    out[i] = serviceDisp[i] + (Number(predictor[i]) || 0);
  }
  return out;
}

function buildNodalDisplacementsFromVec(U, numNodes) {
  const out = new Array(numNodes);
  for (let i = 0; i < numNodes; i += 1) {
    out[i] = { ux: Number(U[2 * i]) || 0, uy: Number(U[2 * i + 1]) || 0 };
  }
  return out;
}

function subtractDisplacementFields(total, baseline) {
  const n = Math.max(total.length, baseline.length);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = {
      ux: (Number(total[i]?.ux) || 0) - (Number(baseline[i]?.ux) || 0),
      uy: (Number(total[i]?.uy) || 0) - (Number(baseline[i]?.uy) || 0)
    };
  }
  return out;
}

export function buildWasmDeformationResult({
  mesh,
  load,
  warnings,
  elementCaches,
  options,
  wasmResult,
  startedAt,
  predictorSolution,
  initialField,
  porePressureByIntegrationPoint,
  analysisType
}) {
  const numNodes = mesh.nodes.length;
  const numElements = mesh.elements.length;
  const elementType = mesh.elementType === 't6' ? 't6' : 't3';

  // Stitch the predictor displacement (from the elastic gravity step,
  // computed on the JS side) back into the WASM-produced fields so
  // consumers see the same total-displacement values they get from the
  // CPU plastic path.
  const totalServiceU = applyPredictorToSolution(wasmResult.serviceDisplacements, predictorSolution);
  const totalGeostaticU = applyPredictorToSolution(wasmResult.geostaticDisplacements, predictorSolution);
  const serviceIncrementU = wasmResult.serviceDisplacements.map((v, i) =>
    v - (wasmResult.geostaticDisplacements[i] || 0)
  );

  const totalNodalDisplacements = buildNodalDisplacementsFromVec(totalServiceU, numNodes);
  const initialNodalDisplacements = buildNodalDisplacementsFromVec(totalGeostaticU, numNodes);
  const serviceIncrementNodalDisplacements = buildNodalDisplacementsFromVec(serviceIncrementU, numNodes);

  // For the visible "nodalDisplacements" use the service increment when a
  // surface load is present (engineering convention: subtract the
  // geostatic baseline), and the total displacement otherwise.
  const hasSurfaceLoad = !!load && Math.abs((Number(load?.q) || 0) * ((Number(load?.xEnd) || 0) - (Number(load?.xStart) || 0))) > 1e-9;
  const displayUsesServiceIncrement = hasSurfaceLoad;
  const nodalDisplacements = displayUsesServiceIncrement
    ? serviceIncrementNodalDisplacements
    : totalNodalDisplacements;

  // Per-element results. We use the wasmResult per-Gauss-point data
  // directly (already correct in tension-positive Voigt-6); for display
  // the CPU path flips normal-stress / shear sign with
  // `negateNormalAndShear`, so we do the same.
  const elementResults = new Array(numElements);
  let activeMcElementCount = 0;
  let tensionCutoffElementCount = 0;
  let peakEta = 0;

  for (let elementIndex = 0; elementIndex < numElements; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache?.cellIndex] || null;
    const gpCount = elementCache?.numGaussPoints || 1;

    let avgStrain = { exx: 0, eyy: 0, gxy: 0 };
    let avgEffective = { sxx: 0, syy: 0, txy: 0 };
    let avgEffective3D = { sxx: 0, syy: 0, szz: 0, txy: 0 };
    let avgInitialEffective = { sxx: 0, syy: 0, txy: 0 };
    let avgInitialEffective3D = { sxx: 0, syy: 0, szz: 0, txy: 0 };
    let avgPorePressure = 0;
    let maxEtaInElement = 0;
    let etaSumWeighted = 0;
    let etaWeight = 0;
    let elementPlasticActive = false;
    let elementTensionActive = false;
    let elementPlasticEver = false;
    let maxAccumulatedPlastic = 0;
    let maxServiceEquivalentPlasticIncrement = 0;
    let maxSafetyEquivalentPlasticIncrement = 0;
    const gaussPoints = [];

    const ips = elementCache?.integrationPoints || [];
    for (let g = 0; g < ips.length; g += 1) {
      const gp = ips[g];
      const wasm = wasmResult.gpStates[gp.globalIndex];
      if (!wasm) continue;
      const weight = ips.length > 0 ? (1.0 / ips.length) : 1;
      const accumulatedPlasticStrain = Number(wasm.accumulatedPlasticStrain) || 0;
      const geostaticAccumulatedPlasticStrain = Number(wasm.geostaticAccumulatedPlasticStrain) || 0;
      const comparisonAccumulatedPlasticStrain = Number.isFinite(Number(wasm.comparisonAccumulatedPlasticStrain))
        ? Number(wasm.comparisonAccumulatedPlasticStrain)
        : geostaticAccumulatedPlasticStrain;
      const serviceEquivalentPlasticIncrement = Math.max(
        accumulatedPlasticStrain - geostaticAccumulatedPlasticStrain,
        0
      );
      const safetyEquivalentPlasticIncrement = analysisType === 'safety-cphi'
        ? Math.max(accumulatedPlasticStrain - comparisonAccumulatedPlasticStrain, 0)
        : 0;

      const eff2D = negateNormalAndShear({ sxx: wasm.stress.sxx, syy: wasm.stress.syy, txy: wasm.stress.sxy });
      const eff3D = negateStress3D({ sxx: wasm.stress.sxx, syy: wasm.stress.syy, szz: wasm.stress.szz, txy: wasm.stress.sxy });
      const ref2D = negateNormalAndShear({ sxx: wasm.referenceStress.sxx, syy: wasm.referenceStress.syy, txy: wasm.referenceStress.sxy });
      const ref3D = negateStress3D({ sxx: wasm.referenceStress.sxx, syy: wasm.referenceStress.syy, szz: wasm.referenceStress.szz, txy: wasm.referenceStress.sxy });

      avgEffective.sxx += weight * eff2D.sxx;
      avgEffective.syy += weight * eff2D.syy;
      avgEffective.txy += weight * eff2D.txy;
      avgEffective3D.sxx += weight * eff3D.sxx;
      avgEffective3D.syy += weight * eff3D.syy;
      avgEffective3D.szz += weight * eff3D.szz;
      avgEffective3D.txy += weight * eff3D.txy;
      avgInitialEffective.sxx += weight * ref2D.sxx;
      avgInitialEffective.syy += weight * ref2D.syy;
      avgInitialEffective.txy += weight * ref2D.txy;
      avgInitialEffective3D.sxx += weight * ref3D.sxx;
      avgInitialEffective3D.syy += weight * ref3D.syy;
      avgInitialEffective3D.szz += weight * ref3D.szz;
      avgInitialEffective3D.txy += weight * ref3D.txy;
      avgPorePressure += weight * (Number(wasm.porePressure) || 0);

      const strain = strainAtGpFromU(elementCache, gp, totalServiceU);
      avgStrain.exx += weight * strain.exx;
      avgStrain.eyy += weight * strain.eyy;
      avgStrain.gxy += weight * strain.gxy;

      if (wasm.plasticActive) elementPlasticActive = true;
      if (wasm.tensionActive) elementTensionActive = true;
      if (wasm.plasticEverActive) elementPlasticEver = true;
      if (wasm.eta > maxEtaInElement) maxEtaInElement = wasm.eta;
      if (!wasm.tensionActive && Number.isFinite(wasm.eta)) {
        etaSumWeighted += weight * wasm.eta;
        etaWeight += weight;
      }
      if (accumulatedPlasticStrain > maxAccumulatedPlastic) {
        maxAccumulatedPlastic = accumulatedPlasticStrain;
      }
      if (serviceEquivalentPlasticIncrement > maxServiceEquivalentPlasticIncrement) {
        maxServiceEquivalentPlasticIncrement = serviceEquivalentPlasticIncrement;
      }
      if (safetyEquivalentPlasticIncrement > maxSafetyEquivalentPlasticIncrement) {
        maxSafetyEquivalentPlasticIncrement = safetyEquivalentPlasticIncrement;
      }

      gaussPoints.push({
        gpIndex: gp.gpIndex,
        integrationPointIndex: gp.globalIndex,
        x: gp.x,
        y: gp.y,
        areaWeight: gp.areaWeight,
        strain,
        stress2D: eff2D,
        effectiveStress: eff2D,
        mc: { eta: wasm.eta },
        tensionCutoffActive: wasm.tensionActive,
        materialDiagnostics: {
          etaMcFinal: wasm.eta,
          tensionCutoffActive: wasm.tensionActive,
          currentlyMcActive: wasm.plasticActive,
          serviceEquivalentPlasticIncrement,
          safetyEquivalentPlasticIncrement
        },
        materialState: {
          accumulatedPlasticStrain,
          currentlyMcActive: wasm.plasticActive,
          hasEverExceededMc: wasm.plasticEverActive
        }
      });
    }

    if (elementPlasticActive) activeMcElementCount += 1;
    if (elementTensionActive) tensionCutoffElementCount += 1;
    if (maxEtaInElement > peakEta) peakEta = maxEtaInElement;

    const porePressure = Math.max(avgPorePressure, 0);
    const initialTotal = {
      sxx: avgInitialEffective.sxx + porePressure,
      syy: avgInitialEffective.syy + porePressure,
      txy: avgInitialEffective.txy
    };
    const initialTotal3D = {
      sxx: avgInitialEffective3D.sxx + porePressure,
      syy: avgInitialEffective3D.syy + porePressure,
      szz: avgInitialEffective3D.szz + porePressure,
      txy: avgInitialEffective3D.txy
    };
    const totalStress = {
      sxx: avgEffective.sxx + porePressure,
      syy: avgEffective.syy + porePressure,
      txy: avgEffective.txy
    };
    const totalStress3D = {
      sxx: avgEffective3D.sxx + porePressure,
      syy: avgEffective3D.syy + porePressure,
      szz: avgEffective3D.szz + porePressure,
      txy: avgEffective3D.txy
    };
    const stressIncrement = {
      sxx: avgEffective.sxx - avgInitialEffective.sxx,
      syy: avgEffective.syy - avgInitialEffective.syy,
      txy: avgEffective.txy - avgInitialEffective.txy
    };
    const principal = principalStress2D(avgEffective);
    const mc = { eta: etaWeight > 0 ? etaSumWeighted / etaWeight : 0 };

    elementResults[elementIndex] = {
      elementIndex,
      regionIndex: cell?.regionIndex ?? -1,
      area: elementCache?.area || 0,
      centroid: elementCache?.centroid || cell?.centroid || { x: 0, y: 0 },
      strain: avgStrain,
      stressIncrement,
      stressIncrementGeo: stressIncrement,
      porePressure,
      initialEffectiveStress: avgInitialEffective,
      initialEffectiveStress3D: avgInitialEffective3D,
      initialTotalStress: initialTotal,
      initialTotalStress3D: initialTotal3D,
      effectiveStress: avgEffective,
      effectiveStress3D: avgEffective3D,
      totalStress,
      totalStress3D,
      principal,
      mc,
      gaussPoints,
      materialState: {
        accumulatedPlasticStrain: maxAccumulatedPlastic,
        currentlyMcActive: elementPlasticActive,
        hasEverExceededMc: elementPlasticEver,
        activeYieldSurface: elementTensionActive ? 'TENSION' : (elementPlasticActive ? 'MC_FACE' : 'NONE'),
        exactBranchKind: elementTensionActive ? 'TENSION_FACE_T3' : (elementPlasticActive ? 'MC_FACE_F13' : 'ELASTIC')
      },
      materialDiagnostics: {
        constitutiveModel: options.constitutiveModel === 'linear-elastic'
          ? 'linear-elastic'
          : options.constitutiveModel === 'mc-plastic'
            ? 'mc-plastic'
            : 'mc-reduced-stiffness',
        currentlyMcActive: elementPlasticActive,
        hasEverExceededMc: elementPlasticEver,
        tensionCutoffActive: elementTensionActive,
        etaMcFinal: maxEtaInElement,
        etaMcContour: etaWeight > 0 ? etaSumWeighted / etaWeight : 0,
        serviceEquivalentPlasticIncrement: maxServiceEquivalentPlasticIncrement,
        safetyEquivalentPlasticIncrement: maxSafetyEquivalentPlasticIncrement
      }
    };
  }

  // Terrain settlement profile.
  const terrainNodeIds = new Set();
  (mesh.constraintEdges || []).forEach((edge) => {
    if (edge?.markerType !== 'outer' || edge?.source !== 'terrain') return;
    (edge.nodeIds || [edge.n1, edge.n2]).forEach((nodeId) => terrainNodeIds.add(nodeId));
  });
  const terrainSettlementProfile = [...terrainNodeIds]
    .map((nodeId) => ({
      x: mesh.nodes[nodeId]?.x ?? 0,
      y: mesh.nodes[nodeId]?.y ?? 0,
      settlement: -(nodalDisplacements[nodeId]?.uy || 0),
      ux: nodalDisplacements[nodeId]?.ux || 0
    }))
    .sort((a, b) => a.x - b.x || b.y - a.y);

  let maxSettlement = 0;
  let maxHorizontalDisplacement = 0;
  let maxInitialSettlement = 0;
  for (let i = 0; i < nodalDisplacements.length; i += 1) {
    const settlement = -Number(nodalDisplacements[i].uy) || 0;
    if (settlement > maxSettlement) maxSettlement = settlement;
    const u = Math.abs(Number(nodalDisplacements[i].ux) || 0);
    if (u > maxHorizontalDisplacement) maxHorizontalDisplacement = u;
  }
  for (let i = 0; i < initialNodalDisplacements.length; i += 1) {
    const s = -Number(initialNodalDisplacements[i].uy) || 0;
    if (s > maxInitialSettlement) maxInitialSettlement = s;
  }

  const summaries = {
    maxSettlement,
    maxHorizontalDisplacement,
    maxInitialSettlement,
    serviceSettlementIncrement: hasSurfaceLoad ? maxSettlement : 0,
    safetySettlementIncrement: 0,
    activeMcElementCount,
    tensionCutoffElementCount,
    peakMcEta: peakEta,
    elementCount: numElements,
    nodeCount: numNodes
  };

  const summary = wasmResult.summary;
  const safety = wasmResult.safety || {};
  const isSafety = analysisType === 'safety-cphi';
  const safetyTrials = Array.isArray(safety.trials) ? safety.trials : [];
  const safetyCurve = Array.isArray(safety.curve) ? safety.curve : [];
  const safetyTrialTargets = Array.isArray(safety.trialTargets) ? safety.trialTargets : [];
  const decodedSafetyResult = safety.safetyResult || {
    finalizationMode: 'legacy-bracket',
    finalization: {
      status: 'not-run',
      factorOfSafety: Number(safety.factorOfSafetyLower) || 1,
      factorOfSafetyLower: Number(safety.factorOfSafetyLower) || 1,
      factorOfSafetyUpper: Number.isFinite(Number(safety.factorOfSafetyUpper))
        ? Number(safety.factorOfSafetyUpper)
        : null,
      factorOfSafetyIsOpenEnded: false,
      bracketWidth: null,
      strengthRetained: Number(safety.strengthRetained) || 1,
      displayedSigmaMsf: Number(safety.factorOfSafetyLower) || 1,
      plateauDetected: false,
      plateauWindowStart: null,
      plateauWindowEnd: null
    },
    mechanism: { status: 'none', score: 0 },
    curve: [],
    trialTargets: []
  };
  const displayedSafetyTrial = isSafety
    ? (
        [...safetyTrialTargets].reverse().find((trial) => trial?.displayed === true) ||
        [...safetyTrials].reverse().find((trial) =>
          trial?.converged === false && Number.isFinite(Number(trial?.committed))
        )
      )
    : null;
  const safetyDisplayedSigmaMsf = isSafety
    ? (Number.isFinite(Number(displayedSafetyTrial?.committed))
        ? Number(displayedSafetyTrial.committed)
        : Number(safety.factorOfSafetyLower) || 1)
    : null;
  const resultSafetyObject = isSafety
    ? {
        ...decodedSafetyResult,
        finalization: {
          ...decodedSafetyResult.finalization,
          displayedSigmaMsf: safetyDisplayedSigmaMsf
        },
        curve: safetyCurve,
        trialTargets: safetyTrialTargets
      }
    : {
        ...decodedSafetyResult,
        finalization: { ...decodedSafetyResult.finalization, status: 'not-run' },
        curve: [],
        trialTargets: []
      };
  const usesUnsymmetricPlasticKrylov =
    options.constitutiveModel === 'mc-plastic' && options.symmetrizeEpTangent !== true;

  return {
    mesh,
    load,
    warnings,
    nodalDisplacements,
    totalNodalDisplacements,
    initialNodalDisplacements,
    terrainSettlementProfile,
    elementResults,
    summaries,
    solver: {
      method: `wasm-cpu-${options.constitutiveModel}-plane-strain-${elementType}${isSafety ? '-safety-cphi' : ''}`,
      analysisType: analysisType || 'deformation',
      elementType,
      integrationPointsPerElement: elementType === 't6' ? 3 : 1,
      constitutiveModel: `${options.constitutiveModel}-material-point`,
      materialPointCount: wasmResult.numGpTotal,
      backend: 'wasm-cpu',
      initialStressMode: 'k0-nil-step',
      converged: summary.geostaticConverged && (summary.serviceConverged || !hasSurfaceLoad) && (!isSafety || safety.status === 1 || safety.status === 3),
      convergenceState: (summary.geostaticConverged && summary.serviceConverged) ? 'converged' : 'partial',
      acceptedLoadSteps: summary.serviceAccepted,
      rejectedLoadSteps: summary.serviceRejected,
      loadFactorCommitted: summary.finalLoadFactor,
      displayedLoadFactor: summary.finalLoadFactor,
      displayedStateMode: 'wasm-cpu',
      displayedLoadFactorMeaning: 'load',
      residualNorm: summary.residualNorm,
      relativeResidualNorm: 0,
      displacementCorrectionNorm: 0,
      relativeDisplacementCorrectionNorm: 0,
      finalActiveMcElements: summary.finalActiveCount,
      peakActiveMcElements: summary.finalActiveCount,
      finalTensionCutoffActiveElements: summary.finalTensionCount,
      peakTensionCutoffActiveElements: summary.finalTensionCount,
      peakMcEta: summary.maxEta,
      lastStateChanges: 0,
      freeDofs: 0,
      linearIterations: summary.cgIterations,
      nonlinearIterations: summary.newtonIterations,
      failureCode: (summary.geostaticConverged && summary.serviceConverged) ? '' : 'wasm-not-converged',
      failureOutcomeClass: (summary.geostaticConverged && summary.serviceConverged) ? 'success' : 'partial',
      failureReason: (summary.geostaticConverged && summary.serviceConverged) ? '' : 'Nonlinear iterations or load steps exhausted in WASM solver.',
      // Initial-phase / service-phase metadata.
      initialPhaseStarted: true,
      initialPhaseConvergenceState: summary.geostaticConverged ? 'converged' : 'partial',
      servicePhaseStarted: hasSurfaceLoad,
      servicePhaseConvergenceState: summary.serviceConverged ? 'converged' : 'partial',
      // Safety c-phi.
      safetyStarted: isSafety,
      safetyStatus: isSafety ? (['not-run', 'bracketed', 'mechanism-developed', 'no-failure-found'][safety.status] || 'unknown') : 'not-applicable',
      safetyBaseState: isSafety ? (hasSurfaceLoad ? 'end-of-service' : 'initial-equilibrium') : 'not-applicable',
      safetyFactorOfSafety: isSafety ? safety.factorOfSafetyLower : null,
      safetyFactorOfSafetyLower: isSafety ? safety.factorOfSafetyLower : null,
      safetyFactorOfSafetyUpper: isSafety ? safety.factorOfSafetyUpper : null,
      safetyStrengthRetained: isSafety ? safety.strengthRetained : null,
      safetyDisplayedSigmaMsf,
      safetyCommittedSigmaMsf: isSafety ? safety.factorOfSafetyLower : null,
      safetyTrialHistory: isSafety ? (safetyTrialTargets.length ? safetyTrialTargets : safetyTrials) : [],
      safetyTrialTargets: isSafety ? safetyTrialTargets : [],
      safetyCurve: isSafety ? safetyCurve : [],
      safetyResult: resultSafetyObject,
      safetyAcceptedContinuationSteps: isSafety ? safetyCurve.length : 0,
      safetyRejectedContinuationSteps: isSafety
        ? (safetyTrialTargets.length
            ? safetyTrialTargets.filter((trial) => trial?.converged === false).length
            : safetyTrials.filter((trial) => trial?.converged === false).length)
        : 0,
      linearAlgebraBackend: {
        name: 'wasm-cpu-f64',
        reason: 'opt-in WASM C++ kernel',
        precisionMode: 'f64',
        elementType,
        krylovPath: usesUnsymmetricPlasticKrylov ? 'gmres' : 'cg-bj',
        krylovCountsByPath: { 'cg-bj': summary.cgIterations },
        krylovCountsBySolver: { cg: summary.cgIterations },
        krylovFallbackReasons: {},
        worstTrueResidualMismatch: 0
      }
    },
    timing: { totalMs: performance.now() - (startedAt || performance.now()) }
  };
}
