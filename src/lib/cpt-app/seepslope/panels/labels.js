// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/labels.js — the small pure label and badge helpers of the Seep / Slope panels
// (refactor step 9f, map §2.11 "Result HTML / labels"). Moved verbatim out of legacy-controller.js:
//   stage6BishopStrengthSetLabel        4125-4129 → strengthSetLabel(key)
//   stage6DepthBandReportHtml           4135-4161 → depthBandReportHtml(report, title)
//   stage6BishopSeepageTerminationLabel 4363-4369 → seepageTerminationLabel(reason)
//   stage6BishopResultMethodLabel       4371-4376 → resultMethodLabel(result)
//   stage6BishopModeMeta                4389-4473 → modeMeta(bishop)   (its one `S` read is the parameter)
//   stage6BishopWallMechanicalLabel     4540-4547 → wallMechanicalLabel(wall)
//   stage6BishopPartialLoadBadgeHtml    4557-4564 → partialLoadBadgeHtml(solver)
// Nothing here reads `S`, the DOM or the clock.
import { compactNumber as stage6CompactNumber, escAttr as stage6EscAttr } from '../../core/format.js';
import { resolveWallMechanicalSection } from '../../seepage/material';

/** The material strength set behind the imported Bishop materials. */
export function strengthSetLabel(key){
  if(key === 'da1_1') return 'DA1/1 (M1 soil set)';
  if(key === 'da1_2') return 'DA1/2 (M2 soil set)';
  return 'Characteristic';
}

