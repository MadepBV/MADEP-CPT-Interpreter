// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// settlement/panel.js — the HTML string builder of the settlement app
// (01-monolith-map.md §2.9 "Render" renderStage6SettlementApp, §6.1 row `settlement/`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js (integration-r @ 07f0645 line numbers):
//   renderStage6SettlementApp 9478-9654 → settlementBodyHtml(analysis, cfg, {detailsOpen})
//     `S.stage6.settlement` → cfg; stage6DetailsOpen(key) → the host's detailsOpen hook (' open' | '');
//     stage6LoadSummaryHtml / stage6NoteHtml → core/format loadSummaryHtml / noteHtml; the four
//     stage6UseCategory* / stage6SlsCombination* builders → options.js.
// Markup byte-identical; the 16 inline `setStage6Field('settlement.…')` handlers stay the shell's.
// `analysis` is compute.js settlementAnalysis() (= stage6-engineering analyzeSettlement); the three
// canvas ids stage6SettlementStressChart / stage6SettlementCumulativeChart / stage6SettlementTimeChart
// are chart.js' SETTLEMENT_CHART_IDS.
import { loadSummaryHtml, noteHtml } from '../core/format.js';
import { slsCombinationHelp, slsCombinationOptions, useCategoryHelp, useCategoryOptions } from './options.js';

