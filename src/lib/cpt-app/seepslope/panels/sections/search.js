// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/search.js — legacy-controller.js 6582-6624, verbatim.

/** `bishop-search` — the Bishop search and solver settings. */
export function searchSectionHtml(vm, env){
  const { bishop } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-search"${stage6DetailsOpen('bishop-search')}>
              <summary>Search and solver settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">If no valid slip circle is found, first try widening the entry and exit zones, increasing the entry / exit samples and centers per chord, increasing the maximum center offset, reducing the minimum slip thickness slightly, or allowing a somewhat larger exit angle. Simple, monotonic terrain geometry also helps the search.</div>
                <label style="font-size:11px;color:var(--tx2)">Entry samples
                  <input type="number" step="1" min="2" value="${bishop.search.nEntry}" onchange="stage6BishopSetField('search.nEntry', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Exit samples
                  <input type="number" step="1" min="2" value="${bishop.search.nExit}" onchange="stage6BishopSetField('search.nExit', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Centers per chord
                  <input type="number" step="1" min="2" value="${bishop.search.nCenter}" onchange="stage6BishopSetField('search.nCenter', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Center offset min (× chord)
                  <input type="number" step="0.1" min="0.05" value="${bishop.search.centerOffsetMin.toFixed(2)}" onchange="stage6BishopSetField('search.centerOffsetMin', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Center offset max (× chord)
                  <input type="number" step="0.1" min="0.10" value="${bishop.search.centerOffsetMax.toFixed(2)}" onchange="stage6BishopSetField('search.centerOffsetMax', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Target slices
                  <input type="number" step="1" min="6" value="${bishop.search.targetSlices}" onchange="stage6BishopSetField('search.targetSlices', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Minimum slip thickness (m)
                  <input type="number" step="0.05" min="0.1" value="${bishop.search.minSlipThickness.toFixed(2)}" onchange="stage6BishopSetField('search.minSlipThickness', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Maximum exit angle (deg)
                  <input type="number" step="1" min="5" max="89" value="${bishop.search.maxExitAngleDeg.toFixed(0)}" onchange="stage6BishopSetField('search.maxExitAngleDeg', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Tolerance
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.solver.tolerance.toFixed(4)}" onchange="stage6BishopSetField('solver.tolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Maximum iterations
                  <input type="number" step="1" min="5" value="${bishop.solver.maxIterations}" onchange="stage6BishopSetField('solver.maxIterations', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Minimum m_alpha
                  <input type="number" step="0.000001" min="0.000000001" value="${bishop.solver.minMAlpha}" onchange="stage6BishopSetField('solver.minMAlpha', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px">
                  <input type="checkbox" ${bishop.solver.useOrdinarySeed?'checked':''} onchange="stage6BishopSetField('solver.useOrdinarySeed', this.checked)">
                  Use ordinary method seed
                </label>
              </div>
            </details>`;
}
