// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/tool-rail.js — the floating canvas dock: three tool groups, the seven cards
// they open and the eight sheets of ./sheets.js (refactor step 9f, map §2.11 "Canvas tool rail").
// Moved verbatim out of legacy-controller.js:
//   stage6BishopWallInfoPanelHtml  4566-4615 → wallInfoPanelHtml(bishop, env)   (its `S` read is the parameter)
//   stage6BishopCanvasToolRailHtml 4742-5248 → canvasToolRailHtml(context, env)
// The rail owns two more `data-st6details` groups — `bishop-view-quick-snap` and
// `bishop-view-quick-layers` — which are its View card's own mini-details, not settings-column
// sections, so they stay here with the card that draws them.
import { compactNumber as stage6CompactNumber, escAttr as stage6EscAttr, escJsString as stage6EscJsString } from '../../core/format.js';
import { drainHeadValueAt } from '../../seepage/drains';
import { wallLength } from '../../wall-geometry.js';
import { effectiveSurfaceLoadQ as effectiveSurfaceLoadQOf, normalizeRegionCoarseness as stage6BishopNormalizeRegionCoarseness, surfaceLoadSummary as surfaceLoadSummaryOf, validZone as stage6BishopValidZone } from '../state/index.js';
import { canvasToolButton as stage6BishopCanvasToolButton, toolIcon as stage6BishopToolIcon } from './icons.js';
import { partialLoadBadgeHtml as stage6BishopPartialLoadBadgeHtml, wallMechanicalLabel as stage6BishopWallMechanicalLabel } from './labels.js';

export function wallInfoPanelHtml(bishop, env){
  const { stage6BishopWallResultSeries, stage6BishopSelectedWallResult } = env;
  const wall = (bishop?.walls || []).find((item)=>item.id === bishop.selectedWallId);
  if(!wall) return '';
  const wallIndex = (bishop.walls || []).findIndex((item)=>item.id === wall.id);
  const wallResult = stage6BishopSelectedWallResult();
  const series = wallResult ? stage6BishopWallResultSeries(wallResult) : null;
  const maxAbs = (values)=>Math.max(0, ...(values || []).map((value)=>Math.abs(Number(value) || 0)));
  const maxM = series ? maxAbs(series.MPassive) : 0;
  const maxV = series ? maxAbs(series.VPassive) : 0;
  const maxN = series ? maxAbs(series.N) : 0;
  const maxW = series ? maxAbs(series.wPassive) : 0;
  const maxTheta = series ? maxAbs(series.thetaPassive) : 0;
  const idxMaxM = series?.MPassive?.findIndex((value)=>Math.abs(Number(value) || 0) === maxM) ?? -1;
  const wallIdArg = stage6EscJsString(wall.id);
  return `
    <div class="st6-canvas-card-section st6-canvas-card--wall-info">
      <div class="st6-canvas-card-kicker">Selected retaining wall</div>
      <div class="st6-canvas-card-note">
        Wall ${wallIndex + 1} · ${stage6EscAttr(wall.material?.label || wall.id)}
        <br>Length ${wallLength(wall).toFixed(2)} m · passive ${stage6EscAttr(wall.passiveSide)}
        <br>${stage6EscAttr(stage6BishopWallMechanicalLabel(wall))}
      </div>
      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
        <button type="button" class="st6-canvas-tool ${wall.mechanicalActive === true ? 'active' : ''}" onclick="stage6BishopSetWallField(${wallIndex}, 'mechanicalActive', ${wall.mechanicalActive === true ? 'false' : 'true'})">
          ${stage6BishopToolIcon('wall')}<span>${wall.mechanicalActive === true ? 'Mechanical active' : 'Activate mechanical'}</span>
        </button>
        <button type="button" class="st6-canvas-tool ${bishop.deformation?.display?.showWallMomentOverlay === true ? 'active' : ''}" onclick="stage6BishopToggleWallMomentOverlay()">
          ${stage6BishopToolIcon('chart')}<span>${bishop.deformation?.display?.showWallMomentOverlay === true ? 'Hide overlay' : 'Show overlay'}</span>
        </button>
      </div>
      ${series ? `
        ${stage6BishopPartialLoadBadgeHtml(bishop.deformation?.result?.solver)}
        <div class="st6-canvas-card-note">
          Max |N| ${stage6CompactNumber(maxN, 3)} kN/m ·
          Max |V| ${stage6CompactNumber(maxV, 3)} kN/m ·
          Max |M| ${stage6CompactNumber(maxM, 3)} kN·m/m${idxMaxM >= 0 ? ` at s ${stage6CompactNumber(series.sNode[idxMaxM] || 0, 3)} m` : ''}
          <br>Max |w| ${(1000 * maxW).toFixed(2)} mm · Max |θ| ${(1000 * maxTheta).toFixed(3)} mrad
          <br><span style="color:var(--tx2)">Canvas overlays are normalized to a fixed amplitude at the diagram maximum — small (but nonzero) values plot close to the wall line; station dots mark every data point, and exact values are in Analysis → Structure / Copy data.</span>
        </div>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          <button type="button" class="st6-canvas-tool" onclick="stage6BishopOpenAnalysisTab('structure', ${wallIdArg})">${stage6BishopToolIcon('chart')}<span>Open Analysis</span></button>
          <button type="button" class="st6-canvas-tool" onclick="stage6BishopCopyWallData(${wallIdArg})">${stage6BishopToolIcon('copy')}<span>Copy data</span></button>
        </div>
      ` : `
        <div class="st6-canvas-card-note">Run deformation with this wall mechanically active, then open Analysis → Structure to inspect N, V, M, w, and theta diagrams.</div>
      `}
    </div>
  `;
}

