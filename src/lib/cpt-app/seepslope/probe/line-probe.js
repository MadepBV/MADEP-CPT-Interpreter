// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/probe/line-probe.js — the line probe: sample a solved seepage or deformation field
// along the shared Measure tool's line, and report the statistics the panel and the chart show.
// Refactor step 9d (01-monolith-map.md §2.11 group "Geometry, picking, line probe", §6.1 row
// `seepslope/` `geometry/line-probe.js`; PLAN §2 row 18d). Moved verbatim from
// legacy-controller.js (integration-r 4974167):
//
//   stage6BishopLineProbeStats 5433-5450     → lineProbeStats
//   stage6BishopIntegrateLineProbe 5452-5466 → integrateLineProbe
//   stage6BishopBuildLineProbe 5468-5615     → buildLineProbe(bishop, workspace, metrics, env)
//
// `S?.stage6?.bishop` became the first parameter and the samplers are imported from the engines
// (`seepage/solver.js`, `deformation/solver.js`) — no `S`, no DOM, no render. Three host values
// stayed explicit in `env`, because their owners are not extracted yet:
//
//   env.hardeningSoilUi                                    STAGE6_ENABLE_HARDENING_SOIL_UI (a flag)
//   env.normalizedDeformationAnalysisType(analysisType)    deformation contours (map §2.11)
//   env.deformationContourOptions / env.deformationContourMeta   idem, through probe/options.js
//   env.seepageHydraulicFs(gradientMagnitude, material)    seepage contours (map §2.11)
//
// The result is the object the panel, the chart and the clipboard all read:
//   {workspace, quantity, meta, status, message}                       — the four refusals
//   + {measurement, samples, chartPoints, stats}                       — 'no-valid-samples'
//   + {coverage, sampleCount, netCrossFlow, absCrossFlow}              — 'ready'
// A sample outside the solved domain keeps its `x/y/s` and stores `value: null`, so the chart
// shows a gap instead of dropping the abscissa.
import { sampleSeepageFlowState, sampleSeepageHead, sampleSeepagePorePressure } from '../../seepage/solver.js';
import { sampleDeformationState } from '../../deformation/solver.js';
import { measurementVectors } from '../geometry/measurement.js';
import { lineProbeMeta } from './options.js';

/** min / max / mean over the finite samples; `validCount` 0 leaves the three null. */
export function lineProbeStats(samples){
  const values = (samples || []).map((item)=>item?.value).filter(Number.isFinite);
  if(!values.length){
    return {
      min:null,
      max:null,
      mean:null,
      validCount:0
    };
  }
  const sum = values.reduce((acc, value)=>acc + value, 0);
  return {
    min:Math.min(...values),
    max:Math.max(...values),
    mean:sum / values.length,
    validCount:values.length
  };
}

/**
 * Trapezoidal ∫ value ds over the samples (`absolute` integrates |value|). Gaps are skipped:
 * a pair with a non-finite end, or a non-increasing `s`, contributes nothing.
 */
export function integrateLineProbe(samples, absolute){
  let total = 0;
  const items = (samples || []).filter((item)=>Number.isFinite(item?.s));
  for(let i=1;i<items.length;i+=1){
    const prev = items[i-1];
    const next = items[i];
    if(!(Number.isFinite(prev?.value) && Number.isFinite(next?.value))) continue;
    const ds = next.s - prev.s;
    if(!(ds > 0)) continue;
    const v0 = absolute ? Math.abs(prev.value) : prev.value;
    const v1 = absolute ? Math.abs(next.value) : next.value;
    total += 0.5 * (v0 + v1) * ds;
  }
  return total;
}

/**
 * Sample the workspace's solved field along `measurementMetrics` (21…201 evenly spaced points,
 * `bishop.lineProbe.sampleCount` clamped). Refuses — with the monolith's four `status` values and
 * messages — outside seepage / deformation, without a measured line, and without a solved
 * mesh + result. `netCrossFlow` / `absCrossFlow` are only computed for seepage `normalFlow`.
 */
