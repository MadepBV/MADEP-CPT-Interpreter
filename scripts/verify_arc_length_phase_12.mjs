#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-12-'));

try {
  const solverSource = readFileSync(join(repoRoot, 'src/wasm/deformation/solver.hpp'), 'utf8');
  assert.match(
    solverSource,
    /GmresScalingCache gmresCache;/,
    'arc-length corrector must own a per-corrector GMRES scaling cache'
  );
  assert.match(
    solverSource,
    /gmresCachePtr/,
    'arc-length corrector must pass the GMRES scaling cache to both solves'
  );

  const source = String.raw`
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

#include "cg.hpp"

using namespace madep;
using namespace madep::cg;

bool close(double a, double b) {
  return std::abs(a - b) <= 1e-10 * std::max(1.0, std::max(std::abs(a), std::abs(b)));
}

int main() {
  CsrMatrix A;
  A.nrows = 2;
  A.rowPtr = {0, 2, 4};
  A.colIdx = {0, 1, 0, 1};
  A.values = {4.0, 1.0, 2.0, 3.0};
  std::vector<std::int32_t> freeDofs = {0, 1};

  double rhs1[2] = {1.0, 2.0};
  double rhs2[2] = {2.0, 1.0};
  double xCached1[2] = {0.0, 0.0};
  double xCached2[2] = {0.0, 0.0};
  double xFresh1[2] = {0.0, 0.0};
  double xFresh2[2] = {0.0, 0.0};

  GmresScalingCache cache;
  LinearSolveResult c1 = solve_gmres_scaled(
      A, freeDofs, rhs1, xCached1, 50, 1e-12, 1e-12, 40, &cache);
  assert(c1.converged);
  assert(cache.rebuildCount == 1);

  LinearSolveResult c2 = solve_gmres_scaled(
      A, freeDofs, rhs2, xCached2, 50, 1e-12, 1e-12, 40, &cache);
  assert(c2.converged);
  assert(cache.rebuildCount == 1);

  LinearSolveResult f1 = solve_gmres_scaled(
      A, freeDofs, rhs1, xFresh1, 50, 1e-12, 1e-12);
  LinearSolveResult f2 = solve_gmres_scaled(
      A, freeDofs, rhs2, xFresh2, 50, 1e-12, 1e-12);
  assert(f1.converged);
  assert(f2.converged);
  for (int i = 0; i < 2; ++i) {
    assert(close(xCached1[i], xFresh1[i]));
    assert(close(xCached2[i], xFresh2[i]));
  }

  A.values[0] += 0.25;
  double rhs3[2] = {1.0, 1.0};
  double xCached3[2] = {0.0, 0.0};
  LinearSolveResult c3 = solve_gmres_scaled(
      A, freeDofs, rhs3, xCached3, 50, 1e-12, 1e-12, 40, &cache);
  assert(c3.converged);
  assert(cache.rebuildCount == 2);

  std::cout << "Arc-length Phase 12 GMRES scaling cache checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_12.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_12');
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
