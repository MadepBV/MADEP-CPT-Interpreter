// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Drivability — inputs + results tab. The element geometry comes from the wall section, the
 * resistance profile from the CPT trace used for the design (same datum shift), the vibrator from
 * a supplier data sheet, a verified catalogue row or a bare required-force run; the impact hammer
 * from the catalogue or custom data. Vibratory: Hypervib1-type force envelope driven to refusal;
 * impact: Smith (1960) wave equation. Non-normative models — no Eurocode partial factors.
 *
 * The question answered: given this machine, how deep can it drive this element (predicted refusal
 * depth), and what is the minimum machine for the target depth.
 */
import { numberRow, selectRow, checkRow, help, accordion, esc, fmt, num, segmented } from './panel-kit.js';
import { table, kvList, copyButton, toTsv, badge } from '../results/result-kit.js';
import { isEmbedded, isSoldierPile } from '../wall-types.js';
import { hSectionSI, sheetPileSI } from '../sections/section-properties.js';
import { vibratoryHammers, impactHammers, findHammer } from '../drivability/hammer-catalog.js';
import { buildDrivingResistanceProfile } from '../drivability/srd-from-cpt.js';
import { runVibratoryDrivability } from '../drivability/vibratory-drivability.js';
import { runImpactDrivability } from '../drivability/impact-wave-equation.js';
import { runPushIn } from '../drivability/push-in.js';
import { vibratorFromDatasheet, carrierCheck } from '../drivability/vibrator-datasheet.js';
import { drivabilityMarker } from '../drivability/drivability-outcome.js';
export { drivabilityMarker };
import { drawXYChart, drawDepthChart } from '../retaining-charts.js';
import { retainingVizSeries } from '../../../styles/theme.ts';

/** Driven element geometry derived from the wall configuration. */
export function drivenElement(rw) {
  const dr = rw.drivability;
  if (isSoldierPile(rw.wallType)) {
    const sec = hSectionSI(rw.soldier.sectionId);
    if (!sec) return null;
    const plugged = dr.toePlugged === true;
    return { label: `${sec.id} (one pile)`, toeArea_m2: plugged ? sec.boxArea : sec.A, shaftPerimeter_m: plugged ? sec.perimeterBox : sec.perimeterFlanges + sec.perimeterPlug, steelArea_m2: sec.A, interlockResistance_kN_m: 0, massPerM_kg: sec.massPerM, unitNote: plugged ? 'plugged H-pile: box area b·h, box perimeter' : 'unplugged H-pile: steel area, flange faces + web cavities' };
  }
  const sp = sheetPileSI(rw.sheet.sectionId);
  if (!sp || !sp.perMetre) return null;
  const units = dr.drivingUnit === 'pair' ? 2 : 1;
  const b = sp.b * units;
  return { label: `${sp.id} (${units === 2 ? 'pair' : 'single'})`, toeArea_m2: sp.A * b, shaftPerimeter_m: (sp.developedPerimeterPerM || 2) * b, steelArea_m2: sp.A * b, interlockResistance_kN_m: num(dr.interlock, 0), massPerM_kg: (sp.massPerPile || sp.massPerM2 * sp.b) * units, unitNote: `${units === 2 ? 'pair' : 'single'} sheet pile: steel area at the toe plane, both faces of the developed section, one interlock engaged with the wall already driven` };
}

function soilClassOf(layer) {
  const phi = Number(layer.phi) || 0, cu = Number(layer.cu) || 0;
  const t = String(layer.type || '').toLowerCase();
  if (/klei|clay|veen|peat/.test(t) || (phi < 1 && cu > 0)) return 'clay';
  if (/leem|silt|loam/.test(t)) return 'silt';
  return 'sand';
}

/** Which vibrator description is active: 'required' (force only), 'sheet' (supplier data sheet) or 'catalog'. */
export function vibratorSource(vb) {
  if (vb.source === 'sheet' || vb.source === 'catalog' || vb.source === 'required') return vb.source;
  return vb.id && vb.id !== 'custom' ? 'catalog' : 'required';
}

/** Target toe depth below the platform (retained surface): explicit, else H + over-dig + embedment. */
export function targetToeDepth(rw) {
  const dr = rw.drivability;
  const H = num(rw.embedded.retainedHeight, 5), d = num(rw.embedded.embedment, 4);
  const overdig = Number.isFinite(rw.result?.overdigUls) ? rw.result.overdigUls : 0.30;
  return Number.isFinite(Number(dr.targetDepth)) && Number(dr.targetDepth) > 0 ? Number(dr.targetDepth) : H + overdig + d;
}

