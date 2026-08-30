// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/probe — the line probe of the Seep / Slope app (refactor step 9d, PLAN §2 row 18d;
// 01-monolith-map.md §2.11 group "Geometry, picking, line probe" and §6.1 row `seepslope/`
// `geometry/line-probe.js`): the quantity catalogue and its formatter, the sampler along the
// shared Measure tool's line, and the clipboard readout.
//
// Nothing here reads `S`, renders or writes the DOM. The host values the package cannot own yet
// are one `env` object, passed by the controller façades:
//
//   {
//     hardeningSoilUi,                          // STAGE6_ENABLE_HARDENING_SOIL_UI
//     normalizedDeformationAnalysisType(type),  // deformation contours (map §2.11)
//     deformationContourOptions(type, hasHs),   //   idem
//     deformationContourMeta(id, type),         //   idem
//     seepageHydraulicFs(gradient, material)    // seepage contours (map §2.11)
//   }
//
// Both groups are extraction steps of their own; when they land, `env` shrinks to the flag and
// the package imports them directly.
export * from './options.js';
export * from './clipboard.js';
export * from './line-probe.js';

export * as options from './options.js';
export * as clipboard from './clipboard.js';
export * as lineProbe from './line-probe.js';
