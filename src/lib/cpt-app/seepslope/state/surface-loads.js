// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/surface-loads.js — the surface loads (and the entry / exit / load zones they
// share their x-range shape with) of the Seep / Slope state, refactor step 9a. Moved verbatim
// from legacy-controller.js (462fc50 lines 4885-5147: stage6BishopSortZone … CreateSurfaceLoadFromZone,
// plus ZoneKey / ZoneLabel / ZoneColor of 5148-5170); the only change is that `S.stage6.bishop`
// became the `bishop` parameter and the host side effects (ensureStage6State, the <details>
// memory, stage6BishopInvalidate, renderStage6) stayed in the host façades:
//
//   pure helpers       sortZone, validZone, zoneKey, zoneLabel, zoneColor, allocateSurfaceLoadId,
//                      normalizeSurfaceLoad, legacySurfaceLoadSeed
//   reads of `bishop`  selectedSurfaceLoad, effectiveSurfaceLoadQ, surfaceLoadSummary,
//                      activeSurfaceLoads (the last one migrates the shape first, as before)
//   writes of `bishop` syncLegacySurfaceLoadMirror, migrateSurfaceLoadsShape (the v1 → v2 shape
//                      migration, also a step of ensure()), primarySurfaceLoad(create),
//                      setSurfaceLoadField, selectSurfaceLoad, deleteSurfaceLoad,
//                      createSurfaceLoadFromZone
//
// The state operations return what the host needs to decide on invalidation / render:
//   setSurfaceLoadField      the changed load, or null when nothing changed (unknown load / field,
//                            non-finite x) — the host invalidates + renders only for a load
//   deleteSurfaceLoad        true when a load was removed (host invalidates), render regardless
//   createSurfaceLoadFromZone the new load (host invalidates) or null for an invalid zone
// Surface-load ids are `load-<n>` (first free index), deterministic — no clock involved.

/** Zone with xStart ≤ xEnd (null for a zone without two finite x). */
export function sortZone(zone){
  if(!zone || !Number.isFinite(zone.xStart) || !Number.isFinite(zone.xEnd)) return null;
  return {
    ...zone,
    xStart:Math.min(zone.xStart, zone.xEnd),
    xEnd:Math.max(zone.xStart, zone.xEnd)
  };
}

/** A zone with two finite x more than 1e-6 apart. */
export function validZone(zone){
  return !!zone
    && Number.isFinite(zone.xStart)
    && Number.isFinite(zone.xEnd)
    && Math.abs(zone.xEnd - zone.xStart) > 1e-6;
}

/** The state key a draft zone kind writes to (`entry` → entryZone, `exit` → exitZone, `load` → surfaceLoad). */
export function zoneKey(kind){
  if(kind === 'entry') return 'entryZone';
  if(kind === 'exit') return 'exitZone';
  if(kind === 'load') return 'surfaceLoad';
  return '';
}

export function zoneLabel(kind){
  if(kind === 'entry') return 'Entry zone';
  if(kind === 'exit') return 'Exit zone';
  if(kind === 'load') return 'Load zone';
  return 'Zone';
}

export function zoneColor(kind){
  if(kind === 'entry') return '#3aa35f';
  if(kind === 'exit') return '#d27b2d';
  if(kind === 'load') return '#b3477a';
  return '#5c6b7a';
}

/** First free `load-<n>` id. */
export function allocateSurfaceLoadId(bishop){
  const taken = new Set((bishop.surfaceLoads || []).map((load)=>String(load?.id || '')).filter(Boolean));
  let index = 1;
  while(taken.has(`load-${index}`)) index += 1;
  return `load-${index}`;
}

