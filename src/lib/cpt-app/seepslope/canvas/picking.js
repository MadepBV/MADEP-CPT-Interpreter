// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/picking.js — what the pointer is over, what a point snaps to, and what a click
// in a draw tool commits (refactor step 9e, PLAN §2 row 18e; 01-monolith-map.md §2.11 group
// "Canvas interaction", §6.1 row `canvas/snap.js`).
//
// Everything here is pure **given a viewport**: the bishop block, a world point and the viewport go
// in, an answer comes out. No `S`, no DOM, no canvas element — the host passes the canvas'
// bounding rect where a screen distance is needed.
//
// Moved verbatim out of legacy-controller.js (line numbers of integration-r @ 3b84193):
//   stage6BishopScreenToWorld         5406 → viewport.screenToWorldFromClient (re-used here)
//   stage6BishopCurrentDragKey        5430 → currentDragKey(drag)
//   stage6BishopSnapPointKey          5437 → snapPointKey
//   stage6BishopCollectSnapPoints     5441 → collectSnapPoints(bishop, excludeKey)
//   stage6BishopNearestPointSnap      5493 → nearestPointSnap
//   stage6BishopSnapWorldPoint        5513 → snapWorldPoint
//   stage6BishopNearestHandle         5590 → nearestHandle(bishop, viewport, rect, clientX, clientY)
//   stage6BishopPickSurfaceLoadAtWorld 5643 → pickSurfaceLoadAtWorld
//   stage6BishopPickWallAtWorld       5664 → pickWallAtWorld
//   stage6BishopCommitDrawPoint       5680 → commitDrawPoint(bishop, world, viewport, env)
//   stage6BishopCompleteCurrentActionAt 5865 → completeCurrentActionAt(bishop, world, viewport, env)
//
// The two committing functions are the only ones that write. They mutate the very `bishop` block
// they are handed — exactly as the monolith did, so a caller keeps its object identity — and reach
// the host through `env`, an object of callbacks resolved **at the statement the monolith called
// them** (the value-or-function convention of PR 18a / 18d). They are host actions, not maths:
// creating a drain re-validates against the model, finishing a draft runs the draft handler, and
// each branch ends in the render / invalidation the monolith performed inline. Keeping them as
// callbacks is what makes the ordering — and therefore the state — bit-identical.
import { dist } from '../geometry/points.js';
import { polygonIsValid } from '../geometry/polygons.js';
import { clampRegionPoint } from '../state/regions.js';
import {
  selectedSurfaceLoad,
  sortZone,
  syncLegacySurfaceLoadMirror,
  validZone,
  zoneKey,
  zoneLabel
} from '../state/surface-loads.js';
import { normalizeWalls } from '../state/walls.js';
import { normalizeDrains } from '../state/drains.js';
import { terrainY as bishopTerrainY } from '../../stage6-bishop.js';
import { pointSegmentDistance, wallEndpoints } from '../../wall-geometry.js';
import {
  VIEWPORT_LIMITS,
  snapToleranceWorld,
  surfaceLoadPickHeightWorld,
  worldToScreen
} from './viewport.js';

const resolve = (v, ...args) => (typeof v === 'function' ? v(...args) : v);

/** The snap key of the handle a drag is holding — excluded from its own snap candidates. */
export function currentDragKey(drag){
  if(!drag) return '';
  const index = drag.kind === 'drainVertex' ? drag.vertexIndex : drag.index;
  return `${drag.kind}:${drag.regionId || drag.loadId || ''}:${Number.isFinite(index) ? index : ''}`;
}

/** The identity of one snap candidate: kind, owning entity id and index. */
export function snapPointKey(kind, index, regionId){
  return `${kind}:${regionId || ''}:${Number.isFinite(index) ? index : ''}`;
}

/**
 * Every point the "snap to points" mode can snap to: terrain and phreatic vertices, the active-CPT
 * marker, the four zone edges, the selected (or single) surface load's two edges, both endpoints of
 * every wall, every drain vertex and every custom-region vertex. Duplicated coordinates are dropped
 * at 1e-4 m, and the handle a drag is holding is excluded by key (`excludeKey`, a string or a
 * function returning one — the monolith read the live drag here).
 */
