// SPDX-License-Identifier: AGPL-3.0-or-later
// Verification of the data-sheet → model translation (vibrator-datasheet.js) and the drive-to-refusal
// outcome of the vibratory runner. Fixture: SAES HST070 RM-DFS-CW40 hydraulic compactor sheet
// (TI/HST/131003/RW): machine class 22–37 t, 205 kN, amplitude 12.0 mm, 66 kW, 2400–2900 rpm,
// oil flow 175–215 [215] l/min, working pressure 200–225 [230] bar, return 10 bar, mass 965 kg.
import { vibratorFromDatasheet, carrierCheck } from '../src/lib/cpt-app/retaining/drivability/vibrator-datasheet.js';
import { runVibratoryDrivability } from '../src/lib/cpt-app/retaining/drivability/vibratory-drivability.js';
import { buildDrivingResistanceProfile } from '../src/lib/cpt-app/retaining/drivability/srd-from-cpt.js';
import { drivabilityMarker } from '../src/lib/cpt-app/retaining/drivability/drivability-outcome.js';

let pass = 0, fail = 0;
const ok = (name, c) => { if (c) { pass++; console.log('OK  ', name); } else { fail++; console.log('FAIL', name); } };
const near = (name, got, want, rel = 1e-3, abs = 0) => { const d = Math.abs(got - want); const tol = Math.max(abs, rel * Math.abs(want)); ok(`${name}: got=${Number(got).toPrecision(6)} want=${want}`, d <= tol); };

// --- SAES HST070 sheet -----------------------------------------------------------------------
const hst070 = { name: 'SAES HST070 RM-DFS-CW40', force_kN: 205, rpmMax: 2900, rpmMin: 2400, amplitude_mm: 12.0, amplitudeConvention: 'pp', totalMass_kg: 965,
  flow_lmin: 175, flowMax_lmin: 215, pressure_bar: 200, pressureMax_bar: 230, power_kW: 66, carrierMin_t: 22, carrierMax_t: 37 };
const d = vibratorFromDatasheet(hst070);
ok('sheet translates', d.ok);
const wMax = 2 * Math.PI * 2900 / 60;
near('M_e = 1000·F/ω² at 2900 rpm', d.eccentricMoment_kgm, 1000 * 205 / (wMax * wMax));          // 2.2228 kg·m
near('M_e ≈ 2.223 kg·m', d.eccentricMoment_kgm, 2.2228, 1e-3);
ok('M_e provenance = from-force', d.eccentricMomentSource === 'from-force');
near('F_c at 2900 rpm reproduces the sheet', d.forceMax_kN, 205, 1e-9);
near('F_c at 2400 rpm = 205·(2400/2900)²', d.forceMin_kN, 205 * (2400 / 2900) ** 2, 1e-9);        // 140.4 kN
near('operating = max rpm by default', d.rpmOperating, 2900, 0);
near('M_dyn from 12.0 mm peak-to-peak = 2000·M_e/A', d.dynamicMass_kg, 2000 * d.eccentricMoment_kgm / 12.0, 1e-9); // 370.5 kg
ok('M_dyn provenance = from-amplitude', d.dynamicMassSource === 'from-amplitude');
near('isolated mass = 965 − M_dyn', d.suppressorMass_kg, 965 - d.dynamicMass_kg, 1e-9);
near('static extra = isolated mass · g', d.staticExtra_kN, (965 - d.dynamicMass_kg) * 9.81 / 1000, 1e-9);
near('hydraulic power at the working point = 200·175/600', d.hydraulicPower_kW, 200 * 175 / 600, 1e-9);   // 58.3 kW
near('hydraulic power at the sheet maxima = 230·215/600', d.hydraulicPowerMax_kW, 230 * 215 / 600, 1e-9); // 82.4 kW
ok('no inconsistency notes for a consistent sheet', d.notes.length === 0);

