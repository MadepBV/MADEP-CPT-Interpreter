// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/drains.js — the drains of the Seep / Slope state, refactor step 9a. Moved
// verbatim from legacy-controller.js (462fc50 lines 5286-5348: stage6BishopDrainId …
// DrainGatingLabel; the drain handlers 7540-7581: SelectDrain, SetDrainField, DeleteDrain).
// `S.stage6.bishop` became the `bishop` parameter; the host side effects (ensureStage6State,
// stage6BishopSyncSoilModel / CurrentModel, the <details> memory, stage6BishopInvalidateSeepage,
// renderStage6) stayed in the host façades:
//
//   pure helpers       drainId(ids), normalizeDrains (the app's wrapper over seepage/drains.js:
//                      ≥ 2 vertices, `drain-<n>` ids and `Drain <n>` labels), defaultDrainHead,
//                      drainValidationSummary, drainGatingLabel
//   writes of `bishop` createDrainFromVertices, selectDrain, setDrainField, deleteDrain
//
// The state operations return what the host needs:
//   createDrainFromVertices  { ok:true, drainId, validation } — the drain is appended, selected, the
//                            workspace switched to seepage (host opens the drains accordion and
//                            invalidates seepage); { ok:false, validation } — the first validation
//                            error is in progress.message, nothing else changed
//   setDrainField            the changed drain (host re-validates against the model + invalidates
//                            seepage), null = no such drain / non-finite head
//   deleteDrain              the removed drain or null (host invalidates seepage regardless)
import { normalizeDrain, normalizeDrains as normalizeDrainModels, validateDrains } from '../../seepage/drains.js';
import { DEFAULT_IDS, entityId } from './ids.js';

/** `drain_<now36>_<rand>` */
export function drainId(ids = DEFAULT_IDS){
  return entityId('drain', ids);
}

/** stage6BishopNormalizeDrains: the seepage normaliser, then drop < 2 vertices and fill ids / labels. */
export function normalizeDrains(drains){
  return normalizeDrainModels(drains || [])
    .filter((drain)=>drain.vertices.length >= 2)
    .map((drain, index)=>({
      ...drain,
      id:drain.id || `drain-${index + 1}`,
      label:drain.label || `Drain ${index + 1}`
    }));
}

/** A constant head at the first vertex's level (0 without one). */
export function defaultDrainHead(vertices){
  const first = vertices?.[0] || null;
  return {
    kind:'constant',
    value:Number.isFinite(+first?.y) ? +first.y : 0
  };
}

/**
 * Append a drain over `vertices` (the drain draft), validated against the seepage model
 * (`model`: the current bishop model, or a function returning it — read only after the candidate
 * is built, as the monolith did). On success the drain is selected and the workspace switched to
 * seepage; on a validation error only progress.message and seepage.drainValidation change.
 */
export function createDrainFromVertices(bishop, vertices, {model = null, ids = DEFAULT_IDS} = {}){
  const id = drainId(ids);
  const candidate = normalizeDrain({
    id,
    label:`Drain ${(bishop.drains || []).length + 1}`,
    vertices,
    closed:false,
    head:defaultDrainHead(vertices),
    gating:'when-saturated'
  }, (bishop.drains || []).length);
  const baseModel = (typeof model === 'function' ? model() : model) || {};
  const validationModel = {
    ...baseModel,
    drains:[...(bishop.drains || []), candidate]
  };
  const validation = validateDrains(validationModel);
  if(validation.errors.length){
    bishop.progress.message = validation.errors[0].message;
    bishop.seepage.drainValidation = validation;
    return {ok:false, validation};
  }
  bishop.drains = normalizeDrains([...(bishop.drains || []), candidate]);
  bishop.selectedDrainId = id;
  bishop.seepage.drainValidation = validation;
  bishop.workspace = 'seepage';
  return {ok:true, drainId:id, validation};
}

/** `n drain validation error(s)` / `… warning(s)` / `ok`. */
export function drainValidationSummary(validation){
  const errorCount = validation?.errors?.length || 0;
  const warningCount = validation?.warnings?.length || 0;
  if(errorCount) return `${errorCount} drain validation ${errorCount === 1 ? 'error' : 'errors'}`;
  if(warningCount) return `${warningCount} drain validation ${warningCount === 1 ? 'warning' : 'warnings'}`;
  return 'ok';
}

export function drainGatingLabel(value){
  if(value === 'always') return 'Always';
  if(value === 'head-cap') return 'Head cap';
  return 'When saturated';
}

/** Select a drain by id ('' clears); selecting drops the wall selection. */
export function selectDrain(bishop, drainId){
  bishop.selectedDrainId = drainId || '';
  if(drainId) bishop.selectedWallId = null;
}

/**
 * Set one field of drain `index` (label, head = a constant head value, gating) and re-normalise
 * the list. Returns the drain, or null when there is no such drain or the head is not finite.
 */
export function setDrainField(bishop, index, field, value){
  const drain = bishop.drains?.[index];
  if(!drain) return null;
  if(field === 'label'){
    drain.label = String(value || '').trim() || `Drain ${index + 1}`;
  } else if(field === 'head'){
    const head = value === '' || value == null ? null : +value;
    if(!Number.isFinite(head)) return null;
    drain.head = {kind:'constant', value:head};
  } else if(field === 'gating'){
    drain.gating = value === 'always' || value === 'head-cap' ? value : 'when-saturated';
  }
  bishop.drains = normalizeDrains(bishop.drains);
  return drain;
}

/** Remove drain `index`; a removed selection moves to the first drain. Returns the removed drain or null. */
export function deleteDrain(bishop, index){
  const removed = bishop.drains?.[index];
  bishop.drains = (bishop.drains || []).filter((_, drainIndex)=>drainIndex !== index);
  if(removed?.id === bishop.selectedDrainId){
    bishop.selectedDrainId = bishop.drains?.[0]?.id || '';
  }
  return removed || null;
}
