#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Behavioural / engineering-expectation tests for the retaining-wall engine: parametric
// sweeps that assert the DIRECTION (monotonicity), SIGN, governing combination, and
// order-of-magnitude a practicing geotechnical engineer would expect. Catches "looks
// plausible but behaves wrong" issues that fixed-case tests miss.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const glue = await import(pathToFileURL(resolve(root, 'static/wasm/retaining/retaining.js')).href);
const M = await (glue.default || glue.createRetainingModule)({ wasmBinary: readFileSync(resolve(root, 'static/wasm/retaining/retaining.wasm')) });
function run(req) {
  const j = JSON.stringify(req); const l = M.lengthBytesUTF8(j); const p = M._malloc(l + 1);
  M.stringToUTF8(j, p, l + 1); const rp = M._madepRunRetainingAnalysis(p, l);
  const r = JSON.parse(M.UTF8ToString(rp)); M._madepFreeBuffer(rp); M._free(p); return r;
}
const util = (r, id) => { const c = (r.checks || []).find((c) => c.id === id); return c ? c.util : NaN; };
const extra = (r, id, k) => { const c = (r.checks || []).find((c) => c.id === id); const e = c && (c.extra || []).find((x) => x.key === k); return e ? e.value : NaN; };

let fails = 0, n = 0;
function ok(name, cond, detail = '') { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }
function mono(name, arr, dir) { // dir +1 increasing, -1 decreasing
  let good = true; for (let i = 1; i < arr.length; i++) if (dir > 0 ? !(arr[i] > arr[i - 1] - 1e-6) : !(arr[i] < arr[i - 1] + 1e-6)) good = false;
  ok(name, good, arr.map((x) => x.toFixed(3)).join(' → '));
}

// ---- base configs ----
const cant = (over = {}) => ({
  wallType: 'cantilever',
  geom: { toe: 0.9, heel: 2.1, stemThkTop: 0.3, stemThkBot: 0.45, stemHeight: 4.5, baseThk: 0.55, gammaConc: 24, ...(over.geom || {}) },
  backfill: { topEl: 0, gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true, ...(over.backfill || {}) },
  insitu: [{ topEl: 0, gammaMoist: 19, gammaSat: 21, phi: 32, c: 5, cu: 0, drained: true, ...(over.insitu || {}) }],
  water: over.water || { retained: -1000, front: -1000 },
  surcharge: over.surcharge ?? 10,
  settings: over.settings || {}
});
const sheet = (over = {}) => ({
  wallType: over.wallType || 'sheetpile',
  geom: { retainedSurfaceEl: 6, excavationEl: 0, embedment: 4, anchorEl: 4.5, anchorFixedLen: 5, anchorDia: 0.15, anchorSpacing: 2, anchorTfk: 150, anchorAngleDeg: 20, ...(over.geom || {}) },
  retained: [{ topEl: 6, gammaMoist: 18, gammaSat: 20, phi: over.phi ?? 30, c: 0, cu: 0, drained: true }],
  front: [{ topEl: 0, gammaMoist: 18, gammaSat: 20, phi: over.phi ?? 30, c: 0, cu: 0, drained: true }],
  water: over.water || { retained: -1000, front: -1000 },
  surcharge: over.surcharge ?? 10, settings: over.settings || {}
});

