#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MC-SH-0 verifier: compile and run the local tangent bisection harness.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'madep-mc-sh0-'));

try {
  const source = resolve(repoRoot, 'scripts/scratch/mc_sh_phase_0.cpp');
  const binary = join(tmp, 'mc_sh_phase_0');
  const compile = spawnSync(
    'g++',
    [
      '-std=c++20',
      '-O2',
      '-Wall',
      '-Wextra',
      '-pedantic',
      '-I', resolve(repoRoot, 'src/wasm/deformation'),
      source,
      '-o', binary
    ],
    { encoding: 'utf8' }
  );
  if (compile.stdout) process.stdout.write(compile.stdout);
  if (compile.stderr) process.stderr.write(compile.stderr);
  assert.equal(compile.status, 0, 'failed to compile MC-SH-0 harness');

  const run = spawnSync(binary, [], { encoding: 'utf8' });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  assert.equal(run.status, 0, 'MC-SH-0 harness failed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
