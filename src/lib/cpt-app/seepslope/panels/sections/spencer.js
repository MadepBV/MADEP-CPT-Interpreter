// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/spencer.js — legacy-controller.js 6625-6664, verbatim.
import { methodModeLabel as stage6BishopMethodModeLabel } from '../../run/index.js';

/** `bishop-spencer` — the Spencer recheck settings. */
export function spencerSectionHtml(vm, env){
  const { bishop } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-spencer"${stage6DetailsOpen('bishop-spencer')}>
              <summary>Spencer recheck settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">When <strong>${stage6BishopMethodModeLabel('bishop_spencer')}</strong> is active, the app first searches with Bishop, then reruns the best circles with a full Spencer solve. For each shortlisted circle it solves the Spencer moment and force branches separately, then finds the λ where those branches intersect. Convergence is accepted on the branch-intersection residual; the λ tolerance field is retained only for compatibility with older saved configs. If Spencer fails on a shortlisted circle, the Bishop result is kept as a fallback.</div>
                <label style="font-size:11px;color:var(--tx2)">Recheck top N circles
                  <input type="number" step="1" min="1" max="${bishop.search.keepBest}" value="${bishop.spencer.recheckCount}" onchange="stage6BishopSetField('spencer.recheckCount', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Lambda low
                  <input type="number" step="0.05" value="${bishop.spencer.lambdaLow.toFixed(2)}" onchange="stage6BishopSetField('spencer.lambdaLow', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Lambda high
                  <input type="number" step="0.05" value="${bishop.spencer.lambdaHigh.toFixed(2)}" onchange="stage6BishopSetField('spencer.lambdaHigh', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Lambda tolerance (legacy)
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.spencer.lambdaTolerance}" onchange="stage6BishopSetField('spencer.lambdaTolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Moment-branch tolerance
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.spencer.momentTolerance}" onchange="stage6BishopSetField('spencer.momentTolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Force-branch tolerance
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.spencer.forceTolerance}" onchange="stage6BishopSetField('spencer.forceTolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">F bracket low
                  <input type="number" step="0.05" min="0.01" value="${bishop.spencer.FBracketLow.toFixed(2)}" onchange="stage6BishopSetField('spencer.FBracketLow', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">F bracket high
                  <input type="number" step="0.5" min="0.10" value="${bishop.spencer.FBracketHigh.toFixed(2)}" onchange="stage6BishopSetField('spencer.FBracketHigh', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Outer iterations
                  <input type="number" step="1" min="5" value="${bishop.spencer.maxOuterIter}" onchange="stage6BishopSetField('spencer.maxOuterIter', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Inner iterations
                  <input type="number" step="1" min="5" value="${bishop.spencer.maxInnerIter}" onchange="stage6BishopSetField('spencer.maxInnerIter', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px">
                  <input type="checkbox" ${bishop.spencer.fallbackBishop?'checked':''} onchange="stage6BishopSetField('spencer.fallbackBishop', this.checked)">
                  Fall back to Bishop if Spencer fails
                </label>
              </div>
            </details>`;
}
