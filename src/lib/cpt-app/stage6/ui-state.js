// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/ui-state.js — the Stage 6 UI state that survives a full re-render of #stage6Area
// (01-monolith-map.md §1.2 `S.stage6.ui`, §2.6 "UI state"): the open/closed state of every
// `<details data-st6details>` and the scroll offsets of the scrollable panels. Moved out of
// legacy-controller.js 3121-3210 (integration-r); the DOM walks are verbatim, the `S` reads
// became a `stage6` parameter. The monolith keeps its names as wrappers that call
// ensureStage6State() first, exactly as before.
//
//   uiState(stage6)                       S.stage6.ui with `details` guaranteed (stage6BishopUiState)
//   rememberDetailsState(stage6, root)    DOM → state before a re-render (stage6RememberDetailsState)
//   detailsOpen(stage6, key)              ' open' / '' for a template (stage6DetailsOpen)
//   setDetailsOpen(stage6, key, open)     state write (stage6SetDetailsOpen)
//   scrollTargets / captureScrollState / restoreScrollState / scrollTargetBaseKey
//                                         the scroll capture/restore around innerHTML replacement

/** Make sure `stage6.ui` and `stage6.ui.details` are objects; returns `stage6.ui`. */
export function uiState(stage6){
  if(!stage6.ui || typeof stage6.ui !== 'object') stage6.ui = {details:{}};
  if(!stage6.ui.details || typeof stage6.ui.details !== 'object') stage6.ui.details = {};
  return stage6.ui;
}

/** Record which `<details data-st6details>` under `root` are open. */
export function rememberDetailsState(stage6, root){
  if(!root) return;
  const ui = uiState(stage6);
  root.querySelectorAll('details[data-st6details]').forEach(el=>{
    ui.details[el.dataset.st6details] = !!el.open;
  });
}

/** ' open' when the details group `key` was open, '' otherwise (for `<details${...}>`). */
export function detailsOpen(stage6, key){
  return stage6?.ui?.details?.[key] ? ' open' : '';
}

export function setDetailsOpen(stage6, key, open = true){
  uiState(stage6).details[key] = !!open;
}

export const STAGE6_SCROLL_PERSIST_SELECTORS = [
  '[data-st6scroll-key]',
  '.st6-canvas-card-body',
  '.st6-canvas-sheet-body',
  '.st6-bishop-view-menu-body',
  '.st6-canvas-table-wrap',
  'details[data-st6details] [style*="overflow"]'
];

export function scrollTargetBaseKey(el){
  const explicit = el?.getAttribute?.('data-st6scroll-key');
  if(explicit) return `explicit:${explicit}`;
  const detailsKey = el?.closest?.('details[data-st6details]')?.dataset?.st6details || '';
  const dialogLabel = el?.closest?.('[role="dialog"][aria-label]')?.getAttribute?.('aria-label') || '';
  const classKey = Array.from(el?.classList || []).sort().join('.');
  const tag = String(el?.tagName || 'node').toLowerCase();
  return `${tag}|${classKey}|${detailsKey}|${dialogLabel}`;
}

export function scrollTargets(root){
  if(!root?.querySelectorAll) return [];
  const seen = new Set();
  const rawTargets = [];
  STAGE6_SCROLL_PERSIST_SELECTORS.forEach((selector)=>{
    root.querySelectorAll(selector).forEach((el)=>{
      if(seen.has(el)) return;
      seen.add(el);
      if(typeof el.scrollTop !== 'number' || typeof el.scrollLeft !== 'number') return;
      rawTargets.push(el);
    });
  });
  const counts = new Map();
  return rawTargets.map((el)=>{
    const baseKey = scrollTargetBaseKey(el);
    const index = counts.get(baseKey) || 0;
    counts.set(baseKey, index + 1);
    return {el, key:`${baseKey}#${index}`};
  });
}

export function captureScrollState(root){
  return scrollTargets(root)
    .map(({el, key})=>({key, top:el.scrollTop || 0, left:el.scrollLeft || 0}))
    .filter((entry)=>entry.top || entry.left);
}

export function restoreScrollState(root, scrollState){
  if(!scrollState?.length) return;
  const byKey = new Map(scrollState.map((entry)=>[entry.key, entry]));
  const restore = ()=>{
    scrollTargets(root).forEach(({el, key})=>{
      const entry = byKey.get(key);
      if(!entry) return;
      el.scrollTop = entry.top;
      el.scrollLeft = entry.left;
    });
  };
  restore();
  requestAnimationFrame(restore);
}
