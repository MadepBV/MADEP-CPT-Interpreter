// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/deformation-contour-legend.js — legacy-controller.js 7312-7332, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';

/** `bishop-deformation-contour-legend` — the canvas contour legend. */
export function deformationContourLegendHtml(vm, env){
  const { bishop, deformationAnalysisType, deformationContourMode, deformationContourDerived, deformationContourLegendMeta, deformationContourLegendTicks } = vm;
  const { stage6DetailsOpen, stage6BishopDeformationContourLegendGradient, stage6BishopDeformationContourLegendValue } = env;
  return deformationContourDerived &&
      bishop.deformation?.display?.showContourLegend !== false &&
      (bishop.deformation?.display?.showContours !== false || bishop.deformation?.display?.showContourLines !== false)
    ? `
              <details class="st6-bishop-contour-legend" data-st6details="bishop-deformation-contour-legend"${stage6DetailsOpen('bishop-deformation-contour-legend')}>
                <summary>
                  <span class="st6-bishop-contour-legend-title">Legend</span>
                  <span class="st6-bishop-contour-legend-mode">${stage6EscAttr(deformationContourLegendMeta.label)}</span>
                </summary>
                <div class="st6-bishop-contour-legend-panel">
                  <div class="st6-bishop-contour-legend-unit">${stage6EscAttr(deformationContourLegendMeta.unit || 'relative')}</div>
                  <div class="st6-bishop-contour-legend-body">
                    <div class="st6-bishop-contour-legend-scale" style="background:${stage6EscAttr(stage6BishopDeformationContourLegendGradient(deformationContourMode, deformationAnalysisType))}"></div>
                    <div class="st6-bishop-contour-legend-ticks">
                      ${deformationContourLegendTicks.map((value)=>`<span>${stage6EscAttr(stage6BishopDeformationContourLegendValue(deformationContourMode, value, deformationAnalysisType))}</span>`).join('')}
                    </div>
                  </div>
                </div>
              </details>
            `
    : '';
}
