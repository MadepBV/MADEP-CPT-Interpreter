// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Build the `analyzeDeformationModel`-shaped result object from a WASM
// v2 solver output. The result reuses the same field structure consumers
// (sampleDeformationState, the report panel, contour rendering) read in
// the CPU JS path, so the two backends are interchangeable from the
// outside.

import { buildSafetyMechanismSummary, emptySafetyMechanismSummary } from '../safety-mechanism.js';
import {
  buildSafetyFinalization,
  safetyStatusAliasFromFinalizationStatus
} from '../safety-finalization.js';

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

function wallFrameFromStations(stations, passiveSign = 1) {
  const first = stations?.[0];
  const last = stations?.[stations.length - 1];
  const dx = (Number(last?.x) || 0) - (Number(first?.x) || 0);
  const dy = (Number(last?.y) || 0) - (Number(first?.y) || 0);
  const length = Math.hypot(dx, dy);
  if (!(length > GEOM_EPS)) {
    const sign = passiveSign < 0 ? -1 : 1;
    return { t:{x:0, y:-1}, nPassive:{x:sign, y:0} };
  }
  const t = { x: dx / length, y: dy / length };
  const nRight = { x: -t.y, y: t.x };
  const sign = passiveSign < 0 ? -1 : 1;
  return {
    t,
    nPassive:{ x:nRight.x * sign, y:nRight.y * sign }
  };
}

