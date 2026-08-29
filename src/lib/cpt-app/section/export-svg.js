// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// section/export-svg.js — download of the section SVG (01-monolith-map.md §2.12 `exportSectionSVG`).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): exportSectionSVG 857-865.
// The file text and name are the pure `sectionSvgDocument` / `sectionSvgFileName`; the Blob +
// anchor click is the thin `exportSectionSVG(document, project)`.

export const SVG_XML_HEADER='<?xml version="1.0"?>';

export function sectionSvgDocument(svgOuterHtml){
  return SVG_XML_HEADER+svgOuterHtml;
}

export function sectionSvgFileName(projectName){
  return `${projectName}_doorsnede.svg`;
}

export function exportSectionSVG(document, project){
  const svg=document.getElementById('sectionSvg');
  if(!svg)return;
  const blob=new Blob([sectionSvgDocument(svg.outerHTML)],{type:'image/svg+xml'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=sectionSvgFileName(project.name);
  a.click();
}
