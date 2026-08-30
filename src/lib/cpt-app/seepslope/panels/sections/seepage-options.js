// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/seepage-options.js — legacy-controller.js 6740-6787, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';
import { secondsLabelFromMs as stage6SecondsLabelFromMs, seepageFlowErrorLabel as stage6SeepageFlowErrorLabel } from '../../run/index.js';
import { seepageTerminationLabel as stage6BishopSeepageTerminationLabel } from '../labels.js';

/** `bishop-seepage-options` — mesh & solve settings and the solver readout. */
export function seepageOptionsSectionHtml(vm, env){
  const { seepage, seepageMeshTargetAreaAuto, seepageAutoMeshTargetArea, seepageMeshTargetArea, seepageUsesIterativeFreeSurface, seepageStatusMessage, seepageDrainInflow, seepageDrainOutflow } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-seepage-options"${stage6DetailsOpen('bishop-seepage-options')}>
              <summary>Mesh & solve</summary>
              <div class="st6-adv-body">
                <label style="font-size:11px;color:var(--tx2)">Free-surface mode
                  <select onchange="stage6BishopSetField('seepage.options.freeSurface', this.value)">
                    <option value="iterate"${seepage.options?.freeSurface==='iterate'?' selected':''}>Iterative free surface</option>
                    <option value="fixed"${seepage.options?.freeSurface==='fixed'?' selected':''}>Fixed phreatic line</option>
                  </select>
                </label>
                <label class="st6-bishop-check">
                  <input type="checkbox" ${seepageMeshTargetAreaAuto ? 'checked' : ''} onchange="stage6BishopSetField('seepage.options.meshTargetAreaAuto', this.checked)">
                  Auto size target area from the drawn geometry
                </label>
                <label style="font-size:11px;color:var(--tx2)">Target element area (m²)
                  <input type="number" step="0.01" min="0.01" value="${Number(seepageMeshTargetArea).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.meshTargetArea', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Flow-rate error target (%)
                  <input type="number" step="0.01" min="0.0001" value="${(100 * Math.max(Number(seepage.options?.flowErrorTolerance) || 0.01, 0.000001)).toFixed(3)}" onchange="stage6BishopSetField('seepage.options.flowErrorTolerance', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
                </label>
                <label style="font-size:11px;color:var(--tx2)">Max runtime (s)
                  <input type="number" step="0.1" min="0.1" value="${(Math.max(Number(seepage.options?.maxRuntimeMs) || 10000, 1) / 1000).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.maxRuntimeMs', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
                </label>
                <label class="st6-bishop-check">
                  <input type="checkbox" ${seepage.options?.usePhreaticAsSeed !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.options.usePhreaticAsSeed', this.checked)">
                  Use the drawn phreatic line as the initial wet/dry seed
                </label>
                <div class="st6-help">Iterative free surface is now the default. In iterative mode the seepage solve stops as soon as the flow-rate error target is met or the runtime limit is reached, whichever comes first. Fixed phreatic remains available when you intentionally want to lock seepage to a known phreatic line for benchmarking or sensitivity checks. The automatic target area scales from the drawn section geometry and becomes coarser for larger sections to keep the default mesh size under control. For the current section that lands around <strong>${seepageAutoMeshTargetArea.toFixed(2)} m²</strong>. Typing a value switches the mesh to manual sizing.</div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Status: <strong>${stage6EscAttr(seepageStatusMessage)}</strong><br>
                  Solver: <strong>constrained triangular FEM mesh</strong><br>
                  Nodes: <strong>${seepage.mesh?.nodes?.length || 0}</strong><br>
                  Triangles: <strong>${seepage.mesh?.elements?.length || 0}</strong><br>
                  Rendered triangles: <strong>${seepage.mesh?.cells?.length || 0}</strong><br>
                  Head range: <strong>${seepage.result ? `${seepage.result.headMin.toFixed(2)} to ${seepage.result.headMax.toFixed(2)} m` : '—'}</strong><br>
                  Through-flow: <strong>${seepage.result ? `${(seepage.result.throughFlow || 0).toExponential(2)} m³/s/m` : '—'}</strong><br>
                  Drain inflow: <strong>${seepage.result ? `${seepageDrainInflow.toExponential(2)} m³/s/m` : '—'}</strong><br>
                  Drain outflow: <strong>${seepage.result ? `${seepageDrainOutflow.toExponential(2)} m³/s/m` : '—'}</strong><br>
                  Flow-rate error target: <strong>${seepageUsesIterativeFreeSurface ? `${(100 * Math.max(Number(seepage.options?.flowErrorTolerance) || 0.01, 0.000001)).toFixed(3)} %` : 'n/a'}</strong><br>
                  Runtime cap: <strong>${seepageUsesIterativeFreeSurface ? stage6SecondsLabelFromMs(Math.max(Number(seepage.options?.maxRuntimeMs) || 10000, 1)) : 'n/a'}</strong><br>
                  Total runtime: <strong>${stage6SecondsLabelFromMs(seepage.result?.timing?.totalMs)}</strong><br>
                  Flow-rate error: <strong>${stage6SeepageFlowErrorLabel(seepage.result)}</strong><br>
                  Termination: <strong>${stage6EscAttr(stage6BishopSeepageTerminationLabel(seepage.result?.solver?.terminationReason))}</strong><br>
                  Max exit gradient: <strong>${seepage.result ? (seepage.result.maxExitGradient || 0).toFixed(3) : '—'}</strong><br>
                  Dry cells: <strong>${seepage.result?.dryCellCount || 0}</strong>
                </div>
                <div class="st6-help">The seepage solver now rebuilds the shared Bishop section into a constrained triangular mesh, solves the head field in a worker, and feeds that result back into the canvas overlays and the optional FEM pore-pressure hook.</div>
              </div>
            </details>`;
}
