#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// State → request → engine (JS → WASM) integration: the app state of the course-manual §6 example
// and of the Rekennota HEA180 wall must reproduce the hand-calculation results through the very
// same path the UI uses (request-builder.js + soil-profile.js + the wasm engine).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, ensure } from '../src/lib/cpt-app/retaining/wall-state.js';
import { buildRequest } from '../src/lib/cpt-app/retaining/request-builder.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const glue = await import(pathToFileURL(resolve(root, 'static/wasm/retaining/retaining.js')).href);
const M = await (glue.default || glue.createRetainingModule)({ wasmBinary: readFileSync(resolve(root, 'static/wasm/retaining/retaining.wasm')) });
function run(req) {
  const j = JSON.stringify(req); const l = M.lengthBytesUTF8(j); const p = M._malloc(l + 1);
  M.stringToUTF8(j, p, l + 1); const rp = M._madepRunRetainingAnalysis(p, l);
  const r = JSON.parse(M.UTF8ToString(rp)); M._madepFreeBuffer(rp); M._free(p); return r;
}
let fails = 0, n = 0;
const ok = (name, cond, detail = '') => { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; };
const near = (name, got, want, tol) => { const good = Math.abs(got - want) <= tol * (1 + Math.abs(want)); ok(name, good, `got=${Number(got).toPrecision(6)} want=${want}`); };
const branch = (r, id) => r.branches.find((b) => b.id === id);

console.log('== state migration ==');
const st = { retwall: { wallType: 'sheetpile', embedded: { retainedHeight: 6 }, settings: { minSurcharge: 10 } } };
const rw = ensure(st);
ok('defaults filled', rw.soldier.sectionId === 'HEA180' && rw.settings.riskScheme === 2 && rw.profile.offset === 0);
ok('user values kept', rw.embedded.retainedHeight === 6 && rw.wallType === 'sheetpile');

console.log('\n== course §6 through the app state (anchored sheet pile) ==');
const a = defaults();
a.wallType = 'anchored';
a.embedded.retainedHeight = 6.0; a.embedded.embedment = 3.60; a.embedded.anchorDepth = 1.2; a.embedded.anchorAngle = 15; a.embedded.anchorSpacing = 2;
a.insitu = { ...a.insitu, mode: 'single', gammaMoist: 18, gammaSat: 18, phi: 30, c: 0, cu: 0, drained: true };
a.surcharge = 10; a.settings.surchargeFloor = 0; a.settings.deltaPassiveSheet = 0; a.settings.da11Mode = 'single-source';
const { request } = buildRequest(a, []);
ok('request wallType anchored', request.wallType === 'anchored' && request.geom.anchored === true);
ok('request has explicit floor / scheme / rule', request.settings.surchargeFloor === 0 && request.settings.riskScheme === 2 && request.settings.overdigRule === 'belgian');
const r = run(request);
ok('engine ok', r.ok === true && r.engine === 'v2');
near('DA1/2 D', branch(r, 'DA1-2').d0, 3.56806, 3e-4); near('DA1/2 T', branch(r, 'DA1-2').T, 122.921, 3e-4); near('DA1/2 M', branch(r, 'DA1-2').Mmax, 258.23, 3e-3);
near('BGT ×1.35 M', branch(r, 'BGT').MEd, 197.458, 4e-3); near('SLS D', branch(r, 'SLS').d0, 2.4362, 3e-4);
near('anchor axial', r.structural.anchorAxial, 254.5, 3e-3);
ok('embedment check passes at provided = required', r.checks[0].id === 'embedment' && r.checks[0].pass);

console.log('\n== Rekennota HEA180 through the app state (soldier pile, CPT layer with override c′ = 0) ==');
const b = defaults();
b.wallType = 'soldierpile';
b.embedded.retainedHeight = 1.616; b.embedded.embedment = 4.484;
b.soldier.sectionId = 'HEA180'; b.soldier.spacing = 1.0; b.soldier.resistanceModel = 'effective-width'; b.soldier.effectiveWidthFactor = 3;
b.loads.berm = { enabled: true, height: 1.577, slopeDeg: 45 };
b.surcharge = 0; b.settings.surchargeFloor = 0; b.settings.overdigRule = 'custom'; b.settings.overdigCustom = 0.30;
b.settings.materialOverride = { enabled: true, gPhi: 1.30, gC: 1.30, gCu: 1.40, applyToDA12: true };
b.settings.assumeCrackWater = false;
// CPT layer model: one loam layer with c′ = 4 (table value) overridden to 0 for the hand calc, φ′ 25, γ 19.5
const layers = [{ top: 0, bot: 12, g: 19.5, gs: 19.5, phi: 25, c: 4, cu: 50, avgQc: 3, type: 'Leem' }];
b.profile.offset = 0;
b.profile.overrides = { '0:0.00-12.00:Leem': { c: 0 } };
const built = buildRequest(b, layers);
ok('section resolved (b = 0.18)', built.section && Math.abs(built.section.b - 0.18) < 1e-9 && built.request.geom.pileWidth === 0.18);
ok('override applied', built.request.retained[0].c === 0 && built.profile.strata[0].overridden.includes('c'));
ok('berm passed with γ of the top layer', built.request.loads.berm.height === 1.577 && built.request.loads.berm.gamma === 19.5);
const r2 = run(built.request);
ok('engine ok / per pile', r2.ok === true && r2.perPile === true && r2.resistanceModel === 'effective-width');
near('t0 (SF 1.30)', branch(r2, 'DA1-2').d0, 3.5393, 3e-3); near('D_req', branch(r2, 'DA1-2').dDesign, 4.247, 3e-3);
near('DA1/1 M_Ed per pile', branch(r2, 'DA1-1').MEd, 57.64, 1.5e-2); near('lagging p_Ed', r2.structural.laggingPressure, 30.39, 3e-3);
ok('T_lat tables (char/design/sensitivity)', r2.tlat.length === 3 && r2.tlat[0].rows.length > 5);
ok('UC embedment < 1', r2.checks[0].util < 1 && r2.checks[0].pass);

console.log('\n== profile shift through the request ==');
const c = defaults(); c.wallType = 'sheetpile'; c.embedded.retainedHeight = 4; c.profile.offset = -1.0;
const lay2 = [{ top: 0, bot: 3, g: 17, gs: 19, phi: 28, c: 0, cu: 0, avgQc: 2, type: 'Silt' }, { top: 3, bot: 20, g: 19, gs: 21, phi: 33, c: 0, cu: 0, avgQc: 12, type: 'Sand' }];
const rc = buildRequest(c, lay2);
ok('top layer extended to the retained surface', rc.request.retained[0].topEl === 4 && Math.abs(rc.request.retained[1].topEl - 0) < 1e-9);
ok('note tells the engineer', rc.profile.notes.some((t) => /extended upward/.test(t)));

console.log(`\n${fails ? 'FAILED' : 'PASSED'}: ${n - fails}/${n}`);
process.exit(fails ? 1 : 0);
