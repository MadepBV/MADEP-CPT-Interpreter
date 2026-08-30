// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/geometry-deformation.js — legacy-controller.js 6509-6579, verbatim.
import { escAttr as stage6EscAttr, tooltip as stage6Tooltip } from '../../../core/format.js';

/** `bishop-geo-deformation` — the deformation workspace mechanical inputs. */
export function mechanicalInputsSectionHtml(vm, env){
  const { bishop, loadQ, loadSummary, deformationAnalysisType, deformationIsSafety, deformationLoadMode, deformationGeostaticInitializationMethod, deformationOutOfPlaneLength, deformationWidth, deformationTotalLoad, deformationAppliedQ, deformationSetupMessage, deformationUsesMcPlastic, deformationUsesMcConsistentTangent } = vm;
  const { stage6DetailsOpen, stage6MaxDepth } = env;
  return `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-deformation"${stage6DetailsOpen('bishop-geo-deformation')}>
                <summary>Mechanical inputs</summary>
                <div class="st6-adv-body">
                  <div class="st6-help">${deformationIsSafety
                    ? 'The safety route starts from a converged Mohr-Coulomb plastic equilibrium state and then runs a c-phi reduction phase with fixed actions. External loading is optional: without active surcharge strips, the analysis reduces strength under self-weight only.'
                    : 'This first deformation tool is a long-term drained screening solve on the shared triangular mesh. Draw the load interval on the terrain, choose whether you want to drive the model by applied pressure or total slab load, then size the out-of-plane length to approximate strip behaviour.'}</div>
                  <label style="font-size:11px;color:var(--tx2)">Analysis mode
                    <select onchange="stage6BishopSetField('deformation.options.analysisType', this.value)">
                      <option value="deformation"${deformationAnalysisType==='deformation'?' selected':''}>Deformation</option>
                      <option value="safety-cphi"${deformationAnalysisType==='safety-cphi'?' selected':''}>C-phi reduction safety</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Load input mode
                    <select onchange="stage6BishopSetField('deformation.options.loadMode', this.value)">
                      <option value="pressure"${deformationLoadMode==='pressure'?' selected':''}>Pressure q (kPa)</option>
                      <option value="total"${deformationLoadMode==='total'?' selected':''}>Total load (kN)</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Constitutive model
                    <select onchange="stage6BishopSetField('deformation.options.constitutiveModel', this.value)">
                      <option value="mc-plastic"${bishop.deformation?.options?.constitutiveModel==='mc-plastic'?' selected':''}>Mohr-Coulomb plastic</option>
                      <option value="mc-reduced-stiffness"${bishop.deformation?.options?.constitutiveModel==='mc-reduced-stiffness'?' selected':''}>Reduced-stiffness screen</option>
                      <option value="linear-elastic"${bishop.deformation?.options?.constitutiveModel==='linear-elastic'?' selected':''}>Linear elastic</option>
                    </select>
                  </label>
                  ${deformationUsesMcPlastic ? `
                  <label style="font-size:11px;color:var(--tx2)" title="WASM CPU only. Uses the Mohr-Coulomb consistent algorithmic tangent in plastic returns; turn off to compare with the previous elastic-tangent global Newton path.">
                    <input type="checkbox" ${deformationUsesMcConsistentTangent ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useMcConsistentTangent', this.checked)">
                    MC Simo-Hughes tangent
                  </label>` : ''}
                  ${deformationUsesMcPlastic ? `
                  <label style="font-size:11px;color:var(--tx2)" title="Staged construction (model C): for a retaining wall, the in-situ K0 state is held supported and the cut-face support is relaxed in a wall-active excavation phase so the wall carries the cut — the physically-correct sequence (the legacy wall-free geostatic cannot stand an unsupported cut and stalls). Only engages with a mechanical wall present; inert otherwise.">
                    <input type="checkbox" ${bishop.deformation?.options?.useStagedExcavation !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useStagedExcavation', this.checked)">
                    Staged construction (wall excavation)
                  </label>` : ''}
                  ${deformationUsesMcPlastic ? `
                  <label style="font-size:11px;color:var(--tx2)" title="Zero-thickness Coulomb soil-wall interface: the retained soil can gap (zero tension) and slip (tau_max = R_inter*c' + R_inter*tan(phi')*sigma_n') against the wall instead of being rigidly bonded — releases the crest tension band so deep cohesionless cuts reach 100% load, and bounds wall friction by the interface strength (R_inter = 0.667 by default, per-wall overridable). Single-sided in this phase: below the excavation level the two soil sides still share mesh nodes (no differential soil-soil slip across the wall plane). Requires staged construction + a mechanical wall; inert otherwise. Safety (c-phi) runs use the bonded wall until interface strength joins the sigma_Msf reduction.">
                    <input type="checkbox" ${bishop.deformation?.options?.useWallInterface !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useWallInterface', this.checked)">
                    Soil–wall interface (gap + slip)
                  </label>` : ''}
	                  <label style="font-size:11px;color:var(--tx2)">Initial equilibrium workflow
	                    <select onchange="stage6BishopSetField('deformation.options.geostaticInitializationMethod', this.value)">
	                      <option value="auto"${deformationGeostaticInitializationMethod==='auto'?' selected':''}>Auto K0 + self-weight equilibrium</option>
	                      ${bishop.deformation?.options?.constitutiveModel === 'mc-plastic' ? `<option value="gravity-ramp"${deformationGeostaticInitializationMethod==='gravity-ramp'?' selected':''}>Gravity ramp equilibrium</option>` : ''}
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Surface load q (kPa)${stage6Tooltip(deformationIsSafety
                    ? 'Optional in safety mode. If you leave the load inactive, the c-phi reduction starts from the self-weight equilibrium state only. If you apply a surcharge, the safety phase starts from the converged end-of-service state and keeps that external load fixed.'
                    : 'Used directly in pressure mode. In total-load mode the app derives an equivalent 2D pressure q = total load / (loaded width × out-of-plane length).')}
                    <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)" ${deformationLoadMode === 'pressure' ? '' : 'disabled'}>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Total slab load (kN)
                    <input type="number" step="1" min="0" value="${deformationTotalLoad != null ? deformationTotalLoad.toFixed(1) : ''}" onchange="stage6BishopSetField('deformation.options.totalLoad', this.value)" ${deformationLoadMode === 'total' ? '' : 'disabled'}>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Out-of-plane length (m)
                    <input type="number" step="0.5" min="0.1" value="${deformationOutOfPlaneLength.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.outOfPlaneLength', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Analysis depth below terrain (m)${stage6Tooltip('The deformation mesh uses the same section envelope as the seepage and stability tools. The bottom boundary is fixed vertically, so a deeper domain usually gives a less stiff settlement response.')}
                    <input type="number" step="0.5" min="${Math.max(stage6MaxDepth(), 15).toFixed(2)}" value="${bishop.analysisDepth.toFixed(2)}" onchange="stage6BishopSetField('analysisDepth', this.value)">
                  </label>
                  <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                    Analysis mode: <strong>${deformationIsSafety ? 'C-phi reduction safety' : 'Deformation'}</strong><br>
	                    Surface loads: <strong>${stage6EscAttr(loadSummary)}</strong><br>
	                    Total loaded width: <strong>${deformationWidth > 0 ? `${deformationWidth.toFixed(2)} m` : '—'}</strong><br>
	                    Average active pressure q: <strong>${deformationAppliedQ > 0 ? `${deformationAppliedQ.toFixed(2)} kPa` : '—'}</strong><br>
                    Total load: <strong>${deformationTotalLoad != null ? `${deformationTotalLoad.toFixed(1)} kN` : '—'}</strong><br>
                    ${deformationUsesMcPlastic ? `MC tangent: <strong>${deformationUsesMcConsistentTangent ? 'Simo-Hughes consistent' : 'elastic fallback'}</strong><br>` : ''}
                    Setup: <strong>${stage6EscAttr(deformationSetupMessage)}</strong>
                  </div>
                </div>
              </details>`;
}
