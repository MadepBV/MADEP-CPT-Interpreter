#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-11-'));

try {
  const solverSource = readFileSync(join(repoRoot, 'src/wasm/deformation/solver.hpp'), 'utf8');
  assert.match(
    solverSource,
    /prepare_arc_length_runtime_options\(ctx, opts\)/,
    'safety arc-length phase must resolve runtime displacement scaling once per phase'
  );
  assert.match(
    solverSource,
    /arc_length_weighted_norm2\(stepDeltaUFree, displacementScale\)/,
    'safety arc-length radius must use the resolved displacement scale'
  );
  assert.match(
    solverSource,
    /arc_length_constraint_residual\([^;]+displacementScale\)/s,
    'safety arc-length constraint must use the resolved displacement scale'
  );

  const source = String.raw`
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

#include "solver.hpp"

using namespace madep;
using namespace madep::solver;

bool close(double a, double b) {
  return std::abs(a - b) <= 1e-12 * std::max(1.0, std::max(std::abs(a), std::abs(b)));
}

int main() {
  PhaseContext ctx;
  ctx.modelBoundingBoxDiagonal = 30.0;

  SolverOptions defaults;
  ArcLengthRuntimeOptions runtime = prepare_arc_length_runtime_options(ctx, defaults);
  assert(close(runtime.displacementScale, 1.0));
  assert(close(runtime.opts.arcLengthInitialRadius, defaults.arcLengthInitialRadius));
  assert(close(runtime.opts.arcLengthConstraintTolerance, defaults.arcLengthConstraintTolerance));

  SolverOptions autoScaled;
  autoScaled.arcLengthDisplacementScale = 0.0;
  runtime = prepare_arc_length_runtime_options(ctx, autoScaled);
  const double w = 1.0 / 30.0;
  assert(close(runtime.displacementScale, w));
  assert(close(runtime.opts.arcLengthInitialRadius, autoScaled.arcLengthInitialRadius * w));
  assert(close(runtime.opts.arcLengthMinRadius, autoScaled.arcLengthMinRadius * w));
  assert(close(runtime.opts.arcLengthMaxRadius, autoScaled.arcLengthMaxRadius * w));
  assert(close(runtime.opts.arcLengthConstraintTolerance, autoScaled.arcLengthConstraintTolerance * w * w));

  SolverOptions customScaled = autoScaled;
  customScaled.arcLengthInitialRadiusScale = 2.0;
  customScaled.arcLengthMinRadiusScale = 3.0;
  customScaled.arcLengthMaxRadiusScale = 4.0;
  customScaled.arcLengthConstraintToleranceScale = 5.0;
  runtime = prepare_arc_length_runtime_options(ctx, customScaled);
  assert(close(runtime.opts.arcLengthInitialRadius, customScaled.arcLengthInitialRadius * w * 2.0));
  assert(close(runtime.opts.arcLengthMinRadius, customScaled.arcLengthMinRadius * w * 3.0));
  assert(close(runtime.opts.arcLengthMaxRadius, customScaled.arcLengthMaxRadius * w * 4.0));
  assert(close(runtime.opts.arcLengthConstraintTolerance, customScaled.arcLengthConstraintTolerance * w * w * 5.0));

  std::vector<double> displacement = {30.0, 0.0};
  assert(close(arc_length_weighted_norm2(displacement, w), 1.0));
  assert(close(arc_length_constraint_residual(displacement, 0.0, 1.0, 1.0, w), 0.0));

  std::cout << "Arc-length Phase 11 displacement-scale option checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_11.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_11');
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