function buildWallResultsFromWasm(wasmWallResults, predictorSolution, geostaticSolution) {
  return (wasmWallResults || []).map((wall) => ({
    wallIndex: wall.wallIndex,
    passiveSide: wall.passiveSide,
    passiveSign: wall.passiveSign,
    stations: (wall.stations || []).map((station) => {
      const predictorUx = Number(predictorSolution?.[2 * station.nodeId]) || 0;
      const predictorUy = Number(predictorSolution?.[2 * station.nodeId + 1]) || 0;
      const geostaticUx = Number(geostaticSolution?.[2 * station.nodeId]) || 0;
      const geostaticUy = Number(geostaticSolution?.[2 * station.nodeId + 1]) || 0;
      return {
        ...station,
        initialUx: predictorUx + geostaticUx,
        initialUy: predictorUy + geostaticUy,
        totalUx: (Number(station.ux) || 0) + predictorUx + geostaticUx,
        totalUy: (Number(station.uy) || 0) + predictorUy + geostaticUy
      };
    })
  })).map((wall) => {
    const stations = wall.stations || [];
    const frame = wallFrameFromStations(stations, wall.passiveSign);
    stations.forEach((station) => {
      const ux = Number(station.ux) || 0;
      const uy = Number(station.uy) || 0;
      const theta = Number(station.theta) || 0;
      station.uAxial = ux * frame.t.x + uy * frame.t.y;
      station.wPassive = ux * frame.nPassive.x + uy * frame.nPassive.y;
      station.thetaPassive = (wall.passiveSign < 0 ? -1 : 1) * theta;
    });
    const s_node = stations.map((station) => Number(station.s) || 0);
    const w_passive = stations.map((station) => Number(station.wPassive) || 0);
    const theta_passive = stations.map((station) => Number(station.thetaPassive) || 0);
    const s_midpoint = [];
    const N = [];
    const V_passive = [];
    const M_passive = [];
    for (let i = 0; i + 1 < stations.length; i += 1) {
      const a = stations[i];
      const b = stations[i + 1];
      s_midpoint.push(0.5 * ((Number(a.s) || 0) + (Number(b.s) || 0)));
      N.push(0.5 * ((Number(a.N) || 0) + (Number(b.N) || 0)));
      V_passive.push(0.5 * ((Number(a.VPassive) || 0) + (Number(b.VPassive) || 0)));
      M_passive.push(0.5 * ((Number(a.MPassive) || 0) + (Number(b.MPassive) || 0)));
    }
    return {
      ...wall,
      s_midpoint,
      N,
      V_passive,
      M_passive,
      s_node,
      w_passive,
      theta_passive
    };
  });
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
  geostatic,
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
  const wallResults = buildWallResultsFromWasm(
    wasmResult.wallResults,
    predictorSolution,
    wasmResult.geostaticDisplacements
  );

  // Per-element results. We use the wasmResult per-Gauss-point data
  // directly (already correct in tension-positive Voigt-6); for display
  // the CPU path flips normal-stress / shear sign with
  // `negateNormalAndShear`, so we do the same.
  const elementResults = new Array(numElements);
  let activeMcElementCount = 0;
  let tensionCutoffElementCount = 0;
  let peakEta = 0;
  let anyGpHasHs = false;

  // Priority lookup for the dominant HS active-surface state across a
  // single element's Gauss points. Indexing matches `lastActiveSet` and
  // covers the full raw enum {0..7} introduced by Phase 2 of the
  // hardening-soil fix plan:
  //   0 = elastic
  //   1 = cone, 2 = cap, 3 = corner (cone+cap)
  //   4 = tension
  //   5 = tension+cone, 6 = tension+cap, 7 = tension+cone+cap
  // Priority order: tension-mixed (5/6/7) takes precedence on the
  // canvas because the tension cutoff is the critical safety surface;
  // tension-only (4) > corner (3) > cap (2) > cone (1) > elastic (0).
  // Raw values 5/6/7 map to priority 4 (tension takes precedence).
  const HS_ACTIVE_SET_PRIORITY = [0, 2, 3, 4, 1, 4, 4, 4];

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
    // HS per-element aggregates. Initialised every iteration so a mixed
    // model (HS + MC regions) keeps non-HS elements free of an `hs`
    // material-state object.
    let anyHsInElement = false;
    let maxHsGammaP = 0;
    let maxHsPP = 0;
    let maxHsEpsVPContractive = 0;
    let minHsEpsVPDilative = 0;
    let dominantActiveSet = 0;
    const gaussPoints = [];

    const ips = elementCache?.integrationPoints || [];
    for (let g = 0; g < ips.length; g += 1) {
      const gp = ips[g];
      const wasm = wasmResult.gpStates[gp.globalIndex];
      if (!wasm) continue;
      const weight = ips.length > 0 ? (1.0 / ips.length) : 1;
      const accumulatedPlasticStrain = Number(wasm.accumulatedPlasticStrain) || 0;
      const hsState = wasm.hs ? {
        gammaP: Number(wasm.hs.gammaP) || 0,
        pP: Number(wasm.hs.pP) || 0,
        epsVP: Number(wasm.hs.epsVP) || 0,
        lastActiveSet: Number(wasm.hs.lastActiveSet) || 0,
        tangentModeCode: Number(wasm.hs.tangentModeCode) || 0,
        tangentMode: wasm.hs.tangentMode || 'elastic'
      } : null;
      if (hsState) {
        anyHsInElement = true;
        anyGpHasHs = true;
        if (hsState.gammaP > maxHsGammaP) maxHsGammaP = hsState.gammaP;
        if (hsState.pP > maxHsPP) maxHsPP = hsState.pP;
        // ε_v^p uses the codebase compression-positive convention, so
        // contractive states are positive and dilative states negative.
        // Track both so the diverging contour palette can render the
        // dilative magnitude separately from any compaction lobe.
        if (hsState.epsVP > maxHsEpsVPContractive) maxHsEpsVPContractive = hsState.epsVP;
        if (hsState.epsVP < minHsEpsVPDilative) minHsEpsVPDilative = hsState.epsVP;
        const setIndex = (hsState.lastActiveSet >= 0 && hsState.lastActiveSet < HS_ACTIVE_SET_PRIORITY.length)
          ? hsState.lastActiveSet
          : 0;
        const priorityCurrent = HS_ACTIVE_SET_PRIORITY[setIndex] ?? 0;
        const priorityDominant = HS_ACTIVE_SET_PRIORITY[dominantActiveSet] ?? 0;
        if (priorityCurrent > priorityDominant) {
          dominantActiveSet = setIndex;
        }
      }
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
          hs: hsState,
          serviceEquivalentPlasticIncrement,
          safetyEquivalentPlasticIncrement
        },
        materialState: {
          accumulatedPlasticStrain,
          currentlyMcActive: wasm.plasticActive,
          hasEverExceededMc: wasm.plasticEverActive,
          hs: hsState
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
        exactBranchKind: elementTensionActive ? 'TENSION_FACE_T3' : (elementPlasticActive ? 'MC_FACE_F13' : 'ELASTIC'),
        hs: anyHsInElement ? {
          gammaPMax: maxHsGammaP,
          pPMax: maxHsPP,
          epsVPContractive: maxHsEpsVPContractive,
          epsVPDilative: minHsEpsVPDilative,
          // Collapse raw mixed-tension states (5/6/7) to plain tension (4)
          // for the UI palette, which is keyed on the documented {0..4}
          // enum. The raw value is preserved through the wire format at
          // the Gauss-point level (gaussPoints[].materialState.hs.lastActiveSet)
          // for diagnostics; only the UI aggregate collapses.
          dominantActiveSet: dominantActiveSet >= 4 ? 4 : dominantActiveSet
        } : null
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
    maxMcEta: peakEta,
    peakMcEta: peakEta,
    hasInfiniteMcEta: false,
    elementCount: numElements,
    nodeCount: numNodes
  };

  const summary = wasmResult.summary;
  // Workstream C3(a): warn on a non-converged service solve. Generalized from
  // Hardening-Soil-only to also cover mc-plastic, because the WASM service
  // phase now hands off the best near-failure iterate (workstream C1) so the
  // displayed wall response is the partial state at the achieved load fraction
  // rather than flat zeros. Additive only — pushes a warning string and never
  // alters converged/convergenceState or any numeric field.
  if (
    Array.isArray(warnings) &&
    (options.constitutiveModel === 'hardening-soil' ||
      options.constitutiveModel === 'mc-plastic') &&
    hasSurfaceLoad &&
    !(summary?.serviceConverged === true) &&
    Number(summary?.finalLoadFactor) < 1 - 1e-6
  ) {
    const lambda = Number(summary?.finalLoadFactor) || 0;
    const modelLabel =
      options.constitutiveModel === 'hardening-soil' ? 'Hardening Soil' : 'Mohr-Coulomb';
    const message = `${modelLabel} WASM service phase reached only ${(lambda * 100).toFixed(1)}% (λ=${lambda.toFixed(3)}) of the requested surface load; the displayed displacements and wall response are the partial-load state at this fraction, not the full-load response.`;
    if (!warnings.includes(message)) warnings.push(message);
  }
  const safety = wasmResult.safety || {};
  const isSafety = analysisType === 'safety-cphi';
  const safetyTrials = Array.isArray(safety.trials) ? safety.trials : [];
  const safetyCurve = Array.isArray(safety.curve) ? safety.curve : [];
  const safetyTrialTargets = Array.isArray(safety.trialTargets) ? safety.trialTargets : [];
  const safetyMechanism = isSafety
    ? buildSafetyMechanismSummary({
        mesh,
        load,
        elementResults,
        nodalDisplacements,
        safetyCurve,
        options
      })
    : emptySafetyMechanismSummary();
  summaries.safetyMechanismStatus = safetyMechanism.status;
  summaries.safetyMechanismScore = safetyMechanism.score;
  summaries.safetyMechanismActiveElements = safetyMechanism.activePlasticElementCount;
  summaries.safetyMechanismLargestComponentElements = safetyMechanism.largestConnectedComponentElementCount;
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
  const safetyFinalization = buildSafetyFinalization({
    mode: options.safetyFinalizationMode,
    rawStatus: isSafety ? safety.statusLabel : 'not-run',
    rawWireStatus: isSafety ? safety.status : 0,
    factorOfSafetyLower: safety.factorOfSafetyLower,
    factorOfSafetyUpper: safety.factorOfSafetyUpper,
    strengthRetained: safety.strengthRetained,
    displayedSigmaMsf: safetyDisplayedSigmaMsf,
    mechanism: safetyMechanism,
    curve: safetyCurve,
    trialTargets: safetyTrialTargets,
    options
  });
  const safetyStatusAlias = isSafety
    ? safetyStatusAliasFromFinalizationStatus(safetyFinalization.status)
    : 'not-applicable';
  const resultSafetyObject = isSafety
    ? {
        ...decodedSafetyResult,
        mechanism: safetyMechanism,
        finalization: safetyFinalization,
        curve: safetyCurve,
        trialTargets: safetyTrialTargets
      }
    : {
        ...decodedSafetyResult,
        mechanism: safetyMechanism,
        finalization: safetyFinalization,
        curve: [],
        trialTargets: []
      };
  const usesUnsymmetricPlasticKrylov =
    summary?.hsPlasticUsedGmres === true ||
    summary?.lastLinearSolverKind === 1;
  const krylovCountsByPath = usesUnsymmetricPlasticKrylov
    ? { gmres: summary.cgIterations }
    : { 'cg-bj': summary.cgIterations };
  const krylovCountsBySolver = usesUnsymmetricPlasticKrylov
    ? { gmres: summary.cgIterations }
    : { cg: summary.cgIterations };

  return {
    mesh,
    load,
    warnings,
    nodalDisplacements,
    totalNodalDisplacements,
    initialNodalDisplacements,
    terrainSettlementProfile,
    elementResults,
    wallResults,
    retainingWallResults: wallResults,
    summaries,
    hasHardeningSoil: anyGpHasHs === true,
    solver: {
      method: `wasm-cpu-${options.constitutiveModel}-plane-strain-${elementType}${isSafety ? '-safety-cphi' : ''}`,
      analysisType: analysisType || 'deformation',
      // Phase 2: soil-wall interface model actually used by this run, surfaced
      // so the result/assumptions block reports it honestly (theory-lock
      // mandate): single-sided Coulomb interface (gap + slip) vs bonded wall.
      wallInterfaceActive: (mesh?.interfacePairs?.length || 0) > 0,
      wallInterfaceStations: mesh?.interfacePairs?.length || 0,
      elementType,
      integrationPointsPerElement: elementType === 't6' ? 3 : 1,
      constitutiveModel: `${options.constitutiveModel}-material-point`,
      materialPointCount: wasmResult.numGpTotal,
      backend: 'wasm-cpu',
      initialStressMode: geostatic?.seedMode || geostatic?.mode || 'k0-nil-step',
      geostaticInitializationMethod: geostatic?.workflow?.method || geostatic?.mode || 'wasm-k0',
      geostaticInitializationRequestedMethod: geostatic?.workflow?.requestedMethod || options?.geostaticInitializationMethod || '',
      geostaticInitializationReason: geostatic?.workflow?.reason || '',
      geostaticInitializationRequiresPlasticCorrection: geostatic?.workflow?.runPlasticCorrection === true,
      geostaticInitializationStressOnlyReference: geostatic?.workflow?.stressOnlyReference === true,
      geostaticInitializationRequiresEquilibratedStart: geostatic?.workflow?.requiresEquilibratedStart === true,
      initialPredictorMode: geostatic?.mode || 'wasm-k0',
      initialPredictorSeedMode: geostatic?.seedMode || geostatic?.mode || 'wasm-k0',
      initialPredictorSeedDiagnostics: geostatic?.seedDiagnostics || null,
      geostaticIterations: Number.isFinite(Number(geostatic?.iterations)) ? Number(geostatic.iterations) : 0,
      geostaticResidualNorm: Number.isFinite(Number(geostatic?.residualNorm)) ? Number(geostatic.residualNorm) : 0,
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
      lastLinearSolverKind: summary.lastLinearSolverKind,
      hsPlasticUsedGmres: summary.hsPlasticUsedGmres === true,
      lastHsFailureCode: Number(summary.lastHsFailureCode) || 0,
      // Workstream B: Tier-2 LM-rescue diagnostics (out-of-band JSON from WASM).
      tier2: wasmResult.tier2 || null,
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
      safetyStatus: safetyStatusAlias,
      safetyBaseState: isSafety ? (hasSurfaceLoad ? 'end-of-service' : 'initial-equilibrium') : 'not-applicable',
      safetyFactorOfSafety: isSafety ? safetyFinalization.factorOfSafety : null,
      safetyFactorOfSafetyLower: isSafety ? safetyFinalization.factorOfSafetyLower : null,
      safetyFactorOfSafetyUpper: isSafety ? safetyFinalization.factorOfSafetyUpper : null,
      safetyStrengthRetained: isSafety ? safetyFinalization.strengthRetained : null,
      safetyDisplayedSigmaMsf: isSafety ? safetyFinalization.displayedSigmaMsf : null,
      safetyCommittedSigmaMsf: isSafety ? safety.factorOfSafetyLower : null,
      safetyTrialHistory: isSafety ? (safetyTrialTargets.length ? safetyTrialTargets : safetyTrials) : [],
      safetyTrialTargets: isSafety ? safetyTrialTargets : [],
      safetyCurve: isSafety ? safetyCurve : [],
      safetyMechanism,
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
        krylovCountsByPath,
        krylovCountsBySolver,
        krylovFallbackReasons: {},
        worstTrueResidualMismatch: 0
      }
    },
    timing: { totalMs: performance.now() - (startedAt || performance.now()) }
  };
}
