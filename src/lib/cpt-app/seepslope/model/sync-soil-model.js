// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/model/sync-soil-model.js — the soil-model sync of the Seep / Slope app as a pure
// function, refactor step 9b (01-monolith-map.md §2.11 "Soil model bridge" 6375-6513 at 462fc50,
// §3.4 #5 / #9, §6.3 item 5; PLAN §4 defect 3). Moved from legacy-controller.js
// stage6BishopSyncSoilModel (integration-r 09b9c9b lines 2876-3005) and stage6BishopCurrentModel
// (3007-3013). The monolith mutated `S.stage6.bishop` in place — and was called from the canvas
// draw path on every frame; here the sync is a function of (bishop, workingLayers) that returns
// a *patch*:
//
//   syncSoilModel(bishop, layers, env) → { changed, patch, invalidation, reimported, source, layers }
//     patch          { key: value } — only the keys whose serialised value the monolith's writes
//                    would change, in the monolith's first-write order (so a key that did not
//                    exist yet is appended where the monolith appended it); one dotted path,
//                    'deformation.options.hsConsistentTangentPromptPending', for the HS tangent
//                    prompt the monolith raised on a legacy material.hs
//     invalidation   null | { kind:'bishop', message } — the Bishop invalidation the monolith
//                    fired mid-sync when a re-import cleared existing results (signature.js);
//                    the host runs its invalidator with that message
//     changed        patch has at least one key
//   applySoilModelPatch(bishop, patch)   writes the patch into the block in place (identity of the
//                                        block preserved — every host reader holds `S.stage6.bishop`)
//   previewState(bishop, patch)          the patched block as a new object, `bishop` untouched
//   soilModelFromState(bishop, layers, env) → { model, sync } — the sync and the model the patched
//                                        state builds, without mutating anything: the "same model
//                                        everywhere" primitive (render, run, draw, verifier)
//   mirrorHsParams(material, layer)      one material with the Stage 4 HS stiffness fields mirrored
//                                        (the HS mirror, monolith 2894-2963) as a new object
//   normalizeSoilGeometry / pruneSelections   the geometry normalisation and the selection pruning
//                                        the sync performed after the materials (monolith 2964-3004)
//
// The body follows the monolith statement for statement; every `bishop.x = …` became a write on
// a shallow draft (`{ ...bishop }` plus a copied surfaceLoads array — the only nested array the
// surface-load migration pushes into), every `material.x = …` a write on `{ ...material }` /
// `{ ...material.hs }` in the same key order, so the applied patch is byte-identical (JSON text,
// key order) to what the monolith produced (scripts/verify_seepslope_model.mjs).
//
// `env`:
//   env.ids        { now, random } for the region ids normalizeCustomRegions allocates to a region
//                  without one (state/ids.js; default the clock + Math.random, as the monolith)
//   env.options    the engine's buildBishopModelFromStageLayers options ({ includeLegacyBands })
//
// Convergence (the monolith's, kept verbatim — scripts/verify_seepslope_model.mjs (d) asserts it):
// the sync is idempotent from the second run on, not from the first, in two documented cases.
//   1. `walls`: state/walls.js normalizeWalls writes `mechanicalActivationPromptPending =
//      !hasMechanicalActiveField`, and the same pass writes `mechanicalActive`. A wall saved before
//      that field existed therefore raises the prompt on the first sync and clears it on the second.
//      Observable behaviour is unchanged either way: the panel HTML is built from the block the
//      *render's* sync left, so the prompt is rendered exactly once (see report 22 §6).
//   2. no layers at all (`layers.length === 0` → `materials.length === 0`): `source.empty` stays
//      true, so every sync re-imports and — once `sourceLayerSignature` is set — fires the
//      "Active CPT layers changed" invalidation again. A Seep / Slope block on a CPT that was never
//      classified therefore clears its (empty) results on every sync.
// A third sync is a no-op in both cases.
import { buildBishopModelFromStageLayers, importBishopMaterialsFromLayers } from '../../stage6-bishop.js';
import { sortedPolyline } from '../state/domain.js';
import { DEFAULT_IDS } from '../state/ids.js';
import {
  migrateSurfaceLoadsShape,
  normalizeSurfaceLoad,
  sortZone,
  syncLegacySurfaceLoadMirror,
  validZone
} from '../state/surface-loads.js';
import { normalizeWalls } from '../state/walls.js';
import { normalizeDrains } from '../state/drains.js';
import { normalizeCustomRegions } from '../state/regions.js';
import { materialsInvalidation, materialsSource } from './signature.js';

