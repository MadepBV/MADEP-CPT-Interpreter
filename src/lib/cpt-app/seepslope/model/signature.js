// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/model/signature.js — the "materials come from the Stage 3/4 layers" contract of the
// Seep / Slope app, refactor step 9b (01-monolith-map.md §2.11 "Soil model bridge", §3.4 #9,
// §6.3 item 5). The bishop materials are derived from the active CPT's working layers; the
// state remembers which layers (`sourceLayerSignature`, the engine's bishopLayerSignature over
// top / bot / type / subtype / c / phi / g / gs / kh / kv) and which strength set
// (`sourceStrengthSet`) they were imported from. The decision of legacy-controller.js
// stage6BishopSyncSoilModel (integration-r 09b9c9b lines 2880-2889) — "re-import the materials
// when the layers, the strength set or an empty material list say so, and clear the Bishop
// results when a previous import existed" — is made explicit here as data.
import { bishopLayerSignature } from '../../stage6-bishop.js';

/** The layer signature the materials are keyed on (the engine's bishopLayerSignature). */
export function materialsSignature(layers){
  return bishopLayerSignature(layers);
}

/** The two messages the monolith stored in progress.message when a re-import cleared results. */
export const MATERIALS_INVALIDATION_MESSAGES = Object.freeze({
  strengthSet:'Material strength set changed; Bishop results were cleared.',
  layers:'Active CPT layers changed; Bishop results were cleared.'
});

/**
 * Why (and whether) the materials must be re-imported from `layers` for this `bishop` block:
 *   signature          the layers' signature
 *   hadSignature       a previous import exists (`sourceLayerSignature` set)
 *   layersChanged      the signature differs from the remembered one
 *   strengthSetChanged `strengthSet` differs from `sourceStrengthSet`
 *   empty              no materials yet
 *   reimport           layersChanged || empty || strengthSetChanged — the monolith's `if`
 */
export function materialsSource(bishop, layers){
  const signature = materialsSignature(layers);
  const hadSignature = !!bishop?.sourceLayerSignature;
  const strengthSetChanged = bishop?.sourceStrengthSet !== bishop?.strengthSet;
  const layersChanged = signature !== bishop?.sourceLayerSignature;
  const empty = !(bishop?.materials?.length);
  return {
    signature,
    hadSignature,
    layersChanged,
    strengthSetChanged,
    empty,
    reimport:layersChanged || empty || strengthSetChanged
  };
}

/**
 * The Bishop invalidation a re-import carries: null when nothing is re-imported or when this is
 * the first import (no results to clear); otherwise `{ kind:'bishop', message }` with the
 * strength-set message taking precedence over the layers message (monolith line 2888).
 */
export function materialsInvalidation(source){
  if(!source?.reimport || !source.hadSignature) return null;
  return {
    kind:'bishop',
    message:source.strengthSetChanged ? MATERIALS_INVALIDATION_MESSAGES.strengthSet : MATERIALS_INVALIDATION_MESSAGES.layers
  };
}
