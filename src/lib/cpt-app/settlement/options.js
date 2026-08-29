// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// settlement/options.js — the Eurocode load-combination wording of the settlement app: the <option>
// lists and help texts of the "Load assumptions and Eurocode combination" accordion
// (01-monolith-map.md §2.6/§2.9 "option/help text builders", §6.1 row `settlement/`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js (integration-r @ 07f0645 line numbers), renamed to drop the `stage6` prefix:
//   stage6UseCategoryOptions       9185-9199 → useCategoryOptions
//   stage6UseCategoryHelp          9201-9213 → useCategoryHelp
//   stage6SlsCombinationOptions    9215-9224 → slsCombinationOptions
//   stage6SlsCombinationHelp       9226-9238 → slsCombinationHelp
//
// Pure text builders; `selected` is the current select value. The same four are used by the beam app's
// load accordion (beam/panel.js imports them from here — the use category / SLS combination wording
// is one text, `slsCombinationHelp(selected, context)` picks the "For settlement" / "For deflection" prefix).

export function useCategoryOptions(selected){
  const labels = {
    A:'A - residential / domestic',
    B:'B - offices',
    C:'C - assembly / congregation',
    D:'D - shopping / commercial',
    E:'E - storage',
    W:'W - wind',
    S:'S - snow',
    T:'T - temperature'
  };
  return ['A','B','C','D','E','W','S','T']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

export function useCategoryHelp(selected){
  const text = {
    A:'Residential and domestic imposed loads. Typical default for houses and small residential slabs.',
    B:'Office loading. Use when the supported structure behaves like an office floor or office occupancy.',
    C:'Assembly / congregation loading. Higher variable load factors for halls, schools, and gathering spaces.',
    D:'Shopping and retail loading. Similar to C but framed for commercial occupancy.',
    E:'Storage / warehouse loading. Highest default psi factors of the building-use categories.',
    W:'Wind action. Only use when the variable action is wind rather than occupancy load.',
    S:'Snow action. Belgian lowland snow defaults.',
    T:'Temperature action. Only use if temperature effects govern the variable action.'
  };
  return text[selected] || text.A;
}

export function slsCombinationOptions(selected){
  const labels = {
    qp:'Quasi-permanent',
    frequent:'Frequent',
    characteristic:'Characteristic'
  };
  return ['qp','frequent','characteristic']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

export function slsCombinationHelp(selected, context){
  const prefix = context === 'settlement'
    ? 'For settlement'
    : context === 'beam'
      ? 'For deflection'
      : 'For serviceability';
  const text = {
    qp:`${prefix}, quasi-permanent is the usual default for long-term behaviour and is the recommended starting point.`,
    frequent:`${prefix}, frequent is useful for intermediate serviceability checks when the variable action is present often but not permanently.`,
    characteristic:`${prefix}, characteristic is the better fit for short-term or immediate response checks and is usually less relevant for long-term consolidation.`
  };
  return text[selected] || text.qp;
}
