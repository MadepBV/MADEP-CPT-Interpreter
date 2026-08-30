// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/geometry-analysis.js — legacy-controller.js 6453-6476, verbatim.
import { tooltip as stage6Tooltip } from '../../../core/format.js';

/** `bishop-geo-analysis` — the stability workspace inputs (strength set, method, q, depth). */
export function analysisInputsSectionHtml(vm, env){
  const { bishop, loadQ } = vm;
  const { stage6DetailsOpen, stage6MaxDepth } = env;
  return `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-analysis"${stage6DetailsOpen('bishop-geo-analysis')}>
                <summary>Analysis inputs</summary>
                <div class="st6-adv-body">
                  <label style="font-size:11px;color:var(--tx2)">Material strength set${stage6Tooltip('Characteristic keeps the active CPT layer parameters unchanged. DA1/1 uses M1 soil factors and DA1/2 uses M2 soil factors before importing the Bishop base materials.')}
                    <select onchange="stage6BishopSetField('strengthSet', this.value)">
                      <option value="characteristic"${bishop.strengthSet==='characteristic'?' selected':''}>Characteristic</option>
                      <option value="da1_1"${bishop.strengthSet==='da1_1'?' selected':''}>DA1/1 (M1)</option>
                      <option value="da1_2"${bishop.strengthSet==='da1_2'?' selected':''}>DA1/2 (M2)</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Method
                    <select onchange="stage6BishopSetField('methodMode', this.value)">
                      <option value="bishop_spencer"${bishop.methodMode==='bishop_spencer'?' selected':''}>Bishop + Spencer check</option>
                      <option value="bishop_only"${bishop.methodMode==='bishop_only'?' selected':''}>Bishop only</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Surface load q (kPa)${stage6Tooltip('Uniform vertical surcharge intensity for the selected load zone. In the 2D Bishop section all active loads contribute q times their overlap width in each slice.')}
                    <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Analysis depth below terrain (m)${stage6Tooltip('The Bishop section extends to this depth below the local ground level at the active CPT. The default is the CPT depth or 15 m, whichever is greater. If you go deeper, the deepest CPT layer is extrapolated downward.')}
                    <input type="number" step="0.5" min="${Math.max(stage6MaxDepth(), 15).toFixed(2)}" value="${bishop.analysisDepth.toFixed(2)}" onchange="stage6BishopSetField('analysisDepth', this.value)">
                  </label>
                </div>
              </details>`;
}