/** Build inputs and run the selected drivability model (synchronous; a few hundred ms at most). */
export function runDrivability(rw, cpt, layers) {
  const dr = rw.drivability;
  const el = drivenElement(rw);
  if (!el) return { ok: false, notes: ['Select a catalogue section first.'] };
  if (!cpt || !cpt.depth?.length) return { ok: false, notes: ['No CPT trace loaded for the active CPT.'] };
  const target = targetToeDepth(rw);
  const offset = num(rw.profile?.offset, 0);
  const soilLayers = (layers || []).map((L) => ({ zTop_m: L.top - offset, zBot_m: L.bot - offset, gamma_kN_m3: Number(L.g) || 19, soil: soilClassOf(L) }));
  const profile = buildDrivingResistanceProfile({
    cpt: { depth: cpt.depth, qc: cpt.qc, fs: cpt.fs, groundLevelOffset: offset },
    pile: { toeArea_m2: el.toeArea_m2, shaftPerimeter_m: el.shaftPerimeter_m, steelArea_m2: el.steelArea_m2, interlockResistance_kN_m: el.interlockResistance_kN_m },
    method: dr.srdMethod === 'alm-hamre' ? 'alm-hamre' : 'reference',
    options: { dz: 0.1, toeFactor: num(dr.toeFactor, 1), shaftFactor: num(dr.shaftFactor, 1), srdFactor: num(dr.srdFactor, 1), almHamre: { layers: soilLayers.map((l) => ({ zTop_m: l.zTop_m, zBot_m: l.zBot_m, soilType: l.soil === 'clay' ? 'clay' : 'sand', gamma_kN_m3: l.gamma_kN_m3 })), gamma_kN_m3: soilLayers[0]?.gamma_kN_m3 || 19, waterTable_m: Math.max((Number(cpt.waterTable) || 0) - offset, 0) } }
  });
  if (!profile.ok) return { ok: false, notes: profile.notes };
  const pileLength = target + 0.5;
  const result = { ok: true, element: el, profile, target, method: dr.method, notes: [...profile.notes] };
  if (dr.method === 'impact') {
    const hm = dr.hammer;
    const cat = hm.id && hm.id !== 'custom' ? findHammer(hm.id) : null;
    const hammer = { ramMass_kg: num(cat?.ramMass_kg, num(hm.ramMass, 5000)), ratedEnergy_kJ: num(cat?.ratedEnergy_kJ, num(hm.ratedEnergy, 60)), efficiency: num(hm.efficiency, cat?.efficiencyDefault ?? 0.8), helmetMass_kg: num(hm.helmetMass, 1500), cushionStiffness_kN_m: num(hm.cushionStiffness, 2.5e6), cushionCoefficientOfRestitution: num(hm.cushionCor, 0.8), type: cat?.type || hm.type || 'hydraulic' };
    const damping = profile.z.map((z) => { const L = soilLayers.find((l) => z >= l.zTop_m && z < l.zBot_m); const c = L ? L.soil : 'sand'; return c === 'clay' ? num(dr.soil.shaftDampingClay, 0.65) : c === 'silt' ? 0.40 : num(dr.soil.shaftDampingSand, 0.16); });
    const impact = runImpactDrivability({ profile, pile: { length_m: pileLength, area_m2: el.steelArea_m2, shaftPerimeter_m: el.shaftPerimeter_m, toeArea_m2: el.toeArea_m2, interlockResistance_kN_m: el.interlockResistance_kN_m, segmentLength_m: 1.0 }, hammer, soilModel: { shaftQuake_m: num(dr.soil.shaftQuake, 0.0025), toeQuake_m: num(dr.soil.toeQuake, 0.0025), shaftDamping_s_m: damping, toeDamping_s_m: num(dr.soil.toeDamping, 0.5) }, options: { targetDepth_m: target, depthStep_m: 0.5 } });
    result.impact = impact; result.hammer = hammer; result.notes.push(...(impact.notes || []));
    const firstRefusal = (impact.perDepth || []).find((r) => r.refusal);
    result.impact.refusalDepth_m = firstRefusal ? firstRefusal.z : null;
    result.impact.reachesTarget = !firstRefusal;
    return result;
  }
  if (dr.method === 'push') {
    const push = runPushIn({ profile, force_kN: num(dr.push?.force_kN, 0), massPerM_kg: dr.push?.includeWeight !== false ? el.massPerM_kg : 0, options: { targetDepth_m: target, reserveMultiplier: 1.0 } });
    result.push = push; result.machineLabel = `push ${fmt(num(dr.push?.force_kN, 0), 0)} kN`;
    result.notes.push(...(push.notes || []));
    return result;
  }
  const vb = dr.vibrator;
  const source = vibratorSource(vb);
  const pileMass = dr.includePileMass !== false ? el.massPerM_kg * pileLength : 0;
  let vibrator, machineLabel;
  if (source === 'sheet') {
    const sd = vibratorFromDatasheet(sheetForModel(vb.sheet || {}));
    result.datasheet = sd;
    if (!sd.ok) return { ok: false, notes: sd.notes, datasheet: sd };
    result.notes.push(...sd.notes);
    result.carrier = carrierCheck(sd, vb.carrier || {});
    machineLabel = vb.sheet?.name || 'data-sheet vibrator';
    vibrator = { frequency_Hz: sd.frequency_Hz, dynamicMass_kg: sd.dynamicMass_kg + pileMass, crowd_kN: num(vb.crowd, 0) + sd.staticExtra_kN, lineForce_kN: num(vb.lineForce, 0), centrifugalForce_kN: sd.forceAtOperating_kN };
  } else if (source === 'catalog') {
    const cat = findHammer(vb.id);
    if (!cat) return { ok: false, notes: ['Catalogue vibrator not found — choose a model or switch to a data sheet.'] };
    machineLabel = `${cat.make} ${cat.model}`;
    const f = Math.min(num(vb.frequency, cat.frequencyMax_Hz ?? 35), cat.frequencyMax_Hz || 1e9);
    if (num(vb.frequency, 0) > (cat.frequencyMax_Hz || 1e9)) result.notes.push(`Frequency clipped to the catalogue maximum ${fmt(cat.frequencyMax_Hz, 1)} Hz.`);
    vibrator = { frequency_Hz: f, dynamicMass_kg: num(vb.dynamicMass, cat.dynamicMassWithClamp_kg ?? cat.dynamicMass_kg ?? 5000) + pileMass, crowd_kN: num(vb.crowd, 0), lineForce_kN: num(vb.lineForce, 0), eccentricMoment_kgm: cat.eccentricMomentMax_kgm };
  } else {
    machineLabel = 'candidate (custom)';
    vibrator = { frequency_Hz: num(vb.frequency, 35), dynamicMass_kg: num(vb.dynamicMass, 5000) + pileMass, crowd_kN: num(vb.crowd, 0), lineForce_kN: num(vb.lineForce, 0), eccentricMoment_kgm: Number(vb.eccentricMoment) > 0 ? Number(vb.eccentricMoment) : undefined, centrifugalForce_kN: Number(vb.centrifugalForce) > 0 ? Number(vb.centrifugalForce) : undefined };
  }
  const options = { lambda: num(dr.lambda, 6), deltaH: num(dr.deltaH, 0), reserveMultiplier: 1.0, targetDepth_m: target };
  const vib = runVibratoryDrivability({ profile, vibrator, options });
  result.vibratory = vib; result.vibrator = vibrator; result.source = source; result.machineLabel = machineLabel; result.pileMass_kg = pileMass;
  result.notes.push(...(vib.notes || []));
  if (vib.ok && vib.candidateCheck) result.sensitivity = sensitivityBand(profile, vibrator, options, vib.candidateCheck);
  return result;
}

/** The sheet as the model sees it: only the chosen attached-mass source is passed on (amplitude or vibrating mass). */
export function sheetForModel(sheet) {
  const src = sheet.massSource === 'mass' ? 'mass' : 'amplitude';
  return { ...sheet, dynamicMass_kg: src === 'mass' ? sheet.dynamicMass_kg : null, amplitude_mm: src === 'amplitude' ? sheet.amplitude_mm : null };
}

/**
 * Model-sensitivity band of the achievable depth: the same machine driven through the same profile
 * with the degradation factor at the ends of its published range (Λ = 4 and 10, Holeyman 2002) and
 * with shaft damping switched on (δ_H = 0.5). The spread is the honest resolution of the prediction.
 */
function sensitivityBand(profile, vibrator, options, base) {
  const variants = [
    { label: 'Λ = 4', options: { ...options, lambda: 4 } },
    { label: 'Λ = 10', options: { ...options, lambda: 10 } },
    { label: 'δ_H = 0.5', options: { ...options, deltaH: 0.5 } }
  ];
  const reach = (c) => (c.reachesTarget ? c.targetDepth_m : c.achievableDepth_m);
  const rows = [{ label: `base (Λ = ${options.lambda}, δ_H = ${options.deltaH})`, achievable_m: reach(base), reaches: base.reachesTarget }];
  for (const v of variants) {
    const r = runVibratoryDrivability({ profile, vibrator, options: v.options });
    if (r.ok && r.candidateCheck) rows.push({ label: v.label, achievable_m: reach(r.candidateCheck), reaches: r.candidateCheck.reachesTarget });
  }
  const depths = rows.map((r) => r.achievable_m);
  return { rows, min_m: Math.min(...depths), max_m: Math.max(...depths), target_m: base.targetDepth_m };
}

function textRow(label, path, value, { placeholder = '' } = {}) {
  return `<label class="field field--inline"><span class="field__text">${label}</span><input class="input input--sm input--text" type="text" placeholder="${esc(placeholder)}" value="${esc(value ?? '')}" onchange="retwallSet('${path}', this.value)"></label>`;
}