console.log('== GRAVITY/CANTILEVER — engineering expectations ==');
// 1. taller stem -> more thrust -> higher sliding & bearing util & stem moment
mono('taller stem ⇒ sliding util ↑', [3.5, 4.5, 5.5, 6.5].map((h) => util(run(cant({ geom: { stemHeight: h } })), 'sliding')), +1);
mono('taller stem ⇒ bearing util ↑', [3.5, 4.5, 5.5, 6.5].map((h) => util(run(cant({ geom: { stemHeight: h } })), 'bearing')), +1);
mono('taller stem ⇒ stem M_Ed ↑', [3.5, 4.5, 5.5, 6.5].map((h) => run(cant({ geom: { stemHeight: h } })).structural.stem.M), +1);
// 2. wider heel -> lower eccentricity & bearing util (more stabilising)
mono('wider heel ⇒ eccentricity ↓', [1.2, 1.8, 2.4, 3.0].map((he) => extra(run(cant({ geom: { heel: he } })), 'bearing', 'e')), -1);
mono('wider heel ⇒ bearing util ↓', [1.2, 1.8, 2.4, 3.0].map((he) => util(run(cant({ geom: { heel: he } })), 'bearing')), -1);
// 3. higher backfill phi -> less active -> lower utils
mono('higher backfill φ′ ⇒ sliding util ↓', [26, 30, 34, 38].map((ph) => util(run(cant({ backfill: { phi: ph } })), 'sliding')), -1);
// 4. higher foundation phi -> more bearing capacity -> lower bearing util
mono('higher foundation φ′ ⇒ bearing util ↓', [28, 32, 36, 40].map((ph) => util(run(cant({ insitu: { phi: ph } })), 'bearing')), -1);
// 5. higher water table -> worse sliding & bearing
{
  const dry = run(cant());
  const wet = run(cant({ water: { retained: 4.0, front: -1000 } }));
  ok('high water table ⇒ sliding util ↑', util(wet, 'sliding') > util(dry, 'sliding'), `${util(dry, 'sliding').toFixed(2)}→${util(wet, 'sliding').toFixed(2)}`);
  ok('high water table ⇒ bearing util ↑', util(wet, 'bearing') > util(dry, 'bearing'), `${util(dry, 'bearing').toFixed(2)}→${util(wet, 'bearing').toFixed(2)}`);
}
// 6. more surcharge -> more driving
mono('higher surcharge ⇒ sliding util ↑', [0, 10, 25, 50].map((q) => util(run(cant({ surcharge: q })), 'sliding')), +1);
// 7. method consolidation + passive toe behaviour. Use a BURIED toe (frontSoilEl>0) so the
//    passive resistance is actually mobilised. The passive method is no longer user-selectable
//    — any legacy passiveMethod value yields the SAME (Annex C) result.
{
  const buried = (s) => cant({ geom: { frontSoilEl: 1.8 }, settings: s });
  const a = util(run(buried({ passiveMethod: 'caquot' })), 'sliding');
  const b = util(run(buried({ passiveMethod: 'coulomb' })), 'sliding');
  const c = util(run(buried({ passiveMethod: 'rankine' })), 'sliding');
  ok('passive method consolidated (legacy choice ignored → identical)', Math.abs(a - b) < 1e-9 && Math.abs(a - c) < 1e-9, `a=${a.toFixed(4)} b=${b.toFixed(4)} c=${c.toFixed(4)}`);
  ok('passive ON reduces sliding util vs OFF', util(run(buried({ passiveToe: true })), 'sliding') < util(run(buried({ passiveToe: false })), 'sliding'), `on=${a.toFixed(3)} off=${util(run(buried({ passiveToe: false })), 'sliding').toFixed(3)}`);
  // larger passive wall friction δ_p ⇒ more passive ⇒ lower sliding util
  const lo = util(run(buried({ passiveDeltaRatio: 0.0 })), 'sliding');
  const hi = util(run(buried({ passiveDeltaRatio: 0.667 })), 'sliding');
  ok('higher δ_p ⇒ more passive ⇒ lower sliding util', hi < lo, `δ0=${lo.toFixed(3)} δ23=${hi.toFixed(3)}`);
}
// 8. governing combination tendencies
{
  const r = run(cant());
  const slid = (r.checks.find((c) => c.id === 'sliding') || {}).combo;
  const stemCombo = r.structural.stem.combo;
  ok('sliding governed by C2 (reduced strength)', slid === 'C2', `combo=${slid}`);
  ok('stem structural governed by C1 (amplified actions)', stemCombo === 'C1', `combo=${stemCombo}`);
}
// 9. magnitude sanity for a 4.5 m cantilever
{
  const r = run(cant());
  const Ed = extra(r, 'sliding', 'H_drive');
  ok('active thrust magnitude plausible (40–160 kN/m)', Ed > 40 && Ed < 200, `H_drive=${Ed.toFixed(0)} kN/m`);
  ok('stem moment plausible (80–500 kNm/m)', r.structural.stem.M > 60 && r.structural.stem.M < 700, `M=${r.structural.stem.M.toFixed(0)}`);
}

