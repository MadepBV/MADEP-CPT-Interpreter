// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU-resident reductions: residual subtract + norm-squared + convergence
// flag in a single command-buffer chain.  This eliminates the per-iteration
// CPU readback that v1 (and v2's elastic CG) does for residual norm and
// convergence test.
//
// Three kernels:
//   - KERNEL_MF_RESID_FROM_FINT_WGSL   r := b - F_int  (DS subtract; one thread per free DOF)
//   - KERNEL_MF_MC_STATS_WGSL          per-workgroup reduction over MC flags/branches
//   - KERNEL_MF_MC_STATS_FINAL_WGSL    final MC stats reduction to one u32[4]
//   - KERNEL_MF_DOT_PASS1_FUSED_WGSL   per-workgroup partial sum of <r, r>  (re-uses pattern from v1's blas dot)
//   - KERNEL_MF_CONVERGE_FLAG_WGSL     reads scalar from dotResult, writes a u32 flag
//                                       to a tiny status buffer if ||r|| <= target.
//
// The status buffer (4 u32 = 16 B) holds:
//     [0] convergedFlag (0 or 1)
//     [1] iterCount
//     [2] reserved
//     [3] reserved
//
// Subsequent kernel invocations check the flag at entry and early-return,
// turning a "max-iter encoded up-front" command buffer into an effective
// "stop on convergence" without any CPU readback inside the iteration loop.

import { DS_WGSL } from '../../wgsl/ds.js';

// -----------------------------------------------------------------------------
// r := b - F_int     (DS subtract, one thread per free DOF).
// -----------------------------------------------------------------------------
export const KERNEL_MF_RESID_FROM_FINT_WGSL = /* wgsl */ `
${DS_WGSL}

struct ResidParams { numFree: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       b:    array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       fInt: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> r:    array<vec2<f32>>;
@group(0) @binding(3) var<uniform>             params: ResidParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  let n: u32 = min(min(arrayLength(&b), arrayLength(&fInt)), arrayLength(&r));
  if (i >= n) { return; }
  r[i] = dsSub(b[i], fInt[i]);
}
`;

export const MF_RESID_FROM_FINT_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'storage' },
    { binding: 3, type: 'uniform' }
  ]
};

// -----------------------------------------------------------------------------
// MC return-mapping stats.  First pass reduces the full per-GP flag arrays to
// one u32[4] partial per workgroup:
//   [0] failed local returns (mcConverged != 1)
//   [1] plastic branches (branchKind != 0)
//   [2] total Gauss points scanned
//   [3] reserved
// This replaces the old per-Newton full mcConverged readback on hard plastic
// cases, where numGp can dominate the CPU/GPU synchronization cost.
// -----------------------------------------------------------------------------
export const KERNEL_MF_MC_STATS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read>       converged:  array<u32>;
@group(0) @binding(1) var<storage, read>       branchKind: array<u32>;
@group(0) @binding(2) var<storage, read_write> statsOut:   array<u32>;

