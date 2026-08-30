// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// section/index.js — public surface of the section view "Doorsnede" package
// (01-monolith-map.md §6.1 row `section/`, extracted in PR 14 / refactor step 8).
//
//   render.js      sectionCpts(project, projection) · buildSectionSvg({...}) → {html, attrs, complete}
//                  (pure) · sectionTokens · renderSection(document, ctx) (thin DOM wrapper)
//   tooltip.js     sectionTooltipHtml(dataset) · sectionTooltipPosition(...) (pure)
//                  · bindSectionTooltip(document)
//   export-svg.js  sectionSvgDocument · sectionSvgFileName (pure) · exportSectionSVG(document, project)
//
// installSection(ctx) binds them to a host; the controller keeps sectionProjection,
// renderSection, bindSectionTooltip and exportSectionSVG as wrappers over the result.
//   ctx.document, ctx.getProject(), ctx.projection(), ctx.sectionGeometry(), ctx.readToken(name, fallback)

import { sectionCpts, renderSection as renderSectionDom } from './render.js';
import { bindSectionTooltip as bindTooltipDom } from './tooltip.js';
import { exportSectionSVG as exportSvgDom } from './export-svg.js';

export {
  SECTION_TOKENS,
  SECTION_PLACEHOLDER_ATTRS,
  sectionTokens,
  sectionCpts,
  sectionNoCptsHtml,
  sectionNoDataHtml,
  buildSectionSvg,
  renderSection
} from './render.js';
export {
  SECTION_TIP_W,
  SECTION_TIP_H,
  SECTION_TIP_PAD,
  sectionTooltipHtml,
  sectionTooltipPosition,
  bindSectionTooltip
} from './tooltip.js';
export { SVG_XML_HEADER, sectionSvgDocument, sectionSvgFileName, exportSectionSVG } from './export-svg.js';

export function installSection(ctx){
  const { document, getProject } = ctx;
  const app = {
    sectionProjection: () => sectionCpts(getProject(), ctx.projection()),
    bindSectionTooltip: () => bindTooltipDom(document),
    renderSection: () => renderSectionDom(document, {
      getProject,
      projection: ctx.projection,
      sectionGeometry: ctx.sectionGeometry,
      readToken: ctx.readToken,
      bindTooltip: app.bindSectionTooltip
    }),
    exportSectionSVG: () => exportSvgDom(document, getProject())
  };
  /* The four names the Doorsnede toolbar and the Svelte bridge resolve on `window` (PR 20). */
  app.handlers = {
    sectionProjection: app.sectionProjection,
    renderSection: app.renderSection,
    bindSectionTooltip: app.bindSectionTooltip,
    exportSectionSVG: app.exportSectionSVG
  };
  return app;
}
