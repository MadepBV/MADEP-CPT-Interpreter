// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Excel CPT workbook parser (Data + Header sheets). Moved from
// legacy-controller.js (loadXlsxModule / parseExcelCpt, old lines 916-1049) in
// refactor step 5 (PR 9). Pure: the XLSX module and the file buffer come in,
// a parsed-CPT result comes out — no S, no DOM, no dialog. The review dialog
// and the apply step are driven by the caller (legacy-controller.js
// importParsedCpt → applyParsedCptTo).
//
// Result: { ok:true, format:'Excel', fileName, rows, skipped, waterLevel,
//   waterSource, elevation, elevationSource, x, y, coordinateSource, meta,
//   review } — `review` is the staged object for presentImportReview minus
//   context.assumedRf (the target CPT's setting, added by the caller); `rows`
//   are built from the auto-detected column mapping (what the dialog shows
//   first, and what an unchanged confirmation applies).
// Or { ok:false, error } carrying the alert text of the old early returns.

import { buildRowsFromGrid, detectColumns, findDataHeaderRow } from '../../import-review/tabular.js';
import { excelHeaderNumber, excelHeaderText, findExcelSheetName } from './excel-headers.js';

let xlsxModulePromise = null;

/** Lazily loaded `xlsx` (SheetJS) — one dynamic import per page. */
export function loadXlsxModule(){
  if(!xlsxModulePromise){
    xlsxModulePromise=import('xlsx').then(module=>module.default?.read?module.default:module);
  }
  return xlsxModulePromise;
}

export function parseExcelCpt(XLSX, buffer, fname){
  let workbook;
  try{
    workbook=XLSX.read(buffer,{type:'array',cellDates:true});
  }catch(err){
    return {ok:false, error:`Could not read Excel workbook: ${err?.message||err}`};
  }

  const dataSheetName=findExcelSheetName(workbook,'Data') || workbook.SheetNames[0];
  const headerSheetName=findExcelSheetName(workbook,'Header');
  const dataSheet=workbook.Sheets[dataSheetName];
  if(!dataSheet) return {ok:false, error:'No data sheet found in Excel workbook.'};

  const dataRows=XLSX.utils.sheet_to_json(dataSheet,{header:1,raw:true,defval:null,blankrows:false});
  const headerRows=headerSheetName
    ? XLSX.utils.sheet_to_json(workbook.Sheets[headerSheetName],{header:1,raw:true,defval:null,blankrows:false})
    : [];

  const headerIdx=findDataHeaderRow(dataRows);
  if(headerIdx<0) return {ok:false, error:'Could not find depth/qc columns in the Excel data sheet.'};

  const cols=detectColumns(dataRows[headerIdx]||[]);
  if(cols.z<0 || cols.qc<0) return {ok:false, error:'Excel data sheet needs at least depth and qc columns.'};

  const water=excelHeaderNumber(headerRows,['Waterniveau','Water level']);
  const elevation=excelHeaderNumber(headerRows,['Grondniveau','Surface level','Ground level','ZID']);
  const x=excelHeaderNumber(headerRows,['E Coordinate','X Coordinate','Easting']);
  const y=excelHeaderNumber(headerRows,['N Coordinate','Y Coordinate','Northing']);
  const aRatio=excelHeaderNumber(headerRows,['Alpha Factor','Alpha','Area ratio']) ?? 0.8;
  const betaFactor=excelHeaderNumber(headerRows,['Beta Factor','Beta']);
  const project=excelHeaderText(headerRows,['Taak Nummer','Project','Project ID']);
  const testid=excelHeaderText(headerRows,['Sondering Nummer','Test ID','CPT ID']);
  const client=excelHeaderText(headerRows,['Client Naam','Client Name','File owner']);
  const operator=excelHeaderText(headerRows,['Operator']);
  const location=excelHeaderText(headerRows,['Locatie','Location']);
  const date=excelHeaderText(headerRows,['Datum','Date']);
  const coneNumber=excelHeaderText(headerRows,['Conus Nummer','Cone Number']);
  const penetrationDepth=excelHeaderNumber(headerRows,['Penetratiediepte','Penetration depth']);

  const built=buildRowsFromGrid(dataRows, headerIdx, cols);

  // Review before apply: the engineer confirms the column mapping and the
  // derived statistics (and can remap columns) before the data enters the
  // project. Cancelling aborts this file's import.
  const review={
    fileName:fname,
    format:'Excel',
    grid:dataRows,
    headerIdx,
    cols,
    context:{
      waterLevel:water!=null?Math.abs(water):null,
      waterSource:water!=null?'Header Waterniveau':null,
      elevation,
      elevationSource:elevation!=null?'Header Grondniveau':null,
      x, y, testid, project
    }
  };

  return {
    ok:true,
    format:'Excel',
    fileName:fname,
    rows:built.rows,
    skipped:built.skipped,
    waterLevel:water!=null?Math.abs(water):null,
    waterSource:water!=null?'Header Waterniveau':null,
    elevation,
    elevationSource:elevation!=null?'Header Grondniveau':null,
    x,
    y,
    coordinateSource:(x!=null||y!=null)?'Header coordinates':null,
    meta:{
      fname,
      importFormat:'Excel',
      project,
      testid,
      client,
      owner:client||operator,
      operator,
      location,
      date,
      coneNumber,
      penetrationDepth,
      aRatio,
      betaFactor,
      zid:elevation
    },
    review
  };
}