var<workgroup> failedShared:  array<u32, 64>;
var<workgroup> plasticShared: array<u32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(workgroup_id) wid: vec3<u32>,
        @builtin(num_workgroups) nwg: vec3<u32>) {
  let li: u32 = lid.x;
  let n: u32 = min(arrayLength(&converged), arrayLength(&branchKind));
  var failed: u32 = 0u;
  var plastic: u32 = 0u;
  let start: u32 = wid.x * 64u + li;
  let strideAll: u32 = max(1u, 64u * max(1u, nwg.x));
  var idx: u32 = start;
  loop {
    if (idx >= n) { break; }
    if (converged[idx] != 1u) { failed = failed + 1u; }
    if (branchKind[idx] != 0u) { plastic = plastic + 1u; }
    idx = idx + strideAll;
  }
  failedShared[li] = failed;
  plasticShared[li] = plastic;
  workgroupBarrier();

  for (var stride: u32 = 32u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      failedShared[li] = failedShared[li] + failedShared[li + stride];
      plasticShared[li] = plasticShared[li] + plasticShared[li + stride];
    }
    workgroupBarrier();
  }
  let outBase: u32 = wid.x * 4u;
  if (li == 0u && outBase + 3u < arrayLength(&statsOut)) {
    statsOut[outBase + 0u] = failedShared[0];
    statsOut[outBase + 1u] = plasticShared[0];
    statsOut[outBase + 2u] = n;
    statsOut[outBase + 3u] = 0u;
  }
}
`;

export const MF_MC_STATS_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'storage' }
  ]
};

// Final MC stats reduction.  Scans the u32[4] partials written by
// KERNEL_MF_MC_STATS_WGSL and writes one u32[4] final stats record.
export const KERNEL_MF_MC_STATS_FINAL_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read>       partials: array<u32>;
@group(0) @binding(1) var<storage, read_write> statsOut: array<u32>;

var<workgroup> failedShared:  array<u32, 64>;
var<workgroup> plasticShared: array<u32, 64>;
var<workgroup> totalShared:   array<u32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let li: u32 = lid.x;
  let groups: u32 = arrayLength(&partials) / 4u;
  var failed: u32 = 0u;
  var plastic: u32 = 0u;
  var total: u32 = 0u;
  var idx: u32 = li;
  loop {
    if (idx >= groups) { break; }
    let base: u32 = idx * 4u;
    failed = failed + partials[base + 0u];
    plastic = plastic + partials[base + 1u];
    total = max(total, partials[base + 2u]);
    idx = idx + 64u;
  }
  failedShared[li] = failed;
  plasticShared[li] = plastic;
  totalShared[li] = total;
  workgroupBarrier();

  for (var stride: u32 = 32u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      failedShared[li] = failedShared[li] + failedShared[li + stride];
      plasticShared[li] = plasticShared[li] + plasticShared[li + stride];
      totalShared[li] = max(totalShared[li], totalShared[li + stride]);
    }
    workgroupBarrier();
  }
  if (li == 0u && arrayLength(&statsOut) >= 4u) {
    statsOut[0] = failedShared[0];
    statsOut[1] = plasticShared[0];
    statsOut[2] = totalShared[0];
    statsOut[3] = 0u;
  }
}
`;

export const MF_MC_STATS_FINAL_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' }
  ]
};

// -----------------------------------------------------------------------------
// Convergence flag: reads the scalar in `dotResult` (interpreted as r·r);
// compares Math.sqrt of it against `targetTolSq` (the squared tolerance);
// writes a single u32 to status[0] if converged.
//
// IMPORTANT: this kernel does the comparison in f32 — fine for the
// convergence test since the tolerance is much larger than f32 precision.
// The DS dot result is faithful at f64 magnitude; we just compare the
// .hi component (to 1 ulp) against the target threshold.
// -----------------------------------------------------------------------------
export const KERNEL_MF_CONVERGE_FLAG_WGSL = /* wgsl */ `
${DS_WGSL}

struct ConvergeParams {
  targetTolSq: vec2<f32>,    // DS scalar: tolerance squared
  _pad: vec2<f32>
};

@group(0) @binding(0) var<storage, read>       dotResult: array<vec2<f32>>;   // r·r (DS scalar)
@group(0) @binding(1) var<storage, read_write> status:    array<u32>;          // 4 u32: convergedFlag, iter, _, _
@group(0) @binding(2) var<storage, read>       params:    ConvergeParams;

@compute @workgroup_size(1)
fn main() {
  if (status[0] == 1u) { return; }      // already converged — preserve flag
  let rr: vec2<f32> = dotResult[0];
  let rrF: f32 = rr.x + rr.y;
  let tol: f32 = params.targetTolSq.x + params.targetTolSq.y;
  if (rrF <= tol) {
    status[0] = 1u;
  } else {
    status[0] = 0u;
  }
  status[1] = status[1] + 1u;            // iter counter
}
`;

export const MF_CONVERGE_FLAG_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' },
    { binding: 2, type: 'read-only-storage' }
  ]
};

// -----------------------------------------------------------------------------
// Reset the status buffer at the top of a fresh CG/BiCGStab run.
// -----------------------------------------------------------------------------
export const KERNEL_MF_RESET_STATUS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> status: array<u32>;

@compute @workgroup_size(1)
fn main() {
  status[0] = 0u;
  status[1] = 0u;
  status[2] = 0u;
  status[3] = 0u;
}
`;

export const MF_RESET_STATUS_LAYOUT = {
  entries: [{ binding: 0, type: 'storage' }]
};
