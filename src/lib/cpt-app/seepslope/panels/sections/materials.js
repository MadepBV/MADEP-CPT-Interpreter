// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/materials.js — legacy-controller.js 6665-6676, verbatim.
import { strengthSetLabel as stage6BishopStrengthSetLabel } from '../labels.js';

/** `bishop-materials` — the imported stability base materials. */
export function materialsSectionHtml(vm, env){
  const { bishop, materialRows } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-materials"${stage6DetailsOpen('bishop-materials')}>
              <summary>Imported base materials from active CPT</summary>
              <div class="st6-adv-body">
                <div class="st6-help">The active CPT working layer model from Stages 2-5 is extended horizontally across the Bishop section. The current imported material set is <strong>${stage6BishopStrengthSetLabel(bishop.strengthSet)}</strong>. You can still tweak the displayed values here for sensitivity work.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Layer</th><th>c'</th><th>phi'</th><th>gamma</th><th>gamma_sat</th></tr></thead>
                    <tbody>${materialRows}</tbody>
                  </table>
                </div>
              </div>
            </details>`;
}
