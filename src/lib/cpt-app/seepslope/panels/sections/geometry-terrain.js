// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/geometry-terrain.js — legacy-controller.js 8013-8025, verbatim.

/** `bishop-geo-terrain` — the terrain draw / DXF import tools. */
export function terrainSectionHtml(vm, env){
  const { bishop } = vm;
  const { stage6DetailsOpen } = env;
  return `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-terrain"${stage6DetailsOpen('bishop-geo-terrain')}>
                <summary>Terrain</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-tools">
                    <button class="btn sm ${bishop.tool==='terrain'?'active':''}" onclick="stage6BishopSetTool('terrain')">Draw terrain</button>
                    <button class="btn sm" onclick="stage6BishopTriggerDxfImport()">Import DXF terrain</button>
                    <input id="stage6BishopDxfInput" type="file" accept=".dxf,.DXF" style="display:none" onchange="stage6BishopImportDxf(event)">
                    <button class="btn sm" onclick="stage6BishopFinishDraft()">Finish draft</button>
                    <button class="btn sm" onclick="stage6BishopPopDraftPoint()">Undo point</button>
                    <button class="btn sm" onclick="stage6BishopClear('draft')">Clear draft</button>
                  </div>
                </div>
              </details>`;
}
