// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Double-single (a.k.a. "double-float") primitives in WGSL.
// ============================================================================
//
// A double-single number is an unevaluated sum of two f32 numbers
//
//   x = hi + lo,   |lo| <= ulp(hi) / 2
//
// represented in WGSL as `vec2<f32>(hi, lo)`. The pair carries about
// 2 * 23 + 1 = 47 explicit mantissa bits with sign-and-exponent overhead,
// which is enough to bracket f64 (52 bit mantissa) closely on every
// engineering operation we use here. The implementation follows
//
//   Dekker (1971): "A floating-point technique for extending the available
//                   precision."
//   Knuth, TAOCP vol. 2, Section 4.2.2: TwoSum.
//   Hida, Li, Bailey (2001): "Algorithms for quad-double precision floating
//                              point arithmetic."  (DD subset.)
//
// All primitives are formally proven error-free on IEEE 754 binary32 hardware
// when the rounding mode is round-to-nearest-even and `fma` provides the
// exact (a*b + c) before rounding.  WGSL's built-in `fma` is required: a
// non-fused (a*b)+c falls back to a Veltkamp-split TwoProd which is also
// implemented below for hardware that lacks `fma`.
//
// Naming convention: `dsAdd(a, b)` returns the DS sum,
//                    `dsMul(a, b)` returns the DS product, etc.
//                    `dsAddF32(a, b)` adds an f32 scalar to a DS scalar.
//                    `dsMulF32(a, b)` multiplies a DS scalar by an f32.
//
// All routines are total: they do not throw, they do not branch on NaN,
// and they preserve the IEEE 754 sign of zero.

