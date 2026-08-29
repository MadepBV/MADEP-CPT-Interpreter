// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/walls.js — the retaining walls of the Seep / Slope state, refactor step 9a.
// Moved verbatim from legacy-controller.js (462fc50 lines 5171-5285: stage6BishopPassiveSideLabel …
// NormalizeWalls; 5450-5452 ResultWallLabel; the wall handlers 7318-7420: SetWallField,
// SetWallMaterialField, DeleteWall, SelectWall; the inline wall creation of the canvas pointer
// path 10620-10645 / 10704-10729 as `addWall`). `S.stage6.bishop` became the `bishop` parameter;
// the host side effects (ensureStage6State, stage6BishopSyncSoilModel, the invalidators,
// renderStage6) stayed in the host façades:
//
//   pure helpers       passiveSideLabel, defaultPassiveSide(terrain), wallId(ids),
//                      defaultWallMaterial, wallMaterialPreset, wallMaterialPresetKey,
//                      normalizeWalls(walls, terrain), resultWallLabel
//   writes of `bishop` addWall, setWallField, setWallMaterialField, deleteWall, selectWall
//
// The state operations return what the host needs for invalidation:
//   addWall               the new wall id (host invalidates the wall geometry)
//   setWallField          'mechanical' | 'geometry' | 'other' (which invalidator), null = no wall
//   setWallMaterialField  { seepage, deformation } (which invalidators), null = no wall / rejected value
//   deleteWall            the removed wall or null (host invalidates the wall geometry regardless)
//   selectWall            the selected wall or null; with `ui` (stage6.ui) the structures panel opens
import {
  defaultWallMechanicalMaterial,
  normalizeWallMaterial,
  resolveWallMechanicalSection,
  wallMechanicalPresetById
} from '../../seepage/material.js';
import { wallAxis, wallEndpoints } from '../../wall-geometry.js';
import { terrainY as bishopTerrainY } from '../../stage6-bishop.js';
import { DEFAULT_IDS, entityId } from './ids.js';

export function passiveSideLabel(side){
  return side === 'left' ? 'Left' : 'Right';
}

/** The passive side a new wall gets: the lower end of the terrain (right when level or unknown). */
export function defaultPassiveSide(terrain = []){
  if(terrain.length >= 2){
    return terrain[terrain.length-1].y <= terrain[0].y ? 'right' : 'left';
  }
  return 'right';
}

/** `wall_<now36>_<rand>` */
export function wallId(ids = DEFAULT_IDS){
  return entityId('wall', ids);
}

/** The material of a freshly drawn wall: an impermeable concrete diaphragm (preset source). */
export function defaultWallMaterial(index = 0, wallId = ''){
  return normalizeWallMaterial(
    {
      id:`wall-material-${wallId || index + 1}`,
      label:'Concrete diaphragm',
      kAcross:1e-12,
      kAlong:1e-12,
      gamma:24,
      gammaSat:24,
      kSource:'preset',
      mechanical:defaultWallMechanicalMaterial('preset')
    },
    index,
    wallId || `${index + 1}`,
    {sourceFallback:'preset', mechanicalPreset:'concrete-diaphragm'}
  );
}

/** A wall material from the preset table of the wall panel (unknown preset → legacy impermeable). */
export function wallMaterialPreset(preset, index = 0, wallId = ''){
  const presets = {
    sheetPile:{label:'Sheet pile', kAcross:1e-10, kAlong:1e-8},
    'steel-sheet-pile-AZ-26':{label:'Steel sheet pile AZ 26', kAcross:1e-12, kAlong:1e-12, gamma:78, gammaSat:78},
    'concrete-diaphragm':{label:'Concrete diaphragm', kAcross:1e-12, kAlong:1e-12, gamma:24, gammaSat:24},
    slurry:{label:'Slurry wall', kAcross:1e-9, kAlong:1e-9},
    diaphragm:{label:'Diaphragm wall', kAcross:1e-9, kAlong:1e-9},
    soilMix:{label:'Soil-mix wall', kAcross:1e-7, kAlong:1e-7},
    relief:{label:'Relief wall', kAcross:1e-6, kAlong:1e-5},
    legacy:{label:'Legacy impermeable', kAcross:1e-10, kAlong:1e-10}
  };
  const presetDef = presets[preset] || presets.legacy;
  const mechanicalPreset = wallMechanicalPresetById(preset);
  return normalizeWallMaterial(
    {
      id:`wall-material-${wallId || index + 1}`,
      ...presetDef,
      kSource:'preset',
      mechanical:mechanicalPreset?.mechanical
    },
    index,
    wallId || `${index + 1}`,
    {sourceFallback:'preset', mechanicalPreset:preset}
  );
}

