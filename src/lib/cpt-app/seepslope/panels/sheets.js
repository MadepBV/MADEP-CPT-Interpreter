// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sheets.js — the eight canvas sheets the tool rail opens
// (legacy-controller.js 7559-7748), verbatim. Each is the monolith's own `const …SheetHtml`; the
// fragments they reuse (workspaceGeometrySectionHtml, workspaceInfoHtml, analysisSheetHtml, …) are
// computed once by ./layout.js and handed down, exactly as the monolith's locals were.
import { escAttr as stage6EscAttr } from '../../core/format.js';
import { drainValidationSummary as stage6BishopDrainValidationSummary, normalizeRegionCoarseness as stage6BishopNormalizeRegionCoarseness } from '../state/index.js';
import { strengthSetLabel as stage6BishopStrengthSetLabel } from './labels.js';

/** Structures: the wall table and the drain table. */
export function structuresSheetHtml(vm, env){
  const { bishop, model, wallRows, drainValidation, drainRows, drainValidationHtml } = vm;
  return `
    <div class="st6-canvas-sheet-grid">
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Retaining walls</div>
        <div class="st6-help">Edit geometry, passive side, and seepage conductivity for every wall without opening the old settings column.</div>
        <div class="st6-canvas-table-wrap">
          <table class="tbl st6-bishop-materials">
            <thead><tr><th>#</th><th>Head x</th><th>Head y</th><th>Tip x</th><th>Tip y</th><th>Passive side</th><th>Mechanical</th><th>R_inter</th><th>Preset</th><th>Model</th><th>E / EA</th><th>t / EI</th><th>ν / GA</th><th>κ</th><th>k across</th><th>k along</th><th>Source</th><th>Length</th><th></th></tr></thead>
            <tbody>${wallRows || '<tr><td colspan="19" style="text-align:center;color:var(--tx2)">No retaining walls yet. Use the Retaining wall tool and click head then tip.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Drains</div>
        <div class="st6-bishop-tools">
          <button class="btn sm ${bishop.tool==='drain'?'active':''}" onclick="stage6BishopSetTool('drain')" ${model ? '' : 'disabled'}>Draw drain line</button>
          <button class="btn sm" onclick="stage6BishopFinishDraft()" ${(bishop.draftKind==='drain' && bishop.draft.length >= 2) ? '' : 'disabled'}>Finish drain</button>
          <button class="btn sm" onclick="stage6BishopClear('drains')" ${(bishop.drains || []).length ? '' : 'disabled'}>Clear drains</button>
        </div>
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          Drains: <strong>${(bishop.drains || []).length}</strong><br>
          Validation: <strong>${stage6EscAttr(stage6BishopDrainValidationSummary(drainValidation))}</strong>
        </div>
        ${drainValidationHtml.length ? `
          <div style="display:grid;gap:6px">
            ${drainValidationHtml.map((issue)=>`
              <div class="info" style="background:${issue.level === 'warn' ? 'var(--wnl)' : 'var(--bg2)'};border-color:${issue.level === 'warn' ? 'var(--wn)' : 'var(--bd2)'};margin:0">${stage6EscAttr(issue.text)}</div>
            `).join('')}
          </div>
        ` : ''}
        <div class="st6-canvas-table-wrap">
          <table class="tbl st6-bishop-materials">
            <thead><tr><th>Label</th><th>Vertices</th><th>Head h</th><th>Gating</th><th>Length</th><th></th><th></th></tr></thead>
            <tbody>${drainRows || '<tr><td colspan="7" style="text-align:center;color:var(--tx2)">No drains yet. Use Draw drain line, then click a start and end point on the canvas.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/** Boundary conditions: the geometry section plus the assigned-BC table. */
export function boundarySheetHtml(vm, env, fragments){
  const { workspace, seepageBoundary, seepageActiveBcs, seepageOrphanedBcs, seepageHeadCount, seepageSetupMessage, seepageBcRows } = vm;
  const { workspaceGeometrySectionHtml } = fragments;
  return workspace === 'seepage' ? `
    <div class="st6-canvas-sheet-grid">
      ${workspaceGeometrySectionHtml}
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Assigned boundary conditions</div>
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          Outer boundary edges: <strong>${seepageBoundary.length}</strong><br>
          Active BCs: <strong>${seepageActiveBcs.length}</strong><br>
          Prescribed head edges: <strong>${seepageHeadCount}</strong><br>
          Orphaned BCs: <strong>${seepageOrphanedBcs.length}</strong><br>
          Status: <strong>${stage6EscAttr(seepageSetupMessage)}</strong>
        </div>
        <div class="st6-canvas-table-wrap">
          <table class="tbl st6-bishop-materials">
            <thead><tr><th>Edge</th><th>Type</th><th>Head</th><th>Status</th><th></th></tr></thead>
            <tbody>${seepageBcRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">No explicit boundary conditions yet.</td></tr>'}</tbody>
          </table>
        </div>
        ${seepageOrphanedBcs.length ? `<div class="st6-help">Some BC anchors no longer match the rebuilt geometry and are marked orphaned. Reassign those edges on the canvas before solving seepage.</div>` : ''}
      </div>
    </div>
  ` : `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Boundary conditions</div>
      <div class="st6-canvas-card-note">Seepage boundary conditions are available in the Seepage workspace.</div>
    </div>
  `;
}

/** Regions: the polygon tools and the selected polygon. */
export function regionsSheetHtml(vm, env){
  const { bishop, model, selectedCustomRegion, customRegionCount, customModeActive, showingCustomRegionPreview, seepageMeshTargetArea } = vm;
  return `
    <div class="st6-canvas-sheet-grid">
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Soil polygons</div>
        <div class="st6-bishop-tools">
          <button class="btn sm" onclick="stage6BishopCopyCurrentRegionsToCustom()" ${model ? '' : 'disabled'}>Copy current polygons</button>
          <button class="btn sm ${bishop.tool==='region'?'active':''}" onclick="stage6BishopSetTool('region')" ${model ? '' : 'disabled'}>Draw polygon</button>
          <button class="btn sm ${bishop.tool==='regionHole'?'active':''}" onclick="stage6BishopSetTool('regionHole')" ${selectedCustomRegion ? '' : 'disabled'}>Cut hole</button>
          <button class="btn sm ${bishop.tool==='regionSplit'?'active':''}" onclick="stage6BishopSetTool('regionSplit')" ${selectedCustomRegion ? '' : 'disabled'}>Split selected</button>
          <button class="btn sm" onclick="stage6BishopFinishDraft()" ${((bishop.draftKind==='region' || bishop.draftKind==='regionHole') && bishop.draft.length >= 3) ? '' : 'disabled'}>${bishop.draftKind==='regionHole' ? 'Finish hole' : 'Finish polygon'}</button>
          <button class="btn sm" onclick="stage6BishopDeleteSelectedRegion()" ${selectedCustomRegion ? '' : 'disabled'}>Delete selected</button>
        </div>
        <label class="st6-bishop-check">
          <input type="checkbox" ${customModeActive ? 'checked' : ''} onchange="stage6BishopSetUseCustomRegions(this.checked)" ${customRegionCount ? '' : 'disabled'}>
          Use custom polygons in the solver
        </label>
        ${showingCustomRegionPreview ? `<div class="st6-help">Custom polygons are visible for editing, but the solver is still using the CPT-derived polygon set until you enable the checkbox above.</div>` : ''}
        <label style="font-size:11px;color:var(--tx2)">Material for new polygons
          <select onchange="stage6BishopSetField('regionDraftMaterialId', this.value)">
            ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${(bishop.regionDraftMaterialId || bishop.materials?.[0]?.id)===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Selected polygon</div>
        ${selectedCustomRegion ? `
          <label style="font-size:11px;color:var(--tx2)">Selected polygon material
            <select onchange="stage6BishopSetSelectedRegionMaterial(this.value)">
              ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${selectedCustomRegion.materialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
            </select>
          </label>
          <label style="font-size:11px;color:var(--tx2)">Selected polygon coarseness
            <input type="number" min="0.01" step="0.1" value="${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness)}" onchange="stage6BishopSetSelectedRegionCoarseness(this.value)">
          </label>
          <div class="st6-help">Effective local seepage target area: <strong>${(stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness) * seepageMeshTargetArea).toFixed(3)} m²</strong>.</div>
          <div class="st6-help">Selected polygon: <strong>${stage6EscAttr(selectedCustomRegion.id)}</strong> · vertices <strong>${selectedCustomRegion.polygon.length}</strong> · source <strong>${selectedCustomRegion.source === 'cpt-copy' ? 'copied from CPT' : selectedCustomRegion.source === 'hole' ? 'hole cut' : selectedCustomRegion.source === 'edited' ? 'edited fragment' : 'custom drawn'}</strong></div>
        ` : `<div class="st6-canvas-card-note">${customRegionCount ? 'No custom polygon is selected. Click one in Edit / pan mode to edit it.' : 'No custom polygons yet. Copy the current solver polygons or draw a new polygon to start editing.'}</div>`}
      </div>
    </div>
  `;
}

/** Materials: permeability / deformation / stability, per workspace. */
export function materialsSheetHtml(vm, env){
  const { bishop, workspace, materialRows, deformationMaterialRows, hsMaterialTableHtml, permeabilityRows } = vm;
  const { STAGE6_ENABLE_HARDENING_SOIL_UI } = env;
  return workspace === 'seepage' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Permeability</div>
      <div class="st6-help">Each Bishop material carries seepage permeability. Editing either value marks that material as a user override.</div>
      <div class="st6-canvas-table-wrap">
        <table class="tbl st6-bishop-materials">
          <thead><tr><th>Material</th><th>k_x (m/s)</th><th>k_y (m/s)</th><th>Source</th><th></th></tr></thead>
          <tbody>${permeabilityRows}</tbody>
        </table>
      </div>
    </div>
  ` : workspace === 'deformation' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Deformation materials</div>
      <div class="st6-canvas-table-wrap">
        <table class="tbl st6-bishop-materials st6-bishop-materials--deformation">
          <colgroup>
            <col class="st6-mat-col-layer">
            <col class="st6-mat-col-emc">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
          </colgroup>
          <thead><tr><th>Layer</th><th>E_mc (kPa)</th><th>ν</th><th>K0</th><th>r_shear</th><th>c'</th><th>phi'</th><th>psi</th></tr></thead>
          <tbody>${deformationMaterialRows}</tbody>
        </table>
      </div>
      ${STAGE6_ENABLE_HARDENING_SOIL_UI ? hsMaterialTableHtml : ''}
    </div>
  ` : `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Stability materials</div>
      <div class="st6-help">The current imported material set is <strong>${stage6BishopStrengthSetLabel(bishop.strengthSet)}</strong>.</div>
      <div class="st6-canvas-table-wrap">
        <table class="tbl st6-bishop-materials">
          <thead><tr><th>Layer</th><th>c'</th><th>phi'</th><th>gamma</th><th>gamma_sat</th></tr></thead>
          <tbody>${materialRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

/** Workspace: the info card, the geometry section and the settings groups. */
export function workspaceSheetHtml(vm, env, fragments){
  const { workspaceGeometrySectionHtml, workspaceSettingsHtml, workspaceInfoHtml } = fragments;
  return `
    <div class="st6-canvas-sheet-grid">
      ${workspaceInfoHtml}
      ${workspaceGeometrySectionHtml}
      ${workspaceSettingsHtml}
    </div>
  `;
}

/** Reset: the nine clear actions. */
export function resetSheetHtml(vm, env){
  const { measurementPoints } = vm;
  return `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Reset geometry and overlays</div>
      <div class="st6-help">These actions clear drawn data from the shared Stage 6 section. They do not delete interpreted CPT layers.</div>
      <div class="st6-bishop-mini-actions">
        <button class="btn sm" onclick="stage6BishopClear('terrain')">Clear terrain</button>
        <button class="btn sm" onclick="stage6BishopClear('phreatic')">Clear phreatic</button>
        <button class="btn sm" onclick="stage6BishopClear('walls')">Clear walls</button>
        <button class="btn sm" onclick="stage6BishopClear('drains')">Clear drains</button>
        <button class="btn sm" onclick="stage6BishopClear('entry')">Clear entry</button>
        <button class="btn sm" onclick="stage6BishopClear('exit')">Clear exit</button>
        <button class="btn sm" onclick="stage6BishopClear('load')">Clear load</button>
        <button class="btn sm" onclick="stage6BishopClear('measure')" ${measurementPoints.length ? '' : 'disabled'}>Clear measure</button>
        <button class="btn sm" onclick="stage6BishopClear('customRegions')">Clear custom polygons</button>
      </div>
    </div>
  `;
}

/** Analysis: the analysis sheet, or the workspace summary as a fallback. */
export function probeSheetHtml(vm, env, fragments){
  const { workspaceInfoHtml, analysisSheetHtml } = fragments;
  return analysisSheetHtml || `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Workspace summary</div>
      ${workspaceInfoHtml}
    </div>
  `;
}

/** The sheet lookup the tool rail indexes with `ui.bishopActiveCanvasSheet`. */
export function canvasSheets(vm, env, fragments){
  const { viewSectionHtml, structuresSheetHtml, boundarySheetHtml, regionsSheetHtml, materialsSheetHtml, workspaceSheetHtml, resetSheetHtml, probeSheetHtml } = fragments;
  return {
    structures:structuresSheetHtml,
    boundary:boundarySheetHtml,
    regions:regionsSheetHtml,
    view:viewSectionHtml,
    materials:materialsSheetHtml,
    workspace:workspaceSheetHtml,
    reset:resetSheetHtml,
    probe:probeSheetHtml
  };
}
