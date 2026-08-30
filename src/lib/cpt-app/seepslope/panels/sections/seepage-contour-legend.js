// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/seepage-contour-legend.js — legacy-controller.js 7333-7353, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';

/** `bishop-seepage-contour-legend` — the canvas contour legend. */
export function seepageContourLegendHtml(vm, env){
  const { bishop, seepageContourMode, seepageContourDerived, seepageContourLegendMeta, seepageContourLegendTicks } = vm;
  const { stage6DetailsOpen, stage6BishopSeepageContourLegendGradient, stage6BishopSeepageContourLegendValue } = env;
  return seepageContourDerived &&
      bishop.seepage?.display?.showContourLegend !== false &&
      (bishop.seepage?.display?.showContours !== false || bishop.seepage?.display?.showContourLines !== false)
    ? `
              <details class="st6-bishop-contour-legend" data-st6details="bishop-seepage-contour-legend"${stage6DetailsOpen('bishop-seepage-contour-legend')}>
                <summary>
                  <span class="st6-bishop-contour-legend-title">Legend</span>
                  <span class="st6-bishop-contour-legend-mode">${stage6EscAttr(seepageContourLegendMeta.label)}</span>
                </summary>
                <div class="st6-bishop-contour-legend-panel">
                  <div class="st6-bishop-contour-legend-unit">${stage6EscAttr(seepageContourLegendMeta.unit || 'relative')}</div>
                  <div class="st6-bishop-contour-legend-body">
                    <div class="st6-bishop-contour-legend-scale" style="background:${stage6EscAttr(stage6BishopSeepageContourLegendGradient(seepageContourMode))}"></div>
                    <div class="st6-bishop-contour-legend-ticks">
                      ${seepageContourLegendTicks.map((value)=>`<span>${stage6EscAttr(stage6BishopSeepageContourLegendValue(seepageContourMode, value))}</span>`).join('')}
                    </div>
                  </div>
                </div>
              </details>
            `
    : '';
}