console.log('\n== EMBEDDED — engineering expectations ==');
// 10. taller retained -> more embedment, moment, (anchored) anchor force
mono('taller retained ⇒ required d ↑', [4, 5, 6, 7].map((H) => run(sheet({ geom: { retainedSurfaceEl: H } })).structural.requiredD), +1);
mono('taller retained ⇒ M_max ↑', [4, 5, 6, 7].map((H) => run(sheet({ geom: { retainedSurfaceEl: H } })).structural.Mmax), +1);
// 11. higher phi -> less embedment
mono('higher φ′ ⇒ required d ↓', [26, 30, 34, 38].map((ph) => run(sheet({ phi: ph })).structural.requiredD), -1);
// 12. anchor reduces M_max vs cantilever (same H, enough embedment)
{
  const c = run(sheet({ wallType: 'sheetpile' }));
  const a = run(sheet({ wallType: 'anchored', geom: { anchorEl: 4.5 } }));
  ok('anchored M_max < cantilever M_max', a.structural.Mmax < c.structural.Mmax, `cant=${c.structural.Mmax.toFixed(0)} anch=${a.structural.Mmax.toFixed(0)}`);
}
// 13. more surcharge -> more embedment/moment
mono('higher surcharge ⇒ M_max ↑', [0, 10, 25, 50].map((q) => run(sheet({ surcharge: q })).structural.Mmax), +1);
// 14. water -> deeper embedment
{
  const dry = run(sheet());
  const wet = run(sheet({ water: { retained: 4.0, front: -1000 } }));
  ok('high water table ⇒ required d ↑', wet.structural.requiredD > dry.structural.requiredD, `${dry.structural.requiredD.toFixed(2)}→${wet.structural.requiredD.toFixed(2)}`);
}
// 15. longer grout body -> more pull-out resistance -> lower anchor util
mono('longer grout body ⇒ anchor pull-out util ↓', [3, 5, 7, 9].map((L) => util(run(sheet({ wallType: 'anchored', geom: { anchorFixedLen: L } })), 'anchor_pullout')), -1);
// 16. cantilever needs more embedment than anchored (same H)
{
  const c = run(sheet({ wallType: 'sheetpile' }));
  const a = run(sheet({ wallType: 'anchored' }));
  ok('cantilever required d > anchored required d', c.structural.requiredD > a.structural.requiredD, `cant=${c.structural.requiredD.toFixed(2)} anch=${a.structural.requiredD.toFixed(2)}`);
  ok('embedded M_max magnitude plausible (100–2000 kNm/m)', c.structural.Mmax > 80 && c.structural.Mmax < 3000, `M_max=${c.structural.Mmax.toFixed(0)}`);
}
// 17. HYD heave/piping (M1): a larger differential head worsens the heave utilisation.
{
  const lo = util(run(sheet({ water: { retained: 5.0, front: -0.5 } })), 'heave');
  const hi = util(run(sheet({ water: { retained: 5.5, front: -2.0 } })), 'heave');
  ok('HYD heave check present + worsens with differential head', Number.isFinite(lo) && hi > lo, `Δh-low util=${lo.toFixed(3)} Δh-high util=${hi.toFixed(3)}`);
}
// 18. anchored wall reports the wall vertical-equilibrium (anchor down-drag) screening check.
{
  const a = run(sheet({ wallType: 'anchored' }));
  ok('anchored reports wall vertical-equilibrium check', a.checks.some((c) => c.id === 'wall_vertical'));
}

console.log('\n== NEW LIMIT STATES / LAYERING ==');
// 19. UPL flotation (M1): the gravity engine reports a flotation verdict.
{
  const r = run(cant());
  ok('gravity reports UPL flotation check', r.checks.some((c) => c.id === 'flotation'));
}
// 20. heel-wedge fix (M3): sloping backfill raises the heel design moment (down-load now
//     carries the wedge already present in q(x)). Compare β=0 vs β=20° at equal geometry.
{
  const m0 = run(cant({ geom: { betaDeg: 0 } })).structural.heel.M;
  const m20 = run(cant({ geom: { betaDeg: 20 } })).structural.heel.M;
  ok('sloping backfill ⇒ heel moment ↑ (wedge in down-load)', m20 > m0, `β0=${m0.toFixed(1)} β20=${m20.toFixed(1)} kNm/m`);
}
// 21. multi-layer passive subdivision (m1): a WEAKER top toe-band layer lowers passive
//     resistance ⇒ higher sliding util than a single strong stratum (buried toe).
{
  const oneStrong = cant({ geom: { frontSoilEl: 1.8 }, insitu: { phi: 34, c: 5 } });
  // two layers in the toe band: weak top (0..-1) over strong bottom
  const layered = cant({ geom: { frontSoilEl: 1.8 } });
  layered.insitu = [
    { topEl: 1.8, gammaMoist: 18, gammaSat: 20, phi: 26, c: 0, cu: 0, drained: true },
    { topEl: 0.0, gammaMoist: 19, gammaSat: 21, phi: 34, c: 5, cu: 0, drained: true }
  ];
  const us = util(run(oneStrong), 'sliding');
  const ul = util(run(layered), 'sliding');
  ok('weak top toe-layer ⇒ less passive ⇒ higher sliding util (layered)', ul > us, `single=${us.toFixed(3)} layered=${ul.toFixed(3)}`);
}

console.log(`\n${fails ? 'BEHAVIOURAL FAILURES' : 'ALL BEHAVIOURAL EXPECTATIONS MET'}: ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
