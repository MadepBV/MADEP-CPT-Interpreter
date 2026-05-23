#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Focused verifier for the embedded retaining-wall Timoshenko beam kernel.
// It compiles a tiny native C++ harness against src/wasm/deformation/beam.hpp
// so the algebra is checked without requiring emscripten.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const tmp = mkdtempSync(path.join(tmpdir(), 'madep-wall-beam-'));
const source = path.join(tmp, 'verify_wall_beam.cpp');
const binary = path.join(tmp, 'verify_wall_beam');

const code = String.raw`
#include <cmath>
#include <iostream>
#include "beam.hpp"

using namespace madep;

static bool near(double a, double b, double rel = 1e-10, double abs = 1e-8) {
  return std::fabs(a - b) <= std::max(abs, rel * std::max(std::fabs(a), std::fabs(b)));
}

static double dot_row(const double* K, int row, const double* u) {
  double s = 0.0;
  for (int j = 0; j < 6; ++j) s += K[row * 6 + j] * u[j];
  return s;
}

static void expected_reduced_local(double L, double EA, double EI, double GA, double kappa, double* K) {
  for (int i = 0; i < 36; ++i) K[i] = 0.0;
  const double axial = EA / L;
  K[0 * 6 + 0] += axial;
  K[0 * 6 + 3] -= axial;
  K[3 * 6 + 0] -= axial;
  K[3 * 6 + 3] += axial;

  const double bend = EI / L;
  K[2 * 6 + 2] += bend;
  K[2 * 6 + 5] -= bend;
  K[5 * 6 + 2] -= bend;
  K[5 * 6 + 5] += bend;

  const double kGA_L = kappa * GA / L;
  const double h = 0.5 * L;
  const int ids[4] = {1, 2, 4, 5};
  const double block[4][4] = {
    { 1.0,  h,  -1.0,  h },
    { h,    h*h, -h,   h*h },
    {-1.0, -h,   1.0, -h },
    { h,    h*h, -h,   h*h }
  };
  for (int i = 0; i < 4; ++i)
    for (int j = 0; j < 4; ++j)
      K[ids[i] * 6 + ids[j]] += kGA_L * block[i][j];
}

int main() {
  BeamElementCache el;
  el.nodeA = 0;
  el.nodeB = 1;
  el.dofs = {0, 1, 2, 3, 4, 5};
  el.xA = 0.0;
  el.yA = 0.0;
  el.xB = 0.0;
  el.yB = -8.0;
  el.length = 8.0;
  el.EA = 2.0e7;
  el.EI = 1.5e5;
  el.GA = 8.0e6;
  el.kappa = 5.0 / 6.0;

  double K[36]{};
  beam::element_stiffness(el, K);
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      if (!near(K[i * 6 + j], K[j * 6 + i], 1e-12, 1e-7)) {
        std::cerr << "non-symmetric elastic beam stiffness at " << i << "," << j << "\n";
        return 1;
      }
    }
  }

  const double rigidX[6] = {1, 0, 0, 1, 0, 0};
  const double rigidY[6] = {0, 1, 0, 0, 1, 0};
  const double rigidRotationLocal[6] = {0, -0.5 * el.length, 1, 0, 0.5 * el.length, 1};
  for (int i = 0; i < 6; ++i) {
    if (!near(dot_row(K, i, rigidX), 0.0, 1e-10, 1e-7) ||
        !near(dot_row(K, i, rigidY), 0.0, 1e-10, 1e-7)) {
      std::cerr << "rigid translation produced internal force at row " << i << "\n";
      return 1;
    }
  }

  std::array<double, 36> kLocal{};
  beam::local_timoshenko_stiffness(el.length, el.EA, el.EI, el.GA, el.kappa, kLocal);
  double expected[36]{};
  expected_reduced_local(el.length, el.EA, el.EI, el.GA, el.kappa, expected);
  for (int i = 0; i < 36; ++i) {
    if (!near(kLocal[i], expected[i], 1e-12, 1e-7)) {
      std::cerr << "reduced-integration local stiffness mismatch at index "
                << i << ": got " << kLocal[i] << " expected " << expected[i] << "\n";
      return 1;
    }
  }
  for (int i = 0; i < 6; ++i) {
    if (!near(dot_row(kLocal.data(), i, rigidRotationLocal), 0.0, 1e-10, 1e-7)) {
      std::cerr << "rigid rotation produced local internal force at row " << i << "\n";
      return 1;
    }
  }

  const double shearEnergyMode[6] = {0, 0, 0, 0, 1, 0};
  double shearWork = 0.0;
  for (int i = 0; i < 6; ++i) shearWork += shearEnergyMode[i] * dot_row(kLocal.data(), i, shearEnergyMode);
  if (!(shearWork > 0.0)) {
    std::cerr << "unit transverse deformation has non-positive shear energy\n";
    return 1;
  }

  std::cout << "wall beam kernel verifier passed\n";
  return 0;
}
`;

try {
  writeFileSync(source, code);
  const compile = spawnSync('g++', [
    '-std=c++20',
    '-I', path.join(root, 'src/wasm/deformation'),
    source,
    '-o', binary
  ], { encoding: 'utf8' });
  if (compile.status !== 0) {
    process.stderr.write(compile.stdout || '');
    process.stderr.write(compile.stderr || '');
    process.exit(compile.status || 1);
  }
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  process.exit(run.status || 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
