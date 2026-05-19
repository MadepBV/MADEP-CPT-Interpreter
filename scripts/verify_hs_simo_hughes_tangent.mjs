#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-5 runtime tangent gate. The C++ SH-2/3/4 harnesses are the canonical
// residual/FD parity checks for the cone, cap, and corner formulae. The WASM
// material-point oracle below verifies that the v11 runtime flag selects the
// Simo-Hughes mode through the live wire path.

import { spawnSync } from 'node:child_process';

function run(script, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed with status ${result.status}`);
  }
}

run('scripts/verify_hs_simo_hughes_phase_2.mjs');
run('scripts/verify_hs_simo_hughes_phase_3.mjs');
run('scripts/verify_hs_simo_hughes_phase_4.mjs');
run('scripts/verify_hs_tangent_oracle.mjs', {
  MADEP_HS_USE_SIMO_HUGHES: '1',
  MADEP_HS_CORNER_FD_CANONICAL: 'phase4'
});
