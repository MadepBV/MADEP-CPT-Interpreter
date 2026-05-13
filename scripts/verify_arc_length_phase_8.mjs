#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildSafetyFinalization } from '../src/lib/cpt-app/deformation/safety-finalization.js';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-8-'));

try {
  const source = String.raw`
#include <cassert>
#include <iostream>

#include "solver.hpp"

using namespace madep;
using namespace madep::solver;

int main() {
  SolverOptions opts;
  opts.arcLengthAllowPostPeakSafetyPath = 1u;

  ArcLengthPredictor predictor;
  predictor.converged = true;
  predictor.deltaLambda = -0.01;

  ArcLengthState firstStep;
  firstStep.acceptedStepCount = 0;
  assert(!arc_length_predictor_direction_allowed(predictor, firstStep, opts));

  ArcLengthState postPeak;
  postPeak.acceptedStepCount = 1;
  assert(arc_length_predictor_direction_allowed(predictor, postPeak, opts));

  opts.arcLengthAllowPostPeakSafetyPath = 0u;
  assert(!arc_length_predictor_direction_allowed(predictor, postPeak, opts));

  predictor.deltaLambda = 0.01;
  assert(arc_length_predictor_direction_allowed(predictor, firstStep, opts));

  predictor.converged = false;
  assert(!arc_length_predictor_direction_allowed(predictor, postPeak, opts));

  std::cout << "Arc-length Phase 8 post-peak predictor gate checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_8.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_8');
  writeFileSync(sourcePath, source);
  const compile = spawnSync(
    'g++',
    ['-std=c++20', '-O2', '-I', join(repoRoot, 'src/wasm/deformation'), sourcePath, '-o', binaryPath],
    { encoding: 'utf8' }
  );
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);
  const run = spawnSync(binaryPath, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  process.stdout.write(run.stdout);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const postPeakCurve = [
  { index: 0, sigmaMsf: 1.0, uMaxAbs: 0, maxDeltaPlasticStrain: 0, arcLengthDetails: null },
  {
    index: 1,
    sigmaMsf: 1.25,
    uMaxAbs: 0.04,
    maxDeltaPlasticStrain: 0.002,
    arcLengthDetails: { actualContinuationMode: 'arc-length', deltaLambda: 0.25 }
  },
  {
    index: 2,
    sigmaMsf: 1.18,
    uMaxAbs: 0.09,
    maxDeltaPlasticStrain: 0.006,
    arcLengthDetails: { actualContinuationMode: 'arc-length', deltaLambda: -0.07 }
  }
];
const peakSigma = Math.max(...postPeakCurve.map((point) => point.sigmaMsf));
assert.equal(peakSigma, 1.25);
assert.ok(postPeakCurve.some((point, index) => index > 0 && point.sigmaMsf < peakSigma));

const finalization = buildSafetyFinalization({
  mode: 'production-msf',
  rawStatus: 'mechanism-developed',
  factorOfSafetyLower: peakSigma,
  factorOfSafetyUpper: null,
  strengthRetained: 1 / peakSigma,
  displayedSigmaMsf: peakSigma,
  mechanism: {
    status: 'coherent',
    score: 0.8,
    threshold: 0.65,
    activePlasticElementCount: 4
  },
  curve: postPeakCurve,
  trialTargets: [],
  options: {
    safetyMechanismPlateauWindow: 2,
    safetyMechanismMinIncrementalDisplacementNorm: 1e-4,
    safetyMechanismMinPlasticIncrement: 1e-4
  }
});

assert.equal(finalization.status, 'mechanism-developed');
assert.equal(finalization.factorOfSafetyLower, peakSigma);
assert.equal(finalization.factorOfSafety, peakSigma);
assert.equal(finalization.displayedSigmaMsf, peakSigma);
console.log('Arc-length Phase 8 post-peak curve snapshot checks passed.');
