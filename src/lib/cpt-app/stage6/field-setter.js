// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/field-setter.js — the value coercion of setStage6Field (legacy-controller.js 3324-3341
// at integration-r): a dotted `field` is typed after its default — number defaults turn '' / null
// into null and everything else into +value, boolean defaults into !!value, anything else is
// stored as given. The monolith's setStage6Field keeps the DOM half (remember details, bearing
// preview short-circuit, re-render) and calls setField() for the state write; the 84 inline
// `setStage6Field('app.path', value)` handlers are untouched.
import { get, set } from './merge.js';

/** The value setStage6Field would store for `field`, given the defaults tree. */
export function coerceFieldValue(defaults, field, value){
  const currentDefault = get(defaults, field);
  let nextValue = value;
  if(typeof currentDefault === 'number'){
    nextValue = value === '' || value == null ? null : +value;
  } else if(typeof currentDefault === 'boolean'){
    nextValue = !!value;
  }
  return nextValue;
}

/** Coerce and write `field` on `stage6`; returns the stored value. */
export function setField(stage6, defaults, field, value){
  const nextValue = coerceFieldValue(defaults, field, value);
  set(stage6, field, nextValue);
  return nextValue;
}
