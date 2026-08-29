// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// beam/panel.js — the HTML string builders of the beam / slab-on-Winkler app
// (01-monolith-map.md §2.9 "Render" renderStage6BeamApp, §6.1 row `beam/`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js (integration-r @ 07f0645 line numbers):
//   stage6BeamOrientationHtml 9351-9362 → orientationHtml(cfg, analysis)  the "Analysis direction" select + prompt
//   stage6BeamDurabilityHtml  9375-9410 → durabilityHtml(reinf)            the EC2 durability audit card
//   renderStage6BeamApp       9834-10083 → beamBodyHtml(analysis, cfg, {detailsOpen})
//     `S.stage6.beam` → cfg; stage6DetailsOpen(key) → the host's detailsOpen hook (' open' | '');
//     stage6Tooltip / stage6LoadSummaryHtml / stage6NoteHtml → core/format; the beam wording builders →
//     options.js; the Eurocode use-category / SLS-combination builders → settlement/options.js.
// Markup byte-identical; the 36 inline `setStage6Field('beam.…')` handlers stay the shell's.
// `analysis` is compute.js beamAnalysis() (= stage6-engineering analyzeBeamAndReinforcement); the canvas
// ids stage6BeamDeflectionChart / stage6BeamMomentChart are chart.js' BEAM_CHART_IDS and
// stage6BeamGeometryCanvas is geometry-preview.js' BEAM_GEOMETRY_CANVAS_ID.
import { loadSummaryHtml, noteHtml, tooltip } from '../core/format.js';
import { slsCombinationHelp, slsCombinationOptions, useCategoryHelp, useCategoryOptions } from '../settlement/options.js';
import { beamAxisCopy, exposureHelp, exposureOptions, loadPatternHelp, modelModeOptions, momentContextHelp, ulsHelp, ulsOptions } from './options.js';

export function orientationHtml(cfg, analysis){
  const mode = cfg.modelMode || 'slab_strip';
  const axis = beamAxisCopy(mode);
  return `
    <label style="font-size:11px;color:var(--tx2)">Analysis direction${tooltip('The equations are one-dimensional. This choice defines what the x direction means before you enter L, b, B, loads, and patch positions.')}
      <select onchange="setStage6Field('beam.modelMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
        ${modelModeOptions(mode)}
      </select>
    </label>
    <div class="st6-help">${axis.prompt}</div>
  `;
}

export function durabilityHtml(reinf){
  const d = reinf.durability;
  const lines = [
    {k:'Exposure class', v:`${d.exposureClass} - ${d.exposureMeta.label}`},
    {k:'Structural class', v:`S${d.structuralClass}`},
    {k:'c_min,dur', v:`${d.cMinDur.toFixed(0)} mm`},
    {k:'c_min,b', v:`${d.cMinB.toFixed(0)} mm`},
    {k:'c_min', v:`${d.cMin.toFixed(0)} mm`},
    {k:'Δc_dev', v:`${d.deltaCdev.toFixed(0)} mm`},
    {k:'Ground-cast extra', v:`${d.unevenExtra.toFixed(0)} mm`},
    {k:'Ground-cast floor', v:`${d.floor.toFixed(0)} mm`},
    {k:'c_nom raw', v:`${d.cNomRaw.toFixed(0)} mm`},
    {k:'c_nom recommended', v:`${d.recommendedCNom.toFixed(0)} mm`},
    {k:'c_nom used', v:`${d.cNom.toFixed(0)} mm`}
  ];
  const structuralDetail = d.structuralAdjustments.length
    ? d.structuralAdjustments.join(' ')
    : 'Default 50-year EC2 structural class S4, with no additional modifiers applied.';
  const fallbackText = d.fallbackExposure
    ? `For ${d.exposureClass}, EC2 cover uses the corrosion fallback ${d.tableExposure}. Concrete mix requirements for XF/XA remain an engineer check outside this tool.`
    : '';
  return `
    <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">EC2 durability audit</div>
      <table class="pt">
        ${lines.map(row=>`<tr><td>${row.k}</td><td>${row.v}</td></tr>`).join('')}
      </table>
      <div style="margin-top:8px;font-size:11px;color:var(--tx2);line-height:1.55">
        ${d.exposureMeta.hint}<br>
        High-strength threshold for this exposure = <strong>${d.highStrengthThreshold.toFixed(0)} MPa</strong>; auto check = <strong>${d.autoHighStrength ? 'applied' : 'not applied'}</strong>.<br>
        ${structuralDetail}
        ${fallbackText ? `<br>${fallbackText}` : ''}
      </div>
    </div>
  `;
}

