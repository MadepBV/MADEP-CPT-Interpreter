// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/wall/response.js — the retaining-wall response of a deformation run: the five plotted
// quantities (M, V, N, w, θ), the station / value series behind them, their extrema, the overlay
// colours and the wall-result lookup by id. 01-monolith-map.md §2.11 "Wall results"; moved out of
// legacy-controller.js in PR 20 / refactor step 10, verbatim.
//
// `createWallResponse(env)` is a factory because the four lookups read the active CPT's bishop
// block (the selected wall, the run's `lastWallInputs` index mapping and the overlay quantity).
//
//   env.bishop()   the active CPT's `stage6.bishop`, or undefined

import { wallResultIsStale } from '../../deformation/wall-result-staleness.js';
import { compactNumber as stage6CompactNumber } from '../../core/format.js';

export function createWallResponse(env){
  function stage6BishopWallResultSeries(wallResult){
    const stations = wallResult?.stations || [];
    const sNode = Array.isArray(wallResult?.s_node) && wallResult.s_node.length
      ? wallResult.s_node.map((v)=>Number(v) || 0)
      : stations.map((station)=>Number(station.s) || 0);
    const wPassive = Array.isArray(wallResult?.w_passive) && wallResult.w_passive.length
      ? wallResult.w_passive.map((v)=>Number(v) || 0)
      : stations.map((station)=>Number(station.wPassive) || 0);
    const thetaPassive = Array.isArray(wallResult?.theta_passive) && wallResult.theta_passive.length
      ? wallResult.theta_passive.map((v)=>Number(v) || 0)
      : stations.map((station)=>Number(station.thetaPassive) || 0);
    const sMidpoint = Array.isArray(wallResult?.s_midpoint) && wallResult.s_midpoint.length
      ? wallResult.s_midpoint.map((v)=>Number(v) || 0)
      : stations.slice(0, -1).map((station, index)=>0.5 * ((Number(station.s) || 0) + (Number(stations[index + 1]?.s) || 0)));
    // Node-level internal forces (single element→node average from the wasm). Used for
    // plotting and extrema so the moment renders as its true linear-within-element field
    // and the peak |M| label is honest. The midpoint arrays (wallResult.M_passive etc.)
    // are a redundant second average — they are retained on wallResult for the
    // wasm-pipeline verifier but deliberately NOT used for display here.
    const nodeForce = (key, fallbackArray)=>{
      if(stations.length) return stations.map((station)=>Number(station?.[key]) || 0);
      return Array.isArray(fallbackArray) ? fallbackArray.map((v)=>Number(v) || 0) : [];
    };
    return {
      sNode,
      sMidpoint,
      N:nodeForce('N', wallResult?.N),
      VPassive:nodeForce('VPassive', wallResult?.V_passive),
      MPassive:nodeForce('MPassive', wallResult?.M_passive),
      wPassive,
      thetaPassive
    };
  }

  const STAGE6_WALL_RESPONSE_QUANTITIES = [
    {id:'M', label:'Moment M', shortLabel:'M', key:'MPassive', stationKey:'sNode', unit:'kN·m/m', axisTitle:'M passive-positive (kN·m/m)', color:'#7e50a8', digits:3},
    {id:'V', label:'Shear V', shortLabel:'V', key:'VPassive', stationKey:'sNode', unit:'kN/m', axisTitle:'V passive-positive (kN/m)', color:'#1f6feb', digits:3},
    {id:'N', label:'Axial N', shortLabel:'N', key:'N', stationKey:'sNode', unit:'kN/m', axisTitle:'N tension-positive (kN/m)', color:'#3d6b6a', digits:3},
    {id:'w', label:'Deflection w', shortLabel:'w', key:'wPassive', stationKey:'sNode', scale:1000, unit:'mm', axisTitle:'w passive-positive (mm)', color:'#b3477a', digits:3},
    {id:'theta', label:'Rotation theta', shortLabel:'theta', key:'thetaPassive', stationKey:'sNode', scale:1000, unit:'mrad', axisTitle:'theta passive-positive (mrad)', color:'#9b6b32', digits:3}
  ];

  function stage6BishopWallResponseMeta(quantity){
    return STAGE6_WALL_RESPONSE_QUANTITIES.find((item)=>item.id === quantity) || STAGE6_WALL_RESPONSE_QUANTITIES[0];
  }

  function stage6BishopWallOverlayQuantity(){
    const quantity = env.bishop()?.deformation?.display?.wallOverlayQuantity || 'M';
    return stage6BishopWallResponseMeta(quantity).id;
  }

  function stage6BishopWallQuantitySeries(wallResult, quantity){
    if(!wallResult) return null;
    const meta = stage6BishopWallResponseMeta(quantity);
    const series = stage6BishopWallResultSeries(wallResult);
    const scale = Number(meta.scale) || 1;
    const values = (series[meta.key] || []).map((value)=>scale * (Number(value) || 0));
    const sValues = series[meta.stationKey] || [];
    return {meta, series, sValues, values};
  }

  function stage6BishopWallQuantityStats(wallResult, quantity){
    const data = stage6BishopWallQuantitySeries(wallResult, quantity);
    const pairs = (data?.values || []).map((value, index)=>({
      value:Number(value),
      s:Number(data?.sValues?.[index]),
      index
    })).filter((pair)=>Number.isFinite(pair.value));
    if(!pairs.length) return null;
    let minPair = pairs[0];
    let maxPair = pairs[0];
    pairs.forEach((pair)=>{
      if(pair.value < minPair.value) minPair = pair;
      if(pair.value > maxPair.value) maxPair = pair;
    });
    const min = minPair.value;
    const max = maxPair.value;
    const maxAbs = Math.max(Math.abs(min), Math.abs(max));
    return {...data, min, max, maxAbs, minPair, maxPair};
  }

  function stage6BishopWallQuantityFormat(value, meta){
    if(!Number.isFinite(value)) return '—';
    return `${stage6CompactNumber(value, meta?.digits || 3)} ${meta?.unit || ''}`.trim();
  }

  function stage6BishopCssColorWithAlpha(color, alpha){
    const match = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
    if(!match) return `rgba(126, 80, 168, ${alpha})`;
    const hex = match[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function stage6BishopContrastingTextColor(color){
    const match = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
    if(!match) return '#fff';
    const hex = match[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.58 ? '#17202a' : '#fff';
  }

  function stage6BishopWallNodeValuesForOverlay(wallResult, quantity){
    const data = stage6BishopWallQuantitySeries(wallResult, quantity);
    const stations = wallResult?.stations || [];
    if(!data || stations.length < 2 || !data.values.length) return null;
    if(data.meta.stationKey === 'sNode'){
      return {...data, nodeValues:data.values.slice(0, stations.length)};
    }
    const nodeValues = [];
    for(let i = 0; i < stations.length; i += 1){
      if(i === 0) nodeValues.push(data.values[0] || 0);
      else if(i === stations.length - 1) nodeValues.push(data.values[data.values.length - 1] || 0);
      else nodeValues.push(0.5 * ((data.values[i - 1] || 0) + (data.values[i] || 0)));
    }
    return {...data, nodeValues};
  }

  // Defense-in-depth staleness guard for the deformation wall overlay.
  // Delegates to the pure `wallResultIsStale` predicate (shared with the
  // verify:wall-station-span CI gate) so the renderer can skip a wall overlay
  // whose run-time geometry no longer matches the current wall, i.e. a diagram
  // drawn at old coordinates after a since-applied wall edit.
  function stage6BishopWallResultIsStale(wallResult, bishop){
    return wallResultIsStale(wallResult, bishop);
  }

  function stage6BishopWallResultForId(wallId){
    const bishop = env.bishop();
    if(!wallId) return null;
    const currentIndex = (bishop.walls || []).findIndex((wall)=>wall.id === wallId);
    const lastInputs = bishop.deformation?.lastWallInputs || [];
    const lastIndex = lastInputs.findIndex((wall)=>wall.id === wallId);
    const resultIndex = lastIndex >= 0 ? lastIndex : currentIndex;
    if(resultIndex < 0) return null;
    return (bishop.deformation?.result?.wallResults || bishop.deformation?.result?.retainingWallResults || [])
      .find((wallResult)=>Number(wallResult.wallIndex) === resultIndex) || null;
  }

  function stage6BishopSelectedWallResult(){
    return stage6BishopWallResultForId(env.bishop()?.selectedWallId);
  }

  function stage6BishopAnalysisWallId(){
    const bishop = env.bishop();
    const selected = bishop?.selectedWallId;
    if(selected && (bishop.walls || []).some((wall)=>wall.id === selected)) return selected;
    const resultIndices = new Set((bishop?.deformation?.result?.wallResults || bishop?.deformation?.result?.retainingWallResults || [])
      .map((wallResult)=>Number(wallResult.wallIndex))
      .filter((index)=>Number.isInteger(index) && index >= 0));
    const activeWithResult = (bishop?.walls || []).find((wall, index)=>wall.mechanicalActive === true && resultIndices.has(index));
    if(activeWithResult) return activeWithResult.id;
    const active = (bishop?.walls || []).find((wall)=>wall.mechanicalActive === true);
    return active?.id || bishop?.walls?.[0]?.id || '';
  }

  return {
    STAGE6_WALL_RESPONSE_QUANTITIES,
    stage6BishopWallResultSeries,
    stage6BishopWallResponseMeta,
    stage6BishopWallOverlayQuantity,
    stage6BishopWallQuantitySeries,
    stage6BishopWallQuantityStats,
    stage6BishopWallQuantityFormat,
    stage6BishopCssColorWithAlpha,
    stage6BishopContrastingTextColor,
    stage6BishopWallNodeValuesForOverlay,
    stage6BishopWallResultIsStale,
    stage6BishopWallResultForId,
    stage6BishopSelectedWallResult,
    stage6BishopAnalysisWallId
  };
}
