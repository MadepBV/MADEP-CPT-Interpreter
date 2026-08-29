// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Delimited-text (CSV) CPT parser. Moved from legacy-controller.js
// (splitDelimitedLine / parseDelimitedText / detectDelimitedTextSeparator /
// parseCsvCpt, old lines 1051-1141) in refactor step 5 (PR 9). Pure: text in,
// a parsed-CPT result out — no S, no DOM, no dialog (see ./excel.js for the
// result shape; the caller runs the review dialog and applies the patch).
//
// Known behaviour locked by the goldens (tests/golden/README.md, "Known app
// behaviour"): a `;`-separated file with comma decimals is scored as
// `,`-delimited by detectDelimitedTextSeparator (the decimals count as extra
// columns) — a fix is a behaviour change with its own golden update.

import { buildRowsFromGrid, detectColumns, findDataHeaderRow } from '../../import-review/tabular.js';
import { stripCptFileExtension } from '../file-kind.js';

export function splitDelimitedLine(line, delimiter){
  const cells=[];
  let cell='';
  let quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){
        cell+='"';
        i++;
      }else{
        quoted=!quoted;
      }
    }else if(ch===delimiter && !quoted){
      cells.push(cell.trim());
      cell='';
    }else{
      cell+=ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseDelimitedText(text, delimiter){
  return String(text||'')
    .replace(/^\uFEFF/,'')
    .split(/\r?\n/)
    .map(line=>splitDelimitedLine(line, delimiter))
    .filter(row=>row.some(cell=>String(cell||'').trim()!==''));
}

export function detectDelimitedTextSeparator(text){
  const sample=String(text||'')
    .replace(/^\uFEFF/,'')
    .split(/\r?\n/)
    .filter(line=>line.trim())
    .slice(0,20);
  const delimiters=[',',';','\t'];
  let best={delimiter:',',score:-Infinity};
  for(const delimiter of delimiters){
    const rows=sample.map(line=>splitDelimitedLine(line, delimiter));
    const headerIdx=findDataHeaderRow(rows);
    const maxCols=Math.max(...rows.map(row=>row.length),0);
    const avgCols=rows.length?rows.reduce((sum,row)=>sum+row.length,0)/rows.length:0;
    const score=(headerIdx>=0?100:0) + maxCols*3 + avgCols;
    if(score>best.score) best={delimiter,score};
  }
  return best.delimiter;
}

export function parseCsvCpt(text,fname){
  const delimiter=detectDelimitedTextSeparator(text);
  const tableRows=parseDelimitedText(text, delimiter);
  const headerIdx=findDataHeaderRow(tableRows);
  if(headerIdx<0) return {ok:false, error:'Could not find depth/qc columns in the CSV file.'};

  const cols=detectColumns(tableRows[headerIdx]||[]);
  if(cols.z<0 || cols.qc<0) return {ok:false, error:'CSV file needs at least depth and qc columns.'};

  const built=buildRowsFromGrid(tableRows, headerIdx, cols);
  const testid=stripCptFileExtension(fname);

  const review={
    fileName:fname,
    format:'CSV',
    grid:tableRows,
    headerIdx,
    cols,
    context:{
      waterLevel:null,
      elevation:null,
      x:null, y:null,
      testid,
      project:null
    }
  };

  return {
    ok:true,
    format:'CSV',
    fileName:fname,
    delimiter,
    rows:built.rows,
    skipped:built.skipped,
    waterLevel:null,
    elevation:null,
    meta:{
      fname,
      importFormat:'CSV',
      project:null,
      testid,
      owner:null,
      location:null,
      date:null,
      aRatio:0.8,
      zid:null
    },
    review
  };
}
