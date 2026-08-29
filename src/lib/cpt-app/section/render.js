// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// section/render.js — the geological cross-section "Doorsnede" as an SVG string
// (01-monolith-map.md §2.12, §6.1 row `section/`).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): sectionProjection 601-608
// (→ `sectionCpts`), renderSection 610-813 (→ `buildSectionSvg` + the thin `renderSection`).
// The SVG text is verbatim. What the old body read from the world became inputs of the pure
// builder: the projection (`projCpts`), the vertical exaggeration (`vex`, `#vexag`), the
// stratigraphy geometry (a thunk — the old body called `stratigraphyApp.sectionGeometry()` only
// once it had data, the builder keeps that order), every project CPT for the legend (`allCpts`,
// the old `PROJECT.cpts`), and the four design tokens (`tokens`, read with core/css-tokens.js
// `readCssToken` by the wrapper — `SCFILL` is soil-styles.js SOIL_FILL_COLORS).
//
// buildSectionSvg(...) → { html, attrs, complete }
//   attrs     { viewBox, width, height } to set on #sectionSvg, or null ("Geen data." leaves them)
//   complete  true when the full section was drawn (the tooltip is bound only then)

import { SOIL_FILL_COLORS } from '../soil-styles.js';

/** The four CSS tokens the section reads, with the monolith's fallbacks. */
export const SECTION_TOKENS = [
  ['text', '--tx', '#18181a'],
  ['muted', '--tx2', '#4a4a52'],
  ['subtle', '--tx3', '#888890'],
  ['blue', '--chart-blue', '#4F8584']
];

export function sectionTokens(readToken){
  const tokens = {};
  for (const [key, name, fallback] of SECTION_TOKENS) tokens[key] = readToken(name, fallback);
  return tokens;
}

/** Placeholder size when fewer than two CPTs project onto the section line. */
export const SECTION_PLACEHOLDER_ATTRS = { viewBox:'0 0 400 80', width:'400', height:'80' };

/** The projected CPTs of the section: the project's CPT objects (copies) with `cptIdx` + `dist`. */
export function sectionCpts(project, projection){
  // Chainage comes from the stratigraphy module so the section, the
  // correlation panel and the DXF export share one projection. Each entry
  // keeps its PROJECT index (cptIdx) — the CPT objects are copies.
  if(!projection) return null;
  return projection.map(({cptIdx,dist})=>({...project.cpts[cptIdx], cptIdx, dist}));
}

export function sectionNoCptsHtml(tokens){
  return `<text x="20" y="40" font-size="13" fill="${tokens.subtle}">Minimaal 2 CPTs met maaiveldshoogte vereist voor doorsnede.</text>`;
}

export function sectionNoDataHtml(tokens){
  return `<text x="20" y="30" font-size="11" fill="${tokens.subtle}">Geen data.</text>`;
}