/** The top-level keys the sync writes, in the monolith's first-write order (key order of a fresh key). */
export const SOIL_MODEL_PATCH_KEYS = Object.freeze([
  'surfaceLoads', 'selectedSurfaceLoadId', 'surfaceLoad',      // migrateSurfaceLoadsShape
  'materials', 'sourceLayerSignature', 'sourceStrengthSet',    // the import
  'customRegions', 'useCustomRegions',                         // the collection guards
  'terrain', 'activeCptX', 'entryZone', 'exitZone',            // the geometry normalisation
  'walls', 'drains',
  'selectedWallId', 'selectedDrainId', 'regionDraftMaterialId', 'selectedRegionId',   // the pruning
  'tool', 'draft', 'draftKind'
]);
export const HS_PROMPT_PATH = 'deformation.options.hsConsistentTangentPromptPending';

/** JSON text with undefined / non-finite numbers made visible (a missing key and an undefined one differ). */
function ser(value){
  return JSON.stringify(value, (key, x)=>(x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? `<${String(x)}>` : x));
}

/**
 * The HS mirror of the sync for one material (monolith 2891-2963): rShear filled from the layer,
 * the Stage 4 HS stiffness fields (E50_ref / Eoed_ref / Eur_ref / m / ν_ur) and K0nc / ψ mirrored
 * from the working layer on every sync (so toggling alphaMethod / stiffMethod / m_ovr upstream is
 * reflected without a signature rebuild), the HS-only `hs` sub-block validated, the legacy fields
 * stripped. Returns the material as a new object (same key order as the in-place writes) and
 * whether `hs` lacked the consistent-tangent flag (a project saved before the HS selector
 * existed — the host raises the migration prompt unless it was resolved).
 */
export function mirrorHsParams(material, layer){
  const next = {...material};
  if(!Number.isFinite(Number(next?.rShear))){
    next.rShear = Number.isFinite(Number(layer?.rShear)) ? Number(layer.rShear) : 0.25;
  }
  // The HS stiffness fields (E50_ref / Eoed_ref / Eur_ref / m / ν_ur) and
  // the cohesion/friction-derived K0_nc + ψ are computed upstream in
  // `hsParams` per CUR 2003-7 / SB260-21-6.4.10 (cohesion-corrected
  // formula + binary stress-exponent default, with Stage 5 m-fit
  // overrides).  Mirror them onto the bishop material on every sync so
  // toggling alphaMethod / stiffMethod / m_ovr upstream is reflected
  // without requiring a full layer-signature rebuild.
  const fallbackE50 = Number(next.Emc) || 1000;
  next.E50_ref = Number(layer?.E50_ref) || fallbackE50;
  next.Eoed_ref = Number(layer?.Eoed_ref) || next.E50_ref;
  next.Eur_ref = Number(layer?.Eur_ref) || 3 * next.E50_ref;
  next.m = Math.min(Math.max(Number.isFinite(Number(layer?.m)) ? Number(layer.m) : 0.5, 0), 1);
  next.nu_ur = Math.min(Math.max(Number.isFinite(Number(layer?.nu_ur)) ? Number(layer.nu_ur) : 0.2, -0.99), 0.49);
  if(Number.isFinite(Number(layer?.K0nc))) next.K0nc = Number(layer.K0nc);
  if(Number.isFinite(Number(layer?.psi))) next.psi = Number(layer.psi);
  // HS-only sub-block: parameters with no upstream analogue. Only these
  // are editable from the HS panel; the inherited block above is
  // read-only (engineer edits them via the Stage 5 layer / material
  // editor).
  const hs = !next.hs || typeof next.hs !== 'object' ? {} : {...next.hs};
  next.hs = hs;
  hs.p_ref = Math.max(Number(hs.p_ref) || 100, 1e-6);
  hs.Rf = Math.min(Math.max(Number.isFinite(Number(hs.Rf)) ? Number(hs.Rf) : 0.9, 1e-6), 0.999999);
  hs.e_init = Number.isFinite(Number(hs.e_init)) ? Number(hs.e_init) : -1;
  hs.e_max = Number.isFinite(Number(hs.e_max)) ? Number(hs.e_max) : -1;
  hs.OCR = Math.max(Number(hs.OCR) || 1, 1e-6);
  const legacyHsReserved = Number(hs.reserved);
  hs.nearSurfaceMinConfiningStress = Math.max(
    Number.isFinite(Number(hs.nearSurfaceMinConfiningStress))
      ? Number(hs.nearSurfaceMinConfiningStress)
      : (Number.isFinite(legacyHsReserved) ? legacyHsReserved : 0),
    0
  );
  const hasStoredHsConsistentTangent = Object.prototype.hasOwnProperty.call(hs, 'useConsistentTangent');
  if(hasStoredHsConsistentTangent){
    hs.useConsistentTangent = hs.useConsistentTangent === true || Number(hs.useConsistentTangent) >= 0.5;
  } else {
    // Existing projects saved before the HS selector existed must not
    // silently flip into the Simo-Hughes path. New projects are handled in
    // importBishopMaterialsFromLayers(), which writes the field explicitly.
    hs.useConsistentTangent = false;
  }
  if('reserved' in hs) delete hs.reserved;
  // Strip legacy stiffness fields that may linger on an existing
  // material.hs from older project files — they now live at the
  // material's top level.
  if('E50_ref' in hs) delete hs.E50_ref;
  if('Eoed_ref' in hs) delete hs.Eoed_ref;
  if('Eur_ref' in hs) delete hs.Eur_ref;
  if('m' in hs) delete hs.m;
  if('nu_ur' in hs) delete hs.nu_ur;
  if('K0_nc' in hs) delete hs.K0_nc;
  return {material:next, legacyTangentSchema:!hasStoredHsConsistentTangent};
}

