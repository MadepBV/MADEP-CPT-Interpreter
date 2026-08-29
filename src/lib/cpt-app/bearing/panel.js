// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// bearing/panel.js — HTML string builders of the bearing app
// (01-monolith-map.md §2.7 "Render", refactor step 7 / PR 12a).
//
// Moved verbatim out of legacy-controller.js (integration-r line numbers):
//   stage6BearingSelectedDepthHtml    10542-10567 → selectedDepthHtml(sel, governing, governingMode)
//   stage6BearingMaterialParamsHtml   10569-10602 → materialParamsHtml(sel, cfg)
//   stage6BearingDrainedFormulaHtml   10604-10630 → drainedFormulaHtml(sel)
//   stage6BearingUndrainedFormulaHtml 10632-10653 → undrainedFormulaHtml(sel)
//   renderStage6BearingApp            11107-11212 → bearingBodyHtml(profile, cfg, {detailsOpen})
//                                     (`S.stage6.bearing` → cfg; stage6DetailsOpen(key) → the host hook)
// The governing-resistance derivation that renderStage6BearingApp and refreshStage6BearingPreview both
// inlined (min of the drained / undrained design resistance and its mode label) is governingResistance().
// Markup byte-identical; the 13 inline `setStage6Field('bearing.…')` handlers stay the shell's. The ids
// stage6DfValue / stage6SelectedDepth / stage6UlsParams / stage6DrainedFormula / stage6UndrainedFormula are
// the partial-update targets of preview.js; stage6BearingChart the canvas of chart.js.
import { noteHtml } from '../core/format.js';
import { bearingNotes, ec7Help, ec7Options, shapeModeDetailHtml, shapeModeHelp, shapeModeOptions } from './notes.js';

/** Governing design resistance at the selected depth: the lower of the drained and undrained curves. */
export function governingResistance(sel){
  const governing = Math.min(sel.qdDrained, sel.qdUndrained);
  const governingMode = sel.qdDrained <= sel.qdUndrained ? 'Drained' : 'Undrained';
  return { governing, governingMode };
}

export function selectedDepthHtml(sel, governing, governingMode){
  return `
    <table class="pt" style="margin-bottom:12px">
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Selected depth</td></tr>
      <tr><td>Df</td><td>${sel.z.toFixed(2)} m</td></tr>
      <tr><td>Layer</td><td>${sel.layer.type}</td></tr>
      <tr><td>Subtype</td><td>${sel.layer.subtype||'—'}</td></tr>
      ${sel.useEc7 ? `<tr><td>Belgian EC7 envelope</td><td>${sel.ec7CombinationLabel}</td></tr>` : `<tr><td>Safety route</td><td>Global system factor</td></tr>`}
      <tr><td>σ'v</td><td>${sel.sigVeff.toFixed(1)} kPa</td></tr>
      <tr><td>Applied stress</td><td>${sel.utilDrained!=null?`${sel.utilDrained.toFixed(2)} · drained / ${sel.utilUndrained.toFixed(2)} · undrained`:'—'}</td></tr>
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--chart-green);padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Drained</td></tr>
      ${sel.useEc7 ? `<tr><td>Governing combo</td><td>${sel.drainedComboLabel}</td></tr>` : ''}
      <tr><td>q_ult</td><td>${sel.qultDrained.toLocaleString()} kPa</td></tr>
      <tr><td>${sel.capacityLabel}</td><td>${sel.qdDrained.toLocaleString()} kPa</td></tr>
      <tr><td>utilisation</td><td>${sel.utilDrained!=null?sel.utilDrained.toFixed(2):'—'}</td></tr>
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--chart-orange);padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Undrained</td></tr>
      ${sel.useEc7 ? `<tr><td>Governing combo</td><td>${sel.undrainedComboLabel}</td></tr>` : ''}
      <tr><td>q_ult</td><td>${sel.qultUndrained.toLocaleString()} kPa</td></tr>
      <tr><td>${sel.capacityLabel}</td><td>${sel.qdUndrained.toLocaleString()} kPa</td></tr>
      <tr><td>utilisation</td><td>${sel.utilUndrained!=null?sel.utilUndrained.toFixed(2):'—'}</td></tr>
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding:4px 0;border-top:1px solid var(--bd);text-transform:uppercase">Governing</td></tr>
      <tr><td>Mode</td><td>${governingMode}</td></tr>
      <tr><td>${sel.capacityLabel}</td><td>${governing.toLocaleString()} kPa</td></tr>
    </table>
  `;
}

