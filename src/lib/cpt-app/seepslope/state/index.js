// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/index.js — the state schema and the state operations of the Seep / Slope
// ("bishop") app, refactor step 9a (01-monolith-map.md §6.1 row `seepslope/`, §6.2 step 9a;
// worklog/refactor/21-pr18a-seepslope-state.md). Pure modules: every function takes the
// `bishop` block (or the pieces it needs) and returns what the host needs to decide on
// invalidation / render; the host (legacy-controller.js until step 9f) keeps the monolith names
// as façades around them.
//
//   defaults.js       defaults() — the `bishop` block of stage6Defaults(), per-concern builders
//   ensure.js         ensure(stage6, env) — the schema migration as named steps
//   domain.js         sortedPolyline, seepageDomainArea, auto/resolved{Seepage,Deformation}MeshTargetArea
//   ids.js            DEFAULT_IDS, entityId — `{ now, random }` for the wall_/drain_/region_ ids
//   surface-loads.js  the surface loads (+ entry / exit / load zone helpers)
//   walls.js          the retaining walls
//   drains.js         the drains
//   regions.js        the custom soil polygons
//
// stage6/apps/bishop-state.js re-exports defaults / ensure / the domain helpers for the Stage 6
// registry (stage6/registry.js) — the shell's composed ensure reaches this package through it.

export {
  defaults,
  measurementDefaults,
  lineProbeDefaults,
  displayDefaults,
  surfaceLoadMirrorDefaults,
  viewportDefaults,
  searchDefaults,
  solverDefaults,
  spencerDefaults,
  progressDefaults,
  runProgressDefaults,
  seepageOptionsDefaults,
  seepageDisplayDefaults,
  seepageDefaults,
  deformationOptionsDefaults,
  deformationDisplayDefaults,
  deformationDefaults,
  capturedViewDefaults
} from './defaults.js';
export { ensure } from './ensure.js';
export * as ensureSteps from './ensure.js';
export {
  sortedPolyline,
  seepageDomainArea,
  autoSeepageMeshTargetArea,
  resolvedSeepageMeshTargetArea,
  autoDeformationMeshTargetArea,
  resolvedDeformationMeshTargetArea
} from './domain.js';
export { DEFAULT_IDS, entityId } from './ids.js';
export * from './surface-loads.js';
export * from './walls.js';
export * from './drains.js';
export * from './regions.js';
export * as surfaceLoads from './surface-loads.js';
export * as walls from './walls.js';
export * as drains from './drains.js';
export * as regions from './regions.js';