function datasheetForm(vb) {
  const s = vb.sheet || {};
  const p = (k) => `drivability.vibrator.sheet.${k}`;
  const massSrc = s.massSource === 'mass' ? 'mass' : 'amplitude';
  const derived = vibratorFromDatasheet(sheetForModel(s));
  const srcTxt = (src) => src === 'stated' ? 'sheet value' : src === 'from-force' ? 'from F_c and rpm' : src === 'from-amplitude' ? 'from the amplitude' : 'missing';
  let summary;
  if (derived.ok) {
    summary = `Derived — M<sub>e</sub> = <strong>${fmt(derived.eccentricMoment_kgm, 2)} kg·m</strong> (${srcTxt(derived.eccentricMomentSource)}); F<sub>c</sub> = ${fmt(derived.forceAtOperating_kN, 0)} kN at ${fmt(derived.rpmOperating, 0)} rpm${derived.forceMin_kN ? ` (${fmt(derived.forceMin_kN, 0)}–${fmt(derived.forceMax_kN, 0)} kN over the rpm range)` : ''}; vibrating mass M<sub>dyn</sub> = <strong>${fmt(derived.dynamicMass_kg, 0)} kg</strong> (${srcTxt(derived.dynamicMassSource)})${derived.suppressorMass_kg ? `; isolated part ${fmt(derived.suppressorMass_kg, 0)} kg = ${fmt(derived.staticExtra_kN, 1)} kN static on the pile` : ''}.`;
  } else summary = derived.notes.map(esc).join(' ');
  // Essentials: the three numbers the force envelope needs (F_c, rpm, attached mass via amplitude or vibrating mass).
  let html = `${textRow('Sheet / model', p('name'), s.name, { placeholder: 'e.g. HST030 RM-DFS-CW30, ICE 28RF' })}
    <div class="cols-2 cols-2--fields">${numberRow('Centrifugal force', p('force_kN'), s.force_kN ?? '', { unit: 'kN', step: 5, min: 0, title: 'The force printed on the sheet (at the maximum rpm unless you set "stated at" below)' })}${numberRow('Frequency max', p('rpmMax'), s.rpmMax ?? '', { unit: 'rpm', step: 50, min: 0 })}</div>
    <label class="field field--inline"><span class="field__text">Attached mass from</span>${segmented(p('massSource'), massSrc, [{ value: 'amplitude', label: 'Amplitude' }, { value: 'mass', label: 'Vibrating mass' }])}</label>
    ${massSrc === 'amplitude'
      ? `<div class="cols-2 cols-2--fields">${numberRow('Amplitude', p('amplitude_mm'), s.amplitude_mm ?? '', { unit: 'mm', step: 0.5, min: 0, title: 'Free amplitude printed on the sheet (machine without pile); M_dyn = 2·M_e/A_pp' })}${selectRow('convention', p('amplitudeConvention'), s.amplitudeConvention || 'pp', [{ value: 'pp', label: 'peak-to-peak (2·Mₑ/M_dyn)' }, { value: 'single', label: 'single (Mₑ/M_dyn)' }], { title: 'Dieseko/ICE, PVE and ABI print the peak-to-peak value' })}</div>`
      : numberRow('Vibrating mass', p('dynamicMass_kg'), s.dynamicMass_kg ?? '', { unit: 'kg', step: 50, min: 0, title: 'Exciter + clamp ("dynamic weight")' })}
    ${help(summary, derived.ok ? '' : 'warn')}`;
  // Optional sheet values (small effect; blank = conservative or default).
  const more = `${numberRow('Force stated at', p('forceAtRpm'), s.forceAtRpm ?? '', { unit: 'rpm', step: 50, min: 0, title: 'Only when the sheet quotes the force below its maximum rpm (blank = at max rpm)' })}
    <div class="cols-2 cols-2--fields">${numberRow('Frequency min', p('rpmMin'), s.rpmMin ?? '', { unit: 'rpm', step: 50, min: 0 })}${numberRow('Operating rpm', p('rpmOperating'), s.rpmOperating ?? '', { unit: 'rpm', step: 50, min: 0, title: 'Blank = maximum rpm (maximum force); F_c ∝ rpm²' })}</div>
    <div class="cols-2 cols-2--fields">${numberRow('Eccentric moment (if printed)', p('eccentricMoment_kgm'), s.eccentricMoment_kgm ?? '', { unit: 'kg·m', step: 0.5, min: 0, title: 'Consistency check against F_c and rpm; the printed value wins' })}${numberRow('Total mass', p('totalMass_kg'), s.totalMass_kg ?? '', { unit: 'kg', step: 50, min: 0, title: 'Incl. suppressor/adapter; the non-vibrating part adds ≈1 % static downforce — blank is slightly conservative' })}</div>
    ${help('These change the result by a few percent at most; leave blank unless the sheet prints them.')}`;
  html += accordion('drv-sheet-more', 'More sheet values (optional)', more, { open: false });
  // Carrier suitability — never enters the drivability result.
  const carrier = `<div class="card__eyebrow">From the sheet</div>
    <div class="cols-2 cols-2--fields">${numberRow('Oil flow', p('flow_lmin'), s.flow_lmin ?? '', { unit: 'l/min', step: 5, min: 0 })}${numberRow('…max', p('flowMax_lmin'), s.flowMax_lmin ?? '', { unit: 'l/min', step: 5, min: 0 })}</div>
    <div class="cols-2 cols-2--fields">${numberRow('Working pressure', p('pressure_bar'), s.pressure_bar ?? '', { unit: 'bar', step: 5, min: 0 })}${numberRow('…max', p('pressureMax_bar'), s.pressureMax_bar ?? '', { unit: 'bar', step: 5, min: 0 })}</div>
    <div class="cols-2 cols-2--fields">${numberRow('Motor power', p('power_kW'), s.power_kW ?? '', { unit: 'kW', step: 1, min: 0 })}${numberRow('Carrier class', p('carrierMin_t'), s.carrierMin_t ?? '', { unit: 't min', step: 1, min: 0 })}</div>
    ${numberRow('Carrier class max', p('carrierMax_t'), s.carrierMax_t ?? '', { unit: 't', step: 1, min: 0 })}
    <div class="card__eyebrow">Your carrier</div>
    <div class="cols-2 cols-2--fields">${numberRow('Operating mass', 'drivability.vibrator.carrier.mass_t', vb.carrier?.mass_t ?? '', { unit: 't', step: 1, min: 0 })}${numberRow('Hydraulic flow', 'drivability.vibrator.carrier.flow_lmin', vb.carrier?.flow_lmin ?? '', { unit: 'l/min', step: 5, min: 0 })}</div>
    <div class="cols-2 cols-2--fields">${numberRow('Pressure', 'drivability.vibrator.carrier.pressure_bar', vb.carrier?.pressure_bar ?? '', { unit: 'bar', step: 5, min: 0 })}${numberRow('Hydraulic power', 'drivability.vibrator.carrier.power_kW', vb.carrier?.power_kW ?? '', { unit: 'kW', step: 5, min: 0 })}</div>
    ${help('Suitability of the excavator / power pack for this head (class, flow, pressure, p·Q/600). Not part of the drivability result.')}`;
  html += accordion('drv-carrier', 'Carrier check (optional)', carrier, { open: false });
  return html;
}

