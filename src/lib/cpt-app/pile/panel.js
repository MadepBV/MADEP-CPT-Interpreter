// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// pile/panel.js — the Stage 6 pile app body as pure string builders (01-monolith-map.md §2.8,
// §6.1 row `pile/`, refactor step 7 / PR 12b). Moved verbatim out of legacy-controller.js
// (integration-r @ 78a2e02): renderStage6PileApp 10708-10737 → renderPileApp,
// renderPileInputsColumn 10739-10874, renderPileVisualsColumn 10876-10903,
// renderPileSummaryColumn 10905-10949, renderPilePerLayerTable 10951-10982,
// renderPileFactorChainTable 10984-11001. The only edits of that move were the two reads of
// controller state that became parameters:
//
//   renderPileApp(cfg, analysis, detailsOpen)
//     cfg          S.stage6.pile (already clamped by state.js ensure())
//     analysis     analyzePile(...) of compute.js as cached in S.stage6Cache.pile
//     detailsOpen  (key) → ' open' | '' — the host's stage6DetailsOpen(key) for the five
//                  <details data-st6details="pile-*"> accordions (stage6/ui-state.js detailsOpen)
//
// PR 13 (style, 02-design-system.md §5.2 row 2e) replaced the class attributes and inline styles with
// the component vocabulary of src/lib/styles/components.css (`.card`, `.cols-3` / `.cols-2`,
// `.fields--stack` + `.field-stack` + `.input`, `.acc`, `.viz` + `.viz-grid`, `.tbl-wrap` + `.tbl`,
// `.tbl--kv`, `.pill`); the ids (stage6PileSection, the four chart canvases), the `setStage6Field('pile.…')`
// handlers, the `data-st6details` keys and every visible string are unchanged.
import { noteHtml } from '../core/format.js';

export function renderPileApp(cfg, analysis, detailsOpen){
  const cap = analysis?.capacity || {};
  const set = analysis?.settlement;
  const notes = analysis?.notes || [];
  const xi = cap.xi || {};
  const lengthM = (cfg.zToe - cfg.zHead);
  const sHead = set ? set.sHead_mm : 0;
  const sUtil = sHead && cfg.sAllowable > 0 ? sHead / cfg.sAllowable : 0;
  const ulsPass = cap.ulsUtil != null && cap.ulsUtil <= 1.0;
  const slsPass = sUtil != null && sUtil <= 1.0;
  return `
    <div class="mc2 card st6-app st6-pile stack">
      <div class="card__head card__head--stack">
        <span class="card__title">Pile capacity (Belgian DM20 / De Beer)</span>
        <span class="card__text">CPT-based axial pile resistance and SLS settlement for a single pile, with the De Beer scale-effect base resistance and the Belgian load-transfer settlement method.</span>
      </div>
      <div class="cols-3">
        ${renderPileInputsColumn(cfg, detailsOpen)}
        ${renderPileVisualsColumn(cfg, analysis)}
        ${renderPileSummaryColumn(cap, set, sHead, sUtil, ulsPass, slsPass, lengthM, cfg)}
      </div>
      <div class="cols-2">
        ${renderPilePerLayerTable(cap)}
        ${renderPileFactorChainTable(cap)}
      </div>
      ${noteHtml(notes)}
    </div>
  `;
}

