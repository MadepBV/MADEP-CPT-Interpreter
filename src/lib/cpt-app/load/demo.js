// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// The demo profile. Moved from legacy-controller.js loadDemo (old lines
// 1626-1657) in refactor step 5 (PR 9): demoRows() is the reading generator
// with the exact bands, step and rounding of the original loop, the random
// source injected (the golden harness seeds it with mulberry32 — the
// committed fixtures/cpt/demo-anonymous.gef is this generator at seed
// 20260829); demoPatch() is the Stage 1 state the demo sets (the same field
// set as apply-parsed-cpt.js, coordinates untouched). Pure: no S, no DOM.

/** Readings of the demo profile — 0.14 … 21.73 m at 0.02 m; `random` is
    called twice per reading (qc, then rf) in the same order as before. */
export function demoRows(random=Math.random){
  const rows=[];
  for(let z=0.14;z<=21.73;z=+(z+0.02).toFixed(3)){
    let qc,rf;
    if(z<0.6)      {qc=0.15+random()*0.12;rf=0.7+random()*0.4;}
    else if(z<1.5) {qc=3+random()*2.5;   rf=0.5+random()*0.4;}
    else if(z<3.0) {qc=7+random()*3;     rf=0.8+random()*0.7;}
    else if(z<5.5) {qc=1.2+random()*1;   rf=4+random()*3;}
    else if(z<7.0) {qc=1.5+random()*0.8; rf=3.5+random()*2;}
    else if(z<9.5) {qc=4+random()*4;     rf=1.2+random()*0.8;}
    else if(z<11)  {qc=2+random()*1;     rf=3+random()*2;}
    else           {qc=3.5+random()*5;   rf=1.5+random()*2;}
    const fs=qc*rf/100;
    rows.push({z,qc:+qc.toFixed(4),fs:+fs.toFixed(6),rf:+rf.toFixed(3),u2:null});
  }
  return rows;
}

/** Stage 1 patch of the demo: rows + water table + surface level + meta
    (`depthMax` is the loop bound 21.73 as before, the last reading is 21.72). */
export function demoPatch(random=Math.random){
  const rows=demoRows(random);
  return {
    data:rows, wt:1.7, wtFromFile:true,
    wtSource:'demo',
    elev:69.97, elevFromFile:true, elevSource:'demo',
    meta:{project:'Demo Project A',testid:'CPT-1 (demo)',location:'Reference site — anonymised',owner:'Anonymous source',
      date:'2025, 7, 7',aRatio:0.79,zid:69.97,fname:'demo-anonymous.GEF',
      nRows:rows.length,depthMin:0.14,depthMax:21.73,hasU2:false,hasFs:true,hasRf:true}
  };
}
