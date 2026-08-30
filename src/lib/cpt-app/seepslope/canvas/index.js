// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas — the Seep / Slope section canvas (refactor step 9e, PLAN §2 row 18e;
// 01-monolith-map.md §2.11 groups "Canvas interaction" and "Canvas draw", §6.1 rows
// `canvas/viewport.js`, `canvas/snap.js`, `canvas/pointer.js`, `canvas/draw/*.js`).
//
//   viewport.js    world ↔ screen, fit, zoom / pan, every px → world tolerance
//   picking.js     snapping, hit tests, and the two committing gestures — pure given a viewport
//   pointer.js     the {down, move, up, cancel} state machine over one canvas
//   view-model.js  the one pure derivation step: state + results + viewport → what the layers need
//   draw/*.js      fourteen layers, each `(ctx2d, viewModel, theme)`, sequenced by draw/index.js
//
// Nothing in the package reads `S`, the DOM, the canvas element or the clock. The host owns the
// element, the device pixel ratio, the model cache and the theme; it hands each of them in.
export * from './viewport.js';
export * from './picking.js';
export * from './pointer.js';
export * from './view-model.js';
export * from './draw/index.js';

export * as viewport from './viewport.js';
export * as picking from './picking.js';
export * as pointer from './pointer.js';
export * as viewModel from './view-model.js';
export * as draw from './draw/index.js';