export function collectSnapPoints(bishop, excludeKey = ''){
  const points = [];
  const seen = new Set();
  const exclude = resolve(excludeKey) || '';
  const pushPoint = (kind, pt, index = null, regionId = null)=>{
    const x = Number(pt?.x);
    const y = Number(pt?.y);
    if(!Number.isFinite(x) || !Number.isFinite(y)) return;
    if(snapPointKey(kind, index, regionId) === exclude) return;
    const coordKey = `${x.toFixed(4)}:${y.toFixed(4)}`;
    if(seen.has(coordKey)) return;
    seen.add(coordKey);
    points.push({x, y});
  };
  (bishop.terrain || []).forEach((pt, index)=>pushPoint('terrain', pt, index));
  (bishop.phreatic || []).forEach((pt, index)=>pushPoint('phreatic', pt, index));
  if(Number.isFinite(bishop.activeCptX) && bishop.terrain.length >= 2){
    pushPoint('cpt', {
      x:bishop.activeCptX,
      y:bishopTerrainY({vertices:bishop.terrain}, bishop.activeCptX) + (Number(bishop.cptInsertionOffset) || 0)
    });
  }
  if(bishop.entryZone && bishop.terrain.length >= 2){
    pushPoint('entryStart', {x:bishop.entryZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xStart)});
    pushPoint('entryEnd', {x:bishop.entryZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xEnd)});
  }
  if(bishop.exitZone && bishop.terrain.length >= 2){
    pushPoint('exitStart', {x:bishop.exitZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xStart)});
    pushPoint('exitEnd', {x:bishop.exitZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xEnd)});
  }
  const selectedLoadForSnap = selectedSurfaceLoad(bishop)
    || ((bishop.surfaceLoads || []).length === 1 ? bishop.surfaceLoads[0] : null);
  if(validZone(selectedLoadForSnap) && bishop.terrain.length >= 2){
    pushPoint('loadStart', {x:selectedLoadForSnap.xStart, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForSnap.xStart)}, null, selectedLoadForSnap.id);
    pushPoint('loadEnd', {x:selectedLoadForSnap.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForSnap.xEnd)}, null, selectedLoadForSnap.id);
  }
  (bishop.walls || []).forEach((wall, index)=>{
    const endpoints = wallEndpoints(wall);
    if(!endpoints) return;
    pushPoint('wallTop', endpoints.head, index);
    pushPoint('wallTip', endpoints.tip, index);
  });
  (bishop.drains || []).forEach((drain)=>{
    (drain.vertices || []).forEach((pt, index)=>pushPoint('drainVertex', pt, index, drain.id));
  });
  (bishop.customRegions || []).forEach((region)=>{
    (region.polygon || []).forEach((pt, index)=>pushPoint('regionVertex', pt, index, region.id));
  });
  return points;
}

/**
 * The nearest snap candidate within the viewport tolerance, or `null`. In `'terrain-x'` mode only
 * x is compared and only x is taken (the y of the probe point is kept).
 */
export function nearestPointSnap(pt, mode, bishop, viewport, excludeKey = ''){
  const tolerance = snapToleranceWorld(viewport);
  let best = null;
  collectSnapPoints(bishop, excludeKey).forEach((candidate)=>{
    const distance = mode === 'terrain-x'
      ? Math.abs(candidate.x - pt.x)
      : dist(candidate, pt);
    if(distance > tolerance) return;
    if(!best || distance < best.distance){
      best = {
        distance,
        point:mode === 'terrain-x'
          ? {x:candidate.x, y:pt.y}
          : {x:candidate.x, y:candidate.y}
      };
    }
  });
  return best;
}

/**
 * The world point a click lands on: the grid candidate (when grid snap is on), the nearest point
 * candidate (when point snap is on), whichever is closer — or the raw point when neither is on.
 * Always a fresh object.
 */
