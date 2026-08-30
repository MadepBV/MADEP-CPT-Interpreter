// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/geometry/regions.js — which soil polygons the canvas shows, which one a point falls
// in, and the three readouts built from one region. Refactor step 9d (01-monolith-map.md §2.11
// group "Geometry, picking, line probe"; PLAN §2 row 18d). Moved verbatim from
// legacy-controller.js (integration-r 4974167):
//
//   stage6BishopRegionAtPoint 5175-5182               → regionAtPoint
//   stage6BishopTooltipHtml 5184-5197                 → regionTooltipHtml(region, env)
//   stage6BishopRegionShortLabel 5199-5203            → regionShortLabel
//   stage6BishopRegionLegendItems 5235-5252           → regionLegendItems
//   stage6BishopDisplayRegions 5640-5646              → displayRegions(model, bishop)
//   stage6BishopShowingCustomRegionPreview 5648-5650  → showingCustomRegionPreview
//
// No `S`, no DOM. Two host inputs stayed explicit:
//   · `displayRegions` took `S.stage6.bishop` only to refuse to answer without a bishop block —
//     it is now the second parameter and the guard is unchanged;
//   · `regionTooltipHtml` reads the workspace strength set as the fallback of a material that
//     carries none, and formats it with `stage6BishopStrengthSetLabel` (results region, step 9f).
//     Both are handed in as `env`, and `env.strengthSet` may be a value **or a function** so the
//     controller keeps the monolith's lazy read (only when the material has no `sourceStrengthSet`,
//     and never for a region without a material).
import { pointInPolygon } from './polygons.js';

/** The polygons the canvas draws: the custom set when there is one, the model's regions otherwise. */
export function displayRegions(model, bishop){
  if(!model || !bishop) return [];
  const customRegions = model.customRegions || [];
  if(customRegions.length) return customRegions;
  return model.regions || [];
}

/** True while custom polygons exist but the solver still runs on the layer-derived regions. */
export function showingCustomRegionPreview(model){
  return !!(model?.customRegions?.length) && model.regionMode !== 'custom';
}

/** The topmost region containing `point` (last drawn wins), or `null`. */
export function regionAtPoint(model, point){
  if(!model?.regions?.length) return null;
  for(let i=model.regions.length-1;i>=0;i-=1){
    const region = model.regions[i];
    if(region.polygon?.length >= 3 && pointInPolygon(point, region.polygon)) return region;
  }
  return null;
}

/** The hover tooltip of one region; `''` for a region without a material. */
export function regionTooltipHtml(region, env){
  if(!region?.material) return '';
  const mat = region.material;
  const setLabel = env.strengthSetLabel(mat.sourceStrengthSet || (typeof env.strengthSet === 'function' ? env.strengthSet() : env.strengthSet));
  return `
    <strong>${mat.label}</strong>
    <div class="mut">${mat.sourceType || 'Soil'}${mat.sourceSubtype ? ` · ${mat.sourceSubtype}` : ''}</div>
    <div class="row"><span>Strength set</span><span>${setLabel}</span></div>
    <div class="row"><span>c'</span><span>${Number(mat.cEff || 0).toFixed(1)} kPa</span></div>
    <div class="row"><span>phi'</span><span>${Number(mat.phiEffDeg || 0).toFixed(1)}°</span></div>
    <div class="row"><span>gamma</span><span>${Number(mat.gamma || 0).toFixed(2)} kN/m³</span></div>
    <div class="row"><span>gamma_sat</span><span>${Number(mat.gammaSat || 0).toFixed(2)} kN/m³</span></div>
  `;
}

/** The label the canvas paints inside a region: the part before ' - ', ellipsised past 18 chars. */
export function regionShortLabel(region){
  const label = String(region?.material?.label || region?.material?.id || 'Region').trim();
  const base = label.includes(' - ') ? label.split(' - ')[0] : label;
  return base.length > 18 ? `${base.slice(0, 17)}…` : base;
}

/** One legend row per material, in first-use order, with the number of regions that use it. */
export function regionLegendItems(model){
  if(!model?.regions?.length) return [];
  const items = new Map();
  model.regions.forEach((region)=>{
    const mat = region.material || {};
    const key = mat.id || region.id;
    const item = items.get(key) || {
      id:key,
      label:mat.label || key,
      color:mat.color || '#c9b089',
      count:0,
      sourceType:mat.sourceType || 'Soil'
    };
    item.count += 1;
    items.set(key, item);
  });
  return [...items.values()];
}
