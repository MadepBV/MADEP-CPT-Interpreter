// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Voigt-6 → Voigt-3 stress slicer.
// =============================================================================
//
// v1's `KERNEL_INTERNAL_FORCE_T3/T6_WGSL` consumes a per-GP stress array of
// 3 DS values per GP — the in-plane components (σxx, σyy, σxy).  v2 stores
// the full Voigt-6 stress (σxx, σyy, σzz, σxy, σyz, σxz) per GP because the
// MC return mapping needs σzz for the principal-stress decomposition.
//
// Before dispatching v1's internal-force kernel from v2, we must extract
// the (xx, yy, xy) triple from the Voigt-6 buffer into a Voigt-3 buffer.
// Voigt-6 layout: [xx, yy, zz, xy, yz, xz]; we want indices 0, 1, 3.
// One thread per GP.

export const KERNEL_MF_STRESS_VOIGT6_TO_VOIGT3_WGSL = /* wgsl */ `
struct SliceParams { numGp: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       sigmaVoigt6: array<vec2<f32>>;   // 6 DS per GP
@group(0) @binding(1) var<storage, read_write> sigmaVoigt3: array<vec2<f32>>;   // 3 DS per GP
@group(0) @binding(2) var<uniform>             params:      SliceParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  let numGp: u32 = min(arrayLength(&sigmaVoigt6) / 6u, arrayLength(&sigmaVoigt3) / 3u);
  if (gp >= numGp) { return; }
  let v6: u32 = gp * 6u;
  let v3: u32 = gp * 3u;
  sigmaVoigt3[v3 + 0u] = sigmaVoigt6[v6 + 0u];   // σxx
  sigmaVoigt3[v3 + 1u] = sigmaVoigt6[v6 + 1u];   // σyy
  sigmaVoigt3[v3 + 2u] = sigmaVoigt6[v6 + 3u];   // σxy
}
`;

export const MF_STRESS_VOIGT6_TO_VOIGT3_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' },
    { binding: 2, type: 'uniform' }
  ]
};
