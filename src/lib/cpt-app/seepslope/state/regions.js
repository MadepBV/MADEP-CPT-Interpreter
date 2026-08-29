// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/regions.js — the custom soil polygons ("regions") of the Seep / Slope state,
// refactor step 9a. Moved verbatim from legacy-controller.js (462fc50 lines 5349-5449:
// stage6BishopRegionId … SelectedCustomRegion; the region handlers 6514-6678 minus the DXF
// export: SetSelectedRegion, CopyCurrentRegionsToCustom, SetUseCustomRegions, ClearCustomRegions,
// DeleteSelectedRegion, SetSelectedRegionMaterial, SetSelectedRegionCoarseness,
// SplitSelectedRegion; the `region` branch of FinishDraft as `addCustomRegion`). `S.stage6.bishop`
// became the `bishop` parameter; the host side effects (ensureStage6State, the <details> memory,
// stage6BishopSyncSoilModel / CurrentModel, the invalidators, renderStage6) stayed in the host
// façades, and the polygon geometry (stage6BishopSplitRegionPolygon, step 9d) is handed to
// splitSelectedRegion as a hook:
//
//   pure helpers       regionId(ids), roundRegionCoord, normalizeRegionCoarseness, clampRegionPoint,
//                      normalizeCustomRegions(regions, terrain, materials, ids), selectedCustomRegion
//   writes of `bishop` setSelectedRegion, addCustomRegion, copyCurrentRegionsToCustom,
//                      setUseCustomRegions, clearCustomRegions, deleteSelectedRegion,
//                      setSelectedRegionMaterial, setSelectedRegionCoarseness, splitSelectedRegion
//
// The state operations return what the host needs:
//   copyCurrentRegionsToCustom  true when the model's regions were copied (host re-syncs the model
//                               and invalidates), false = no regions (message set)
//   setUseCustomRegions         the resulting flag (the host's message depends on it)
//   deleteSelectedRegion        true when a region was removed (host invalidates + renders)
//   setSelectedRegionMaterial / setSelectedRegionCoarseness  the region or null (no selection)
//   splitSelectedRegion         { ok } — on failure progress.message holds the reason (host renders)
import { isSimplePolygon, normalizeRegionPolygon, polygonArea } from '../../soil-regions.js';
import { DEFAULT_IDS, entityId } from './ids.js';

export const REGION_COORD_DECIMALS = 6;
export const REGION_COARSENESS_DECIMALS = 3;

/** `region_<now36>_<rand>` */
export function regionId(ids = DEFAULT_IDS){
  return entityId('region', ids);
}

export function roundRegionCoord(value){
  return +Number(value).toFixed(REGION_COORD_DECIMALS);
}

/** Mesh coarseness factor: positive, 3 decimals, 1 when unset. */
export function normalizeRegionCoarseness(value){
  const numeric = Number(value);
  if(!Number.isFinite(numeric) || !(numeric > 0)) return 1;
  return +numeric.toFixed(REGION_COARSENESS_DECIMALS);
}

export function clampRegionPoint(point, minX = -Infinity, maxX = Infinity){
  return {
    x:roundRegionCoord(Math.min(Math.max(Number(point?.x), minX), maxX)),
    y:roundRegionCoord(Number(point?.y))
  };
}

/**
 * Every region in canonical shape: finite vertices clamped to the terrain extent and rounded,
 * the polygon normalised, the material id resolved against `materials` (first material as
 * fallback), coarseness and source normalised, a missing id allocated. Regions without a
 * material, with fewer than 3 vertices, a degenerate area or self-intersections are dropped.
 */
export function normalizeCustomRegions(regions, terrain, materials, ids = DEFAULT_IDS){
  const minX = terrain?.length ? terrain[0].x : -Infinity;
  const maxX = terrain?.length ? terrain[terrain.length-1].x : Infinity;
  const materialIds = new Set((materials || []).map((material)=>material.id));
  const fallbackMaterialId = materials?.[0]?.id || null;
  return (regions || [])
    .map((region)=>{
      const rawPolygon = (region?.polygon || [])
        .map((pt)=>({
          x:Number(pt?.x),
          y:Number(pt?.y)
        }))
        .filter((pt)=>Number.isFinite(pt.x) && Number.isFinite(pt.y))
        .map((pt)=>clampRegionPoint(pt, minX, maxX));
      const polygon = normalizeRegionPolygon(rawPolygon);
      const materialId = materialIds.has(region?.materialId) ? region.materialId : fallbackMaterialId;
      return {
        id:region?.id || regionId(ids),
        polygon,
        materialId,
        coarseness:normalizeRegionCoarseness(region?.coarseness),
        source:region?.source === 'cpt-copy' ? 'cpt-copy' : region?.source === 'hole' ? 'hole' : region?.source === 'edited' ? 'edited' : 'custom'
      };
    })
    .filter((region)=>region.materialId && region.polygon.length >= 3 && polygonArea(region.polygon) > 1e-4 && isSimplePolygon(region.polygon));
}

export function selectedCustomRegion(bishop){
  if(!bishop) return null;
  return (bishop.customRegions || []).find((region)=>region.id === bishop.selectedRegionId) || null;
}

/** Select a region by id (null / '' clears). */
export function setSelectedRegion(bishop, regionId){
  bishop.selectedRegionId = regionId || null;
}

/**
 * Append a custom region over an already validated `polygon` (the region draft, normalised and
 * simple) with the draft material, enable custom regions and select it. Returns the new region's
 * id, or null when the normaliser dropped it.
 */
