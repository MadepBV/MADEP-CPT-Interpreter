// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/table.js — the Stage 3 layer table: the Eurocode / NEN Tabel 3 subtype dropdown, the
// row markup and the compatibility warning panel below it. 01-monolith-map.md §6.1 row `layers/`
// (`table.js`), moved out of legacy-controller.js in PR 20 / refactor step 10.
//
// CONCEPTUAL SEPARATION (the monolith's own note, kept here with the code):
//   - Stage 2 (classification): Robertson / CUR 3 / NEN 6740 / Eurocode Table 3 assigns a CPT
//     soil type per depth reading, then layers are detected. This determines the BOUNDARY logic.
//   - Stage 3 (parameter method): independently assigns geotechnical parameters (γ, φ', c', cu)
//     to each layer — the generic DEF table (CPT-type defaults) or Eurocode / NEN Tabel 3 (the
//     full subtype catalogue with consistentie). Independent of the Stage 2 method.
//   - Stage 4 (model): derives HS / MC params from the Stage 3 output.
//
// The subtype dropdown always shows the full catalogue: compatible entries first (enabled),
// adjacent / transition entries marked, incompatible families disabled. The warning panel flags
// any layer whose subtype is outside the compatible or adjacent range for its CPT type.
//
// `buildSubtypeDropdown` and `renderLayerRowsHtml` are pure string builders; `renderLayers` and
// `renderCompatWarnings` are their DOM writers. The inline `onchange="changeSubtype(this)"` /
// `onchange="editL(this)"` names are published by installLayersApp's handlers.

import { CAT } from '../eurocode-tabel3.js';
import { CAT_GROUPS, compatLevel, qcRfFit } from './tabel3-compat.js';
import { SOIL_CLASS_NAMES } from '../soil-styles.js';

const SC = SOIL_CLASS_NAMES;

/* Build the subtype dropdown for one layer.
   Groups: compatible entries first (enabled), adjacent (enabled, marked),
   incompatible last (disabled). */
export function buildSubtypeDropdown(l, i){
  const cptType=l.type;
  const cur=l.subtype||'';
  const qc=l.avgQc;
  // null (not an assumed 3): qcRfFit then skips the Rf check, matching the
  // suggestion engine — otherwise a qc-only CPT shows no ✓ on any sand entry.
  const rf=l.avgRf??null;
  const bdCol=l.ovr.subtype?'var(--wn)':'var(--bd2)';

  // Sort entries: ok → adj → bad
  const sorted=[
    ...CAT.filter(r=>compatLevel(cptType,r.grp)==='ok'),
    ...CAT.filter(r=>compatLevel(cptType,r.grp)==='adj'),
    ...CAT.filter(r=>compatLevel(cptType,r.grp)==='bad'),
  ];

  const sections={ok:'',adj:'',bad:''};
  const grpOpen={ok:'',adj:'',bad:''};

  for(const row of sorted){
    const level=compatLevel(cptType,row.grp);
    const sel=row.subtype===cur?' selected':'';
    const grpLabel=CAT_GROUPS[row.grp]||row.grp;
    const key=level+'__'+row.grp;
    if(grpOpen[level]!==key){
      if(grpOpen[level]) sections[level]+='</optgroup>';
      const prefix=level==='adj'?'⚠ Overgang — ':'';
      sections[level]+=`<optgroup label="${prefix}${grpLabel}">`;
      grpOpen[level]=key;
    }

    // Visual fit hints — 'ok' entries never disabled (user must be able to select any)
    // 'bad' (incompatible soil family) remain disabled
    let disabled='', label=row.label, titleAttr='';
    if(level==='ok'){
      const fit=qcRfFit(row,qc,rf);
      if(fit==='match'){
        label='✓ '+row.label;            // clear best match
      } else if(fit==='close'){
        label='~ '+row.label;            // borderline
      } else {
        label='· '+row.label;            // out of range but still selectable
      }
    } else if(level==='adj'){
      label='⚠ '+row.label;             // adjacent/transition
    } else if(level==='bad'){
      disabled=' disabled';               // incompatible family — truly disabled
    }

    sections[level]+=`<option value="${row.subtype}"${sel}${disabled}>${label}</option>`;
  }
  for(const lv of ['ok','adj','bad']) if(grpOpen[lv]) sections[lv]+='</optgroup>';

  let inner=`<option value="">— kies grondsoort —</option>`;
  if(sections.ok)  inner+=sections.ok;
  if(sections.adj) inner+=`<optgroup label="── Overgang ──" disabled></optgroup>`+sections.adj;
  if(sections.bad) inner+=`<optgroup label="── Niet verwacht ──" disabled></optgroup>`+sections.bad;

  return `<select data-i="${i}" onchange="changeSubtype(this)"
    style="font-size:11px;padding:2px 4px;border:1px solid ${bdCol};border-radius:4px;
           background:var(--bg);color:var(--tx);width:100%;margin-top:3px;max-width:210px"
    >${inner}</select>`;
}