/** The preset key a material matches (for the panel's <select>), 'custom' when none. */
export function wallMaterialPresetKey(material){
  if(material?.kSource === 'legacy-impermeable') return 'legacy';
  if(material?.kSource === 'user') return 'custom';
  const mechanical = material?.mechanical || {};
  if(mechanical.model === 'section-properties') return 'steel-sheet-pile-AZ-26';
  if(mechanical.model === 'rectangular' && Math.abs((Number(mechanical.E) || 0) - 3e7) <= 3e4 && Math.abs((Number(mechanical.thickness) || 0) - 0.6) <= 1e-6) return 'concrete-diaphragm';
  const kAcross = Number(material?.kAcross);
  const kAlong = Number(material?.kAlong);
  const close = (value, target)=>Number.isFinite(value) && Math.abs(value - target) <= Math.max(Math.abs(target) * 1e-9, 1e-16);
  if(close(kAcross, 1e-10) && close(kAlong, 1e-8)) return 'sheetPile';
  if(close(kAcross, 1e-9) && close(kAlong, 1e-9)) return String(material?.label || '').toLowerCase().includes('diaphragm') ? 'diaphragm' : 'slurry';
  if(close(kAcross, 1e-7) && close(kAlong, 1e-7)) return 'soilMix';
  if(close(kAcross, 1e-6) && close(kAlong, 1e-5)) return 'relief';
  if(close(kAcross, 1e-10) && close(kAlong, 1e-10)) return 'legacy';
  return 'custom';
}

/**
 * Every wall in canonical shape: head / tip endpoints (legacy x / yTop / yTip walls get theirs
 * from the terrain), x clamped to the terrain, a minimum length of 0.05 m, the legacy aliases kept,
 * the material normalised (walls without one become legacy-impermeable), rounded to mm and sorted
 * by head x. Walls without an axis are dropped.
 */
export function normalizeWalls(walls, terrain){
  const terrainLine = terrain?.length ? {vertices:terrain} : null;
  const minX = terrain?.length ? terrain[0].x : -Infinity;
  const maxX = terrain?.length ? terrain[terrain.length-1].x : Infinity;
  return (walls || [])
    .map((wall, index)=>{
      const id = wall?.id || `wall-${index + 1}`;
      const hadMaterial = !!(wall?.material && typeof wall.material === 'object');
      const hasMechanicalActiveField = Object.prototype.hasOwnProperty.call(wall || {}, 'mechanicalActive');
      const mechanicalActive = hasMechanicalActiveField ? wall?.mechanicalActive === true : false;
      const legacyX = Number.isFinite(+wall?.x) ? +wall.x : minX;
      const xFallback = Math.min(Math.max(legacyX, minX), maxX);
      const endpoints = wallEndpoints(wall);
      const headRaw = endpoints?.head || {
        x:xFallback,
        y:Number.isFinite(+wall?.yTop)
          ? +wall.yTop
          : terrainLine
            ? bishopTerrainY(terrainLine, xFallback)
            : NaN
      };
      const tipRaw = endpoints?.tip || {
        x:xFallback,
        y:Number.isFinite(+wall?.yTip) ? +wall.yTip : NaN
      };
      const head = {
        x:Math.min(Math.max(Number(headRaw.x), minX), maxX),
        y:Number(headRaw.y)
      };
      let tip = {
        x:Math.min(Math.max(Number(tipRaw.x), minX), maxX),
        y:Number(tipRaw.y)
      };
      if(Number.isFinite(head.x) && Number.isFinite(head.y) && Number.isFinite(tip.x) && Number.isFinite(tip.y)){
        const len = Math.hypot(tip.x - head.x, tip.y - head.y);
        if(len < 0.05){
          tip = {x:head.x, y:head.y - 0.05};
        }
      }
      return {
        id,
        head,
        tip,
        // Legacy aliases kept during migration for old UI/report code.
        x:head.x,
        yTop:head.y,
        yTip:tip.y,
        passiveSide:wall?.passiveSide === 'left' ? 'left' : 'right',
        mechanicalActive,
        mechanicalActivationPromptPending:!hasMechanicalActiveField && !!wall,
        anchors:Array.isArray(wall?.anchors) ? wall.anchors : [],
        maxShearForce:Number.isFinite(+wall?.maxShearForce) && +wall.maxShearForce > 0 ? +wall.maxShearForce : null,
        // Soil-wall interface R_inter (deformation module): must survive every
        // normalize pass or the wall-table input is silently discarded and the
        // interface always solves with the 0.667 preset.
        interfaceRInter:Number.isFinite(+wall?.interfaceRInter) && +wall.interfaceRInter > 0
          ? Math.min(Math.max(+wall.interfaceRInter, 0.01), 1.0)
          : null,
        material:normalizeWallMaterial(wall?.material, index, id, {
          sourceFallback:hadMaterial ? 'user' : 'legacy-impermeable',
          mechanicalPreset:mechanicalActive ? 'concrete-diaphragm' : null
        })
      };
    })
    .filter((wall)=>wallAxis(wall, 1e-9))
    .map((wall)=>{
      wall.head = {x:+wall.head.x.toFixed(3), y:+wall.head.y.toFixed(3)};
      wall.tip = {x:+wall.tip.x.toFixed(3), y:+wall.tip.y.toFixed(3)};
      wall.x = wall.head.x;
      wall.yTop = wall.head.y;
      wall.yTip = wall.tip.y;
      return wall;
    })
    .sort((a,b)=>a.head.x-b.head.x || b.head.y-a.head.y || a.tip.x-b.tip.x);
}