export function snapWorldPoint(pt, mode, bishop, viewport, excludeKey = ''){
  const grid = Math.max(bishop.snapSize || 0.5, 0.05);
  const candidates = [];
  if(bishop.gridSnap){
    const gridPoint = {...pt};
    gridPoint.x = Math.round(gridPoint.x / grid) * grid;
    if(mode !== 'terrain-x'){
      gridPoint.y = Math.round(gridPoint.y / grid) * grid;
    }
    candidates.push({
      point:gridPoint,
      distance:mode === 'terrain-x' ? Math.abs(gridPoint.x - pt.x) : dist(gridPoint, pt)
    });
  }
  if(bishop.pointSnap){
    const pointCandidate = nearestPointSnap(pt, mode, bishop, viewport, excludeKey);
    if(pointCandidate) candidates.push(pointCandidate);
  }
  if(!candidates.length) return {...pt};
  candidates.sort((a, b)=>a.distance - b.distance);
  return {...candidates[0].point};
}

/**
 * The draggable handle under the pointer (within 12 screen px), or `null`. `rect` is the canvas'
 * bounding rect; the monolith read it twice per candidate inside the distance helper.
 */
export function nearestHandle(bishop, viewport, rect, clientX, clientY, selectedRegion = null){
  const handles = [];
  const screenDist = (pt)=>{
    const scr = worldToScreen(pt, viewport);
    return Math.hypot(scr.x - (clientX - rect.left), scr.y - (clientY - rect.top));
  };
  bishop.terrain.forEach((pt, index)=>handles.push({kind:'terrain', index, pt}));
  bishop.phreatic.forEach((pt, index)=>handles.push({kind:'phreatic', index, pt}));
  if(Number.isFinite(bishop.activeCptX) && bishop.terrain.length >= 2){
    handles.push({kind:'cpt', pt:{x:bishop.activeCptX, y:bishopTerrainY({vertices:bishop.terrain}, bishop.activeCptX) + (Number(bishop.cptInsertionOffset) || 0)}});
  }
  if(bishop.entryZone){
    handles.push({kind:'entryStart', pt:{x:bishop.entryZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xStart)}});
    handles.push({kind:'entryEnd', pt:{x:bishop.entryZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xEnd)}});
  }
  if(bishop.exitZone){
    handles.push({kind:'exitStart', pt:{x:bishop.exitZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xStart)}});
    handles.push({kind:'exitEnd', pt:{x:bishop.exitZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xEnd)}});
  }
  const selectedLoadForHandles = selectedSurfaceLoad(bishop)
    || ((bishop.surfaceLoads || []).length === 1 ? bishop.surfaceLoads[0] : null);
  if(validZone(selectedLoadForHandles)){
    handles.push({kind:'loadStart', loadId:selectedLoadForHandles.id, pt:{x:selectedLoadForHandles.xStart, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForHandles.xStart)}});
    handles.push({kind:'loadEnd', loadId:selectedLoadForHandles.id, pt:{x:selectedLoadForHandles.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForHandles.xEnd)}});
  }
  (bishop.walls || []).forEach((wall, index)=>{
    const endpoints = wallEndpoints(wall);
    if(!endpoints) return;
    handles.push({kind:'wallTop', index, pt:endpoints.head});
    handles.push({kind:'wallTip', index, pt:endpoints.tip});
  });
  (bishop.drains || []).forEach((drain, drainIndex)=>{
    (drain.vertices || []).forEach((pt, vertexIndex)=>{
      handles.push({kind:'drainVertex', index:drainIndex, vertexIndex, regionId:drain.id, pt});
    });
  });
  if((bishop.customRegions || []).length){
    const region = resolve(selectedRegion);
    (region?.polygon || []).forEach((pt, index)=>{
      handles.push({kind:'regionVertex', regionId:region.id, index, pt});
    });
  }
  let best = null;
  handles.forEach((handle)=>{
    const d = screenDist(handle.pt);
    if(d <= VIEWPORT_LIMITS.handlePickRadiusPx && (!best || d < best.distance)){
      best = {...handle, distance:d};
    }
  });
  return best;
}

