#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hardening Soil production-acceptance runner.
//
// Per docs/features/hardening-soil-fix.md §Phase 9: consolidates every
// HS verifier into a single PASS/FAIL gate. Each individual verifier is
// run as a child process (so failures don't terminate the parent) and
// the table at the end gives the production-acceptance verdict.
//
// Verifiers covered (11 total):
//   1.  verify:hs-phase-1            (wire+state plumbing)
//   2.  verify:hs-phase-2            (single-surface D.1/D.2/D.3/D.5)
//   3.  verify:hs-phase-3            (corner D.4 + admissibility cert)
//   4.  verify:hs-phase-4            (tension cutoff hierarchy)
//   5.  verify:hs-phase-5            (D.6 multi-element + plane-strain σ_zz)
//   6.  verify:hs-phase-6            (visualization wire-format)
//   7.  verify:hs-phase-7            (c-φ safety integration)
//   8.  verify:hs-phase-8            (UI inheritance + benchmark fixtures)
//   9.  verify:hs-app-safety-path    (app-level HS safety path)
//   10. verify:hs-tangent-oracle     (analytic vs FD tangent oracle)
//   11. verify:hs-solver-dispatch    (GMRES dispatch verification)
//
// Acceptance gate: ALL 11 must PASS for production.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const VERIFIERS = [
  { id: 'hs-phase-1', label: 'wire+state', script: 'verify_hs_phase_1.mjs' },
  { id: 'hs-phase-2', label: 'single-surface D.1/D.2/D.3/D.5', script: 'verify_hs_phase_2.mjs' },
  { id: 'hs-phase-3', label: 'corner D.4 + admissibility cert', script: 'verify_hs_phase_3.mjs' },
  { id: 'hs-phase-4', label: 'tension cutoff hierarchy', script: 'verify_hs_phase_4.mjs' },
  { id: 'hs-phase-5', label: 'D.6 multi-element + plane-strain', script: 'verify_hs_phase_5.mjs' },
  { id: 'hs-phase-6', label: 'visualization wire-format', script: 'verify_hs_phase_6.mjs' },
  { id: 'hs-phase-7', label: 'c-φ safety integration', script: 'verify_hs_phase_7.mjs' },
  { id: 'hs-phase-8', label: 'UI + benchmark fixtures', script: 'verify_hs_phase_8.mjs' },
  { id: 'hs-app-safety-path', label: 'app-level safety path', script: 'verify_hs_app_safety_path.mjs' },
  { id: 'hs-tangent-oracle', label: 'analytic vs FD tangent', script: 'verify_hs_tangent_oracle.mjs' },
  { id: 'hs-solver-dispatch', label: 'GMRES dispatch (Phase 7)', script: 'verify_hs_solver_dispatch.mjs' }
];

function runVerifier(scriptName) {
  return new Promise((resolveP) => {
    const scriptPath = resolve(repoRoot, 'scripts', scriptName);
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const start = Date.now();
    child.on('close', (code) => {
      const elapsed = Date.now() - start;
      resolveP({ code, stdout, stderr, elapsed });
    });
    child.on('error', (err) => {
      const elapsed = Date.now() - start;
      resolveP({ code: -1, stdout, stderr: stderr + `\nspawn error: ${err?.message ?? err}`, elapsed });
    });
  });
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function lastNonEmptyLines(text, n) {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  return lines.slice(-n);
}

async function main() {
  console.log('================================');
  console.log(' HS Production Acceptance Runner');
  console.log('================================');
  console.log(`Repository: ${repoRoot}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Verifiers to run: ${VERIFIERS.length}`);
  console.log('');

  const results = [];
  for (let i = 0; i < VERIFIERS.length; i += 1) {
    const v = VERIFIERS[i];
    const label = `[${i + 1}/${VERIFIERS.length}] ${v.id}`;
    process.stdout.write(`${label.padEnd(40)} ... `);
    const r = await runVerifier(v.script);
    const passed = r.code === 0;
    results.push({ ...v, ...r, passed });
    process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  (${formatDuration(r.elapsed)})\n`);
    if (!passed) {
      console.log(`    exit code: ${r.code}`);
      const tail = lastNonEmptyLines(r.stdout, 6);
      const errTail = lastNonEmptyLines(r.stderr, 6);
      if (tail.length > 0) {
        console.log('    stdout tail:');
        for (const line of tail) console.log(`      ${line}`);
      }
      if (errTail.length > 0) {
        console.log('    stderr tail:');
        for (const line of errTail) console.log(`      ${line}`);
      }
    }
  }

  console.log('');
  console.log('HS Production Acceptance Summary');
  console.log('================================');
  for (const r of results) {
    const flag = r.passed ? '[PASS]' : '[FAIL]';
    console.log(`${flag} verify:${r.id.padEnd(22)}  (${r.label})  ${formatDuration(r.elapsed)}`);
  }
  console.log('');

  const failures = results.filter((r) => !r.passed);
  if (failures.length === 0) {
    console.log('Acceptance gate: ALL PASS.');
    console.log('');
    console.log('HS implementation is production-ready within the documented envelope:');
    console.log(' - non-associated plasticity uses the unsymmetric analytic algorithmic tangent;');
    console.log(' - plastic HS Newton iterations dispatch to GMRES (CG forbidden);');
    console.log(' - admissibility certificate enforced at every accepted Gauss point;');
    console.log(' - plane-strain ε_zz is never mutated (Phase 3 fix);');
    console.log(' - elastic-tangent modified Newton retained as diagnostic fallback only.');
    process.exit(0);
  } else {
    console.log(`Acceptance gate: FAIL — ${failures.length} verifier(s) failed.`);
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - verify:${f.id}  (exit ${f.code})`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Acceptance runner crashed:', err);
  process.exit(2);
});