export function renderPileInputsColumn(cfg, detailsOpen){
  const numField = (path, label, value, opts={}) => `
    <label class="field-stack">${label}
      <input type="number" class="input input--num" step="${opts.step || 0.01}" min="${opts.min ?? 0}" ${opts.max != null ? `max="${opts.max}"` : ''}
        value="${value != null && value !== '' ? value : ''}" placeholder="${opts.placeholder || ''}"
        onchange="setStage6Field('pile.${path}', this.value)">
    </label>`;
  const selectField = (path, label, value, options) => `
    <label class="field-stack">${label}
      <select class="input" onchange="setStage6Field('pile.${path}', this.value)">
        ${options.map(([v,l])=>`<option value="${v}"${value===v?' selected':''}>${l}</option>`).join('')}
      </select>
    </label>`;
  const checkField = (path, label, value) => `
    <label class="check check--row">
      <input type="checkbox" ${value?'checked':''} onchange="setStage6Field('pile.${path}', this.checked)">
      ${label}
    </label>`;

  return `
    <div>
      <div class="card__eyebrow">Inputs</div>
      <div class="fields fields--stack">
        <div class="card card--quiet card--note">Drag the pile toe and head on the section view to set z<sub>toe</sub> and z<sub>head</sub>, or type values here. Drag the shaft / base edges to change D<sub>s</sub> / D<sub>b</sub>. Click any soil layer to snap the toe to its top, mid, or bottom.</div>
        ${selectField('pileType','Pile type',cfg.pileType,[
          ['driven','Driven / jacked'],
          ['screw_displacement','Displacement screw (plastic-concrete shaft)'],
          ['screw_cased','Screw with lost / temporary casing'],
          ['cfa','CFA (continuous flight auger)'],
          ['bored','Bored']
        ])}
        ${selectField('shape','Cross-section',cfg.shape,[
          ['circular','Circular'],
          ['square','Square'],
          ['rectangular','Rectangular']
        ])}
        ${cfg.shape === 'circular' ? `
          ${numField('Ds','Shaft diameter D<sub>s</sub> (m)',cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Db','Base diameter D<sub>b</sub> (m)',cfg.Db,{step:0.01,min:cfg.Ds})}
        ` : cfg.shape === 'square' ? `
          ${numField('a','Side a (m)',cfg.a ?? cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Ds','Shaft equivalent D<sub>s</sub> (m, perimeter use)',cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Db','Base equivalent D<sub>b</sub> (m, base use)',cfg.Db,{step:0.01,min:cfg.Ds})}
        ` : `
          ${numField('a','Short side a (m)',cfg.a ?? cfg.Ds,{step:0.01,min:0.05})}
          ${numField('b','Long side b (m)',cfg.b ?? cfg.a ?? cfg.Ds,{step:0.01,min:cfg.a ?? cfg.Ds})}
          ${numField('Ds','Shaft equivalent D<sub>s</sub> (m)',cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Db','Base equivalent D<sub>b</sub> (m)',cfg.Db,{step:0.01,min:cfg.Ds})}
        `}
        ${numField('Ap','Pile axial cross-section A<sub>p</sub> (m², blank = auto)',cfg.Ap,{step:0.001,min:0.001,placeholder:'auto'})}
        ${numField('zHead','Pile head depth z<sub>head</sub> (m)',cfg.zHead.toFixed(2),{step:0.05,min:0})}
        ${numField('zToe','Pile toe depth z<sub>toe</sub> (m)',cfg.zToe.toFixed(2),{step:0.05,min:cfg.zHead+0.5})}
        ${numField('Fcd','ULS design load F<sub>c,d</sub> (kN)',cfg.Fcd,{step:10,min:0})}
        ${numField('Frep','SLS representative load F<sub>rep</sub> (kN)',cfg.Frep,{step:10,min:0})}
        ${numField('sAllowable','Allowable settlement s<sub>allow</sub> (mm)',cfg.sAllowable,{step:1,min:0.5})}
        <details class="acc" data-st6details="pile-factors"${detailsOpen('pile-factors')}>
          <summary class="acc__head">Factor chain (γ<sub>Rd</sub> / ξ / γ<sub>b</sub>·γ<sub>s</sub>)</summary>
          <div class="acc__body">
            ${selectField('sltCondition','Static load test condition',cfg.sltCondition,[
              ['none','No SLT — γ<sub>Rd1</sub>'],
              ['comparable','SLT in comparable conditions — γ<sub>Rd2</sub>'],
              ['jobsite','SLT on the job site — γ<sub>Rd3</sub>']
            ])}
            ${selectField('nPiles','Number of piles',cfg.nPiles,[
              ['1-3','1–3'],['4-10','4–10'],['>10','>10']
            ])}
            ${selectField('cptDensity','CPT density',cfg.cptDensity,[
              ['1/10m2','1 CPT / 10 m²'],
              ['1/50m2','1 CPT / 50 m²'],
              ['1/100m2','1 CPT / 100 m²'],
              ['1/300m2','1 CPT / 300 m²'],
              ['1/1000m2','1 CPT / 1000 m²']
            ])}
            ${numField('nCpt','Number of CPTs in zone',cfg.nCpt,{step:1,min:1})}
            ${checkField('qaToggle','Quality assurance (QA) — favourable γ<sub>b</sub> column',cfg.qaToggle)}
          </div>
        </details>
        <details class="acc" data-st6details="pile-atg"${detailsOpen('pile-atg')}>
          <summary class="acc__head">ATG / DM20 factor overrides</summary>
          <div class="acc__body">
            ${checkField('useAtg','Use ATG / DM20 overrides',cfg.useAtg)}
            ${cfg.useAtg ? `
              ${numField('atgAlphaB','α<sub>b</sub> override',cfg.atgAlphaB,{step:0.01,min:0.01,placeholder:'default'})}
              ${numField('atgAlphaS','α<sub>s</sub> override',cfg.atgAlphaS,{step:0.01,min:0.01,placeholder:'default'})}
              ${numField('atgGammaRd','γ<sub>Rd</sub> override',cfg.atgGammaRd,{step:0.05,min:0.5,placeholder:'default'})}
              ${numField('atgGammaB','γ<sub>b</sub> override',cfg.atgGammaB,{step:0.05,min:0.5,placeholder:'default'})}
            ` : '<div class="card card--quiet card--note">Tick the box above to expose α<sub>b</sub>, α<sub>s</sub>, γ<sub>Rd</sub>, γ<sub>b</sub> override fields for ATG-certified pile systems.</div>'}
            ${numField('lambdaOverride','λ override (relaxing enlarged base)',cfg.lambdaOverride,{step:0.01,min:0.1,max:1.0,placeholder:'default 1.00'})}
          </div>
        </details>
        <details class="acc" data-st6details="pile-cone"${detailsOpen('pile-cone')}>
          <summary class="acc__head">Mechanical cone correction</summary>
          <div class="acc__body">
            ${checkField('mechanicalCone','Apply mechanical-cone ω correction',cfg.mechanicalCone)}
            ${cfg.mechanicalCone ? selectField('coneType','Cone type',cfg.coneType,[
              ['M1','M1'],['M2','M2'],['M4','M4']
            ]) : '<div class="card card--quiet card--note">Default: CPT-E (electric cone, ω = 1.00). Tick the box for mechanical cones.</div>'}
          </div>
        </details>
        <details class="acc" data-st6details="pile-downdrag"${detailsOpen('pile-downdrag')}>
          <summary class="acc__head">Negative skin friction / downdrag</summary>
          <div class="acc__body">
            ${selectField('downdrag','Downdrag preset',cfg.downdrag,[
              ['none','No downdrag expected'],
              ['moderate','Moderate (4–10 cm settlement → ½ F<sub>nk</sub>)'],
              ['severe','Severe (>10 cm settlement → full F<sub>nk</sub>)']
            ])}
            ${cfg.downdrag !== 'none' ? `
              ${numField('neutralPlane','Neutral plane depth (m)',cfg.neutralPlane,{step:0.05,min:cfg.zHead+0.05,max:cfg.zToe-0.05})}
              <div class="card card--quiet card--note">Layers above the neutral plane lose positive shaft friction and contribute to F<sub>nk</sub> via slip + analogy methods.</div>
            ` : ''}
          </div>
        </details>
        <details class="acc" data-st6details="pile-settlement"${detailsOpen('pile-settlement')}>
          <summary class="acc__head">Settlement parameters</summary>
          <div class="acc__body">
            ${selectField('settlementMethod','Method',cfg.settlementMethod,[
              ['transfer','Belgian load-transfer (recommended)'],
              ['typical-curve','Simplified typical-curve (short, homogeneous piles only)']
            ])}
            ${selectField('pileMaterial','Pile material',cfg.pileMaterial,[
              ['concrete','Reinforced concrete'],
              ['steel','Steel'],
              ['timber','Timber']
            ])}
            ${numField('Ep','E<sub>p</sub> (GPa)',cfg.Ep,{step:1,min:1})}
            ${numField('EbOverride','E<sub>b</sub> override (kPa, blank = oedometric default)',cfg.EbOverride,{step:1000,min:1000,placeholder:'auto'})}
            ${numField('MsOverride','M<sub>s</sub> override (×10⁻³, blank = table)',cfg.MsOverride,{step:0.5,min:0.1,placeholder:'auto'})}
            ${numField('MbOverride','M<sub>b</sub> override (blank = table)',cfg.MbOverride,{step:1,min:0.1,placeholder:'auto'})}
          </div>
        </details>
      </div>
    </div>
  `;
}

export function renderPileVisualsColumn(cfg, analysis){
  return `
    <div class="stack">
      <div class="viz viz--section" style="--viz-h:520px">
        <div class="viz__label">Pile + soil section view (drag to edit)</div>
        <svg id="stage6PileSection" width="100%"></svg>
      </div>
      <div class="viz-grid">
        <div class="viz">
          <div class="viz__title">De Beer transformation chain</div>
          <div class="viz__body"><canvas id="stage6PileDeBeerChart" role="img" aria-label="De Beer profile"></canvas></div>
        </div>
        <div class="viz">
          <div class="viz__title">Per-layer shaft friction q<sub>s</sub></div>
          <div class="viz__body"><canvas id="stage6PileShaftChart" role="img" aria-label="Shaft friction profile"></canvas></div>
        </div>
        <div class="viz">
          <div class="viz__title">Load–settlement curve</div>
          <div class="viz__body"><canvas id="stage6PileLoadSettlementChart" role="img" aria-label="Load-settlement curve"></canvas></div>
        </div>
        <div class="viz">
          <div class="viz__title">Axial force N(z)</div>
          <div class="viz__body"><canvas id="stage6PileAxialForceChart" role="img" aria-label="Axial force profile"></canvas></div>
        </div>
      </div>
    </div>
  `;
}

export function renderPileSummaryColumn(cap, set, sHead, sUtil, ulsPass, slsPass, lengthM, cfg){
  const fmt = (v, dp=0, unit='') => Number.isFinite(+v) ? `${(+v).toFixed(dp)}${unit?(' '+unit):''}` : '—';
  const utilRow = (u) => !Number.isFinite(+u) ? '' : (+u <= 1.0 ? ' class="is-ok"' : ' class="is-fail"');
  const passBadge = (pass, label) => `<span class="pill ${pass?'pill--good':'pill--bad'}">${pass?'PASS':'FAIL'} · ${label}</span>`;
  return `
    <div>
      <div class="card__eyebrow">Summary</div>
      <table class="tbl tbl--kv">
        <tr><td>Pile length L</td><td>${lengthM.toFixed(2)} m</td></tr>
        <tr><td>D<sub>b,eq</sub></td><td>${fmt(cap.Dbeq, 3, 'm')}</td></tr>
        <tr><td>A<sub>b</sub></td><td>${fmt(cap.A_b, 4, 'm²')}</td></tr>
        <tr><td>χ<sub>s</sub></td><td>${fmt(cap.chi_s, 3, 'm')}</td></tr>
        <tr><td>Layer at toe</td><td>${cap.categoryAtToe || '—'}</td></tr>
        <tr><td>q<sub>b</sub> (De Beer)</td><td>${fmt(cap.qb_kPa, 0, 'kPa')}</td></tr>
        <tr><td>α<sub>b</sub> · e<sub>b</sub> · β · λ</td><td>${(cap.alphaB||0).toFixed(2)} · ${(cap.eb||1).toFixed(3)} · ${(cap.beta||1).toFixed(3)} · ${(cap.lambda||1).toFixed(2)}</td></tr>
        <tr><td>R<sub>b</sub></td><td>${fmt(cap.R_b, 0, 'kN')}</td></tr>
        <tr><td>R<sub>s</sub></td><td>${fmt(cap.R_s, 0, 'kN')}</td></tr>
        <tr><td>R<sub>c</sub> = R<sub>b</sub> + R<sub>s</sub></td><td>${fmt(cap.R_c, 0, 'kN')}</td></tr>
        <tr><td>γ<sub>Rd</sub></td><td>${fmt(cap.gammaRd, 2)}</td></tr>
        <tr><td>R<sub>c,cal</sub></td><td>${fmt(cap.R_c_cal, 0, 'kN')}</td></tr>
        <tr><td>ξ<sub>3</sub> / ξ<sub>4</sub> / max</td><td>${(cap.xi?.xi3||0).toFixed(2)} / ${(cap.xi?.xi4||0).toFixed(2)} / <strong>${(cap.xi?.governing||0).toFixed(2)}</strong></td></tr>
        <tr><td>R<sub>c,k</sub></td><td>${fmt(cap.R_c_k, 0, 'kN')}</td></tr>
        <tr><td>γ<sub>b</sub> / γ<sub>s</sub></td><td>${(cap.gamma_b||1).toFixed(2)} / ${(cap.gamma_s||1).toFixed(2)}</td></tr>
        <tr class="key"><td>R<sub>c,d</sub></td><td><strong>${fmt(cap.R_c_d, 0, 'kN')}</strong></td></tr>
        ${cap.neutralPlane != null ? `
          <tr><td>F<sub>nk</sub> slip</td><td>${fmt(cap.F_nk_slip, 0, 'kN')}</td></tr>
          <tr><td>F<sub>nk</sub> analogy</td><td>${fmt(cap.F_nk_analogy, 0, 'kN')}</td></tr>
          <tr><td>F<sub>nk,d</sub> (governing)</td><td><strong>${fmt(cap.F_nk_design, 0, 'kN')}</strong></td></tr>
        ` : ''}
        <tr><td>Effective ULS load</td><td>${fmt(cap.ulsLoad, 0, 'kN')}</td></tr>
        <tr${utilRow(cap.ulsUtil)}><td>ULS utilisation</td><td>${fmt(cap.ulsUtil, 3)}</td></tr>
        ${set ? `
          <tr><td>s<sub>head</sub> (SLS)</td><td>${fmt(sHead, 2, 'mm')}</td></tr>
          <tr><td>z<sub>b</sub> (base)</td><td>${fmt((set.zb_m||0)*1000, 2, 'mm')}</td></tr>
          <tr><td>s<sub>allow</sub></td><td>${cfg.sAllowable.toFixed(1)} mm</td></tr>
          <tr${utilRow(sUtil)}><td>SLS utilisation</td><td>${fmt(sUtil, 3)}</td></tr>
        ` : ''}
      </table>
      <div class="pills" style="margin-top:var(--sp-3)">
        ${passBadge(ulsPass, 'ULS')}
        ${set ? passBadge(slsPass, 'SLS') : ''}
      </div>
    </div>
  `;
}

export function renderPilePerLayerTable(cap){
  const rows = (cap?.perLayer || []).map((row) => {
    const tag = row.excluded ? '<span class="ink-muted">excluded</span>'
      : row.aboveNeutral ? '<span class="ink-bad">above N.P.</span>'
      : '<span class="ink-good">contributing</span>';
    const etaP = row.etaP != null ? row.etaP.toFixed(4) : 'cap';
    return `<tr>
      <td class="num">${row.layerIndex + 1}</td>
      <td class="num">${row.top.toFixed(2)}</td>
      <td class="num">${row.bot.toFixed(2)}</td>
      <td>${row.category}</td>
      <td class="num">${row.qcMean.toFixed(2)}</td>
      <td class="num">${etaP}</td>
      <td class="num">${row.qs.toFixed(0)}</td>
      <td class="num">${row.alphaS.toFixed(2)}</td>
      <td class="num">${row.h.toFixed(2)}</td>
      <td>${tag}</td>
      <td class="num">${row.RsLayer.toFixed(0)}</td>
    </tr>`;
  }).join('');
  return `
    <div class="card card--quiet stack--tight">
      <div class="card__eyebrow">Per-layer shaft resistance</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th class="num">i</th><th class="num">Top (m)</th><th class="num">Bot (m)</th><th>Cat.</th><th class="num">q<sub>c,m</sub> (MPa)</th><th class="num">η*<sub>p</sub></th><th class="num">q<sub>s</sub> (kPa)</th><th class="num">α<sub>s</sub></th><th class="num">h (m)</th><th>Status</th><th class="num">R<sub>s</sub> (kN)</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="11" class="tbl__empty">No layers intersect the pile shaft.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderPileFactorChainTable(cap){
  const fmt = (v, dp=0) => Number.isFinite(+v) ? (+v).toFixed(dp) : '—';
  return `
    <div class="card card--quiet stack--tight">
      <div class="card__eyebrow">Factor chain audit</div>
      <table class="tbl tbl--kv tbl--sm">
        <tr><td>R<sub>c</sub> = R<sub>b</sub> + R<sub>s</sub></td><td class="tbl__v">${fmt(cap.R_c, 0)} kN</td><td class="tbl__note">per-CPT calculated</td></tr>
        <tr><td>÷ γ<sub>Rd</sub></td><td class="tbl__v">${fmt(cap.gammaRd, 2)}</td><td class="tbl__note">${cap.lambdaSource === 'override' ? 'ATG override' : 'DM20 default'}</td></tr>
        <tr><td>= R<sub>c,cal</sub></td><td class="tbl__v">${fmt(cap.R_c_cal, 0)} kN</td><td class="tbl__note">calibrated</td></tr>
        <tr><td>÷ max(ξ<sub>3</sub>, ξ<sub>4</sub>)</td><td class="tbl__v">${fmt(cap.xi?.governing, 2)}</td><td class="tbl__note">single-CPT governing branch (${cap.xi?.branch || '—'})</td></tr>
        <tr><td>= R<sub>c,k</sub></td><td class="tbl__v">${fmt(cap.R_c_k, 0)} kN</td><td class="tbl__note">characteristic</td></tr>
        <tr><td>R<sub>b,k</sub> = ${(cap.RbShare*100).toFixed(0)}% of R<sub>c,k</sub></td><td class="tbl__v">${fmt(cap.R_b_k, 0)} kN</td><td class="tbl__note"></td></tr>
        <tr><td>R<sub>s,k</sub> = ${(cap.RsShare*100).toFixed(0)}% of R<sub>c,k</sub></td><td class="tbl__v">${fmt(cap.R_s_k, 0)} kN</td><td class="tbl__note"></td></tr>
        <tr class="key"><td>R<sub>c,d</sub> = R<sub>b,k</sub>/γ<sub>b</sub> + R<sub>s,k</sub>/γ<sub>s</sub></td><td class="tbl__v"><strong>${fmt(cap.R_c_d, 0)} kN</strong></td><td class="tbl__note">γ<sub>b</sub>=${(cap.gamma_b||1).toFixed(2)}, γ<sub>s</sub>=${(cap.gamma_s||1).toFixed(2)}</td></tr>
      </table>
    </div>
  `;
}
