#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-9-'));

try {
  const solverSource = readFileSync(join(repoRoot, 'src/wasm/deformation/solver.hpp'), 'utf8');
  assert.match(
    solverSource,
    /arc_length_line_search_max_backtracks\(opts\)/,
    'arc-length line search loop must use the SolverOptions backtrack cap'
  );
  assert.doesNotMatch(
    solverSource,
    /constexpr int kArcLengthLineSearchMaxBacktracks = 6/,
    'arc-length line search backtrack cap must not be hard-coded'
  );

  const source = String.raw`
#include <cassert>
#include <iostream>

#include "solver.hpp"

using namespace madep;
using namespace madep::solver;

int main() {
  SolverOptions opts;
  assert(opts.arcLengthLineSearchMaxBacktracks == 6);
  assert(arc_length_line_search_max_backtracks(opts) == 6);

  opts.arcLengthLineSearchMaxBacktracks = 4;
  assert(arc_length_line_search_max_backtracks(opts) == 4);

  opts.arcLengthLineSearchMaxBacktracks = 0;
  assert(arc_length_line_search_max_backtracks(opts) == 1);

  opts.arcLengthLineSearchMaxBacktracks = -10;
  assert(arc_length_line_search_max_backtracks(opts) == 1);

  std::cout << "Arc-length Phase 9 line-search backtrack option checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_9.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_9');
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