export function drivabilityPanel(rw) {
  if (!isEmbedded(rw.wallType)) return '';
  const dr = rw.drivability;
  const soldier = isSoldierPile(rw.wallType);
  const el = drivenElement(rw);
  const H = num(rw.embedded.retainedHeight, 5), d = num(rw.embedded.embedment, 4);
  const overdig = Number.isFinite(rw.result?.overdigUls) ? rw.result.overdigUls : 0.30;
  const target = targetToeDepth(rw);
  let body = `<label class="field field--inline"><span class="field__text">Installation</span>${segmented('drivability.method', dr.method, [{ value: 'vibratory', label: 'Vibratory' }, { value: 'impact', label: 'Impact' }, { value: 'push', label: 'Push (static)' }])}</label>
    ${soldier ? checkRow('Plugged toe (box area b·h)', 'drivability.toePlugged', !!dr.toePlugged) : selectRow('Driving unit', 'drivability.drivingUnit', dr.drivingUnit || 'single', [{ value: 'single', label: 'single pile' }, { value: 'pair', label: 'pair (double pile)' }]) + numberRow('Interlock resistance', 'drivability.interlock', dr.interlock, { unit: 'kN/m per interlock', step: 1, min: 0, title: 'Per metre of embedded interlock; from experience / trial (not derivable from q_c, f_s)' })}
    ${el ? help(`Element: <strong>${esc(el.label)}</strong> — toe area ${fmt(el.toeArea_m2 * 1e4, 1)} cm², contact perimeter ${fmt(el.shaftPerimeter_m, 2)} m, ${fmt(el.massPerM_kg, 0)} kg/m (${esc(el.unitNote)}).`) : ''}
    ${help(`Target toe depth: <strong>${fmt(target, 2)} m</strong> below the platform${dr.targetDepth > 0 ? ' (entered)' : ` = retained height ${fmt(H, 2)} + over-dig ${fmt(overdig, 2)} + embedment ${fmt(d, 2)} m below the <em>design</em> excavation`}. A pile of ${fmt(target + num(rw.soldier?.pileHeadAbove, 0), 2)} m reaches it; if your pile is shorter, set the embedment from the design level or enter the toe depth under “Model parameters”.`)}`;
  // Model parameters (advanced, collapsed): the numbers the two models are sensitive to.
  const modelParams = `${numberRow('Target toe depth override', 'drivability.targetDepth', dr.targetDepth ?? '', { unit: 'm', step: 0.1, title: 'Blank = H + over-dig + embedment (pile driven from the retained surface)' })}
    <div class="card__eyebrow">Resistance profile from the CPT</div>
    ${selectRow('Static reference', 'drivability.srdMethod', dr.srdMethod || 'reference', [{ value: 'reference', label: 'q_s = q_c, τ_s = f_s (course §7.2)' }, { value: 'alm-hamre', label: 'Alm & Hamre (2001) SRD, friction fatigue' }])}
    <div class="cols-2 cols-2--fields">${numberRow('Toe factor', 'drivability.toeFactor', dr.toeFactor, { step: 0.1, min: 0.1 })}${numberRow('Shaft factor', 'drivability.shaftFactor', dr.shaftFactor, { step: 0.1, min: 0.1 })}</div>
    ${help('Drivability needs an <em>upper</em> resistance envelope (dense lenses, set-up); Eurocode resistance factors must not be applied here (course §3.3).')}
    ${dr.method === 'vibratory' ? `<div class="card__eyebrow">Vibratory model</div>
    <div class="cols-2 cols-2--fields">${numberRow('Λ (degradation)', 'drivability.lambda', dr.lambda, { step: 1, min: 4, max: 10, title: 'Fully degraded resistance = 1/Λ of the static value; published range 4–10 (Holeyman 2002). The result card shows the band over 4–10.' })}${numberRow('δ<sub>H</sub> (damping)', 'drivability.deltaH', dr.deltaH, { step: 0.05, min: 0, title: '0 = free acceleration (optimistic); calibrate against a measured amplitude (course §15.8)' })}</div>
    ${numberRow('Line pull (up)', 'drivability.vibrator.lineForce', dr.vibrator.lineForce, { unit: 'kN', step: 5, min: 0, title: 'Crane line carrying part of the weight' })}
    ${checkRow('Add the element mass to the vibrating mass', 'drivability.includePileMass', dr.includePileMass !== false)}
    ${help('Hypervib1-type model (Van Rompaey, Legrand & Holeyman 1995; Holeyman 2002): χ = (1 − 1/Λ)·e<sup>−1/FR</sup> + 1/Λ, q<sub>d</sub> = (q<sub>s</sub> − q<sub>l</sub>)·e<sup>−α</sup> + q<sub>l</sub>. The pile is driven from the platform; the first depth where F<sub>c</sub> + W<sub>eff</sub> &lt; m<sub>R</sub>·R<sub>drive</sub> is the predicted refusal. m<sub>R</sub> = 1.25 is an equipment reserve, not a partial factor.')}` : ''}`;
  if (dr.method === 'vibratory') {
    const vb = dr.vibrator;
    const source = vibratorSource(vb);
    const cat = source === 'catalog' ? findHammer(vb.id) : null;
    body += `<div class="card__eyebrow">Vibratory hammer</div>
      <label class="field field--inline"><span class="field__text">Describe by</span>${segmented('drivability.vibrator.source', source, [{ value: 'sheet', label: 'Data sheet' }, { value: 'catalog', label: 'Catalogue' }, { value: 'required', label: 'Required only' }])}</label>`;
    if (source === 'sheet') {
      body += datasheetForm(vb) + help('A plate compactor (SAES HST and similar) has no clamp: the element is not rigidly attached, so the attached-mass model is optimistic — use it for light trench sheets only.');
    } else if (source === 'catalog') {
      body += selectRow('Model', 'drivability.vibrator.id', cat ? vb.id : 'custom', [{ value: 'custom', label: '— choose —' }, ...vibratoryHammers.map((h) => ({ value: h.id, label: `${h.make} ${h.model}` }))])
        + (cat ? help(`${esc(cat.model)}: ${fmt(cat.eccentricMomentMax_kgm, 0)} kg·m, ${fmt(cat.centrifugalForceMax_kN, 0)} kN at ${fmt(cat.frequencyMax_Hz, 1)} Hz${cat.dynamicMass_kg ? `, dynamic mass ${fmt(cat.dynamicMassWithClamp_kg || cat.dynamicMass_kg, 0)} kg` : ' — dynamic mass not published: enter it'}${cat.variableMoment ? ', variable moment' : ''}. <a href="${esc(cat.source)}" target="_blank" rel="noopener">source</a>`) : help('Verified rows only (URL and date per row). Not listed? Use “Data sheet”.'))
        + numberRow('Operating frequency', 'drivability.vibrator.frequency', vb.frequency, { unit: 'Hz', step: 1, min: 5, title: 'Force at this frequency: M_e·(2πf)²' })
        + numberRow('Dynamic mass (exciter + clamp)', 'drivability.vibrator.dynamicMass', vb.dynamicMass, { unit: 'kg', step: 100, min: 100 });
    } else {
      body += help('No machine yet: the run reports the minimum centrifugal force, eccentric moment and amplitude a vibrator must provide at this frequency and attached mass — the specification to send to suppliers.')
        + numberRow('Frequency', 'drivability.vibrator.frequency', vb.frequency, { unit: 'Hz', step: 1, min: 5 })
        + numberRow('Dynamic mass (exciter + clamp)', 'drivability.vibrator.dynamicMass', vb.dynamicMass, { unit: 'kg', step: 100, min: 100 })
        + numberRow('Candidate eccentric moment', 'drivability.vibrator.eccentricMoment', vb.eccentricMoment ?? '', { unit: 'kg·m', step: 1, min: 0, title: 'Optional: check a candidate head' });
    }
    body += numberRow('Crowd / pull-down', 'drivability.vibrator.crowd', vb.crowd, { unit: 'kN', step: 5, min: 0, title: 'Leader or excavator push-down on the head (course §4.3); not more than the carrier can hold stably. 0 = free-hanging.' });
  } else if (dr.method === 'push') {
    body += `<div class="card__eyebrow">Static push</div>
      ${numberRow('Push force at the head', 'drivability.push.force_kN', dr.push?.force_kN ?? 150, { unit: 'kN', step: 10, min: 0, title: 'Excavator crowd through a driving cap, or the rated press force of a press-in machine. Enter what the contractor guarantees, not the hydraulic maximum.' })}
      ${checkRow('Add the element self-weight', 'drivability.push.includeWeight', dr.push?.includeWeight !== false)}
      ${help('Quasi-static balance F<sub>push</sub> + W ≥ R<sub>static</sub>(z) against the upper CPT resistance envelope (no degradation, no rate effects). Typical excavator crowd ≤ 30–50 % of its operating weight (a 25 t machine: ≈ 75–120 kN); a press-in machine gives its rated force with reaction from installed elements. Obstructions and q<sub>c</sub> &gt; 30 MPa layers refuse pressing regardless.')}`;
  } else {
    const hm = dr.hammer;
    const cat = hm.id && hm.id !== 'custom' ? findHammer(hm.id) : null;
    body += `<div class="card__eyebrow">Impact hammer</div>
      ${selectRow('Model', 'drivability.hammer.id', hm.id || 'custom', [{ value: 'custom', label: 'custom' }, ...impactHammers.map((h) => ({ value: h.id, label: `${h.make} ${h.model} (${h.ratedEnergy_kJ} kJ)` }))])}
      ${cat ? help(`${esc(cat.model)}: ram ${fmt(cat.ramMass_kg, 0)} kg, rated ${fmt(cat.ratedEnergy_kJ, 0)} kJ, ${esc(cat.type)}. <a href="${esc(cat.source)}" target="_blank" rel="noopener">source</a>`) : `<div class="cols-2 cols-2--fields">${numberRow('Ram mass', 'drivability.hammer.ramMass', hm.ramMass, { unit: 'kg', step: 100 })}${numberRow('Rated energy', 'drivability.hammer.ratedEnergy', hm.ratedEnergy, { unit: 'kJ', step: 1 })}</div>`}
      ${numberRow('Efficiency', 'drivability.hammer.efficiency', hm.efficiency, { step: 0.05, min: 0.3, max: 1 })}`;
  }
  const impactAdvanced = dr.method === 'impact' ? `<div class="card__eyebrow">Impact hammer details</div>
      <div class="cols-2 cols-2--fields">${numberRow('Helmet mass', 'drivability.hammer.helmetMass', dr.hammer.helmetMass, { unit: 'kg', step: 100 })}${numberRow('Cushion stiffness', 'drivability.hammer.cushionStiffness', dr.hammer.cushionStiffness, { unit: 'kN/m', step: 1e5 })}</div>
      ${numberRow('Cushion COR', 'drivability.hammer.cushionCor', dr.hammer.cushionCor, { step: 0.05, min: 0.3, max: 1 })}
      <div class="card__eyebrow">Smith soil model</div>
      <div class="cols-2 cols-2--fields">${numberRow('Shaft quake', 'drivability.soil.shaftQuake', dr.soil.shaftQuake, { unit: 'm', step: 0.0005 })}${numberRow('Toe quake', 'drivability.soil.toeQuake', dr.soil.toeQuake, { unit: 'm', step: 0.0005 })}</div>
      <div class="cols-2 cols-2--fields">${numberRow('Shaft damping sand', 'drivability.soil.shaftDampingSand', dr.soil.shaftDampingSand, { unit: 's/m', step: 0.05 })}${numberRow('Shaft damping clay', 'drivability.soil.shaftDampingClay', dr.soil.shaftDampingClay, { unit: 's/m', step: 0.05 })}</div>
      ${numberRow('Toe damping', 'drivability.soil.toeDamping', dr.soil.toeDamping, { unit: 's/m', step: 0.05 })}
      ${help('Smith (1960) lumped-mass wave equation; defaults from GRLWEAP / FHWA GEC-12 (quake 2.5 mm, damping 0.16 s/m sand, 0.65 s/m clay, 0.50 s/m toe). Diesel hammers are modelled by their rated energy only (no combustion model).')}` : '';
  body += accordion('drv-model', 'Model parameters (advanced)', modelParams + impactAdvanced, { open: false });
  body += `<div class="actions"><button type="button" class="btn btn--sm btn--primary" onclick="retwallRunDrivability()">Run drivability</button>${dr.status === 'running' ? '<span class="field__hint">computing…</span>' : ''}</div>`;
  return accordion('drivability', 'Drivability', body, { open: false, pill: dr.method === 'impact' ? 'impact' : dr.method === 'push' ? 'push' : `vibratory · ${vibratorSource(dr.vibrator)}` });
}

