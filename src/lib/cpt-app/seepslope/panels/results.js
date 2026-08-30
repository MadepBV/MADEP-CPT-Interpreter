// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/results.js — the results panel under the canvas, one shape per workspace
// (legacy-controller.js 7769-7983), verbatim.
import { compactNumber as stage6CompactNumber, escAttr as stage6EscAttr } from '../../core/format.js';
import { methodModeLabel as stage6BishopMethodModeLabel, secondsLabelFromMs as stage6SecondsLabelFromMs, seepageFlowErrorLabel as stage6SeepageFlowErrorLabel } from '../run/index.js';
import { seepageTerminationLabel as stage6BishopSeepageTerminationLabel } from './labels.js';
import { safetyCurveHtml as stage6BishopSafetyCurveHtml, safetyMechanismHtml as stage6BishopSafetyMechanismHtml } from './safety.js';

/** Stability slices / seepage boundary summary / deformation profiles. */
export function workspaceResultsHtml(vm, env){
  const { bishop, selected, results, summary, wallSummary, workspace, hasWalls, showSpencerSliceCols, showWallSliceCol, selectedNormalHeader, selectedMethodLabel, selectedWallLabel, seepage, deformation, seepageBoundary, seepageActiveBcs, seepageOrphanedBcs, seepageHeadCount, seepageStatusLabel, seepageStatusMessage, deformationIsSafety, deformationLoadMode, deformationOutOfPlaneLength, deformationActiveLoads, deformationTotalLoad, deformationStatusLabel, deformationAppliedQ, deformationWarnings, deformationInitialStressMode, deformationSafetyStatus, deformationSafetyFoSLower, deformationSafetyFoSUpper, deformationSafetyOpenEnded, deformationSafetyDisplayedSigmaMsf, deformationSafetyStrengthRetained, deformationSafetyMechanism, deformationGeostaticIterations, deformationGeostaticResidual, deformationSolverLabel, deformationAcceptedSteps, deformationRejectedSteps, deformationPeakActive, deformationProfileRows, deformationWallRows, deformationStatusMessage, resultRows, drainResultRows, seepageDrainInflow, seepageDrainOutflow, seepageDrainNodeSummary } = vm;
  const { stage6BishopSeepageEdgeLabel, stage6BishopSeepageBcTypeLabel } = env;
  return workspace === 'stability' ? `
          <div class="st6-bishop-results-panel">
            <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase">Results</div>
            <div class="st6-bishop-results-top">
              <div class="st6-bishop-side">
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>${bishop.strengthSet === 'da1_2'
                    ? 'Critical Λ (EC7 DA1/2 over-design factor, require ≥ 1.0)'
                    : bishop.strengthSet === 'da1_1'
                      ? 'Critical F (M1 strengths — enter design loads; not a full DA1/1 verification)'
                      : 'Critical F (characteristic strengths)'}</td><td>${summary && results[0] ? results[0].FS.toFixed(3) : '—'}</td></tr>
                  <tr><td>Mode</td><td>${stage6BishopMethodModeLabel(bishop.methodMode)}</td></tr>
                  <tr><td>Circle centre</td><td>${summary ? `(${summary.center.x.toFixed(2)}, ${summary.center.y.toFixed(2)})` : '—'}</td></tr>
                  <tr><td>Radius</td><td>${summary ? `${summary.radius.toFixed(2)} m` : '—'}</td></tr>
                  <tr><td>Max slip depth</td><td>${summary ? `${summary.maxDepth.toFixed(2)} m` : '—'}</td></tr>
                  ${hasWalls ? `<tr><td>Critical through wall</td><td>${wallSummary?.criticalThroughWall ? wallSummary.criticalThroughWall.FS.toFixed(3) : '—'}</td></tr>` : ''}
                  ${hasWalls ? `<tr><td>Critical below wall</td><td>${wallSummary?.criticalBelowWall ? wallSummary.criticalBelowWall.FS.toFixed(3) : '—'}</td></tr>` : ''}
                  ${hasWalls ? `<tr><td>Wall effective</td><td>${wallSummary?.wallEffective == null ? '—' : (wallSummary.wallEffective ? 'yes' : 'no / inconclusive')}</td></tr>` : ''}
                  <tr><td>Trials</td><td>${bishop.results?.timing?.trialCount ?? '—'}</td></tr>
                  <tr><td>Runtime</td><td>${bishop.results?.timing?.totalMs != null ? `${bishop.results.timing.totalMs.toFixed(0)} ms` : '—'}</td></tr>
                  <tr><td>Spencer rechecked</td><td>${bishop.results?.methodMode === 'bishop_spencer' ? `${bishop.results?.spencerRechecked || 0}` : 'off'}</td></tr>
                  <tr><td>Spencer converged</td><td>${bishop.results?.methodMode === 'bishop_spencer' ? `${bishop.results?.spencerConverged || 0}` : 'off'}</td></tr>
                  <tr><td>Selected result</td><td>${selected ? `#${(bishop.selectedResult||0)+1}` : '—'}</td></tr>
                  <tr><td>Selected method</td><td>${selectedMethodLabel}</td></tr>
                  <tr><td>Selected Bishop F</td><td>${selected && Number.isFinite(selected.F_bishop) ? selected.F_bishop.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected Spencer F</td><td>${selected?.method === 'spencer' && Number.isFinite(selected.FS) ? selected.FS.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected λ</td><td>${selected && Number.isFinite(selected.lambda) ? selected.lambda.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected θ</td><td>${selected && Number.isFinite(selected.thetaDeg) ? `${selected.thetaDeg.toFixed(1)}°` : '—'}</td></tr>
                  ${hasWalls ? `<tr><td>Selected wall status</td><td>${selectedWallLabel}</td></tr>` : ''}
                  ${hasWalls ? `<tr><td>Selected wall force</td><td>${selected && Number.isFinite(selected.wallForceTotal) ? `${selected.wallForceTotal.toFixed(1)} kN/m` : '—'}</td></tr>` : ''}
                  <tr><td>Selected moment residual</td><td>${selected && Number.isFinite(selected.momentResidual) ? selected.momentResidual.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected force residual</td><td>${selected && Number.isFinite(selected.forceResidual) ? selected.forceResidual.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected iterations</td><td>${selected ? selected.iterations : '—'}</td></tr>
                </table>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:0">
                  Rejections: ${bishop.results ? Object.entries(bishop.results.rejectionCounts || {}).map(([k,v])=>`${k}: ${v}`).join(' · ') || 'none' : 'no search yet'}${selected?.spencerAttempted && !selected?.spencerConverged ? `<br>Selected fallback: ${stage6EscAttr(selected.spencerRejectReason || 'Spencer did not converge.')}` : ''}
                </div>
              </div>
              <div class="st6-bishop-side">
                ${bishop.results && !results.length ? `
                  <div class="st6-help" style="margin-bottom:12px">
                    No valid circle was found for the current geometry and search settings. Try widening the <strong>entry</strong> and <strong>exit</strong> zones, increasing <strong>entry / exit samples</strong> and <strong>centers per chord</strong>, increasing <strong>center offset max</strong>, reducing <strong>minimum slip thickness</strong> a little, or allowing a larger <strong>maximum exit angle</strong>. The rejection summary above tells you which filter blocked most trial circles.
                  </div>
                `:''}
                <div class="mc2-sec">Best circles</div>
                <div style="max-height:200px;overflow:auto">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>#</th><th>F</th><th>Method</th><th>Bishop F</th><th>Wall</th><th>λ</th><th>Iter</th><th></th></tr></thead>
                    <tbody>${resultRows || '<tr><td colspan="8" style="text-align:center;color:var(--tx2)">No results yet.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="st6-bishop-side">
              <div class="mc2-sec">Selected slices</div>
              <div style="max-height:250px;overflow:auto">
                <table class="tbl st6-bishop-results">
                  <thead><tr><th>i</th><th>W</th><th>Q</th><th>V</th><th>alpha</th><th>c'</th><th>phi'</th><th>u</th><th>m_alpha</th><th>${selectedNormalHeader}</th>${showWallSliceCol ? '<th>R_wall,left</th>' : ''}${showSpencerSliceCols ? '<th>E_r</th><th>X_r</th><th>S_mob</th>' : ''}</tr></thead>
                  <tbody>
                    ${selected ? selected.slices.map((slice, index)=>`
                      <tr>
                        <td>${index+1}</td>
                        <td>${slice.W.toFixed(1)}</td>
                        <td>${(slice.Q || 0).toFixed(1)}</td>
                        <td>${(slice.V || slice.W || 0).toFixed(1)}</td>
                        <td>${(slice.alphaRad * 180 / Math.PI).toFixed(1)}°</td>
                        <td>${slice.baseMaterial.cEff.toFixed(1)}</td>
                        <td>${slice.baseMaterial.phiEffDeg.toFixed(1)}°</td>
                        <td>${slice.uBase.toFixed(1)}</td>
                        <td>${slice.mAlpha.toFixed(3)}</td>
                        <td>${(showSpencerSliceCols ? slice.N_eff : slice.normalForce) != null ? (showSpencerSliceCols ? slice.N_eff : slice.normalForce).toFixed(1) : '—'}</td>
                        ${showWallSliceCol ? `<td>${(slice.wallForceLeft || 0) > 0 ? slice.wallForceLeft.toFixed(1) : '—'}</td>` : ''}
                        ${showSpencerSliceCols ? `<td>${slice.E_right != null ? slice.E_right.toFixed(1) : '—'}</td><td>${slice.X_right != null ? slice.X_right.toFixed(1) : '—'}</td><td>${slice.S_mob != null ? slice.S_mob.toFixed(1) : '—'}</td>` : ''}
                      </tr>
                    `).join('') : `<tr><td colspan="${10 + (showWallSliceCol ? 1 : 0) + (showSpencerSliceCols ? 3 : 0)}" style="text-align:center;color:var(--tx2)">Select or run a result to inspect slice data.</td></tr>`}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
  ` : workspace === 'seepage' ? `
          <div class="st6-bishop-results-panel">
            <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase">Results</div>
            <div class="st6-bishop-results-top">
              <div class="st6-bishop-side">
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>Status</td><td>${stage6EscAttr(seepageStatusLabel)}</td></tr>
                  <tr><td>Nodes</td><td>${seepage.mesh?.nodes?.length || 0}</td></tr>
                  <tr><td>Triangles</td><td>${seepage.mesh?.elements?.length || 0}</td></tr>
                  <tr><td>Head range</td><td>${seepage.result ? `${seepage.result.headMin.toFixed(2)} to ${seepage.result.headMax.toFixed(2)} m` : '—'}</td></tr>
                  <tr><td>Through-flow</td><td>${seepage.result ? `${(seepage.result.throughFlow || 0).toExponential(2)} m³/s/m` : '—'}</td></tr>
                  <tr><td>Drain inflow</td><td>${seepage.result ? `${seepageDrainInflow.toExponential(2)} m³/s/m` : '—'}</td></tr>
                  <tr><td>Drain outflow</td><td>${seepage.result ? `${seepageDrainOutflow.toExponential(2)} m³/s/m` : '—'}</td></tr>
                  <tr><td>Flow-rate error</td><td>${stage6SeepageFlowErrorLabel(seepage.result)}</td></tr>
                  <tr><td>Termination</td><td>${stage6EscAttr(stage6BishopSeepageTerminationLabel(seepage.result?.solver?.terminationReason))}</td></tr>
                  <tr><td>Max exit gradient</td><td>${seepage.result ? (seepage.result.maxExitGradient || 0).toFixed(3) : '—'}</td></tr>
                  <tr><td>Dry cells</td><td>${seepage.result?.dryCellCount || 0}</td></tr>
                  <tr><td>Runtime</td><td>${stage6SecondsLabelFromMs(seepage.result?.timing?.totalMs)}</td></tr>
                </table>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:0">
                  ${stage6EscAttr(seepageStatusMessage)}
                </div>
              </div>
              <div class="st6-bishop-side">
                <div class="mc2-sec">Boundary summary</div>
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>Outer edges</td><td>${seepageBoundary.length}</td></tr>
                  <tr><td>Explicit BCs</td><td>${seepageActiveBcs.length}</td></tr>
                  <tr><td>Prescribed head</td><td>${seepageHeadCount}</td></tr>
                  <tr><td>Seepage face</td><td>${seepageActiveBcs.filter((bc)=>bc.type === 'seepage-face').length}</td></tr>
                  <tr><td>No-flow</td><td>${seepageActiveBcs.filter((bc)=>bc.type === 'no-flow').length}</td></tr>
                  <tr><td>Orphaned BCs</td><td>${seepageOrphanedBcs.length}</td></tr>
                  <tr><td>Drain nodes active</td><td>${seepageDrainNodeSummary ? `${seepageDrainNodeSummary.activeNodes || 0} / ${seepageDrainNodeSummary.totalNodes || 0}` : '—'}</td></tr>
                  <tr><td>Drain edge check</td><td>${Number.isFinite(Number(seepageDrainNodeSummary?.perEdgeReactionDelta)) ? Number(seepageDrainNodeSummary.perEdgeReactionDelta).toExponential(2) : '—'}</td></tr>
                </table>
                <div class="mc2-sec">Drain discharge</div>
                <div style="max-height:160px;overflow:auto;margin-bottom:12px">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>Drain</th><th>Gating</th><th>Inflow</th><th>Reaction</th><th>Active nodes</th></tr></thead>
                    <tbody>${drainResultRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">No solved drain discharge.</td></tr>'}</tbody>
                  </table>
                </div>
                <div class="mc2-sec">Assigned BCs</div>
                <div style="max-height:240px;overflow:auto">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>Edge</th><th>Type</th><th>Head</th><th>Status</th></tr></thead>
                    <tbody>${seepageActiveBcs.map((bc)=>{
                      const edge = seepageBoundary.find((item)=>item.edgeKey === bc.edgeKey);
                      return `
                        <tr>
                          <td>${stage6EscAttr(stage6BishopSeepageEdgeLabel(edge || {source:bc.anchor?.source, index:0}))}</td>
                          <td>${stage6EscAttr(stage6BishopSeepageBcTypeLabel(bc.type))}</td>
                          <td>${bc.type === 'head' && Number.isFinite(bc.head) ? `${bc.head.toFixed(2)} m` : '—'}</td>
                          <td>${stage6EscAttr(bc.status || 'active')}</td>
                        </tr>
                      `;
                    }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--tx2)">No explicit boundary conditions yet.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
  ` : `
          <div class="st6-bishop-results-panel">
            <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase">Results</div>
            <div class="st6-bishop-results-top">
              <div class="st6-bishop-side">
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>Status</td><td>${stage6EscAttr(deformationStatusLabel)}</td></tr>
                  <tr><td>Load mode</td><td>${deformationLoadMode === 'total' ? 'total load' : 'pressure q'}</td></tr>
	                  <tr><td>Active loads</td><td>${deformationActiveLoads.length}</td></tr>
	                  <tr><td>Average q</td><td>${deformationAppliedQ > 0 ? `${deformationAppliedQ.toFixed(2)} kPa` : '—'}</td></tr>
	                  <tr><td>Total load</td><td>${deformationTotalLoad != null ? `${deformationTotalLoad.toFixed(1)} kN` : '—'}</td></tr>
                  <tr><td>Out-of-plane length</td><td>${deformationOutOfPlaneLength.toFixed(2)} m</td></tr>
		                  <tr><td>Nodes</td><td>${deformation.mesh?.nodes?.length || 0}</td></tr>
		                  <tr><td>Mechanical walls</td><td>${deformation.mesh?.mechanicalWalls?.length || 0}</td></tr>
		                  <tr><td>Triangles</td><td>${deformation.mesh?.elements?.length || 0}</td></tr>
	                  <tr><td>Solver</td><td>${stage6EscAttr(deformationSolverLabel)}</td></tr>
	                  <tr><td>Initial stress</td><td>${stage6EscAttr(deformationInitialStressMode)}</td></tr>
	                  <tr><td>Free DOFs</td><td>${deformation.result?.solver?.freeDofs || 0}</td></tr>
	                  <tr><td>Geostatic CG iterations</td><td>${deformationGeostaticIterations ?? '—'}</td></tr>
	                  <tr><td>Geostatic residual</td><td>${deformationGeostaticResidual}</td></tr>
                  ${deformationIsSafety
                    ? `<tr><td>Safety status</td><td>${stage6EscAttr(deformationSafetyStatus)}</td></tr>
                  <tr><td>FoS lower bound</td><td>${deformationSafetyFoSLower != null ? deformationSafetyFoSLower.toFixed(3) : '—'}</td></tr>
                  <tr><td>FoS upper bound</td><td>${deformationSafetyOpenEnded && deformationSafetyFoSLower != null ? `> ${deformationSafetyFoSLower.toFixed(3)}` : (deformationSafetyFoSUpper != null ? deformationSafetyFoSUpper.toFixed(3) : '—')}</td></tr>
                  <tr><td>Displayed ΣMsf</td><td>${deformationSafetyDisplayedSigmaMsf != null ? deformationSafetyDisplayedSigmaMsf.toFixed(3) : '—'}</td></tr>
                  <tr><td>Displayed retained strength</td><td>${deformationSafetyStrengthRetained != null ? `${(100 * deformationSafetyStrengthRetained).toFixed(2)} %` : '—'}</td></tr>
                  <tr><td>Accepted continuation steps</td><td>${deformation.result?.solver?.safetyAcceptedContinuationSteps || 0}</td></tr>
                  <tr><td>Rejected continuation steps</td><td>${deformation.result?.solver?.safetyRejectedContinuationSteps || 0}</td></tr>
                  <tr><td>Mechanism</td><td>${deformationSafetyMechanism ? `${stage6EscAttr(deformationSafetyMechanism.status || 'none')} · ${stage6CompactNumber(deformationSafetyMechanism.score || 0, 3)}` : '—'}</td></tr>`
                    : `<tr><td>Accepted load steps</td><td>${deformationAcceptedSteps ?? '—'}</td></tr>
                  <tr><td>Rejected load steps</td><td>${deformationRejectedSteps ?? '—'}</td></tr>`}
                  <tr><td>Nonlinear iterations</td><td>${deformation.result?.solver?.nonlinearIterations || 0}</td></tr>
	                  <tr><td>Linear iterations</td><td>${deformation.result?.solver?.linearIterations || 0}</td></tr>
                  <tr><td>Residual</td><td>${Number.isFinite(deformation.result?.solver?.residualNorm) ? Number(deformation.result.solver.residualNorm).toExponential(2) : '—'}</td></tr>
                  <tr><td>Peak active MC elements</td><td>${deformationPeakActive ?? '—'}</td></tr>
                  <tr><td>Max settlement</td><td>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxSettlement || 0)).toFixed(2)} mm` : '—'}</td></tr>
                  <tr><td>Max |u_x|</td><td>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxHorizontalDisplacement || 0)).toFixed(2)} mm` : '—'}</td></tr>
                  <tr><td>Max delta sigma_yy</td><td>${deformation.result ? `${(deformation.result.summaries?.maxDeltaSigmaYy || 0).toFixed(2)} kPa` : '—'}</td></tr>
	                  <tr><td>Max MC eta</td><td>${deformation.result ? (deformation.result.summaries?.hasInfiniteMcEta ? '∞' : `${(deformation.result.summaries?.maxMcEta || 0).toFixed(3)}`) : '—'}</td></tr>
	                  <tr><td>Active MC elements</td><td>${deformation.result ? `${deformation.result.summaries?.activeMcElementCount || 0}` : '—'}</td></tr>
	                  <tr><td>MC-exceeded elements</td><td>${deformation.result ? `${deformation.result.summaries?.exceededMcElementCount || 0}` : '—'}</td></tr>
	                  <tr><td>Max ε̄ᵖ,acc</td><td>${deformation.result ? `${(100 * (deformation.result.summaries?.maxEquivalentPlasticStrain || 0)).toFixed(3)} %` : '—'}</td></tr>
                  ${deformationIsSafety ? `<tr><td>Max Δε̄ᵖ,safety</td><td>${deformation.result ? `${(100 * (deformation.result.summaries?.maxSafetyEquivalentPlasticIncrement || 0)).toFixed(3)} %` : '—'}</td></tr>` : ''}
                  <tr><td>Runtime</td><td>${stage6SecondsLabelFromMs(deformation.result?.timing?.totalMs)}</td></tr>
                </table>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:0">
                  ${stage6EscAttr(deformationStatusMessage)}
                  ${deformationWarnings.length ? `<br><br>${deformationWarnings.map((warning)=>stage6EscAttr(warning)).join('<br>')}` : ''}
			              </div>
			            </div>
              <div class="st6-bishop-side">
                <div class="mc2-sec">Terrain settlement profile</div>
                <div style="max-height:300px;overflow:auto">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>#</th><th>x</th><th>y</th><th>settlement (mm)</th><th>u_x (mm)</th></tr></thead>
                    <tbody>${deformationProfileRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">Run the deformation screen to inspect the terrain settlement profile.</td></tr>'}</tbody>
		                  </table>
		                </div>
		              </div>
	              <div class="st6-bishop-side">
	                <div class="mc2-sec">Retaining wall response</div>
	                <div style="max-height:300px;overflow:auto">
	                  <table class="tbl st6-bishop-results">
	                    <thead><tr><th>Wall</th><th>Station</th><th>s (m)</th><th>w pass. (mm)</th><th>θ pass. (mrad)</th><th>N (kN/m)</th><th>V pass. (kN/m)</th><th>M pass. (kNm/m)</th></tr></thead>
	                    <tbody>${deformationWallRows || '<tr><td colspan="8" style="text-align:center;color:var(--tx2)">Run deformation with mechanical wall activation enabled to inspect wall forces.</td></tr>'}</tbody>
	                  </table>
	                </div>
	              </div>
		            </div>
	            ${deformationIsSafety ? stage6BishopSafetyCurveHtml(deformation.result?.solver) : ''}
	            ${deformationIsSafety ? stage6BishopSafetyMechanismHtml(deformationSafetyMechanism) : ''}
	          </div>
	  `;
}