export function canvasToolRailHtml(context, env){
  const { STAGE6_ENABLE_HARDENING_SOIL_UI, STAGE6_WALL_RESPONSE_QUANTITIES, stage6DetailsOpen, stage6MaxDepth, stage6ActiveBishop, stage6BishopUiState, stage6BishopSeepageEdgeLabel, stage6BishopAnalysisWallId, stage6BishopWallResultForId, stage6BishopWallQuantityStats, stage6BishopWallQuantityFormat, stage6BishopWallOverlayQuantity, stage6BishopSeepageContourOptions, stage6BishopDeformationContourOptions } = env;
  const ui = stage6BishopUiState();
  const bishop = context?.bishop || stage6ActiveBishop();
  const stage6BishopEffectiveSurfaceLoadQ = (load, ws = bishop?.workspace || 'stability')=>effectiveSurfaceLoadQOf(bishop, load, ws);
  const stage6BishopSurfaceLoadSummary = (load, ws = bishop?.workspace || 'stability')=>surfaceLoadSummaryOf(bishop, load, ws);
  const workspace = context?.workspace || 'stability';
  const model = context?.model || null;
  const selectedCustomRegion = context?.selectedCustomRegion || null;
  const selectedSeepageEdge = context?.selectedSeepageEdge || null;
  const selectedSeepageBc = context?.selectedSeepageBc || null;
  const selectedDrainIndex = (bishop.drains || []).findIndex((drain)=>drain.id === bishop.selectedDrainId);
  const selectedDrain = selectedDrainIndex >= 0 ? bishop.drains[selectedDrainIndex] : null;
  const pendingWallActivationCount = (bishop.walls || []).filter((wall)=>wall.mechanicalActivationPromptPending === true).length;
  const isHidden = ui.bishopCanvasToolsHidden === true;
  const activePanel = ui.bishopActiveCanvasPanel === 'view' ? '' : (ui.bishopActiveCanvasPanel || '');
  const activeSheet = ui.bishopActiveCanvasSheet || '';
  if(isHidden){
    return `
      <button type="button" class="st6-canvas-tools-restore" onclick="stage6BishopToggleCanvasTools(true)" title="Show canvas tools" aria-label="Show canvas tools">
        ${stage6BishopToolIcon('settings')}
      </button>
    `;
  }
  const toolButton = (id, label, icon, disabled = false)=>stage6BishopCanvasToolButton({
    label,
    icon,
    active:bishop.tool === id,
    disabled,
    onclick:`stage6BishopSetTool('${id}')`
  });
  const actionButton = (label, icon, onclick, disabled = false, tone = '')=>stage6BishopCanvasToolButton({
    label,
    icon,
    disabled,
    onclick,
    tone
  });
  const panelButton = (id, label, icon)=>stage6BishopCanvasToolButton({
    label,
    icon,
    active:activePanel === id && !activeSheet,
    onclick:`stage6BishopSetCanvasPanel('${id}')`
  });
  const sheetButton = (id, label, icon)=>stage6BishopCanvasToolButton({
    label,
    icon,
    active:activeSheet === id,
    onclick:`stage6BishopSetCanvasSheet('${id}')`
  });
  const hasDraft = !!bishop.draft?.length;
  const finishDraftEnabled = (
    (bishop.draftKind === 'terrain' || bishop.draftKind === 'phreatic') && bishop.draft.length >= 2
  ) || (
    bishop.draftKind === 'drain' && bishop.draft.length >= 2
  ) || (
    (bishop.draftKind === 'region' || bishop.draftKind === 'regionHole') && bishop.draft.length >= 3
  );
  const loadQ = Number(context?.loadQ || 0);
  const surfaceLoads = bishop.surfaceLoads || [];
  const selectedSurfaceLoad = (surfaceLoads || []).find((load)=>load.id === bishop.selectedSurfaceLoadId) || null;
  const primarySurfaceLoad = selectedSurfaceLoad
    || surfaceLoads.find((load)=>load.active !== false)
    || surfaceLoads[0]
    || null;
  const selectedLoadWidth = stage6BishopValidZone(selectedSurfaceLoad)
    ? Math.max(selectedSurfaceLoad.xEnd - selectedSurfaceLoad.xStart, 0)
    : 0;
  const surfaceLoadRows = surfaceLoads.map((load, index)=>{
    const selected = load.id === bishop.selectedSurfaceLoadId;
    const q = stage6BishopEffectiveSurfaceLoadQ(load, workspace);
    const loadIdArg = stage6EscJsString(load.id);
    return `
      <div class="st6-canvas-card-row" style="gap:6px;align-items:center">
        <button type="button" class="st6-canvas-tool ${selected ? 'active' : ''}" style="flex:1;justify-content:flex-start" onclick="stage6BishopSelectSurfaceLoad(${loadIdArg})" title="${stage6EscAttr(stage6BishopSurfaceLoadSummary(load, workspace))}">
          ${stage6BishopToolIcon('load')}
          <span>${stage6EscAttr(load.label || `Load ${index + 1}`)}</span>
        </button>
        <button type="button" class="st6-canvas-tool ${load.active !== false ? 'active' : ''}" style="width:36px;flex:0 0 36px" onclick="stage6BishopSetSurfaceLoadField(${loadIdArg}, 'active', ${load.active === false ? 'true' : 'false'})" title="${load.active === false ? 'Enable load' : 'Disable load'}" aria-label="${load.active === false ? 'Enable load' : 'Disable load'}">
          ${stage6BishopToolIcon(load.active === false ? 'eyeOff' : 'play')}
        </button>
        <span style="font-size:11px;color:var(--tx2);min-width:54px;text-align:right">${q.toFixed(1)} kPa</span>
      </div>
    `;
  }).join('');
  const selectedLoadIdArg = selectedSurfaceLoad ? stage6EscJsString(selectedSurfaceLoad.id) : '""';
  const selectedSurfaceLoadEditor = selectedSurfaceLoad ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Selected load</div>
      <label class="st6-canvas-check">
        <input type="checkbox" ${selectedSurfaceLoad.active === false ? '' : 'checked'} onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'active', this.checked)">
        Active in current model
      </label>
      <label>Label
        <input type="text" value="${stage6EscAttr(selectedSurfaceLoad.label || selectedSurfaceLoad.id)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'label', this.value)">
      </label>
      <label>Load input
        <select onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'loadMode', this.value)">
          <option value="pressure"${selectedSurfaceLoad.loadMode !== 'total' ? ' selected' : ''}>Pressure q (kPa)</option>
          <option value="total"${selectedSurfaceLoad.loadMode === 'total' ? ' selected' : ''}>Total load (kN)</option>
        </select>
      </label>
      ${selectedSurfaceLoad.loadMode === 'total' ? `
        <label>Total load (kN)
          <input type="number" step="1" min="0" value="${Number(selectedSurfaceLoad.totalLoad || 0).toFixed(1)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'totalLoad', this.value)">
        </label>
      ` : `
        <label>Pressure q (kPa)
          <input type="number" step="1" min="0" value="${Number(selectedSurfaceLoad.q || 0).toFixed(1)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'q', this.value)">
        </label>
      `}
      <div class="st6-canvas-card-grid">
        <label>x start (m)
          <input type="number" step="0.1" value="${Number(selectedSurfaceLoad.xStart ?? 0).toFixed(2)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'xStart', this.value)">
        </label>
        <label>x end (m)
          <input type="number" step="0.1" value="${Number(selectedSurfaceLoad.xEnd ?? 0).toFixed(2)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'xEnd', this.value)">
        </label>
      </div>
      <div class="st6-canvas-card-note">Width ${selectedLoadWidth.toFixed(2)} m · effective q ${stage6BishopEffectiveSurfaceLoadQ(selectedSurfaceLoad, workspace).toFixed(2)} kPa</div>
      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
        ${actionButton('Delete load', 'reset', `stage6BishopDeleteSurfaceLoad(${selectedLoadIdArg})`, false, 'danger')}
      </div>
    </div>
  ` : '';
  const seepage = bishop.seepage || {};
  const seepageMeshTargetArea = Number(context?.seepageMeshTargetArea || 0);
  const seepageUsesIterativeFreeSurface = seepage.options?.freeSurface === 'iterate';
  const viewSeepageContourOptions = stage6BishopSeepageContourOptions();
  const viewSeepageContourMode = bishop.seepage?.display?.contourMode || 'head';
  const viewDeformationAnalysisType = bishop.deformation?.options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const viewDeformationHasHs = STAGE6_ENABLE_HARDENING_SOIL_UI && bishop.deformation?.result?.hasHardeningSoil === true;
  const viewDeformationContourOptions = stage6BishopDeformationContourOptions(viewDeformationAnalysisType, viewDeformationHasHs);
  const viewDeformationContourMode = bishop.deformation?.display?.contourMode || 'uTotal';
  const deformationShowWallOverlay = bishop.deformation?.display?.showWallMomentOverlay === true;
  const wallOverlayQuantity = stage6BishopWallOverlayQuantity();
  const wallOverlayStats = stage6BishopWallQuantityStats(
    stage6BishopWallResultForId(stage6BishopAnalysisWallId()),
    wallOverlayQuantity
  );
  const wallOverlayStatsLabel = wallOverlayStats
    ? `min ${stage6BishopWallQuantityFormat(wallOverlayStats.min, wallOverlayStats.meta)} · max ${stage6BishopWallQuantityFormat(wallOverlayStats.max, wallOverlayStats.meta)}`
    : 'Run deformation and hover a wall to inspect min/max.';
  const draftRegionMaterialId = bishop.regionDraftMaterialId || bishop.materials?.[0]?.id || '';
  const selectedRegionMaterialId = selectedCustomRegion?.materialId || draftRegionMaterialId;
  const draftMaterialOptions = (bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${draftRegionMaterialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('');
  const selectedMaterialOptions = (bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${selectedRegionMaterialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('');
  const panelTitle = {
    draw:'Draw',
    structures:'Structures',
    boundary:'Boundary conditions',
    regions:'Regions',
    view:'View',
    solve:'Solve',
    reset:'Reset'
  }[activePanel] || '';
  const sheetTitle = {
    structures:'Structure Settings',
    boundary:'Boundary Conditions',
    regions:'Region Settings',
    view:'View Settings',
    materials:'Materials',
    workspace:workspace === 'seepage' ? 'Seepage Settings' : workspace === 'deformation' ? 'Deformation Settings' : 'Stability Settings',
    reset:'Reset Geometry',
    probe:'Analysis'
  }[activeSheet] || '';
  const draftActions = hasDraft ? `
    <div class="st6-canvas-card-row st6-canvas-card-row--actions">
      ${actionButton('Finish draft', 'finish', 'stage6BishopFinishDraft()', !finishDraftEnabled)}
      ${actionButton('Undo point', 'undo', 'stage6BishopPopDraftPoint()')}
      ${actionButton('Clear draft', 'clear', "stage6BishopClear('draft')", false, 'danger')}
    </div>
  ` : '';
  const drawPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Section drawing</div>
      <div class="st6-canvas-card-grid">
        ${toolButton('terrain', 'Terrain', 'terrain')}
        ${actionButton('Import DXF', 'import', 'stage6BishopTriggerDxfImport()')}
        ${toolButton('cpt', 'Place CPT', 'cpt')}
        ${toolButton('phreatic', 'Phreatic line', 'phreatic')}
        ${toolButton('measure', 'Measure', 'measure')}
        ${toolButton('edit', 'Edit / pan', 'pointer')}
      </div>
      ${draftActions}
    </div>
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">CPT placement</div>
      <label>Insertion offset vs terrain (m)
        <input type="number" step="0.1" value="${(Number(bishop.cptInsertionOffset) || 0).toFixed(2)}" onchange="stage6BishopSetField('cptInsertionOffset', this.value)"${Number.isFinite(bishop.activeCptX) ? '' : ' disabled'}>
      </label>
      <div class="st6-canvas-card-note">${Number.isFinite(bishop.activeCptX)
        ? 'Positive lifts the CPT start above the terrain (shallow readings clip at the ground); negative sinks it below, and the top layer is extrapolated up to the terrain.'
        : 'Place the CPT to enable a vertical insertion offset.'}</div>
    </div>
  `;
	  const structuresPanel = `
	    <div class="st6-canvas-card-section">
	      <div class="st6-canvas-card-kicker">Structure tools</div>
      <div class="st6-canvas-card-grid">
        ${toolButton('wall', 'Retaining wall', 'wall')}
        ${toolButton('drain', 'Drain line', 'drain', !model)}
        ${toolButton('load', 'Load zone', 'load')}
        ${toolButton('entry', 'Entry zone', 'entry')}
        ${toolButton('exit', 'Exit zone', 'exit')}
      </div>
    </div>
      ${pendingWallActivationCount ? `
        <div class="st6-canvas-card-section">
          <div class="st6-canvas-card-kicker">Legacy wall activation</div>
          <div class="st6-canvas-card-note">${pendingWallActivationCount} existing retaining wall${pendingWallActivationCount === 1 ? '' : 's'} opened from older project data. They stay inactive in deformation until you opt in.</div>
          <div class="st6-canvas-card-row st6-canvas-card-row--actions">
            <button type="button" class="st6-canvas-tool" onclick="stage6BishopResolveWallMechanicalActivation(true)">${stage6BishopToolIcon('wall')}<span>Activate</span></button>
            <button type="button" class="st6-canvas-tool" onclick="stage6BishopResolveWallMechanicalActivation(false)">${stage6BishopToolIcon('close')}<span>Keep inactive</span></button>
          </div>
        </div>
      ` : ''}
	    ${wallInfoPanelHtml(bishop, env)}
	    <div class="st6-canvas-card-section">
	      <div class="st6-canvas-card-kicker">Quick settings</div>
	      <label>${primarySurfaceLoad ? `Quick q for ${stage6EscAttr(primarySurfaceLoad.label || primarySurfaceLoad.id)}` : 'Default surface load q'} (kPa)
	        <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
	      </label>
	      <div class="st6-canvas-card-note">Use Load zone to draw another strip. Click a strip in Edit / pan to select and edit it.</div>
	      ${selectedDrain ? `
        <label>Selected drain head h (m)
          <input type="number" step="0.05" value="${Number(drainHeadValueAt(selectedDrain, 0) || 0).toFixed(2)}" onchange="stage6BishopSetDrainField(${selectedDrainIndex}, 'head', this.value)">
        </label>
        <label>Drain gating
          <select onchange="stage6BishopSetDrainField(${selectedDrainIndex}, 'gating', this.value)">
            <option value="always"${selectedDrain.gating==='always'?' selected':''}>Always</option>
            <option value="when-saturated"${selectedDrain.gating==='when-saturated'?' selected':''}>When saturated</option>
            <option value="head-cap"${selectedDrain.gating==='head-cap'?' selected':''}>Head cap</option>
          </select>
        </label>
      ` : '<div class="st6-canvas-card-note">Select or draw a drain to edit head and gating here.</div>'}
	      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
	        ${actionButton('Manage structures', 'wall', "stage6BishopSetCanvasSheet('structures')")}
	        ${actionButton('Reset tools', 'reset', "stage6BishopSetCanvasSheet('reset')")}
	      </div>
	    </div>
	    <div class="st6-canvas-card-section">
	      <div class="st6-canvas-card-kicker">Surface loads</div>
	      ${surfaceLoadRows || '<div class="st6-canvas-card-note">No loads yet. Select Load zone, then click two terrain points.</div>'}
	    </div>
	    ${selectedSurfaceLoadEditor}
	  `;
  const boundaryPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Boundary assignment</div>
      <div class="st6-canvas-card-grid">
        ${toolButton('seepageBc', 'Assign BC', 'boundary', !model || workspace !== 'seepage')}
        ${toolButton('edit', 'Edit / pan', 'pointer')}
      </div>
      ${workspace !== 'seepage' ? '<div class="st6-canvas-card-note">Boundary conditions are available in the Seepage workspace.</div>' : ''}
    </div>
    ${workspace === 'seepage' ? `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Selected edge</div>
        ${selectedSeepageEdge ? `
          <div class="st6-canvas-card-note">${stage6EscAttr(stage6BishopSeepageEdgeLabel(selectedSeepageEdge))} · ${selectedSeepageEdge.length.toFixed(2)} m</div>
          <label>Boundary type
            <select onchange="stage6BishopSetSeepageBcType(this.value)">
              <option value="no-flow"${(selectedSeepageBc?.type || 'no-flow')==='no-flow'?' selected':''}>No-flow</option>
              <option value="head"${selectedSeepageBc?.type==='head'?' selected':''}>Prescribed head</option>
              <option value="seepage-face"${selectedSeepageBc?.type==='seepage-face'?' selected':''}>Seepage face</option>
            </select>
          </label>
          ${(selectedSeepageBc?.type || 'no-flow') === 'head' ? `
            <label>Head h (m elevation)
              <input type="number" step="0.05" value="${Number(selectedSeepageBc?.head ?? selectedSeepageEdge.mid.y).toFixed(2)}" onchange="stage6BishopSetSeepageBcHead(this.value)">
            </label>
          ` : ''}
          <div class="st6-canvas-card-row st6-canvas-card-row--actions">
            ${actionButton('Remove BC', 'clear', `stage6BishopDeleteSeepageBc('${stage6EscAttr(selectedSeepageEdge.edgeKey)}')`, false, 'danger')}
            ${actionButton('BC table', 'boundary', "stage6BishopSetCanvasSheet('boundary')")}
          </div>
        ` : '<div class="st6-canvas-card-note">Click Assign BC, then choose an outer boundary edge.</div>'}
      </div>
    ` : ''}
  `;
  const regionsPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Region tools</div>
      <div class="st6-canvas-card-grid">
        ${actionButton('Copy CPT regions', 'copy', 'stage6BishopCopyCurrentRegionsToCustom()', !model)}
        ${actionButton('Export to DXF', 'download', 'stage6BishopExportRegionsDxf()', !model)}
        ${toolButton('region', 'Draw polygon', 'polygon', !model)}
        ${toolButton('regionHole', 'Cut hole', 'cut', !selectedCustomRegion)}
        ${toolButton('regionSplit', 'Split polygon', 'split', !selectedCustomRegion)}
      </div>
    </div>
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Region settings</div>
      <label>Material for new polygons
        <select onchange="stage6BishopSetField('regionDraftMaterialId', this.value)">${draftMaterialOptions}</select>
      </label>
      ${selectedCustomRegion ? `
        <label>Selected material
          <select onchange="stage6BishopSetSelectedRegionMaterial(this.value)">${selectedMaterialOptions}</select>
        </label>
        <label>Selected coarseness
          <input type="number" min="0.01" step="0.1" value="${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness)}" onchange="stage6BishopSetSelectedRegionCoarseness(this.value)">
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Delete selected', 'clear', 'stage6BishopDeleteSelectedRegion()', false, 'danger')}
        </div>
      ` : '<div class="st6-canvas-card-note">Select a custom polygon to edit its material and mesh coarseness.</div>'}
    </div>
  `;
  const viewDisplayQuantityPanel = workspace === 'seepage' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Display quantity</div>
      <label>Canvas contours
        <select onchange="stage6BishopSetField('seepage.display.contourMode', this.value)">
          ${viewSeepageContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${viewSeepageContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
        </select>
      </label>
    </div>
  ` : workspace === 'deformation' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Display quantity</div>
      <label>Canvas contours
        <select onchange="stage6BishopSetField('deformation.display.contourMode', this.value)">
          ${viewDeformationContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${viewDeformationContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
        </select>
      </label>
    </div>
  ` : '';
  const viewPanel = `
    ${viewDisplayQuantityPanel}
    <details class="st6-canvas-card-section st6-canvas-mini-details" data-st6details="bishop-view-quick-snap"${stage6DetailsOpen('bishop-view-quick-snap')}>
      <summary>Snap</summary>
      <div class="st6-canvas-mini-details-body">
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.gridSnap?'checked':''} onchange="stage6BishopSetField('gridSnap', this.checked)"> Snap to grid</label>
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.pointSnap?'checked':''} onchange="stage6BishopSetField('pointSnap', this.checked)"> Snap to points</label>
        <label>Grid size (m)
          <input type="number" step="0.05" min="0.05" value="${bishop.snapSize.toFixed(2)}" onchange="stage6BishopSetField('snapSize', this.value)">
        </label>
      </div>
    </details>
    <details class="st6-canvas-card-section st6-canvas-mini-details" data-st6details="bishop-view-quick-layers"${stage6DetailsOpen('bishop-view-quick-layers')}>
      <summary>Canvas layers</summary>
      <div class="st6-canvas-mini-details-body">
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.display?.showRegions !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegions', this.checked)"> Soil polygons</label>
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.display?.showRegionLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLabels', this.checked)"> Polygon labels</label>
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.display?.showRegionLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLegend', this.checked)"> Polygon legend</label>
        ${workspace === 'seepage' ? `
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showBoundaryConditions !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showBoundaryConditions', this.checked)"> Boundary conditions</label>
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showDrains !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showDrains', this.checked)"> Drains</label>
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showFlowVectors ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showFlowVectors', this.checked)"> Flow lines</label>
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showExitGradient ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showExitGradient', this.checked)"> Exit gradient</label>
        ` : ''}
        ${workspace === 'deformation' ? `
          <label class="st6-canvas-check"><input type="checkbox" ${deformationShowWallOverlay ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showWallMomentOverlay', this.checked)"> Wall result overlay</label>
          <label>Wall overlay quantity
            <select onchange="stage6BishopSetField('deformation.display.wallOverlayQuantity', this.value)" title="${stage6EscAttr(wallOverlayStatsLabel)}">
              ${STAGE6_WALL_RESPONSE_QUANTITIES.map((option)=>`<option value="${stage6EscAttr(option.id)}"${wallOverlayQuantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
            </select>
          </label>
        ` : ''}
      </div>
    </details>
    <div class="st6-canvas-card-row st6-canvas-card-row--actions">
      ${actionButton('Detailed view', 'layers', "stage6BishopOpenSettingsDetail('bishop-geo-view')")}
      ${actionButton('Fit view', 'fit', 'fitStage6BishopViewport()')}
    </div>
  `;
  const solvePanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">${workspace === 'seepage' ? 'Seepage solve' : workspace === 'deformation' ? 'Deformation solve' : 'Stability solve'}</div>
      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
        ${actionButton(context?.toolbarRunLabel || 'Run', 'play', context?.toolbarRunAction || 'stage6BishopRunSearch()', !context?.toolbarRunReady)}
        ${actionButton('Stop', 'stop', context?.toolbarStopAction || 'stage6BishopStopSearch();renderStage6()', !context?.toolbarRunning)}
        ${actionButton(context?.toolbarClearLabel || 'Clear result', 'clear', context?.toolbarClearAction || "stage6BishopClear('results')", !context?.toolbarHasResult)}
      </div>
      <div class="st6-canvas-card-note">${stage6EscAttr(context?.toolbarProgressText || '')}</div>
    </div>
    ${workspace === 'seepage' ? `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Core settings</div>
        <label>Free-surface mode
          <select onchange="stage6BishopSetField('seepage.options.freeSurface', this.value)">
            <option value="iterate"${seepage.options?.freeSurface==='iterate'?' selected':''}>Iterative free surface</option>
            <option value="fixed"${seepage.options?.freeSurface==='fixed'?' selected':''}>Fixed phreatic line</option>
          </select>
        </label>
        <label class="st6-canvas-check"><input type="checkbox" ${seepage.options?.meshTargetAreaAuto !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.options.meshTargetAreaAuto', this.checked)"> Auto mesh size</label>
        <label>Target area (m²)
          <input type="number" step="0.01" min="0.01" value="${Number(seepageMeshTargetArea || 0).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.meshTargetArea', this.value)">
        </label>
        <label>Flow error target (%)
          <input type="number" step="0.01" min="0.0001" value="${(100 * Math.max(Number(seepage.options?.flowErrorTolerance) || 0.01, 0.000001)).toFixed(3)}" onchange="stage6BishopSetField('seepage.options.flowErrorTolerance', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
        </label>
        <label>Runtime cap (s)
          <input type="number" step="0.1" min="0.1" value="${(Math.max(Number(seepage.options?.maxRuntimeMs) || 10000, 1) / 1000).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.maxRuntimeMs', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Materials', 'materials', "stage6BishopSetCanvasSheet('materials')")}
          ${actionButton('Advanced solve', 'settings', "stage6BishopSetCanvasSheet('workspace')")}
        </div>
      </div>
    ` : workspace === 'stability' ? `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Core settings</div>
        <label>Strength set
          <select onchange="stage6BishopSetField('strengthSet', this.value)">
            <option value="characteristic"${bishop.strengthSet==='characteristic'?' selected':''}>Characteristic</option>
            <option value="da1_1"${bishop.strengthSet==='da1_1'?' selected':''}>DA1/1 (M1)</option>
            <option value="da1_2"${bishop.strengthSet==='da1_2'?' selected':''}>DA1/2 (M2)</option>
          </select>
        </label>
        <label>Method
          <select onchange="stage6BishopSetField('methodMode', this.value)">
            <option value="bishop_spencer"${bishop.methodMode==='bishop_spencer'?' selected':''}>Bishop + Spencer</option>
            <option value="bishop_only"${bishop.methodMode==='bishop_only'?' selected':''}>Bishop only</option>
          </select>
        </label>
        <label>Surface load q (kPa)
          <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
        </label>
        <label>Analysis depth (m)
          <input type="number" step="0.5" min="${Math.max(stage6MaxDepth(), 15).toFixed(2)}" value="${bishop.analysisDepth.toFixed(2)}" onchange="stage6BishopSetField('analysisDepth', this.value)">
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Search settings', 'settings', "stage6BishopSetCanvasSheet('workspace')")}
          ${actionButton('Materials', 'materials', "stage6BishopSetCanvasSheet('materials')")}
        </div>
      </div>
    ` : `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Core settings</div>
        <label>Analysis mode
          <select onchange="stage6BishopSetField('deformation.options.analysisType', this.value)">
            <option value="deformation"${bishop.deformation?.options?.analysisType!=='safety-cphi'?' selected':''}>Deformation</option>
            <option value="safety-cphi"${bishop.deformation?.options?.analysisType==='safety-cphi'?' selected':''}>C-phi safety</option>
          </select>
        </label>
        <label>Surface load q (kPa)
          <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Mechanical inputs', 'settings', "stage6BishopSetCanvasSheet('workspace')")}
          ${actionButton('Materials', 'materials', "stage6BishopSetCanvasSheet('materials')")}
        </div>
      </div>
    `}
  `;
  const resetPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Clear drawn items</div>
      <div class="st6-canvas-card-grid">
        ${actionButton('Clear draft', 'clear', "stage6BishopClear('draft')", false, 'danger')}
        ${actionButton('Clear load', 'load', "stage6BishopClear('load')", false, 'danger')}
        ${actionButton('Clear drains', 'drain', "stage6BishopClear('drains')", false, 'danger')}
        ${actionButton('More reset', 'reset', "stage6BishopSetCanvasSheet('reset')", false, 'danger')}
      </div>
    </div>
  `;
  const panelBody = {
    draw:drawPanel,
    structures:structuresPanel,
    boundary:boundaryPanel,
    regions:regionsPanel,
    view:viewPanel,
    solve:solvePanel,
    reset:resetPanel
  }[activePanel] || '';
  const sheetBody = context?.canvasSheets?.[activeSheet] || '';
  return `
    <div class="st6-canvas-shell" aria-label="Canvas tools and settings">
      <div class="st6-canvas-dock" aria-label="Tool groups">
        <div class="st6-canvas-dock-group" aria-label="Model tools">
          ${panelButton('draw', 'Draw', 'terrain')}
          ${panelButton('structures', 'Structures', 'wall')}
          ${panelButton('boundary', 'Boundary conditions', 'boundary')}
          ${panelButton('regions', 'Regions', 'polygon')}
        </div>
        <div class="st6-canvas-dock-group" aria-label="Analysis tools">
          ${panelButton('solve', 'Solve', 'play')}
          ${sheetButton('workspace', 'Settings', 'settings')}
          ${sheetButton('materials', 'Materials', 'materials')}
          ${sheetButton('probe', 'Analysis', 'chart')}
        </div>
        <div class="st6-canvas-dock-group" aria-label="Utility tools">
          ${panelButton('reset', 'Reset', 'reset')}
          ${stage6BishopCanvasToolButton({label:'Hide canvas UI', icon:'eyeOff', onclick:'stage6BishopToggleCanvasTools(false)'})}
        </div>
      </div>
	      ${panelBody ? `
	        <div class="st6-canvas-card" role="dialog" aria-label="${stage6EscAttr(panelTitle)}">
          <div class="st6-canvas-card-head">
            <strong>${stage6EscAttr(panelTitle)}</strong>
            <button type="button" class="st6-canvas-card-close" onclick="stage6BishopSetCanvasPanel('')" aria-label="Close ${stage6EscAttr(panelTitle)}">${stage6BishopToolIcon('close')}</button>
          </div>
          <div class="st6-canvas-card-body" data-st6scroll-key="bishop-canvas-card-${stage6EscAttr(activePanel)}">${panelBody}</div>
	        </div>
	      ` : ''}
	      ${sheetBody ? `
        <div class="st6-canvas-sheet" role="dialog" aria-label="${stage6EscAttr(sheetTitle)}">
          <div class="st6-canvas-card-head">
            <strong>${stage6EscAttr(sheetTitle)}</strong>
            <button type="button" class="st6-canvas-card-close" onclick="stage6BishopSetCanvasSheet('')" aria-label="Close ${stage6EscAttr(sheetTitle)}">${stage6BishopToolIcon('close')}</button>
          </div>
          <div class="st6-canvas-sheet-body" data-st6scroll-key="bishop-canvas-sheet-${stage6EscAttr(activeSheet)}">${sheetBody}</div>
        </div>
      ` : ''}
    </div>
  `;
}