export function addCustomRegion(bishop, polygon, ids = DEFAULT_IDS){
  const id = regionId(ids);
  bishop.customRegions = normalizeCustomRegions([
    ...(bishop.customRegions || []),
    {
      id,
      polygon,
      materialId:bishop.regionDraftMaterialId || bishop.materials?.[0]?.id || null,
      coarseness:1,
      source:'custom'
    }
  ], bishop.terrain, bishop.materials, ids);
  bishop.useCustomRegions = bishop.customRegions.length > 0;
  bishop.selectedRegionId = bishop.customRegions[bishop.customRegions.length - 1]?.id || bishop.selectedRegionId;
  return (bishop.customRegions || []).some((region)=>region.id === id) ? id : null;
}

/**
 * Replace the custom set with a copy of the solver's current regions (`model.regions`, the CPT-
 * derived ones marked `cpt-copy`), enable them and select the first. Returns false (message set)
 * when the model has no regions.
 */
export function copyCurrentRegionsToCustom(bishop, model, ids = DEFAULT_IDS){
  if(!model?.regions?.length){
    bishop.progress.message = 'Draw terrain and place the active CPT marker before copying solver polygons.';
    return false;
  }
  bishop.customRegions = model.regions.map((region, index)=>({
    id:regionId(ids),
    polygon:(region.polygon || []).map((pt)=>clampRegionPoint(pt)),
    materialId:region.material?.id || bishop.materials?.[0]?.id || null,
    coarseness:normalizeRegionCoarseness(region?.coarseness),
    source:index < (model.autoRegions?.length || 0) ? 'cpt-copy' : 'custom'
  }));
  bishop.useCustomRegions = bishop.customRegions.length > 0;
  bishop.selectedRegionId = bishop.customRegions[0]?.id || null;
  bishop.regionDraftMaterialId = bishop.customRegions[0]?.materialId || bishop.materials?.[0]?.id || null;
  return true;
}

/** Enable / disable the custom set in the solver (only enabled when there are regions). Returns the flag. */
export function setUseCustomRegions(bishop, value){
  bishop.useCustomRegions = !!value && (bishop.customRegions || []).length > 0;
  return bishop.useCustomRegions;
}

/** Drop every custom region and the selection, back to the CPT-derived polygons. */
export function clearCustomRegions(bishop){
  bishop.customRegions = [];
  bishop.useCustomRegions = false;
  bishop.selectedRegionId = null;
}

/** Remove the selected region (the first remaining one becomes selected). Returns true when one was removed. */
export function deleteSelectedRegion(bishop){
  const selectedId = bishop.selectedRegionId;
  if(!selectedId) return false;
  bishop.customRegions = (bishop.customRegions || []).filter((region)=>region.id !== selectedId);
  bishop.selectedRegionId = bishop.customRegions[0]?.id || null;
  if(!bishop.customRegions.length){
    bishop.useCustomRegions = false;
  }
  return true;
}

/** Assign a material to the selected region. Returns the region or null without a selection. */
export function setSelectedRegionMaterial(bishop, materialId){
  const region = selectedCustomRegion(bishop);
  if(!region) return null;
  region.materialId = materialId;
  return region;
}

/** Set the mesh coarseness of the selected region. Returns the region or null without a selection. */
export function setSelectedRegionCoarseness(bishop, value){
  const region = selectedCustomRegion(bishop);
  if(!region) return null;
  region.coarseness = normalizeRegionCoarseness(value);
  return region;
}

/**
 * Split the selected region along the two boundary points of the `regionSplit` draft.
 * `splitPolygon(region, p0, p1)` is the polygon geometry (stage6BishopSplitRegionPolygon):
 * `{ ok, polygons }` or `{ ok:false, message }`. On success the region is replaced by the pieces
 * (`edited`), the first piece selected, the tool set to `edit` and the draft cleared; on failure
 * progress.message tells why (an empty split draft is kept in `regionSplit` mode).
 */
export function splitSelectedRegion(bishop, {splitPolygon, ids = DEFAULT_IDS}){
  const region = selectedCustomRegion(bishop);
  const splitPoints = bishop.draftKind === 'regionSplit' ? (bishop.draft || []) : [];
  if(!region || splitPoints.length < 2){
    bishop.progress.message = 'Choose two boundary points on the selected polygon to split it.';
    return {ok:false};
  }
  const outcome = splitPolygon(region, splitPoints[0], splitPoints[1]);
  if(!outcome.ok){
    bishop.draft = [];
    bishop.draftKind = 'regionSplit';
    bishop.progress.message = outcome.message;
    return {ok:false};
  }
  const replacements = outcome.polygons.map((polygon)=>({
    id:regionId(ids),
    polygon,
    materialId:region.materialId || bishop.materials?.[0]?.id || null,
    coarseness:normalizeRegionCoarseness(region?.coarseness),
    source:'edited'
  }));
  bishop.customRegions = normalizeCustomRegions(
    (bishop.customRegions || []).flatMap((item)=>item.id === region.id ? replacements : [item]),
    bishop.terrain,
    bishop.materials,
    ids
  );
  bishop.selectedRegionId = replacements[0]?.id || bishop.selectedRegionId;
  bishop.useCustomRegions = bishop.customRegions.length > 0;
  bishop.tool = 'edit';
  bishop.draft = [];
  bishop.draftKind = '';
  return {ok:true};
}