export function buildSectionSvg({projCpts, vex, getGeometry, allCpts, tokens}){
  if(!projCpts||projCpts.length<1){
    return { html: sectionNoCptsHtml(tokens), attrs: { ...SECTION_PLACEHOLDER_ATTRS }, complete: false };
  }

  // ── Canvas geometry ──
  // Top margin hosts the legend row + CPT headers; right margin hosts the
  // rightmost column's depth labels.
  const ML=65,MR=48,MT=64,MB=50;
  const W=Math.max(700, projCpts.length*260);

  // Collect all elevations across all CPTs
  const elevAll=[];
  projCpts.forEach(c=>{
    if(c.elev!=null) elevAll.push(c.elev);
    c.layers.forEach(l=>{ if(c.elev!=null) elevAll.push(c.elev-l.bot); });
  });
  if(!elevAll.length){ return { html: sectionNoDataHtml(tokens), attrs: null, complete: false }; }
  const maxElev=Math.max(...elevAll)+1;
  const minElev=Math.min(...elevAll)-1;
  const elevRange=maxElev-minElev||1;
  const H=Math.max(350, elevRange*vex*18);

  const totalW=W+ML+MR, totalH=H+MT+MB;
  const attrs={ viewBox:`0 0 ${totalW} ${totalH}`, width:totalW, height:totalH };

  const distMin=projCpts[0].dist, distMax=projCpts[projCpts.length-1].dist;
  const distRange=Math.max(distMax-distMin,1);

  function px(d){ return ML+(d-distMin)/distRange*W; }
  function py(e){ return MT+(maxElev-e)/elevRange*(H/vex)*vex; }
  function esc(v){
    return String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  const svgText = tokens.text;
  const svgMuted = tokens.muted;
  const svgSubtle = tokens.subtle;
  const svgBlue = tokens.blue;

  let s='';

  // ── Ground fill (below surface, above deepest layer) ──
  s+='<rect x="0" y="0" width="'+totalW+'" height="'+totalH+'" fill="var(--bg)"/>';

  // ── Elevation grid lines ──
  const step=elevRange<=5?0.5:elevRange<=15?1:elevRange<=30?2:5;
  for(let e=Math.ceil(minElev/step)*step; e<=Math.floor(maxElev/step)*step; e=+(e+step).toFixed(4)){
    const y=py(e);
    if(y<MT||y>MT+H) continue;
    s+=`<line x1="${ML}" x2="${ML+W}" y1="${y}" y2="${y}" stroke="rgba(128,128,128,0.10)" stroke-width="0.5"/>`;
    s+=`<text x="${ML-5}" y="${y+3.5}" font-size="9" text-anchor="end" fill="${svgSubtle}" font-family="sans-serif">${e.toFixed(1)}</text>`;
  }

  // ── Stratigraphic units ──
  // Unit polygons come from the stratigraphy module: interpolated between
  // sampled CPTs, pinched out halfway toward CPTs where a unit is absent
  // (lenses form separate lobes). Same geometry as the DXF export.
  const stratGeom=getGeometry();
  if(stratGeom){
    stratGeom.polygons.forEach(poly=>{
      const pts=poly.points.map(p=>`${px(p.dist).toFixed(1)},${py(p.taw).toFixed(1)}`).join(' ');
      s+=`<polygon points="${pts}" fill="${poly.color}" fill-opacity="0.80" stroke="${svgMuted}" stroke-width="0.6"/>`;
    });
    // One label per unit, on its widest lobe — anchored at the midpoint of
    // the lobe's widest span BETWEEN anchor points, so labels sit clear of
    // the CPT columns and their depth annotations. A paint-order halo keeps
    // them readable on any unit fill.
    stratGeom.units.forEach(unit=>{
      const lobes=stratGeom.polygons.filter(p=>p.unitId===unit.id);
      if(!lobes.length) return;
      const widest=lobes.reduce((a,b)=>{
        const wA=Math.max(...a.points.map(p=>p.dist))-Math.min(...a.points.map(p=>p.dist));
        const wB=Math.max(...b.points.map(p=>p.dist))-Math.min(...b.points.map(p=>p.dist));
        return wB>wA?b:a;
      });
      // Vertical extent of the lobe at each anchor distance.
      const spanAt=new Map();
      widest.points.forEach(p=>{
        const cur=spanAt.get(p.dist)||{top:-Infinity,bot:Infinity};
        cur.top=Math.max(cur.top,p.taw);
        cur.bot=Math.min(cur.bot,p.taw);
        spanAt.set(p.dist,cur);
      });
      const anchors=[...spanAt.entries()].map(([dist,v])=>({dist,...v})).sort((a,b)=>a.dist-b.dist);
      if(anchors.length<2) return;
      // Widest gap between consecutive anchors — its midpoint is column-free.
      let seg=0, segW=-1;
      for(let i=1;i<anchors.length;i++){
        const w=anchors[i].dist-anchors[i-1].dist;
        if(w>segW){segW=w;seg=i-1;}
      }
      const a1=anchors[seg], a2=anchors[seg+1];
      const labelDist=(a1.dist+a2.dist)/2;
      const topMid=(a1.top+a2.top)/2, botMid=(a1.bot+a2.bot)/2;
      const hPx=Math.abs(py(botMid)-py(topMid));
      if(hPx>13){
        const label=`${unit.letter} — ${(unit.subtype||unit.type).split('/')[0].trim()}`;
        s+=`<text x="${px(labelDist).toFixed(1)}" y="${((py(topMid)+py(botMid))/2+3.5).toFixed(1)}" font-size="9" font-weight="600" text-anchor="middle"
          fill="rgba(24,24,26,0.72)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" stroke-linejoin="round"
          font-family="sans-serif">${esc(label)}</text>`;
      }
    });
  }

  // ── Fill background below correlated stratigraphy (deepest layer downward) ──
  // Draw a ground fill below the deepest confirmed layer in each CPT
  projCpts.forEach(c=>{
    if(!c.elev||!c.layers.length) return;
    const deepBot=c.elev-c.layers[c.layers.length-1].bot;
    const x=px(c.dist), colW=14;
    s+=`<rect x="${(x-colW/2).toFixed(1)}" y="${py(deepBot).toFixed(1)}" width="${colW}" height="${(totalH-py(deepBot)).toFixed(1)}" fill="#b8a99a" fill-opacity="0.3"/>`;
  });

  // ── CPT columns ──
  projCpts.forEach(c=>{
    if(!c.elev) return;
    const xc=px(c.dist), colW=14;
    // Surface to toe vertical line
    const toeElev=c.layers.length?c.elev-c.layers[c.layers.length-1].bot:c.elev-10;
    s+=`<line x1="${xc}" x2="${xc}" y1="${py(c.elev)}" y2="${py(toeElev)}" stroke="${svgMuted}" stroke-width="0.8" stroke-dasharray="3,2"/>`;

    c.layers.forEach(l=>{
      const fill=SOIL_FILL_COLORS[l.type]||'#D3D1C7';
      const y1=py(c.elev-l.top), y2=py(c.elev-l.bot);
      const h=Math.max(y2-y1,1.5);
      const topTaw=(c.elev-l.top).toFixed(2);
      const botTaw=(c.elev-l.bot).toFixed(2);
      const avgFsTxt=l.avgFs!=null?(l.avgFs*1000).toFixed(1):'—';
      const avgRfTxt=l.avgRf!=null?l.avgRf.toFixed(2):'—';
      const subtypeTxt=l.subtype||'—';
      s+=`<rect class="section-layer-hit" data-section-layer="1"
        data-cpt="${esc(c.id)}"
        data-type="${esc(l.type)}"
        data-subtype="${esc(subtypeTxt)}"
        data-top="${l.top.toFixed(2)}"
        data-bot="${l.bot.toFixed(2)}"
        data-toptaw="${topTaw}"
        data-bottaw="${botTaw}"
        data-thk="${(l.bot-l.top).toFixed(2)}"
        data-qc="${l.avgQc.toFixed(2)}"
        data-fs="${avgFsTxt}"
        data-rf="${avgRfTxt}"
        data-g="${l.g}"
        data-gs="${l.gs}"
        data-phi="${l.phi}"
        data-c="${l.c}"
        data-cu="${l.cu}"
        x="${(xc-colW/2).toFixed(1)}" y="${y1.toFixed(1)}" width="${colW}" height="${h.toFixed(1)}"
        fill="${fill}" stroke="rgba(0,0,0,0.25)" stroke-width="0.5"/>`;
      // Layer boundary tick (right of column)
      s+=`<line x1="${(xc+colW/2).toFixed(1)}" x2="${(xc+colW/2+5).toFixed(1)}" y1="${y1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${svgMuted}" stroke-width="0.6"/>`;
      // Depth label right of the column: keeps the leftmost column's labels
      // off the elevation axis and all labels off the unit-name anchors.
      if(h>12){
        const elmid=(y1+y2)/2;
        s+=`<text x="${(xc+colW/2+7).toFixed(1)}" y="${(elmid+3).toFixed(1)}" font-size="7.5" text-anchor="start" fill="${svgMuted}" paint-order="stroke" stroke="var(--bg)" stroke-width="2.5" stroke-linejoin="round" font-family="sans-serif">${(c.elev-l.bot).toFixed(1)}</text>`;
      }
    });

    // WT
    if(c.wt!=null){
      const wtY=py(c.elev-c.wt);
      s+=`<line x1="${(xc-18).toFixed(1)}" x2="${(xc+18).toFixed(1)}" y1="${wtY.toFixed(1)}" y2="${wtY.toFixed(1)}" stroke="${svgBlue}" stroke-width="2" stroke-dasharray="5,3"/>`;
    }
    // CPT label
    s+=`<text x="${xc}" y="${(MT-14).toFixed(1)}" font-size="10" text-anchor="middle" font-weight="600" fill="${svgText}" font-family="sans-serif">${c.id}</text>`;
    s+=`<text x="${xc}" y="${(MT-4).toFixed(1)}" font-size="9" text-anchor="middle" fill="${svgSubtle}" font-family="sans-serif">${c.elev!=null?c.elev.toFixed(2)+' m TAW':''}</text>`;
    // Distance from start
    const d0=(c.dist-distMin).toFixed(0);
    s+=`<text x="${xc}" y="${(totalH-8).toFixed(1)}" font-size="9" text-anchor="middle" fill="${svgSubtle}" font-family="sans-serif">${d0}m</text>`;
  });

  // ── WT interpolated line across section ──
  const wtPts=projCpts.filter(c=>c.wt!=null&&c.elev!=null)
    .map(c=>`${px(c.dist).toFixed(1)},${py(c.elev-c.wt).toFixed(1)}`);
  if(wtPts.length>=2)
    s+=`<polyline points="${wtPts.join(' ')}" fill="none" stroke="${svgBlue}" stroke-width="1.8" stroke-dasharray="7,5"/>
        <text x="${(ML+10).toFixed(1)}" y="${py(projCpts.find(c=>c.wt!=null)?.elev-(projCpts.find(c=>c.wt!=null)?.wt||0)||maxElev).toFixed(1)}" font-size="9" fill="${svgBlue}" font-family="sans-serif">WT</text>`;

  // ── Axes labels ──
  s+=`<text x="${(ML+W/2).toFixed(1)}" y="${(totalH-6).toFixed(1)}" font-size="10" text-anchor="middle" fill="${svgMuted}" font-family="sans-serif">Afstand langs doorsnede (m) — vex ×${vex}</text>`;
  s+=`<text x="12" y="${(MT+H/2).toFixed(1)}" font-size="10" text-anchor="middle" fill="${svgMuted}" font-family="sans-serif" transform="rotate(-90,12,${(MT+H/2).toFixed(1)})">Hoogte (m TAW)</text>`;

  // ── Legend — one horizontal chip row in the top band, clear of the plot ──
  const legendTypes=[...new Set(allCpts.flatMap(c=>c.layers.map(l=>l.type)))].slice(0,8);
  let lx=ML;
  const ly=14;
  legendTypes.forEach(t=>{
    s+=`<rect x="${lx}" y="${ly}" width="10" height="10" rx="2" fill="${SOIL_FILL_COLORS[t]||'#D3D1C7'}" stroke="rgba(0,0,0,0.2)" stroke-width="0.3"/>`;
    s+=`<text x="${lx+14}" y="${ly+8.5}" font-size="8.5" fill="${svgMuted}" font-family="sans-serif">${t}</text>`;
    lx+=14+t.length*4.6+16;
  });

  return { html: s, attrs, complete: true };
}

/**
 * The thin DOM wrapper of the old renderSection: read #vexag, project, build, write #sectionSvg,
 * bind the tooltip once the full section is drawn.
 *   ctx.projection()      stratigraphyApp.projection() (null when the section line is undefined)
 *   ctx.sectionGeometry() stratigraphyApp.sectionGeometry()
 *   ctx.getProject()      PROJECT (the CPT copies + the legend's CPT list)
 *   ctx.readToken(name, fallback)   core/css-tokens.js readCssToken
 *   ctx.bindTooltip()     section/tooltip.js bindSectionTooltip(document)
 */
export function renderSection(document, ctx){
  const svg=document.getElementById('sectionSvg');
  if(!svg) return;
  const vex=parseFloat(document.getElementById('vexag')?.value||2);

  const project=ctx.getProject();
  const projCpts=sectionCpts(project, ctx.projection());
  const result=buildSectionSvg({
    projCpts,
    vex,
    getGeometry: ctx.sectionGeometry,
    allCpts: project.cpts,
    tokens: sectionTokens(ctx.readToken)
  });
  svg.innerHTML=result.html;
  if(result.attrs){
    svg.setAttribute('viewBox',result.attrs.viewBox); svg.setAttribute('width',result.attrs.width); svg.setAttribute('height',result.attrs.height);
  }
  if(result.complete) ctx.bindTooltip();
}