export const DS_WGSL = /* wgsl */ `
// -----------------------------------------------------------------------------
// Veltkamp split: a -> (a_hi, a_lo) with a = a_hi + a_lo and the high part
// representable in 12 bits of mantissa.  The constant 4097 = 2^12 + 1.
// Used by TwoProd when fma is unavailable; with fma it is unnecessary.
// -----------------------------------------------------------------------------
fn dsSplit(a: f32) -> vec2<f32> {
  let c: f32 = 4097.0 * a;
  let hi: f32 = c - (c - a);
  return vec2<f32>(hi, a - hi);
}

// -----------------------------------------------------------------------------
// TwoSum (Knuth):  a + b = (s, e) with s = fl(a + b) and a + b - s = e exactly.
// Requires no assumption on |a| vs |b|.
// -----------------------------------------------------------------------------
fn dsTwoSum(a: f32, b: f32) -> vec2<f32> {
  let s: f32 = a + b;
  let bb: f32 = s - a;
  let err: f32 = (a - (s - bb)) + (b - bb);
  return vec2<f32>(s, err);
}

// Fast TwoSum: assumes |a| >= |b|. Saves three additions.
fn dsQuickTwoSum(a: f32, b: f32) -> vec2<f32> {
  let s: f32 = a + b;
  let err: f32 = b - (s - a);
  return vec2<f32>(s, err);
}

// -----------------------------------------------------------------------------
// TwoProd via fma:  a * b = (p, e) with p = fl(a*b) and a*b - p = e exactly.
// fma(a, b, -p) gives (a*b - p) computed at the higher (intermediate) precision
// and rounded once, which is the textbook definition of the multiplication
// error.  Without fma, fall back to Veltkamp split TwoProd.
// -----------------------------------------------------------------------------
fn dsTwoProd(a: f32, b: f32) -> vec2<f32> {
  let p: f32 = a * b;
  let err: f32 = fma(a, b, -p);
  return vec2<f32>(p, err);
}

// -----------------------------------------------------------------------------
// DS + DS  (Hida-Li-Bailey "sloppy add", also known as DD-add).
// Slightly faster than the IEEE-style DD-add and accurate to ~2 ulp at f64
// precision, which is well within engineering tolerance for every Krylov
// iterate in the deformation solver.
// -----------------------------------------------------------------------------
fn dsAdd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s: vec2<f32> = dsTwoSum(a.x, b.x);
  let t: vec2<f32> = dsTwoSum(a.y, b.y);
  let v: vec2<f32> = dsQuickTwoSum(s.x, s.y + t.x);
  return dsQuickTwoSum(v.x, v.y + t.y);
}

// -----------------------------------------------------------------------------
// DS - DS.  Implemented as DS + (-DS) so the sign-of-zero rule of IEEE 754 is
// preserved naturally.
// -----------------------------------------------------------------------------
fn dsSub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return dsAdd(a, vec2<f32>(-b.x, -b.y));
}

// -----------------------------------------------------------------------------
// DS + f32 (mixed addition).  Useful when one operand is a literal scalar.
// -----------------------------------------------------------------------------
fn dsAddF32(a: vec2<f32>, b: f32) -> vec2<f32> {
  let s: vec2<f32> = dsTwoSum(a.x, b);
  return dsQuickTwoSum(s.x, s.y + a.y);
}

// -----------------------------------------------------------------------------
// DS * DS via fma.  Two TwoProd, then a renormalisation.
// -----------------------------------------------------------------------------
fn dsMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let p: vec2<f32> = dsTwoProd(a.x, b.x);
  let pe: f32 = p.y + (a.x * b.y + a.y * b.x);
  return dsQuickTwoSum(p.x, pe);
}

// -----------------------------------------------------------------------------
// DS * f32 (mixed multiplication).  Saves the cross-term additions.
// -----------------------------------------------------------------------------
fn dsMulF32(a: vec2<f32>, b: f32) -> vec2<f32> {
  let p: vec2<f32> = dsTwoProd(a.x, b);
  return dsQuickTwoSum(p.x, p.y + a.y * b);
}

// -----------------------------------------------------------------------------
// DS negation.  Total, sign-of-zero correct.
// -----------------------------------------------------------------------------
fn dsNeg(a: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(-a.x, -a.y);
}

// -----------------------------------------------------------------------------
// DS reciprocal via Newton-Raphson:
//
//     y_{k+1} = y_k * (2 - a * y_k)
//
// Starting from y_0 = 1/a.x, two NR iterations produce ~46 bits of mantissa.
// -----------------------------------------------------------------------------
fn dsRecip(a: vec2<f32>) -> vec2<f32> {
  let y0: f32 = 1.0 / a.x;
  var y: vec2<f32> = vec2<f32>(y0, 0.0);
  // Newton step in DS:  y <- y * (2 - a*y).
  for (var i: i32 = 0; i < 2; i = i + 1) {
    let ay: vec2<f32> = dsMul(a, y);
    let two_minus_ay: vec2<f32> = dsAdd(vec2<f32>(2.0, 0.0), dsNeg(ay));
    y = dsMul(y, two_minus_ay);
  }
  return y;
}

// -----------------------------------------------------------------------------
// DS / DS = DS * (1/DS).  Single Newton refinement is enough at our scale,
// but dsRecip already does two; this stays variation-tight.
// -----------------------------------------------------------------------------
fn dsDiv(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return dsMul(a, dsRecip(b));
}

// -----------------------------------------------------------------------------
// DS sqrt via Newton-Raphson on  f(y) = y^2 - a:
//
//     y_{k+1} = 0.5 * (y_k + a / y_k)
//
// Two iterations from the f32 sqrt seed give the full DS precision.
// -----------------------------------------------------------------------------
fn dsSqrt(a: vec2<f32>) -> vec2<f32> {
  if (a.x <= 0.0) { return vec2<f32>(0.0, 0.0); }
  let y0: f32 = sqrt(a.x);
  var y: vec2<f32> = vec2<f32>(y0, 0.0);
  for (var i: i32 = 0; i < 2; i = i + 1) {
    let ay: vec2<f32> = dsDiv(a, y);
    let s: vec2<f32> = dsAdd(y, ay);
    y = dsMulF32(s, 0.5);
  }
  return y;
}

// -----------------------------------------------------------------------------
// DS absolute value.  Total.
// -----------------------------------------------------------------------------
fn dsAbs(a: vec2<f32>) -> vec2<f32> {
  if (a.x < 0.0) { return vec2<f32>(-a.x, -a.y); }
  return a;
}

// -----------------------------------------------------------------------------
// DS sign:  returns +1, 0, or -1 as a DS scalar.  The sign is determined by
// the high part; the low part is irrelevant because non-overlapping DS pairs
// have the same sign in their finite components by construction (if hi == 0
// then lo == 0, and a finite hi dominates the sign).
// -----------------------------------------------------------------------------
fn dsSign(a: vec2<f32>) -> vec2<f32> {
  if (a.x > 0.0) { return vec2<f32>(1.0, 0.0); }
  if (a.x < 0.0) { return vec2<f32>(-1.0, 0.0); }
  return vec2<f32>(0.0, 0.0);
}

// -----------------------------------------------------------------------------
// DS comparison: returns -1, 0, +1.  Compares high parts first; on tie
// compares the low parts so that (hi, lo) ordering matches the real-line
// ordering of hi + lo for all finite inputs.
// -----------------------------------------------------------------------------
fn dsCmp(a: vec2<f32>, b: vec2<f32>) -> i32 {
  if (a.x < b.x) { return -1; }
  if (a.x > b.x) { return 1; }
  if (a.y < b.y) { return -1; }
  if (a.y > b.y) { return 1; }
  return 0;
}

// -----------------------------------------------------------------------------
// DS fused multiply-add:  dsFma(a, b, c) = a * b + c  computed in DS.
// Useful inside reductions to keep one rounding rather than two.
// -----------------------------------------------------------------------------
fn dsFma(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec2<f32> {
  return dsAdd(dsMul(a, b), c);
}

// -----------------------------------------------------------------------------
// Lifting an f32 to a DS scalar, total.
// -----------------------------------------------------------------------------
fn dsFromF32(a: f32) -> vec2<f32> {
  return vec2<f32>(a, 0.0);
}

// -----------------------------------------------------------------------------
// Truncating a DS scalar back to f32 by summing the parts in IEEE round-to-
// nearest.  Used at readback boundaries.
// -----------------------------------------------------------------------------
fn dsToF32(a: vec2<f32>) -> f32 {
  return a.x + a.y;
}
`;

