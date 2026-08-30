// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/line-probe.js — the shared Measure-line probe read-out
// (legacy-controller.js 7027-7039 and 7040-7058), verbatim.
import { compactNumber as stage6CompactNumber, escAttr as stage6EscAttr } from '../../core/format.js';
import { measurementLabel as stage6BishopMeasurementLabel } from '../geometry/index.js';
import { lineProbeFormatValue as stage6BishopLineProbeFormatValue } from '../probe/index.js';

/** The probe statistics card, or the reason there is none. */
export function lineProbeSummaryHtml(vm, env){
  const { measurementMetrics, lineProbe } = vm;
  return lineProbe.status === 'ready' ? `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:10px">
              Line: <strong>${stage6EscAttr(stage6BishopMeasurementLabel(measurementMetrics))}</strong><br>
              Quantity: <strong>${stage6EscAttr(lineProbe.meta?.label || 'Line probe')}</strong><br>
              Valid samples: <strong>${lineProbe.stats.validCount}/${lineProbe.sampleCount}</strong>${lineProbe.coverage != null ? ` (${(100 * lineProbe.coverage).toFixed(0)}%)` : ''}<br>
              Range: <strong>${stage6EscAttr(stage6BishopLineProbeFormatValue(lineProbe.meta, lineProbe.stats.min))} to ${stage6EscAttr(stage6BishopLineProbeFormatValue(lineProbe.meta, lineProbe.stats.max))}</strong><br>
              Mean: <strong>${stage6EscAttr(stage6BishopLineProbeFormatValue(lineProbe.meta, lineProbe.stats.mean))}</strong>
              ${lineProbe.quantity === 'normalFlow' && Number.isFinite(lineProbe.netCrossFlow) ? `<br>Net cross-flow: <strong>${stage6CompactNumber(lineProbe.netCrossFlow, 3)} m³/s/m</strong><br>Absolute cross-flow: <strong>${stage6CompactNumber(lineProbe.absCrossFlow, 3)} m³/s/m</strong>` : ''}
            </div>
            ${lineProbe.quantity === 'normalFlow' ? `<div class="st6-help" style="margin-bottom:10px">Positive <strong>q_n</strong> means flow across the left side of the measurement direction A→B; reverse the measurement points if you want the sign convention flipped.</div>` : ''}
            ${lineProbe.message ? `<div class="st6-help" style="margin-bottom:10px">${stage6EscAttr(lineProbe.message)}</div>` : ''}
          `
    : `<div class="st6-help" style="margin-bottom:10px">${stage6EscAttr(lineProbe.message || 'No line probe available yet.')}</div>`;
}

/** The whole Line probe side panel — seepage and deformation only. */
export function lineProbeHtml(vm, env, fragments){
  const { bishop, workspace, measurementPoints, lineProbeOptions, lineProbe, lineProbeSelectionPath, lineProbeCopyToneColor } = vm;
  const { lineProbeSummaryHtml } = fragments;
  return workspace === 'seepage' || workspace === 'deformation' ? `
            <div class="st6-bishop-side" style="margin-top:14px">
              <div class="mc2-sec">Line probe</div>
              <div class="st6-help" style="margin-bottom:10px">The graph follows the shared measurement line without covering the canvas. Use <strong>Measure</strong> in the geometry tools to set or replace the probe line.</div>
              <label style="font-size:11px;color:var(--tx2);margin-bottom:10px;display:block">Quantity
                <select onchange="stage6BishopSetField('${lineProbeSelectionPath}', this.value)">
                  ${lineProbeOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${lineProbe.quantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                </select>
              </label>
              <div class="st6-bishop-mini-actions" style="margin-bottom:10px">
                <button class="btn sm ${bishop.tool==='measure'?'active':''}" onclick="stage6BishopSetTool('measure')">Set probe line</button>
                <button class="btn sm" onclick="stage6BishopClear('measure')" ${measurementPoints.length ? '' : 'disabled'}>Clear line</button>
                <button class="btn sm" onclick="stage6BishopCopyLineProbeData()" ${lineProbe.status === 'ready' ? '' : 'disabled'}>Copy graph data</button>
              </div>
              ${bishop.lineProbe?.copyMessage ? `<div class="st6-help" style="margin-bottom:10px;color:${lineProbeCopyToneColor}">${stage6EscAttr(bishop.lineProbe.copyMessage)}</div>` : ''}
              ${lineProbeSummaryHtml}
              ${lineProbe.status === 'ready' ? `<div style="position:relative;height:220px"><canvas id="stage6BishopLineProbeChart" role="img" aria-label="Line probe graph"></canvas></div>` : ''}
            </div>
          ` : '';
}