/** One load in canonical shape (id, label, q, totalLoad, loadMode, active, sorted finite x or null). */
export function normalizeSurfaceLoad(load, index, bishop){
  const out = load && typeof load === 'object' ? {...load} : {};
  out.id = String(out.id || `load-${index + 1}`);
  out.label = String(out.label || `Load ${index + 1}`).slice(0, 64);
  out.q = Math.max(Number(out.q) || 0, 0);
  out.totalLoad = Math.max(Number(out.totalLoad) || 0, 0);
  out.loadMode = out.loadMode === 'total' ? 'total' : out.loadMode === 'pressure'
    ? 'pressure'
    : bishop?.deformation?.options?.loadMode === 'total'
      ? 'total'
      : 'pressure';
  out.active = out.active !== false;
  if(Number.isFinite(Number(out.xStart))) out.xStart = Number(out.xStart);
  else out.xStart = null;
  if(Number.isFinite(Number(out.xEnd))) out.xEnd = Number(out.xEnd);
  else out.xEnd = null;
  const sorted = sortZone(out);
  return sorted || out;
}

/** Keep the legacy single `surfaceLoad` mirror equal to the first active load (old UI / report code reads it). */
export function syncLegacySurfaceLoadMirror(bishop){
  if(!bishop) return;
  const first = (bishop.surfaceLoads || []).find((load)=>load?.active !== false)
    || (bishop.surfaceLoads || [])[0]
    || null;
  bishop.surfaceLoad = first
    ? {xStart:first.xStart, xEnd:first.xEnd, q:Math.max(Number(first.q) || 0, 0)}
    : {
      xStart:null,
      xEnd:null,
      q:Math.max(Number(bishop.surfaceLoad?.q) || 0, 0)
    };
}

/** The v1 single `surfaceLoad` {xStart, xEnd, q} as a v2 load (null when it has no extent). */
export function legacySurfaceLoadSeed(bishop, legacy){
  if(!legacy || !Number.isFinite(Number(legacy.xStart)) || !Number.isFinite(Number(legacy.xEnd))) return null;
  const migratedLegacy = normalizeSurfaceLoad({
    id:allocateSurfaceLoadId(bishop),
    label:'Load 1',
    xStart:Number(legacy.xStart),
    xEnd:Number(legacy.xEnd),
    q:Math.max(Number(legacy.q) || 0, 0),
    totalLoad:Math.max(Number(bishop.deformation?.options?.totalLoad) || 0, 0),
    loadMode:bishop.deformation?.options?.loadMode === 'total' ? 'total' : 'pressure',
    active:true
  }, 0, bishop);
  return validZone(migratedLegacy) ? migratedLegacy : null;
}

/**
 * Shape migration v1 → v2: a saved session with the single `surfaceLoad` and no `surfaceLoads[]`
 * gets its load seeded into the array; every load is normalised, ids de-duplicated, invalid zones
 * dropped, auto labels renumbered, a dangling selection cleared, and the legacy mirror re-synced.
 */
export function migrateSurfaceLoadsShape(bishop){
  if(!bishop) return;
  const legacy = bishop.surfaceLoad && typeof bishop.surfaceLoad === 'object' ? bishop.surfaceLoad : null;
  const hadLoads = Array.isArray(bishop.surfaceLoads);
  if(!hadLoads) bishop.surfaceLoads = [];
  if(!bishop.surfaceLoads.length){
    const seed = legacySurfaceLoadSeed(bishop, legacy);
    if(seed) bishop.surfaceLoads.push(seed);
  }
  const used = new Set();
  bishop.surfaceLoads = (bishop.surfaceLoads || []).map((load, index)=>{
    const normalized = normalizeSurfaceLoad(load, index, bishop);
    let id = normalized.id || `load-${index + 1}`;
    if(used.has(id)){
      id = allocateSurfaceLoadId({...bishop, surfaceLoads:[...used].map((item)=>({id:item}))});
    }
    used.add(id);
    normalized.id = id;
    return normalized;
  }).filter((load)=>validZone(load));
  if(!bishop.surfaceLoads.length){
    const seed = legacySurfaceLoadSeed(bishop, legacy);
    if(seed) bishop.surfaceLoads.push(seed);
  }
  bishop.surfaceLoads.forEach((load, index)=>{
    if(/^Load\s+\d+$/i.test(String(load.label || ''))) load.label = `Load ${index + 1}`;
  });
  if(bishop.selectedSurfaceLoadId && !(bishop.surfaceLoads || []).some((load)=>load.id === bishop.selectedSurfaceLoadId)){
    bishop.selectedSurfaceLoadId = null;
  }
  syncLegacySurfaceLoadMirror(bishop);
}

