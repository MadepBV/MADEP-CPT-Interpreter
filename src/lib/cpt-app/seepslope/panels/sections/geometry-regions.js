// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/geometry-regions.js — legacy-controller.js 8026-8081, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';
import { normalizeRegionCoarseness as stage6BishopNormalizeRegionCoarseness } from '../../state/index.js';

/** `bishop-geo-regions` — the custom soil-polygon editor. */
export function geometryRegionsSectionHtml(vm, env){
  const { bishop, selectedCustomRegion, customRegionCount, customModeActive, showingCustomRegionPreview, seepageMeshTargetArea } = vm;
  const { stage6DetailsOpen } = env;
  return `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-regions"${stage6DetailsOpen('bishop-geo-regions')}>
                <summary>Soil polygons</summary>
                <div class="st6-adv-body">
                  <div class="st6-help">Default Bishop still uses CPT-derived polygons. To edit them, first copy the current solver polygons into a custom set. After that you can draw additional polygons, select one in <strong>Edit / pan</strong>, drag its vertices, split it into smaller polygons, cut interior holes with a different material, assign one of the imported Bishop materials, and tune a polygon-specific seepage coarseness factor for local mesh refinement.</div>
                  ${showingCustomRegionPreview ? `<div class="st6-help">Custom polygons are visible for editing, but the solver is still using the CPT-derived polygon set until you enable the checkbox below.</div>` : ''}
                  <div class="st6-bishop-tool-grid">
                    <div class="st6-bishop-tool-group">
                      <div class="st6-bishop-tool-title">Create</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm" onclick="stage6BishopCopyCurrentRegionsToCustom()">Copy current polygons</button>
                        <button class="btn sm ${bishop.tool==='region'?'active':''}" onclick="stage6BishopSetTool('region')">Draw polygon</button>
                        <button class="btn sm" onclick="stage6BishopFinishDraft()" ${((bishop.draftKind==='region' || bishop.draftKind==='regionHole') && bishop.draft.length >= 3) ? '' : 'disabled'}>${bishop.draftKind==='regionHole' ? 'Finish hole' : 'Finish polygon'}</button>
                      </div>
                    </div>
                    <div class="st6-bishop-tool-group ${selectedCustomRegion ? '' : 'st6-bishop-tool-group-muted'}">
                      <div class="st6-bishop-tool-title">Selected polygon</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='regionHole'?'active':''}" onclick="stage6BishopSetTool('regionHole')" ${selectedCustomRegion ? '' : 'disabled'}>Cut hole</button>
                        <button class="btn sm ${bishop.tool==='regionSplit'?'active':''}" onclick="stage6BishopSetTool('regionSplit')" ${selectedCustomRegion ? '' : 'disabled'}>Split selected</button>
                        <button class="btn sm" onclick="stage6BishopDeleteSelectedRegion()" ${selectedCustomRegion ? '' : 'disabled'}>Delete selected</button>
                      </div>
                    </div>
                  </div>
                  <label class="st6-bishop-check">
                    <input type="checkbox" ${customModeActive ? 'checked' : ''} onchange="stage6BishopSetUseCustomRegions(this.checked)" ${customRegionCount ? '' : 'disabled'}>
                    Use custom polygons in the solver
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Material for new polygons
                    <select onchange="stage6BishopSetField('regionDraftMaterialId', this.value)">
                      ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${(bishop.regionDraftMaterialId || bishop.materials?.[0]?.id)===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
                    </select>
                  </label>
                  ${selectedCustomRegion ? `
                    <label style="font-size:11px;color:var(--tx2)">Selected polygon material
                      <select onchange="stage6BishopSetSelectedRegionMaterial(this.value)">
                        ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${selectedCustomRegion.materialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
                      </select>
                    </label>
                    <label style="font-size:11px;color:var(--tx2)">Selected polygon coarseness
                      <input
                        id="st6-bishop-selected-region-coarseness"
                        type="number"
                        min="0.01"
                        step="0.1"
                        value="${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness)}"
                        onchange="stage6BishopSetSelectedRegionCoarseness(this.value)"
                        onkeydown="if(event.key === 'Enter'){ event.preventDefault(); stage6BishopSetSelectedRegionCoarseness(this.value); this.blur(); }"
                      >
                    </label>
                    <div class="st6-help">When custom polygons are enabled in the solver, this scales only the seepage mesh inside the selected polygon. Effective local target area: <strong>${(stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness) * seepageMeshTargetArea).toFixed(3)} m²</strong> = coarseness <strong>${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness).toFixed(2)}</strong> × global target <strong>${seepageMeshTargetArea.toFixed(3)} m²</strong>.</div>
                    <div class="st6-help">Selected polygon: <strong>${stage6EscAttr(selectedCustomRegion.id)}</strong> · vertices <strong>${selectedCustomRegion.polygon.length}</strong> · source <strong>${selectedCustomRegion.source === 'cpt-copy' ? 'copied from CPT' : selectedCustomRegion.source === 'hole' ? 'hole cut' : selectedCustomRegion.source === 'edited' ? 'edited fragment' : 'custom drawn'}</strong></div>
                  ` : `
                    <div class="st6-help">${customRegionCount ? 'No custom polygon is selected. Click one in Edit / pan mode to edit it.' : 'No custom polygons yet. Copy the current solver polygons or draw a new polygon to start editing.'}</div>
                  `}
                </div>
              </details>`;
}
