// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/contours/deformation.js — the deformation contour catalogue: the quantity list per
// analysis type (deformation / safety c-φ, plus the four Hardening Soil quantities), the labels
// and units, the per-element and per-cell values, the T6 visual sub-triangles, the plastic-point
// sets, the statistics, the colours and the legend. 01-monolith-map.md §2.11 "Deformation
// contours"; moved out of legacy-controller.js in PR 20 / refactor step 10, verbatim.
//
// `createDeformationContours(env)` is a factory because two members read the active CPT:
// `stage6BishopNormalizedDeformationAnalysisType` falls back to the run's own analysis type, and
// `stage6BishopDeformationContourDerived` memoises the traced iso-lines on the volatile cache.
//
//   env.currentAnalysisType()  `S.stage6.bishop.deformation.options.analysisType`
//   env.ensure()               ensureStage6State()
//   env.cache()                the active CPT's `stage6Cache` (created if absent)

import { contourSegmentsForTriangles } from '../../seepage/solver.js';
import { compactNumber as stage6CompactNumber } from '../../core/format.js';
import {
  ST6_DEFORMATION_SEQ_PALETTE,
  ST6_DEFORMATION_SIGNED_PALETTE,
  stage6BishopInterpolatePalette
} from './palettes.js';

export function createDeformationContours(env){
  function stage6BishopNormalizedDeformationAnalysisType(analysisType = null){
    if(analysisType === 'safety-cphi') return 'safety-cphi';
    if(analysisType === 'deformation') return 'deformation';
    return env.currentAnalysisType() === 'safety-cphi'
      ? 'safety-cphi'
      : 'deformation';
  }

  function stage6BishopDeformationQuantityIds(analysisType = null, hasHs = false){
    const normalizedAnalysisType = stage6BishopNormalizedDeformationAnalysisType(analysisType);
    const ids = [
      'uTotal',
      'settlement',
      'ux',
      'uy',
      'epsilonXx',
      'epsilonYy',
      'gammaXy',
      'equivalentPlasticStrain',
      'deltaSigmaYy',
      'sigmaYyEffInit',
      'sigmaYyEff',
      'sigmaYyTotalInit',
      'sigmaYyTotal',
      'sigmaXxEffInit',
      'sigmaXxEff',
      'sigmaXxTotalInit',
      'sigmaXxTotal',
      'tauXy',
      'mcEta'
    ];
    if(normalizedAnalysisType === 'safety-cphi'){
      ids.splice(8, 0, 'safetyEquivalentPlasticIncrement');
    }
    if(hasHs === true){
      ids.push('hsGammaP');
      ids.push('hsPP');
      ids.push('hsEpsVPDilative');
      ids.push('hsLastActiveSet');
    }
    return ids;
  }

  function stage6BishopDeformationContourMeta(mode, analysisType = 'deformation'){
    const isSafety = stage6BishopNormalizedDeformationAnalysisType(analysisType) === 'safety-cphi';
    if(mode === 'settlement') return {label:isSafety ? 'Additional settlement (-Δuᵧ,safety)' : 'Settlement (-uᵧ,fin)', axisTitle:isSafety ? 'Additional settlement (-Δuᵧ,safety) (mm)' : 'Settlement (-uᵧ,fin) (mm)', unit:'mm', scale:1000, digits:2, signed:false};
    if(mode === 'ux') return {label:isSafety ? 'Δuₓ,safety' : 'uₓ,fin', axisTitle:isSafety ? 'Δuₓ,safety (mm)' : 'uₓ,fin (mm)', unit:'mm', scale:1000, digits:2, signed:true};
    if(mode === 'uy') return {label:isSafety ? 'Δuᵧ,safety' : 'uᵧ,fin', axisTitle:isSafety ? 'Δuᵧ,safety (mm)' : 'uᵧ,fin (mm)', unit:'mm', scale:1000, digits:2, signed:true};
    if(mode === 'uTotal') return {label:isSafety ? '|Δu|,safety' : '|u|,fin', axisTitle:isSafety ? '|Δu|,safety (mm)' : '|u|,fin (mm)', unit:'mm', scale:1000, digits:2, signed:false};
    if(mode === 'epsilonXx') return {label:'εₓₓ,fin', axisTitle:'εₓₓ,fin (%)', unit:'%', scale:100, digits:3, signed:true};
    if(mode === 'epsilonYy') return {label:'εᵧᵧ,fin', axisTitle:'εᵧᵧ,fin (%)', unit:'%', scale:100, digits:3, signed:true};
    if(mode === 'gammaXy') return {label:'γₓᵧ,fin', axisTitle:'γₓᵧ,fin (%)', unit:'%', scale:100, digits:3, signed:true};
    if(mode === 'equivalentPlasticStrain') return {label:'ε̄ᵖ,acc', axisTitle:'ε̄ᵖ,acc (%)', unit:'%', scale:100, digits:3, signed:false};
    if(mode === 'safetyEquivalentPlasticIncrement') return {label:'Δε̄ᵖ,safety', axisTitle:'Δε̄ᵖ,safety (%)', unit:'%', scale:100, digits:3, signed:false};
    if(mode === 'deltaSigmaYy') return {label:'Δσᵧᵧ', axisTitle:'Δσᵧᵧ (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaYyEffInit') return {label:'σ′ᵧᵧ,init', axisTitle:'σ′ᵧᵧ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaYyEff') return {label:'σ′ᵧᵧ,fin', axisTitle:'σ′ᵧᵧ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaYyTotalInit') return {label:'σᵧᵧ,init', axisTitle:'σᵧᵧ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaYyTotal') return {label:'σᵧᵧ,fin', axisTitle:'σᵧᵧ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaXxEffInit') return {label:'σ′ₓₓ,init', axisTitle:'σ′ₓₓ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaXxEff') return {label:'σ′ₓₓ,fin', axisTitle:'σ′ₓₓ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaXxTotalInit') return {label:'σₓₓ,init', axisTitle:'σₓₓ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'sigmaXxTotal') return {label:'σₓₓ,fin', axisTitle:'σₓₓ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
    if(mode === 'tauXy') return {label:'τₓᵧ,fin', axisTitle:'τₓᵧ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:true};
    if(mode === 'hsGammaP') return {label:'γᵖ (HS)', axisTitle:'γᵖ (HS) (%)', unit:'%', scale:100, digits:3, signed:false};
    if(mode === 'hsPP') return {label:'pₚ (HS)', axisTitle:'pₚ (HS) (kPa)', unit:'kPa', scale:1, digits:1, signed:false};
    if(mode === 'hsEpsVPDilative') return {label:'εᵥᵖ (HS, dilative)', axisTitle:'εᵥᵖ (HS, dilative) (%)', unit:'%', scale:100, digits:3, signed:true};
    if(mode === 'hsLastActiveSet') return {label:'HS active surface', axisTitle:'HS active surface', unit:'', scale:1, digits:0, signed:false, categorical:true};
    return {label:'η_MC', axisTitle:'η_MC (-)', unit:'', scale:1, digits:3, signed:false};
  }

  function stage6BishopDeformationContourOptions(analysisType = 'deformation', hasHs = false){
    const normalizedAnalysisType = stage6BishopNormalizedDeformationAnalysisType(analysisType);
    return stage6BishopDeformationQuantityIds(normalizedAnalysisType, hasHs === true).map((id)=>({
      id,
      label:stage6BishopDeformationContourMeta(id, normalizedAnalysisType).label
    }));
  }

  function stage6BishopDeformationVectorMode(mode){
    return ['settlement', 'ux', 'uy', 'uTotal'].includes(mode);
  }

  function stage6BishopT6VisualSubtriangles(element){
    if(!Array.isArray(element) || element.length < 6) return [element?.slice?.(0, 3) || []];
    return [
      [element[0], element[5], element[4]],
      [element[5], element[1], element[3]],
      [element[4], element[3], element[2]],
      [element[5], element[3], element[4]]
    ];
  }

  function stage6BishopDeformationPlasticPointSets(result){
    const constitutiveModel = String(result?.solver?.constitutiveModel || '');
    const isMcPlastic = constitutiveModel === 'mc-plastic-material-point' || constitutiveModel === 'gpu-resident-mc-plastic';
    const activePoints = [];
    const tensionPoints = [];
    const historyPoints = [];
    (result?.elementResults || []).forEach((item)=>{
      if(Array.isArray(item?.gaussPoints) && item.gaussPoints.length){
        item.gaussPoints.forEach((gp)=>{
          if(!Number.isFinite(gp?.x) || !Number.isFinite(gp?.y)) return;
          const point = {x:gp.x, y:gp.y};
          const diagnostics = gp?.materialDiagnostics || {};
          const materialState = gp?.materialState || {};
          const tensionCutoffActive = gp?.tensionCutoffActive === true || diagnostics.tensionCutoffActive === true;
          const currentlyMcActive = diagnostics.currentlyMcActive === true || materialState.currentlyMcActive === true;
          if(isMcPlastic){
            if(tensionCutoffActive){
              tensionPoints.push(point);
              return;
            }
            if(currentlyMcActive){
              activePoints.push(point);
              return;
            }
            if((Number(materialState?.accumulatedPlasticStrain) || 0) > 1e-8) historyPoints.push(point);
            return;
          }
          if(constitutiveModel === 'mc-reduced-stiffness-material-point' && currentlyMcActive) activePoints.push(point);
        });
        return;
      }
      const centroid = item?.centroid;
      if(!Number.isFinite(centroid?.x) || !Number.isFinite(centroid?.y)) return;
      const diagnostics = item?.materialDiagnostics || {};
      const tensionCutoffActive = diagnostics.tensionCutoffActive === true;
      const currentlyMcActive = diagnostics.currentlyMcActive === true;
      if(isMcPlastic){
        if(tensionCutoffActive){
          tensionPoints.push(centroid);
          return;
        }
        if(currentlyMcActive){
          activePoints.push(centroid);
          return;
        }
        if((Number(item?.materialState?.accumulatedPlasticStrain) || 0) > 1e-8){
          historyPoints.push(centroid);
        }
        return;
      }
      if(constitutiveModel === 'mc-reduced-stiffness-material-point' && currentlyMcActive){
        activePoints.push(centroid);
      }
    });
    return {
      activePoints,
      tensionPoints,
      historyPoints
    };
  }

  function stage6BishopDeformationFiniteScalar(value, fallback = 0){
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function stage6BishopDeformationFiniteScalarOrNull(value){
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function stage6BishopDeformationElementEtaMc(item){
    const contourEta = Number(item?.materialDiagnostics?.etaMcContour);
    if(Number.isFinite(contourEta)) return contourEta;
    let sumEta = 0;
    let sumWeight = 0;
    let fallbackMax = null;
    (item?.gaussPoints || []).forEach((gp)=>{
      if(gp?.tensionCutoffActive === true || gp?.materialDiagnostics?.tensionCutoffActive === true) return;
      const numeric = Number(gp?.materialDiagnostics?.etaMcFinal ?? gp?.mc?.eta);
      if(!Number.isFinite(numeric)) return;
      const weight = Math.max(Number(gp?.areaWeight) || 1, 0);
      sumEta += weight * numeric;
      sumWeight += weight;
      fallbackMax = Math.max(fallbackMax ?? 0, numeric);
    });
    if(sumWeight > 0) return sumEta / sumWeight;
    if(fallbackMax != null) return fallbackMax;
    if(item?.materialDiagnostics?.tensionCutoffActive !== true){
      const numeric = Number(item?.materialDiagnostics?.etaMcFinal ?? item?.mc?.eta);
      if(Number.isFinite(numeric)) return numeric;
    }
    return null;
  }

  function stage6BishopAverageFiniteValues(values, fallback = null){
    const finite = (values || []).filter((value)=>Number.isFinite(value));
    if(!finite.length) return fallback;
    return finite.reduce((sum, value)=>sum + value, 0) / finite.length;
  }

  function stage6BishopDeformationCellTriangleIndices(mesh, cellIndex){
    return Array.isArray(mesh?.cells?.[cellIndex]?.triangleIndices)
      ? mesh.cells[cellIndex].triangleIndices
      : [];
  }

  function stage6BishopDeformationCellNodeIds(mesh, cellIndex){
    const nodeIds = [];
    const seen = new Set();
    stage6BishopDeformationCellTriangleIndices(mesh, cellIndex).forEach((triangleIndex)=>{
      (mesh?.elements?.[triangleIndex] || []).forEach((nodeId)=>{
        if(seen.has(nodeId)) return;
        seen.add(nodeId);
        nodeIds.push(nodeId);
      });
    });
    return nodeIds;
  }

  function stage6BishopDeformationElementContourValue(result, elementIndex, mode){
    if(mode === 'syy') mode = 'deltaSigmaYy';
    const item = result?.elementResults?.[elementIndex] || null;
    if(mode === 'epsilonXx') return stage6BishopDeformationFiniteScalar(item?.strain?.exx, 0);
    if(mode === 'epsilonYy') return stage6BishopDeformationFiniteScalar(item?.strain?.eyy, 0);
    if(mode === 'gammaXy') return stage6BishopDeformationFiniteScalar(item?.strain?.gxy, 0);
    if(mode === 'equivalentPlasticStrain') return stage6BishopDeformationFiniteScalar(item?.materialState?.accumulatedPlasticStrain, 0);
    if(mode === 'safetyEquivalentPlasticIncrement') return stage6BishopDeformationFiniteScalar(item?.materialDiagnostics?.safetyEquivalentPlasticIncrement, 0);
    if(mode === 'deltaSigmaYy') return -stage6BishopDeformationFiniteScalar(item?.stressIncrement?.syy, 0);
    if(mode === 'sigmaYyEffInit') return stage6BishopDeformationFiniteScalar(item?.initialEffectiveStress?.syy, 0);
    if(mode === 'sigmaYyEff') return stage6BishopDeformationFiniteScalar(item?.effectiveStress?.syy, 0);
    if(mode === 'sigmaYyTotalInit') return stage6BishopDeformationFiniteScalar(item?.initialTotalStress?.syy, 0);
    if(mode === 'sigmaYyTotal') return stage6BishopDeformationFiniteScalar(item?.totalStress?.syy, 0);
    if(mode === 'sigmaXxEffInit') return stage6BishopDeformationFiniteScalar(item?.initialEffectiveStress?.sxx, 0);
    if(mode === 'sigmaXxEff') return stage6BishopDeformationFiniteScalar(item?.effectiveStress?.sxx, 0);
    if(mode === 'sigmaXxTotalInit') return stage6BishopDeformationFiniteScalar(item?.initialTotalStress?.sxx, 0);
    if(mode === 'sigmaXxTotal') return stage6BishopDeformationFiniteScalar(item?.totalStress?.sxx, 0);
    if(mode === 'tauXy') return stage6BishopDeformationFiniteScalar(item?.effectiveStress?.txy, 0);
    if(mode === 'hsGammaP') return stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.gammaPMax, 0);
    if(mode === 'hsPP') return stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.pPMax, 0);
    // ε_v^p is signed (compression-positive); flip the sign so dilative
    // magnitudes render as positive lobes in the diverging palette.
    if(mode === 'hsEpsVPDilative') return -stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.epsVPDilative, 0);
    if(mode === 'hsLastActiveSet') return stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.dominantActiveSet, 0);
    return stage6BishopDeformationElementEtaMc(item);
  }

  function stage6BishopDeformationContourValue(result, mesh, cellIndex, mode){
    const nodal = result?.nodalDisplacements || [];
    const nodeIds = stage6BishopDeformationCellNodeIds(mesh, cellIndex);
    if(mode === 'settlement'){
      return stage6BishopAverageFiniteValues(nodeIds.map((nodeId)=>-stage6BishopDeformationFiniteScalar(nodal[nodeId]?.uy, 0)), 0);
    }
    if(mode === 'ux'){
      return stage6BishopAverageFiniteValues(nodeIds.map((nodeId)=>stage6BishopDeformationFiniteScalar(nodal[nodeId]?.ux, 0)), 0);
    }
    if(mode === 'uy'){
      return stage6BishopAverageFiniteValues(nodeIds.map((nodeId)=>stage6BishopDeformationFiniteScalar(nodal[nodeId]?.uy, 0)), 0);
    }
    if(mode === 'uTotal'){
      return stage6BishopAverageFiniteValues(
        nodeIds.map((nodeId)=>Math.hypot(stage6BishopDeformationFiniteScalar(nodal[nodeId]?.ux, 0), stage6BishopDeformationFiniteScalar(nodal[nodeId]?.uy, 0))),
        0
      );
    }
    return stage6BishopAverageFiniteValues(
      stage6BishopDeformationCellTriangleIndices(mesh, cellIndex).map((elementIndex)=>stage6BishopDeformationElementContourValue(result, elementIndex, mode)),
      null
    );
  }

  function stage6BishopDeformationContourModeIsSigned(mode, analysisType = null){
    return !!stage6BishopDeformationContourMeta(mode, analysisType).signed;
  }

  function stage6BishopDeformationContourStats(result, mesh, mode, analysisType = null){
    const values = (mesh?.cells || []).map((_, index)=>stage6BishopDeformationContourValue(result, mesh, index, mode)).filter(Number.isFinite);
    if(!values.length) return {min:0, max:1};
    const min = Math.min(...values);
    const max = Math.max(...values);
    if(stage6BishopDeformationContourModeIsSigned(mode, analysisType)){
      const abs = Math.max(Math.abs(min), Math.abs(max), 1e-9);
      return {min:-abs, max:abs};
    }
    return {
      min,
      max: max > min + 1e-9 ? max : min + 1
    };
  }

  function stage6BishopDeformationContourNodalValues(result, mesh, mode){
    const nodeCount = mesh?.nodes?.length || 0;
    if(!nodeCount) return [];
    if(mode === 'settlement') return Array.from({length:nodeCount}, (_, nodeId)=>-stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.uy, 0));
    if(mode === 'ux') return Array.from({length:nodeCount}, (_, nodeId)=>stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.ux, 0));
    if(mode === 'uy') return Array.from({length:nodeCount}, (_, nodeId)=>stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.uy, 0));
    if(mode === 'uTotal') return Array.from({length:nodeCount}, (_, nodeId)=>Math.hypot(
      stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.ux, 0),
      stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.uy, 0)
    ));
    const sums = new Array(nodeCount).fill(0);
    const weights = new Array(nodeCount).fill(0);
    (mesh?.elements || []).forEach((element, elementIndex)=>{
      const value = stage6BishopDeformationElementContourValue(result, elementIndex, mode);
      if(!Number.isFinite(value)) return;
      const weight = Math.max(Number(mesh?.elementData?.[elementIndex]?.area) || 0, 1e-6);
      element.forEach((nodeId)=>{
        sums[nodeId] += value * weight;
        weights[nodeId] += weight;
      });
    });
    return sums.map((sum, index)=>weights[index] > 0 ? sum / weights[index] : 0);
  }

  function stage6BishopDeformationVisualContourMesh(mesh, mode){
    if(mesh?.elementType !== 't6' || !stage6BishopDeformationVectorMode(mode)) return mesh;
    return {
      ...mesh,
      elements:(mesh.elements || []).flatMap((element)=>stage6BishopT6VisualSubtriangles(element))
    };
  }

  function stage6BishopDeformationContourRgb(value, min, max, mode, analysisType = null){
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
    const finiteValue = Number.isFinite(value)
      ? value
      : (stage6BishopDeformationContourModeIsSigned(mode, analysisType) ? 0 : lo);
    if(stage6BishopDeformationContourModeIsSigned(mode, analysisType)){
      const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
      return stage6BishopInterpolatePalette(
        ST6_DEFORMATION_SIGNED_PALETTE,
        Math.max(0, Math.min((finiteValue + span) / (2 * span), 1))
      );
    }
    return stage6BishopInterpolatePalette(
      ST6_DEFORMATION_SEQ_PALETTE,
      Math.max(0, Math.min((finiteValue - lo) / (hi - lo), 1))
    );
  }

  function stage6BishopDeformationContourColor(value, min, max, mode, alpha = 0.6, analysisType = null){
    const rgb = stage6BishopDeformationContourRgb(value, min, max, mode, analysisType);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  function stage6BishopDeformationContourLineColor(value, min, max, mode, alpha = 0.92, analysisType = null){
    const rgb = stage6BishopDeformationContourRgb(value, min, max, mode, analysisType);
    return `rgba(${Math.round(rgb.r * 0.72)}, ${Math.round(rgb.g * 0.72)}, ${Math.round(rgb.b * 0.72)}, ${alpha})`;
  }

  function stage6BishopDeformationContourLegendGradient(mode, analysisType = null){
    const stops = stage6BishopDeformationContourModeIsSigned(mode, analysisType)
      ? ST6_DEFORMATION_SIGNED_PALETTE
      : ST6_DEFORMATION_SEQ_PALETTE;
    return `linear-gradient(to top, ${stops.map((stop)=>`rgb(${stop.rgb[0]}, ${stop.rgb[1]}, ${stop.rgb[2]}) ${Math.round(stop.t * 100)}%`).join(', ')})`;
  }

  function stage6BishopDeformationContourLegendTicks(mode, stats, analysisType = null){
    if(stage6BishopDeformationContourModeIsSigned(mode, analysisType)){
      const span = Math.max(Math.abs(stats?.min || 0), Math.abs(stats?.max || 0), 1e-9);
      return [span, 0.5 * span, 0, -0.5 * span, -span];
    }
    const min = Number.isFinite(stats?.min) ? stats.min : 0;
    const max = Number.isFinite(stats?.max) ? stats.max : 1;
    return [max, min + 0.75 * (max - min), min + 0.5 * (max - min), min + 0.25 * (max - min), min];
  }

  function stage6BishopDeformationContourLegendValue(mode, value, analysisType = null){
    const meta = stage6BishopDeformationContourMeta(mode, analysisType);
    const scaled = value * (meta.scale || 1);
    return `${stage6CompactNumber(scaled, meta.digits || 3)}${meta.unit ? ` ${meta.unit}` : ''}`;
  }

  function stage6BishopDeformationContourFlatTolerance(mode, analysisType = null){
    const meta = stage6BishopDeformationContourMeta(mode, analysisType);
    const digits = Math.max(Math.round(Number(meta?.digits) || 0), 0);
    const scale = Math.max(Math.abs(Number(meta?.scale) || 1), 1e-12);
    return 0.5 * Math.pow(10, -digits) / scale;
  }

  function stage6BishopDeformationContourLevels(mode, stats, count = 11, analysisType = null){
    const min = Number.isFinite(stats?.min) ? stats.min : 0;
    const max = Number.isFinite(stats?.max) ? stats.max : min + 1;
    const flatTolerance = Math.max(1e-9, stage6BishopDeformationContourFlatTolerance(mode, analysisType));
    if(!(max > min + flatTolerance)) return [];
    const out = [];
    for(let index = 1; index < count; index += 1){
      const t = index / count;
      const level = min + (max - min) * t;
      if(stage6BishopDeformationContourModeIsSigned(mode, analysisType) && Math.abs(level) < 1e-10) continue;
      out.push(level);
    }
    if(stage6BishopDeformationContourModeIsSigned(mode, analysisType) && min < 0 && max > 0){
      out.push(0);
      out.sort((a, b)=>a - b);
    }
    return out;
  }

  function stage6BishopDeformationContourDerived(result, mesh, mode){
    env.ensure();
    const cache = env.cache();
    const store = cache.bishopDeformationContourDerived || (cache.bishopDeformationContourDerived = {});
    const cached = store[mode];
    if(cached && cached.result === result && cached.mesh === mesh) return cached;
    const analysisType = result?.solver?.analysisType === 'safety-cphi' ? 'safety-cphi' : null;
    const stats = stage6BishopDeformationContourStats(result, mesh, mode, analysisType);
    const nodalValues = stage6BishopDeformationContourNodalValues(result, mesh, mode);
    const levels = stage6BishopDeformationContourLevels(mode, stats, 11, analysisType);
    const contourMesh = stage6BishopDeformationVisualContourMesh(mesh, mode);
    const levelSegments = levels.map((level)=>({
      level,
      segments:contourSegmentsForTriangles(contourMesh, nodalValues, level)
    })).filter((group)=>group.segments.length);
    const next = {result, mesh, mode, stats, nodalValues, levels, levelSegments};
    store[mode] = next;
    return next;
  }

  return {
    stage6BishopNormalizedDeformationAnalysisType,
    stage6BishopDeformationQuantityIds,
    stage6BishopDeformationContourMeta,
    stage6BishopDeformationContourOptions,
    stage6BishopDeformationVectorMode,
    stage6BishopT6VisualSubtriangles,
    stage6BishopDeformationPlasticPointSets,
    stage6BishopDeformationFiniteScalar,
    stage6BishopDeformationFiniteScalarOrNull,
    stage6BishopDeformationElementEtaMc,
    stage6BishopAverageFiniteValues,
    stage6BishopDeformationCellTriangleIndices,
    stage6BishopDeformationCellNodeIds,
    stage6BishopDeformationElementContourValue,
    stage6BishopDeformationContourValue,
    stage6BishopDeformationContourModeIsSigned,
    stage6BishopDeformationContourStats,
    stage6BishopDeformationContourNodalValues,
    stage6BishopDeformationVisualContourMesh,
    stage6BishopDeformationContourRgb,
    stage6BishopDeformationContourColor,
    stage6BishopDeformationContourLineColor,
    stage6BishopDeformationContourLegendGradient,
    stage6BishopDeformationContourLegendTicks,
    stage6BishopDeformationContourLegendValue,
    stage6BishopDeformationContourFlatTolerance,
    stage6BishopDeformationContourLevels,
    stage6BishopDeformationContourDerived
  };
}