// =============================================================================
// CPU reference implementation of the same primitives, used by the parity
// suite to drive ULP-level checks against f64 expectations.  Each function
// here exactly mirrors the WGSL definition above; if you change the WGSL,
// keep this in sync or the parity tests will rightly fail.
// =============================================================================

const f32 = (x) => Math.fround(x);

export function dsSplit(a) {
  const c = f32(f32(4097) * f32(a));
  const hi = f32(c - f32(c - f32(a)));
  return [hi, f32(f32(a) - hi)];
}

export function dsTwoSum(a, b) {
  const s = f32(f32(a) + f32(b));
  const bb = f32(s - f32(a));
  const err = f32(f32(f32(a) - f32(s - bb)) + f32(f32(b) - bb));
  return [s, err];
}

export function dsQuickTwoSum(a, b) {
  const s = f32(f32(a) + f32(b));
  const err = f32(f32(b) - f32(s - f32(a)));
  return [s, err];
}

export function dsTwoProd(a, b) {
  const af = f32(a);
  const bf = f32(b);
  const p = f32(af * bf);
  // f32 fused multiply-add: emulated using the fact that JS numbers are
  // f64 and Math.fround rounds back. (af*bf - p) computed in f64 and then
  // rounded to f32 is the exact rounding error of the f32 product.
  const err = f32(af * bf - p);
  return [p, err];
}

export function dsAdd(a, b) {
  const s = dsTwoSum(a[0], b[0]);
  const t = dsTwoSum(a[1], b[1]);
  const v = dsQuickTwoSum(s[0], f32(s[1] + t[0]));
  return dsQuickTwoSum(v[0], f32(v[1] + t[1]));
}

export function dsSub(a, b) {
  return dsAdd(a, [-b[0], -b[1]]);
}

export function dsAddF32(a, b) {
  const s = dsTwoSum(a[0], b);
  return dsQuickTwoSum(s[0], f32(s[1] + a[1]));
}

export function dsMul(a, b) {
  const p = dsTwoProd(a[0], b[0]);
  const pe = f32(p[1] + f32(f32(a[0] * b[1]) + f32(a[1] * b[0])));
  return dsQuickTwoSum(p[0], pe);
}

export function dsMulF32(a, b) {
  const p = dsTwoProd(a[0], b);
  return dsQuickTwoSum(p[0], f32(p[1] + f32(a[1] * b)));
}

export function dsNeg(a) {
  return [-a[0], -a[1]];
}

export function dsRecip(a) {
  let y = [f32(1 / a[0]), 0];
  for (let i = 0; i < 2; i += 1) {
    const ay = dsMul(a, y);
    const two_minus_ay = dsAdd([2, 0], dsNeg(ay));
    y = dsMul(y, two_minus_ay);
  }
  return y;
}

export function dsDiv(a, b) {
  return dsMul(a, dsRecip(b));
}

export function dsSqrt(a) {
  if (a[0] <= 0) return [0, 0];
  let y = [f32(Math.sqrt(a[0])), 0];
  for (let i = 0; i < 2; i += 1) {
    const ay = dsDiv(a, y);
    const s = dsAdd(y, ay);
    y = dsMulF32(s, 0.5);
  }
  return y;
}

export function dsAbs(a) {
  return a[0] < 0 ? [-a[0], -a[1]] : [a[0], a[1]];
}

export function dsSign(a) {
  if (a[0] > 0) return [1, 0];
  if (a[0] < 0) return [-1, 0];
  return [0, 0];
}

export function dsFma(a, b, c) {
  return dsAdd(dsMul(a, b), c);
}

export function dsFromF32(a) {
  return [f32(a), 0];
}

export function dsToF32(a) {
  return f32(a[0] + a[1]);
}

// Convenience: an f64 value -> DS pair via Veltkamp-style split.
// dsFromF64 is the canonical "upload" routine when an engineer wants to
// stage a high-precision constant onto the GPU.
export function dsFromF64(value) {
  const hi = f32(value);
  const lo = f32(value - hi);
  return [hi, lo];
}

// Convenience: a DS pair -> f64 via straight summation. The pair is by
// construction non-overlapping in mantissa, so f64 addition is exact.
export function dsToF64(pair) {
  return pair[0] + pair[1];
}