/** The `<tr>` set of `#lb` for one CPT (pure). */
export function renderLayerRowsHtml(cpt){
  const taw=z=>cpt.elev!=null?(cpt.elev-z).toFixed(2):'—';
  return cpt.layers.map((l,i)=>{
    const ed=(f,step=0.5)=>
      `<input class="input input--sm${l.ovr[f]?' ovr':''}" data-i="${i}" data-f="${f}" value="${l[f]}" type="number" step="${step}" onchange="editL(this)">`;
    const thick=(l.bot-l.top).toFixed(2);
    const dropdown=buildSubtypeDropdown(l,i);
    return`<tr>
      <td class="key" style="font-weight:600">${i+1}</td>
      <td class="num">${l.top.toFixed(2)}</td><td class="num">${l.bot.toFixed(2)}</td>
      <td class="num" style="color:var(--tx2)">${taw(l.top)}</td>
      <td class="num" style="color:var(--tx2)">${taw(l.bot)}</td>
      <td class="num">${thick} m</td>
      <td style="min-width:180px">
        <span class="pill ${SC[l.type]||'s-sand'}" style="font-size:10px">${l.type}</span>
        ${l.rfIndeterminate&&!l.ovr.subtype?'<span style="font-size:9px;color:var(--wn);border:1px solid var(--wn);border-radius:3px;padding:0 3px;margin-left:4px;vertical-align:middle" title="Geen gemeten Rf — meerdere Tabel 3 rijen passen bij deze qc. Grondsoort volgt de catalogusvolgorde; controleer de keuze.">qc-only</span>':''}
        ${dropdown}
      </td>
      <td class="num">${l.avgQc.toFixed(3)}</td>
      <td class="num">${l.avgFs!=null?(l.avgFs*1000).toFixed(1):'—'}</td>
      <td class="num">${l.avgRf!=null?l.avgRf.toFixed(2):'—'}</td>
      <td class="num">${ed('g')}</td><td class="num">${ed('gs')}</td>
      <td class="num">${ed('phi')}</td><td class="num">${ed('c')}</td><td class="num">${ed('cu',1)}</td>
    </tr>`;
  }).join('');
}

/** Every compatibility remark the layer model carries (pure). */
export function compatWarnings(cpt){
  const warnings=[];
  cpt.layers.forEach((l,i)=>{
    if(!l.subtype||l.subtype==='(overridden)') return;
    if(l.rfIndeterminate && !l.ovr.subtype){
      warnings.push({i,layer:i+1,cptType:l.type,subtype:l.subtype,level:'adj',
        msg:`Laag ${i+1}: <strong>${l.subtype}</strong> gekozen zonder gemeten R<sub>f</sub> (fs ontbreekt in het bronbestand). Meerdere Tabel 3 rijen passen bij qc ≈ ${l.avgQc.toFixed(1)} MPa; de parameters volgen de eerste passende rij. Controleer of overschrijf de grondsoort indien boringen of projectkennis beschikbaar zijn.`});
    }
    const entry=CAT.find(r=>r.subtype===l.subtype);
    if(!entry) return;
    const level=compatLevel(l.type, entry.grp);
    if(level==='bad'){
      warnings.push({i,layer:i+1,cptType:l.type,subtype:l.subtype,level:'bad',
        msg:`CPT classificatie = <strong>${l.type}</strong>, gekozen grondsoort = <strong>${l.subtype}</strong> — dit zijn niet-verwante grondsoorten. Controleer of de CPT classificatie correct is of pas de grondsoort aan.`});
    } else if(level==='adj'){
      warnings.push({i,layer:i+1,cptType:l.type,subtype:l.subtype,level:'adj',
        msg:`Laag ${i+1}: <strong>${l.subtype}</strong> ligt in een aangrenzende / overgangsfamilie t.o.v. CPT type <strong>${l.type}</strong>. Enkel aanvaardbaar indien bevestigd via boring, labo of projectkennis.`});
    }
  });
  return warnings;
}

/** The warning panel's markup (pure); '' when the model is fully compatible. */
export function compatWarningsHtml(warnings){
  if(!warnings.length) return '';
  return warnings.map(w=>`
    <div class="layerwarn ${w.level==='bad'?'layerwarn-bad':'layerwarn-adj'}">
      <span class="layerwarn-k">
        ${w.level==='bad'?'⚠ Waarschuwing laag '+w.layer:'ⓘ Opmerking laag '+w.layer}
      </span><br>
      <span class="layerwarn-msg">${w.msg}</span>
    </div>`).join('');
}

/** Write the warning panel, creating its container after `#lt` the first time. */
export function renderCompatWarnings(document, cpt){
  // Find layer warnings container — create if missing
  let warnEl=document.getElementById('layerWarnings');
  if(!warnEl){
    warnEl=document.createElement('div');
    warnEl.id='layerWarnings';
    warnEl.style.cssText='margin-top:12px';
    document.getElementById('lt').parentElement.after(warnEl);
  }
  warnEl.innerHTML=compatWarningsHtml(compatWarnings(cpt));
}

/** Write `#lb` and the warning panel below it. */
export function renderLayers(document, cpt){
  document.getElementById('lb').innerHTML=renderLayerRowsHtml(cpt);
  // Render compatibility warnings below the table
  renderCompatWarnings(document, cpt);
}
