#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifies src/lib/cpt-app/retaining/vibration/attenuation-calibration.js against the course
// chapter §15.5 two-point example and the §15.6–15.7 regression / upper-prediction expressions.
import { calibrateTwoPoint, calibrateLeastSquares, upperPrediction, predictFromFit } from '../src/lib/cpt-app/retaining/vibration/attenuation-calibration.js';

let fails = 0, n = 0;
function ok(name, cond, detail = '') { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }
const close = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('== Two-point calibration (course §15.5) ==');
{
  const f = calibrateTwoPoint({ x1_m: 10, v1_mm_s: 5.0, x2_m: 20, v2_mm_s: 2.0 });
  ok('n = ln(5/2)/ln(2) = 1.3219', close(f.n, 1.3219, 0.0001), f.n.toFixed(4));
  ok('K = 5·10^1.3219 = 104.93', close(f.K, 104.93, 0.01), f.K.toFixed(2));
  ok('v(30) = 1.17 mm/s', close(predictFromFit(f, 30), 1.17, 0.005), predictFromFit(f, 30).toFixed(3));
  ok('fit reproduces both points', close(predictFromFit(f, 10), 5, 1e-9) && close(predictFromFit(f, 20), 2, 1e-9));
  ok('note: two points give no residual', f.notes.some((s) => /no residual/.test(s)));
  ok('invalid input → NaN + note, no throw', Number.isNaN(calibrateTwoPoint({ x1_m: 10, v1_mm_s: 5, x2_m: 10, v2_mm_s: 2 }).n));
  const inc = calibrateTwoPoint({ x1_m: 10, v1_mm_s: 2, x2_m: 20, v2_mm_s: 5 });
  ok('increasing PPV with distance → n < 0 flagged', inc.n < 0 && inc.notes.some((s) => /n ≤ 0/.test(s)));
}

console.log('== Least-squares log-log regression (course §15.6) ==');
{
  const K = 104.93, nn = 1.3219;
  const exact = [5, 10, 20, 40].map((x) => ({ x_m: x, v_mm_s: K * Math.pow(x, -nn) }));
  const f = calibrateLeastSquares({ points: exact });
  ok('exact power-law data recovered: n', close(f.n, nn, 1e-9), f.n.toFixed(5));
  ok('exact power-law data recovered: K', close(f.K, K, 1e-6), f.K.toFixed(3));
  ok('s = 0, r² = 1 for exact data', close(f.s, 0, 1e-9) && close(f.r2, 1, 1e-12));
  ok('N = 4 → small-sample caveat', f.N === 4 && f.notes.some((s) => /Small sample/.test(s)));
  ok('t-factor for ν = 2 is 2.920', close(f.tFactor, 2.92, 1e-9));

  // Noisy data (residuals ±0.1 in ln v around the same law): fit must stay close, s ≈ 0.1
  const noisy = [[5, +0.1], [10, -0.1], [20, +0.1], [40, -0.1], [60, +0.1], [80, -0.1]].map(([x, e]) => ({ x_m: x, v_mm_s: Math.exp(Math.log(K) - nn * Math.log(x) + e) }));
  const g = calibrateLeastSquares({ points: noisy });
  ok('noisy data: n within 0.1 of 1.32', close(g.n, nn, 0.1), g.n.toFixed(3));
  ok('noisy data: s ≈ 0.1', g.s > 0.07 && g.s < 0.14, g.s.toFixed(3));
  ok('N = 6 → no small-sample caveat', g.N === 6 && !g.notes.some((s) => /Small sample/.test(s)));
  ok('residual sum ≈ 0 (least squares)', close(g.residuals.reduce((a, b) => a + b, 0), 0, 1e-9));

  // manual check of the formulas with three points
  const p3 = [{ x_m: 10, v_mm_s: 5 }, { x_m: 20, v_mm_s: 2 }, { x_m: 40, v_mm_s: 1 }];
  const h = calibrateLeastSquares({ points: p3 });
  const X = p3.map((p) => Math.log(p.x_m)), Y = p3.map((p) => Math.log(p.v_mm_s));
  const Xm = X.reduce((a, b) => a + b) / 3, Ym = Y.reduce((a, b) => a + b) / 3;
  const nManual = -X.reduce((a, x, i) => a + (x - Xm) * (Y[i] - Ym), 0) / X.reduce((a, x) => a + (x - Xm) ** 2, 0);
  ok('3-point n matches hand formula', close(h.n, nManual, 1e-12), h.n.toFixed(4));
  ok('3-point ln K = Ȳ + n X̄', close(h.lnK, Ym + h.n * Xm, 1e-12));
  ok('N < 3 → NaN + note', Number.isNaN(calibrateLeastSquares({ points: p3.slice(0, 2) }).n));
  ok('non-positive points dropped with note', calibrateLeastSquares({ points: [...p3, { x_m: 0, v_mm_s: 1 }] }).notes.some((s) => /dropped/.test(s)));
}

console.log('== Upper prediction (course §15.7) ==');
{
  const K = 104.93, nn = 1.3219, s = 0.2;
  const u = upperPrediction({ K, n: nn, s, distance_m: 30, N: 8 });
  const expected = Math.exp(Math.log(K) - nn * Math.log(30) + 1.645 * s);
  ok('ln v95 = ln K − n ln x + 1.645 s', close(u.v95_mm_s, expected, 1e-9), u.v95_mm_s.toFixed(3));
  ok('v95 = vFit · e^(1.645 s) = 1.39× fit', close(u.v95_mm_s / u.vFit_mm_s, Math.exp(1.645 * 0.2), 1e-9));
  ok('vFit(30) = 1.17', close(u.vFit_mm_s, 1.17, 0.005));
  ok('N = 8 → no small-sample caveat', !u.notes.some((t) => /Small sample/.test(t)));
  const u4 = upperPrediction({ K, n: nn, s, distance_m: 30, N: 4 });
  ok('N = 4 → small-sample caveat', u4.notes.some((t) => /Small sample/.test(t)));
  const u0 = upperPrediction({ K, n: nn, s: 0, distance_m: 30 });
  ok('s = 0 → v95 = fit, with note', close(u0.v95_mm_s, u0.vFit_mm_s, 1e-12) && u0.notes.some((t) => /zero/.test(t)));
  const ut = upperPrediction({ K, n: nn, s, distance_m: 30, z: 2.92 });
  ok('custom z (t-factor) increases the bound', ut.v95_mm_s > u.v95_mm_s);
  ok('invalid input → NaN + note', Number.isNaN(upperPrediction({ K: -1, n: 1, s: 0.1, distance_m: 10 }).v95_mm_s));
  // end-to-end: fit noisy data → upper prediction bounds most points
  const noisy = [[5, +0.15], [10, -0.1], [20, +0.05], [40, -0.15], [60, +0.1], [80, -0.05]].map(([x, e]) => ({ x_m: x, v_mm_s: Math.exp(Math.log(K) - nn * Math.log(x) + e) }));
  const g = calibrateLeastSquares({ points: noisy });
  const above = noisy.filter((p) => upperPrediction({ K: g.K, n: g.n, s: g.s, distance_m: p.x_m, N: g.N }).v95_mm_s >= p.v_mm_s).length;
  ok('upper prediction envelopes all six noisy points', above === 6, `${above}/6`);
}

console.log(`\n${n - fails}/${n} OK${fails ? `, ${fails} FAIL` : ''}`);
process.exit(fails ? 1 : 0);
