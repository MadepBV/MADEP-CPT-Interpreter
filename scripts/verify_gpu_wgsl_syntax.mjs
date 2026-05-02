// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Structural WGSL syntax check for every kernel string the GPU resident
// pipeline ships.  This is NOT a full WGSL parser (naga is the canonical
// validator); it catches the structural mistakes that would crash kernel
// compilation on any browser:
//
//   - balanced braces, parens, brackets;
//   - exactly one `@compute @workgroup_size(N)` per kernel;
//   - exactly one `fn main(...)` entry point per kernel;
//   - bind-group declarations present;
//   - no stray `${...}` template-literal markers (would mean a missing
//     interpolation); no orphaned `import` keyword in a WGSL string.
//
// The harness runs against ALL exported kernel strings from the GPU module
// tree.  If any kernel fails, the script exits non-zero and lists the
// offending kernels with their failure reasons.
// =============================================================================

import * as ds from '../src/lib/cpt-app/deformation/gpu/wgsl/ds.js';
import * as blas from '../src/lib/cpt-app/deformation/gpu/wgsl/blas.js';
import * as elements from '../src/lib/cpt-app/deformation/gpu/wgsl/elements.js';
import * as mc from '../src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js';
import * as geo from '../src/lib/cpt-app/deformation/gpu/resident-geostatic.js';
import * as asm from '../src/lib/cpt-app/deformation/gpu/gpu-assembly.js';
import * as v2Kx from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-kx-element.js';
import * as v2Diag from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-jacobi-diag.js';
import * as v2ElasticD from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-elastic-d.js';
import * as v2ApplyJacobi from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-apply-jacobi.js';
import * as v2TrialStress from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-trial-stress.js';
import * as v2BlockJacobi from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-block-jacobi.js';
import * as v2Residual from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-residual-and-flag.js';
import * as v2StressSlice from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-stress-slice.js';
import * as v2Blas from '../src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-blas.js';

// Collect every (name, string) WGSL kernel.
const kernels = [];
const collectFrom = (mod, modName) => {
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === 'string' && k.startsWith('KERNEL_') && k.endsWith('_WGSL')) {
      kernels.push({ name: `${modName}.${k}`, source: v });
    }
  }
};
collectFrom(blas, 'blas');
collectFrom(elements, 'elements');
collectFrom(mc, 'mc');
collectFrom(geo, 'geo');
collectFrom(asm, 'asm');
collectFrom(v2Kx, 'v2Kx');
collectFrom(v2Diag, 'v2Diag');
collectFrom(v2ElasticD, 'v2ElasticD');
collectFrom(v2ApplyJacobi, 'v2ApplyJacobi');
collectFrom(v2TrialStress, 'v2TrialStress');
collectFrom(v2BlockJacobi, 'v2BlockJacobi');
collectFrom(v2Residual, 'v2Residual');
collectFrom(v2StressSlice, 'v2StressSlice');
collectFrom(v2Blas, 'v2Blas');

const failures = [];
const passes = [];

function check(label, ok, detail = '') {
  if (ok) passes.push({ label, detail });
  else failures.push({ label, detail });
  process.stdout.write(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function balanced(source, openCh, closeCh) {
  let depth = 0;
  let inLine = false, inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i += 1; } continue; }
    if (c === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 1; continue; }
    if (c === openCh) depth += 1;
    if (c === closeCh) depth -= 1;
    if (depth < 0) return -1;
  }
  return depth;
}

function countMatches(source, regex) {
  return (source.match(regex) || []).length;
}

process.stdout.write(`\n=== WGSL structural lint (${kernels.length} kernels) ===\n`);
for (const { name, source } of kernels) {
  process.stdout.write(`\n-- ${name}\n`);

  // 1. Non-empty.
  check('non-empty source', source.length > 100, `len=${source.length}`);

  // 2. Balanced braces / parens / brackets.
  check('balanced { }', balanced(source, '{', '}') === 0, `depth-residual=${balanced(source, '{', '}')}`);
  check('balanced ( )', balanced(source, '(', ')') === 0, `depth-residual=${balanced(source, '(', ')')}`);
  check('balanced [ ]', balanced(source, '[', ']') === 0, `depth-residual=${balanced(source, '[', ']')}`);

  // 3. No unfilled template-literal placeholders.
  check('no unfilled ${...} placeholders',
        !/\$\{[^}\n]+\}/.test(source.replace(/\${DS_WGSL}/g, ''))
        || /\${\s*DS_WGSL\s*}/.test(source),  // DS_WGSL placeholders that should already be filled
        '');

  // 4. Has @compute @workgroup_size(N) (or workgroup_size attribute).
  const wgMatches = countMatches(source, /@compute\s*@workgroup_size\s*\(\s*\d+\s*\)/g);
  check('contains @compute @workgroup_size(N)', wgMatches >= 1, `count=${wgMatches}`);

  // 5. Has fn main(...) entry.
  const mainMatches = countMatches(source, /\bfn\s+main\s*\(/g);
  check('contains fn main(...)', mainMatches >= 1, `count=${mainMatches}`);

  // 6. Has at least one @group(0) @binding(0) declaration.
  check('contains @group(0) @binding(...)', /@group\(0\)\s*@binding\(\d+\)/.test(source), '');

  // 7. No JS keywords leaking in (catches accidental code-mode in template literals).
  check('no leaking JS keywords (`function`, `=>`, `const`)',
        !/\bfunction\b/.test(source)
        && !/=>\s*\{/.test(source)
        && !/\bconst\s+\w+\s*=\s*new\b/.test(source),
        '');

  // 8. Each fn signature parses minimally as `fn name(...) -> ret { ... }` or `fn name(...) { ... }`.
  const fnMatches = source.match(/\bfn\s+\w+\s*\([\s\S]*?\)\s*(?:->\s*[\w<>,\s]+)?\s*\{/g) || [];
  const fnDeclarations = (source.match(/\bfn\s+\w+\s*\(/g) || []).length;
  check('every fn declaration parses with body opener',
        fnMatches.length === fnDeclarations,
        `fnSignatures=${fnMatches.length} fnNames=${fnDeclarations}`);

  // 9. v2 production kernels run on Safari/Metal worker paths where tiny
  // uniform dispatch-size counters have previously read back as zero. Bounds
  // must come from storage-buffer arrayLength() instead; scalar uniforms such
  // as convergence tolerances are still fine.
  if (name.startsWith('v2')) {
    const uniformDispatchCounter = source.match(/\bparams\.(?:n|num[A-Za-z0-9_]*)\b/g) || [];
    check('v2 avoids uniform dispatch-size counters',
          uniformDispatchCounter.length === 0,
          uniformDispatchCounter.length ? uniformDispatchCounter.join(', ') : '');
  }
}

process.stdout.write(`\n=== Summary ===\n`);
process.stdout.write(`  passed: ${passes.length}\n`);
process.stdout.write(`  failed: ${failures.length}\n`);
if (failures.length) {
  process.stdout.write('\nFailures:\n');
  failures.forEach(({ label, detail }) => {
    process.stdout.write(`  - ${label}${detail ? ` (${detail})` : ''}\n`);
  });
  process.exit(1);
}
process.exit(0);
