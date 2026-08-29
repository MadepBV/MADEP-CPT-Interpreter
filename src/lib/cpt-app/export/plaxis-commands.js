// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// export/plaxis-commands.js — PLAXIS `soilmat` material commands (Mohr-Coulomb and
// Hardening Soil per layer) plus the nu'/drainage warning that accompanies them.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 8, refactor step 4): the helpers
// safeMaterialToken … msToMday (old lines 15642-15679 at c989770, verbatim) and the text
// half of `exportPlaxisCommands` (15681-15756). The only change: the CPT state is a
// parameter instead of the module-level active CPT `S`, and hsParams/khParams get the
// explicit model ctx (cptModelCtx). The alert and the `<a download>` click stay in the
// controller wrapper (it calls buildPlaxisCommandsText → plaxisNuDrainageConflicts →
// alert → download, in the old order).

import { cptModelCtx, hsParams, khParams } from '../model-params/index.js';

export function safeMaterialToken(value){
  let txt=String(value??'').trim();
  if(txt.normalize) txt=txt.normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
  txt=txt.replace(/[(),]/g,'').replace(/\s+/g,'_').replace(/[^A-Za-z0-9_.-]/g,'');
  return txt || 'Layer';
}

export function plaxisDrainageType(layer){
  const sub=(layer.subtype||'').toLowerCase();
  if(sub.includes('(lh)') || sub.includes('(kh)') || sub.includes('leemhoudend') || sub.includes('klei-/leemhoudend')){
    return 'Undrained A';
  }
  return layer.type==='Sand' || layer.type==='Gravel' ? 'Drained' : 'Undrained A';
}

export function plaxisDisplayName(value){
  return String(value??'')
    .replace(/"/g, '\'')
    .replace(/\r?\n/g, ' ')
    .trim();
}

export function plaxisCommandValue(value){
  if(typeof value === 'number'){
    if(!isFinite(value)) return '0';
    return Object.is(value, -0) ? '0' : String(value);
  }
  return `"${plaxisDisplayName(value)}"`;
}

export function buildPlaxisSoilmatCommand(pairs){
  return `soilmat ${pairs.map(([key,val])=>`${plaxisCommandValue(key)} ${plaxisCommandValue(val)}`).join(' ')}`;
}

export function msToMday(value){
  if(!isFinite(value)) return 0;
  return +(value * 86400).toFixed(6);
}

/** The CPT identifier used in the material names and the file name. */
export function plaxisCptId(cpt){
  return cpt.meta.testid||cpt.id||'CPT';
}

/**
 * PLAXIS material commands, CRLF-joined (two `soilmat` lines per layer: _MC and _HS).
 * @param {object} cpt  CPT state: layers, meta.testid, id are read.
 * @param {object} ctx  model ctx (cptModelCtx(cpt) by default).
 */
export function buildPlaxisCommandsText(cpt, ctx = cptModelCtx(cpt)){
  const cptId=plaxisCptId(cpt);
  const commands=cpt.layers.flatMap((l,i)=>{
    const layerId=i+1;
    const subtype=l.subtype||l.type||`Layer_${layerId}`;
    const safeSubtype=safeMaterialToken(subtype);
    const baseName=`${safeMaterialToken(cptId)}_L${layerId}_${safeSubtype}`;
    const dr=plaxisDrainageType(l);
    const h=hsParams(l, ctx);
    const k=khParams(l, ctx);
    const khMday=msToMday(k.kh_rep);
    const kvMday=msToMday(k.kv_rep);
    const cohesion=Math.max(Number(l.c)||0,0.1);
    const mcName=`${baseName}_MC`;
    const hsName=`${baseName}_HS`;

    return[
      buildPlaxisSoilmatCommand([
        ['Identification', mcName],
        ['SoilModel', 2],
        ['DrainageType', dr],
        ['gammaUnsat', l.g],
        ['gammaSat', l.gs],
        ['ERef', h.Emc],
        ['nu', h.nu],
        ['cRef', cohesion],
        ['phi', l.phi],
        ['psi', h.psi],
        ['PermHorizontalPrimary', khMday],
        ['PermVertical', kvMday]
      ]),
      buildPlaxisSoilmatCommand([
        ['Identification', hsName],
        ['SoilModel', 3],
        ['DrainageType', dr],
        ['gammaUnsat', l.g],
        ['gammaSat', l.gs],
        ['E50Ref', h.E50_ref],
        ['EOedRef', h.Eoed_ref],
        ['EURRef', h.Eur_ref],
        ['PowerM', h.m],
        ['pRef', 100],
        ['cRef', cohesion],
        ['phi', l.phi],
        ['psi', h.psi],
        ['PermHorizontalPrimary', khMday],
        ['PermVertical', kvMday]
      ])
    ];
  });
  return commands.join('\r\n');
}

/* PLAXIS requires nu' < 0.35 for Undrained (A)/(B) materials (Material
   Models Manual 3.3.2); cohesive layers export as Undrained A, so soft
   fine layers at the table default nu' = 0.40 will be flagged on import.
   Warn (without altering the exported values) so the engineer reviews
   nu or the drainage type in PLAXIS. */
export function plaxisNuDrainageConflicts(cpt, ctx = cptModelCtx(cpt)){
  return cpt.layers
    .map((l,i)=>({i:i+1, dr:plaxisDrainageType(l), nu:hsParams(l, ctx).nu, subtype:l.subtype||l.type}))
    .filter(x=>x.dr!=='Drained' && x.nu>=0.35);
}

/** The alert text for a non-empty conflict list (exactly the controller's wording). */
export function plaxisNuDrainageAlertMessage(nuDrainageConflicts){
  return 'PLAXIS note: nu′ >= 0.35 combined with Undrained A will be flagged by PLAXIS (Material Models Manual 3.3.2).\n\n'
    +nuDrainageConflicts.map(x=>`Layer ${x.i} (${x.subtype}): nu = ${x.nu}`).join('\n')
    +'\n\nThe export is unchanged; review nu or the drainage type in PLAXIS.';
}

/** Download file name of the commands file. */
export function plaxisCommandsFilename(cpt){
  return `CPT_${safeMaterialToken(plaxisCptId(cpt))}_plaxis_materials_commands.txt`;
}
