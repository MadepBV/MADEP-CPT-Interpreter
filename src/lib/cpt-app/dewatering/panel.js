// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// dewatering/panel.js — the HTML string builder of the dewatering app
// (01-monolith-map.md §2.9 "Render" renderStage6DewateringApp, §6.1 row `dewatering/`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js (integration-r @ 07f0645 line numbers):
//   renderStage6DewateringApp 9656-9832 → dewateringBodyHtml(analysis, cfg, env)
//     `S.stage6.dewatering` → cfg; the two `S.wt` reads (the "Original WT" audit row and the `min`
//     of the target-water-table input) → env.wt, read once through waterTableOf (compute.js: explicit,
//     finite, no fallback); stage6LoadSummaryHtml / stage6NoteHtml → core/format; the two
//     stage6DewateringCombination* builders → options.js.
// Markup byte-identical; the 16 inline `setStage6Field('dewatering.…')` handlers stay the shell's.
// `analysis` is compute.js dewateringAnalysis() (= stage6-engineering analyzeDewatering); the four
// canvas ids stage6Dewatering{Drawdown,Stress,Settlement,Time}Chart are chart.js' DEWATERING_CHART_IDS.
import { loadSummaryHtml, noteHtml } from '../core/format.js';
import { waterTableOf } from './compute.js';
import { combinationHelp, combinationOptions } from './options.js';

