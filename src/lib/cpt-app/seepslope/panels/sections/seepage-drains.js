// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/seepage-drains.js — legacy-controller.js 6712-6739, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';
import { drainValidationSummary as stage6BishopDrainValidationSummary } from '../../state/index.js';

/** `bishop-seepage-drains` — the drain tools, validation and table. */
export function seepageDrainsSectionHtml(vm, env){
  const { bishop, model, drainValidation, drainRows, drainValidationHtml } = vm;
  const { stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-seepage-drains"${stage6DetailsOpen('bishop-seepage-drains')}>
              <summary>Drains</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Draw an interior drain as a line in the shared canvas. After the second click, set the constant drain head in the selected row below. Per-vertex and invert-plus head modes remain disabled for this v1 plumbing phase.</div>
                <div class="st6-bishop-tools">
                  <button class="btn sm ${bishop.tool==='drain'?'active':''}" onclick="stage6BishopSetTool('drain')" ${model ? '' : 'disabled'}>Draw drain line</button>
                  <button class="btn sm" onclick="stage6BishopFinishDraft()" ${(bishop.draftKind==='drain' && bishop.draft.length >= 2) ? '' : 'disabled'}>Finish drain</button>
                  <button class="btn sm" onclick="stage6BishopClear('drains')" ${(bishop.drains || []).length ? '' : 'disabled'}>Clear drains</button>
                </div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Drains: <strong>${(bishop.drains || []).length}</strong><br>
                  Validation: <strong>${stage6EscAttr(stage6BishopDrainValidationSummary(drainValidation))}</strong>
                </div>
                ${drainValidationHtml.length ? `
                  <div style="display:grid;gap:6px">
                    ${drainValidationHtml.map((issue)=>`
                      <div class="info" style="background:${issue.level === 'warn' ? 'var(--wnl)' : 'var(--bg2)'};border-color:${issue.level === 'warn' ? 'var(--wn)' : 'var(--bd2)'};margin:0">${stage6EscAttr(issue.text)}</div>
                    `).join('')}
                  </div>
                ` : ''}
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Label</th><th>Vertices</th><th>Head h</th><th>Gating</th><th>Length</th><th></th><th></th></tr></thead>
                    <tbody>${drainRows || '<tr><td colspan="7" style="text-align:center;color:var(--tx2)">No drains yet. Use Draw drain line, then click a start and end point on the canvas.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </details>`;
}
