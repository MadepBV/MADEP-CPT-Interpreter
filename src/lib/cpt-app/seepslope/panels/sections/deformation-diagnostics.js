// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/deformation-diagnostics.js — legacy-controller.js 6888-6894, verbatim.
import { depthBandReportHtml as stage6DepthBandReportHtml } from '../labels.js';

/** `bishop-deformation-diagnostics` — the depth-band plasticity report. */
export function deformationDiagnosticsSectionHtml(vm, env){
  const { deformation } = vm;
  const { stage6DetailsOpen } = env;
  return `
                  <details class="st6-adv" data-st6details="bishop-deformation-diagnostics"${stage6DetailsOpen('bishop-deformation-diagnostics')}>
                    <summary>Plasticity diagnostics</summary>
                    <div class="st6-adv-body">
                      ${stage6DepthBandReportHtml(deformation.result?.solver?.initialPhaseDepthBandReport, 'Initial self-weight')}
                      ${stage6DepthBandReportHtml(deformation.result?.solver?.servicePhaseDepthBandReport, 'Service loading')}
                    </div>
                  </details>`;
}
