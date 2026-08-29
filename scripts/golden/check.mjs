#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every Node-tier suite and compares against tests/golden/node/** (design §4.3):
//   node scripts/golden/check.mjs                 # exit 1 on any FAIL / NEW / MISSING
//   node scripts/golden/check.mjs --filter layers # one suite (glob on suite or suite/case)
//   node scripts/golden/check.mjs --update        # rewrite only failing/new cases
//   node scripts/golden/check.mjs --list          # list suites and tolerance classes
// Mismatches are written to tests/golden/.actual/ for `git diff --no-index`.
import { run, parseArgs } from './lib/runner.mjs';
const args = parseArgs(process.argv.slice(2));
process.exit(await run({ mode: 'check', filter: args.filter, update: args.update, list: args.list }));
