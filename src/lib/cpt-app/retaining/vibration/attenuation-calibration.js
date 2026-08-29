// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Site-specific attenuation calibration of the power law v = K · x^(−n) from trial measurements.
//
// References
//   [COURSE] course chapter §15.5 (two-point calibration), §15.6 (log-log least squares),
//            §15.7 (one-sided upper prediction ln v95 = ln K − n ln x + 1.645 s).
//
// Units: x in m, v in mm/s. Pure functions; caveats in `notes` instead of throws.
//
// Assumptions
//   * Residuals in ln v are treated as normal with constant variance (homoscedastic in log space).
//   * The 1.645 factor is the large-sample one-sided 95 % normal quantile. With few points
//     (N < 6) it underestimates the true prediction bound; a Student-t based factor is provided
//     as `tFactor` for information but the course expression (1.645) is what `upperPrediction` uses.
//   * Separate fits are required for materially different source conditions (course §15.6).

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * One-sided 95 % Student-t quantiles for ν = N − 2 degrees of freedom (ν = 1…10), then ≈ normal.
 * @type {Record<number, number>}
 */
const T95 = { 1: 6.314, 2: 2.920, 3: 2.353, 4: 2.132, 5: 2.015, 6: 1.943, 7: 1.895, 8: 1.860, 9: 1.833, 10: 1.812 };

/**
 * Two-point calibration: n = ln(v1/v2) / ln(x2/x1), K = v1 · x1^n.
 * @param {{ x1_m:number, v1_mm_s:number, x2_m:number, v2_mm_s:number }} a
 * @returns {{ n:number, K:number, N?:number, formula:string, source?:string, notes:string[] }}
 */
export function calibrateTwoPoint({ x1_m, v1_mm_s, x2_m, v2_mm_s }) {
  const notes = [];
  for (const [k, v] of Object.entries({ x1_m, v1_mm_s, x2_m, v2_mm_s })) if (!isNum(v) || v <= 0) notes.push(`${k} must be a positive number.`);
  if (isNum(x1_m) && isNum(x2_m) && x1_m === x2_m) notes.push('x1_m and x2_m must differ.');
  if (notes.length) return { n: NaN, K: NaN, formula: 'n = ln(v1/v2)/ln(x2/x1); K = v1·x1^n', notes };
  const n = Math.log(v1_mm_s / v2_mm_s) / Math.log(x2_m / x1_m);
  const K = v1_mm_s * Math.pow(x1_m, n);
  if (n <= 0) notes.push('Fitted exponent n ≤ 0 (no attenuation with distance) — check the measurements / source conditions.');
  notes.push('Two points give no residual estimate; use ≥ 3 points (calibrateLeastSquares) for an upper prediction.');
  return { n, K, N: 2, formula: 'n = ln(v1/v2)/ln(x2/x1); K = v1·x1^n', source: 'course §15.5', notes };
}

/**
 * Least-squares fit of Y = ln K − n X with X = ln x, Y = ln v (N ≥ 3).
 * n = −Σ(Xi−X̄)(Yi−Ȳ)/Σ(Xi−X̄)², ln K = Ȳ + n X̄; s = √(SSE/(N−2)) residual std-dev of ln v.
 *
 * @param {{ points:{x_m:number, v_mm_s:number}[] }} a
 * @returns {{ n:number, K:number, lnK:number, s:number, N:number, r2:number, residuals:number[], tFactor:number,
 *            formula:string, source:string, notes:string[] }}
 */
