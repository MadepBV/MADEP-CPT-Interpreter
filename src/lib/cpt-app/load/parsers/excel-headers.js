// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Excel "Header" sheet lookups for the CPT workbook importer. Moved verbatim
// from legacy-controller.js (pad2 / formatExcelHeaderValue / normalizeExcelLabel /
// excelHeaderLookup / excelHeaderText / excelHeaderNumber / findExcelSheetName,
// old lines 863-914) in refactor step 5 (PR 9). Pure: header rows in, values out.

import { parseCptNumber } from '../../import-review/tabular.js';

export function pad2(n){
  return String(n).padStart(2,'0');
}

export function formatExcelHeaderValue(value, key=''){
  if(value==null) return '';
  if(value instanceof Date && !isNaN(value)){
    if(/tijd|time/i.test(key)){
      return `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
    }
    return `${pad2(value.getDate())}/${pad2(value.getMonth()+1)}/${value.getFullYear()}`;
  }
  if(typeof value==='number'){
    return Number.isInteger(value)?String(value):String(value);
  }
  return String(value).trim();
}

export function normalizeExcelLabel(value){
  return String(value||'')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ');
}

export function excelHeaderLookup(headerRows, labels){
  const wanted=labels.map(normalizeExcelLabel);
  for(const row of headerRows){
    const key=normalizeExcelLabel(row?.[0]);
    if(wanted.includes(key)) return row?.[1];
  }
  return null;
}

export function excelHeaderText(headerRows, labels){
  const raw=excelHeaderLookup(headerRows, labels);
  const label=labels[0]||'';
  const text=formatExcelHeaderValue(raw,label);
  return text||null;
}

export function excelHeaderNumber(headerRows, labels){
  return parseCptNumber(excelHeaderLookup(headerRows, labels));
}

export function findExcelSheetName(workbook, preferredName){
  const wanted=normalizeExcelLabel(preferredName);
  return workbook.SheetNames.find(name=>normalizeExcelLabel(name)===wanted)
    || workbook.SheetNames.find(name=>normalizeExcelLabel(name).includes(wanted));
}
