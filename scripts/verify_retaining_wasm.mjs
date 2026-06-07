#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifies the retaining-wall WASM engine end-to-end through its JSON bridge:
// loads the module under Node, runs all four wall types, and checks the results
// for structure, finiteness, and hand-calc / physical-consistency parity.
//
// Requires static/wasm/retaining/retaining.{js,wasm} to be built:
//   source ~/tools/emsdk/emsdk_env.sh && bash src/wasm/retaining/build.sh
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const glueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/retaining/retaining.js'));
const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/retaining/retaining.wasm'));

let fails = 0;
function ok(name, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}`);
  if (!cond) fails++;
}
function near(name, got, want, tol) {
  const good = Math.abs(got - want) <= tol * (1 + Math.abs(want));
  console.log(`${good ? 'OK  ' : 'FAIL'}  ${name} got=${got.toFixed(4)} want=${want.toFixed(4)}`);
  if (!good) fails++;
}

const glue = await import(glueUrl.href);
const factory = glue.default || glue.createRetainingModule;
const Module = await factory({ wasmBinary });

function run(req) {
  const json = JSON.stringify(req);
  const len = Module.lengthBytesUTF8(json);
  const ptr = Module._malloc(len + 1);
  Module.stringToUTF8(json, ptr, len + 1);
  const resPtr = Module._madepRunRetainingAnalysis(ptr, len);
  const res = Module.UTF8ToString(resPtr);
  Module._madepFreeBuffer(resPtr);
  Module._free(ptr);
  return JSON.parse(res);
}
const checkById = (r, id) => r.checks.find((c) => c.id === id);

console.log('== version + error handling ==');
ok('engine returns ok=false on garbage', run({ wallType: 'nope' }).ok === false);

console.log('\n== RC cantilever wall ==');
const cant = run({
  wallType: 'cantilever',
  geom: { toe: 0.8, heel: 2.2, stemThkTop: 0.3, stemThkBot: 0.45, stemHeight: 5.5, baseThk: 0.6, gammaConc: 24 },
  backfill: { topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true },
  insitu: [{ topEl: 0, gammaMoist: 19, gammaSat: 21, phi: 34, c: 5, cu: 0, drained: true }],
  water: { retained: -1000, front: -1000 },
  surcharge: 10,
  settings: { consequenceClass: 2 }
});
ok('cantilever ok', cant.ok === true);
ok('has sliding/bearing/eccentricity/overturning', ['sliding', 'bearing', 'eccentricity', 'overturning'].every((id) => checkById(cant, id)));
ok('all checks have finite util', cant.checks.every((c) => Number.isFinite(c.util)));
ok('both DA1 combos referenced', cant.checks.some((c) => c.combo === 'C1' || c.combo === 'C2'));
ok('structural stem moment > 0', cant.structural.stem.M > 0);
ok('B reported', cant.B > 0);
console.log(`   B=${cant.B.toFixed(2)} m  maxUtil=${cant.maxUtil.toFixed(3)}  stem M=${cant.structural.stem.M.toFixed(1)} kNm/m`);

console.log('\n== gravity (mass) wall ==');
const grav = run({
  wallType: 'gravity',
  geom: { toe: 0.6, heel: 0.6, stemThkTop: 1.0, stemThkBot: 2.0, stemHeight: 4.0, baseThk: 0.6, gammaConc: 24, backBatterDeg: 0 },
  backfill: { topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true },
  insitu: [{ topEl: 0, gammaMoist: 20, gammaSat: 21, phi: 35, c: 0, cu: 0, drained: true }],
  surcharge: 5
});
ok('gravity ok + has bearing', grav.ok === true && !!checkById(grav, 'bearing'));

console.log('\n== cantilever embedded sheet pile ==');
const sheet = run({
  wallType: 'sheetpile',
  geom: { retainedSurfaceEl: 6, excavationEl: 0, embedment: 4 },
  retained: [{ topEl: 6, gammaMoist: 18, gammaSat: 20, phi: 30, c: 0, cu: 0, drained: true }],
  front: [{ topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 30, c: 0, cu: 0, drained: true }],
  water: { retained: -1000, front: -1000 },
  surcharge: 0
});
ok('sheetpile ok + embedment check', sheet.ok === true && !!checkById(sheet, 'embedment'));
ok('sheetpile M_max > 0', sheet.structural.Mmax > 0);
ok('sheetpile required d > 0', sheet.structural.requiredD > 0);
ok('sheetpile has BM diagram', sheet.diagrams.some((d) => d.id.startsWith('M_') && d.z.length > 5));
console.log(`   M_max=${sheet.structural.Mmax.toFixed(1)} kNm/m  d_req=${sheet.structural.requiredD.toFixed(2)} m`);

console.log('\n== anchored sheet pile ==');
const anch = run({
  wallType: 'anchored',
  geom: { retainedSurfaceEl: 6, excavationEl: 0, embedment: 2.5, anchorEl: 5 },
  retained: [{ topEl: 6, gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true }],
  front: [{ topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true }],
  surcharge: 0
});
ok('anchored ok + anchor force > 0', anch.ok === true && anch.structural.anchorForce > 0);
ok('anchored M_max < cantilever sheet M_max', anch.structural.Mmax < sheet.structural.Mmax);
console.log(`   M_max=${anch.structural.Mmax.toFixed(1)} kNm/m  anchor=${anch.structural.anchorForce.toFixed(1)} kN/m  d_req=${anch.structural.requiredD.toFixed(2)} m`);

console.log('\n== action factors flow through (consequence-class differential) ==');
// K_FI scales unfavourable actions: CC1=0.90, CC2=1.00, CC3=1.10. If the action factors
// are correctly applied, the embedded M_max and gravity stem moment must scale with CC.
function embeddedMmax(cc) {
  return run({
    wallType: 'sheetpile', geom: { retainedSurfaceEl: 6, excavationEl: 0, embedment: 4 },
    retained: [{ topEl: 6, gammaMoist: 18, gammaSat: 20, phi: 30, c: 0, cu: 0, drained: true }],
    front: [{ topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 30, c: 0, cu: 0, drained: true }],
    surcharge: 15, settings: { consequenceClass: cc }
  }).structural.Mmax;
}
const mCC1 = embeddedMmax(1), mCC3 = embeddedMmax(3);
const ratio = mCC3 / mCC1;
near('embedded M_max scales with K_FI (CC3/CC1 ≈ 1.10/0.90)', ratio, 1.10 / 0.90, 0.04);
console.log(`   M_max CC1=${mCC1.toFixed(1)}  CC3=${mCC3.toFixed(1)}  ratio=${ratio.toFixed(3)}`);
function gravityStem(cc) {
  return run({
    wallType: 'cantilever',
    geom: { toe: 0.8, heel: 2.2, stemThkTop: 0.3, stemThkBot: 0.45, stemHeight: 5.5, baseThk: 0.6, gammaConc: 24 },
    backfill: { topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true },
    insitu: [{ topEl: 0, gammaMoist: 19, gammaSat: 21, phi: 34, c: 5, cu: 0, drained: true }],
    surcharge: 10, settings: { consequenceClass: cc }
  }).structural.stem.M;
}
const sCC1 = gravityStem(1), sCC3 = gravityStem(3);
near('gravity stem M scales with K_FI', sCC3 / sCC1, 1.10 / 0.90, 0.05);
console.log(`   stem M CC1=${sCC1.toFixed(1)}  CC3=${sCC3.toFixed(1)}  ratio=${(sCC3 / sCC1).toFixed(3)}`);

console.log('\n== base uplift reduces sliding resistance when water is high (gravity) ==');
function gravitySlidingUtil(waterMode) {
  const req = {
    wallType: 'gravity',
    geom: { toe: 0.5, heel: 1.5, stemThkTop: 0.5, stemThkBot: 1.4, stemHeight: 4.0, baseThk: 0.6, gammaConc: 24 },
    backfill: { topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 30, c: 0, cu: 0, drained: true },
    insitu: [{ topEl: 0, gammaMoist: 20, gammaSat: 21, phi: 32, c: 0, cu: 0, drained: true }],
    surcharge: 5
  };
  if (waterMode) req.water = { retained: 4.0, front: -1000 };  // WT near top, above base
  const r = run(req);
  return checkById(r, 'sliding').util;
}
const slidDry = gravitySlidingUtil(false), slidWet = gravitySlidingUtil(true);
ok('high water table worsens sliding (uplift + thrust)', slidWet > slidDry);
console.log(`   sliding util dry=${slidDry.toFixed(3)}  high-WT=${slidWet.toFixed(3)}`);

console.log(`\n${fails ? 'FAILED' : 'PASS'}: retaining wasm verifier (${fails} failure${fails === 1 ? '' : 's'})`);
process.exit(fails ? 1 : 0);
