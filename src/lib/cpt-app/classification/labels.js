// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/labels.js — display labels of the Stage 2 classification methods.
//
// Moved verbatim out of src/lib/cpt-app/legacy-controller.js (PR 6, refactor step 3),
// lines 1681-1703. Pure string functions: used by the Stage 2 panel (run.js / panel.js),
// by the Stage 7 report (stage7MethodLabel) and by the method cards.

export function classificationMethodLabel(method){
  return {
    robertson:'Robertson (1990)',
    robertson2016:'Robertson (2016)',
    cur3:'CUR 3 layers',
    nen6740:'NEN 6740',
    sb260:'NEN Tabel 3 / EC7'
  }[method] || method || 'Unknown';
}

export function classificationMetricLabel(method){
  if(method === 'robertson') return 'Ic (-)';
  if(method === 'robertson2016') return 'Qtn (-)';
  if(method === 'nen6740') return 'qc,NEN (MPa)';
  return 'Metric (-)';
}

export function classificationMetricValue(method, row){
  if(method === 'robertson') return row.Ic != null ? row.Ic : '—';
  if(method === 'robertson2016') return row.Qt != null ? row.Qt.toFixed(1) : '—';
  if(method === 'nen6740') return row.Qt != null ? row.Qt.toFixed(2) : '—';
  return '—';
}