export function materialParamsHtml(sel, cfg){
  if(!sel.useEc7){
    return `
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Global safety-factor route at selected depth</div>
      <table class="pt">
        <tr><td>φ'k</td><td>${sel.phiK.toFixed(1)}°</td><td>c'k</td><td>${sel.cK.toFixed(1)} kPa</td><td>cu,k</td><td>${sel.cuK.toFixed(1)} kPa</td></tr>
        <tr><td>γ'</td><td>${sel.gammaEff.toFixed(2)} kN/m³</td><td>ξ</td><td>${cfg.xi.toFixed(2)}</td><td>Route</td><td>Global SF</td></tr>
        <tr><td>B / L</td><td>${sel.BRaw.toFixed(2)} / ${sel.LRaw.toFixed(2)} m</td><td>eB / eL</td><td>${sel.eB.toFixed(2)} / ${sel.eL.toFixed(2)} m</td><td>Route</td><td>${sel.shapeModeLabel}</td></tr>
        <tr><td>B' / L'</td><td>${sel.BEff.toFixed(2)} / ${sel.LEff.toFixed(2)} m</td><td>r</td><td>${sel.r.toFixed(3)}</td><td>k</td><td>${sel.k.toFixed(3)}</td></tr>
      </table>
      <div style="margin-top:8px;font-size:11px;color:var(--tx2);line-height:1.5">
        Characteristic soil parameters are used directly. The global/system factor ξ is applied on the output resistance only and is not combined with γ_R or γ_M.<br>
        Nγ uses the <strong>${sel.ngammaFormulaLabel}</strong> form. Shape factors follow <strong>${sel.shapeModeLabel}</strong>. ${shapeModeDetailHtml(sel.shapeMode)}
      </div>
    `;
  }
  return `
    <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Belgian EC7 DA1 parameters used at selected depth</div>
    <table class="pt">
      <tr><td>Drained combo</td><td>${sel.drainedComboLabel}</td><td>Undrained combo</td><td>${sel.undrainedComboLabel}</td><td>γ_Rd</td><td>${cfg.gammaRd.toFixed(2)}</td></tr>
      <tr><td>φ'k</td><td>${sel.phiK.toFixed(1)}°</td><td>γ_M,φ</td><td>${sel.gammaMphi.toFixed(2)}</td><td>φ'd</td><td>${sel.phiD.toFixed(1)}°</td></tr>
      <tr><td>c'k</td><td>${sel.cK.toFixed(1)} kPa</td><td>γ_M,c'</td><td>${sel.gammaMc.toFixed(2)}</td><td>c'd</td><td>${sel.cD.toFixed(1)} kPa</td></tr>
      <tr><td>cu,k</td><td>${sel.cuK.toFixed(1)} kPa</td><td>γ_M,cu</td><td>${sel.gammaMcu.toFixed(2)}</td><td>cu,d</td><td>${sel.cuD.toFixed(1)} kPa</td></tr>
      <tr><td>γ'</td><td>${sel.gammaEff.toFixed(2)} kN/m³</td><td>Combo mode</td><td>${cfg.ec7Combination === 'governing' ? 'most onerous' : cfg.ec7Combination.toUpperCase().replace('_','/')}</td><td>R set</td><td>R1</td></tr>
      <tr><td>B / L</td><td>${sel.BRaw.toFixed(2)} / ${sel.LRaw.toFixed(2)} m</td><td>eB / eL</td><td>${sel.eB.toFixed(2)} / ${sel.eL.toFixed(2)} m</td><td>Shape route</td><td>${sel.shapeModeLabel}</td></tr>
      <tr><td>B' / L'</td><td>${sel.BEff.toFixed(2)} / ${sel.LEff.toFixed(2)} m</td><td>r</td><td>${sel.r.toFixed(3)}</td><td>Nγ</td><td>${sel.ngammaFormulaLabel}</td></tr>
    </table>
    ${sel.ec7Results && sel.ec7Results.length > 1 ? `
      <div style="margin-top:8px;font-size:11px;color:var(--tx2);line-height:1.55">
        DA1 overview: ${sel.ec7Results.map(r=>`${r.label}: drained ${r.qdDrained.toFixed(0)} kPa, undrained ${r.qdUndrained.toFixed(0)} kPa`).join(' · ')}
      </div>
    ` : ''}
  `;
}