/** The topmost surface load whose band (terrain → 22 px above it) contains `world`, or `null`. */
export function pickSurfaceLoadAtWorld(bishop, world, viewport){
  if(!world || !bishop?.terrain?.length) return null;
  const tolerance = snapToleranceWorld(viewport);
  const terrain = {vertices:bishop.terrain};
  const loads = [...(bishop.surfaceLoads || [])].reverse();
  for(const load of loads){
    if(!validZone(load)) continue;
    const xStart = Math.min(load.xStart, load.xEnd);
    const xEnd = Math.max(load.xStart, load.xEnd);
    if(world.x < xStart - tolerance || world.x > xEnd + tolerance) continue;
    const xProbe = Math.min(Math.max(world.x, xStart), xEnd);
    const ySurface = bishopTerrainY(terrain, xProbe);
    const height = surfaceLoadPickHeightWorld(viewport);
    if(world.y >= ySurface - tolerance && world.y <= ySurface + height + tolerance){
      return load;
    }
  }
  return null;
}

/** The wall whose axis passes within the snap tolerance of `world`, nearest first, or `null`. */
export function pickWallAtWorld(bishop, world, viewport){
  if(!world) return null;
  const tolerance = snapToleranceWorld(viewport);
  let best = null;
  (bishop.walls || []).forEach((wall)=>{
    const endpoints = wallEndpoints(wall);
    if(!endpoints) return;
    const distance = pointSegmentDistance(world, endpoints.head, endpoints.tip);
    if(distance <= tolerance && (!best || distance < best.distance)){
      best = {wall, distance};
    }
  });
  return best?.wall || null;
}

/** The wall literal both commit paths append — one shape, two call sites in the monolith. */
function newWall(bishop, top, tip, env){
  const wallId = env.wallId();
  return {
    id:wallId,
    head:{x:top.x, y:top.y},
    tip:{x:tip.x, y:tip.y},
    x:top.x,
    yTop:top.y,
    yTip:tip.y,
    passiveSide:env.defaultPassiveSide(),
    mechanicalActive:true,
    anchors:[],
    maxShearForce:null,
    material:env.defaultWallMaterial((bishop.walls || []).length, wallId)
  };
}

/**
 * A left click in a draw tool. Mutates `bishop` and drives the host through `env`; the return value
 * is the monolith's (undefined) — every branch ends in an `env.render()` or in a handler that
 * renders itself.
 *
 * `env`: `{render, model, seepageBoundary, pickSeepageBoundaryEdge, selectSeepageBoundary,
 * finishDraft, createDrainFromVertices, selectedCustomRegion, pickRegionBoundaryPoint,
 * splitSelectedRegion, invalidate, invalidateWallGeometry, createSurfaceLoadFromZone, wallId,
 * defaultPassiveSide, defaultWallMaterial}`; `excludeKey` is the live drag key (see
 * `collectSnapPoints`).
 */