// single-amplitude convention halves the derived mass
const dS = vibratorFromDatasheet({ ...hst070, amplitudeConvention: 'single' });
near('single amplitude ⇒ M_dyn = 1000·M_e/A', dS.dynamicMass_kg, 1000 * d.eccentricMoment_kgm / 12.0, 1e-9);
// operating rpm reduces the force quadratically
const dOp = vibratorFromDatasheet({ ...hst070, rpmOperating: 2600 });
near('F_c at 2600 rpm', dOp.forceAtOperating_kN, 205 * (2600 / 2900) ** 2, 1e-9);
// stated moment wins, inconsistency flagged
const dM = vibratorFromDatasheet({ ...hst070, eccentricMoment_kgm: 3.0 });
ok('stated moment used and flagged (3.0 vs 2.22 kg·m)', dM.eccentricMoment_kgm === 3.0 && dM.eccentricMomentSource === 'stated' && dM.notes.some((n) => /inconsistency/.test(n)));
// stated dynamic mass wins; amplitude check note
const dD = vibratorFromDatasheet({ ...hst070, dynamicMass_kg: 600 });
ok('stated vibrating mass used; amplitude mismatch noted', dD.dynamicMass_kg === 600 && dD.dynamicMassSource === 'stated' && dD.notes.some((n) => /Amplitude check/.test(n)));
// ICE 28RF convention check (peak-to-peak): 28 kg·m / 3900 kg → 14.4 mm; with 200TU clamp 5400 kg → 10.4 mm
const ice = vibratorFromDatasheet({ eccentricMoment_kgm: 28, rpmMax: 2300, force_kN: 1600, amplitude_mm: 10.4, amplitudeConvention: 'pp', dynamicMass_kg: 5400, totalMass_kg: 5900 });
near('ICE 28RF free p-p amplitude with clamp = 2·28/5400', ice.amplitudeFree_pp_mm, 2000 * 28 / 5400, 1e-9);
ok('ICE 28RF: force consistent with 28 kg·m at 2300 rpm (no note)', !ice.notes.some((n) => /inconsistency/.test(n)));
// missing data
ok('missing rpm ⇒ not ok', !vibratorFromDatasheet({ force_kN: 205 }).ok);
ok('missing force and moment ⇒ not ok', !vibratorFromDatasheet({ rpmMax: 2900 }).ok);
ok('missing mass and amplitude ⇒ not ok with note', (() => { const r = vibratorFromDatasheet({ force_kN: 205, rpmMax: 2900 }); return !r.ok && r.notes.some((n) => /vibrating mass/.test(n)); })());

// --- carrier check ---------------------------------------------------------------------------
const c1 = carrierCheck(d, { mass_t: 30, flow_lmin: 200, pressure_bar: 220, power_kW: 90 });
ok('carrier 30 t / 200 l/min / 220 bar / 90 kW ⇒ all ok', c1.ok === true && c1.rows.every((r) => r.ok === true));
const c2 = carrierCheck(d, { mass_t: 18, flow_lmin: 150, pressure_bar: 250 });
ok('carrier 18 t ⇒ class fails', c2.rows.find((r) => r.id === 'class').ok === false);
ok('150 l/min ⇒ flow fails', c2.rows.find((r) => r.id === 'flow').ok === false);
ok('250 bar ⇒ pressure ok but relief note', c2.rows.find((r) => r.id === 'pressure').ok === true && /relief/.test(c2.rows.find((r) => r.id === 'pressure').note));
ok('power not given ⇒ null, overall false', c2.rows.find((r) => r.id === 'power').ok === null && c2.ok === false);
ok('nothing given ⇒ nothing checked (null)', carrierCheck(d, {}).ok === null);