/** The wall column of the results table. */
export function resultWallLabel(result){
  if(!result) return '—';
  if(result.intersectsWall) return `${result.wallIntersectionCount || 0} engaged`;
  if(result.passesBelowWall) return 'passes below';
  return 'no wall effect';
}

/**
 * Append a wall from `head` (on the terrain) to `tip` — the wall tool's second click —, mechanically
 * active with the default concrete material, normalise the list and select it. Returns the id.
 */
export function addWall(bishop, head, tip, ids = DEFAULT_IDS){
  const id = wallId(ids);
  bishop.walls = [
    ...(bishop.walls || []),
    {
      id,
      head:{x:head.x, y:head.y},
      tip:{x:tip.x, y:tip.y},
      x:head.x,
      yTop:head.y,
      yTip:tip.y,
      passiveSide:defaultPassiveSide(bishop.terrain || []),
      mechanicalActive:true,
      anchors:[],
      maxShearForce:null,
      material:defaultWallMaterial((bishop.walls || []).length, id)
    }
  ];
  bishop.walls = normalizeWalls(bishop.walls, bishop.terrain);
  bishop.selectedWallId = id;
  return id;
}

/**
 * Set one field of wall `index` (passiveSide, maxShearForce, interfaceRInter, mechanicalActive,
 * head.x/y, tip.x/y, the legacy x / yTop / yTip, or any other numeric key) and re-normalise the
 * list. Returns the invalidation class: 'mechanical' (activation), 'geometry' (an endpoint),
 * 'other'; null when there is no such wall.
 */
export function setWallField(bishop, index, field, value){
  const wall = bishop.walls?.[index];
  if(!wall) return null;
  if(field === 'passiveSide'){
    wall.passiveSide = value === 'left' ? 'left' : 'right';
  } else if(field === 'maxShearForce'){
    wall.maxShearForce = value === '' || value == null ? null : Math.max(+value || 0, 0);
  } else if(field === 'interfaceRInter'){
    const r = value === '' || value == null ? null : +value;
    wall.interfaceRInter = Number.isFinite(r) && r > 0 ? Math.min(Math.max(r, 0.01), 1) : null;
  } else if(field === 'mechanicalActive'){
    wall.mechanicalActive = value === true || value === 'true' || value === 1 || value === '1';
    wall.mechanicalActivationPromptPending = false;
  } else if(field === 'head.x' || field === 'head.y' || field === 'tip.x' || field === 'tip.y'){
    const [endKey, coordKey] = field.split('.');
    if(!wall[endKey] || typeof wall[endKey] !== 'object') wall[endKey] = {};
    wall[endKey][coordKey] = value === '' || value == null ? null : +value;
  } else if(field === 'x'){
    const nextX = value === '' || value == null ? null : +value;
    const axis = wallAxis(wall);
    if(Number.isFinite(nextX)){
      const dx = axis ? axis.tip.x - axis.head.x : 0;
      wall.head = {...(wall.head || {x:wall.x, y:wall.yTop}), x:nextX};
      wall.tip = {...(wall.tip || {x:wall.x, y:wall.yTip}), x:nextX + dx};
    }
  } else if(field === 'yTop'){
    wall.head = {...(wall.head || {x:wall.x, y:wall.yTop}), y:value === '' || value == null ? null : +value};
  } else if(field === 'yTip'){
    wall.tip = {...(wall.tip || {x:wall.x, y:wall.yTip}), y:value === '' || value == null ? null : +value};
  } else {
    wall[field] = value === '' || value == null ? null : +value;
  }
  bishop.walls = normalizeWalls(bishop.walls, bishop.terrain);
  if(field === 'mechanicalActive') return 'mechanical';
  if(field === 'x' || field === 'yTop' || field === 'yTip' || field.startsWith('head.') || field.startsWith('tip.')) return 'geometry';
  return 'other';
}

