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
// PR 13 (style, 02-design-system.md §5.2 row 2e) replaced the class attributes and inline styles with the
// component vocabulary of src/lib/styles/components.css; the 16 inline `setStage6Field('dewatering.…')`
// handlers, the four canvas ids stage6Dewatering{Drawdown,Stress,Settlement,Time}Chart (chart.js'
// DEWATERING_CHART_IDS) and every visible string are unchanged.
// `analysis` is compute.js dewateringAnalysis() (= stage6-engineering analyzeDewatering).
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
    <div class="mc2 card st6-app stack">
      <div class="card__head card__head--stack">
        <span class="card__title">Dewatering impact</span>
        <span class="card__text">Hydrogeological screening plus stress and settlement response at the CPT location.</span>
      </div>
      <div class="cols-3">
        <div>
          <div class="card__eyebrow">Inputs</div>
          <div class="fields fields--stack">
            <label class="field-stack">Combination context
              <select class="input" onchange="setStage6Field('dewatering.combination', this.value)">
                ${combinationOptions(cfg.combination)}
              </select>
            </label>
            <div class="card card--quiet card--note">${combinationHelp(cfg.combination)}</div>
            <label class="field-stack">Target water table at well / excavation (m below ground)
              <input type="number" class="input input--num" step="0.1" min="${wt.toFixed(2)}" value="${cfg.targetWt.toFixed(2)}" onchange="setStage6Field('dewatering.targetWt', this.value)">
            </label>
            <label class="field-stack">Geometry
              <select class="input" onchange="setStage6Field('dewatering.geometry', this.value)">
                <option value="single_well"${cfg.geometry==='single_well'?' selected':''}>Single well</option>
                <option value="equivalent_well_rectangular_excavation"${cfg.geometry==='equivalent_well_rectangular_excavation'?' selected':''}>Equivalent well excavation</option>
                <option value="line_dewatering_trench"${cfg.geometry==='line_dewatering_trench'?' selected':''}>Line dewatering trench</option>
              </select>
            </label>
            <label class="field-stack">Aquifer type
              <select class="input" onchange="setStage6Field('dewatering.aquiferType', this.value)">
                <option value="unconfined"${cfg.aquiferType==='unconfined'?' selected':''}>Unconfined</option>
                <option value="confined"${cfg.aquiferType==='confined'?' selected':''}>Confined</option>
              </select>
            </label>
            ${cfg.geometry==='single_well' ? `
              <label class="field-stack">Well radius rw (m)
                <input type="number" class="input input--num" step="0.05" min="0.05" value="${cfg.rw.toFixed(2)}" onchange="setStage6Field('dewatering.rw', this.value)">
              </label>
              <label class="field-stack">Distance well-CPT (m)
                <input type="number" class="input input--num" step="0.5" min="0" value="${cfg.rCPT.toFixed(2)}" onchange="setStage6Field('dewatering.rCPT', this.value)">
              </label>
            `:''}
            ${cfg.geometry==='equivalent_well_rectangular_excavation' ? `
              <label class="field-stack">Pit length L (m)
                <input type="number" class="input input--num" step="0.5" min="0.5" value="${cfg.LPit.toFixed(2)}" onchange="setStage6Field('dewatering.LPit', this.value)">
              </label>
              <label class="field-stack">Pit width B (m)
                <input type="number" class="input input--num" step="0.5" min="0.5" value="${cfg.BPit.toFixed(2)}" onchange="setStage6Field('dewatering.BPit', this.value)">
              </label>
              <label class="field-stack">Centroid-CPT distance (m)
                <input type="number" class="input input--num" step="0.5" min="0" value="${cfg.rCPT.toFixed(2)}" onchange="setStage6Field('dewatering.rCPT', this.value)">
              </label>
              <div class="card card--quiet card--note">The rectangular excavation is converted to an equivalent circular well using the same plan area. The drawdown curve is then evaluated at the CPT distance from the excavation centroid.</div>
            `:''}
            ${cfg.geometry==='line_dewatering_trench' ? `
              <label class="field-stack">Trench length (m)
                <input type="number" class="input input--num" step="0.5" min="1" value="${cfg.LTrench.toFixed(2)}" onchange="setStage6Field('dewatering.LTrench', this.value)">
              </label>
              <label class="field-stack">Perpendicular CPT distance (m)
                <input type="number" class="input input--num" step="0.5" min="0" value="${cfg.distanceToCPT.toFixed(2)}" onchange="setStage6Field('dewatering.distanceToCPT', this.value)">
              </label>
            `:''}
            <label class="field-stack">Sichardt coefficient C
              <input type="number" class="input input--num" step="100" min="100" value="${cfg.CSichardt.toFixed(0)}" onchange="setStage6Field('dewatering.CSichardt', this.value)">
            </label>
            <label class="field-stack">Total stress mode
              <select class="input" onchange="setStage6Field('dewatering.sigmaVMode', this.value)">
                <option value="conservative"${cfg.sigmaVMode==='conservative'?' selected':''}>Conservative sigma_v fixed</option>
                <option value="realistic"${cfg.sigmaVMode==='realistic'?' selected':''}>Realistic gamma_sat to gamma</option>
              </select>
            </label>
            <div class="card card--quiet card--note">Conservative keeps the total overburden stress profile unchanged and only lowers pore pressure. Realistic also reduces total stress in the zone that changes from saturated to unsaturated, by switching from γ_sat to γ.</div>
            <label class="field-stack">Aquifer base depth (m, optional)
              <input type="number" class="input input--num" step="0.5" min="0.5" value="${cfg.aquiferBaseDepth!=null?cfg.aquiferBaseDepth.toFixed(2):''}" onchange="setStage6Field('dewatering.aquiferBaseDepth', this.value)" placeholder="defaults to CPT bottom">
            </label>
            <label class="field-stack">Sub-layer dz (m)
              <input type="number" class="input input--num" step="0.05" min="0.05" value="${cfg.dz.toFixed(2)}" onchange="setStage6Field('dewatering.dz', this.value)">
            </label>
            <label class="field-stack">Time horizon for settlement curve (days, optional)
              <input type="number" class="input input--num" step="10" min="0" value="${cfg.timeDays.toFixed(0)}" onchange="setStage6Field('dewatering.timeDays', this.value)">
            </label>
          </div>
        </div>
        <div>
          <div class="stack">
            <div class="viz">
              <div class="viz__label">Estimated phreatic level profile from source to CPT</div>
              <div class="viz__body" style="--viz-h:170px"><canvas id="stage6DewateringDrawdownChart" role="img" aria-label="Drawdown profile"></canvas></div>
            </div>
            <div class="viz">
              <div class="viz__label">Effective stress before / after drawdown</div>
              <div class="viz__body" style="--viz-h:170px"><canvas id="stage6DewateringStressChart" role="img" aria-label="Effective stress profile"></canvas></div>
            </div>
            <div class="viz">
              <div class="viz__label">Total settlement versus distance from source</div>
              <div class="viz__body" style="--viz-h:170px"><canvas id="stage6DewateringSettlementChart" role="img" aria-label="Dewatering settlement versus distance"></canvas></div>
            </div>
            ${analysis.timeCurve ? `
              <div class="viz">
                <div class="viz__label">Indicative settlement time curve</div>
                <div class="viz__body" style="--viz-h:170px"><canvas id="stage6DewateringTimeChart" role="img" aria-label="Dewatering settlement time curve"></canvas></div>
              </div>
            `:''}
          </div>
        </div>
        <div class="stack--tight">
          <table class="tbl tbl--kv">
            <tr class="tbl__sec"><td colspan="2">Summary</td></tr>
            <tr><td>New WT at CPT</td><td>${analysis.newWtAtCpt.toFixed(2)} m</td></tr>
            <tr class="key"><td>Drawdown at CPT</td><td>${analysis.drawdownAtCpt.toFixed(2)} m</td></tr>
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
            <tr class="key"><td>Total settlement</td><td>${analysis.totalSettlementMm.toFixed(1)} mm</td></tr>
          </table>
          <div class="card card--quiet card--note">Dewatering impact is treated as an SLS deformation screening tool. Use the expected drawdown directly; this module does not apply DA1/1 or DA1/2 style load factoring.</div>
          <div class="card card--quiet card--note">Hydraulics are screened with a transmissivity-based model. The app combines the active layer conductivities into <strong>T = Σ(k_h · b)</strong> through the pumped interval and uses that profile in the radial or line-flow estimate.</div>
          <div class="card card--quiet card--note">Important: settlement is driven by the <strong>drawdown at the CPT location</strong>, not by the target level at the well or excavation itself. If the CPT sits outside the computed screening influence radius, the module will show little or no settlement.</div>
        </div>
      </div>
      <div class="cols-2">
        ${loadSummaryHtml('Hydraulic screening inputs', loadRows)}
        <div class="card card--quiet">
          <div class="card__eyebrow">Formula route</div>
          <div class="formula">
            R = C · s · sqrt(k)<br>
            h²(r) = h_w² + Q / (pi·k) · ln(r / r_w) &nbsp; (radial, unconfined)<br>
            Delta eps = Delta sigma' / E_oed(sigma_mean)
          </div>
          <div class="card__text">
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
      <div>
        <div class="card__eyebrow">Per layer settlement contribution</div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th class="num">Layer</th><th>Type</th><th class="num">Top-Bot (m)</th><th class="num">Settlement (mm)</th></tr></thead>
            <tbody>${analysis.perLayer.map(row=>`<tr><td class="num">${row.layerIndex+1}</td><td>${row.type}</td><td class="num">${row.top.toFixed(2)}-${row.bot.toFixed(2)}</td><td class="num">${row.settlementMm.toFixed(2)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      ${noteHtml(analysis.notes)}
    </div>
  `;
}
