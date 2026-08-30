// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/geometry-clear.js — legacy-controller.js 8115-8130, verbatim.

/** `bishop-geo-clear` — the reset-geometry actions. */
export function geometryClearSectionHtml(vm, env){
  const { workspace, measurementPoints } = vm;
  const { stage6DetailsOpen } = env;
  return `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-clear"${stage6DetailsOpen('bishop-geo-clear')}>
                <summary>Reset geometry</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-mini-actions">
                    <button class="btn sm" onclick="stage6BishopClear('terrain')">Clear terrain</button>
                    <button class="btn sm" onclick="stage6BishopClear('phreatic')">Clear phreatic</button>
                    <button class="btn sm" onclick="stage6BishopClear('walls')">Clear walls</button>
                    <button class="btn sm" onclick="stage6BishopClear('drains')">Clear drains</button>
                    <button class="btn sm" onclick="stage6BishopClear('entry')">Clear entry</button>
                    <button class="btn sm" onclick="stage6BishopClear('exit')">Clear exit</button>
                    <button class="btn sm" onclick="stage6BishopClear('load')">Clear load</button>
                    ${workspace === 'stability' ? `<button class="btn sm" onclick="stage6BishopClear('measure')" ${measurementPoints.length ? '' : 'disabled'}>Clear measure</button>` : ''}
                    <button class="btn sm" onclick="stage6BishopClear('customRegions')">Clear custom polygons</button>
                  </div>
                </div>
              </details>`;
}
