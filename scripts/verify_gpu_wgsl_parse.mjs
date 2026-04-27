// SPDX-License-Identifier: AGPL-3.0-or-later
//
// True WGSL parser-validation pass.  Runs every kernel string through
// wgsl_reflect (Brendan Duncan's pure-JS WGSL parser).  Catches the issues
// the structural lint cannot: undefined identifiers, type mismatches,
// malformed function signatures, illegal array constructors, etc.
//
// wgsl_reflect's parser implements WGSL spec parsing — anything it accepts
// is grammatically valid; anything it rejects would also be rejected by a
// real WebGPU runtime's compile step.
//
// Run via:  node --experimental-vm-modules scripts/verify_gpu_wgsl_parse.mjs
//
// Requires Node ≥ 22 (because wgsl_reflect is shipped as ESM-only).
// =============================================================================

// Resolve wgsl_reflect via direct path: caller passes its location via
// VALIDATOR_WGSL_REFLECT_PATH (or defaults to a sibling node_modules install).
const wgslReflectPath = process.env.VALIDATOR_WGSL_REFLECT_PATH
  || '/tmp/wgsl-validator-tmp/node_modules/wgsl_reflect/wgsl_reflect.module.js';
const { WgslReflect } = await import(wgslReflectPath);
import * as blas from '../src/lib/cpt-app/deformation/gpu/wgsl/blas.js';
import * as elements from '../src/lib/cpt-app/deformation/gpu/wgsl/elements.js';
import * as mc from '../src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js';
import * as geo from '../src/lib/cpt-app/deformation/gpu/resident-geostatic.js';
import * as asm from '../src/lib/cpt-app/deformation/gpu/gpu-assembly.js';
import * as ds from '../src/lib/cpt-app/deformation/gpu/wgsl/ds.js';

const kernels = [];
const collect = (mod, modName) => {
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === 'string' && k.startsWith('KERNEL_') && k.endsWith('_WGSL')) {
      kernels.push({ name: `${modName}.${k}`, source: v });
    }
  }
};
collect(blas, 'blas');
collect(elements, 'elements');
collect(mc, 'mc');
collect(geo, 'geo');
collect(asm, 'asm');
// Plus DS_WGSL on its own (it is a prelude, not a kernel, but should also parse).
kernels.unshift({ name: 'ds.DS_WGSL', source: ds.DS_WGSL });

let pass = 0, fail = 0;
for (const { name, source } of kernels) {
  try {
    const reflect = new WgslReflect(source);
    const fnCount = reflect.functions.length;
    const entryCount = reflect.entry?.compute?.length || 0;
    process.stdout.write(`  [OK ] ${name.padEnd(40)} fns=${fnCount} computeEntries=${entryCount}\n`);
    pass += 1;
  } catch (err) {
    process.stdout.write(`  [FAIL] ${name.padEnd(40)} ${err?.message || err}\n`);
    fail += 1;
  }
}

process.stdout.write(`\n=== Summary ===\n`);
process.stdout.write(`  passed: ${pass}\n`);
process.stdout.write(`  failed: ${fail}\n`);
process.exit(fail ? 1 : 0);
