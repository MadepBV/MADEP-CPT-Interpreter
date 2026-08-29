// SPDX-License-Identifier: AGPL-3.0-or-later
// Verification of the static push-in model (push-in.js): analytic refusal depth in uniform soil,
// required-force monotonicity, self-weight effect, reserve ordering, and the outcome marker.
import { buildDrivingResistanceProfile } from '../src/lib/cpt-app/retaining/drivability/srd-from-cpt.js';
import { runPushIn } from '../src/lib/cpt-app/retaining/drivability/push-in.js';
import { drivabilityMarker } from '../src/lib/cpt-app/retaining/drivability/drivability-outcome.js';

let pass = 0, fail = 0;
const ok = (name, c) => { if (c) { pass++; console.log('OK  ', name); } else { fail++; console.log('FAIL', name); } };
const near = (name, got, want, rel = 1e-6, abs = 0) => { const d = Math.abs(got - want); ok(`${name}: got=${Number(got).toPrecision(6)} want=${want}`, d <= Math.max(abs, rel * Math.abs(want))); };

// Uniform sand q_c = 10 MPa, f_s = 50 kPa to 10 m; unplugged HEA 180 (A = 45.3 cm², perimeter 1.06 m, 35.5 kg/m)
const depth = Array.from({ length: 101 }, (_, i) => i * 0.1);
const prof = buildDrivingResistanceProfile({ cpt: { depth, qc: depth.map(() => 10), fs: depth.map(() => 50) }, pile: { toeArea_m2: 0.00453, shaftPerimeter_m: 1.06, steelArea_m2: 0.00453 }, method: 'reference', options: { dz: 0.1 } });
ok('profile ok', prof.ok);
const perim = 1.06, tau = 50, qA = 10000 * 0.00453;      // R_static(z) = τ·P·z + q_c·A = 53·z + 45.3 kN
const w = 35.5 * 9.81 / 1000;                            // 0.348 kN/m
const F = 200;
// analytic refusal: F + w z = 53 z + 45.3 → z* = (F − 45.3)/(53 − w)
const zStar = (F - qA) / (tau * perim - w);
const r = runPushIn({ profile: prof, force_kN: F, massPerM_kg: 35.5, options: { targetDepth_m: 8 } });
ok('run ok', r.ok && r.perDepth.length === 80);
near('R_static at 8 m = 53·8 + 45.3', r.perDepth[79].Rstatic_kN, tau * perim * 8 + qA, 1e-9);
ok('refusal at the first 0.1 m step beyond z*', r.refusalDepth_m != null && r.refusalDepth_m > zStar && r.refusalDepth_m - zStar <= 0.1 + 1e-9);
ok('achievable = refusal − 0.1', Math.abs(r.refusalDepth_m - r.achievableDepth_m - 0.1) < 1e-9);
near('required force for 8 m = 53·8 + 45.3 − w·8', r.requiredForce_kN, tau * perim * 8 + qA - w * 8, 1e-9);
near('required with 1.25 reserve', r.requiredForce125_kN, 1.25 * (tau * perim * 8 + qA) - w * 8, 1e-9);
ok('governing depth is the target in uniform soil', Math.abs(r.governingDepth_m - 8) < 1e-9);
ok('1.25 refusal is shallower than or equal to the 1.0 refusal', (r.refusalDepth125_m ?? 99) <= r.refusalDepth_m);
ok('margins decrease with depth', r.perDepth[0].G_kN > r.perDepth[79].G_kN);
// enough force reaches the target with reserve
const big = runPushIn({ profile: prof, force_kN: 1000, massPerM_kg: 35.5, options: { targetDepth_m: 8 } });
ok('1000 kN reaches 8 m with reserve', big.reachesTarget && big.reachesTarget125 && big.marginAtTarget125_kN > 0);
// self-weight: ignoring it makes the refusal shallower (or equal)
const noW = runPushIn({ profile: prof, force_kN: F, massPerM_kg: 0, options: { targetDepth_m: 8 } });
ok('without self-weight refusal is not deeper', noW.refusalDepth_m <= r.refusalDepth_m && noW.perDepth.every((p) => p.W_kN === 0));
// zero force: refuses at the first step (toe resistance alone exceeds the weight)
const zero = runPushIn({ profile: prof, force_kN: 0, massPerM_kg: 35.5, options: { targetDepth_m: 8 } });
ok('0 kN refuses immediately', !zero.reachesTarget && zero.refusalDepth_m === prof.z[0] && zero.achievableDepth_m === 0);
// guards
ok('negative force ⇒ not ok', !runPushIn({ profile: prof, force_kN: -5 }).ok);
ok('missing profile ⇒ not ok', !runPushIn({ profile: null, force_kN: 100 }).ok);
// outcome marker
const mk = drivabilityMarker({ drivability: { result: { ok: true, target: 8, push: r } } });
ok('marker: refusal ⇒ bad at the refusal depth with the force in the label', mk && mk.level === 'bad' && mk.z === r.refusalDepth_m && /200 kN/.test(mk.label));
const mkOk = drivabilityMarker({ drivability: { result: { ok: true, target: 8, push: big } } });
ok('marker: reaches ⇒ ok at the target', mkOk && mkOk.level === 'ok' && mkOk.z === 8);
ok('notes mention the refusal depth', r.notes.some((n) => /refusal predicted at/.test(n)));

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
