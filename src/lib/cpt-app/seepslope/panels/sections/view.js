// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/view.js — legacy-controller.js 7163-7311, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';

/** `bishop-geo-view` — the full View panel, opened as the tool rail's View sheet. */
export function viewSectionHtml(vm, env){
  const { bishop, workspace, seepageContourOptions, deformationContourOptions, deformationDisplacementVectorAvailable, deformationShowWallOverlay, wallOverlayQuantity, wallOverlayStatsLabel } = vm;
  const { STAGE6_WALL_RESPONSE_QUANTITIES, stage6DetailsOpen } = env;
  return `
              <details class="st6-adv st6-bishop-view-panel" data-st6details="bishop-geo-view"${stage6DetailsOpen('bishop-geo-view')}>
                <summary>View</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-view-grid">
                    <div class="st6-bishop-view-card">
                      <div class="st6-bishop-view-card-title">Snap</div>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.gridSnap?'checked':''} onchange="stage6BishopSetField('gridSnap', this.checked)">
                        Snap to grid
                      </label>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.pointSnap?'checked':''} onchange="stage6BishopSetField('pointSnap', this.checked)">
                        Snap to existing points
                      </label>
                      <label style="font-size:11px;color:var(--tx2)">Grid size (m)
                        <input type="number" step="0.05" min="0.05" value="${bishop.snapSize.toFixed(2)}" onchange="stage6BishopSetField('snapSize', this.value)">
                      </label>
                      <div class="st6-help">If both snap modes are enabled, the cursor snaps to whichever candidate is closer: the grid node or the nearest existing Bishop canvas point.</div>
                    </div>
                    <div class="st6-bishop-view-card">
                      <div class="st6-bishop-view-card-title">Polygon overlay</div>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.display?.showRegions !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegions', this.checked)">
                        Show soil polygons
                      </label>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.display?.showRegionLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLabels', this.checked)">
                        Show polygon labels
                      </label>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.display?.showRegionLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLegend', this.checked)">
                        Show polygon legend
                      </label>
                      <label style="font-size:11px;color:var(--tx2)">Fill opacity
                        <input type="number" step="0.05" min="0.05" max="0.75" value="${Number(bishop.display?.regionOpacity ?? 0.22).toFixed(2)}" onchange="stage6BishopSetField('display.regionOpacity', this.value)">
                      </label>
                    </div>
                    ${workspace === 'seepage' ? `
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Seepage contours</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showContours !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showContours', this.checked)">
                          Show contour fill
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showContourLines !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showContourLines', this.checked)">
                          Show contour lines
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showContourLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showContourLegend', this.checked)">
                          Show contour legend
                        </label>
                        <label style="font-size:11px;color:var(--tx2)">Contour mode
                          <select onchange="stage6BishopSetField('seepage.display.contourMode', this.value)">
                            ${seepageContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${bishop.seepage?.display?.contourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                          </select>
                        </label>
                      </div>
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Seepage overlay</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showBoundaryConditions !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showBoundaryConditions', this.checked)">
                          Show boundary conditions
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showBoundaryLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showBoundaryLabels', this.checked)">
                          Show BC labels
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showPhreatic !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showPhreatic', this.checked)">
                          Show phreatic line
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showDrains !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showDrains', this.checked)">
                          Show drains
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showFlowVectors ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showFlowVectors', this.checked)">
                          Show flow lines
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showExitGradient ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showExitGradient', this.checked)">
                          Show exit gradient
                        </label>
                      </div>
                    ` : workspace === 'deformation' ? `
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Contour overlay</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showContours !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showContours', this.checked)">
                          Show contour fill
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showContourLines !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showContourLines', this.checked)">
                          Show contour lines
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showContourLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showContourLegend', this.checked)">
                          Show contour legend
                        </label>
                        <label style="font-size:11px;color:var(--tx2)">Contour mode
                          <select onchange="stage6BishopSetField('deformation.display.contourMode', this.value)">
                            ${deformationContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${bishop.deformation?.display?.contourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                          </select>
                        </label>
                      </div>
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Mesh and vectors</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showDeformedMesh !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showDeformedMesh', this.checked)">
                          Show deformed mesh
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showUndeformedMesh ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showUndeformedMesh', this.checked)">
                          Show undeformed mesh
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showLoadVectors !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showLoadVectors', this.checked)">
                          Show load vectors
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showPlasticPoints !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showPlasticPoints', this.checked)">
                          Show plastic points
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${deformationShowWallOverlay ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showWallMomentOverlay', this.checked)">
                          Show wall result overlay
                        </label>
                        <label style="font-size:11px;color:var(--tx2)">Wall overlay quantity
                          <select onchange="stage6BishopSetField('deformation.display.wallOverlayQuantity', this.value)" title="${stage6EscAttr(wallOverlayStatsLabel)}">
                            ${STAGE6_WALL_RESPONSE_QUANTITIES.map((option)=>`<option value="${stage6EscAttr(option.id)}"${wallOverlayQuantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                          </select>
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showDisplacementVectors ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showDisplacementVectors', this.checked)" ${deformationDisplacementVectorAvailable ? '' : 'disabled'}>
                          Show displacement direction vectors
                        </label>
                        <div class="st6-help">Filled red points mark currently active plastic points, amber points mark active tension cut-off points, and magenta rings show stored plastic history. In the reduced-stiffness screen the same overlay marks MC-active hotspots.</div>
                        <label style="font-size:11px;color:var(--tx2)">Deformed-shape scale factor
                          <input type="number" step="0.1" min="0.05" value="${Number(bishop.deformation?.options?.displacementScale || 1).toFixed(2)}" onchange="stage6BishopSetField('deformation.options.displacementScale', this.value)">
                        </label>
                        <div class="st6-help">Wall diagrams are signed: positive w, V, and M plot toward the selected passive side; for a right-passive wall, negative w is left. Displacement vectors are shown sparsely on the current contour lines for <strong>Settlement</strong>, <strong>|u|,fin</strong>, <strong>uₓ,fin</strong>, and <strong>uᵧ,fin</strong>. They stay off for stress and MC contour modes.</div>
                      </div>
                    ` : ''}
                  </div>
                </div>
              </details>
  `;
}
