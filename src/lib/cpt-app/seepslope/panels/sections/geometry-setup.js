// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/geometry-setup.js — legacy-controller.js 8082-8113, verbatim.
import { escAttr as stage6EscAttr } from '../../../core/format.js';

/** `bishop-geo-setup` — CPT / phreatic / drain / wall / zone tools and the Measure probe. */
export function geometrySetupSectionHtml(vm, env){
  const { bishop, workspace, measurementStatus } = vm;
  const { stage6DetailsOpen } = env;
  return `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-setup"${stage6DetailsOpen('bishop-geo-setup')}>
                <summary>Section setup</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-tool-grid">
                    <div class="st6-bishop-tool-group">
                      <div class="st6-bishop-tool-title">Draw</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='cpt'?'active':''}" onclick="stage6BishopSetTool('cpt')">Place CPT</button>
                        <button class="btn sm ${bishop.tool==='phreatic'?'active':''}" onclick="stage6BishopSetTool('phreatic')">Phreatic line</button>
                        <button class="btn sm ${bishop.tool==='drain'?'active':''}" onclick="stage6BishopSetTool('drain')">Drain</button>
                        <button class="btn sm ${bishop.tool==='wall'?'active':''}" onclick="stage6BishopSetTool('wall')">Retaining wall</button>
                        <button class="btn sm ${bishop.tool==='entry'?'active':''}" onclick="stage6BishopSetTool('entry')">Entry zone</button>
                        <button class="btn sm ${bishop.tool==='exit'?'active':''}" onclick="stage6BishopSetTool('exit')">Exit zone</button>
                        <button class="btn sm ${bishop.tool==='load'?'active':''}" onclick="stage6BishopSetTool('load')">Load zone</button>
                      </div>
                    </div>
                    <div class="st6-bishop-tool-group">
                      <div class="st6-bishop-tool-title">Edit</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='edit'?'active':''}" onclick="stage6BishopSetTool('edit')">Edit / pan</button>
                      </div>
                    </div>
                    <div class="st6-bishop-tool-group st6-bishop-tool-group-muted">
                      <div class="st6-bishop-tool-title">Probe</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='measure'?'active':''}" onclick="stage6BishopSetTool('measure')">Measure</button>
                      </div>
                      <div class="st6-help">Measurement line: <strong>${stage6EscAttr(measurementStatus)}</strong>${workspace === 'seepage' ? '<br>Boundary assignment lives in the seepage boundary-conditions section below.' : ''}</div>
                    </div>
                  </div>
                </div>
              </details>`;
}
