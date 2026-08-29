// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/shell.js — the Stage 6 shell: app switch, shared banner and the one re-render path of
// #stage6Area (01-monolith-map.md §2.6 "Shell render", §4.2 row "Stage 6", §6.1 row `stage6/`).
// Moved out of legacy-controller.js (integration-r): stage6SharedBanner 11564-11570,
// stage6AppIcon 11572-11585, stage6CardsHtml 11587-11610, renderStage6 15188-15246. The markup
// is verbatim; the seven-way `if/else` on `S.stage6.app` became a lookup in the registry-keyed
// `apps` map the host passes in.
//
// createStage6Shell(ctx) → { render, cardsHtml, sharedBanner, appIcon, resolveApp }
//   ctx.registry             createStage6Registry(...) — card order, cardMeta, enabled hook
//   ctx.getState()           the active CPT (S): layers, id, wt, paramMethod, stage6, stage6Cache
//   ctx.ensure()             ensureStage6State()
//   ctx.rememberDetailsState()  stage6RememberDetailsState() — <details> DOM → state before a re-render
//   ctx.workingLayers()      stage6WorkingLayers() — the Stage 4 → Stage 6 layer contract
//   ctx.apps                 { [appId]: { compute?(layers) → analysis, body(analysis, layers) → html,
//                                          postRender?() } }
//                            compute's result is written to `S.stage6Cache[appId]` before body()
//                            runs (the five analysis apps); retwall and bishop have no compute.
//                            Until refactor step 7 these are closures over the monolith's own
//                            render/chart functions; afterwards they are the packages' install() results.
//   ctx.legacyFallbackApp    the app rendered for an unknown `S.stage6.app` value — 'beam', the
//                            `else` branch of the old chain (kept as-is: a pure move)
//   ctx.containerId          'stage6Area'
//
// render(): ensure → capture scroll + <details> state → (no layers: placeholder) → compute →
// body → innerHTML = cards + banner + body → restore scroll → rAF(post-render, restore scroll).
import { enabledApps, registryEntry, STAGE6_ICON_FALLBACK } from './registry.js';
import { captureScrollState, restoreScrollState } from './ui-state.js';

export const STAGE6_NO_LAYERS_HTML = '<div style="color:var(--tx2);font-size:13px;padding:20px 0">Run the CPT through Stages 2–5 first so Stage 6 can reuse the interpreted layer model.</div>';

/** 18×18 line-art glyph (stroke = currentColor) around a registry icon body. */
export function stage6IconSvg(body){
  return `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function createStage6Shell(ctx){
  const {
    registry,
    getState,
    ensure,
    rememberDetailsState,
    workingLayers,
    apps,
    legacyFallbackApp = 'beam',
    containerId = 'stage6Area'
  } = ctx;

  /** The `apps` adapter for `app`, or the legacy fallback for an id the shell does not know. */
  function resolveApp(app){
    const id = Object.prototype.hasOwnProperty.call(apps, app) ? app : legacyFallbackApp;
    return { id, ...apps[id] };
  }

  function appIcon(id){
    const entry = registryEntry(registry, id);
    return stage6IconSvg(entry ? entry.cardMeta.icon : STAGE6_ICON_FALLBACK);
  }

  function sharedBanner(){
    const S = getState();
    return `
    <div class="info" style="margin-bottom:14px;background:var(--bg2);border-color:var(--bd2);color:var(--tx2)">
      Active CPT: <strong>${S.id}</strong> · WT = <strong>${S.wt.toFixed(2)} m</strong> below surface · parameter source = <strong>${S.paramMethod==='sb260'?'EC7 / NEN Table 3':'DEF'}</strong> · Stage 5 tuned m = <strong>${S.layers.some(l=>l.ovr.m)?'used where accepted':'not accepted'}</strong>
    </div>
  `;
  }

  function cardsHtml(app){
    const cards = enabledApps(registry);
    return `
    <div class="app-switch" role="tablist" aria-label="Stage 6 applications">
      ${cards.map(c=>`<button type="button" role="tab" aria-selected="${c.id===app}" class="app-chip ${c.id===app?'sel':''}" onclick="setStage6App('${c.id}')" title="${c.cardMeta.title} — ${c.cardMeta.desc}">
        <span class="app-chip-ico">${appIcon(c.id)}</span><span class="app-chip-lbl">${c.short}</span>
      </button>`).join('')}
    </div>
  `;
  }

  function render(){
    ensure();
    const el = document.getElementById(containerId);
    if(!el) return;
    const scrollState = captureScrollState(el);
    rememberDetailsState();
    const S = getState();
    if(!S.layers.length){
      el.innerHTML = STAGE6_NO_LAYERS_HTML;
      return;
    }
    const layers = workingLayers();
    const app = S.stage6.app;
    const adapter = resolveApp(app);
    let analysis;
    if(adapter.compute){
      analysis = adapter.compute(layers);
      S.stage6Cache[adapter.id] = analysis;
    }
    const body = adapter.body(analysis, layers);
    el.innerHTML = `${cardsHtml(app)}${sharedBanner()}${body}`;
    restoreScrollState(el, scrollState);
    requestAnimationFrame(()=>{
      if(adapter.postRender) adapter.postRender();
      restoreScrollState(el, scrollState);
    });
  }

  return { render, cardsHtml, sharedBanner, appIcon, resolveApp };
}