export function selectedSurfaceLoad(bishop){
  if(!bishop) return null;
  return (bishop.surfaceLoads || []).find((load)=>load.id === bishop.selectedSurfaceLoadId) || null;
}

/** The selected, else first active, else first load; with `create`, a new 5 kPa load is appended and selected. */
export function primarySurfaceLoad(bishop, create = false){
  if(!bishop) return null;
  migrateSurfaceLoadsShape(bishop);
  let load = selectedSurfaceLoad(bishop)
    || (bishop.surfaceLoads || []).find((item)=>item.active !== false)
    || (bishop.surfaceLoads || [])[0]
    || null;
  if(!load && create){
    load = {
      id:allocateSurfaceLoadId(bishop),
      label:`Load ${(bishop.surfaceLoads || []).length + 1}`,
      xStart:null,
      xEnd:null,
      q:Math.max(Number(bishop.surfaceLoad?.q) || 5, 0),
      totalLoad:0,
      loadMode:'pressure',
      active:true
    };
    bishop.surfaceLoads = [...(bishop.surfaceLoads || []), load];
    bishop.selectedSurfaceLoadId = load.id;
    syncLegacySurfaceLoadMirror(bishop);
  }
  return load;
}

/** The pressure (kPa) a load applies in `workspace`: q, or totalLoad / (width × out-of-plane length) in total mode. */
export function effectiveSurfaceLoadQ(bishop, load, workspace = bishop?.workspace || 'stability'){
  if(!load) return 0;
  const loadMode = load.loadMode === 'total'
    ? 'total'
    : load.loadMode === 'pressure'
      ? 'pressure'
      : workspace === 'deformation' && bishop?.deformation?.options?.loadMode === 'total'
        ? 'total'
        : 'pressure';
  const width = Math.abs((Number(load.xEnd) || 0) - (Number(load.xStart) || 0));
  if(loadMode === 'total'){
    const outOfPlaneLength = Math.max(Number(bishop?.deformation?.options?.outOfPlaneLength) || 10, 0.1);
    const loadCount = Array.isArray(bishop?.surfaceLoads) ? bishop.surfaceLoads.length : 0;
    const legacyTotalLoad = loadCount <= 1 ? Number(bishop?.deformation?.options?.totalLoad) || 0 : 0;
    const totalLoad = Math.max(Number(load.totalLoad) || legacyTotalLoad || 0, 0);
    return width > 1e-9 ? totalLoad / Math.max(width * outOfPlaneLength, 1e-6) : 0;
  }
  return Math.max(Number(load.q) || 0, 0);
}

export function surfaceLoadSummary(bishop, load, workspace = bishop?.workspace || 'stability'){
  if(!validZone(load)) return 'not set';
  const q = effectiveSurfaceLoadQ(bishop, load, workspace);
  const modeLabel = load.loadMode === 'total' ? `total ${Math.max(Number(load.totalLoad) || 0, 0).toFixed(1)} kN` : `${q.toFixed(1)} kPa`;
  return `${load.xStart.toFixed(2)}-${load.xEnd.toFixed(2)} m @ ${modeLabel}${load.active === false ? ' (inactive)' : q > 0 ? '' : ' (zero)'}`;
}

