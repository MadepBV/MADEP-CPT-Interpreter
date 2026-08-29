// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// dewatering/options.js — the wording of the dewatering app's "Combination context" select: its
// <option> list and help text (01-monolith-map.md §2.6/§2.9 "option/help text builders", §6.1 row
// `dewatering/`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js (integration-r @ 07f0645 line numbers), renamed to drop the prefix:
//   stage6DewateringCombinationOptions 9240-9246 → combinationOptions
//   stage6DewateringCombinationHelp    9248-9253 → combinationHelp
//
// Pure text builders; `selected` is the current select value ('characteristic' | 'qp').

export function combinationOptions(selected){
  const labels = {
    characteristic:'Characteristic drawdown',
    qp:'Quasi-permanent drawdown context'
  };
  return ['characteristic','qp'].map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`).join('');
}

export function combinationHelp(selected){
  if(selected === 'qp'){
    return 'Quasi-permanent is useful as a contextual serviceability label when the lowered water level is expected to persist for a long period. In the current tool, the entered drawdown itself is still used directly.';
  }
  return 'Characteristic is the recommended default here: enter the expected drawdown directly and do not factor it as a ULS variable load.';
}