export function commitDrawPoint(bishop, world, viewport, env, excludeKey = ''){
  const snap = (pt, mode)=>snapWorldPoint(pt, mode, bishop, viewport, excludeKey);
  const tool = bishop.tool;
  if(tool === 'seepageBc'){
    const model = env.model();
    const boundary = env.seepageBoundary(model);
    const picked = env.pickSeepageBoundaryEdge(boundary, world, snapToleranceWorld(viewport));
    if(!picked?.edge){
      bishop.progress.message = 'Click near an outer-boundary edge to assign a seepage boundary condition.';
      env.render();
      return;
    }
    env.selectSeepageBoundary(picked.edge.edgeKey);
    return;
  }
  if(tool === 'terrain' || tool === 'phreatic'){
    const snapped = snap(world, 'free');
    const next = [...bishop.draft];
    // Permit a vertical drop (same x, different y); reject only a backwards move or a duplicate point.
    const prevPt = next[next.length-1];
    if(prevPt && (snapped.x < prevPt.x - 1e-6 || Math.hypot(snapped.x-prevPt.x, snapped.y-prevPt.y) <= 1e-6)) return;
    next.push(snapped);
    bishop.draft = next;
    bishop.draftKind = tool;
    env.render();
    return;
  }
  if(tool === 'drain'){
    if(bishop.terrain.length < 2) return;
    const snapped = snap(world, 'free');
    const next = [...bishop.draft];
    if(next.length && dist(snapped, next[next.length - 1]) <= 1e-6) return;
    if(bishop.draftKind !== 'drain' || !next.length){
      bishop.draft = [snapped];
      bishop.draftKind = 'drain';
      bishop.progress.message = 'Drain start set. Click the end point to create the drain.';
      env.render();
      return;
    }
    if(env.createDrainFromVertices([next[0], snapped])){
      bishop.draft = [];
      bishop.draftKind = '';
    }
    env.render();
    return;
  }
  if(tool === 'region' || tool === 'regionHole'){
    if(bishop.terrain.length < 2) return;
    if(tool === 'regionHole' && !env.selectedCustomRegion()){
      bishop.progress.message = 'Select a custom polygon first in Edit / pan mode, then choose Cut hole.';
      env.render();
      return;
    }
    const snapped = snap(world, 'free');
    const next = [...bishop.draft];
    if(next.length && dist(snapped, next[next.length - 1]) <= 1e-6) return;
    if(next.length >= 3 && dist(snapped, next[0]) <= Math.max(bishop.snapSize || 0.5, 0.25)){
      env.finishDraft();
      return;
    }
    next.push(snapped);
    bishop.draft = next;
    bishop.draftKind = tool;
    env.render();
    return;
  }
  if(tool === 'regionSplit'){
    const region = env.selectedCustomRegion();
    if(!region){
      bishop.progress.message = 'Select a custom polygon first in Edit / pan mode, then choose Split selected.';
      env.render();
      return;
    }
    const cutPoint = env.pickRegionBoundaryPoint(region, world);
    if(!cutPoint){
      bishop.progress.message = 'Click near the selected polygon boundary to place a split point.';
      env.render();
      return;
    }
    if(bishop.draftKind !== 'regionSplit' || bishop.draft.length >= 2){
      bishop.draft = [cutPoint];
      bishop.draftKind = 'regionSplit';
      env.render();
      return;
    }
    if(dist(bishop.draft[0], cutPoint) <= Math.max((bishop.snapSize || 0.5) * 0.25, 0.05)){
      bishop.progress.message = 'Choose a second boundary point away from the first one to split the polygon.';
      env.render();
      return;
    }
    bishop.draft = [bishop.draft[0], cutPoint];
    bishop.draftKind = 'regionSplit';
    env.splitSelectedRegion();
    return;
  }
  if(tool === 'cpt'){
    if(bishop.terrain.length < 2) return;
    const x = snap(world, 'terrain-x').x;
    bishop.activeCptX = Math.min(Math.max(x, bishop.terrain[0].x), bishop.terrain[bishop.terrain.length-1].x);
    env.invalidate('Active CPT position updated; rerun Bishop search.');
    env.render();
    return;
  }
  if(tool === 'measure'){
    const snapped = snap(world, 'free');
    const points = (bishop.measurement?.points || []).slice(0, 2);
    if(points.length !== 1){
      bishop.measurement = {points:[snapped]};
    } else if(dist(points[0], snapped) > 1e-6){
      bishop.measurement = {points:[points[0], snapped]};
    }
    env.render();
    return;
  }
  if(tool === 'entry' || tool === 'exit' || tool === 'load'){
    if(bishop.terrain.length < 2) return;
    const x = snap(world, 'terrain-x').x;
    const terrain = {vertices:bishop.terrain};
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    const clampedX = Math.min(Math.max(x, minX), maxX);
    if(bishop.draftKind !== tool || bishop.draft.length >= 2){
      bishop.draft = [{x:clampedX, y:bishopTerrainY(terrain, clampedX)}];
      bishop.draftKind = tool;
    } else {
      const first = bishop.draft[0];
      const key = zoneKey(tool);
      const zone = sortZone({
        ...(bishop[key] || {}),
        xStart:first.x,
        xEnd:clampedX
      });
      if(tool === 'load'){
        env.createSurfaceLoadFromZone(zone);
      } else if(key) {
        bishop[key] = zone;
        env.invalidate(`${zoneLabel(tool)} updated; rerun Bishop search.`);
      }
      bishop.draft = [];
      bishop.draftKind = '';
    }
    env.render();
    return;
  }
  if(tool === 'wall'){
    if(bishop.terrain.length < 2) return;
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    if(bishop.draftKind !== 'wall' || bishop.draft.length !== 1){
      const x = Math.min(Math.max(snap(world, 'terrain-x').x, minX), maxX);
      const terrain = {vertices:bishop.terrain};
      bishop.draft = [{x, y:bishopTerrainY(terrain, x)}];
      bishop.draftKind = 'wall';
    } else {
      const top = bishop.draft[0];
      const tip = snap(world, 'free');
      const wall = newWall(bishop, top, tip, env);
      bishop.walls = [...(bishop.walls || []), wall];
      bishop.walls = normalizeWalls(bishop.walls, bishop.terrain);
      bishop.selectedWallId = wall.id;
      bishop.draft = [];
      bishop.draftKind = '';
      env.invalidateWallGeometry('Retaining wall added; rerun Bishop search.');
    }
    env.render();
  }
}

