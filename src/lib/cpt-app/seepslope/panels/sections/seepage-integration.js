// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/seepage-integration.js — legacy-controller.js 6788-6797, verbatim.

/** `bishop-seepage-integration` — the FEM pore-pressure opt-in. */
export function seepageIntegrationSectionHtml(vm, env){
  const { bishop } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-seepage-integration"${stage6DetailsOpen('bishop-seepage-integration')}>
              <summary>Bishop integration</summary>
              <div class="st6-adv-body">
                <label class="st6-bishop-check">
                  <input type="checkbox" ${bishop.useFemPorePressure ? 'checked' : ''} onchange="stage6BishopSetField('useFemPorePressure', this.checked)">
                  Use FEM pore pressure when a seepage result exists
                </label>
                <div class="st6-help">This opt-in stays harmless while the seepage result is empty: Bishop and Spencer continue to use the drawn hydrostatic phreatic line until a seepage field is available.</div>
              </div>
            </details>`;
}