export function buildLineProbe(bishop, workspace, measurementMetrics, env = {}){
  const quantity = workspace === 'seepage'
    ? (bishop?.lineProbe?.seepageQuantity || 'head')
    : (bishop?.lineProbe?.deformationQuantity || 'uTotal');
  const analysisType = workspace === 'deformation'
    ? env.normalizedDeformationAnalysisType()
    : null;
  const hasHs = workspace === 'deformation' && env.hardeningSoilUi && bishop?.deformation?.result?.hasHardeningSoil === true;
  const meta = lineProbeMeta(workspace, quantity, analysisType, hasHs, env);
  if(workspace !== 'seepage' && workspace !== 'deformation'){
    return {
      workspace,
      quantity,
      meta,
      status:'unsupported',
      message:'Line plots are currently available in the seepage and deformation workspaces.'
    };
  }
  if(!measurementMetrics || !(measurementMetrics.length > 1e-9)){
    return {
      workspace,
      quantity,
      meta,
      status:'missing-measurement',
      message:'Use the shared Measure tool to draw a probe line on the canvas first.'
    };
  }
  if(workspace === 'seepage' && !(bishop?.seepage?.mesh && bishop?.seepage?.result)){
    return {
      workspace,
      quantity,
      meta,
      status:'missing-result',
      message:'Run seepage first, then the measured line can plot heads, gradients, and discharge quantities.'
    };
  }
  if(workspace === 'deformation' && !(bishop?.deformation?.mesh && bishop?.deformation?.result)){
    return {
      workspace,
      quantity,
      meta,
      status:'missing-result',
      message:'Run deformation first, then the measured line can plot displacement and MC screening quantities.'
    };
  }
  const sampleCount = Math.min(Math.max(Math.round(+bishop?.lineProbe?.sampleCount || 81), 21), 201);
  const vectors = measurementVectors(measurementMetrics);
  const samples = [];
  for(let i=0;i<sampleCount;i+=1){
    const t = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
    const x = measurementMetrics.a.x + t * measurementMetrics.dx;
    const y = measurementMetrics.a.y + t * measurementMetrics.dy;
    const s = t * measurementMetrics.length;
    let value = null;
    if(workspace === 'seepage'){
      if(quantity === 'head'){
        value = sampleSeepageHead(bishop.seepage.mesh, bishop.seepage.result, x, y);
      } else if(quantity === 'porePressure'){
        value = sampleSeepagePorePressure(bishop.seepage.mesh, bishop.seepage.result, x, y, 9.81);
      } else {
        const flowState = sampleSeepageFlowState(bishop.seepage.mesh, bishop.seepage.result, x, y);
        if(flowState){
          if(quantity === 'gradient'){
            value = Math.hypot(flowState.dhdx || 0, flowState.dhdy || 0);
          } else if(quantity === 'hydraulicFs'){
            const cell = bishop.seepage.mesh?.cells?.[flowState.cellIndex];
            value = env.seepageHydraulicFs(
              Math.hypot(flowState.dhdx || 0, flowState.dhdy || 0),
              cell?.material
            );
          } else if(quantity === 'flow'){
            value = Math.hypot(flowState.qx || 0, flowState.qy || 0);
          } else if(quantity === 'qx'){
            value = flowState.qx || 0;
          } else if(quantity === 'qy'){
            value = flowState.qy || 0;
          } else if(quantity === 'normalFlow'){
            value = (flowState.qx || 0) * vectors.nx + (flowState.qy || 0) * vectors.ny;
          }
        }
      }
    } else if(workspace === 'deformation'){
      const state = sampleDeformationState(bishop.deformation.mesh, bishop.deformation.result, x, y);
      if(state){
        if(quantity === 'ux') value = 1000 * (state.ux || 0);
        else if(quantity === 'uy') value = 1000 * (state.uy || 0);
        else if(quantity === 'uTotal') value = 1000 * (state.uTotal || 0);
        else if(quantity === 'epsilonXx') value = 100 * (state.epsilonXx || 0);
        else if(quantity === 'epsilonYy') value = 100 * (state.epsilonYy || 0);
        else if(quantity === 'gammaXy') value = 100 * (state.gammaXy || 0);
        else if(quantity === 'equivalentPlasticStrain') value = 100 * (state.equivalentPlasticStrain || 0);
        else if(quantity === 'safetyEquivalentPlasticIncrement') value = 100 * (state.safetyEquivalentPlasticIncrement || 0);
        else if(quantity === 'deltaSigmaYy') value = state.deltaSigmaYy;
        else if(quantity === 'sigmaYyEffInit') value = state.sigmaYyEffInit;
        else if(quantity === 'sigmaYyEff') value = state.sigmaYyEff;
        else if(quantity === 'sigmaYyTotalInit') value = state.sigmaYyTotalInit;
        else if(quantity === 'sigmaYyTotal') value = state.sigmaYyTotal;
        else if(quantity === 'sigmaXxEffInit') value = state.sigmaXxEffInit;
        else if(quantity === 'sigmaXxEff') value = state.sigmaXxEff;
        else if(quantity === 'sigmaXxTotalInit') value = state.sigmaXxTotalInit;
        else if(quantity === 'sigmaXxTotal') value = state.sigmaXxTotal;
        else if(quantity === 'tauXy') value = state.tauXy;
        else if(quantity === 'mcEta') value = state.mcEta;
        else value = 1000 * (state.settlement || 0);
      }
    }
    samples.push({
      index:i,
      x,
      y,
      s,
      value:Number.isFinite(value) ? value : null
    });
  }
  const stats = lineProbeStats(samples);
  if(!stats.validCount){
    return {
      workspace,
      quantity,
      meta,
      measurement:measurementMetrics,
      samples,
      chartPoints:samples.map((item)=>({x:item.s, y:item.value})),
      stats,
      status:'no-valid-samples',
      message:'The current measurement line does not intersect the solved field inside the section domain.'
    };
  }
  const coverage = stats.validCount / sampleCount;
  return {
    workspace,
    quantity,
    meta,
    measurement:measurementMetrics,
    samples,
    chartPoints:samples.map((item)=>({x:item.s, y:item.value})),
    stats,
    status:'ready',
    coverage,
    sampleCount,
    message:coverage < 0.999
      ? 'Part of the measurement line lies outside the solved domain, so the graph includes gaps where no field value exists.'
      : '',
    netCrossFlow:workspace === 'seepage' && quantity === 'normalFlow' ? integrateLineProbe(samples, false) : null,
    absCrossFlow:workspace === 'seepage' && quantity === 'normalFlow' ? integrateLineProbe(samples, true) : null
  };
}