/**
 * The materials part of the sync (monolith 2880-2963) on a draft: re-import when signature.js
 * says so, then the HS mirror on every material. Writes draft.materials / sourceLayerSignature /
 * sourceStrengthSet; returns the source decision, the invalidation and the HS prompt flag.
 */
export function syncMaterials(draft, layers){
  const source = materialsSource(draft, layers);
  if(source.reimport){
    draft.materials = importBishopMaterialsFromLayers(layers, draft.materials || [], draft.strengthSet || 'characteristic');
    draft.sourceLayerSignature = source.signature;
    draft.sourceStrengthSet = draft.strengthSet;
  }
  let legacyTangentSchema = false;
  draft.materials = (draft.materials || []).map((material, index)=>{
    const mirrored = mirrorHsParams(material, layers[index]);
    if(mirrored.legacyTangentSchema) legacyTangentSchema = true;
    return mirrored.material;
  });
  const hsPromptPending = legacyTangentSchema
    && !!draft.deformation?.options
    && draft.deformation.options.hsConsistentTangentMigrationResolved !== true;
  return {source, invalidation:materialsInvalidation(source), hsPromptPending};
}

/**
 * The geometry normalisation of the sync (monolith 2964-2987) on a draft: the terrain sorted,
 * the active CPT clamped onto it, the entry / exit zones and the surface loads clamped to its
 * extent, the legacy load mirror re-synced, the walls / drains / custom regions normalised
 * against the sorted terrain and the materials. Nothing happens without two terrain points
 * (the collection guards run regardless).
 */
export function normalizeSoilGeometry(draft, ids = DEFAULT_IDS){
  if(!Array.isArray(draft.customRegions)) draft.customRegions = [];
  draft.useCustomRegions = !!draft.useCustomRegions;
  if(Array.isArray(draft.terrain) && draft.terrain.length >= 2){
    const sorted = sortedPolyline(draft.terrain);
    draft.terrain = sorted;
    const minX = sorted[0].x;
    const maxX = sorted[sorted.length-1].x;
    if(!Number.isFinite(draft.activeCptX)){
      draft.activeCptX = 0.5*(minX+maxX);
    } else {
      draft.activeCptX = Math.min(Math.max(+draft.activeCptX, minX), maxX);
    }
    ['entryZone','exitZone'].forEach((key)=>{
      const zone = sortZone(draft[key]);
      if(!zone) return;
      zone.xStart = Math.min(Math.max(zone.xStart, minX), maxX);
      zone.xEnd = Math.min(Math.max(zone.xEnd, minX), maxX);
      draft[key] = sortZone(zone);
    });
    draft.surfaceLoads = (draft.surfaceLoads || []).map((load, index)=>{
      const normalized = normalizeSurfaceLoad(load, index, draft);
      if(validZone(normalized)){
        normalized.xStart = Math.min(Math.max(normalized.xStart, minX), maxX);
        normalized.xEnd = Math.min(Math.max(normalized.xEnd, minX), maxX);
        return sortZone(normalized) || normalized;
      }
      return normalized;
    }).filter((load)=>validZone(load));
    syncLegacySurfaceLoadMirror(draft);
    draft.walls = normalizeWalls(draft.walls, sorted);
    draft.drains = normalizeDrains(draft.drains);
    draft.customRegions = normalizeCustomRegions(draft.customRegions, sorted, draft.materials, ids);
  }
}