// --- drive-to-refusal outcome ------------------------------------------------------------------
// uniform sand q_c 10 MPa, f_s 50 kPa to 8 m: HEA 180 pile (A = 45.3 cm², perimeter ≈ 1.06 m unplugged)
const n = 81, depth = Array.from({ length: n }, (_, i) => i * 0.1);
const prof = buildDrivingResistanceProfile({ cpt: { depth, qc: depth.map(() => 10), fs: depth.map(() => 50) }, pile: { toeArea_m2: 0.00453, shaftPerimeter_m: 1.06, steelArea_m2: 0.00453 }, method: 'reference', options: { dz: 0.1 } });
ok('profile ok', prof.ok);
const pileMass = 35.5 * 8.5;
const vibr = { frequency_Hz: d.frequency_Hz, dynamicMass_kg: d.dynamicMass_kg + pileMass, crowd_kN: d.staticExtra_kN, lineForce_kN: 0, centrifugalForce_kN: d.forceAtOperating_kN };
const r = runVibratoryDrivability({ profile: prof, vibrator: vibr, options: { lambda: 6, targetDepth_m: 8 } });
ok('run ok with candidate', r.ok && r.candidateCheck);
const c = r.candidateCheck;
ok('per-depth candidate margins present', r.perDepth.every((p) => Number.isFinite(p.Gcand_kN) && Number.isFinite(p.Gcand125_kN)));
ok('margins decrease with depth in uniform soil', r.perDepth[0].Gcand_kN > r.perDepth[r.perDepth.length - 1].Gcand_kN);
ok('target depth recorded', c.targetDepth_m === 8);
if (c.reachesTarget) {
  ok('reaches target ⇒ no refusal depth, achievable = target', c.refusalDepth_m === null && c.achievableDepth_m === 8);
} else {
  ok('refusal ⇒ achievable is the last open depth (0.1 m above)', Math.abs(c.refusalDepth_m - c.achievableDepth_m - 0.1) < 1e-9);
  ok('margin negative at the refusal depth, non-negative above', r.perDepth.find((p) => Math.abs(p.z - c.refusalDepth_m) < 1e-9).Gcand_kN < 0 && r.perDepth.find((p) => Math.abs(p.z - c.achievableDepth_m) < 1e-9).Gcand_kN >= 0);
}
ok('1.25 refusal is never deeper than the 1.0 refusal', (c.refusalDepth125_m ?? 99) <= (c.refusalDepth_m ?? 99));
// a much stronger machine reaches the target
const big = runVibratoryDrivability({ profile: prof, vibrator: { ...vibr, centrifugalForce_kN: 5000 }, options: { lambda: 6, targetDepth_m: 8 } });
ok('5000 kN machine reaches 8 m with reserve', big.candidateCheck.reachesTarget && big.candidateCheck.reachesTarget125 && big.candidateCheck.marginAtTarget_kN > 0);
// a very weak machine refuses immediately below the first metre
const weak = runVibratoryDrivability({ profile: prof, vibrator: { ...vibr, centrifugalForce_kN: 5, dynamicMass_kg: 400, crowd_kN: 0 }, options: { lambda: 6, targetDepth_m: 8 } });
ok('5 kN machine refuses early', !weak.candidateCheck.reachesTarget && weak.candidateCheck.refusalDepth_m < 3);
ok('refusal note text', weak.notes.some((t) => /refusal predicted at/.test(t)));
// outcome marker
const rwFake = { drivability: { result: { ok: true, target: 8, machineLabel: 'X', vibratory: weak } } };
const mk = drivabilityMarker(rwFake);
ok('marker: refusal ⇒ bad level at the refusal depth', mk && mk.level === 'bad' && mk.z === weak.candidateCheck.refusalDepth_m && /refusal/.test(mk.label));
const mkBig = drivabilityMarker({ drivability: { result: { ok: true, target: 8, machineLabel: 'X', vibratory: big } } });
ok('marker: reaches ⇒ ok level at the target', mkBig && mkBig.level === 'ok' && mkBig.z === 8);
ok('marker: impact refusal', (() => { const m = drivabilityMarker({ drivability: { result: { ok: true, target: 8, impact: { refusalDepth_m: 5.5 } } } }); return m.level === 'bad' && m.z === 5.5; })());
ok('marker: no result ⇒ null', drivabilityMarker({ drivability: { result: null } }) === null);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