/**
 * A right click: finish whatever the current draft is at `world`. `true` when something was
 * completed (the monolith's return value; the pointer handler uses it only to stop). Mutates
 * `bishop`, drives the host through the same `env` as `commitDrawPoint`.
 */
export function completeCurrentActionAt(bishop, world, viewport, env, excludeKey = ''){
  const snap = (pt, mode)=>snapWorldPoint(pt, mode, bishop, viewport, excludeKey);
  if(bishop.draftKind === 'terrain' || bishop.draftKind === 'phreatic' || bishop.draftKind === 'drain' || bishop.draftKind === 'region' || bishop.draftKind === 'regionHole'){
    if((bishop.draft || []).length >= 2){
      if(bishop.draftKind === 'drain' && bishop.draft.length < 2) return false;
      if((bishop.draftKind === 'region' || bishop.draftKind === 'regionHole') && bishop.draft.length < 3) return false;
      env.finishDraft();
      return true;
    }
    return false;
  }
  if(bishop.draftKind === 'regionSplit'){
    bishop.draft = [];
    bishop.draftKind = 'regionSplit';
    env.render();
    return true;
  }
  if((bishop.draftKind === 'entry' || bishop.draftKind === 'exit' || bishop.draftKind === 'load') && (bishop.draft || []).length === 1 && bishop.terrain.length >= 2){
    const kind = bishop.draftKind;
    const x = snap(world, 'terrain-x').x;
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    const clampedX = Math.min(Math.max(x, minX), maxX);
    const first = bishop.draft[0];
    const key = zoneKey(kind);
    const zone = sortZone({
      ...(bishop[key] || {}),
      xStart:first.x,
      xEnd:clampedX
    });
    if(validZone(zone)){
      if(kind === 'load'){
        env.createSurfaceLoadFromZone(zone);
      } else if(key) {
        bishop[key] = zone;
        env.invalidate(`${zoneLabel(kind)} updated; rerun Bishop search.`);
      }
      bishop.draft = [];
      bishop.draftKind = '';
      env.render();
      return true;
    }
  }
  if(bishop.draftKind === 'wall' && (bishop.draft || []).length === 1){
    const top = bishop.draft[0];
    const tip = snap(world, 'free');
    const wall = newWall(bishop, top, tip, env);
    bishop.walls = [...(bishop.walls || []), wall];
    bishop.walls = normalizeWalls(bishop.walls, bishop.terrain);
    bishop.selectedWallId = wall.id;
    bishop.draft = [];
    bishop.draftKind = '';
    env.invalidateWallGeometry('Retaining wall added; rerun Bishop search.');
    env.render();
    return true;
  }
  return false;
}

/**
 * One handle-drag step: moves the held handle to `world` and returns `true` when the bishop block
 * changed. Every branch is the monolith's, including the guards that reject a zero-length terrain /
 * phreatic edge and an invalid region polygon (a rejected move draws the frame but changes nothing).
 */
