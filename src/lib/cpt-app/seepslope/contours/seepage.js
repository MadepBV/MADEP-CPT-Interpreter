// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/contours/seepage.js — the seepage contour catalogue: the seven quantities (head,
// pore pressure, gradient, hydraulic FS, |q|, qx, qy), their per-element / per-cell values, the
// nodal interpolation the iso-lines are traced on, the statistics, the colours and the legend.
// 01-monolith-map.md §2.11 "Seepage state + contours"; moved out of legacy-controller.js in
// PR 20 / refactor step 10, verbatim.
//
// `createSeepageContours(env)` is a factory rather than plain exports because one member —
// `stage6BishopSeepageContourDerived`, the memo of the traced iso-lines — reads the volatile
// Stage 6 cache of the active CPT. Everything else is pure.
//
//   env.ensure()   ensureStage6State()
//   env.cache()    the active CPT's `stage6Cache` (created if absent, as `S.stage6Cache ||= {}` did)

import { stage6Constants } from '../../stage6-engineering.js';
import { contourSegmentsForTriangles } from '../../seepage/solver.js';
import { compactNumber as stage6CompactNumber } from '../../core/format.js';
import {
  ST6_SEEPAGE_HYDRAULIC_FS_CAP,
  ST6_SEEPAGE_HYDRAULIC_FS_PALETTE,
  ST6_DEFORMATION_SEQ_PALETTE,
  ST6_DEFORMATION_SIGNED_PALETTE,
  stage6BishopInterpolatePalette
} from './palettes.js';

