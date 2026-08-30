// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/deformation-solve.js — legacy-controller.js 6822-6897, verbatim;
// the nested `bishop-deformation-diagnostics` group is ./deformation-diagnostics.js.
import { deformationDiagnosticsSectionHtml } from './deformation-diagnostics.js';
import { escAttr as stage6EscAttr } from '../../../core/format.js';
import { secondsLabelFromMs as stage6SecondsLabelFromMs } from '../../run/index.js';

/** `bishop-deformation-solve` — mesh & run state, with the nested diagnostics group. */
export function deformationSolveSectionHtml(vm, env){
  const { deformation, deformationIsSafety, deformationMeshTargetAreaAuto, deformationAutoMeshTargetArea, deformationMeshTargetArea, deformationMeshElementType, deformationMeshElementLabel, deformationWarnings, deformationRequestedInitialStressMode, deformationInitialStressMode, deformationSafetyStatus, deformationSafetyFoSLower, deformationSafetyFoSUpper, deformationSafetyOpenEnded, deformationSafetyDisplayedSigmaMsf, deformationSafetyStrengthRetained, deformationInitialPhaseStatus, deformationServicePhaseStatus, deformationGeostaticIterations, deformationGeostaticResidual, deformationSolverLabel, deformationAcceptedSteps, deformationRejectedSteps, deformationCommittedLoadFactor, deformationDisplayedLoadFactor, deformationPeakActive, deformationStatusMessage } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-deformation-solve"${stage6DetailsOpen('bishop-deformation-solve')}>
              <summary>Mesh & run state</summary>
              <div class="st6-adv-body">
                <label class="st6-bishop-check">
                  <input type="checkbox" ${deformationMeshTargetAreaAuto ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.meshTargetAreaAuto', this.checked)">
                  Auto size target area from the drawn geometry
                </label>
                <label style="font-size:11px;color:var(--tx2)">Target element area (m²)
                  <input type="number" step="0.005" min="0.01" value="${Number(deformationMeshTargetArea).toFixed(3)}" onchange="stage6BishopSetField('deformation.options.meshTargetArea', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Triangle element
                  <select onchange="stage6BishopSetField('deformation.options.meshElementType', this.value)">
                    <option value="t3" ${deformationMeshElementType === 't3' ? 'selected' : ''}>T3 - constant strain, fast</option>
                    <option value="t6" ${deformationMeshElementType === 't6' ? 'selected' : ''}>T6 - quadratic, 3 Gauss points</option>
                  </select>
                </label>
                <label class="st6-bishop-check">
                  <input type="checkbox" ${deformation.options?.useSeepagePorePressures ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useSeepagePorePressures', this.checked)">
                  Use seepage pore pressures when a seepage result exists
                </label>
                <div class="st6-help">${deformationIsSafety
                  ? `The safety mesh still follows the shared section geometry, with local refinement under active surcharge strips. The automatic target area scales from the current section and is about <strong>${deformationAutoMeshTargetArea.toFixed(3)} m²</strong> here. The safety phase starts from a converged self-weight equilibrium state before the strength-reduction multiplier ΣMsf is advanced.`
		                  : `The deformation mesh is intentionally refined beneath the loaded interval and both load edges. T3 is the fast constant-strain path; T6 uses six-node quadratic triangles and three integration points per element to resolve bending and stress gradients with lower mesh sensitivity. The automatic target area is about <strong>${deformationAutoMeshTargetArea.toFixed(3)} m²</strong> here. The default workflow recovers a K0 stress field and requires self-weight equilibrium before service loading.`}</div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Status: <strong>${stage6EscAttr(deformationStatusMessage)}</strong><br>
                  Solver: <strong>${stage6EscAttr(deformationSolverLabel)}</strong><br>
                  Initial workflow: <strong>${stage6EscAttr(deformationRequestedInitialStressMode)}</strong><br>
                  Initial stress: <strong>${stage6EscAttr(deformationInitialStressMode)}</strong><br>
                  Initial equilibration: <strong>${stage6EscAttr(deformationInitialPhaseStatus)}</strong><br>
                  Service phase: <strong>${stage6EscAttr(deformationServicePhaseStatus)}</strong><br>
                  ${deformationIsSafety ? `Safety phase: <strong>${stage6EscAttr(deformationSafetyStatus)}</strong><br>` : ''}
                  ${deformationIsSafety ? `FoS lower bound: <strong>${deformationSafetyFoSLower != null ? deformationSafetyFoSLower.toFixed(3) : '—'}</strong><br>` : ''}
                  ${deformationIsSafety ? `FoS upper bound: <strong>${deformationSafetyOpenEnded && deformationSafetyFoSLower != null ? `> ${deformationSafetyFoSLower.toFixed(3)}` : (deformationSafetyFoSUpper != null ? deformationSafetyFoSUpper.toFixed(3) : '—')}</strong><br>` : ''}
                  ${deformationIsSafety ? `Displayed ΣMsf: <strong>${deformationSafetyDisplayedSigmaMsf != null ? deformationSafetyDisplayedSigmaMsf.toFixed(3) : '—'}</strong><br>` : ''}
                  ${deformationIsSafety ? `Displayed retained strength: <strong>${deformationSafetyStrengthRetained != null ? `${(100 * deformationSafetyStrengthRetained).toFixed(2)} %` : '—'}</strong><br>` : ''}
                  Element type: <strong>${stage6EscAttr(deformationMeshElementLabel)}</strong><br>
                  Nodes: <strong>${deformation.mesh?.nodes?.length || 0}</strong><br>
                  Mechanical walls: <strong>${deformation.mesh?.mechanicalWalls?.length || 0}</strong><br>
                  Mid-edge nodes: <strong>${deformation.mesh?.meshStats?.midEdgeNodes || 0}</strong><br>
                  Triangles: <strong>${deformation.mesh?.elements?.length || 0}</strong><br>
                  Integration points: <strong>${deformation.result?.solver?.integrationPointCount || 0}</strong><br>
                  Free DOFs: <strong>${deformation.result?.solver?.freeDofs || 0}</strong><br>
                  Geostatic CG iterations: <strong>${deformationGeostaticIterations ?? '—'}</strong><br>
                  Geostatic residual: <strong>${deformationGeostaticResidual}</strong><br>
                  ${deformationIsSafety
                    ? `Safety continuation steps: <strong>${deformation.result?.solver?.safetyAcceptedContinuationSteps || 0}</strong>${deformation.result?.solver?.safetyRejectedContinuationSteps ? ` accepted, ${deformation.result.solver.safetyRejectedContinuationSteps} cut back` : ''}<br>`
                    : `Load steps: <strong>${deformationAcceptedSteps ?? '—'}</strong>${deformationRejectedSteps ? ` accepted, ${deformationRejectedSteps} cut back` : ''}<br>`}
                  ${deformationIsSafety
                    ? ''
                    : `Load factor shown: <strong>${deformationDisplayedLoadFactor != null ? `${(100 * deformationDisplayedLoadFactor).toFixed(1)} %` : '—'}</strong><br>
                  Last converged load factor: <strong>${deformationCommittedLoadFactor != null ? `${(100 * deformationCommittedLoadFactor).toFixed(1)} %` : '—'}</strong><br>`}
                  Nonlinear iterations: <strong>${deformation.result?.solver?.nonlinearIterations || 0}</strong><br>
                  Linear iterations: <strong>${deformation.result?.solver?.linearIterations || 0}</strong><br>
                  Residual: <strong>${Number.isFinite(deformation.result?.solver?.residualNorm) ? Number(deformation.result.solver.residualNorm).toExponential(2) : '—'}</strong><br>
                  Peak active MC elements: <strong>${deformationPeakActive ?? '—'}</strong><br>
                  ${deformationIsSafety
                    ? `Max safety Δε̄ᵖ: <strong>${deformation.result ? `${(100 * (deformation.result.summaries?.maxSafetyEquivalentPlasticIncrement || 0)).toFixed(3)} %` : '—'}</strong><br>`
                    : `Initial max settlement: <strong>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxInitialSettlement || 0)).toFixed(2)} mm` : '—'}</strong><br>`}
                  Runtime: <strong>${stage6SecondsLabelFromMs(deformation.result?.timing?.totalMs)}</strong>
                </div>
                ${deformationWarnings.length ? `
                  <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                    ${deformationWarnings.map((warning)=>stage6EscAttr(warning)).join('<br>')}
                  </div>
                ` : ''}
                ${(deformation.result?.solver?.initialPhaseDepthBandReport || deformation.result?.solver?.servicePhaseDepthBandReport) ? `${deformationDiagnosticsSectionHtml(vm, env)}
                ` : ''}
              </div>
            </details>`;
}
