// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/canvas-view-menu.js — the `bishop-canvas-view-menu` group: the
// floating View menu over the canvas (legacy-controller.js 7513-7558) plus the two fragments only
// it uses — the contour-mode select (7382-7394) and the overlay icon grid (7395-7512, with the
// monolith's `viewMenuIconButton` closure at 7357-7365) — verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';
import { toolIcon as stage6BishopToolIcon } from '../icons.js';

/** The View menu's contour-mode select. */
export function viewMenuContourControlHtml(vm, env){
  const { workspace, seepageContourMode, seepageContourOptions, deformationContourMode, deformationContourOptions } = vm;
  return workspace === 'seepage' ? `
    <label class="st6-bishop-view-menu-field">Contour mode
      <select onchange="stage6BishopSetField('seepage.display.contourMode', this.value)">
        ${seepageContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${seepageContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
      </select>
    </label>
  ` : workspace === 'deformation' ? `
    <label class="st6-bishop-view-menu-field">Contour mode
      <select onchange="stage6BishopSetField('deformation.display.contourMode', this.value)">
        ${deformationContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${deformationContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
      </select>
    </label>
  ` : '';
}

/** The View menu's icon grid of per-workspace overlays. */
export function viewMenuWorkspaceOverlayHtml(vm, env){
  const { bishop, workspace, deformationDisplacementVectorAvailable, deformationShowWallOverlay, wallOverlayQuantity, wallOverlayStatsLabel, deformationShowContours, deformationShowContourLines, deformationShowContourLegend, deformationShowDeformedMesh, deformationShowUndeformedMesh, deformationShowPlasticPoints, deformationShowDirectionVectors, seepageShowContours, seepageShowContourLines, seepageShowContourLegend, seepageShowBoundaryConditions, seepageShowBoundaryLabels, seepageShowPhreatic, seepageShowDrains, seepageShowFlowVectors, seepageShowExitGradient } = vm;
  const { STAGE6_WALL_RESPONSE_QUANTITIES } = env;
  const viewMenuIconButton = ({label, icon, active, disabled, onclick})=>`
    <button
      type="button"
      class="st6-bishop-view-menu-action${active ? ' active' : ''}"
      ${disabled ? 'disabled' : `onclick="${onclick}"`}
      title="${stage6EscAttr(label)}"
      aria-label="${stage6EscAttr(label)}"
    >${stage6BishopToolIcon(icon)}</button>
  `;
  return workspace === 'seepage' ? `
    <div class="st6-bishop-view-menu-icon-grid">
      ${viewMenuIconButton({
        label:'Contour fill',
        icon:'contourFill',
        active:seepageShowContours,
        onclick:`stage6BishopSetField('seepage.display.showContours', ${seepageShowContours ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour lines',
        icon:'contourLines',
        active:seepageShowContourLines,
        onclick:`stage6BishopSetField('seepage.display.showContourLines', ${seepageShowContourLines ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour legend',
        icon:'layers',
        active:seepageShowContourLegend,
        onclick:`stage6BishopSetField('seepage.display.showContourLegend', ${seepageShowContourLegend ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Boundary conditions',
        icon:'boundary',
        active:seepageShowBoundaryConditions,
        onclick:`stage6BishopSetField('seepage.display.showBoundaryConditions', ${seepageShowBoundaryConditions ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Boundary labels',
        icon:'label',
        active:seepageShowBoundaryLabels,
        onclick:`stage6BishopSetField('seepage.display.showBoundaryLabels', ${seepageShowBoundaryLabels ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Phreatic line',
        icon:'phreatic',
        active:seepageShowPhreatic,
        onclick:`stage6BishopSetField('seepage.display.showPhreatic', ${seepageShowPhreatic ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Drains',
        icon:'drain',
        active:seepageShowDrains,
        onclick:`stage6BishopSetField('seepage.display.showDrains', ${seepageShowDrains ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Flow lines',
        icon:'arrows',
        active:seepageShowFlowVectors,
        onclick:`stage6BishopSetField('seepage.display.showFlowVectors', ${seepageShowFlowVectors ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Exit gradient',
        icon:'exitGradient',
        active:seepageShowExitGradient,
        onclick:`stage6BishopSetField('seepage.display.showExitGradient', ${seepageShowExitGradient ? 'false' : 'true'})`
      })}
    </div>
  ` : workspace === 'deformation' ? `
    <div class="st6-bishop-view-menu-icon-grid">
      ${viewMenuIconButton({
        label:'Contour fill',
        icon:'contourFill',
        active:deformationShowContours,
        onclick:`stage6BishopSetField('deformation.display.showContours', ${deformationShowContours ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour lines',
        icon:'contourLines',
        active:deformationShowContourLines,
        onclick:`stage6BishopSetField('deformation.display.showContourLines', ${deformationShowContourLines ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour legend',
        icon:'layers',
        active:deformationShowContourLegend,
        onclick:`stage6BishopSetField('deformation.display.showContourLegend', ${deformationShowContourLegend ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Deformed mesh',
        icon:'meshDeformed',
        active:deformationShowDeformedMesh,
        onclick:`stage6BishopSetField('deformation.display.showDeformedMesh', ${deformationShowDeformedMesh ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Undeformed mesh',
        icon:'meshUndeformed',
        active:deformationShowUndeformedMesh,
        onclick:`stage6BishopSetField('deformation.display.showUndeformedMesh', ${deformationShowUndeformedMesh ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Plastic points',
        icon:'plastic',
        active:deformationShowPlasticPoints,
        onclick:`stage6BishopSetField('deformation.display.showPlasticPoints', ${deformationShowPlasticPoints ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Direction vectors',
        icon:'arrows',
        active:deformationShowDirectionVectors,
        disabled:!deformationDisplacementVectorAvailable,
        onclick:`stage6BishopSetField('deformation.display.showDisplacementVectors', ${deformationShowDirectionVectors ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Wall result overlay',
        icon:'chart',
        active:deformationShowWallOverlay,
        onclick:`stage6BishopSetField('deformation.display.showWallMomentOverlay', ${deformationShowWallOverlay ? 'false' : 'true'})`
      })}
    </div>
    <label class="st6-bishop-view-menu-field" title="${stage6EscAttr(wallOverlayStatsLabel)}">Wall overlay quantity
      <select onchange="stage6BishopSetField('deformation.display.wallOverlayQuantity', this.value)">
        ${STAGE6_WALL_RESPONSE_QUANTITIES.map((option)=>`<option value="${stage6EscAttr(option.id)}"${wallOverlayQuantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
      </select>
    </label>
    <label class="st6-bishop-view-menu-field">Shape scale
      <input type="number" step="0.1" min="0.05" value="${Number(bishop.deformation?.options?.displacementScale || 1).toFixed(2)}" onchange="stage6BishopSetField('deformation.options.displacementScale', this.value)">
    </label>
  ` : '';
}

/** `bishop-canvas-view-menu` — the floating View menu over the canvas. */
export function canvasViewMenuSectionHtml(vm, env, fragments){
  const { bishop, workspace, regionLegendItems } = vm;
  const { stage6DetailsOpen } = env;
  const { viewMenuContourControlHtml, viewMenuWorkspaceOverlayHtml } = fragments;
  return `
    <details class="st6-bishop-view-menu" data-st6details="bishop-canvas-view-menu"${stage6DetailsOpen('bishop-canvas-view-menu')}>
      <summary title="View" aria-label="View">
        <span class="st6-bishop-view-menu-icon">${stage6BishopToolIcon('layers')}</span>
        <span class="st6-bishop-region-legend-title st6-bishop-view-menu-title">View</span>
        ${regionLegendItems.length ? `<span class="st6-bishop-region-legend-count">${regionLegendItems.length}</span>` : ''}
      </summary>
      <div class="st6-bishop-view-menu-body" data-st6scroll-key="bishop-canvas-view-menu-body">
        <div class="st6-bishop-view-menu-actions">
          <button type="button" class="st6-bishop-view-menu-action" onclick="fitStage6BishopViewport()" title="Fit view" aria-label="Fit view">${stage6BishopToolIcon('fit')}</button>
          <button type="button" class="st6-bishop-view-menu-action" onclick="stage6BishopOpenSettingsDetail('bishop-geo-view')" title="View details" aria-label="View details">${stage6BishopToolIcon('panel')}</button>
        </div>
        ${viewMenuContourControlHtml}
        <div class="st6-bishop-view-menu-section">
          <div class="st6-bishop-view-menu-label">Snap</div>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.gridSnap?'checked':''} onchange="stage6BishopSetField('gridSnap', this.checked)"> Grid</label>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.pointSnap?'checked':''} onchange="stage6BishopSetField('pointSnap', this.checked)"> Points</label>
          <label class="st6-bishop-view-menu-field">Grid size
            <input type="number" step="0.05" min="0.05" value="${bishop.snapSize.toFixed(2)}" onchange="stage6BishopSetField('snapSize', this.value)">
          </label>
        </div>
        <div class="st6-bishop-view-menu-section">
          <div class="st6-bishop-view-menu-label">Polygons</div>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.display?.showRegions !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegions', this.checked)"> Fill</label>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.display?.showRegionLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLabels', this.checked)"> Labels</label>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.display?.showRegionLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLegend', this.checked)"> List</label>
          ${bishop.display?.showRegionLegend !== false && regionLegendItems.length ? `
            <div class="st6-bishop-region-legend-body st6-bishop-view-menu-region-list">
              ${regionLegendItems.map((item)=>`
                <div class="st6-bishop-region-chip">
                  <span class="st6-bishop-region-swatch" style="background:${stage6EscAttr(item.color)}"></span>
                  <span class="st6-bishop-region-text">${stage6EscAttr(item.label)}${item.count > 1 ? ` <em>(${item.count})</em>` : ''}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
        ${viewMenuWorkspaceOverlayHtml ? `
          <div class="st6-bishop-view-menu-section">
            <div class="st6-bishop-view-menu-label">${workspace === 'seepage' ? 'Seepage' : 'Deformation'}</div>
            ${viewMenuWorkspaceOverlayHtml}
          </div>
        ` : ''}
      </div>
    </details>`;
}

/** The monolith's `canvasViewMenuHtml` local: the group plus its own trailing indent. */
export function canvasViewMenuHtml(vm, env){
  const fragments = {
    viewMenuContourControlHtml: viewMenuContourControlHtml(vm, env),
    viewMenuWorkspaceOverlayHtml: viewMenuWorkspaceOverlayHtml(vm, env)
  };
  return `${canvasViewMenuSectionHtml(vm, env, fragments)}
  `;
}
