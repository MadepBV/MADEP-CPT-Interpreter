// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// project/index.js — public surface of the project package (01-monolith-map.md §6.1 row
// `project/`, extracted in PR 14 / refactor step 8): banner, CPT list, phase and stage navigation.
//
//   banner.js  bannerTabsHtml(project) (pure) · renderBanner(document, project, handlers)
//   cpts.js    selectCpt(project, idx, ctx) · addCpt · setCptName · removeCpt · syncCptControls
//   phase.js   setPhase(document, project, ph, hooks) · PHASES
//   nav.js     goS(document, cpt, n, renderStage) · trackMaxStage · applyStageNav · resetStageNav
//              · bindStageNav(document, goS)
//
// installProject(ctx) binds them to a host: the controller keeps its old names (selectCpt,
// addCpt, setCptName, renderBanner, removeCpt, setPhase, goS) as one-line wrappers over the
// returned handlers, and `S` is re-pointed only through ctx.setActive (core/state.js).
//
//   ctx.document, ctx.getProject(), ctx.getActive(), ctx.setActive(idx), ctx.newCptState(id),
//   ctx.confirm(message), ctx.stopWorkers(), ctx.cancelClassificationRefresh(),
//   ctx.syncClassificationMethodCards(method), ctx.initCharts(), ctx.drawLayerColumnSvg(...),
//   ctx.renderCorrelation(), ctx.renderSection(), ctx.renderStage(n)

import { renderBanner as renderBannerDom } from './banner.js';
import { selectCpt as selectCptOf, addCpt as addCptTo, setCptName as setCptNameOf, removeCpt as removeCptFrom } from './cpts.js';
import { setPhase as setPhaseOf } from './phase.js';
import { goS as goStage, bindStageNav } from './nav.js';

export { bannerTabsHtml, bindBannerTabs, renderBanner } from './banner.js';
export { CHART_AREA_HTML, syncCptControls, selectCpt, addCpt, setCptName, removeCpt } from './cpts.js';
export { PHASES, setPhase } from './phase.js';
export { trackMaxStage, applyStageNav, resetStageNav, goS, bindStageNav } from './nav.js';

export function installProject(ctx){
  const { document, getProject, getActive, setActive, newCptState } = ctx;
  const app = {
    renderBanner: () => renderBannerDom(document, getProject(), { selectCpt: app.selectCpt, removeCpt: app.removeCpt }),
    selectCpt: (idx) => selectCptOf(getProject(), idx, {
      document,
      getActive,
      setActive,
      stopWorkers: ctx.stopWorkers,
      cancelClassificationRefresh: ctx.cancelClassificationRefresh,
      renderBanner: app.renderBanner,
      syncClassificationMethodCards: ctx.syncClassificationMethodCards,
      initCharts: ctx.initCharts,
      drawLayerColumnSvg: ctx.drawLayerColumnSvg
    }),
    addCpt: () => addCptTo(getProject(), { document, newCptState, selectCpt: app.selectCpt }),
    setCptName: (idx, name) => setCptNameOf(getProject(), idx, name, { renderBanner: app.renderBanner }),
    removeCpt: (idx) => removeCptFrom(getProject(), idx, { confirm: ctx.confirm, setActive, renderBanner: app.renderBanner, selectCpt: app.selectCpt }),
    setPhase: (ph) => setPhaseOf(document, getProject(), ph, { renderCorrelation: ctx.renderCorrelation, renderSection: ctx.renderSection }),
    goS: (n) => goStage(document, getActive(), n, ctx.renderStage),
    bindStageNav: () => bindStageNav(document, app.goS)
  };
  return app;
}
