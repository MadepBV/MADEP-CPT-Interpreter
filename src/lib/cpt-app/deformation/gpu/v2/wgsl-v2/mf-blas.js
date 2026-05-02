// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// WebGPU v2 DS BLAS kernels.
// ============================================================================
//
// These kernels deliberately avoid uniform-buffer length parameters.  Safari /
// Apple-Metal worker runs have shown static uniform params reading as zero
// while storage buffers read correctly.  Lengths are derived from storage
// buffer sizes with arrayLength(), and scalar coefficients are supplied through
// tiny read-only storage buffers.

import { DS_WGSL } from '../../wgsl/ds.js';

export const KERNEL_MF_AXPY_WGSL = /* wgsl */ `
${DS_WGSL}

struct AxpyParams {
  alpha: vec2<f32>,
  n: u32,
  _pad: vec3<u32>
};

@group(0) @binding(0) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> y: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       params: AxpyParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  let n: u32 = min(arrayLength(&x), arrayLength(&y));
  if (i >= n) { return; }
  y[i] = dsAdd(dsMul(params.alpha, x[i]), y[i]);
}
`;

export const KERNEL_MF_AXPBY_WGSL = /* wgsl */ `
${DS_WGSL}

struct AxpbyParams {
  alpha: vec2<f32>,
  beta: vec2<f32>,
  n: u32,
  _pad: vec3<u32>
};

@group(0) @binding(0) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> y: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       params: AxpbyParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  let n: u32 = min(arrayLength(&x), arrayLength(&y));
  if (i >= n) { return; }
  y[i] = dsAdd(dsMul(params.alpha, x[i]), dsMul(params.beta, y[i]));
}
`;

export const KERNEL_MF_DOT_PASS1_WGSL = /* wgsl */ `
${DS_WGSL}

@group(0) @binding(0) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       y: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> partials: array<vec2<f32>>;

var<workgroup> shared_acc: array<vec2<f32>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(local_invocation_id)  lid: vec3<u32>,
        @builtin(workgroup_id)         wid: vec3<u32>) {
  let i: u32 = gid.x;
  let li: u32 = lid.x;
  let n: u32 = min(arrayLength(&x), arrayLength(&y));
  var partial: vec2<f32> = vec2<f32>(0.0, 0.0);
  if (i < n) {
    partial = dsMul(x[i], y[i]);
  }
  shared_acc[li] = partial;
  workgroupBarrier();

  for (var stride: u32 = 32u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      shared_acc[li] = dsAdd(shared_acc[li], shared_acc[li + stride]);
    }
    workgroupBarrier();
  }
  if (li == 0u && wid.x < arrayLength(&partials)) {
    partials[wid.x] = shared_acc[0];
  }
}
`;

export const KERNEL_MF_DOT_PASS2_WGSL = /* wgsl */ `
${DS_WGSL}

@group(0) @binding(0) var<storage, read>       partials: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> result: array<vec2<f32>>;

var<workgroup> shared_red: array<vec2<f32>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let li: u32 = lid.x;
  let n: u32 = arrayLength(&partials);
  var acc: vec2<f32> = vec2<f32>(0.0, 0.0);
  var idx: u32 = li;
  loop {
    if (idx >= n) { break; }
    acc = dsAdd(acc, partials[idx]);
    idx = idx + 64u;
  }
  shared_red[li] = acc;
  workgroupBarrier();
  for (var stride: u32 = 32u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      shared_red[li] = dsAdd(shared_red[li], shared_red[li + stride]);
    }
    workgroupBarrier();
  }
  if (li == 0u && arrayLength(&result) > 0u) {
    result[0] = shared_red[0];
  }
}
`;

export const MF_AXPY_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' },
    { binding: 2, type: 'read-only-storage' }
  ]
};

export const MF_AXPBY_LAYOUT = MF_AXPY_LAYOUT;

export const MF_DOT_PASS1_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'storage' }
  ]
};

export const MF_DOT_PASS2_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' }
  ]
};