/** The loads the solvers see: active, with a valid extent and a positive effective pressure. */
export function activeSurfaceLoads(bishop, workspace = bishop?.workspace || 'stability'){
  if(!bishop) return [];
  migrateSurfaceLoadsShape(bishop);
  return (bishop.surfaceLoads || []).filter((load)=>load.active !== false && validZone(load) && effectiveSurfaceLoadQ(bishop, load, workspace) > 0);
}

/**
 * Set one field of a load (active / label / loadMode / q / totalLoad / xStart / xEnd, the x
 * clamped to the terrain extent and re-sorted), select it and re-sync the mirror. Returns the load,
 * or null when nothing changed (unknown load or field, non-finite x).
 */
export function setSurfaceLoadField(bishop, loadId, field, value){
  migrateSurfaceLoadsShape(bishop);
  const load = (bishop.surfaceLoads || []).find((item)=>item.id === loadId);
  if(!load) return null;
  if(field === 'active'){
    load.active = !!value;
  } else if(field === 'label'){
    load.label = String(value || '').slice(0, 64);
  } else if(field === 'loadMode'){
    load.loadMode = value === 'total' ? 'total' : 'pressure';
  } else if(field === 'q'){
    load.q = Math.max(Number(value) || 0, 0);
  } else if(field === 'totalLoad'){
    load.totalLoad = Math.max(Number(value) || 0, 0);
  } else if(field === 'xStart' || field === 'xEnd'){
    const x = Number(value);
    if(!Number.isFinite(x)) return null;
    const minX = bishop.terrain?.[0]?.x ?? -Infinity;
    const maxX = bishop.terrain?.[bishop.terrain.length - 1]?.x ?? Infinity;
    load[field] = Math.min(Math.max(x, minX), maxX);
    Object.assign(load, sortZone(load) || load);
  } else {
    return null;
  }
  bishop.selectedSurfaceLoadId = load.id;
  syncLegacySurfaceLoadMirror(bishop);
  return load;
}

/** Select a load (null / '' clears); selecting switches the canvas tool to `edit`. */
export function selectSurfaceLoad(bishop, loadId){
  migrateSurfaceLoadsShape(bishop);
  bishop.selectedSurfaceLoadId = loadId || null;
  if(loadId) bishop.tool = 'edit';
}

/** Remove a load by id; true when one was removed (the mirror is then re-synced). */
export function deleteSurfaceLoad(bishop, loadId){
  const before = (bishop.surfaceLoads || []).length;
  bishop.surfaceLoads = (bishop.surfaceLoads || []).filter((load)=>load.id !== loadId);
  if(bishop.selectedSurfaceLoadId === loadId) bishop.selectedSurfaceLoadId = null;
  const changed = bishop.surfaceLoads.length !== before;
  if(changed) syncLegacySurfaceLoadMirror(bishop);
  return changed;
}

/**
 * Append a load over `zone` (the load tool's second click), inheriting q / totalLoad / loadMode
 * from the primary load (5 kPa without one), select it and switch to `edit`. Returns the load,
 * or null for an invalid zone.
 */
export function createSurfaceLoadFromZone(bishop, zone){
  migrateSurfaceLoadsShape(bishop);
  if(!validZone(zone)) return null;
  const source = primarySurfaceLoad(bishop, false);
  const id = allocateSurfaceLoadId(bishop);
  const load = {
    id,
    label:`Load ${(bishop.surfaceLoads || []).length + 1}`,
    xStart:zone.xStart,
    xEnd:zone.xEnd,
    q:Math.max(Number(source?.q ?? bishop.surfaceLoad?.q) || 5, 0),
    totalLoad:Math.max(Number(source?.totalLoad) || 0, 0),
    loadMode:source?.loadMode === 'total' ? 'total' : 'pressure',
    active:true
  };
  bishop.surfaceLoads = [...(bishop.surfaceLoads || []), load];
  bishop.selectedSurfaceLoadId = id;
  bishop.tool = 'edit';
  syncLegacySurfaceLoadMirror(bishop);
  return load;
}