export function calibrateLeastSquares({ points = [] }) {
  const notes = [];
  const pts = points.filter((p) => p && isNum(p.x_m) && isNum(p.v_mm_s) && p.x_m > 0 && p.v_mm_s > 0);
  if (pts.length !== points.length) notes.push(`${points.length - pts.length} point(s) dropped (non-positive or non-numeric).`);
  const N = pts.length;
  const empty = { n: NaN, K: NaN, lnK: NaN, s: NaN, N, r2: NaN, residuals: [], tFactor: NaN, formula: 'ln v = ln K − n ln x', source: 'course §15.6', notes };
  if (N < 3) { notes.push('At least 3 points are required for a least-squares fit with a residual estimate.'); return empty; }
  const X = pts.map((p) => Math.log(p.x_m)), Y = pts.map((p) => Math.log(p.v_mm_s));
  const Xm = X.reduce((a, b) => a + b, 0) / N, Ym = Y.reduce((a, b) => a + b, 0) / N;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < N; i++) { sxy += (X[i] - Xm) * (Y[i] - Ym); sxx += (X[i] - Xm) ** 2; syy += (Y[i] - Ym) ** 2; }
  if (sxx === 0) { notes.push('All distances are equal; the exponent is undetermined.'); return empty; }
  const n = -sxy / sxx;
  const lnK = Ym + n * Xm;
  const residuals = X.map((x, i) => Y[i] - (lnK - n * x));
  const sse = residuals.reduce((a, r) => a + r * r, 0);
  const s = Math.sqrt(sse / (N - 2));
  const r2 = syy > 0 ? 1 - sse / syy : 1;
  const dof = N - 2;
  const tFactor = T95[dof] ?? 1.645;
  if (N < 6) notes.push(`Small sample (N = ${N}): the normal 1.645 factor underestimates a one-sided 95 % prediction bound; t(0.95, ${dof}) = ${tFactor.toFixed(3)} or a conservative envelope is more appropriate (course §15.7).`);
  if (n <= 0) notes.push('Fitted exponent n ≤ 0 (no attenuation with distance) — check the data.');
  return { n, K: Math.exp(lnK), lnK, s, N, r2, residuals, tFactor, formula: 'ln v = ln K − n ln x (least squares)', source: 'course §15.6', notes };
}

/**
 * One-sided upper prediction: ln v95(x) = ln K − n ln x + z · s (z = 1.645, course §15.7).
 *
 * @param {{ K:number, n:number, s:number, distance_m:number, N?:number, z?:number }} a
 * @returns {{ v95_mm_s:number, vFit_mm_s:number, z:number, s?:number, distance_m?:number, formula:string, source?:string, notes:string[] }}
 */
export function upperPrediction({ K, n, s, distance_m, N, z = 1.645 }) {
  const notes = [];
  if (!isNum(K) || K <= 0 || !isNum(n) || !isNum(s) || s < 0 || !isNum(distance_m) || distance_m <= 0) {
    return { v95_mm_s: NaN, vFit_mm_s: NaN, z, formula: 'ln v95 = ln K − n ln x + z·s', notes: ['K > 0, n, s ≥ 0 and distance_m > 0 are required.'] };
  }
  const lnFit = Math.log(K) - n * Math.log(distance_m);
  const v95 = Math.exp(lnFit + z * s);
  if (isNum(N) && N < 6) notes.push(`Small sample (N = ${N}): use a formal small-sample prediction interval (t-based) or a conservative envelope rather than the large-sample 1.645 expression (course §15.7).`);
  if (s === 0) notes.push('Residual std-dev is zero (perfect fit or two-point calibration): the upper prediction equals the fit and carries no statistical allowance.');
  notes.push('A best-fit line is not an upper bound; operational variability (start-up, refusal, depth) must be added separately.');
  return { v95_mm_s: v95, vFit_mm_s: Math.exp(lnFit), z, s, distance_m, formula: 'ln v95 = ln K − n ln x + z·s', source: 'course §15.7', notes };
}

/**
 * Evaluate a fit at a distance.
 * @param {{ K:number, n:number }} fit
 * @param {number} distance_m
 */
export function predictFromFit(fit, distance_m) {
  if (!fit || !isNum(fit.K) || !isNum(fit.n) || !isNum(distance_m) || distance_m <= 0) return NaN;
  return fit.K * Math.pow(distance_m, -fit.n);
}