/**
 * Set one field of the material of wall `index` (preset, mechanical.model, mechanical.<E|thickness|
 * EA|EI|GA|kappa|nu>, label, kAcross, kAlong) and re-normalise the list. Returns which analyses the
 * change touches, `{ seepage, deformation }`; null when there is no such wall or the value was
 * rejected (non-positive stiffness / conductivity, ν outside [0, 0.5)) — the material was still
 * normalised to a user material in that case, as before.
 */
export function setWallMaterialField(bishop, index, field, value){
  const wall = bishop.walls?.[index];
  if(!wall) return null;
  wall.material = normalizeWallMaterial(wall.material, index, wall.id, {sourceFallback:'user'});
  if(field === 'preset'){
    wall.material = wallMaterialPreset(value, index, wall.id);
  } else if(field === 'mechanical.model'){
    const nextModel = value === 'section-properties' ? 'section-properties' : 'rectangular';
    if(nextModel === 'section-properties'){
      wall.material.mechanical = {
        model:'section-properties',
        EA:resolveWallMechanicalSection(wall.material.mechanical).EA,
        EI:resolveWallMechanicalSection(wall.material.mechanical).EI,
        GA:resolveWallMechanicalSection(wall.material.mechanical).GA,
        kappa:1,
        source:'user'
      };
    } else {
      wall.material.mechanical = defaultWallMechanicalMaterial('user');
    }
  } else if(field.startsWith('mechanical.')){
    const key = field.slice('mechanical.'.length);
    const mechanical = {...(wall.material.mechanical || defaultWallMechanicalMaterial('user'))};
    const nextValue = value === '' || value == null ? null : +value;
    if(key === 'E' || key === 'thickness' || key === 'EA' || key === 'EI' || key === 'GA' || key === 'kappa'){
      if(!(nextValue > 0)) return null;
      mechanical[key] = nextValue;
    } else if(key === 'nu'){
      if(!(Number.isFinite(nextValue) && nextValue >= 0 && nextValue < 0.5)) return null;
      mechanical.nu = nextValue;
    }
    mechanical.source = 'user';
    wall.material.mechanical = mechanical;
  } else if(field === 'label'){
    wall.material.label = String(value || '').trim() || 'Wall material';
    wall.material.kSource = 'user';
  } else if(field === 'kAcross' || field === 'kAlong'){
    const nextValue = value === '' || value == null ? null : +value;
    if(!(nextValue > 0)) return null;
    wall.material[field] = nextValue;
    wall.material.kSource = 'user';
  }
  bishop.walls = normalizeWalls(bishop.walls, bishop.terrain);
  return {
    seepage:field === 'kAcross' || field === 'kAlong' || field === 'preset',
    deformation:field.startsWith('mechanical.') || field === 'preset'
  };
}

/** Remove wall `index` (clearing its selection). Returns the removed wall or null. */
export function deleteWall(bishop, index){
  const removed = bishop.walls?.[index] || null;
  bishop.walls = (bishop.walls || []).filter((_, wallIndex)=>wallIndex !== index);
  if(removed?.id === bishop.selectedWallId){
    bishop.selectedWallId = null;
  }
  return removed;
}

/**
 * Select a wall by id (an unknown id clears the selection). Selecting drops the load / drain /
 * region selections and, given the Stage 6 `ui` state, opens the structures panel of the tool rail.
 */
export function selectWall(bishop, wallId, ui = null){
  const wall = (bishop.walls || []).find((item)=>item.id === wallId);
  bishop.selectedWallId = wall ? wall.id : null;
  if(wall){
    bishop.selectedSurfaceLoadId = null;
    bishop.selectedDrainId = '';
    bishop.selectedRegionId = null;
    if(ui){
      ui.bishopActiveCanvasPanel = 'structures';
      ui.bishopActiveCanvasSheet = '';
      ui.bishopCanvasToolsHidden = false;
    }
  }
  return wall || null;
}
