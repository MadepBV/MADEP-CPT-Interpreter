// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// core/state.js — the active-CPT pointer of a project (01-monolith-map.md §1.1, §6.1 `core/` row:
// `getActive()/setActive()`).
//
// New in PR 14 (refactor step 8). The monolith keeps `S`, a module-level `let` that every function
// closes over, as the active CPT; until this step it was reassigned at three sites (declaration,
// selectCpt, removeCpt). Both reassignments now go through the controller's `setActive(idx)`,
// which is `S = setActiveCpt(PROJECT, idx)` — the only place `S` is written after its declaration.
// The project shape is the controller's PROJECT literal: { name, cpts, activeCptIdx, phase,
// stratigraphy, sectionOrder }.

/** The CPT `project.activeCptIdx` points at (what the controller's `S` mirrors). */
export function activeCpt(project){
  return project.cpts[project.activeCptIdx];
}

/** True when `idx` addresses an existing CPT of the project (selectCpt's guard). */
export function isCptIndex(project, idx){
  return Number.isInteger(idx) && idx >= 0 && idx < project.cpts.length;
}

/**
 * Point the project at CPT `idx` and return that CPT. No validation (removeCpt's clamp and
 * selectCpt's range check happen before) — this is the one write of `activeCptIdx`.
 */
export function setActiveCpt(project, idx){
  project.activeCptIdx = idx;
  return project.cpts[idx];
}
