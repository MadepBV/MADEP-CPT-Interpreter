// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck — plain ES module with JSDoc contracts and runtime input guards (repo pattern, see PLAN §5)
/**
 * Vibrator data sheet → model input.
 *
 * A supplier sheet (Dieseko/ICE, PVE, ABI, SAES, …) lists a *machine* in its own vocabulary:
 * centrifugal force, rpm range, amplitude, mass, oil flow, working pressure, motor power and the
 * carrier class. The force-envelope model (vibratory-drivability.js) needs the *mechanics*:
 * eccentric moment M_e, operating frequency f, attached (dynamic) mass M_dyn and the static
 * downforce. This module does the translation with the relations of course §4.1–4.3 and states
 * for every derived number which sheet value it came from.
 *
 * Relations (course §4.1–4.2, F in kN, M_e in kg·m, ω in rad/s)
 *   ω = 2π·rpm/60
 *   F_c(f) = M_e·ω²/1000                   → M_e = 1000·F_c,max/ω_max²   when the sheet gives only the force
 *   s₀ = M_e/M_dyn (single), A_pp = 2·s₀   → M_dyn = 2000·M_e/A_pp [mm]  or 1000·M_e/s₀ [mm]
 *   P_hyd = p[bar]·Q[l/min]/600  [kW]      hydraulic power the carrier must deliver
 *   W_static = (M_total − M_dyn)·g/1000    weight of the isolated (non-vibrating) part, transmitted
 *                                          through the suppressor to the pile unless the line carries it
 *
 * Amplitude convention. Dieseko/ICE, PVE and ABI print the peak-to-peak free amplitude 2·M_e/M_dyn
 * (checked: ICE 28RF 28 kg·m / 3900 kg → 14.4 mm, sheet 14 mm; with 200TU clamp 5400 kg → 10.4 mm,
 * sheet 10.4 mm). Some sheets print the single amplitude; the convention is therefore an input.
 */

export const G_M_S2 = 9.81;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };

/**
 * @param {object} sheet
 *   force_kN            centrifugal force printed on the sheet (at rpmMax unless forceAtRpm is given)
 *   forceAtRpm          rpm at which force_kN applies (blank = rpmMax)
 *   rpmMax, rpmMin      frequency range
 *   rpmOperating        operating rpm for the check (blank = rpmMax)
 *   eccentricMoment_kgm stated eccentric moment (blank = derived from the force)
 *   amplitude_mm        printed amplitude; amplitudeConvention 'pp' (peak-to-peak, default) | 'single'
 *   dynamicMass_kg      vibrating mass incl. clamp (blank = derived from the amplitude)
 *   totalMass_kg        total mass incl. suppressor / adapter / hoses
 *   flow_lmin, flowMax_lmin, pressure_bar, pressureMax_bar, power_kW, carrierMin_t, carrierMax_t
 * @returns {object} derived vibrator + provenance
 */