function verdictBox(level, tag, text) {
  return `<div class="verdict ${level === 'ok' ? 'verdict--good' : level === 'warn' ? 'verdict--warn' : 'verdict--bad'}"><span class="verdict__tag">${tag}</span><span class="verdict__body">${text}</span></div>`;
}

function candidateCard(R) {
  const V = R.vibratory, c = V.candidateCheck, sd = R.datasheet;
  if (!c) return '';
  const name = esc(R.machineLabel || 'candidate');
  let verdict;
  if (!c.reachesTarget) verdict = verdictBox('bad', 'REFUSAL', `<strong>${name}</strong> is predicted to refuse at <strong>${fmt(c.refusalDepth_m, 2)} m</strong> (m<sub>R</sub> = 1.0) — mechanically possible down to ${fmt(c.achievableDepth_m, 2)} m of the ${fmt(c.targetDepth_m, 2)} m target. Short by ${fmt(c.targetDepth_m - c.achievableDepth_m, 2)} m.`);
  else if (!c.reachesTarget125) verdict = verdictBox('warn', 'MARGINAL', `<strong>${name}</strong> reaches the target ${fmt(c.targetDepth_m, 2)} m without reserve (m<sub>R</sub> = 1.0); with the 1.25 equipment reserve refusal is predicted at ${fmt(c.refusalDepth125_m, 2)} m. Plan a trial pile and a fallback (heavier head, crowd, pre-drilling).`);
  else verdict = verdictBox('ok', 'REACHES TARGET', `<strong>${name}</strong> reaches the target depth ${fmt(c.targetDepth_m, 2)} m with the 1.25 reserve — smallest margin ${fmt(c.margin125_kN, 0)} kN at ${fmt(c.z, 2)} m.`);
  const rows = [
    ['F<sub>c</sub> available', fmt(c.Fc_kN, 1), `kN at ${fmt(V.frequency_Hz, 1)} Hz${sd ? ` (${fmt(sd.rpmOperating, 0)} rpm)` : ''}`],
    ['F<sub>c,min</sub> required for the target', `${fmt(V.FcRequired_kN, 1)} / ${fmt(V.FcRequired125_kN, 1)}`, 'kN (m_R 1.0 / 1.25)'],
    ['Force margin at the target', `${fmt(c.marginAtTarget_kN, 1)} / ${fmt(c.marginAtTarget125_kN, 1)}`, `kN ${badge(c.marginAtTarget_kN >= 0, c.marginAtTarget_kN >= 0 ? 'OPEN' : 'CLOSED')}`],
    ['Worst margin', `${fmt(c.margin_kN, 1)} / ${fmt(c.margin125_kN, 1)}`, `kN at ${fmt(c.z, 2)} m`],
    ['Eccentric moment M<sub>e</sub>', fmt(c.eccentricMoment_kgm, 2), `kg·m${sd ? ` (${sd.eccentricMomentSource === 'stated' ? 'sheet' : 'from F_c, rpm'})` : ''}`],
    ['Vibrating mass M<sub>dyn</sub>', fmt(V.dynamicMass_kg, 0), `kg${R.pileMass_kg ? ` incl. ${fmt(R.pileMass_kg, 0)} kg element` : ''}${sd ? ` (${sd.dynamicMassSource === 'stated' ? 'sheet' : sd.dynamicMassSource === 'from-amplitude' ? `from ${fmt(sd.amplitudeStated_mm, 1)} mm ${sd.amplitudeConvention === 'pp' ? 'p-p' : 'single'} amplitude` : '?'})` : ''}`],
    ['Attached amplitude s₀ / A<sub>pp</sub>', `${fmt(c.amplitude_mm, 2)} / ${fmt(c.amplitudePp_mm, 2)}`, 'mm (with the element)'],
    ['Acceleration ratio α', fmt(c.accelerationRatio, 2), '— free; at the worst depth ' + fmt(c.alpha, 2)],
    ['W<sub>eff</sub> (weight + crowd − line)', fmt(V.Weff_kN, 1), `kN${sd?.staticExtra_kN ? ` incl. ${fmt(sd.staticExtra_kN, 1)} kN isolated part` : ''}`],
    ['Stress screen (F<sub>c</sub> + W<sub>eff</sub>)/A<sub>s</sub>', fmt(c.stressScreen_MPa, 1), 'MPa']
  ];
  let carrier = '';
  if (R.carrier?.rows) {
    carrier = `<div class="card__eyebrow">Carrier check ${R.carrier.ok === null ? badge(true, 'NOT CHECKED') : badge(R.carrier.ok)}</div>` + table([
      { label: 'Item', render: (r) => esc(r.label) }, { label: 'Machine needs', render: (r) => esc(r.required) }, { label: 'Carrier', render: (r) => esc(r.available) },
      { label: '', render: (r) => r.ok === null ? '<span class="pill pill--data">—</span>' : badge(r.ok) + (r.note ? `<div class="tbl__sub">${esc(r.note)}</div>` : '') }
    ], R.carrier.rows);
  }
  const sb = R.sensitivity;
  const band = sb ? help(`<strong>Model sensitivity:</strong> achievable depth ${fmt(sb.min_m, 1)}–${fmt(sb.max_m, 1)} m of the ${fmt(sb.target_m, 2)} m target across ${sb.rows.slice(1).map((r) => `${esc(r.label)} → ${fmt(r.achievable_m, 1)} m`).join(', ')}. The force-envelope method is an order-of-magnitude screen (course §7.1): differences smaller than this band — and any margin below ~0.5 m — are inside the model's resolution; confirm with a trial pile (course §15.8).`) : '';
  return `<div class="card__eyebrow">Achievable depth — ${name}</div>${verdict}${band}<div>${kvList(rows)}</div>${carrier}`;
}