export function drainedFormulaHtml(sel){
  return `
    <div style="font-size:10px;font-weight:700;color:var(--chart-green);text-transform:uppercase;margin-bottom:6px">Drained formula at selected depth</div>
    <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
      q_ult,d = c'·N_c·s_c·d_c + q'·N_q·s_q·d_q + 0.5·γ'·B'·N_γ·s_γ·d_γ
    </div>
    <div style="font-size:11px;color:var(--tx2);line-height:1.55">
      φ'k = <strong>${sel.phiK.toFixed(1)}°</strong>${sel.useEc7?` → φ'd = <strong>${sel.phiD.toFixed(1)}°</strong>`:''}<br>
      c'k = <strong>${sel.cK.toFixed(1)} kPa</strong>${sel.useEc7?` → c'd = <strong>${sel.cD.toFixed(1)} kPa</strong>`:''}<br>
      N_c = <strong>${sel.Nc.toFixed(3)}</strong><br>
      N_q = <strong>${sel.Nq.toFixed(3)}</strong><br>
      N_γ = <strong>${sel.Ng.toFixed(3)}</strong> (${sel.ngammaFormulaLabel})<br>
      q' = σ'v = <strong>${sel.qDrain.toFixed(1)} kPa</strong><br>
      γ' = <strong>${sel.gammaEff.toFixed(2)} kN/m³</strong><br>
      ${sel.useEc7 ? `Governing Belgian combo = <strong>${sel.drainedComboLabel}</strong><br>` : ''}
      Shape factors = <strong>${sel.shapeModeLabel}</strong><br>
      B = <strong>${sel.BRaw.toFixed(2)} m</strong>, L = <strong>${sel.LRaw.toFixed(2)} m</strong><br>
      eB = <strong>${sel.eB.toFixed(2)} m</strong>, eL = <strong>${sel.eL.toFixed(2)} m</strong><br>
      B' = <strong>${sel.BEff.toFixed(2)} m</strong>, L' = <strong>${sel.LEff.toFixed(2)} m</strong>, r = <strong>${sel.r.toFixed(3)}</strong><br>
      Df/B' = η = <strong>${sel.eta.toFixed(3)}</strong>, k = <strong>${sel.k.toFixed(3)}</strong><br>
      s_c = <strong>${sel.sc.toFixed(2)}</strong>, s_q = <strong>${sel.sq.toFixed(2)}</strong>, s_γ = <strong>${sel.sg.toFixed(2)}</strong><br>
      d_c = <strong>${sel.dc.toFixed(2)}</strong>, d_q = <strong>${sel.dq.toFixed(2)}</strong>, d_γ = <strong>${sel.dg.toFixed(2)}</strong><br>
      ${sel.factorLabel} = <strong>${sel.factor.toFixed(2)}</strong><br>
      ${sel.capacityLabel} = q_ult,d / ${sel.factorLabel} = <strong>${sel.qdDrained.toLocaleString()} kPa</strong>
    </div>
  `;
}

