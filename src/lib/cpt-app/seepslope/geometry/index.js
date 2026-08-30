// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/geometry — the pure section maths of the Seep / Slope app (refactor step 9d,
// PLAN §2 row 18d; 01-monolith-map.md §2.11 group "Geometry, picking, line probe" and §6.1 row
// `seepslope/` `geometry/polygons.js`). Points and segments, polygons and their validators,
// boundary picking / splitting / hole subtraction, the regions a canvas shows and the shared
// Measure tool's line.
//
// Nothing here reads `S`, the DOM or the canvas viewport. The two host-owned inputs are explicit
// parameters: the boundary-pick tolerance of `pickRegionBoundaryPoint` (the viewport, step 9e)
// and the `env` of `regionTooltipHtml` (the workspace strength set and its label, step 9f).
// The pointer, snapping and viewport handling that *uses* these helpers stays in the controller
// until step 9e.
export * from './points.js';
export * from './polygons.js';
export * from './boundary.js';
export * from './regions.js';
export * from './measurement.js';

export * as points from './points.js';
export * as polygons from './polygons.js';
export * as boundary from './boundary.js';
export * as regions from './regions.js';
export * as measurement from './measurement.js';