export function drivabilityView(rw) {
  const dr = rw.drivability;
  if (!isEmbedded(rw.wallType)) return '<div class="card card--quiet card--note">Drivability is assessed for driven elements (sheet piles, soldier piles).</div>';
  if (dr.status === 'error') return `<div class="verdict verdict--bad"><span class="verdict__tag">ERROR</span><span class="verdict__body">${esc(dr.error)}</span></div>`;
  const R = dr.result;
  if (!R) return '<div class="card card--quiet card--note">Open the “Drivability” panel, describe the machine (data sheet, catalogue or required-only) and press <strong>Run drivability</strong>. The resistance profile uses the CPT trace of the active sounding with the same datum shift as the design.</div>';
  if (!R.ok) return `<div class="verdict verdict--warn"><span class="verdict__body">${(R.notes || []).map(esc).join('<br>')}</span></div>`;
  let html = '';
  if (R.vibratory) {
    const V = R.vibratory;
    const m = V.machine || {};
    const req = [
      ['F<sub>c,min</sub> (m<sub>R</sub> = 1.0)', fmt(V.FcRequired_kN, 1), `kN, governing depth ${fmt(V.governingDepth_m, 2)} m`],
      ['F<sub>c,min</sub> (m<sub>R</sub> = 1.25, recommended)', fmt(V.FcRequired125_kN, 1), `kN at ${fmt(V.governingDepth125_m, 2)} m`],
      ['Eccentric moment at f', fmt(m.atRequired125?.eccentricMoment_kgm, 2), `kg·m at ${fmt(V.frequency_Hz, 1)} Hz (${fmt(V.frequency_Hz * 60, 0)} rpm)`],
      ['Attached amplitude s₀ / A<sub>pp</sub>', `${fmt(m.atRequired125?.amplitude_mm, 2)} / ${fmt(m.atRequired125?.amplitudePp_mm, 2)}`, `mm for M_dyn ${fmt(V.dynamicMass_kg, 0)} kg`],
      ['Acceleration ratio α', fmt(m.atRequired125?.accelerationRatio, 2), '—'],
      ['Static downforce W<sub>eff</sub>', fmt(V.Weff_kN, 1), 'kN'],
      ['Stress screen (F<sub>c</sub> + W<sub>eff</sub>)/A<sub>s</sub>', fmt(m.atRequired125?.stressScreen_MPa, 1), 'MPa'],
      ['Λ / δ<sub>H</sub>', `${fmt(V.lambda, 0)} / ${fmt(V.deltaH, 2)}`, '']
    ];
    html += `<div class="cols-2"><div class="stack--sections">
      ${V.candidateCheck ? candidateCard(R) : ''}
      <div class="card__eyebrow">Minimum vibrator for the target depth ${fmt(R.target, 2)} m</div>
      ${kvList(req)}
      ${help(`Specification to a supplier: a head that delivers <strong>${fmt(V.FcRequired125_kN, 0)} kN</strong> and <strong>${fmt(m.atRequired125?.eccentricMoment_kgm, 1)} kg·m</strong> simultaneously at ${fmt(V.frequency_Hz * 60, 0)} rpm with about ${fmt(V.dynamicMass_kg - (R.pileMass_kg || 0), 0)} kg vibrating mass, plus the static downforce assumed (course §7.9). Amplitude, clamp, power, wave stress and vibration are separate checks (course §7.10).`)}
      </div><div><div class="viz viz--chart viz--tall"><canvas id="retwallChartDrive2"></canvas></div></div></div>
      <div class="cols-2"><div><div class="viz viz--chart"><canvas id="retwallChartDrive1"></canvas></div></div><div class="stack--sections">
      ${table([{ label: 'z (m)', num: true, render: (r) => fmt(r.z, 2) }, { label: 'R<sub>s</sub> (kN)', num: true, render: (r) => fmt(r.Rs_kN, 1) }, { label: 'R<sub>b</sub> (kN)', num: true, render: (r) => fmt(r.Rb_kN, 1) }, { label: 'R<sub>drive</sub> (kN)', num: true, render: (r) => fmt(r.Rdrive_kN, 1) }, { label: 'α', num: true, render: (r) => fmt(r.alpha, 2) }, { label: 'F<sub>c,min</sub> (kN)', num: true, render: (r) => fmt(r.FcMin_kN, 1) }, { label: 'F<sub>c,min,1.25</sub>', num: true, render: (r) => fmt(r.FcMin125_kN, 1) }, ...(V.candidateCheck ? [{ label: 'G<sub>cand</sub> (kN)', num: true, render: (r) => `${fmt(r.Gcand_kN, 1)}` }] : [])], V.perDepth.filter((_, i) => i % Math.max(1, Math.round(V.perDepth.length / 24)) === 0 || i === V.perDepth.length - 1))}
      <div class="actions">${copyButton('copy per-depth table (TSV)', toTsv(['z_m', 'Rs_kN', 'Rb_kN', 'Rdrive_kN', 'alpha', 'FcMin_kN', 'FcMin125_kN', 'Gcand_kN', 'Gcand125_kN'], V.perDepth.map((r) => [r.z, r.Rs_kN, r.Rb_kN, r.Rdrive_kN, r.alpha, r.FcMin_kN, r.FcMin125_kN, r.Gcand_kN ?? '', r.Gcand125_kN ?? ''])))}</div>
      </div></div>`;
  }
  if (R.push) {
    const P = R.push;
    const verdict = !P.reachesTarget
      ? verdictBox('bad', 'REFUSAL', `Pushing with <strong>${fmt(P.force_kN, 0)} kN</strong> is predicted to stop at <strong>${fmt(P.refusalDepth_m, 2)} m</strong> — possible down to ${fmt(P.achievableDepth_m, 2)} m of the ${fmt(P.targetDepth_m, 2)} m target. Short by ${fmt(P.targetDepth_m - P.achievableDepth_m, 2)} m; ${fmt(P.requiredForce_kN, 0)} kN is needed (${fmt(P.requiredForce125_kN, 0)} kN with the 1.25 reserve).`)
      : !P.reachesTarget125 ? verdictBox('warn', 'MARGINAL', `<strong>${fmt(P.force_kN, 0)} kN</strong> reaches the target ${fmt(P.targetDepth_m, 2)} m without reserve; with the 1.25 reserve refusal is predicted at ${fmt(P.refusalDepth125_m, 2)} m. Required ${fmt(P.requiredForce125_kN, 0)} kN with reserve.`)
      : verdictBox('ok', 'REACHES TARGET', `<strong>${fmt(P.force_kN, 0)} kN</strong> reaches the target ${fmt(P.targetDepth_m, 2)} m with the 1.25 reserve — smallest margin ${fmt(Math.min(...P.perDepth.map((r) => r.G125_kN)), 0)} kN.`);
    html += `<div class="cols-2"><div class="stack--sections">
      <div class="card__eyebrow">Achievable depth — static push</div>
      ${verdict}<div class="stack--sections">
      ${kvList([['Required push force (m<sub>R</sub> = 1.0 / 1.25)', `${fmt(P.requiredForce_kN, 0)} / ${fmt(P.requiredForce125_kN, 0)}`, `kN, governing depth ${fmt(P.governingDepth_m, 2)} m`], ['Static resistance at the target', fmt(P.perDepth[P.perDepth.length - 1]?.Rstatic_kN, 0), 'kN (upper envelope)'], ['Element self-weight at the target', fmt(P.perDepth[P.perDepth.length - 1]?.W_kN, 1), 'kN'], ['Margin at the target (1.0 / 1.25)', `${fmt(P.marginAtTarget_kN, 0)} / ${fmt(P.marginAtTarget125_kN, 0)}`, 'kN']])}</div>
      ${help('The static resistance profile is an upper envelope from q<sub>c</sub>/f<sub>s</sub> (or Alm & Hamre with friction fatigue — the usual press-in basis). No dynamic degradation applies to pressing. The prediction is a screen; a trial element confirms it.')}
      </div><div><div class="viz viz--chart viz--tall"><canvas id="retwallChartDrive1"></canvas></div></div></div>
      <div class="cols-2"><div></div><div class="stack--sections">
      ${table([{ label: 'z (m)', num: true, render: (r) => fmt(r.z, 2) }, { label: 'R<sub>s</sub> (kN)', num: true, render: (r) => fmt(r.Rs_kN, 0) }, { label: 'R<sub>b</sub> (kN)', num: true, render: (r) => fmt(r.Rb_kN, 0) }, { label: 'R<sub>static</sub> (kN)', num: true, render: (r) => fmt(r.Rstatic_kN, 0) }, { label: 'W (kN)', num: true, render: (r) => fmt(r.W_kN, 1) }, { label: 'F<sub>req</sub> (kN)', num: true, render: (r) => fmt(r.Frequired_kN, 0) }, { label: 'G (kN)', num: true, render: (r) => fmt(r.G_kN, 0) }], P.perDepth.filter((_, i) => i % Math.max(1, Math.round(P.perDepth.length / 24)) === 0 || i === P.perDepth.length - 1))}
      <div class="actions">${copyButton('copy per-depth table (TSV)', toTsv(['z_m', 'Rs_kN', 'Rb_kN', 'Rstatic_kN', 'W_kN', 'Frequired_kN', 'G_kN'], P.perDepth.map((r) => [r.z, r.Rs_kN, r.Rb_kN, r.Rstatic_kN, r.W_kN, r.Frequired_kN, r.G_kN])))}</div>
      </div></div>`;
  }
  if (R.impact) {
    const I = R.impact;
    const last = I.perDepth[I.perDepth.length - 1];
    const worst = I.perDepth.reduce((m, r) => (r.blows_per_25cm ?? 9999) > (m?.blows_per_25cm ?? -1) ? r : m, null);
    const verdict = I.refusalDepth_m != null
      ? verdictBox('bad', 'REFUSAL', `Refusal (≥ 250 blows / 25 cm) predicted at <strong>${fmt(I.refusalDepth_m, 2)} m</strong> of the ${fmt(R.target, 2)} m target.`)
      : verdictBox(last?.blows_per_25cm > 120 ? 'warn' : 'ok', last?.blows_per_25cm > 120 ? 'HARD DRIVING' : 'REACHES TARGET', `The hammer reaches the target ${fmt(R.target, 2)} m; hardest driving ${fmt(worst?.blows_per_25cm, 0)} blows / 25 cm at ${fmt(worst?.z, 2)} m.`);
    html += `<div class="cols-2"><div class="stack--sections">
      <div class="card__eyebrow">Achievable depth — hammer ${esc(R.hammer?.type || '')}, ram ${fmt(R.hammer?.ramMass_kg, 0)} kg, ${fmt(R.hammer?.ratedEnergy_kJ, 0)} kJ × η ${fmt(R.hammer?.efficiency, 2)}</div>
      ${verdict}<div class="stack--sections">
      ${kvList([['Blow count at target depth', last?.blows_per_25cm != null ? fmt(last.blows_per_25cm, 0) : 'refusal', `blows / 25 cm at ${fmt(last?.z, 2)} m`], ['Set per blow at target', fmt(last?.set_mm, 1), 'mm'], ['Hardest driving', worst?.blows_per_25cm != null ? fmt(worst.blows_per_25cm, 0) : 'refusal', `blows / 25 cm at ${fmt(worst?.z, 2)} m`], ['Max compressive stress', fmt(Math.max(...I.perDepth.map((r) => r.maxCompStress_MPa || 0)), 0), 'MPa'], ['Max tensile stress', fmt(Math.max(...I.perDepth.map((r) => r.maxTensStress_MPa || 0)), 0), 'MPa'], ['Transferred energy (ENTHRU) at target', fmt(last?.enthru_kJ, 1), 'kJ'], ['Refusal criterion', '≥ 250 blows / 25 cm', 'FHWA GEC-12 practice']])}</div>
      <div class="card__text">Verify the compressive stress against 0.9·f<sub>y</sub> (EN 12699 / EN 12063 driving stress limits) and the pile's buckling and handling condition separately.</div>
      </div><div><div class="viz viz--chart viz--tall"><canvas id="retwallChartDrive1"></canvas></div></div></div>
      <div class="cols-2"><div><div class="viz viz--chart"><canvas id="retwallChartDrive2"></canvas></div></div><div class="stack--sections">
      ${table([{ label: 'z (m)', num: true, render: (r) => fmt(r.z, 2) }, { label: 'R<sub>static</sub> (kN)', num: true, render: (r) => fmt(r.Rstatic_kN, 0) }, { label: 'set (mm)', num: true, render: (r) => fmt(r.set_mm, 1) }, { label: 'blows/25 cm', num: true, render: (r) => r.refusal ? 'refusal' : fmt(r.blows_per_25cm, 0) }, { label: 'σ<sub>c,max</sub> (MPa)', num: true, render: (r) => fmt(r.maxCompStress_MPa, 0) }, { label: 'σ<sub>t,max</sub> (MPa)', num: true, render: (r) => fmt(r.maxTensStress_MPa, 0) }, { label: 'ENTHRU (kJ)', num: true, render: (r) => fmt(r.enthru_kJ, 1) }], I.perDepth)}
      <div class="actions">${copyButton('copy blow-count table (TSV)', toTsv(['z_m', 'Rstatic_kN', 'set_mm', 'blows_per_25cm', 'sigma_c_MPa', 'sigma_t_MPa', 'enthru_kJ'], I.perDepth.map((r) => [r.z, r.Rstatic_kN, r.set_mm, r.blows_per_25cm ?? 'refusal', r.maxCompStress_MPa, r.maxTensStress_MPa, r.enthru_kJ])))}</div>
      </div></div>`;
  }
  html += `<div class="card__text">${(R.notes || []).map(esc).join(' ')}</div>`;
  return html;
}