export function undrainedFormulaHtml(sel){
  return `
    <div style="font-size:10px;font-weight:700;color:var(--chart-orange);text-transform:uppercase;margin-bottom:6px">Undrained formula at selected depth</div>
    <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
      q_ult,u = q + 5.14·c_u·s_cu·d_cu
    </div>
    <div style="font-size:11px;color:var(--tx2);line-height:1.55">
      q = σv = <strong>${sel.qUndrain.toFixed(1)} kPa</strong><br>
      cu,k = <strong>${sel.cuK.toFixed(1)} kPa</strong>${sel.useEc7?` → cu,d = <strong>${sel.cuD.toFixed(1)} kPa</strong>`:''}<br>
      N_cu = <strong>5.14</strong><br>
      ${sel.useEc7 ? `Governing Belgian combo = <strong>${sel.undrainedComboLabel}</strong><br>` : ''}
      Shape factors = <strong>${sel.shapeModeLabel}</strong><br>
      B = <strong>${sel.BRaw.toFixed(2)} m</strong>, L = <strong>${sel.LRaw.toFixed(2)} m</strong><br>
      eB = <strong>${sel.eB.toFixed(2)} m</strong>, eL = <strong>${sel.eL.toFixed(2)} m</strong><br>
      B' = <strong>${sel.BEff.toFixed(2)} m</strong>, L' = <strong>${sel.LEff.toFixed(2)} m</strong>, r = <strong>${sel.r.toFixed(3)}</strong><br>
      Df/B' = η = <strong>${sel.eta.toFixed(3)}</strong>, k = <strong>${sel.k.toFixed(3)}</strong><br>
      s_cu = <strong>${sel.scu.toFixed(2)}</strong>, d_cu = <strong>${sel.dcu.toFixed(2)}</strong><br>
      ${sel.factorLabel} = <strong>${sel.factor.toFixed(2)}</strong><br>
      ${sel.capacityLabel} = q_ult,u / ${sel.factorLabel} = <strong>${sel.qdUndrained.toLocaleString()} kPa</strong>
    </div>
  `;
}

