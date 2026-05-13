#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';

function springForce(u) {
  return u - u * u * u;
}

function springTangent(u) {
  return 1 - 3 * u * u;
}

function constraintResidual(duStep, dlamStep, deltaS, alpha) {
  return duStep * duStep + alpha * alpha * dlamStep * dlamStep - deltaS * deltaS;
}

function corrector({ u, lambda, uStart, lambdaStart, deltaS, alpha }) {
  const residual = lambda - springForce(u);
  const k = springTangent(u);
  assert.ok(Math.abs(k) > 1e-10, 'benchmark tangent should stay off the exact singular point');

  const duResidual = residual / k;
  const duContinuation = 1 / k;
  const duStep = u - uStart;
  const dlamStep = lambda - lambdaStart;
  const g = constraintResidual(duStep, dlamStep, deltaS, alpha);
  const guDuResidual = 2 * duStep * duResidual;
  const guDuContinuation = 2 * duStep * duContinuation;
  const gLambda = 2 * alpha * alpha * dlamStep;
  const denominator = guDuContinuation + gLambda;
  assert.ok(Math.abs(denominator) > 1e-12, 'arc-length denominator should be usable');

  const deltaLambda = (-g - guDuResidual) / denominator;
  return {
    deltaU: duResidual + deltaLambda * duContinuation,
    deltaLambda,
    denominator,
    constraintResidual: g
  };
}

function solveScalarRiks() {
  let u = 0;
  let lambda = 0;
  let previousDu = 0;
  let previousDlam = 0;
  const alpha = 1;
  const deltaS = 0.08;
  const points = [];

  for (let step = 0; step < 14; step += 1) {
    const uStart = u;
    const lambdaStart = lambda;
    const phi = 1 / springTangent(uStart);
    let scale = deltaS / Math.sqrt(phi * phi + alpha * alpha);
    let duStep = scale * phi;
    let dlamStep = scale;
    if (step > 0 && (duStep * previousDu + alpha * alpha * dlamStep * previousDlam) < 0) {
      duStep = -duStep;
      dlamStep = -dlamStep;
    }
    u = uStart + duStep;
    lambda = lambdaStart + dlamStep;

    for (let iter = 0; iter < 16; iter += 1) {
      const c = corrector({ u, lambda, uStart, lambdaStart, deltaS, alpha });
      u += c.deltaU;
      lambda += c.deltaLambda;
      if (Math.abs(lambda - springForce(u)) < 1e-10 &&
          Math.abs(constraintResidual(u - uStart, lambda - lambdaStart, deltaS, alpha)) < 1e-10) {
        break;
      }
      assert.ok(iter < 15, 'scalar Riks corrector did not converge');
    }

    previousDu = u - uStart;
    previousDlam = lambda - lambdaStart;
    points.push({ u, lambda });
  }

  return points;
}

const points = solveScalarRiks();
const peak = Math.max(...points.map((p) => p.lambda));
const last = points[points.length - 1];
const theoreticalPeak = 2 / (3 * Math.sqrt(3));

assert.ok(peak > theoreticalPeak - 0.01, `peak ${peak} should approach ${theoreticalPeak}`);
assert.ok(last.u > 1 / Math.sqrt(3), 'path should pass the limit-point displacement');
assert.ok(last.lambda < peak, 'path should continue onto the descending branch');

console.log('Arc-length Phase 3 scalar Riks checks passed.');
