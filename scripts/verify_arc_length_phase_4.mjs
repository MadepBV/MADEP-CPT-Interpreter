#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-4-'));

try {
  const source = String.raw`
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>

#include "solver.hpp"

using namespace madep;
using namespace madep::solver;

static bool close(double a, double b) {
  return std::abs(a - b) <= 1e-15 * std::max({1.0, std::abs(a), std::abs(b)});
}

static bool same_point(const MaterialPoint& a, const MaterialPoint& b) {
  for (int i = 0; i < 6; ++i) {
    if (!close(a.effectiveStress[i], b.effectiveStress[i])) return false;
    if (!close(a.totalStrain[i], b.totalStrain[i])) return false;
    if (!close(a.plasticStrain[i], b.plasticStrain[i])) return false;
    if (!close(a.referenceStress[i], b.referenceStress[i])) return false;
  }
  return close(a.accumulatedPlasticStrain, b.accumulatedPlasticStrain) &&
      a.plasticActive == b.plasticActive &&
      a.tensionCutoffActive == b.tensionCutoffActive &&
      a.currentlyMcActive == b.currentlyMcActive &&
      a.exactBranchKind == b.exactBranchKind &&
      a.multiplicityKind == b.multiplicityKind &&
      a.localReturnMode == b.localReturnMode &&
      a.localFallbackUsed == b.localFallbackUsed;
}

int main() {
  std::vector<ElementCache> elements(1);
  elem::build_T3(Node{0.0, 0.0}, Node{1.0, 0.0}, Node{0.0, 1.0}, elements[0]);
  elements[0].regionIndex = 0;
  elements[0].nodeIds = {0, 1, 2, -1, -1, -1};
  elements[0].dofs = {0, 1, 2, 3, 4, 5, -1, -1, -1, -1, -1, -1};
  elements[0].mpIdx = {0, -1, -1};

  RegionParams region;
  region.Emc = 8000.0;
  region.nu = 0.30;
  region.cEff = 4.0;
  region.phi = 24.0 * M_PI / 180.0;
  region.psi = 0.0;
  region.K0nc = 0.5;
  region.gamma = 18.0;
  region.gammaSat = 20.0;
  region.sigmaTAllow = 0.0;
  region.rShear = 0.25;
  region.useTensionCutoff = 1u;
  region.symmetrize = 0u;
  std::vector<RegionParams> regions{region};
  std::vector<Mat6> regionC = build_region_elastic(regions);

  std::vector<MaterialPoint> committed(1);
  std::vector<MaterialPoint> trial(1);
  committed[0].regionIndex = 0;
  trial[0].regionIndex = 0;
  committed[0].effectiveStress[V_XX] = -15.0;
  committed[0].effectiveStress[V_YY] = -20.0;
  committed[0].effectiveStress[V_ZZ] = -17.0;
  committed[0].referenceStress = committed[0].effectiveStress;
  trial[0] = committed[0];
  const std::vector<MaterialPoint> committedBefore = committed;
  const std::vector<MaterialPoint> trialBefore = trial;

  std::vector<std::int32_t> freeDofs{0, 1, 2, 3, 4, 5};
  std::vector<std::int32_t> freeIndexByDof{0, 1, 2, 3, 4, 5};
  CsrMatrix K;
  sparse::build_pattern(elements, freeIndexByDof, 6, K);

  std::vector<double> U(6, 0.0);
  U[2] = -0.035;
  U[3] = 0.015;
  U[4] = 0.010;
  U[5] = -0.020;
  std::vector<double> zeroRhs(6, 0.0);

  PhaseContext ctx;
  ctx.elements = &elements;
  ctx.committed = &committed;
  ctx.trial = &trial;
  ctx.regions = &regions;
  ctx.regionC = &regionC;
  ctx.freeDofs = &freeDofs;
  ctx.freeIndexByDof = &freeIndexByDof;
  ctx.K = &K;
  ctx.U_global = &U;
  ctx.U_base = nullptr;
  ctx.baseRhsFree = &zeroRhs;
  ctx.rampedRhsFree = &zeroRhs;
  ctx.ndof = 6;
  ctx.kind = ConstitutiveKind::McPlastic;
  ctx.phaseKind = PhaseKind::SafetyCphi;
  ctx.symmetrize = false;
  ctx.incrementalStress = false;
  ctx.safetyStrengthBaseRegions = &regions;

  SolverOptions opts;
  opts.constitutive = ConstitutiveKind::McPlastic;
  opts.arcLengthFiniteDifferenceStepScale = 1e-5;
  opts.arcLengthFiniteDifferenceMinStep = 1e-7;
  ArcLengthFdScratch fdScratch;

  const SafetyResidualDerivativeFd atBoundary =
      compute_safety_sigma_msf_residual_derivative_fd(ctx, U, 1.0, 1.0, fdScratch, opts);
  assert(atBoundary.converged);
  assert(atBoundary.failureCode == 0u);
  assert(!atBoundary.usedCentralDifference);
  assert(atBoundary.lowerSigmaMsf >= 1.0);
  assert(atBoundary.upperSigmaMsf > atBoundary.lowerSigmaMsf);
  assert(same_point(committed[0], committedBefore[0]));
  assert(same_point(trial[0], trialBefore[0]));

  const SafetyResidualDerivativeFd central =
      compute_safety_sigma_msf_residual_derivative_fd(ctx, U, 1.0, 1.4, fdScratch, opts);
  assert(central.converged);
  assert(central.failureCode == 0u);
  assert(central.usedCentralDifference);
  assert(central.lowerSigmaMsf >= 1.0);
  assert(central.upperSigmaMsf > central.lowerSigmaMsf);
  assert(same_point(committed[0], committedBefore[0]));
  assert(same_point(trial[0], trialBefore[0]));

  double norm = 0.0;
  for (std::size_t i = 0; i < central.rLambdaFree.size(); ++i) {
    assert(std::isfinite(central.rLambdaFree[i]));
    assert(std::isfinite(central.continuationRhsFree[i]));
    assert(close(central.continuationRhsFree[i], -central.rLambdaFree[i]));
    norm += central.rLambdaFree[i] * central.rLambdaFree[i];
  }
  assert(norm >= 0.0);

  SolverOptions coarser = opts;
  coarser.arcLengthFiniteDifferenceStepScale = 2e-5;
  const SafetyResidualDerivativeFd centralCoarse =
      compute_safety_sigma_msf_residual_derivative_fd(ctx, U, 1.0, 1.4, fdScratch, coarser);
  assert(centralCoarse.converged);
  double diff = 0.0;
  double ref = 0.0;
  for (std::size_t i = 0; i < central.rLambdaFree.size(); ++i) {
    const double d = central.rLambdaFree[i] - centralCoarse.rLambdaFree[i];
    diff += d * d;
    ref += central.rLambdaFree[i] * central.rLambdaFree[i];
  }
  if (ref > 1e-20) {
    assert(std::sqrt(diff / ref) < 0.25);
  }

  std::cout << "Arc-length Phase 4 safety FD derivative checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_4.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_4');
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

  const solverSource = readFileSync(join(repoRoot, 'src/wasm/deformation/solver.hpp'), 'utf8');
  assert.match(solverSource, /compute_safety_sigma_msf_residual_derivative_fd/);
  assert.match(solverSource, /candidateLower >= 1\.0/);
  assert.match(solverSource, /std::vector<MaterialPoint> trialBackup/);
  assert.match(solverSource, /const std::vector<MaterialPoint>& committedRef = \*ctx\.committed/);
  assert.doesNotMatch(solverSource, /\*ctx\.committed = committedBackup/);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