export function bearingBodyHtml(profile, cfg, { detailsOpen }){
  const sel = profile.selected;
  const { governing, governingMode } = governingResistance(sel);
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Bearing capacity</span>
        <span style="font-size:11px;color:var(--tx2)">ULS-style resistance screening from the interpreted CPT profile.</span>
      </div>
      <div style="display:grid;grid-template-columns:260px 1fr 250px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <label style="font-size:11px;color:var(--tx2)">Displayed curves
              <select onchange="setStage6Field('bearing.showMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="both"${cfg.showMode==='both'?' selected':''}>Show both curves</option>
                <option value="drained"${cfg.showMode==='drained'?' selected':''}>Drained only</option>
                <option value="undrained"${cfg.showMode==='undrained'?' selected':''}>Undrained only</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Foundation type
              <select onchange="setStage6Field('bearing.foundationType', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="strip"${cfg.foundationType==='strip'?' selected':''}>Strip</option>
                <option value="footing"${cfg.foundationType==='footing'?' selected':''}>Footing / pad</option>
                <option value="slab"${cfg.foundationType==='slab'?' selected':''}>Slab / raft</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Width B (m)
              <input type="number" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('bearing.B', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Length L (m)
              <input type="number" step="0.1" min="0.1" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('bearing.L', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <div>
              <div style="font-size:11px;color:var(--tx2);margin-bottom:5px">Founding depth Df = <strong id="stage6DfValue">${cfg.Df.toFixed(2)} m</strong></div>
              <input type="range" min="0.2" max="${profile.maxDepth.toFixed(2)}" step="0.05" value="${cfg.Df.toFixed(2)}" oninput="setStage6Field('bearing.Df', this.value)" style="width:100%">
            </div>
            <details class="st6-adv" data-st6details="bearing-advanced"${detailsOpen('bearing-advanced')}>
              <summary>Optional verification and safety settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Bearing capacity is calculated regardless. Expand this only if you want a utilisation check against an applied stress or if you want to adjust the safety philosophy.</div>
                <label style="font-size:11px;color:var(--tx2)">Shape factors
                  <select onchange="setStage6Field('bearing.shapeMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${shapeModeOptions(cfg.shapeMode)}
                  </select>
                </label>
                <div class="st6-help">${shapeModeHelp(cfg.shapeMode)}</div>
                <label style="font-size:11px;color:var(--tx2)">Eccentricity eB (m)
                  <input type="number" step="0.01" min="0" value="${cfg.eB.toFixed(2)}" onchange="setStage6Field('bearing.eB', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Eccentricity eL (m)
                  <input type="number" step="0.01" min="0" value="${cfg.eL.toFixed(2)}" onchange="setStage6Field('bearing.eL', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <div class="st6-help">Effective dimensions for shape factors use B' = B − 2eB and L' = L − 2eL. With the default centered load, keep eB = eL = 0. For circular plans screened in this rectangular interface, use B = L so r = 1.</div>
                <label style="font-size:11px;color:var(--tx2)">Applied stress for utilisation (kPa)
                  <input type="number" step="5" min="0" value="${cfg.load.toFixed(0)}" onchange="setStage6Field('bearing.load', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Safety route
                  <select onchange="setStage6Field('bearing.factorMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    <option value="ec7"${cfg.factorMode==='ec7'?' selected':''}>EC7 output factors</option>
                    <option value="system"${cfg.factorMode==='system'?' selected':''}>Global system factor ξ</option>
                  </select>
                </label>
                ${cfg.factorMode==='ec7' ? `
                  <label style="font-size:11px;color:var(--tx2)">Belgian ULS combination
                    <select onchange="setStage6Field('bearing.ec7Combination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                      ${ec7Options(cfg.ec7Combination)}
                    </select>
                  </label>
                  <div class="st6-help">${ec7Help(cfg.ec7Combination)}</div>
                  <label style="font-size:11px;color:var(--tx2)">γ_Rd
                    <input type="number" step="0.05" min="1.0" value="${cfg.gammaRd.toFixed(2)}" onchange="setStage6Field('bearing.gammaRd', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  </label>
                  <div class="st6-help">Belgian EC7 DA1 uses R1 for spread footing bearing. This tool keeps γ_R = 1.0 and switches the soil-side factors automatically between DA1/1 and DA1/2.</div>
                ` : `
                  <label style="font-size:11px;color:var(--tx2)">Global system factor ξ
                    <input type="number" step="0.1" min="1.0" value="${cfg.xi.toFixed(2)}" onchange="setStage6Field('bearing.xi', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  </label>
                  <div class="st6-help">Use the global ξ route only as a legacy screening path. For Belgian EC7 checks, switch back to the EC7 route above.</div>
                `}
              </div>
            </details>
          </div>
        </div>
        <div>
          <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">
            ${cfg.factorMode==='ec7' ? 'Design bearing capacity vs founding depth' : 'Allowable bearing capacity vs founding depth'}
            <span style="margin-left:6px;color:var(--chart-green)">- drained</span>
            <span style="margin-left:4px;color:var(--chart-orange)">- undrained</span>
            <span style="margin-left:4px;color:var(--chart-blue)">- selected Df</span>
          </div>
          <div style="position:relative;height:420px"><canvas id="stage6BearingChart" role="img" aria-label="Bearing capacity versus depth"></canvas></div>
        </div>
        <div id="stage6SelectedDepth">${selectedDepthHtml(sel, governing, governingMode)}</div>
      </div>
      <div id="stage6UlsParams" style="margin-top:14px" class="info">${materialParamsHtml(sel, cfg)}</div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div id="stage6DrainedFormula" class="info" style="background:var(--bg2)">${drainedFormulaHtml(sel)}</div>
        <div id="stage6UndrainedFormula" class="info" style="background:var(--bg2)">${undrainedFormulaHtml(sel)}</div>
      </div>
      ${noteHtml(bearingNotes(sel, cfg))}
    </div>
  `;
}
