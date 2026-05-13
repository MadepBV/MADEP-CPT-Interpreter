#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Focused regression for the opt-in WASM robust nonlinear mode.
//
// The 120 kPa probe sits in the range where the exact plastic tangent
// still converges but spends many continuation steps fighting line-search
// stalls. Robust mode is expected to keep convergence and reduce the
// continuation/Newton/Krylov work by accepting only clearly better
// elastic-globalization rescue directions.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const probeScript = resolve(repoRoot, 'scripts/probe_solver_dx.mjs');

function parseProbeOutput(stdout) {
  const text = String(stdout || '');
  const readBool = (label) => {
    const match = text.match(new RegExp(`${label}:\\s*(true|false)`));
    if (!match) throw new Error(`Missing ${label} in probe output:\n${text}`);
    return match[1] === 'true';
  };
  const readNumber = (label) => {
    const match = text.match(new RegExp(`${label}:\\s*([-+0-9.eE]+)`));
    if (!match) throw new Error(`Missing ${label} in probe output:\n${text}`);
    return Number(match[1]);
  };
  const stepMatch = text.match(/accepted\/rejected steps:\s*([0-9]+)\s*\/\s*([0-9]+)/);
  if (!stepMatch) throw new Error(`Missing accepted/rejected steps in probe output:\n${text}`);
  return {
    robust: readBool('wasmRobustNonlinearMode'),
    converged: readBool('CONVERGED'),
    loadFactor: readNumber('loadFactorCommitted'),
    accepted: Number(stepMatch[1]),
    rejected: Number(stepMatch[2]),
    newton: readNumber('newton iters'),
    linear: readNumber('linear iters'),
    residual: readNumber('residual'),
    stdout: text
  };
}

function runProbe({ robust }) {
  const result = spawnSync(process.execPath, [probeScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PROBE_Q: '120',
      WASM_ROBUST: robust ? '1' : '0'
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Probe failed (${robust ? 'robust' : 'default'}):\n${result.stdout}\n${result.stderr}`);
  }
  return parseProbeOutput(result.stdout);
}

function assertCondition(condition, message, details) {
  if (condition) return;
  const suffix = details ? `\n${details}` : '';
  throw new Error(`${message}${suffix}`);
}

const baseline = runProbe({ robust: false });
const robust = runProbe({ robust: true });

console.log('Default WASM probe:', {
  accepted: baseline.accepted,
  rejected: baseline.rejected,
  newton: baseline.newton,
  linear: baseline.linear,
  residual: baseline.residual
});
console.log('Robust WASM probe:', {
  accepted: robust.accepted,
  rejected: robust.rejected,
  newton: robust.newton,
  linear: robust.linear,
  residual: robust.residual
});

assertCondition(!baseline.robust && robust.robust, 'Probe robust flag was not routed correctly.');
assertCondition(baseline.converged && robust.converged, 'Both default and robust probes must converge.');
assertCondition(baseline.loadFactor === 1 && robust.loadFactor === 1, 'Both probes must commit the full load factor.');
assertCondition(
  robust.rejected < baseline.rejected,
  'Robust mode should reduce rejected continuation steps on the 120 kPa plastic probe.',
  `default rejected=${baseline.rejected}, robust rejected=${robust.rejected}`
);
assertCondition(
  robust.accepted <= baseline.accepted,
  'Robust mode should not need more accepted continuation steps on the 120 kPa plastic probe.',
  `default accepted=${baseline.accepted}, robust accepted=${robust.accepted}`
);
assertCondition(
  robust.newton <= baseline.newton,
  'Robust mode should not need more Newton iterations on the 120 kPa plastic probe.',
  `default Newton=${baseline.newton}, robust Newton=${robust.newton}`
);
assertCondition(
  robust.linear <= baseline.linear,
  'Robust mode should not need more Krylov iterations on the 120 kPa plastic probe.',
  `default Krylov=${baseline.linear}, robust Krylov=${robust.linear}`
);

console.log('PASS: WASM robust nonlinear mode reduces high-plasticity continuation work.');
