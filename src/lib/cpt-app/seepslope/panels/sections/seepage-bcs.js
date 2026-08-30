// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/seepage-bcs.js — legacy-controller.js 6690-6711, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';

/** `bishop-seepage-bcs` — the assigned boundary conditions. */
export function seepageBcsSectionHtml(vm, env){
  const { seepageBoundary, seepageActiveBcs, seepageOrphanedBcs, seepageHeadCount, seepageSetupMessage, seepageBcRows } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-seepage-bcs"${stage6DetailsOpen('bishop-seepage-bcs')}>
              <summary>Assigned boundary conditions</summary>
              <div class="st6-adv-body">
                <div class="st6-help">The seepage solver will require at least one prescribed-head edge. Any outer boundary edge without an explicit assignment still behaves as no-flow by default.</div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Outer boundary edges: <strong>${seepageBoundary.length}</strong><br>
                  Active BCs: <strong>${seepageActiveBcs.length}</strong><br>
                  Prescribed head edges: <strong>${seepageHeadCount}</strong><br>
                  Orphaned BCs: <strong>${seepageOrphanedBcs.length}</strong><br>
                  Status: <strong>${stage6EscAttr(seepageSetupMessage)}</strong>
                </div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Edge</th><th>Type</th><th>Head</th><th>Status</th><th></th></tr></thead>
                    <tbody>${seepageBcRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">No explicit boundary conditions yet.</td></tr>'}</tbody>
                  </table>
                </div>
                ${seepageOrphanedBcs.length ? `
                  <div class="st6-help">Some BC anchors no longer match the rebuilt geometry and are marked orphaned. Reassign those edges on the canvas before solving seepage.</div>
                ` : ''}
              </div>
            </details>`;
}