export function drawDrivabilityCharts(rw) {
  const R = rw.drivability?.result;
  if (!R?.ok) return;
  const c1 = document.getElementById('retwallChartDrive1');
  const c2 = document.getElementById('retwallChartDrive2');
  const S = retainingVizSeries();
  if (R.vibratory) {
    const V = R.vibratory;
    const c = V.candidateCheck;
    if (c1 && V.forceEnvelopeCurve?.length) drawXYChart(c1, { title: `Force envelope at the governing depth ${fmt(V.governingDepth125_m, 2)} m`, xLabel: 'F_c (kN)', yLabel: 'margin G (kN)', series: [{ x: V.forceEnvelopeCurve.map((p) => p.Fc_kN), y: V.forceEnvelopeCurve.map((p) => p.G_kN), color: S.drive, label: 'G = F_c + W_eff − R_drive' }, { x: V.forceEnvelopeCurve.map((p) => p.Fc_kN), y: V.forceEnvelopeCurve.map((p) => p.G125_kN), color: S.required125, label: 'G (m_R = 1.25)' }], hlines: [{ y: 0, label: 'G = 0', color: S.zero }], vlines: [{ x: V.FcRequired_kN, label: `F_c,min ${fmt(V.FcRequired_kN, 0)} kN` }, { x: V.FcRequired125_kN, label: `${fmt(V.FcRequired125_kN, 0)} kN (1.25)` }, ...(c ? [{ x: c.Fc_kN, label: `machine ${fmt(c.Fc_kN, 0)} kN`, color: S.machine }] : [])] });
    if (c2 && V.perDepth?.length) {
      const z = V.perDepth.map((r) => r.z);
      const series = [{ z, v: V.perDepth.map((r) => r.Rstatic_kN), color: S.staticRef, label: 'R_static (reference)', width: 1.2 }, { z, v: V.perDepth.map((r) => r.Rdrive_kN), color: S.drive, label: 'R_drive (dynamic)' }, { z, v: V.perDepth.map((r) => r.FcMin_kN), color: S.required, label: 'F_c,min (m_R 1.0)' }, { z, v: V.perDepth.map((r) => r.FcMin125_kN), color: S.required125, label: 'F_c,min (m_R 1.25)' }];
      const markers = [{ depth: R.target, label: `target ${fmt(R.target, 2)} m`, color: S.target }];
      if (c) {
        series.push({ z, v: V.perDepth.map(() => c.Fc_kN), color: S.machine, label: `machine F_c ${fmt(c.Fc_kN, 0)} kN`, width: 1.4 });
        if (c.refusalDepth_m != null) markers.push({ depth: c.refusalDepth_m, label: `refusal (m_R 1.0) ${fmt(c.refusalDepth_m, 2)} m`, color: S.refusal });
        else if (c.refusalDepth125_m != null) markers.push({ depth: c.refusalDepth125_m, label: `refusal (m_R 1.25) ${fmt(c.refusalDepth125_m, 2)} m`, color: S.marginal });
      }
      drawDepthChart(c2, { title: c ? 'Machine force vs required force — where the envelope closes' : 'Resistance and required force vs toe depth', unit: 'kN', depthMax: Math.max(...z), series, markers });
    }
  }
  if (R.push && c1) {
    const P = R.push;
    const z = P.perDepth.map((r) => r.z);
    const markers = [{ depth: R.target, label: `target ${fmt(R.target, 2)} m`, color: S.target }];
    if (P.refusalDepth_m != null) markers.push({ depth: P.refusalDepth_m, label: `refusal ${fmt(P.refusalDepth_m, 2)} m`, color: S.refusal });
    else if (P.refusalDepth125_m != null) markers.push({ depth: P.refusalDepth125_m, label: `refusal (m_R 1.25) ${fmt(P.refusalDepth125_m, 2)} m`, color: S.marginal });
    drawDepthChart(c1, { title: 'Static resistance vs push force — where the balance closes', unit: 'kN', depthMax: Math.max(...z), series: [{ z, v: P.perDepth.map((r) => r.Rstatic_kN), color: S.drive, label: 'R_static (upper envelope)' }, { z, v: P.perDepth.map((r) => r.Frequired_kN), color: S.required, label: 'F required (R − W)' }, { z, v: P.perDepth.map(() => P.force_kN), color: S.machine, label: `F_push ${fmt(P.force_kN, 0)} kN`, width: 1.4 }], markers });
  }
  if (R.impact) {
    const I = R.impact;
    const blows = I.perDepth.map((r) => r.blows_per_25cm ?? 250);
    const markers = [{ depth: R.target, label: `target ${fmt(R.target, 2)} m`, color: S.target }];
    if (I.refusalDepth_m != null) markers.push({ depth: I.refusalDepth_m, label: `refusal ${fmt(I.refusalDepth_m, 2)} m`, color: S.refusal });
    if (c1) drawDepthChart(c1, { title: 'Blow count vs toe depth', unit: 'blows / 25 cm', depthMax: Math.max(...I.perDepth.map((r) => r.z)), series: [{ z: I.perDepth.map((r) => r.z), v: blows, color: S.blows, label: 'blows per 25 cm', fill: S.blowsSoft }, { z: I.perDepth.map((r) => r.z), v: I.perDepth.map((r) => r.maxCompStress_MPa), color: S.stress, label: 'σ_c,max (MPa)', width: 1.2 }], markers });
    if (c2 && I.bearingGraph?.length) drawXYChart(c2, { title: `Bearing graph at ${fmt(I.perDepth[I.perDepth.length - 1]?.z, 1)} m`, xLabel: 'blows / 25 cm', yLabel: 'R_u (kN)', series: [{ x: I.bearingGraph.map((p) => p.blows_per_25cm ?? 250), y: I.bearingGraph.map((p) => p.Ru_kN), color: S.capacity, label: 'capacity vs blow count', points: true }], xMin: 0 });
  }
}
