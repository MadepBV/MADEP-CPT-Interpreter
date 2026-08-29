// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// bearing/notes.js — the bearing app's wording: option lists, help texts and the result notes
// (01-monolith-map.md §2.7 "Shared Stage 6 helpers … options/help text builders", refactor step 7 / PR 12a).
//
// Moved verbatim out of legacy-controller.js (integration-r line numbers):
//   stage6BearingShapeModeDetailHtml 9918-9923 → shapeModeDetailHtml
//   stage6BearingShapeModeDetailText 9925-9930 → shapeModeDetailText
//   stage6BearingEc7Options          10210-10219 → ec7Options
//   stage6BearingEc7Help             10221-10228 → ec7Help
//   stage6BearingShapeModeOptions    10230-10238 → shapeModeOptions
//   stage6BearingShapeModeHelp       10240-10245 → shapeModeHelp
//   stage6BearingNotes               10295-10337 → bearingNotes(sel, cfg) → [{level, text}] for core/format noteHtml
// Pure text builders; `sel` is a bearingAtDepth() result, `cfg` the stage6.bearing block.
import { usesEc7Factors } from './compute.js';

export function shapeModeDetailHtml(mode){
  if(mode === 'conservative'){
    return 'Shape factors are fixed at <code>1.0</code> in conservative mode.';
  }
  return "Shape factors follow the effective-dimension ratio <code>r = B'/L'</code>.";
}

export function shapeModeDetailText(mode){
  if(mode === 'conservative'){
    return 'In conservative mode all shape factors are fixed at 1.0.';
  }
  return 'In Brinch Hansen / Annex D mode the shape factors follow the effective-dimension ratio r = B′/L′.';
}

export function ec7Options(selected){
  const labels = {
    governing:'Governing of DA1/1 and DA1/2 (Recommended)',
    da1_1:'DA1/1 - action-factored route',
    da1_2:'DA1/2 - M2 soil-strength route'
  };
  return ['governing','da1_1','da1_2']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

export function ec7Help(selected){
  const text = {
    governing:'Belgian EC7 bearing checks should normally review both DA1/1 and DA1/2; the governing result is the recommended default in this tool.',
    da1_1:'DA1/1 keeps soil strengths characteristic and is useful when you want to inspect the action-factored side on its own.',
    da1_2:'DA1/2 applies the M2 reduction to soil strengths and often governs geotechnical bearing resistance; inspect it directly if you want to understand the soil-side penalty.'
  };
  return text[selected] || text.governing;
}

export function shapeModeOptions(selected){
  const labels = {
    hansen:'Brinch Hansen / Annex D (Recommended)',
    conservative:'Conservative (shape factors = 1.0)'
  };
  return ['hansen','conservative']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

export function shapeModeHelp(selected){
  if(selected === 'conservative'){
    return 'Conservative mode keeps all shape factors equal to 1.0. Depth factors still apply, but plan-shape enhancement is suppressed.';
  }
  return 'Brinch Hansen / Annex D mode derives the shape factors from the effective plan ratio r = B′/L′ after eccentricity. This is the default and recommended mode.';
}

export function bearingNotes(sel, cfg){
  const notes = [{
    level:'warn',
    text:'Bearing capacity is shown as a shallow-foundation screening curve using the interpreted layer active at each founding depth. Layered failure mechanisms and full eccentric-load verification are not modeled here.'
  }];
  // EN 1997-1 §6.5.4: special precautions are required where the load
  // eccentricity exceeds 1/3 of the footing dimension. The app clamps e at
  // B/2 − 0.025 m but does not otherwise restrict it, so surface the
  // normative warning instead of silently accepting an extreme offset.
  const eB = Number(sel.eB) || 0;
  const eL = Number(sel.eL) || 0;
  if(eB > (Number(sel.BRaw) || sel.B) / 3 || eL > (Number(sel.LRaw) || sel.L) / 3){
    notes.push({
      level:'warn',
      text:'Load eccentricity exceeds 1/3 of the footing width (EN 1997-1 §6.5.4): special precautions are required — careful review of the design actions and the bearing model is mandatory. The middle-third condition (|e| < B/6, no tensile corner reactions) is also violated.'
    });
  } else if(eB > (Number(sel.BRaw) || sel.B) / 6 || eL > (Number(sel.LRaw) || sel.L) / 6){
    notes.push({
      level:'info',
      text:'Load eccentricity exceeds B/6 (middle third): part of the base loses compressive contact; the effective-width model remains valid but check serviceability and edge pressures.'
    });
  }
  notes.push({
    level:'info',
    text:`The current bearing check uses ${sel.ngammaFormulaLabel} for Nγ and ${sel.shapeModeLabel} for shape factors. ${shapeModeDetailText(sel.shapeMode)} It includes Df/B′ depth factors, but it still assumes level ground, horizontal base, and no horizontal load.`
  });
  if(usesEc7Factors(cfg)){
    notes.push({
      level:'info',
      text:'Belgian bearing checks should normally review both DA1/1 and DA1/2; the governing result is the recommended default in this tool.'
    });
    notes.push({
      level:'warn',
      text:'gamma_Rd is kept as an optional model factor only. Leave it at 1.0 unless you intentionally want an extra correction for simplified analytical model bias.'
    });
  } else {
    notes.push({level:'warn', text:'Global/system factor ξ is a legacy-style screening route. Keep it separate from the EC7 partial-factor route and do not stack them.'});
  }
  if(sel.layer.type === 'Sandy clay' || sel.layer.type === 'Peat / organic'){
    notes.push({level:'info', text:'Mixed or organic layers can govern with undrained behaviour. Review both curves before accepting a founding depth.'});
  }
  return notes;
}
