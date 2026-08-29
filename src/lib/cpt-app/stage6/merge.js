// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/merge.js — the three object-path helpers of the Stage 6 state, moved verbatim out of
// legacy-controller.js (stage6Merge 2629-2639, stage6Get 2641-2643, stage6Set 2645-2654 at
// integration-r). Pure; no DOM, no state.

/** Fill every key of `defaults` that is null/undefined in `target`, recursing into plain objects
 *  (arrays and primitives are taken as a whole, and an existing value is never overwritten). */
export function merge(target, defaults){
  Object.keys(defaults).forEach((key)=>{
    const dv = defaults[key];
    if(dv && typeof dv === 'object' && !Array.isArray(dv)){
      if(!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      merge(target[key], dv);
    } else if(target[key] == null){
      target[key] = dv;
    }
  });
}

/** Read a dotted path ('bearing.Df'); undefined when a segment is missing. */
export function get(obj, path){
  return path.split('.').reduce((acc, part)=>acc ? acc[part] : undefined, obj);
}

/** Write a dotted path, creating intermediate objects. */
export function set(obj, path, value){
  const parts = path.split('.');
  let cur = obj;
  for(let i=0;i<parts.length-1;i+=1){
    const part = parts[i];
    if(!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length-1]] = value;
}