export function dragHandleTo(bishop, drag, world, viewport, excludeKey = ''){
  const snap = (pt, mode)=>snapWorldPoint(pt, mode, bishop, viewport, excludeKey);
  if(drag.kind === 'terrain'){
    const pt = snap(world, 'free');
    const prev = bishop.terrain[drag.index-1];
    const next = bishop.terrain[drag.index+1];
    // Monotone NON-decreasing x (allow a vertical face Δx=0, Δy≠0 — e.g. a step flush to a wall);
    // 'free' snapping pulls x onto a wall head/tip so the drop lands exactly on the wall.
    if(prev) pt.x = Math.max(pt.x, prev.x);
    if(next) pt.x = Math.min(pt.x, next.x);
    if((prev && Math.hypot(pt.x-prev.x, pt.y-prev.y) <= 1e-6) ||
       (next && Math.hypot(pt.x-next.x, pt.y-next.y) <= 1e-6)) return false;  // reject a zero-length edge
    bishop.terrain[drag.index] = pt;
  } else if(drag.kind === 'phreatic'){
    const pt = snap(world, 'free');
    const prev = bishop.phreatic[drag.index-1];
    const next = bishop.phreatic[drag.index+1];
    if(prev) pt.x = Math.max(pt.x, prev.x);   // allow a vertical phreatic step to match the face
    if(next) pt.x = Math.min(pt.x, next.x);
    if((prev && Math.hypot(pt.x-prev.x, pt.y-prev.y) <= 1e-6) ||
       (next && Math.hypot(pt.x-next.x, pt.y-next.y) <= 1e-6)) return false;
    bishop.phreatic[drag.index] = pt;
  } else if(drag.kind === 'cpt'){
    const x = snap(world, 'terrain-x').x;
    bishop.activeCptX = Math.min(Math.max(x, bishop.terrain[0].x), bishop.terrain[bishop.terrain.length-1].x);
  } else if(drag.kind.startsWith('entry') || drag.kind.startsWith('exit') || drag.kind.startsWith('load')){
    const edge = drag.kind.endsWith('Start') ? 'xStart' : 'xEnd';
    const x = snap(world, 'terrain-x').x;
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    if(drag.kind.startsWith('load')){
      const load = (bishop.surfaceLoads || []).find((item)=>item.id === drag.loadId)
        || selectedSurfaceLoad(bishop);
      if(!load) return false;
      load[edge] = Math.min(Math.max(x, minX), maxX);
      Object.assign(load, sortZone(load) || load);
      bishop.selectedSurfaceLoadId = load.id;
      syncLegacySurfaceLoadMirror(bishop);
    } else {
      const key = drag.kind.startsWith('entry') ? 'entryZone' : 'exitZone';
      bishop[key][edge] = Math.min(Math.max(x, minX), maxX);
      bishop[key] = sortZone(bishop[key]);
    }
  } else if(drag.kind === 'wallTop' || drag.kind === 'wallTip'){
    const wall = bishop.walls?.[drag.index];
    if(!wall) return false;
    const pt = snap(world, 'free');
    const minX = bishop.terrain.length >= 2 ? bishop.terrain[0].x : -Infinity;
    const maxX = bishop.terrain.length >= 2 ? bishop.terrain[bishop.terrain.length-1].x : Infinity;
    const nextPoint = {
      x:Math.min(Math.max(pt.x, minX), maxX),
      y:pt.y
    };
    if(drag.kind === 'wallTop'){
      wall.head = nextPoint;
    } else {
      wall.tip = nextPoint;
    }
    bishop.walls = normalizeWalls(bishop.walls, bishop.terrain);
  } else if(drag.kind === 'drainVertex'){
    const drain = bishop.drains?.[drag.index];
    if(!drain || !Array.isArray(drain.vertices) || !drain.vertices[drag.vertexIndex]) return false;
    const pt = snap(world, 'free');
    drain.vertices[drag.vertexIndex] = {x:+pt.x.toFixed(6), y:+pt.y.toFixed(6)};
    bishop.drains = normalizeDrains(bishop.drains);
  } else if(drag.kind === 'regionVertex'){
    const region = (bishop.customRegions || []).find((item)=>item.id === drag.regionId);
    if(!region) return false;
    const pt = snap(world, 'free');
    const minX = bishop.terrain.length >= 2 ? bishop.terrain[0].x : -Infinity;
    const maxX = bishop.terrain.length >= 2 ? bishop.terrain[bishop.terrain.length-1].x : Infinity;
    const nextPoint = clampRegionPoint(pt, minX, maxX);
    const nextPolygon = (region.polygon || []).map((item, index)=>index === drag.index ? nextPoint : item);
    if(polygonIsValid(nextPolygon)){
      region.polygon[drag.index] = nextPoint;
    }
  }
  return true;
}
