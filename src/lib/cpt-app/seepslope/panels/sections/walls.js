// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/walls.js — legacy-controller.js 8133-8144, verbatim.

/** `bishop-walls` — the retaining-wall table. */
export function wallsSectionHtml(vm, env){
  const { wallRows } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-walls"${stage6DetailsOpen('bishop-walls')}>
              <summary>Retaining walls</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Walls are treated as infinitely stiff line elements for stability. In seepage they are thin oriented regions with user-set across-wall and along-wall conductivity; dry wall elements get the same dry-factor reduction as soil.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>#</th><th>Head x</th><th>Head y</th><th>Tip x</th><th>Tip y</th><th>Passive side</th><th>Mechanical</th><th>R_inter</th><th>Preset</th><th>Model</th><th>E / EA</th><th>t / EI</th><th>ν / GA</th><th>κ</th><th>k across</th><th>k along</th><th>Source</th><th>Length</th><th></th></tr></thead>
                    <tbody>${wallRows || '<tr><td colspan="19" style="text-align:center;color:var(--tx2)">No retaining walls yet. Use the Retaining wall tool and click head then tip.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </details>`;
}