export function beamBodyHtml(analysis, cfg, { detailsOpen = () => '' } = {}){
  const ks = analysis.ksInfo;
  const reinf = analysis.reinforcement;
  const axisCopy = beamAxisCopy(cfg.modelMode);
  const momentUnits = reinf.momentUnits || 'kNm/m';
  const areaUnits = reinf.areaUnits || 'mm²/m';
  const loadInputKind = analysis.slsLoadMeta.units === 'kN' ? 'point action' : 'line load q(x)';
  const loadInputPlural = analysis.slsLoadMeta.units === 'kN' ? 'point actions' : 'line loads q(x)';
  const loadRows = [
    {k:'Analysis direction', v:axisCopy.summary},
    {k:'Foundation model', v:ks.foundationModel === 'pasternak' ? 'Pasternak (two-parameter)' : 'Winkler'},
    {k:'SLS route', v:`${analysis.slsLoadMeta.label}`},
    {k:'ULS route', v:`${analysis.ulsLoadMeta.label}`},
    {k:'SLS load', v:`${analysis.slsLoadMeta.value.toFixed(2)} ${analysis.slsLoadMeta.units}`},
    {k:'ULS load', v:`${analysis.ulsLoadMeta.value.toFixed(2)} ${analysis.ulsLoadMeta.units}`},
    {k:'Es mode', v:cfg.EsMode === 'young_drained' ? 'Young drained' : 'Oedometric'},
    {k:'Es avg', v:`${ks.EsAvg.toFixed(0)} kPa`},
    {k:'ks', v:`${ks.ks.toFixed(0)} kN/m³`},
    ...(ks.foundationModel === 'pasternak' ? [
      {k:'G_s,avg', v:`${ks.GsAvg.toFixed(0)} kPa`},
      {k:'G_p', v:`${ks.gp.toFixed(0)} kN/m`},
      {k:'eta', v:ks.gpEta.toFixed(2)}
    ] : []),
    {k:'beta*L', v:ks.betaL.toFixed(2)}
  ];
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Beam / slab on ${ks.foundationModel === 'pasternak' ? 'Pasternak' : 'Winkler'}</span>
        <span style="font-size:11px;color:var(--tx2)">1D strip model with SLS deflection and ULS reinforcement output from the current CPT stiffness profile.</span>
      </div>
      <div style="display:grid;grid-template-columns:300px 1fr 280px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <div class="st6-help" style="margin-bottom:2px">Pick the <strong>x direction</strong> first. The canvas shows the x-z model view and the y-z section for the values below.</div>
            ${orientationHtml(cfg, analysis)}
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.BLabel}${tooltip(axisCopy.BTip)}
              <input type="number" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('beam.B', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.bLabel}${tooltip(axisCopy.bTip)}
              <input type="number" step="0.1" min="0.1" value="${cfg.b.toFixed(2)}" onchange="setStage6Field('beam.b', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.LLabel}${tooltip(axisCopy.LTip)}
              <input type="number" step="0.1" min="0.5" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('beam.L', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.hLabel}${tooltip('h is the vertical concrete section depth. It is used twice: it increases strip stiffness EI for the soil-supported beam solve and increases reinforcement effective depth d for the section check. Because a stiffer strip can bridge a larger MEd on elastic support, As,req can rise over some h ranges even though a fixed-moment section check would usually need less steel.')}
              <input type="number" step="0.01" min="0.1" value="${cfg.h.toFixed(2)}" onchange="setStage6Field('beam.h', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Founding depth Df (m)${tooltip('Df shifts the evaluation depth for the soil stiffness averaging. Use the depth of the underside of the slab, strip footing, or beam relative to ground level.')}
              <input type="number" step="0.1" min="0" value="${cfg.Df.toFixed(2)}" onchange="setStage6Field('beam.Df', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Concrete E (kPa)${tooltip('Concrete Young modulus used for EI. The default is a reasonable reinforced-concrete screening value. Change it only if you want a project-specific stiffness assumption.')}
              <input type="number" step="100000" min="1000000" value="${cfg.Ec.toFixed(0)}" onchange="setStage6Field('beam.Ec', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Foundation model${tooltip('Use Winkler as the standard first screening model. Pasternak adds shear coupling between adjacent soil springs and can give a smoother, more spread response, but in this app it is still an inferred experimental extension.')}
              <select onchange="setStage6Field('beam.foundationModel', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="winkler"${cfg.foundationModel==='winkler'?' selected':''}>Winkler</option>
                <option value="pasternak"${cfg.foundationModel==='pasternak'?' selected':''}>Pasternak (1D strip)</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Es route${tooltip('This controls how the CPT-derived stiffness is converted to the soil modulus used in k_s. The default keeps Es = E_oed for consistency with the oedometric CPT workflow.')}
              <select onchange="setStage6Field('beam.EsMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="oedometric"${cfg.EsMode==='oedometric'?' selected':''}>Es = E_oed, ν = 0</option>
                <option value="young_drained"${cfg.EsMode==='young_drained'?' selected':''}>Young drained conversion</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Influence depth for Es averaging (m)${tooltip('Depth range below Df over which the CPT stiffness is averaged to derive Es and k_s. Larger values smooth the soil profile more; smaller values make the support react more to the near-surface layer only.')}
              <input type="number" step="0.1" min="0.5" value="${cfg.zInfluence.toFixed(2)}" onchange="setStage6Field('beam.zInfluence', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            ${cfg.foundationModel==='pasternak' ? `
              <label style="font-size:11px;color:var(--tx2)">Pasternak coupling factor eta${tooltip('eta scales the inferred Pasternak shear layer: G_p = eta · G_s,avg · H_p. Start around 1.0. Lower eta weakens lateral coupling between springs; higher eta strengthens it.')}
                <input type="number" step="0.1" min="0" value="${cfg.gpEta.toFixed(2)}" onchange="setStage6Field('beam.gpEta', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Override G_p (kN/m, optional)${tooltip('Use this only if you already have an engineering value for the Pasternak shear parameter G_p. Leave it blank to let the app infer G_p from the CPT stiffness profile and eta.')}
                <input type="number" step="100" min="0" value="${cfg.gpOverride!=null?cfg.gpOverride:''}" onchange="setStage6Field('beam.gpOverride', this.value)" placeholder="leave blank to infer from CPT" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <div class="st6-help">Pasternak adds shear interaction between adjacent springs. Here <strong>eta</strong> is an engineer scaling factor in <strong>G_p = eta · G_s,avg · H_p</strong>. Start around <strong>1.0</strong>; lower values weaken the coupling, higher values strengthen it. Treat this as experimental screening unless calibrated.</div>
            `:''}
            <label style="font-size:11px;color:var(--tx2)">Load pattern${tooltip('Choose a load shape that matches how the slab or beam is really loaded. Uniform full length is often a settlement-style case; local bending is usually better captured by a patch load or a point load.')}
              <select onchange="setStage6Field('beam.loadPattern', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="uniform_full"${cfg.loadPattern==='uniform_full'?' selected':''}>Uniform full length</option>
                <option value="uniform_patch"${cfg.loadPattern==='uniform_patch'?' selected':''}>Uniform patch</option>
                <option value="point_centre"${cfg.loadPattern==='point_centre'?' selected':''}>Point load at centre</option>
                <option value="point_at_x"${cfg.loadPattern==='point_at_x'?' selected':''}>Point load at x</option>
              </select>
            </label>
            <div class="st6-help">${loadPatternHelp(cfg.loadPattern)}</div>
            ${cfg.loadPattern==='uniform_patch' ? `
              <label style="font-size:11px;color:var(--tx2)">Patch start x (m)${tooltip('Start position of the loaded zone along the strip. Use this with patch end x to place a wall strip, loaded bay, or other local area load.')}
                <input type="number" step="0.1" min="0" value="${cfg.xStart.toFixed(2)}" onchange="setStage6Field('beam.xStart', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Patch end x (m)${tooltip('End position of the loaded patch. The bending moment is created only over this loaded interval, so this is often more useful than full-length loading for reinforcement screening.')}
                <input type="number" step="0.1" min="0" value="${cfg.xEnd.toFixed(2)}" onchange="setStage6Field('beam.xEnd', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            ${(cfg.loadPattern==='point_centre' || cfg.loadPattern==='point_at_x') ? `
              <label style="font-size:11px;color:var(--tx2)">Point load x-position (m)${tooltip('x-position of the concentrated load along the strip. This is useful for checking an isolated reaction, edge-near machine support, or local heavy point action.')}
                <input type="number" step="0.1" min="0" value="${cfg.xLoad.toFixed(2)}" onchange="setStage6Field('beam.xLoad', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            <label style="font-size:11px;color:var(--tx2)">Allowable deflection ratio L / n${tooltip('Serviceability comparison only. The app reports w_max and compares it to L/n. This does not affect the ULS reinforcement result.')}
              <input type="number" step="50" min="100" value="${cfg.allowableDeflectionRatio.toFixed(0)}" onchange="setStage6Field('beam.allowableDeflectionRatio', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <details class="st6-adv" data-st6details="beam-loads"${detailsOpen('beam-loads')}>
              <summary>Load assumptions and Eurocode combination</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Expand this only if you want to change how the line load is assembled. The category sets the Eurocode ψ-factors for the variable action.</div>
                <label style="font-size:11px;color:var(--tx2)">SLS combination
                  <select onchange="setStage6Field('beam.slsCombination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${slsCombinationOptions(cfg.slsCombination)}
                  </select>
                </label>
                <div class="st6-help">${slsCombinationHelp(cfg.slsCombination, 'beam')}</div>
                <label style="font-size:11px;color:var(--tx2)">ULS action set
                  <select onchange="setStage6Field('beam.ulsCombination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${ulsOptions(cfg.ulsCombination)}
                  </select>
                </label>
                <div class="st6-help">${ulsHelp(cfg.ulsCombination)}</div>
                <label style="font-size:11px;color:var(--tx2)">Load category for Eurocode ψ-factors
                  <select onchange="setStage6Field('beam.useCategory', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${useCategoryOptions(cfg.useCategory)}
                  </select>
                </label>
                <div class="st6-help">${useCategoryHelp(cfg.useCategory)}</div>
                <label style="font-size:11px;color:var(--tx2)">Permanent ${loadInputKind} Gk (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.Gk.toFixed(1)}" onchange="setStage6Field('beam.Gk', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Leading variable ${loadInputKind} Qk (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.QLead.toFixed(1)}" onchange="setStage6Field('beam.QLead', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Other variable ${loadInputPlural} together (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.QOther.toFixed(1)}" onchange="setStage6Field('beam.QOther', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
              </div>
            </details>
            <div style="padding-top:6px;border-top:1px solid var(--bd)">
              <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">EC2 reinforcement</div>
              <label style="font-size:11px;color:var(--tx2)">Concrete class fck (MPa)${tooltip('Characteristic cylinder strength used for the EC2 ULS reinforcement design. The app applies the concrete material factor internally when deriving f_cd.')}
                <input type="number" step="1" min="12" value="${cfg.fck.toFixed(0)}" onchange="setStage6Field('beam.fck', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Steel fyk (MPa)${tooltip('Characteristic reinforcement yield strength. The app applies the EC2 steel material factor internally and designs with f_yd = f_yk / 1.15.')}
                <input type="number" step="10" min="200" value="${cfg.fyk.toFixed(0)}" onchange="setStage6Field('beam.fyk', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Exposure class${tooltip('Exposure class drives the EC2 durability cover recommendation c_nom. Pick the environment the member will actually see, then override only if project detailing requires it.')}
                <select onchange="setStage6Field('beam.exposureClass', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  ${exposureOptions(cfg.exposureClass)}
                </select>
              </label>
              <div class="st6-help">${exposureHelp(cfg.exposureClass)}</div>
              <label style="font-size:11px;color:var(--tx2)">Design working life (years)${tooltip('Used in the EC2 durability route for the recommended nominal cover. Longer design life can lead to a higher recommended c_nom.')}
                <select onchange="setStage6Field('beam.designLifeYears', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  <option value="25"${cfg.designLifeYears===25?' selected':''}>25 years</option>
                  <option value="50"${cfg.designLifeYears===50?' selected':''}>50 years</option>
                  <option value="100"${cfg.designLifeYears===100?' selected':''}>100 years</option>
                </select>
              </label>
              <label style="font-size:11px;color:var(--tx2)">Bar diameter (mm)${tooltip('Bar diameter used in the cover and effective-depth calculation. It affects d and therefore the resulting As requirement slightly.')}
                <input type="number" step="2" min="6" value="${cfg.phiBar.toFixed(0)}" onchange="setStage6Field('beam.phiBar', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Max aggregate size d_g (mm)
                <input type="number" step="1" min="8" value="${cfg.dG.toFixed(0)}" onchange="setStage6Field('beam.dG', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Δc_dev (mm)
                <input type="number" step="1" min="0" value="${cfg.deltaCdev.toFixed(0)}" onchange="setStage6Field('beam.deltaCdev', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Override c_nom (mm, optional)
                <input type="number" step="1" min="0" value="${cfg.cNomOverride!=null?cfg.cNomOverride:''}" onchange="setStage6Field('beam.cNomOverride', this.value)" placeholder="leave blank for recommendation" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.isSlabOrPlate?'checked':''} onchange="setStage6Field('beam.isSlabOrPlate', this.checked)">EC2 slab / plate durability class (cover only)</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.specialQC?'checked':''} onchange="setStage6Field('beam.specialQC', this.checked)">special QC / precast-like execution</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.castAgainstUnevenSurface?'checked':''} onchange="setStage6Field('beam.castAgainstUnevenSurface', this.checked)">cast against uneven prepared surface (+5 mm)</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.castAgainstPreparedGround?'checked':''} onchange="setStage6Field('beam.castAgainstPreparedGround', this.checked)">cast against prepared ground / blinding (minimum 40 mm)</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.castAgainstUnpreparedGround?'checked':''} onchange="setStage6Field('beam.castAgainstUnpreparedGround', this.checked)">cast against unprepared ground (minimum 75 mm)</label>
              <div class="st6-help">High-strength concrete reduction is checked automatically from the chosen fck and exposure class, following the EC2 Table 4.3N thresholds.</div>
            </div>
          </div>
        </div>
        <div>
          <div style="display:grid;grid-template-columns:1fr;gap:12px">
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">SLS deflection line w(x)</div>
              <div style="position:relative;height:190px"><canvas id="stage6BeamDeflectionChart" role="img" aria-label="Beam deflection diagram"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">ULS bending moment M(x)</div>
              <div style="position:relative;height:190px"><canvas id="stage6BeamMomentChart" role="img" aria-label="Beam bending moment diagram"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Geometry preview (view only)</div>
              <div style="position:relative;height:220px;border:1px solid var(--bd);border-radius:3px;background:var(--bg2);overflow:hidden">
                <canvas id="stage6BeamGeometryCanvas" role="img" aria-label="Beam or slab strip geometry preview" style="width:100%;height:100%;display:block"></canvas>
              </div>
            </div>
          </div>
        </div>
        <div>
          <table class="pt" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:700;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Summary</td></tr>
            <tr><td>Es avg</td><td>${ks.EsAvg.toFixed(0)} kPa</td></tr>
            <tr><td>ks</td><td>${ks.ks.toFixed(0)} kN/m³</td></tr>
            ${ks.foundationModel === 'pasternak' ? `<tr><td>G_p</td><td>${ks.gp.toFixed(0)} kN/m</td></tr>` : ''}
            <tr><td>${ks.foundationModel === 'pasternak' ? 'lambda_ref' : 'lambda'}</td><td>${ks.lambda.toFixed(2)} m</td></tr>
            <tr><td>${ks.foundationModel === 'pasternak' ? 'beta·L ref' : 'beta·L'}</td><td>${ks.betaL.toFixed(2)}</td></tr>
            <tr><td>Classification</td><td>${ks.classification}</td></tr>
            <tr><td>w_max,SLS</td><td>${(analysis.sls.maxDeflection.value*1000).toFixed(2)} mm</td></tr>
            <tr><td>w_allow</td><td>${((cfg.L / cfg.allowableDeflectionRatio)*1000).toFixed(2)} mm</td></tr>
            <tr><td>SLS utilisation</td><td>${(Math.abs(analysis.sls.maxDeflection.value)/Math.max(cfg.L / cfg.allowableDeflectionRatio, 1e-6)).toFixed(2)}</td></tr>
            <tr><td>M_Ed,max</td><td>${Math.abs(analysis.uls.maxMoment.value).toFixed(2)} ${momentUnits}</td></tr>
            <tr><td>Exposure</td><td>${reinf.durability.exposureClass}</td></tr>
            <tr><td>Structural class</td><td>S${reinf.structuralClass}</td></tr>
            <tr><td>c_nom</td><td>${reinf.cNom.toFixed(0)} mm</td></tr>
            <tr><td>b_w</td><td>${reinf.bw.toFixed(0)} mm</td></tr>
            <tr><td>As,req</td><td>${reinf.AsReq!=null?reinf.AsReq.toFixed(0):'—'} ${areaUnits}</td></tr>
            <tr><td>As,min</td><td>${reinf.AsMin.toFixed(0)} ${areaUnits}</td></tr>
            <tr><td>As,governing</td><td>${reinf.As.toFixed(0)} ${areaUnits}</td></tr>
          </table>
          <div class="st6-help" style="margin-bottom:10px">${momentContextHelp(cfg)}</div>
          <div class="st6-help">k_s is <strong>not</strong> a fixed soil material constant. It depends on the interpreted CPT stiffness, the loaded width <strong>B</strong>, the averaging depth, and the strip stiffness. As a rough order of magnitude only: very soft support may be around <strong>5,000-20,000 kN/m³</strong>, medium support <strong>20,000-80,000 kN/m³</strong>, and stiff/dense support <strong>80,000-200,000+ kN/m³</strong>. Use these only as a sanity check, not as target values.</div>
        </div>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${loadSummaryHtml('Vesic / load audit', loadRows)}
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Formula route</div>
          <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
            k_s = 0.65·E_s / [B·(1-nu²)] · (E_s·B^4 / (E_b·I_b))^(1/12)<br>
            ${ks.foundationModel === 'pasternak'
              ? `G_p = eta·G_s,avg·H_p &nbsp; (or engineer override)<br>EI·w'''' - G_p·b·w'' + k_s·b·w = q(x)`
              : `EI·w'''' + k_s·b·w = q(x)`}
          </div>
          <div style="font-size:11px;color:var(--tx2);line-height:1.55">
            Foundation model = <strong>${ks.foundationModel === 'pasternak' ? 'Pasternak (1D strip)' : 'Winkler'}</strong><br>
            Structural stiffness I = <strong>${ks.I.toFixed(5)} m4</strong><br>
            ULS design moment = <strong>${Math.abs(analysis.uls.maxMoment.value).toFixed(2)} ${momentUnits}</strong><br>
            c_nom used = <strong>${reinf.cNom.toFixed(0)} mm</strong><br>
            Effective depth d = <strong>${reinf.d.toFixed(0)} mm</strong><br>
            Structural class = <strong>S${reinf.structuralClass}</strong>
          </div>
        </div>
      </div>
      <div style="margin-top:14px">
        ${durabilityHtml(reinf)}
      </div>
      ${noteHtml(analysis.notes)}
    </div>
  `;
}
