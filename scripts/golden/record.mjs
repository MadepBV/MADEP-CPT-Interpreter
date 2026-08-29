#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Records every Node-tier golden (Tier A pure modules + Tier B controller-under-Node)
// into tests/golden/node/**. Use once for the baseline, then prefer `check.mjs --update`
// (which touches only failing cases and makes the change reviewable). --filter <glob>
// scopes to a suite (`layers`) or a case (`layers/short.*`).
import { run, parseArgs } from './lib/runner.mjs';
const args = parseArgs(process.argv.slice(2));
process.exit(await run({ mode: 'record', filter: args.filter, list: args.list }));
