// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Apply Jacobi preconditioner (elementwise z = mInv * r).  One thread per row.

import { DS_WGSL } from '../../wgsl/ds.js';

export const KERNEL_MF_APPLY_JACOBI_WGSL = /* wgsl */ `
${DS_WGSL}

struct ApplyParams { n: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       mInv: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       r:    array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> z:    array<vec2<f32>>;
@group(0) @binding(3) var<uniform>             params: ApplyParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  let n: u32 = min(min(arrayLength(&mInv), arrayLength(&r)), arrayLength(&z));
  if (i >= n) { return; }
  z[i] = dsMul(mInv[i], r[i]);
}
`;

export const MF_APPLY_JACOBI_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'storage' },
    { binding: 3, type: 'uniform' }
  ]
};
