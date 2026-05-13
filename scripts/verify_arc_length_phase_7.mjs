#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-7-'));

try {
  const source = String.raw`
#include <cassert>
#include <iostream>

#include "solver.hpp"

using namespace madep;
using namespace madep::solver;

static PhaseResult failed_near_limit() {
  PhaseResult result;
  result.converged = false;
  result.accepted = 3;
  result.rejected = 2;
  result.loadFactor = 0.90;
  result.activeCount = 4;
  return result;
}

int main() {
  SolverOptions opts;
  opts.requestedContinuationMode = RequestedContinuationMode::Auto;
  opts.safetyBracketTolerance = 0.01;

  PhaseResult candidate = failed_near_limit();
  assert(should_attempt_safety_arc_length_auto(
      candidate, opts, ConstitutiveKind::McPlastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  SolverOptions explicitArc = opts;
  explicitArc.requestedContinuationMode = RequestedContinuationMode::ArcLength;
  assert(!should_attempt_safety_arc_length_auto(
      candidate, explicitArc, ConstitutiveKind::McPlastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  PhaseResult converged = candidate;
  converged.converged = true;
  assert(!should_attempt_safety_arc_length_auto(
      converged, opts, ConstitutiveKind::McPlastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  PhaseResult earlyFailure = candidate;
  earlyFailure.loadFactor = 0.89;
  assert(!should_attempt_safety_arc_length_auto(
      earlyFailure, opts, ConstitutiveKind::McPlastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  PhaseResult noAcceptedSteps = candidate;
  noAcceptedSteps.accepted = 0;
  assert(!should_attempt_safety_arc_length_auto(
      noAcceptedSteps, opts, ConstitutiveKind::McPlastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  PhaseResult noRepeatedRejections = candidate;
  noRepeatedRejections.rejected = 1;
  assert(!should_attempt_safety_arc_length_auto(
      noRepeatedRejections, opts, ConstitutiveKind::McPlastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  PhaseResult noPlasticity = candidate;
  noPlasticity.activeCount = 0;
  noPlasticity.tensionCount = 0;
  noPlasticity.displayActiveCount = 0;
  noPlasticity.displayTensionCount = 0;
  assert(!should_attempt_safety_arc_length_auto(
      noPlasticity, opts, ConstitutiveKind::McPlastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  assert(!should_attempt_safety_arc_length_auto(
      candidate, opts, ConstitutiveKind::McPlastic, 1.0, 1.2, 1.3, opts.safetyBracketTolerance));
  assert(!should_attempt_safety_arc_length_auto(
      candidate, opts, ConstitutiveKind::McPlastic, 1.0, 1.005, -1.0, opts.safetyBracketTolerance));
  assert(!should_attempt_safety_arc_length_auto(
      candidate, opts, ConstitutiveKind::LinearElastic, 1.0, 1.2, -1.0, opts.safetyBracketTolerance));

  std::cout << "Arc-length Phase 7 auto-trigger checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_7.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_7');
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