export function dewateringBodyHtml(analysis, cfg, env){
  const wt = waterTableOf(env, 'dewateringBodyHtml');
  const loadRows = [
    {k:'Limit state', v:'SLS'},
    {k:'Combination', v:cfg.combination === 'qp' ? 'Quasi-permanent drawdown context' : 'Characteristic drawdown'},
    {k:'Hydraulic model', v:analysis.hydraulicModel},
    {k:'Geometry', v:analysis.geometry.label},
    {k:'Original WT', v:`${wt.toFixed(2)} m`},
    {k:'Target WT at well', v:`${analysis.targetWt.toFixed(2)} m`},
    {k:'WT at CPT', v:`${analysis.newWtAtCpt.toFixed(2)} m`},
    {k:'Drawdown at CPT', v:`${analysis.drawdownAtCpt.toFixed(2)} m`},
    {k:analysis.geometry.distanceLabel || 'Source-CPT distance', v:`${(analysis.geometry.distanceToCpt || 0).toFixed(2)} m`},
    ...(analysis.geometry.wellRadius ? [{k:analysis.geometry.equivalentRadiusLabel || 'Well radius', v:`${analysis.geometry.wellRadius.toFixed(2)} m`}] : []),
    {k:'T far field', v:`${analysis.transmissivityFar.toExponential(2)} m²/s`},
    {k:'T at well', v:`${analysis.transmissivityWell.toExponential(2)} m²/s`},
    {k:'k_eff,h', v:`${analysis.effectiveK.toExponential(2)} m/s`},
    {k:'R', v:`${analysis.radiusInfluence.toFixed(1)} m`}
  ];
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Dewatering impact</span>
        <span style="font-size:11px;color:var(--tx2)">Hydrogeological screening plus stress and settlement response at the CPT location.</span>
      </div>
      <div style="display:grid;grid-template-columns:280px 1fr 260px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <label style="font-size:11px;color:var(--tx2)">Combination context
              <select onchange="setStage6Field('dewatering.combination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                ${combinationOptions(cfg.combination)}
              </select>
            </label>
            <div class="st6-help">${combinationHelp(cfg.combination)}</div>
            <label style="font-size:11px;color:var(--tx2)">Target water table at well / excavation (m below ground)
              <input type="number" step="0.1" min="${wt.toFixed(2)}" value="${cfg.targetWt.toFixed(2)}" onchange="setStage6Field('dewatering.targetWt', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Geometry
              <select onchange="setStage6Field('dewatering.geometry', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="single_well"${cfg.geometry==='single_well'?' selected':''}>Single well</option>
                <option value="equivalent_well_rectangular_excavation"${cfg.geometry==='equivalent_well_rectangular_excavation'?' selected':''}>Equivalent well excavation</option>
                <option value="line_dewatering_trench"${cfg.geometry==='line_dewatering_trench'?' selected':''}>Line dewatering trench</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Aquifer type
              <select onchange="setStage6Field('dewatering.aquiferType', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="unconfined"${cfg.aquiferType==='unconfined'?' selected':''}>Unconfined</option>
                <option value="confined"${cfg.aquiferType==='confined'?' selected':''}>Confined</option>
              </select>
            </label>
            ${cfg.geometry==='single_well' ? `
              <label style="font-size:11px;color:var(--tx2)">Well radius rw (m)
                <input type="number" step="0.05" min="0.05" value="${cfg.rw.toFixed(2)}" onchange="setStage6Field('dewatering.rw', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Distance well-CPT (m)
                <input type="number" step="0.5" min="0" value="${cfg.rCPT.toFixed(2)}" onchange="setStage6Field('dewatering.rCPT', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            ${cfg.geometry==='equivalent_well_rectangular_excavation' ? `
              <label style="font-size:11px;color:var(--tx2)">Pit length L (m)
                <input type="number" step="0.5" min="0.5" value="${cfg.LPit.toFixed(2)}" onchange="setStage6Field('dewatering.LPit', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Pit width B (m)
                <input type="number" step="0.5" min="0.5" value="${cfg.BPit.toFixed(2)}" onchange="setStage6Field('dewatering.BPit', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Centroid-CPT distance (m)
                <input type="number" step="0.5" min="0" value="${cfg.rCPT.toFixed(2)}" onchange="setStage6Field('dewatering.rCPT', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <div class="st6-help">The rectangular excavation is converted to an equivalent circular well using the same plan area. The drawdown curve is then evaluated at the CPT distance from the excavation centroid.</div>
            `:''}
            ${cfg.geometry==='line_dewatering_trench' ? `
              <label style="font-size:11px;color:var(--tx2)">Trench length (m)
                <input type="number" step="0.5" min="1" value="${cfg.LTrench.toFixed(2)}" onchange="setStage6Field('dewatering.LTrench', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Perpendicular CPT distance (m)
                <input type="number" step="0.5" min="0" value="${cfg.distanceToCPT.toFixed(2)}" onchange="setStage6Field('dewatering.distanceToCPT', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            <label style="font-size:11px;color:var(--tx2)">Sichardt coefficient C
              <input type="number" step="100" min="100" value="${cfg.CSichardt.toFixed(0)}" onchange="setStage6Field('dewatering.CSichardt', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Total stress mode
              <select onchange="setStage6Field('dewatering.sigmaVMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="conservative"${cfg.sigmaVMode==='conservative'?' selected':''}>Conservative sigma_v fixed</option>
                <option value="realistic"${cfg.sigmaVMode==='realistic'?' selected':''}>Realistic gamma_sat to gamma</option>
              </select>
            </label>
            <div class="st6-help">Conservative keeps the total overburden stress profile unchanged and only lowers pore pressure. Realistic also reduces total stress in the zone that changes from saturated to unsaturated, by switching from γ_sat to γ.</div>
            <label style="font-size:11px;color:var(--tx2)">Aquifer base depth (m, optional)
              <input type="number" step="0.5" min="0.5" value="${cfg.aquiferBaseDepth!=null?cfg.aquiferBaseDepth.toFixed(2):''}" onchange="setStage6Field('dewatering.aquiferBaseDepth', this.value)" placeholder="defaults to CPT bottom" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Sub-layer dz (m)
              <input type="number" step="0.05" min="0.05" value="${cfg.dz.toFixed(2)}" onchange="setStage6Field('dewatering.dz', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Time horizon for settlement curve (days, optional)
              <input type="number" step="10" min="0" value="${cfg.timeDays.toFixed(0)}" onchange="setStage6Field('dewatering.timeDays', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
          </div>
        </div>
        <div>
          <div style="display:grid;grid-template-columns:1fr;gap:12px">
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Estimated phreatic level profile from source to CPT</div>
              <div style="position:relative;height:170px"><canvas id="stage6DewateringDrawdownChart" role="img" aria-label="Drawdown profile"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Effective stress before / after drawdown</div>
              <div style="position:relative;height:170px"><canvas id="stage6DewateringStressChart" role="img" aria-label="Effective stress profile"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Total settlement versus distance from source</div>
              <div style="position:relative;height:170px"><canvas id="stage6DewateringSettlementChart" role="img" aria-label="Dewatering settlement versus distance"></canvas></div>
            </div>
            ${analysis.timeCurve ? `
              <div>
                <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Indicative settlement time curve</div>
                <div style="position:relative;height:170px"><canvas id="stage6DewateringTimeChart" role="img" aria-label="Dewatering settlement time curve"></canvas></div>
              </div>
            `:''}
          </div>
        </div>
        <div>
          <table class="pt" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:700;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Summary</td></tr>
            <tr><td>New WT at CPT</td><td>${analysis.newWtAtCpt.toFixed(2)} m</td></tr>
            <tr><td>Drawdown at CPT</td><td>${analysis.drawdownAtCpt.toFixed(2)} m</td></tr>
            <tr><td>${analysis.geometry.distanceLabel || 'Source-CPT distance'}</td><td>${(analysis.geometry.distanceToCpt || 0).toFixed(2)} m</td></tr>
            ${analysis.geometry.wellRadius ? `<tr><td>${analysis.geometry.equivalentRadiusLabel || 'Well radius'}</td><td>${analysis.geometry.wellRadius.toFixed(2)} m</td></tr>` : ''}
            <tr><td>R influence</td><td>${analysis.radiusInfluence.toFixed(1)} m</td></tr>
            <tr><td>Q estimate</td><td>${analysis.QEstimate.toExponential(2)} ${analysis.QUnits}</td></tr>
            ${analysis.qPrime ? `<tr><td>q' estimate</td><td>${analysis.qPrime.toExponential(2)} ${analysis.qPrimeUnits}</td></tr>`:''}
            <tr><td>Aquifer base</td><td>${analysis.baseDepth.toFixed(2)} m</td></tr>
            <tr><td>Hydraulic model</td><td>${analysis.hydraulicModel}</td></tr>
            <tr><td>T far field</td><td>${analysis.transmissivityFar.toExponential(2)} m²/s</td></tr>
            <tr><td>T at well</td><td>${analysis.transmissivityWell.toExponential(2)} m²/s</td></tr>
            <tr><td>k_eff,h</td><td>${analysis.effectiveK.toExponential(2)} m/s</td></tr>
            <tr><td>Conservative settlement</td><td>${analysis.conservativeSettlementMm.toFixed(2)} mm</td></tr>
            <tr><td>Realistic settlement</td><td>${analysis.realisticSettlementMm.toFixed(2)} mm</td></tr>
            <tr><td>Max Δσv mode effect</td><td>${analysis.maxSigmaVShift.toFixed(1)} kPa</td></tr>
            <tr><td>Total settlement</td><td>${analysis.totalSettlementMm.toFixed(1)} mm</td></tr>
          </table>
          <div class="st6-help" style="margin-bottom:8px">Dewatering impact is treated as an SLS deformation screening tool. Use the expected drawdown directly; this module does not apply DA1/1 or DA1/2 style load factoring.</div>
          <div class="st6-help" style="margin-bottom:8px">Hydraulics are screened with a transmissivity-based model. The app combines the active layer conductivities into <strong>T = Σ(k_h · b)</strong> through the pumped interval and uses that profile in the radial or line-flow estimate.</div>
          <div class="st6-help">Important: settlement is driven by the <strong>drawdown at the CPT location</strong>, not by the target level at the well or excavation itself. If the CPT sits outside the computed screening influence radius, the module will show little or no settlement.</div>
        </div>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${loadSummaryHtml('Hydraulic screening inputs', loadRows)}
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Formula route</div>
          <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
            R = C · s · sqrt(k)<br>
            h²(r) = h_w² + Q / (pi·k) · ln(r / r_w) &nbsp; (radial, unconfined)<br>
            Delta eps = Delta sigma' / E_oed(sigma_mean)
          </div>
          <div style="font-size:11px;color:var(--tx2);line-height:1.55">
            Geometry = <strong>${analysis.geometry.label}</strong><br>
            Aquifer type = <strong>${cfg.aquiferType}</strong><br>
            Distance axis = <strong>${analysis.geometry.geometry === 'line_dewatering_trench' ? 'perpendicular distance from trench' : 'radial distance from well centre / excavation centroid'}</strong><br>
            Settlement-distance curve = <strong>total settlement predicted at each x-location</strong><br>
            Total stress mode = <strong>${cfg.sigmaVMode}</strong><br>
            Settlement limit state = <strong>SLS only</strong><br>
            Combination route = <strong>${cfg.combination === 'qp' ? 'Quasi-permanent context, no γ factors' : 'Characteristic drawdown, no γ factors'}</strong>
          </div>
        </div>
      </div>
      <div class="mc2" style="margin-top:14px">
        <div class="mc2-sec">Per layer settlement contribution</div>
        <table class="tbl">
          <thead><tr><th>Layer</th><th>Type</th><th>Top-Bot (m)</th><th>Settlement (mm)</th></tr></thead>
          <tbody>${analysis.perLayer.map(row=>`<tr><td>${row.layerIndex+1}</td><td>${row.type}</td><td>${row.top.toFixed(2)}-${row.bot.toFixed(2)}</td><td>${row.settlementMm.toFixed(2)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      ${noteHtml(analysis.notes)}
    </div>
  `;
}
