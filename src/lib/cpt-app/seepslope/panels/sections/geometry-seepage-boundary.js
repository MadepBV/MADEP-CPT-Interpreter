// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/geometry-seepage-boundary.js — legacy-controller.js 6478-6507, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';

/** `bishop-geo-seepage-boundary` — the seepage workspace BC assignment. */
export function seepageBoundarySectionHtml(vm, env){
  const { bishop, model, selectedSeepageEdge, selectedSeepageBc, seepageSetupMessage } = vm;
  const { stage6DetailsOpen, stage6BishopSeepageEdgeLabel } = env;
  return `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-seepage-boundary"${stage6DetailsOpen('bishop-geo-seepage-boundary')}>
                <summary>Boundary conditions</summary>
                <div class="st6-adv-body">
                  <div class="st6-help">Switch the shared canvas into boundary-condition mode, then click an outer-boundary edge. Terrain, model base, and the two side boundaries can carry seepage BCs; interior soil-region edges cannot. New edges reuse the last boundary condition you applied, while edges that already have an explicit BC keep their own setting. For <strong>Prescribed head</strong>, enter the absolute head elevation <strong>h</strong> in metres; on a sloping or vertical edge the solver applies that head only to the submerged part below <strong>y = h</strong>, while the dry part above falls back to natural no-flow.</div>
                  <div class="st6-bishop-tools">
                    <button class="btn sm ${bishop.tool==='seepageBc'?'active':''}" onclick="stage6BishopSetTool('seepageBc')" ${model ? '' : 'disabled'}>Assign BC</button>
                    <button class="btn sm ${bishop.tool==='edit'?'active':''}" onclick="stage6BishopSetTool('edit')">Edit / pan</button>
                  </div>
                  ${selectedSeepageEdge ? `
                    <div class="st6-help">Selected edge: <strong>${stage6EscAttr(stage6BishopSeepageEdgeLabel(selectedSeepageEdge))}</strong> · length <strong>${selectedSeepageEdge.length.toFixed(2)} m</strong></div>
                    <label style="font-size:11px;color:var(--tx2)">Boundary type
                      <select onchange="stage6BishopSetSeepageBcType(this.value)">
                        <option value="no-flow"${(selectedSeepageBc?.type || 'no-flow')==='no-flow'?' selected':''}>No-flow</option>
                        <option value="head"${selectedSeepageBc?.type==='head'?' selected':''}>Prescribed head</option>
                        <option value="seepage-face"${selectedSeepageBc?.type==='seepage-face'?' selected':''}>Seepage face</option>
                      </select>
                    </label>
                    ${(selectedSeepageBc?.type || 'no-flow') === 'head' ? `
                      <label style="font-size:11px;color:var(--tx2)">Head h (m elevation)
                        <input type="number" step="0.05" value="${Number(selectedSeepageBc?.head ?? selectedSeepageEdge.mid.y).toFixed(2)}" onchange="stage6BishopSetSeepageBcHead(this.value)">
                      </label>
                    ` : ''}
                    <div class="st6-bishop-mini-actions">
                      <button class="btn sm" onclick="stage6BishopDeleteSeepageBc('${stage6EscAttr(selectedSeepageEdge.edgeKey)}')">Remove explicit BC</button>
                    </div>
                  ` : `
                    <div class="st6-help">${seepageSetupMessage}</div>
                  `}
                </div>
              </details>`;
}