export function settlementBodyHtml(analysis, cfg, { detailsOpen = () => '' } = {}){
  const loadRows = [
    {k:'Limit state', v:'SLS'},
    {k:'Combination', v:cfg.combination === 'qp' ? 'Quasi-permanent' : cfg.combination},
    {k:'Gk', v:`${cfg.Gk.toFixed(1)} kPa`},
    {k:'Qk,lead', v:`${cfg.QLead.toFixed(1)} kPa`},
    {k:'Qk,other', v:`${cfg.QOther.toFixed(1)} kPa`},
    {k:'q_gross', v:`${analysis.qGross.toFixed(1)} kPa`},
    {k:'sigma_v(Df)', v:`${analysis.sigmaVDf.toFixed(1)} kPa`},
    {k:'q_net', v:`${analysis.qNet.toFixed(1)} kPa`}
  ];
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Settlement</span>
        <span style="font-size:11px;color:var(--tx2)">SLS settlement at the footing / slab centreline from CPT-derived E_oed with explicit stress integration below Df.</span>
      </div>
      <div style="display:grid;grid-template-columns:280px 1fr 260px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="st6-help" style="margin-bottom:8px">The reported settlement is the vertical settlement beneath the centre of the loaded area. For a strip footing this is the centreline in section; for a rectangular, square, circular footing or slab it is the middle of the footprint.</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <label style="font-size:11px;color:var(--tx2)">Footing type
              <select onchange="setStage6Field('settlement.footingType', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="strip"${cfg.footingType==='strip'?' selected':''}>Strip</option>
                <option value="rectangular"${cfg.footingType==='rectangular'?' selected':''}>Rectangular / slab</option>
                <option value="square"${cfg.footingType==='square'?' selected':''}>Square</option>
                <option value="circular"${cfg.footingType==='circular'?' selected':''}>Circular</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Width B (m)
              <input type="number" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('settlement.B', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            ${cfg.footingType==='circular' ? `
              <label style="font-size:11px;color:var(--tx2)">Diameter D (m)
                <input type="number" step="0.1" min="0.1" value="${cfg.D.toFixed(2)}" onchange="setStage6Field('settlement.D', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            ` : `
              <label style="font-size:11px;color:var(--tx2)">Length L (m)
                <input type="number" step="0.1" min="0.1" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('settlement.L', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `}
            <label style="font-size:11px;color:var(--tx2)">Founding depth Df (m)
              <input type="number" step="0.1" min="0" value="${cfg.Df.toFixed(2)}" onchange="setStage6Field('settlement.Df', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Stress spread
              <select onchange="setStage6Field('settlement.stressMethod', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="boussinesq"${cfg.stressMethod==='boussinesq'?' selected':''}>Boussinesq / Newmark</option>
                <option value="two_to_one"${cfg.stressMethod==='two_to_one'?' selected':''}>2:1 method</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Truncation rule
              <select onchange="setStage6Field('settlement.truncationRule', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="10%_sigma_eff"${cfg.truncationRule==='10%_sigma_eff'?' selected':''}>Delta sigma < 10% sigma'v0</option>
                <option value="20%_q_net"${cfg.truncationRule==='20%_q_net'?' selected':''}>Delta sigma < 20% q_net</option>
                <option value="CPT_bottom"${cfg.truncationRule==='CPT_bottom'?' selected':''}>Use CPT bottom</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Sub-layer dz (m)
              <input type="number" step="0.05" min="0.05" value="${cfg.dz.toFixed(2)}" onchange="setStage6Field('settlement.dz', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Target allowable settlement (mm)
              <input type="number" step="1" min="1" value="${cfg.allowableSettlement.toFixed(0)}" onchange="setStage6Field('settlement.allowableSettlement', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px">
              <input type="checkbox" ${cfg.includeTime?'checked':''} onchange="setStage6Field('settlement.includeTime', this.checked)">
              Show settlement time curve
            </label>
            ${cfg.includeTime ? `
              <label style="font-size:11px;color:var(--tx2)">Time horizon (days)
                <input type="number" step="10" min="1" value="${cfg.timeDays.toFixed(0)}" onchange="setStage6Field('settlement.timeDays', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            <details class="st6-adv" data-st6details="settlement-loads"${detailsOpen('settlement-loads')}>
              <summary>Load assumptions and Eurocode combination</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Only expand this if you want to change the serviceability load assumptions. The default is the quasi-permanent SLS combination, which is usually the right starting point for long-term settlement.</div>
                <label style="font-size:11px;color:var(--tx2)">SLS combination
                  <select onchange="setStage6Field('settlement.combination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${slsCombinationOptions(cfg.combination)}
                  </select>
                </label>
                <div class="st6-help">${slsCombinationHelp(cfg.combination, 'settlement')}</div>
                <label style="font-size:11px;color:var(--tx2)">Load category for Eurocode ψ-factors
                  <select onchange="setStage6Field('settlement.useCategory', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${useCategoryOptions(cfg.useCategory)}
                  </select>
                </label>
                <div class="st6-help">${useCategoryHelp(cfg.useCategory)}</div>
                <label style="font-size:11px;color:var(--tx2)">Permanent stress Gk (kPa)
                  <input type="number" step="5" min="0" value="${cfg.Gk.toFixed(1)}" onchange="setStage6Field('settlement.Gk', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Leading variable load Qk (kPa)
                  <input type="number" step="5" min="0" value="${cfg.QLead.toFixed(1)}" onchange="setStage6Field('settlement.QLead', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Other variable loads together (kPa)
                  <input type="number" step="5" min="0" value="${cfg.QOther.toFixed(1)}" onchange="setStage6Field('settlement.QOther', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
              </div>
            </details>
          </div>
        </div>
        <div>
          <div style="display:grid;grid-template-columns:1fr;gap:12px">
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Stress increase Delta sigma_v vs depth</div>
              <div style="position:relative;height:180px"><canvas id="stage6SettlementStressChart" role="img" aria-label="Settlement stress increase versus depth"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Cumulative settlement vs depth</div>
              <div style="position:relative;height:180px"><canvas id="stage6SettlementCumulativeChart" role="img" aria-label="Cumulative settlement versus depth"></canvas></div>
            </div>
            ${analysis.timeCurve ? `
              <div>
                <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Indicative settlement time curve</div>
                <div style="position:relative;height:180px"><canvas id="stage6SettlementTimeChart" role="img" aria-label="Settlement time curve"></canvas></div>
              </div>
            `:''}
          </div>
        </div>
        <div>
          <table class="pt" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:700;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Summary</td></tr>
            <tr><td>Total settlement</td><td>${analysis.totalSettlementMm.toFixed(1)} mm</td></tr>
            <tr><td>Target allowable</td><td>${cfg.allowableSettlement.toFixed(1)} mm</td></tr>
            <tr><td>Utilisation</td><td>${(analysis.totalSettlementMm/Math.max(cfg.allowableSettlement,1)).toFixed(2)}</td></tr>
            <tr><td>q_gross</td><td>${analysis.qGross.toFixed(1)} kPa</td></tr>
            <tr><td>q_net</td><td>${analysis.qNet.toFixed(1)} kPa</td></tr>
            <tr><td>Df</td><td>${analysis.Df.toFixed(2)} m</td></tr>
            <tr><td>Truncation</td><td>${analysis.truncationCause}</td></tr>
            <tr><td>z_trunc</td><td>${analysis.truncationDepth.toFixed(2)} m</td></tr>
            <tr><td>Sublayers used</td><td>${analysis.sublayers.length}</td></tr>
          </table>
        </div>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${loadSummaryHtml('Load combination audit', loadRows)}
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Formula used</div>
          <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
            Delta eps = Delta sigma_v / E_oed(sigma_mean)<br>
            Delta S = Sum(Delta eps * Delta z)
          </div>
          <div style="font-size:11px;color:var(--tx2);line-height:1.55">
            Evaluation point = <strong>centre of loaded area</strong><br>
            Stress method = <strong>${cfg.stressMethod === 'two_to_one' ? '2:1 spread beneath centreline' : 'Boussinesq / Newmark centreline'}</strong><br>
            Soil route = <strong>Characteristic E_oed,ref and m</strong><br>
            Load route = <strong>SLS ${cfg.combination === 'qp' ? 'quasi-permanent' : cfg.combination}</strong><br>
            Truncation = <strong>${analysis.truncationCause}</strong>
          </div>
        </div>
      </div>
      <div class="mc2" style="margin-top:14px">
        <div class="mc2-sec">Per layer contribution</div>
        <table class="tbl">
          <thead><tr><th>Layer</th><th>Type</th><th>Top-Bot (m)</th><th>Thickness (m)</th><th>Settlement (mm)</th></tr></thead>
          <tbody>
            ${analysis.perLayer.map(row=>`<tr><td>${row.layerIndex+1}</td><td>${row.type}</td><td>${row.top.toFixed(2)}-${row.bot.toFixed(2)}</td><td>${row.thickness.toFixed(2)}</td><td>${row.settlementMm.toFixed(2)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="mc2" style="margin-top:14px">
        <div class="mc2-sec">Audit sublayers</div>
        <div style="max-height:320px;overflow:auto">
          <table class="tbl">
            <thead><tr><th>z_mid</th><th>Layer</th><th>sigma'v0</th><th>Delta sigma</th><th>sigma'mean</th><th>E_oed</th><th>Delta S</th></tr></thead>
            <tbody>
              ${analysis.sublayers.map(row=>`<tr><td>${row.zMid.toFixed(2)}</td><td>${row.layerIndex+1}</td><td>${row.sigmaEff0.toFixed(1)}</td><td>${row.deltaSigmaV.toFixed(1)}</td><td>${row.sigmaMean.toFixed(1)}</td><td>${row.Eoed.toFixed(0)}</td><td>${row.dSmm.toFixed(3)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ${noteHtml(analysis.notes)}
    </div>
  `;
}
