#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-10-'));

try {
  const solverSource = readFileSync(join(repoRoot, 'src/wasm/deformation/solver.hpp'), 'utf8');
  assert.match(
    solverSource,
    /arc_length_line_search_merit\(\s*a\.residualNorm,\s*lastConstraintResidual,\s*stepState\.deltaS,\s*stepMeritBeta,\s*(?:arcOpts|opts)\s*\)/s,
    'current arc-length merit must route through the merit-mode helper'
  );
  assert.match(
    solverSource,
    /arc_length_line_search_merit\(\s*probe\.residualNorm,\s*constraint,\s*stepState\.deltaS,\s*stepMeritBeta,\s*(?:arcOpts|opts)\s*\)/s,
    'probe arc-length merit must route through the merit-mode helper'
  );

  const source = String.raw`
#include <cassert>
#include <cmath>
#include <iostream>

#include "solver.hpp"

using namespace madep;
using namespace madep::solver;

bool close(double a, double b) {
  return std::abs(a - b) <= 1e-12 * std::max(1.0, std::max(std::abs(a), std::abs(b)));
}

int main() {
  SolverOptions opts;
  assert(opts.arcLengthMeritMode == ArcLengthMeritMode::OneNormScaled);

  const double oneNorm = arc_length_line_search_merit(
      2.0, 0.01, 0.1, 16.0, opts);
  assert(close(oneNorm, 3.0));

  opts.arcLengthMeritMode = ArcLengthMeritMode::Quadratic;
  const double beta = arc_length_quadratic_merit_beta(2.0, 0.5);
  assert(close(beta, 16.0));

  const double quadratic = arc_length_line_search_merit(
      2.0, 0.5, 0.1, beta, opts);
  assert(close(quadratic, 4.0));

  const double floorBeta = arc_length_quadratic_merit_beta(2.0, 0.0);
  assert(std::isfinite(floorBeta));
  assert(floorBeta > 1.0);

  const double minBeta = arc_length_quadratic_merit_beta(0.01, 10.0);
  assert(close(minBeta, 1.0));

  std::cout << "Arc-length Phase 10 merit-mode option checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_10.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_10');
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
