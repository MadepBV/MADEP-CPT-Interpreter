// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/index.js — the sequencer: the fourteen layers of the Seep / Slope section,
// in the monolith's exact order (refactor step 9e, PLAN §2 row 18e; 01-monolith-map.md §6.2 step 9e
// "canvas … then `draw/*` split", §6.3 item 4).
//
// `stage6BishopDrawCanvas` was one 1 139-line function. What is left of it in the controller is the
// frame's host half — measure the canvas, size the backing store for the device pixel ratio, get
// the 2D context, build the model, cache it, resolve the theme — and then this call. Every layer
// takes `(ctx2d, viewModel, theme)`, is pure with respect to the state, and can be run against any
// context (the report capture's offscreen canvas, step 9g; the verifier's recording context).
//
// **The order is the contract.** It is what the visual baselines lock, so it is written out once,
// here, and never implied by import order.
import { drawBackground, drawGrid } from './background.js';
import { drawRegions } from './regions.js';
import { drawSeepageField } from './seepage.js';
import { drawDeformationField } from './deformation.js';
import { drawDraft, drawDrains, drawPhreatic } from './water.js';
import { drawHoverPreview } from './hover.js';
import { drawZonesAndLoads } from './loads.js';
import { drawWallResponses, drawWalls } from './walls.js';
import { drawMeasurement } from './measurement.js';
import { drawSlipCircles } from './slip-circles.js';
import { drawTerrain } from './terrain.js';
import { drawBoundaryConditions } from './boundary-conditions.js';
import { drawCptMarker } from './cpt-marker.js';
import { drawEditHandles } from './handles.js';

/** The layer list, in paint order — exported so a test can name what it asserts. */
export const DRAW_LAYERS = Object.freeze([
  ['background', drawBackground],
  ['grid', drawGrid],
  ['regions', drawRegions],
  ['seepage', drawSeepageField],
  ['deformation', drawDeformationField],
  ['phreatic', drawPhreatic],
  ['drains', drawDrains],
  ['draft', drawDraft],
  ['hover', drawHoverPreview],
  ['zonesAndLoads', drawZonesAndLoads],
  ['walls', drawWalls],
  ['wallResponses', drawWallResponses],
  ['measurement', drawMeasurement],
  ['slipCircles', drawSlipCircles],
  ['terrain', drawTerrain],
  ['boundaryConditions', drawBoundaryConditions],
  ['cptMarker', drawCptMarker],
  ['editHandles', drawEditHandles]
]);

/** Paints one frame. Never touches the state — see `canvas/view-model.js`. */
export function drawCanvasFrame(ctx, vm, theme){
  for(const [, layer] of DRAW_LAYERS) layer(ctx, vm, theme);
}

export * from './primitives.js';
export * from './background.js';
export * from './regions.js';
export * from './seepage.js';
export * from './deformation.js';
export * from './water.js';
export * from './hover.js';
export * from './loads.js';
export * from './walls.js';
export * from './measurement.js';
export * from './slip-circles.js';
export * from './terrain.js';
export * from './boundary-conditions.js';
export * from './cpt-marker.js';
export * from './handles.js';