/**
 * The selection pruning of the sync (monolith 2988-3004) on a draft: a wall / drain / region /
 * draft-material selection that no longer exists is cleared (drain and region fall back to the
 * first one), the custom set is disabled without polygons, and a split / hole tool without a
 * selected polygon falls back to the edit tool.
 */
export function pruneSelections(draft){
  draft.selectedWallId = draft.selectedWallId ? String(draft.selectedWallId) : null;
  if(draft.selectedWallId && !(draft.walls || []).some((wall)=>wall.id === draft.selectedWallId)){
    draft.selectedWallId = null;
  }
  if(!(draft.drains || []).some((drain)=>drain.id === draft.selectedDrainId)){
    draft.selectedDrainId = draft.drains?.[0]?.id || '';
  }
  const validMaterialIds = new Set((draft.materials || []).map((material)=>material.id));
  if(!validMaterialIds.has(draft.regionDraftMaterialId)){
    draft.regionDraftMaterialId = draft.materials?.[0]?.id || null;
  }
  if(!(draft.customRegions || []).some((region)=>region.id === draft.selectedRegionId)){
    draft.selectedRegionId = draft.customRegions?.[0]?.id || null;
  }
  if(!(draft.customRegions || []).length) draft.useCustomRegions = false;
  if((draft.tool === 'regionSplit' || draft.tool === 'regionHole') && !draft.selectedRegionId){
    draft.tool = 'edit';
    draft.draft = [];
    draft.draftKind = '';
  }
}

/** The whole sync as a patch of `bishop` (see the header). `bishop` is not mutated. */
export function syncSoilModel(bishop, layers, env = {}){
  const ids = env.ids || DEFAULT_IDS;
  const draft = {...bishop};
  // the surface-load migration pushes into an existing empty array — copy it so the input stays untouched
  if(Array.isArray(bishop.surfaceLoads)) draft.surfaceLoads = bishop.surfaceLoads.slice();
  migrateSurfaceLoadsShape(draft);
  const materials = syncMaterials(draft, layers);
  normalizeSoilGeometry(draft, ids);
  pruneSelections(draft);
  const patch = {};
  for(const key of SOIL_MODEL_PATCH_KEYS){
    if(!(key in draft)) continue;
    if(ser(draft[key]) !== ser(bishop[key])) patch[key] = draft[key];
  }
  if(materials.hsPromptPending && bishop.deformation?.options?.hsConsistentTangentPromptPending !== true){
    patch[HS_PROMPT_PATH] = true;
  }
  return {
    changed:Object.keys(patch).length > 0,
    patch,
    invalidation:materials.invalidation,
    reimported:materials.source.reimport,
    source:materials.source,
    layers
  };
}

/** Write a patch into the block in place (dotted keys walk into nested objects; the block keeps its identity). */
export function applySoilModelPatch(bishop, patch){
  for(const [path, value] of Object.entries(patch || {})){
    if(!path.includes('.')){
      bishop[path] = value;
      continue;
    }
    const parts = path.split('.');
    let target = bishop;
    for(let i = 0; i < parts.length - 1; i += 1){
      if(!target[parts[i]] || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length-1]] = value;
  }
  return bishop;
}

/** The block with the patch applied, as a new object along every written path; `bishop` untouched. */
export function previewState(bishop, patch){
  const next = {...bishop};
  for(const [path, value] of Object.entries(patch || {})){
    if(!path.includes('.')){
      next[path] = value;
      continue;
    }
    const parts = path.split('.');
    let target = next;
    for(let i = 0; i < parts.length - 1; i += 1){
      const child = target[parts[i]];
      target[parts[i]] = child && typeof child === 'object' ? {...child} : {};
      target = target[parts[i]];
    }
    target[parts[parts.length-1]] = value;
  }
  return next;
}

/** The engine's builder under the package's env contract (`env.options` → the engine options). */
export function buildBishopModel(layers, bishop, env = {}){
  return buildBishopModelFromStageLayers(layers, bishop, env.options || {});
}

/**
 * The sync and the model of the synced state, without mutating `bishop`: what
 * stage6BishopCurrentModel computed (minus the seepage-state sync, seepage/boundary.js, which
 * stays a host concern until step 9c). Every consumer that builds a model from the state
 * (render, run handlers, canvas draw, report capture) gets the same model for the same inputs.
 */
export function soilModelFromState(bishop, layers, env = {}){
  const sync = syncSoilModel(bishop, layers, env);
  const state = sync.changed ? previewState(bishop, sync.patch) : bishop;
  return {model:buildBishopModel(layers, state, env), sync, state};
}
