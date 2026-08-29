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
// PR 13 (style, 02-design-system.md §5.2 row 2e) replaced the class attributes and inline styles with the
// component vocabulary of src/lib/styles/components.css; the 16 inline `setStage6Field('settlement.…')`
// handlers, the three canvas ids stage6SettlementStressChart / stage6SettlementCumulativeChart /
// stage6SettlementTimeChart (chart.js' SETTLEMENT_CHART_IDS) and every visible string are unchanged.
// `analysis` is compute.js settlementAnalysis() (= stage6-engineering analyzeSettlement).
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
    <div class="mc2 card st6-app stack">
      <div class="card__head card__head--stack">
        <span class="card__title">Settlement</span>
        <span class="card__text">SLS settlement at the footing / slab centreline from CPT-derived E_oed with explicit stress integration below Df.</span>
      </div>
      <div class="cols-3">
        <div class="stack--tight">
          <div class="card__eyebrow">Inputs</div>
          <div class="card card--quiet card--note">The reported settlement is the vertical settlement beneath the centre of the loaded area. For a strip footing this is the centreline in section; for a rectangular, square, circular footing or slab it is the middle of the footprint.</div>
          <div class="fields fields--stack">
            <label class="field-stack">Footing type
              <select class="input" onchange="setStage6Field('settlement.footingType', this.value)">
                <option value="strip"${cfg.footingType==='strip'?' selected':''}>Strip</option>
                <option value="rectangular"${cfg.footingType==='rectangular'?' selected':''}>Rectangular / slab</option>
                <option value="square"${cfg.footingType==='square'?' selected':''}>Square</option>
                <option value="circular"${cfg.footingType==='circular'?' selected':''}>Circular</option>
              </select>
            </label>
            <label class="field-stack">Width B (m)
              <input type="number" class="input input--num" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('settlement.B', this.value)">
            </label>
            ${cfg.footingType==='circular' ? `
              <label class="field-stack">Diameter D (m)
                <input type="number" class="input input--num" step="0.1" min="0.1" value="${cfg.D.toFixed(2)}" onchange="setStage6Field('settlement.D', this.value)">
              </label>
            ` : `
              <label class="field-stack">Length L (m)
                <input type="number" class="input input--num" step="0.1" min="0.1" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('settlement.L', this.value)">
              </label>
            `}
            <label class="field-stack">Founding depth Df (m)
              <input type="number" class="input input--num" step="0.1" min="0" value="${cfg.Df.toFixed(2)}" onchange="setStage6Field('settlement.Df', this.value)">
            </label>
            <label class="field-stack">Stress spread
              <select class="input" onchange="setStage6Field('settlement.stressMethod', this.value)">
                <option value="boussinesq"${cfg.stressMethod==='boussinesq'?' selected':''}>Boussinesq / Newmark</option>
                <option value="two_to_one"${cfg.stressMethod==='two_to_one'?' selected':''}>2:1 method</option>
              </select>
            </label>
            <label class="field-stack">Truncation rule
              <select class="input" onchange="setStage6Field('settlement.truncationRule', this.value)">
                <option value="10%_sigma_eff"${cfg.truncationRule==='10%_sigma_eff'?' selected':''}>Delta sigma < 10% sigma'v0</option>
                <option value="20%_q_net"${cfg.truncationRule==='20%_q_net'?' selected':''}>Delta sigma < 20% q_net</option>
                <option value="CPT_bottom"${cfg.truncationRule==='CPT_bottom'?' selected':''}>Use CPT bottom</option>
              </select>
            </label>
            <label class="field-stack">Sub-layer dz (m)
              <input type="number" class="input input--num" step="0.05" min="0.05" value="${cfg.dz.toFixed(2)}" onchange="setStage6Field('settlement.dz', this.value)">
            </label>
            <label class="field-stack">Target allowable settlement (mm)
              <input type="number" class="input input--num" step="1" min="1" value="${cfg.allowableSettlement.toFixed(0)}" onchange="setStage6Field('settlement.allowableSettlement', this.value)">
            </label>
            <label class="check check--row">
              <input type="checkbox" ${cfg.includeTime?'checked':''} onchange="setStage6Field('settlement.includeTime', this.checked)">
              Show settlement time curve
            </label>
            ${cfg.includeTime ? `
              <label class="field-stack">Time horizon (days)
                <input type="number" class="input input--num" step="10" min="1" value="${cfg.timeDays.toFixed(0)}" onchange="setStage6Field('settlement.timeDays', this.value)">
              </label>
            `:''}
            <details class="acc" data-st6details="settlement-loads"${detailsOpen('settlement-loads')}>
              <summary class="acc__head">Load assumptions and Eurocode combination</summary>
              <div class="acc__body">
                <div class="card card--quiet card--note">Only expand this if you want to change the serviceability load assumptions. The default is the quasi-permanent SLS combination, which is usually the right starting point for long-term settlement.</div>
                <label class="field-stack">SLS combination
                  <select class="input" onchange="setStage6Field('settlement.combination', this.value)">
                    ${slsCombinationOptions(cfg.combination)}
                  </select>
                </label>
                <div class="card card--quiet card--note">${slsCombinationHelp(cfg.combination, 'settlement')}</div>
                <label class="field-stack">Load category for Eurocode ψ-factors
                  <select class="input" onchange="setStage6Field('settlement.useCategory', this.value)">
                    ${useCategoryOptions(cfg.useCategory)}
                  </select>
                </label>
                <div class="card card--quiet card--note">${useCategoryHelp(cfg.useCategory)}</div>
                <label class="field-stack">Permanent stress Gk (kPa)
                  <input type="number" class="input input--num" step="5" min="0" value="${cfg.Gk.toFixed(1)}" onchange="setStage6Field('settlement.Gk', this.value)">
                </label>
                <label class="field-stack">Leading variable load Qk (kPa)
                  <input type="number" class="input input--num" step="5" min="0" value="${cfg.QLead.toFixed(1)}" onchange="setStage6Field('settlement.QLead', this.value)">
                </label>
                <label class="field-stack">Other variable loads together (kPa)
                  <input type="number" class="input input--num" step="5" min="0" value="${cfg.QOther.toFixed(1)}" onchange="setStage6Field('settlement.QOther', this.value)">
                </label>
              </div>
            </details>
          </div>
        </div>
        <div>
          <div class="stack">
            <div class="viz">
              <div class="viz__label">Stress increase Delta sigma_v vs depth</div>
              <div class="viz__body" style="--viz-h:180px"><canvas id="stage6SettlementStressChart" role="img" aria-label="Settlement stress increase versus depth"></canvas></div>
            </div>
            <div class="viz">
              <div class="viz__label">Cumulative settlement vs depth</div>
              <div class="viz__body" style="--viz-h:180px"><canvas id="stage6SettlementCumulativeChart" role="img" aria-label="Cumulative settlement versus depth"></canvas></div>
            </div>
            ${analysis.timeCurve ? `
              <div class="viz">
                <div class="viz__label">Indicative settlement time curve</div>
                <div class="viz__body" style="--viz-h:180px"><canvas id="stage6SettlementTimeChart" role="img" aria-label="Settlement time curve"></canvas></div>
              </div>
            `:''}
          </div>
        </div>
        <div>
          <table class="tbl tbl--kv">
            <tr class="tbl__sec"><td colspan="2">Summary</td></tr>
            <tr class="key"><td>Total settlement</td><td>${analysis.totalSettlementMm.toFixed(1)} mm</td></tr>
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
      <div class="cols-2">
        ${loadSummaryHtml('Load combination audit', loadRows)}
        <div class="card card--quiet">
          <div class="card__eyebrow">Formula used</div>
          <div class="formula">
            Delta eps = Delta sigma_v / E_oed(sigma_mean)<br>
            Delta S = Sum(Delta eps * Delta z)
          </div>
          <div class="card__text">
            Evaluation point = <strong>centre of loaded area</strong><br>
            Stress method = <strong>${cfg.stressMethod === 'two_to_one' ? '2:1 spread beneath centreline' : 'Boussinesq / Newmark centreline'}</strong><br>
            Soil route = <strong>Characteristic E_oed,ref and m</strong><br>
            Load route = <strong>SLS ${cfg.combination === 'qp' ? 'quasi-permanent' : cfg.combination}</strong><br>
            Truncation = <strong>${analysis.truncationCause}</strong>
          </div>
        </div>
      </div>
      <div>
        <div class="card__eyebrow">Per layer contribution</div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th class="num">Layer</th><th>Type</th><th class="num">Top-Bot (m)</th><th class="num">Thickness (m)</th><th class="num">Settlement (mm)</th></tr></thead>
            <tbody>
              ${analysis.perLayer.map(row=>`<tr><td class="num">${row.layerIndex+1}</td><td>${row.type}</td><td class="num">${row.top.toFixed(2)}-${row.bot.toFixed(2)}</td><td class="num">${row.thickness.toFixed(2)}</td><td class="num">${row.settlementMm.toFixed(2)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div class="card__eyebrow">Audit sublayers</div>
        <div class="tbl-wrap" style="--tbl-wrap-max:20rem">
          <table class="tbl">
            <thead><tr><th class="num">z_mid</th><th class="num">Layer</th><th class="num">sigma'v0</th><th class="num">Delta sigma</th><th class="num">sigma'mean</th><th class="num">E_oed</th><th class="num">Delta S</th></tr></thead>
            <tbody>
              ${analysis.sublayers.map(row=>`<tr><td class="num">${row.zMid.toFixed(2)}</td><td class="num">${row.layerIndex+1}</td><td class="num">${row.sigmaEff0.toFixed(1)}</td><td class="num">${row.deltaSigmaV.toFixed(1)}</td><td class="num">${row.sigmaMean.toFixed(1)}</td><td class="num">${row.Eoed.toFixed(0)}</td><td class="num">${row.dSmm.toFixed(3)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ${noteHtml(analysis.notes)}
    </div>
  `;
}