export function vibratorFromDatasheet(sheet = {}) {
  const notes = [];
  const out = { ok: false, notes };
  const rpmMax = pos(sheet.rpmMax);
  const force = pos(sheet.force_kN);
  const MeStated = pos(sheet.eccentricMoment_kgm);
  if (!rpmMax) { notes.push('Data sheet: the maximum frequency (rpm) is required.'); return out; }
  if (!force && !MeStated) { notes.push('Data sheet: enter the centrifugal force (kN) or the eccentric moment (kg·m).'); return out; }
  const rpmForce = pos(sheet.forceAtRpm) || rpmMax;
  const wForce = 2 * Math.PI * rpmForce / 60;
  const wMax = 2 * Math.PI * rpmMax / 60;
  // eccentric moment
  let Me, MeSource;
  if (MeStated) {
    Me = MeStated; MeSource = 'stated';
    if (force) {
      const Fcheck = Me * wForce * wForce / 1000;
      const ratio = Fcheck / force;
      if (Math.abs(ratio - 1) > 0.10) notes.push(`Sheet inconsistency: M_e·ω² at ${rpmForce} rpm gives ${Fcheck.toFixed(0)} kN, the sheet prints ${force.toFixed(0)} kN (ratio ${ratio.toFixed(2)}). The stated moment is used.`);
    }
  } else {
    Me = 1000 * force / (wForce * wForce); MeSource = 'from-force';
  }
  // operating frequency
  const rpmMin = pos(sheet.rpmMin);
  let rpmOp = pos(sheet.rpmOperating) || rpmMax;
  if (rpmOp > rpmMax) { notes.push(`Operating rpm ${rpmOp} above the sheet maximum ${rpmMax}; clipped.`); rpmOp = rpmMax; }
  if (rpmMin && rpmOp < rpmMin) { notes.push(`Operating rpm ${rpmOp} below the sheet minimum ${rpmMin}; clipped.`); rpmOp = rpmMin; }
  const f = rpmOp / 60, w = 2 * Math.PI * f;
  const FcAtOperating = Me * w * w / 1000;
  const FcMax = Me * wMax * wMax / 1000;
  const FcMin = rpmMin ? Me * Math.pow(2 * Math.PI * rpmMin / 60, 2) / 1000 : null;
  // dynamic mass
  const amp = pos(sheet.amplitude_mm);
  const conv = sheet.amplitudeConvention === 'single' ? 'single' : 'pp';
  let Mdyn = pos(sheet.dynamicMass_kg), MdynSource = 'stated';
  if (!Mdyn && amp) { Mdyn = (conv === 'pp' ? 2000 : 1000) * Me / amp; MdynSource = 'from-amplitude'; }
  if (!Mdyn) { MdynSource = 'missing'; notes.push('Neither the vibrating mass nor the amplitude is on the sheet: enter one of them (the attached mass sets the acceleration).'); }
  if (Mdyn && amp && MdynSource === 'stated') {
    const ampCalc = (conv === 'pp' ? 2000 : 1000) * Me / Mdyn;
    if (Math.abs(ampCalc / amp - 1) > 0.15) notes.push(`Amplitude check: ${conv === 'pp' ? '2·' : ''}M_e/M_dyn gives ${ampCalc.toFixed(1)} mm, the sheet prints ${amp.toFixed(1)} mm — verify the amplitude convention or the vibrating mass.`);
  }
  const Mtot = pos(sheet.totalMass_kg);
  const suppressorMass = Mtot && Mdyn && Mtot > Mdyn ? Mtot - Mdyn : 0;
  if (Mtot && Mdyn && Mtot < Mdyn) notes.push('Total mass below the vibrating mass — check the sheet values.');
  const staticExtra_kN = suppressorMass * G_M_S2 / 1000;
  // hydraulics
  const flowWork = pos(sheet.flow_lmin) || pos(sheet.flowMax_lmin);
  const flowMax = pos(sheet.flowMax_lmin) || pos(sheet.flow_lmin);
  const pWork = pos(sheet.pressure_bar) || pos(sheet.pressureMax_bar);
  const pMax = pos(sheet.pressureMax_bar) || pos(sheet.pressure_bar);
  const hydraulicPower_kW = flowWork && pWork ? pWork * flowWork / 600 : null;        // working point
  const hydraulicPowerMax_kW = flowMax && pMax ? pMax * flowMax / 600 : null;         // at the sheet maxima
  const power = pos(sheet.power_kW);
  if (hydraulicPowerMax_kW && power && hydraulicPowerMax_kW < 0.8 * power) notes.push(`Hydraulic power p·Q/600 = ${hydraulicPowerMax_kW.toFixed(0)} kW at the sheet maxima is well below the printed motor power ${power} kW — check flow/pressure.`);
  Object.assign(out, {
    ok: !!Mdyn,
    frequency_Hz: f, rpmOperating: rpmOp, rpmMax, rpmMin, frequencyMax_Hz: rpmMax / 60, frequencyMin_Hz: rpmMin ? rpmMin / 60 : null,
    eccentricMoment_kgm: Me, eccentricMomentSource: MeSource,
    forceMax_kN: FcMax, forceMin_kN: FcMin, forceAtOperating_kN: FcAtOperating, forceStated_kN: force, forceStatedAtRpm: rpmForce,
    dynamicMass_kg: Mdyn, dynamicMassSource: MdynSource, amplitudeConvention: conv, amplitudeStated_mm: amp,
    amplitudeFree_pp_mm: Mdyn ? 2000 * Me / Mdyn : null,
    totalMass_kg: Mtot, suppressorMass_kg: suppressorMass, staticExtra_kN,
    flow_lmin: pos(sheet.flow_lmin), flowMax_lmin: flowMax, pressure_bar: pos(sheet.pressure_bar), pressureMax_bar: pMax, power_kW: power, hydraulicPower_kW, hydraulicPowerMax_kW,
    carrierMin_t: pos(sheet.carrierMin_t), carrierMax_t: pos(sheet.carrierMax_t)
  });
  return out;
}

