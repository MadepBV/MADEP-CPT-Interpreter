#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'madep-arc-length-phase-6-'));

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

static PhaseContext make_context(
    std::vector<ElementCache>& elements,
    std::vector<MaterialPoint>& committed,
    std::vector<MaterialPoint>& trial,
    std::vector<RegionParams>& regions,
    std::vector<Mat6>& regionC,
    std::vector<std::int32_t>& freeDofs,
    std::vector<std::int32_t>& freeIndexByDof,
    CsrMatrix& K,
    std::vector<double>& U,
    std::vector<double>& zeroRhs,
    ConstitutiveKind kind) {
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
  ctx.baseRhsFree = &zeroRhs;
  ctx.rampedRhsFree = &zeroRhs;
  ctx.ndof = 6;
  ctx.kind = kind;
  ctx.phaseKind = PhaseKind::SafetyCphi;
  ctx.symmetrize = false;
  ctx.incrementalStress = false;
  ctx.safetyStrengthBaseRegions = &regions;
  return ctx;
}

int main() {
  std::vector<ElementCache> elements(1);
  elem::build_T3(Node{0.0, 0.0}, Node{1.0, 0.0}, Node{0.0, 1.0}, elements[0]);
  elements[0].regionIndex = 0;
  elements[0].nodeIds = {0, 1, 2, -1, -1, -1};
  elements[0].dofs = {0, 1, 2, 3, 4, 5, -1, -1, -1, -1, -1, -1};
  elements[0].mpIdx = {0, -1, -1};

  RegionParams region;
  region.Emc = 12000.0;
  region.nu = 0.30;
  region.cEff = 4.0;
  region.phi = 25.0 * M_PI / 180.0;
  region.psi = 0.0;
  region.gamma = 18.0;
  region.gammaSat = 20.0;
  region.rShear = 0.25;
  region.useTensionCutoff = 1u;
  std::vector<RegionParams> regions{region};
  std::vector<Mat6> regionC = build_region_elastic(regions);
  std::vector<MaterialPoint> committed(1);
  std::vector<MaterialPoint> trial(1);
  committed[0].regionIndex = 0;
  trial[0].regionIndex = 0;
  std::vector<std::int32_t> freeDofs{0, 1, 2, 3, 4, 5};
  std::vector<std::int32_t> freeIndexByDof{0, 1, 2, 3, 4, 5};
  CsrMatrix K;
  sparse::build_pattern(elements, freeIndexByDof, 6, K);
  std::vector<double> U(6, 0.0);
  U[2] = -0.01;
  U[5] = -0.01;
	  std::vector<double> zeroRhs(6, 0.0);
	
	  SolverOptions opts;
	  opts.arcLengthDerivativeMode = ArcLengthDerivativeMode::AnalyticVerified;
	  ArcLengthFdScratch scratch;
	  PhaseContext elasticCtx = make_context(
	      elements, committed, trial, regions, regionC, freeDofs, freeIndexByDof,
	      K, U, zeroRhs, ConstitutiveKind::LinearElastic);
	  SafetyResidualDerivativeFd analytic = compute_safety_sigma_msf_residual_derivative(
	      elasticCtx, U, 1.0, 1.25, scratch, opts);
	  SafetyResidualDerivativeFd fd = compute_safety_sigma_msf_residual_derivative_fd(
	      elasticCtx, U, 1.0, 1.25, scratch, opts);
  assert(analytic.converged);
  assert(fd.converged);
  for (std::size_t i = 0; i < analytic.rLambdaFree.size(); ++i) {
    assert(std::abs(analytic.rLambdaFree[i]) <= 1e-14);
    assert(std::abs(fd.rLambdaFree[i]) <= 1e-10);
  }

  PhaseContext plasticCtx = make_context(
      elements, committed, trial, regions, regionC, freeDofs, freeIndexByDof,
      K, U, zeroRhs, ConstitutiveKind::McPlastic);
  SafetyResidualDerivativeFd unsupported =
      compute_safety_sigma_msf_residual_derivative_analytic(plasticCtx, 1.25);
	  assert(!unsupported.converged);
	  assert(unsupported.failureCode == 4u);
	  SafetyResidualDerivativeFd plasticSelected =
	      compute_safety_sigma_msf_residual_derivative(plasticCtx, U, 1.0, 1.25, scratch, opts);
	  SafetyResidualDerivativeFd plasticFd =
	      compute_safety_sigma_msf_residual_derivative_fd(plasticCtx, U, 1.0, 1.25, scratch, opts);
  assert(plasticSelected.converged == plasticFd.converged);
  assert(plasticSelected.failureCode == plasticFd.failureCode);

  std::cout << "Arc-length Phase 6 analytic selector checks passed.\n";
  return 0;
}
`;

  const sourcePath = join(tmp, 'verify_arc_length_phase_6.cpp');
  const binaryPath = join(tmp, 'verify_arc_length_phase_6');
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
