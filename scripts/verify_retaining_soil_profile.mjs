#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Soil-profile mapping for the retaining-wall app: vertical shift of the CPT stratigraphy relative
// to the wall datum (extend the top layer upward / cut off above the surface), per-layer overrides
// keyed by a stable layer key, and the engine strata format.
import { buildStrata, profileBands, layerKey, setCohesionForAll, pruneOverrides, strataForEngine, resolveLayerParameters } from '../src/lib/cpt-app/retaining/soil-profile.js';

let fails = 0, n = 0;
const ok = (name, cond, detail = '') => { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const layers = [
  { top: 0, bot: 2.0, g: 17, gs: 19, phi: 28, c: 2, cu: 0, avgQc: 3, type: 'Silt' },
  { top: 2.0, bot: 6.0, g: 19, gs: 21, phi: 33, c: 0, cu: 0, avgQc: 12, type: 'Sand' },
  { top: 6.0, bot: 9.0, g: 16, gs: 16, phi: 0, c: 0, cu: 40, avgQc: 0.8, type: 'Clay' }
];

console.log('== no shift ==');
let r = buildStrata({ layers, surfaceEl: 10 });
ok('3 strata', r.strata.length === 3);
ok('top elevations', near(r.strata[0].topEl, 10) && near(r.strata[1].topEl, 8) && near(r.strata[2].topEl, 4));
ok('qc in kPa', r.strata[1].qc === 12000);
ok('clay undrained', r.strata[2].drained === false && r.strata[2].cu === 40);
ok('deepest layer extension note', r.notes.some((t) => /extended downward/.test(t)));

console.log('\n== CPT ground 1.5 m BELOW the surface → top layer extended upward ==');
r = buildStrata({ layers, surfaceEl: 10, offset: -1.5 });
ok('first stratum starts at the surface', near(r.strata[0].topEl, 10));
ok('second stratum shifted down', near(r.strata[1].topEl, 6.5));
ok('extendedTopBy 1.5', near(r.extendedTopBy, 1.5));
ok('note explains the extension', r.notes.some((t) => /extended upward/.test(t)));

console.log('\n== CPT ground 2.5 m ABOVE the surface → first layer cut off entirely, second cut ==');
r = buildStrata({ layers, surfaceEl: 10, offset: 2.5 });
ok('first CPT layer dropped', r.strata.length === 2 && r.strata[0].label === 'Sand');
ok('sand starts at the surface', near(r.strata[0].topEl, 10));
ok('clay top at 10 − (6 − 2.5) = 6.5', near(r.strata[1].topEl, 6.5));
ok('note explains the cut', r.notes.some((t) => /cut off/.test(t)));

console.log('\n== overrides ==');
const key1 = layerKey(layers[1], 1);
let ov = { [key1]: { c: 0.5, phi: 30 } };
r = buildStrata({ layers, surfaceEl: 10, overrides: ov });
ok('override applied to sand', r.strata[1].c === 0.5 && r.strata[1].phi === 30 && r.strata[1].overridden.includes('c'));
ok('silt untouched', r.strata[0].c === 2);
ov = setCohesionForAll(layers, ov, 0.1);
r = buildStrata({ layers, surfaceEl: 10, overrides: ov });
ok('c′ = 0.1 on every layer', r.strata.every((s) => s.c === 0.1));
ok('other override kept', r.strata[1].phi === 30);
const pruned = pruneOverrides(layers.slice(0, 2), ov);
ok('prune drops the clay key', Object.keys(pruned).length === 2);
const res = resolveLayerParameters(layers[2], 2, { [layerKey(layers[2], 2)]: { drained: true, phi: 22 } });
ok('drainage framework override', res.params.drained === true && res.params.phi === 22 && res.overridden.includes('drained'));

console.log('\n== engine format and bands ==');
const eng = strataForEngine(r.strata);
ok('engine strata keys', eng.every((s) => ['topEl', 'gammaMoist', 'gammaSat', 'phi', 'c', 'cu', 'drained', 'qc'].every((k) => k in s)) && !('label' in eng[0]));
const bands = profileBands({ layers, surfaceEl: 10, offset: -1.5, minEl: -5, clipTopEl: 9 });
ok('bands clipped at clipTopEl', near(bands[0].topEl, 9));
ok('last band clipped at minEl', near(bands[bands.length - 1].botEl, -5));

console.log('\n== fallback single material ==');
r = buildStrata({ layers: [], surfaceEl: 3, fallback: { gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true } });
ok('single stratum', r.strata.length === 1 && r.strata[0].phi === 32 && r.notes.length === 1);

console.log(`\n${fails ? 'FAILED' : 'PASSED'}: ${n - fails}/${n}`);
process.exit(fails ? 1 : 0);
