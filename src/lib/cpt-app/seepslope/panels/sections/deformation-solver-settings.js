// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/deformation-solver-settings.js — legacy-controller.js 6898-6973, verbatim.

/** `bishop-deformation-solver-settings` — the nonlinear solver knobs. */
export function deformationSolverSettingsSectionHtml(vm, env){
  const { deformationIsSafety, deformationNonlinearMaxIterations, deformationInitialLoadStep, deformationMinLoadStep, deformationMaxLoadSteps, deformationResidualRelTol, deformationResidualAbsTol, deformationDisplacementRelTol, deformationDisplacementAbsTol, deformationLoadStepGrowthFactor, deformationLoadStepCutbackFactor, deformationPlasticLoadStepGrowthFactor, deformationPlasticLoadStepCutbackFactor, deformationGeostaticCorrectionStages, deformationSafetyInitialSigmaMsfIncrement, deformationSafetySigmaMsfGrowthFactor, deformationSafetySigmaMsfMax, deformationSafetySigmaMsfBracketTolerance, deformationSafetyMaxSearchTrials, deformationUseUnsymmetricPlasticSolver, deformationSolverBackend } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-deformation-solver-settings"${stage6DetailsOpen('bishop-deformation-solver-settings')}>
              <summary>Solver settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">${deformationIsSafety
                  ? 'These settings control both the base deformation solve and the c-phi reduction search. The safety phase expands the strength-reduction multiplier ΣMsf until failure is bracketed, then refines that bracket conservatively from the last converged state.'
                  : 'These settings control how aggressively the nonlinear deformation solver searches for equilibrium before it cuts the load step back or stops. Smaller initial steps and more conservative growth help near plastic collapse; tighter tolerances demand a cleaner residual before a step is accepted.'}</div>
                <label style="font-size:11px;color:var(--tx2)">Nonlinear iterations per load step
                  <input type="number" step="1" min="1" value="${deformationNonlinearMaxIterations}" onchange="stage6BishopSetField('deformation.options.nonlinearMaxIterations', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Initial load step (0-1)
                  <input type="number" step="0.01" min="${deformationMinLoadStep.toFixed(6)}" max="1" value="${deformationInitialLoadStep.toFixed(3)}" onchange="stage6BishopSetField('deformation.options.initialLoadStep', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Minimum load step
                  <input type="number" step="0.0001" min="0.000001" value="${deformationMinLoadStep.toFixed(6)}" onchange="stage6BishopSetField('deformation.options.minLoadStep', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Maximum load steps
                  <input type="number" step="1" min="1" value="${deformationMaxLoadSteps}" onchange="stage6BishopSetField('deformation.options.maxLoadSteps', this.value)">
                </label>
		                <div class="st6-help">Auto is the production workflow: one K0 stress-recovery seed, followed by the required self-weight equilibrium solve before service or safety loading.</div>
		                <label style="font-size:11px;color:var(--tx2)">Geostatic correction stages
		                  <input type="number" step="1" min="1" max="64" value="${deformationGeostaticCorrectionStages}" onchange="stage6BishopSetField('deformation.options.geostaticCorrectionStages', this.value)">
		                </label>
                <label style="font-size:11px;color:var(--tx2)">Residual relative tolerance
                  <input type="number" step="0.00001" min="0.00000001" value="${deformationResidualRelTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.residualRelTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Residual absolute tolerance
                  <input type="number" step="0.000001" min="0.000000001" value="${deformationResidualAbsTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.residualAbsTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Displacement relative tolerance
                  <input type="number" step="0.000001" min="0.00000001" value="${deformationDisplacementRelTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.displacementRelTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Displacement absolute tolerance
                  <input type="number" step="0.000000001" min="0.000000000001" value="${deformationDisplacementAbsTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.displacementAbsTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Load-step growth factor
                  <input type="number" step="0.01" min="1" value="${deformationLoadStepGrowthFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.loadStepGrowthFactor', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Load-step cutback factor
                  <input type="number" step="0.01" min="0.1" max="0.9" value="${deformationLoadStepCutbackFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.loadStepCutbackFactor', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Plastic growth factor
                  <input type="number" step="0.01" min="1" value="${deformationPlasticLoadStepGrowthFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.plasticLoadStepGrowthFactor', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Plastic cutback factor
                  <input type="number" step="0.01" min="0.1" max="0.9" value="${deformationPlasticLoadStepCutbackFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.plasticLoadStepCutbackFactor', this.value)">
                </label>
	                <label class="st6-bishop-check">
	                  <input type="checkbox" ${deformationUseUnsymmetricPlasticSolver ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useUnsymmetricPlasticSolver', this.checked)">
	                  Nonsymmetric plastic tangents
	                </label>
	                <label class="st6-bishop-check">
	                  <span style="font-size:11px;color:var(--tx2);min-width:80px">Solve path:</span>
	                  <select onchange="stage6BishopSetField('deformation.options.solverBackend', this.value)" style="font-size:11px">
	                    <option value="js-cpu" ${deformationSolverBackend === 'js-cpu' ? 'selected' : ''}>JS CPU</option>
	                    <option value="wasm-cpu" ${deformationSolverBackend === 'wasm-cpu' ? 'selected' : ''}>WASM CPU</option>
	                  </select>
	                </label>
                ${deformationIsSafety ? `
                  <label style="font-size:11px;color:var(--tx2)">Initial ΣMsf increment
                    <input type="number" step="0.01" min="0.001" value="${deformationSafetyInitialSigmaMsfIncrement.toFixed(3)}" onchange="stage6BishopSetField('deformation.options.safetyInitialSigmaMsfIncrement', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">ΣMsf growth factor
                    <input type="number" step="0.01" min="1.01" value="${deformationSafetySigmaMsfGrowthFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.safetySigmaMsfGrowthFactor', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Maximum ΣMsf
                    <input type="number" step="0.05" min="1.00" value="${deformationSafetySigmaMsfMax.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.safetySigmaMsfMax', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">FoS bracket tolerance
                    <input type="number" step="0.001" min="0.0001" value="${deformationSafetySigmaMsfBracketTolerance.toFixed(3)}" onchange="stage6BishopSetField('deformation.options.safetySigmaMsfBracketTolerance', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Maximum safety trials
                    <input type="number" step="1" min="1" value="${deformationSafetyMaxSearchTrials}" onchange="stage6BishopSetField('deformation.options.safetyMaxSearchTrials', this.value)">
                  </label>
                ` : ''}
              </div>
            </details>`;
}
