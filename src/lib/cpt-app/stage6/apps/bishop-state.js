// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/bishop-state.js — the Seep / Slope ("bishop") state schema for the Stage 6 registry.
// PR 11 held the monolith's defaults + migration here verbatim; since refactor step 9a (PR 18a)
// the schema lives in src/lib/cpt-app/seepslope/state/ and this file only re-exports it, the
// pattern of the other five apps/*-state.js files. The registry (stage6/registry.js) reads
// `defaults` / `ensure`; the domain helpers stay exported for anything that still imports them
// from here.
export {
  defaults,
  ensure,
  sortedPolyline,
  seepageDomainArea,
  autoSeepageMeshTargetArea,
  resolvedSeepageMeshTargetArea,
  autoDeformationMeshTargetArea,
  resolvedDeformationMeshTargetArea
} from '../../seepslope/state/index.js';
