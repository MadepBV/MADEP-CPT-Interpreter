// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// CPT file-kind sniffing for the Stage 1 loader. Moved verbatim from
// legacy-controller.js (stripCptFileExtension / isExcelCptFile / isCsvCptFile,
// old lines 417-434) in refactor step 5 (PR 9). Pure: strings in, booleans out.

export function stripCptFileExtension(name){
  return String(name||'CPT').replace(/\.(gef|txt|csv|xls|xlsx)$/i,'');
}

export function isExcelCptFile(file){
  const name=String(file?.name||'');
  const type=String(file?.type||'');
  return /\.(xls|xlsx)$/i.test(name)
    || type.includes('spreadsheet')
    || type.includes('excel');
}

export function isCsvCptFile(file){
  const name=String(file?.name||'');
  const type=String(file?.type||'');
  return /\.csv$/i.test(name) || type.includes('csv');
}
