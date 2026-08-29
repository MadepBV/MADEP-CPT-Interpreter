// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GEF (Geotechnical Exchange Format) CPT parser. Moved from
// legacy-controller.js (parseGEF, old lines 1143-1275) in refactor step 5
// (PR 9). Pure: file text in, a parsed-CPT result out — no S, no DOM, no
// dialog (see ./excel.js for the result shape; the caller runs the review
// dialog and applies the patch). The reading loop is verbatim.
//
// Follow-up (not in this pure move): `#COLUMNVOID` markers are ignored, so a
// void value (e.g. -9999) in a mapped column is taken as a reading.

import { cptValueToMPa } from '../../import-review/tabular.js';

/** Channels shown read-only in the review dialog (GEF declares its columns
    in the header through COLUMNINFO quantity IDs). */
export const GEF_CHANNELS=[
  {qid:11, alt:1, label:'Diepte'},
  {qid:2, label:'Conusweerstand qc'},
  {qid:3, label:'Kleefweerstand fs'},
  {qid:4, label:'Wrijvingsgetal Rf'},
  {qid:6, label:'Waterspanning u2'}
];

export function parseGEF(txt,fname){
  const lines=txt.split(/\r?\n/);
  const colMap={};  // quantityID → 0-based col index
  const unitMap={}; // quantityID → declared unit string from COLUMNINFO
  let eoh=false, wl=null, zid=null, aRatio=0.8;
  const meta={fname};
  const rows=[];

  for(const raw of lines){
    const l=raw.trim();
    if(!l)continue;
    if(l.toUpperCase().startsWith('#EOH')){eoh=true;continue;}

    if(!eoh){
      if(l.startsWith('#COLUMNINFO')){
        // format: #COLUMNINFO= colIndex, unit, description, quantityID
        const rest=l.slice(l.indexOf('=')+1).split(',');
        if(rest.length>=4){
          const ci=parseInt(rest[0].trim())-1;
          const unit=(rest[1]||'').trim();
          const qi=parseInt(rest[3].trim());
          if(!isNaN(ci)&&!isNaN(qi)){
            colMap[qi]=ci;
            unitMap[qi]=unit;
          }
        }
      }
      if(l.startsWith('#MEASUREMENTVAR')){
        const m=l.match(/#MEASUREMENTVAR\s*=\s*(\d+)\s*,\s*([\-\d.eE+]+)/);
        if(m){
          const id=+m[1],val=parseFloat(m[2]);
          if(id===14&&!isNaN(val))wl=Math.abs(val);   // water table depth
          if(id===3 &&!isNaN(val))aRatio=val;           // net area ratio
        }
      }
      if(l.startsWith('#ZID')){
        const m=l.match(/#ZID\s*=\s*[^,]+,\s*([\-\d.eE+]+)/);
        if(m)zid=parseFloat(m[1]);
      }
      if(l.startsWith('#PROJECTID'))  meta.project=l.split('=')[1].trim();
      if(l.startsWith('#TESTID'))     meta.testid=l.split('=')[1].trim();
      if(l.startsWith('#STARTDATE'))  meta.date=l.split('=')[1].trim();
      if(l.startsWith('#FILEOWNER'))  meta.owner=l.split('=')[1].trim();
      if(l.startsWith('#MEASUREMENTTEXT')&&/lokatie|location/i.test(l)){
        const m=l.match(/=\s*\d+\s*,\s*([^,]+)/);
        if(m)meta.location=m[1].trim();
      }
      continue;
    }

    if(l.startsWith('!'))continue;
    const parts=l.split(/\s+/).filter(Boolean);
    if(parts.length<2)continue;
    let vals;try{vals=parts.map(Number);}catch(e){continue;}
    if(vals.some(v=>isNaN(v)))continue;

    function get(qid){const ci=colMap[qid];return(ci!=null&&ci<vals.length)?vals[ci]:null;}
    function unitFor(qid){return (unitMap[qid]||'').toLowerCase();}

    const z=get(11)??get(1);   // prefer corrected depth
    const qc_v=get(2);
    const fs_v=get(3);
    const rf_v=get(4);         // % as declared
    const u2_v=get(6);

    if(z==null||qc_v==null||isNaN(z)||isNaN(qc_v)||z<0)continue;

    const qc=cptValueToMPa(qc_v, unitFor(2), 'qc');
    const fs=cptValueToMPa(fs_v, unitFor(3), 'fs');

    let rf=null;
    if(rf_v!=null&&!isNaN(rf_v)&&rf_v>=0&&rf_v<50){
      rf=Math.min(rf_v,20);
    } else if(fs!=null&&qc>0.05){
      rf=Math.max(0,Math.min(20,(Math.abs(fs)/qc)*100));
    }

    const u2=u2_v!=null&&!isNaN(u2_v)?u2_v:null;
    if(qc<0.02)continue;  // cone not engaged

    rows.push({z:+z.toFixed(4),qc:+qc.toFixed(4),
      fs:fs!=null?+fs.toFixed(6):null,
      rf:rf!=null?+rf.toFixed(3):null,u2});
  }

  // Review before apply — GEF columns are declared in the file header
  // (COLUMNINFO quantity IDs), so the mapping is shown read-only.
  const channels=GEF_CHANNELS
    .map(ch=>{
      const qid=colMap[ch.qid]!=null?ch.qid:(ch.alt!=null&&colMap[ch.alt]!=null?ch.alt:null);
      if(qid==null) return {label:ch.label, source:'niet in bestand', unit:''};
      return {label:ch.label, source:`kolom ${colMap[qid]+1} (GEF #${qid})`, unit:unitMap[qid]||''};
    });
  const review={
    fileName:fname,
    format:'GEF',
    rows,
    channels,
    context:{
      waterLevel:wl,
      waterSource:wl!=null?'MEASUREMENTVAR 14':null,
      elevation:zid,
      elevationSource:zid!=null?'ZID':null,
      x:null, y:null,
      testid:meta.testid||null,
      project:meta.project||null
    }
  };

  return {
    ok:true,
    format:'GEF',
    fileName:fname,
    rows,
    columns:{colMap, unitMap},
    waterLevel:wl,
    waterSource:wl!=null?'MEASUREMENTVAR 14':null,
    elevation:zid,
    elevationSource:zid!=null?'ZID':null,
    meta:{...meta,importFormat:'GEF',aRatio,zid},
    review
  };
}