/**
 * Carrier (excavator / power pack) suitability rows. Every row: { label, required, available, ok (true|false|null), note }.
 * ok = null when the sheet or the carrier does not give the value (nothing is assumed).
 */
export function carrierCheck(derived, carrier = {}) {
  const rows = [];
  const mass = pos(carrier.mass_t), flow = pos(carrier.flow_lmin), p = pos(carrier.pressure_bar), pw = pos(carrier.power_kW);
  const cmin = derived.carrierMin_t, cmax = derived.carrierMax_t;
  rows.push({ id: 'class', label: 'Carrier class', required: cmin || cmax ? `${cmin ?? '?'}–${cmax ?? '?'} t` : '—', available: mass ? `${mass} t` : '—',
    ok: mass && (cmin || cmax) ? (!cmin || mass >= cmin) && (!cmax || mass <= cmax) : null,
    note: mass && cmin && mass < cmin ? 'carrier lighter than the sheet minimum: stability and hydraulics doubtful' : mass && cmax && mass > cmax ? 'carrier heavier than the sheet maximum: check the adapter and the hydraulic limits' : '' });
  const qReq = derived.flow_lmin || derived.flowMax_lmin;
  rows.push({ id: 'flow', label: 'Oil flow', required: qReq ? `${derived.flow_lmin ?? '?'}${derived.flowMax_lmin && derived.flowMax_lmin !== derived.flow_lmin ? `–${derived.flowMax_lmin}` : ''} l/min` : '—', available: flow ? `${flow} l/min` : '—',
    ok: flow && qReq ? flow >= (derived.flow_lmin || qReq) : null,
    note: flow && derived.flowMax_lmin && flow > derived.flowMax_lmin ? 'carrier flow above the machine maximum: a flow limiter is required' : flow && qReq && flow < (derived.flow_lmin || qReq) ? 'insufficient flow: the machine will not reach its rated rpm (lower force)' : '' });
  const pReq = derived.pressure_bar || derived.pressureMax_bar;
  rows.push({ id: 'pressure', label: 'Working pressure', required: pReq ? `${derived.pressure_bar ?? '?'}${derived.pressureMax_bar && derived.pressureMax_bar !== derived.pressure_bar ? ` (max ${derived.pressureMax_bar})` : ''} bar` : '—', available: p ? `${p} bar` : '—',
    ok: p && pReq ? p >= (derived.pressure_bar || pReq) : null,
    note: p && derived.pressureMax_bar && p > derived.pressureMax_bar ? 'carrier pressure above the machine maximum: pressure relief required' : p && pReq && p < (derived.pressure_bar || pReq) ? 'insufficient pressure: the eccentrics cannot be driven at full moment in stiff soil' : '' });
  const pReqStr = derived.hydraulicPower_kW ? `${derived.hydraulicPower_kW.toFixed(0)}${derived.hydraulicPowerMax_kW && derived.hydraulicPowerMax_kW - derived.hydraulicPower_kW > 0.5 ? `–${derived.hydraulicPowerMax_kW.toFixed(0)}` : ''} kW${derived.power_kW ? ` (motor ${derived.power_kW} kW)` : ''}` : (derived.power_kW ? `${derived.power_kW} kW` : '—');
  rows.push({ id: 'power', label: 'Hydraulic power p·Q/600', required: pReqStr, available: pw ? `${pw} kW` : '—',
    ok: pw && (derived.hydraulicPower_kW || derived.power_kW) ? pw >= (derived.hydraulicPower_kW || derived.power_kW) : null,
    note: pw && (derived.hydraulicPower_kW || derived.power_kW) && pw < (derived.hydraulicPower_kW || derived.power_kW) ? 'carrier hydraulic power below the machine demand at full flow and pressure' : '' });
  const checked = rows.filter((r) => r.ok !== null);
  return { rows, checked: checked.length, ok: checked.length ? checked.every((r) => r.ok) : null };
}
