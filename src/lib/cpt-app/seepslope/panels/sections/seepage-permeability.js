// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/seepage-permeability.js — legacy-controller.js 6678-6689, verbatim.

/** `bishop-seepage-perm` — the per-material permeability table. */
export function seepagePermeabilitySectionHtml(vm, env){
  const { permeabilityRows } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-seepage-perm"${stage6DetailsOpen('bishop-seepage-perm')}>
              <summary>Permeability</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Each Bishop material now carries seepage permeability. CPT-derived values are carried through when available; otherwise the app uses an SBTn-style default. Editing either value marks that material as a user override.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Material</th><th>k_x (m/s)</th><th>k_y (m/s)</th><th>Source</th><th></th></tr></thead>
                    <tbody>${permeabilityRows}</tbody>
                  </table>
                </div>
              </div>
            </details>`;
}