export function createSeepageContours(env){
  function stage6BishopSeepageHeadColor(value, min, max, alpha = 0.55){
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
    const t = Math.max(0, Math.min((value - lo) / (hi - lo), 1));
    const r = Math.round(33 + (44 - 33) * t);
    const g = Math.round(109 + (158 - 109) * t);
    const b = Math.round(186 + (82 - 186) * t);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function stage6BishopSeepageContourMeta(mode){
    if(mode === 'head') return {label:'h', axisTitle:'Head h (m)', unit:'m', scale:1, digits:2, signed:false};
    if(mode === 'porePressure') return {label:'u', axisTitle:'Pore pressure u (kPa)', unit:'kPa', scale:1, digits:2, signed:true};
    if(mode === 'gradient') return {label:'|∇h|', axisTitle:'Hydraulic gradient |∇h| (-)', unit:'', scale:1, digits:3, signed:false};
    if(mode === 'hydraulicFs') return {label:'FSᵢ', axisTitle:'Hydraulic safety factor FSᵢ = iᶜʳⁱᵗ / |∇h| (-)', unit:'', scale:1, digits:2, signed:false, centeredAtOne:true};
    if(mode === 'flow') return {label:'|q|', axisTitle:'Specific discharge |q| (m/s)', unit:'m/s', scale:1, digits:3, signed:false};
    if(mode === 'qx') return {label:'qₓ', axisTitle:'Specific discharge qₓ (m/s)', unit:'m/s', scale:1, digits:3, signed:true};
    return {label:'qᵧ', axisTitle:'Specific discharge qᵧ (m/s)', unit:'m/s', scale:1, digits:3, signed:true};
  }

  function stage6BishopSeepageContourOptions(){
    return [
      'head',
      'porePressure',
      'gradient',
      'hydraulicFs',
      'flow',
      'qx',
      'qy'
    ].map((id)=>({
      id,
      label:stage6BishopSeepageContourMeta(id).label
    }));
  }

  function stage6BishopSeepageCriticalGradient(material){
    const gammaW = Math.max(Number(stage6Constants().gammaW) || 9.81, 1e-9);
    const gammaDry = Number.isFinite(Number(material?.gamma)) ? Number(material.gamma) : 18;
    const gammaSat = Number.isFinite(Number(material?.gammaSat)) ? Number(material.gammaSat) : gammaDry + 2;
    return Math.max((gammaSat - gammaW) / gammaW, 0);
  }

  function stage6BishopSeepageHydraulicFs(gradientMagnitude, material){
    const gradient = Math.max(Math.abs(Number(gradientMagnitude) || 0), 0);
    const criticalGradient = stage6BishopSeepageCriticalGradient(material);
    if(!(criticalGradient > 0)) return 0;
    if(!(gradient > 1e-9)) return ST6_SEEPAGE_HYDRAULIC_FS_CAP;
    return Math.min(criticalGradient / gradient, ST6_SEEPAGE_HYDRAULIC_FS_CAP);
  }

  function stage6BishopSeepageElementContourValue(result, mesh, elementIndex, mode){
    if(mode === 'head') return Number(result?.elementHeads?.[elementIndex] ?? 0);
    if(mode === 'porePressure'){
      const centroidY = Number(mesh?.elementData?.[elementIndex]?.centroid?.y);
      const head = Number(result?.elementHeads?.[elementIndex] ?? 0);
      return Number.isFinite(centroidY) ? 9.81 * (head - centroidY) : 0;
    }
    const gradient = result?.elementGradients?.[elementIndex] || {};
    if(mode === 'gradient') return Number(gradient.gradientMagnitude || 0);
    if(mode === 'hydraulicFs'){
      const cell = mesh?.cells?.[mesh?.elementCell?.[elementIndex]];
      return stage6BishopSeepageHydraulicFs(gradient.gradientMagnitude, cell?.material);
    }
    if(mode === 'flow') return Number(gradient.qMagnitude || 0);
    if(mode === 'qx') return Number(gradient.qx || 0);
    return Number(gradient.qy || 0);
  }

  function stage6BishopSeepageContourValue(result, mesh, cellIndex, mode){
    if(mode === 'head') return Number(result?.cellHeads?.[cellIndex] ?? result?.headMin ?? 0);
    if(mode === 'porePressure'){
      const cellY = Number(mesh?.cells?.[cellIndex]?.centroid?.y);
      const head = Number(result?.cellHeads?.[cellIndex] ?? 0);
      return Number.isFinite(cellY) ? 9.81 * (head - cellY) : 0;
    }
    const gradient = result?.cellGradients?.[cellIndex] || {};
    if(mode === 'gradient') return Number(gradient.gradientMagnitude || 0);
    if(mode === 'hydraulicFs'){
      const cell = mesh?.cells?.[cellIndex];
      return stage6BishopSeepageHydraulicFs(gradient.gradientMagnitude, cell?.material);
    }
    if(mode === 'flow') return Number(gradient.qMagnitude || 0);
    if(mode === 'qx') return Number(gradient.qx || 0);
    return Number(gradient.qy || 0);
  }

  function stage6BishopSeepageContourModeIsSigned(mode){
    return !!stage6BishopSeepageContourMeta(mode).signed;
  }

  function stage6BishopSeepageContourStats(result, mesh, mode){
    const values = (mesh?.cells || []).map((_, index)=>stage6BishopSeepageContourValue(result, mesh, index, mode)).filter(Number.isFinite);
    if(!values.length) return {min:0, max:1};
    const min = Math.min(...values);
    const max = Math.max(...values);
    if(mode === 'hydraulicFs'){
      return {
        min:Math.min(min, 1),
        max:Math.max(max, 1.5)
      };
    }
    if(stage6BishopSeepageContourModeIsSigned(mode)){
      const abs = Math.max(Math.abs(min), Math.abs(max), 1e-9);
      return {min:-abs, max:abs};
    }
    return {
      min,
      max: max > min + 1e-9 ? max : min + 1
    };
  }

  function stage6BishopSeepageContourNodalValues(result, mesh, mode){
    const nodeCount = mesh?.nodes?.length || 0;
    if(!nodeCount) return [];
    if(mode === 'head') return Array.from({length:nodeCount}, (_, nodeId)=>Number(result?.heads?.[nodeId] || 0));
    if(mode === 'porePressure'){
      return Array.from({length:nodeCount}, (_, nodeId)=>{
        const head = Number(result?.heads?.[nodeId] || 0);
        const y = Number(mesh?.nodes?.[nodeId]?.y);
        return Number.isFinite(y) ? 9.81 * (head - y) : 0;
      });
    }
    const sums = new Array(nodeCount).fill(0);
    const weights = new Array(nodeCount).fill(0);
    (mesh?.elements || []).forEach((element, elementIndex)=>{
      const value = stage6BishopSeepageElementContourValue(result, mesh, elementIndex, mode);
      if(!Number.isFinite(value)) return;
      const weight = Math.max(Number(mesh?.elementData?.[elementIndex]?.area) || 0, 1e-6);
      element.forEach((nodeId)=>{
        sums[nodeId] += value * weight;
        weights[nodeId] += weight;
      });
    });
    return sums.map((sum, index)=>weights[index] > 0 ? sum / weights[index] : 0);
  }

  function stage6BishopSeepageContourRgb(value, min, max, mode){
    if(mode === 'hydraulicFs'){
      const finiteValue = Number.isFinite(value) ? Math.max(value, 0) : 0;
      const hi = Math.max(Number.isFinite(max) ? max : 1.5, 1.5);
      const t = finiteValue <= 1
        ? 0.5 * Math.max(0, Math.min(finiteValue, 1))
        : 0.5 + 0.5 * Math.max(0, Math.min((finiteValue - 1) / Math.max(hi - 1, 1e-9), 1));
      return stage6BishopInterpolatePalette(ST6_SEEPAGE_HYDRAULIC_FS_PALETTE, t);
    }
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
    if(stage6BishopSeepageContourModeIsSigned(mode)){
      const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
      return stage6BishopInterpolatePalette(
        ST6_DEFORMATION_SIGNED_PALETTE,
        Math.max(0, Math.min((value + span) / (2 * span), 1))
      );
    }
    return stage6BishopInterpolatePalette(
      ST6_DEFORMATION_SEQ_PALETTE,
      Math.max(0, Math.min((value - lo) / (hi - lo), 1))
    );
  }

  function stage6BishopSeepageContourColor(value, min, max, mode, alpha = 0.52){
    const rgb = stage6BishopSeepageContourRgb(value, min, max, mode);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  function stage6BishopSeepageContourLineColor(value, min, max, mode, alpha = 0.94){
    const rgb = stage6BishopSeepageContourRgb(value, min, max, mode);
    return `rgba(${Math.round(rgb.r * 0.72)}, ${Math.round(rgb.g * 0.72)}, ${Math.round(rgb.b * 0.72)}, ${alpha})`;
  }

  function stage6BishopSeepageContourLegendGradient(mode){
    if(mode === 'hydraulicFs'){
      return `linear-gradient(to top, ${ST6_SEEPAGE_HYDRAULIC_FS_PALETTE.map((stop)=>`rgb(${stop.rgb[0]}, ${stop.rgb[1]}, ${stop.rgb[2]}) ${Math.round(stop.t * 100)}%`).join(', ')})`;
    }
    const stops = stage6BishopSeepageContourModeIsSigned(mode)
      ? ST6_DEFORMATION_SIGNED_PALETTE
      : ST6_DEFORMATION_SEQ_PALETTE;
    return `linear-gradient(to top, ${stops.map((stop)=>`rgb(${stop.rgb[0]}, ${stop.rgb[1]}, ${stop.rgb[2]}) ${Math.round(stop.t * 100)}%`).join(', ')})`;
  }

  function stage6BishopSeepageContourLegendTicks(mode, stats){
    if(mode === 'hydraulicFs'){
      const max = Math.max(Number.isFinite(stats?.max) ? stats.max : 1.5, 1.5);
      return [max, 1 + 0.5 * (max - 1), 1, 0.5, 0];
    }
    if(stage6BishopSeepageContourModeIsSigned(mode)){
      const span = Math.max(Math.abs(stats?.min || 0), Math.abs(stats?.max || 0), 1e-9);
      return [span, 0.5 * span, 0, -0.5 * span, -span];
    }
    const min = Number.isFinite(stats?.min) ? stats.min : 0;
    const max = Number.isFinite(stats?.max) ? stats.max : 1;
    return [max, min + 0.75 * (max - min), min + 0.5 * (max - min), min + 0.25 * (max - min), min];
  }

  function stage6BishopSeepageContourLegendValue(mode, value){
    const meta = stage6BishopSeepageContourMeta(mode);
    const scaled = value * (meta.scale || 1);
    return `${stage6CompactNumber(scaled, meta.digits || 3)}${meta.unit ? ` ${meta.unit}` : ''}`;
  }

  function stage6BishopSeepageContourLevels(mode, stats, count = 11){
    const min = Number.isFinite(stats?.min) ? stats.min : 0;
    const max = Number.isFinite(stats?.max) ? stats.max : min + 1;
    if(!(max > min + 1e-9)) return [];
    const out = [];
    for(let index = 1; index < count; index += 1){
      const t = index / count;
      const level = min + (max - min) * t;
      if(stage6BishopSeepageContourModeIsSigned(mode) && Math.abs(level) < 1e-10) continue;
      out.push(level);
    }
    if(stage6BishopSeepageContourModeIsSigned(mode) && min < 0 && max > 0){
      out.push(0);
      out.sort((a, b)=>a - b);
    }
    if(mode === 'hydraulicFs' && min < 1 && max > 1 && !out.some((level)=>Math.abs(level - 1) < 1e-9)){
      out.push(1);
      out.sort((a, b)=>a - b);
    }
    return out;
  }

  function stage6BishopSeepageContourDerived(result, mesh, mode){
    env.ensure();
    const cache = env.cache();
    const store = cache.bishopSeepageContourDerived || (cache.bishopSeepageContourDerived = {});
    const cached = store[mode];
    if(cached && cached.result === result && cached.mesh === mesh) return cached;
    const stats = stage6BishopSeepageContourStats(result, mesh, mode);
    const nodalValues = stage6BishopSeepageContourNodalValues(result, mesh, mode);
    const levels = stage6BishopSeepageContourLevels(mode, stats, 11);
    const levelSegments = levels.map((level)=>({
      level,
      segments:contourSegmentsForTriangles(mesh, nodalValues, level)
    })).filter((group)=>group.segments.length);
    const next = {result, mesh, mode, stats, nodalValues, levels, levelSegments};
    store[mode] = next;
    return next;
  }

  return {
    stage6BishopSeepageHeadColor,
    stage6BishopSeepageContourMeta,
    stage6BishopSeepageContourOptions,
    stage6BishopSeepageCriticalGradient,
    stage6BishopSeepageHydraulicFs,
    stage6BishopSeepageElementContourValue,
    stage6BishopSeepageContourValue,
    stage6BishopSeepageContourModeIsSigned,
    stage6BishopSeepageContourStats,
    stage6BishopSeepageContourNodalValues,
    stage6BishopSeepageContourRgb,
    stage6BishopSeepageContourColor,
    stage6BishopSeepageContourLineColor,
    stage6BishopSeepageContourLegendGradient,
    stage6BishopSeepageContourLegendTicks,
    stage6BishopSeepageContourLegendValue,
    stage6BishopSeepageContourLevels,
    stage6BishopSeepageContourDerived
  };
}
