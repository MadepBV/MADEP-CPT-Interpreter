// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Steel section inputs: sheet-pile section (per metre) or soldier-pile H-profile + lagging + model choices.
import { numberRow, selectRow, checkRow, help, accordion, esc, fmt, segmented } from './panel-kit.js';
import { isSoldierPile } from '../wall-types.js';
import { STEEL_H_SECTIONS } from '../sections/steel-h-sections.js';
import { SHEET_PILE_SECTIONS } from '../sections/sheet-pile-sections.js';
import { hSectionSI, sheetPileSI, hSectionClass, yieldStrength } from '../sections/section-properties.js';

function groupedOptions(list, keyFn, labelFn) {
  const groups = new Map();
  for (const s of list) { const k = keyFn(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  return groups;
}

function sectionSelect(path, value, groups, labelFn) {
  let html = `<select onchange="retwallSet('${path}', this.value)">`;
  for (const [g, items] of groups) {
    html += `<optgroup label="${esc(g)}">` + items.map((s) => `<option value="${esc(s.id)}"${s.id === value ? ' selected' : ''}>${esc(labelFn(s))}</option>`).join('') + '</optgroup>';
  }
  return html + '</select>';
}

const H_GRADES = [{ value: 'S235', label: 'S235' }, { value: 'S275', label: 'S275' }, { value: 'S355', label: 'S355' }];
const SP_GRADES = ['S240GP', 'S270GP', 'S320GP', 'S355GP', 'S390GP', 'S430GP', 'S460GP'].map((g) => ({ value: g, label: g }));

export function sectionPanel(rw) {
  if (isSoldierPile(rw.wallType)) return soldierSectionPanel(rw);
  return sheetPileSectionPanel(rw);
}

function sheetPileSectionPanel(rw) {
  const sh = rw.sheet;
  const groups = groupedOptions(SHEET_PILE_SECTIONS.filter((s) => s.shape !== 'flat'), (s) => `${s.family} ${s.series ? '— ' + s.series : ''}`.trim());
  const sp = sheetPileSI(sh.sectionId, { corrosionLoss: sh.corrosionLoss });
  const fy = yieldStrength(sh.grade) || 355;
  const cls = sp?.classByGrade ? sp.classByGrade[sh.grade] : null;
  const props = sp ? `<div class="st6-rw-kv" style="margin-top:6px">
      <dt>A</dt><dd>${fmt(sp.A * 1e4, 0)}<small>cm²/m</small></dd>
      <dt>I<sub>y</sub></dt><dd>${fmt(sp.Iy * 1e8, 0)}<small>cm⁴/m</small></dd>
      <dt>W<sub>el</sub> / W<sub>pl</sub></dt><dd>${fmt(sp.Wel * 1e6, 0)} / ${fmt((sp.Wpl || 0) * 1e6, 0)}<small>cm³/m</small></dd>
      <dt>mass</dt><dd>${fmt(sp.massPerM2, 0)}<small>kg/m²</small></dd>
      <dt>h / t / s</dt><dd>${fmt(sp.h * 1000, 0)} / ${fmt(sp.t * 1000, 1)} / ${fmt(sp.s * 1000, 1)}<small>mm</small></dd>
      <dt>class (${esc(sh.grade)})</dt><dd>${cls != null ? cls : '—'}</dd>
    </div>` : '<div class="st6-rw-note warn">Section not found in the catalogue.</div>';
  const body = `
    <label class="st6-rw-field"><span>Section</span>${sectionSelect('sheet.sectionId', sh.sectionId, groups, (s) => s.id)}</label>
    ${selectRow('Steel grade', 'sheet.grade', sh.grade, SP_GRADES)}
    ${props}
    ${checkRow('Use plastic W<sub>pl</sub> (class 1–2 only)', 'sheet.useWpl', !!sh.useWpl, { title: 'EN 1993-5 §5.2.2: plastic resistance for class 1 and 2 sections; elastic (W_el) otherwise' })}
    ${sh.useWpl ? numberRow('β<sub>B</sub> (U-piles, NA)', 'sheet.betaB', sh.betaB, { step: 0.05, min: 0.5, max: 1, title: 'EN 1993-5 interlock transmission factor; 1.0 for Z-piles, National Annex value for U-piles' }) : ''}
    ${numberRow('Corrosion loss', 'sheet.corrosionLoss', sh.corrosionLoss, { step: 0.01, min: 0, max: 0.5, title: 'Uniform reduction of A, I, W for the design life (EN 1993-5 §4.4); 0.10 = 10 %' })}
    ${help(`Catalogue values per metre of wall (ArcelorMittal General Catalogue 2024). f<sub>y</sub> = ${fy} N/mm² (${esc(sh.grade)}). The class shown is the catalogue class for this grade; plastic resistance needs class ≤ 2.`)}`;
  return accordion('section', 'Sheet-pile section', body, { open: true, pill: sh.sectionId });
}

function soldierSectionPanel(rw) {
  const so = rw.soldier;
  const groups = groupedOptions(STEEL_H_SECTIONS, (s) => s.family);
  const sec = hSectionSI(so.sectionId);
  const fy = yieldStrength(so.grade) || 235;
  const cls = sec ? hSectionClass(sec, fy) : null;
  const props = sec ? `<div class="st6-rw-kv" style="margin-top:6px">
      <dt>h × b</dt><dd>${fmt(sec.h * 1000, 0)} × ${fmt(sec.b * 1000, 0)}<small>mm</small></dd>
      <dt>A</dt><dd>${fmt(sec.A * 1e4, 2)}<small>cm²</small></dd>
      <dt>I<sub>y</sub></dt><dd>${fmt(sec.Iy * 1e8, 0)}<small>cm⁴</small></dd>
      <dt>W<sub>el,y</sub> / W<sub>pl,y</sub></dt><dd>${fmt(sec.Wely * 1e6, 1)} / ${fmt(sec.Wply * 1e6, 1)}<small>cm³</small></dd>
      <dt>A<sub>v,z</sub></dt><dd>${fmt(sec.Avz * 1e4, 2)}<small>cm²</small></dd>
      <dt>mass</dt><dd>${fmt(sec.massPerM, 1)}<small>kg/m</small></dd>
      <dt>class (${esc(so.grade)})</dt><dd>${cls ? cls.cls : '—'}</dd>
    </div>` : '<div class="st6-rw-note warn">Section not found in the catalogue.</div>';
  const body = `
    <label class="st6-rw-field"><span>Profile</span>${sectionSelect('soldier.sectionId', so.sectionId, groups, (s) => `${s.id} (${s.mass} kg/m)`)}</label>
    ${selectRow('Steel grade', 'soldier.grade', so.grade, H_GRADES)}
    ${props}
    <div class="st6-rw-card-title" style="margin-top:10px">Lagging (beschot)</div>
    ${numberRow('Plate thickness', 'soldier.laggingThk', so.laggingThk, { unit: 'm', step: 0.001, min: 0.002 })}
    ${selectRow('Lagging grade', 'soldier.laggingGrade', so.laggingGrade, H_GRADES)}
    <label class="st6-rw-field"><span>Span for the plate check</span>${segmented('soldier.laggingSpan', so.laggingSpan, [{ value: 'centre', label: 'c/c spacing (conservative)' }, { value: 'clear', label: 'clear s − b' }])}</label>
    ${checkRow('Lagging watertight (apply water pressure above the excavation)', 'soldier.laggingWatertight', !!so.laggingWatertight)}
    <div class="st6-rw-card-title" style="margin-top:10px">Resistance model below the excavation (hand calculation)</div>
    <label class="st6-rw-field"><span>Model</span>${segmented('soldier.resistanceModel', so.resistanceModel, [{ value: 'effective-width', label: 'Effective width' }, { value: 'brinch-hansen', label: 'Brinch Hansen' }])}</label>
    ${so.resistanceModel === 'brinch-hansen'
      ? checkRow('Cap by the continuous-wall tributary resistance s·p<sub>net</sub>', 'soldier.rowCap', so.rowCap !== false)
      : numberRow('Effective width factor k (b<sub>eff</sub> = min(k·b, s))', 'soldier.effectiveWidthFactor', so.effectiveWidthFactor, { step: 0.5, min: 1, max: 5 })}
    ${help(so.resistanceModel === 'brinch-hansen'
      ? 'Net line resistance B·[e<sub>w</sub>(z)]⁺ per pile from the Brinch Hansen (1961) coefficients with the Andersen–Lodahl (2023) retained-height term; B = flange width. The net coefficient cannot separate active from passive, so DA1/1 factoring applies to the retained-side load above the excavation only.'
      : 'EAB / Belgian guideline §5: active on the flange width b, passive on b<sub>eff</sub> = min(k·b, s) with the plane-strain K<sub>p</sub>. k = 3 is the usual value; the Rekennota uses min(3b, s). The PLAXIS T<sub>lat</sub> table always uses Brinch Hansen with B = b — the two models are never mixed.')}
    <div class="st6-rw-card-title" style="margin-top:10px">PLAXIS embedded-beam axial inputs</div>
    <label class="st6-rw-field"><span>T<sub>lat</sub> convention</span>${segmented('soldier.tlatConvention', so.tlatConvention, [{ value: 'AL', label: 'Andersen–Lodahl' }, { value: 'equal', label: 'Equal-level' }])}</label>
    ${selectRow('K for T<sub>skin</sub>', 'soldier.tskinK', so.tskinK, [{ value: 'k0', label: 'K₀ = 1 − sin φ′ (pre-augered / lower bound)' }, { value: '0.8', label: '0.8' }, { value: '1.0', label: '1.0 (driven)' }])}
    ${numberRow('δ/φ′ on the flanges', 'soldier.tskinDeltaRatio', so.tskinDeltaRatio, { step: 0.05, min: 0, max: 1 })}
    ${checkRow('Soil–soil shear on the plug faces (2h at φ′)', 'soldier.tskinPlug', so.tskinPlug !== false)}
    ${numberRow('α<sub>b</sub> for F<sub>max</sub> = α<sub>b</sub>·q<sub>c</sub>·A<sub>b</sub>', 'soldier.fmaxAlphaB', so.fmaxAlphaB, { step: 0.05, min: 0, max: 1 })}
    ${checkRow('Plugged toe (A<sub>b</sub> = b·h)', 'soldier.fmaxPlugged', so.fmaxPlugged !== false)}`;
  return accordion('section', 'Soldier pile & lagging', body, { open: true, pill: `${so.sectionId} @ ${fmt(so.spacing, 2)} m` });
}