/** The plasticity depth-band bars of the deformation diagnostics group. */
export function depthBandReportHtml(report, title = 'Depth-band plasticity'){
  const bands = Array.isArray(report?.depthBands) ? report.depthBands.filter((band)=>Number(band?.count) > 0) : [];
  if(!bands.length) return '';
  const maxCount = Math.max(1, ...bands.map((band)=>Math.max(Number(band.plastic) || 0, Number(band.tension) || 0)));
  return `
    <div class="info st6-depth-band-report" style="background:var(--bg2);border-color:var(--bd2)">
      <strong>${stage6EscAttr(title)}</strong>
      ${bands.map((band)=>{
        const plastic = Number(band.plastic) || 0;
        const tension = Number(band.tension) || 0;
        const plasticWidth = Math.min(100, 100 * plastic / maxCount);
        const tensionWidth = Math.min(100, 100 * tension / maxCount);
        const tau95 = Number(band.tauOverStrength?.p95);
        return `
          <div class="st6-depth-band-row">
            <span>${stage6EscAttr(band.label)}</span>
            <div class="st6-depth-band-bars">
              <i style="width:${plasticWidth.toFixed(1)}%"></i>
              <b style="width:${tensionWidth.toFixed(1)}%"></b>
            </div>
            <em>${plastic}/${band.count} MC${tension ? `, ${tension} T` : ''}${Number.isFinite(tau95) ? `, τ/S p95 ${tau95.toFixed(2)}` : ''}</em>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/** Why the seepage solve stopped. */
export function seepageTerminationLabel(reason){
  if(!reason) return '—';
  if(reason === 'time-limit') return 'Stopped at runtime limit';
  if(reason === 'interrupted') return 'Interrupted by user';
  if(reason === 'fixed-boundary') return 'Solved with fixed phreatic boundary';
  return 'Converged on flow-rate error target';
}

/** Bishop / Spencer / fallback, for a search result row. */
export function resultMethodLabel(result){
  if(!result) return '—';
  if(result.method === 'spencer') return 'Spencer';
  if(result.spencerAttempted && !result.spencerConverged) return 'Seep/Slope (Spencer fallback)';
  return 'Seep/Slope';
}

/** The active tool's name and its one-line hint (the status card and the tool rail). */
export function modeMeta(bishop){
  if(bishop.tool === 'terrain'){
    return {
      label:'Terrain mode',
      hint:'Click terrain points from left to right, then press Finish draft to accept the terrain.'
    };
  }
  if(bishop.tool === 'phreatic'){
    return {
      label:'Phreatic mode',
      hint:'Click phreatic-line points from left to right, then press Finish draft to accept the line.'
    };
  }
  if(bishop.tool === 'region'){
    return {
      label:'Soil polygon mode',
      hint:'Click polygon vertices, then press Finish draft or right-click to close the polygon. New polygons use the selected material and switch Bishop to custom polygon mode.'
    };
  }
  if(bishop.tool === 'regionHole'){
    return {
      label:'Hole cut mode',
      hint:'Draw a closed polygon inside the selected custom polygon to create a material override there. The chosen material for new polygons will be used for the cutout.'
    };
  }
  if(bishop.tool === 'regionSplit'){
    return {
      label:'Split polygon mode',
      hint:'Click two points on the boundary of the selected custom polygon to split it into two polygons. Right-click cancels the current split draft.'
    };
  }
  if(bishop.tool === 'cpt'){
    return {
      label:'Place CPT mode',
      hint:'Click once on the terrain to place the active CPT marker used for the Bishop soil column.'
    };
  }
  if(bishop.tool === 'entry'){
    return {
      label:'Entry zone mode',
      hint:'Click the start and end of the entry zone on the terrain.'
    };
  }
  if(bishop.tool === 'exit'){
    return {
      label:'Exit zone mode',
      hint:'Click the start and end of the exit zone on the terrain.'
    };
  }
  if(bishop.tool === 'load'){
    return {
      label:'Load zone mode',
      hint:'Click the start and end of a uniform surcharge strip on the terrain. Set q below in kPa.'
    };
  }
  if(bishop.tool === 'wall'){
    return {
      label:'Retaining wall mode',
      hint:'Click the wall head, then click the wall tip. The wall can be vertical or inclined and stays shared by stability, seepage, and deformation.'
    };
  }
  if(bishop.tool === 'measure'){
    return {
      label:'Measure mode',
      hint:'Click two points in the shared canvas to measure the straight-line distance, horizontal delta, and vertical delta. A third click starts a new measurement.'
    };
  }
  if(bishop.tool === 'seepageBc'){
    return {
      label:'Boundary-condition mode',
      hint:'Click an outer-boundary edge to assign a seepage boundary condition. Only the terrain, model base, and the two side boundaries can carry seepage BCs.'
    };
  }
  if(bishop.tool === 'drain'){
    return {
      label:'Drain mode',
      hint:'Click the drain start point, then click the end point. The new drain is selected so you can set its head.'
    };
  }
  return {
    label:'Edit / pan mode',
    hint:'Drag terrain or phreatic vertices, retaining-wall ends, the CPT marker, zone ends, or selected custom soil-polygon vertices. Click a custom polygon first to select it. Drag empty space to pan and use the mouse wheel to zoom.'
  };
}

/** `EA … · EI …` or `E … · t …` for a wall's mechanical section. */
export function wallMechanicalLabel(wall){
  const section = resolveWallMechanicalSection(wall?.material?.mechanical);
  if(!section) return 'mechanical section not set';
  if(section.model === 'section-properties'){
    return `EA ${stage6CompactNumber(section.EA, 3)} kN/m · EI ${stage6CompactNumber(section.EI, 3)} kN·m²/m`;
  }
  return `E ${stage6CompactNumber(section.E, 3)} kPa · t ${stage6CompactNumber(section.thickness, 3)} m`;
}

// Workstream C3(b): additive "Partial — solved to NN% load" badge for a
// non-converged service solve. Reads the same solver fields the deformation
// banner uses (convergenceState + displayedLoadFactor). Scoped to a service-
// load partial: the geostatic phase converged but the service phase stalled
// before full load. A geostatic-only failure installs no wall (so there is no
// wall response to show), and a fully-converged safety run reports
// convergenceState 'converged', so both are excluded. Additive only — returns
// a string and never reads or mutates any numeric/convergence field.
export function partialLoadBadgeHtml(solver){
  if(!solver || solver.convergenceState !== 'partial') return '';
  if(solver.servicePhaseStarted !== true) return '';
  if(solver.initialPhaseConvergenceState && solver.initialPhaseConvergenceState !== 'converged') return '';
  const lambda = Math.max(0, Math.min(1, Number(solver.displayedLoadFactor) || 0));
  const pct = (100 * lambda).toFixed(1);
  return `<span style="display:inline-block;margin-top:4px;padding:1px 8px;border-radius:9px;font-size:10px;font-weight:600;background:rgba(245,158,11,0.16);color:var(--wn);border:1px solid rgba(245,158,11,0.4);white-space:nowrap">Partial — solved to ${pct}% load</span>`;
}
