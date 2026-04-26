# T6 GPU acceleration plan

**Document status:** forward implementation specification
**Goal:** extend the GPU acceleration backend so that T6 (six-node, three-Gauss-point) elements receive the same speedup as T3 today, without disturbing the working T3 pipeline.

This guide assumes the T6 element implementation in [element-t6.js](../../src/lib/cpt-app/deformation/element-t6.js) is correct (verified via the patch tests in `verify_deformation_phase_1.mjs` and the load-conservation gate). The remaining work is purely on the GPU side.

---

## 1. What already works

**Sparse matvec is element-type-agnostic.** The Krylov inner loop for T6 already runs on the GPU when `useGpuAcceleration` is on. The matvec kernel sees only the assembled global K in ELLPACK form; whether each row came from T3 or T6 element blocks is invisible to it. **Do not change matvec — it is the largest GPU win and it is already working for T6.**

**Element-kernel calls are gated to T3 today.** The three solver entrypoints in [solver.js:316-346](../../src/lib/cpt-app/deformation/solver.js#L316-L346) all check `elementCache.kind !== 't3'` and return `null` for T6, which forces the CPU element path:

```js
if ((elementCaches || []).some((elementCache) => elementCache?.kind !== 't3')) return null;
```

So today the T6 solver runs:
- **GPU**: sparse matvec (the dominant cost in linear elastic and Stage 1 phases).
- **CPU**: element strain, internal force, elastic-stiffness assembly, MC return map, scatter into the global matrix.

**Where T6 GPU still leaves performance on the table:**
- Linear-elastic and Stage 1 reduced-stiffness runs spend ~30–40% of CPU time in element-strain and element-stiffness loops; offloading those to GPU is the second-tier win.
- Stage 2 plasticity is bounded by the per-Gauss MC return map (which stays on CPU), so the element-stiffness GPU win is smaller in absolute terms but proportionally similar.

---

## 2. Strategy

**Add T6 element kernels alongside T3, dispatching on `elementCache.kind` at the backend layer.** Do not generalize a single kernel to handle both element types — the strides, loop bounds, and output sizes are different enough that a unified kernel ends up either branchy (slow on GPU) or under-specified.

```
src/lib/cpt-app/deformation/gpu/
├── elements.js            (refactored — common strides, T3-specific functions remain, T6-specific functions added)
├── elements-t6.js         (NEW — T6 strides, B-packing, reference kernels)
├── cpu-f32-backend.js     (small — dispatches strain/force/stiffness on element type)
├── webgl-backend.js       (medium — adds T6 GPU kernels, dispatches on element type)
├── ellpack.js             (no change — matvec is element-agnostic)
├── probe.js               (no change)
├── double-single.js       (no change)
├── gpujs-runtime.js       (no change)
└── index.js               (no change beyond surfacing element capabilities)
```

The solver-side gate ([solver.js:316-346](../../src/lib/cpt-app/deformation/solver.js#L316-L346)) is loosened so that T6 calls also reach the backend; the backend itself is responsible for routing.

---

## 3. Data layout for T6 element kernels

### 3.1 B-matrix packing

T3: B is 3 × 6 = 18 floats per element, evaluated once at the centroid (constant strain).

T6: B is 3 × 12 = **36 floats per Gauss point**, and there are 3 Gauss points per element, so **108 floats per element**. Pack flat in (element, gp, row, col) order:

```
B_flat[element * 108 + gp * 36 + row * 12 + col]
```

Pre-compute on CPU at element-cache build time. T6 corners are constant (no need to recompute per Krylov iter), so the pack runs once per mesh, identical to today's T3 cache pattern.

### 3.2 Stride summary

| Quantity | T3 stride / element | T6 stride / element |
|---|---|---|
| `B` | 18 (= 3·6) | **108** (= 3 GP · 3 · 12) |
| `dofs` | 6 | **12** |
| `area` | 1 | 1 (still corner-triangle area; det J = 2·area is folded in via the Gauss weights) |
| input `tangent` (broadcast) | 9 | **27** (= 3 GP · 9) — one D per Gauss point |
| input `tangent` (broadcast across all elements) | 9 | 9 (still allowed for elastic-only runs where every Gauss point of every element shares D) |
| input `stress` | 3 | **9** (= 3 GP · 3) |
| output `strain` | 3 | **9** (= 3 GP · 3) |
| output `internalForce` | 6 | **12** (already Gauss-summed) |
| output `elasticStiffness` | 36 | **144** (already Gauss-summed) |

The constants live in `elements.js` and `elements-t6.js`:

```js
// elements.js (existing — keep)
export const T3_ELEMENT_B_STRIDE = 18;
export const T3_ELEMENT_DOF_STRIDE = 6;
// ... etc

// elements-t6.js (NEW)
export const T6_ELEMENT_B_STRIDE = 108;       // 3 GP × 3 rows × 12 cols
export const T6_ELEMENT_DOF_STRIDE = 12;
export const T6_ELEMENT_STRAIN_STRIDE = 9;    // 3 GP × 3 components
export const T6_ELEMENT_FORCE_STRIDE = 12;
export const T6_ELEMENT_TANGENT_STRIDE = 27;  // 3 GP × 9 (3×3 plane-strain D)
export const T6_ELEMENT_STIFFNESS_STRIDE = 144;
export const T6_GAUSS_WEIGHT = 1 / 6;         // GAUSS_T6_3PT.w from element-t6.js
```

Note: the existing `elements.js` constants (`ELEMENT_B_STRIDE = 18`, etc.) should stay — we want **T3-specific names** to avoid ambiguity. Rename them with a `T3_` prefix in a small refactor so call sites reading them are explicit about element type. This is a one-line search/replace and stops bugs where someone copies the T3 stride into a T6 context.

### 3.3 Memory budget

Per element T6 vs T3:
- B: 18 → 108 floats (×6).
- Stiffness output: 36 → 144 floats (×4).
- Total element-kernel buffer size grows by roughly **5× to 6×**.

For a 5,000-element mesh at f32: T3 buffers ≈ 420 KB; T6 buffers ≈ 2.5 MB. Well within WebGL2 texture budgets (max texture size on modern GPUs is 16384², so flat buffers of length up to 268M floats fit). The size-gate for `useGpuAcceleration` (currently 1500 free DOFs) does **not** need to change for T6 — what matters is per-iteration upload cost, and even at 5,000 T6 elements the upload is sub-millisecond.

---

## 4. CPU-f32 reference kernels (T6)

Add T6-flavoured reference functions in `elements-t6.js` that mirror the existing T3 ones. They are the deterministic baseline that the WebGL kernels must match within ~1e-5 relative.

```js
// elements-t6.js
import { GAUSS_T6_3PT, buildBMatrixT6AtGauss } from '../element-t6.js';

export function createElementKernelBufferT6(elementCount = 0) {
  const count = Math.max(Math.round(Number(elementCount) || 0), 0);
  return {
    elementCount: count,
    elementType: 't6',
    B:    new Float32Array(count * T6_ELEMENT_B_STRIDE),
    dofs: new Int32Array(count * T6_ELEMENT_DOF_STRIDE),
    area: new Float32Array(count),
    identityKey: null
  };
}

export function packElementKernelBufferT6(buffer, elementCaches) {
  for (let e = 0; e < elementCaches.length; e += 1) {
    const cache = elementCaches[e];
    const corners = cache.corners;
    const bBase = e * T6_ELEMENT_B_STRIDE;
    for (let g = 0; g < 3; g += 1) {
      const gp = GAUSS_T6_3PT[g];
      const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
      const gpBase = bBase + g * 36;
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 12; col += 1) {
          buffer.B[gpBase + row * 12 + col] = B[row][col];
        }
      }
    }
    const dofBase = e * T6_ELEMENT_DOF_STRIDE;
    for (let k = 0; k < 12; k += 1) buffer.dofs[dofBase + k] = cache.dofs[k];
    buffer.area[e] = cache.area;
  }
  buffer.identityKey = elementCaches;
}

// Reference functions: exact CPU-f64 forms used as the parity baseline.
export function elementStrainReferenceT6(buffer, displacement, out = null) { ... }
export function elementInternalForceReferenceT6(buffer, stressFlat, out = null) { ... }
export function elementElasticStiffnessReferenceT6(buffer, tangentFlat, out = null) { ... }
```

**`elementStrainReferenceT6` body:**

```js
export function elementStrainReferenceT6(buffer, displacement, out = null) {
  const N = buffer.elementCount;
  const result = out && out.length === N * T6_ELEMENT_STRAIN_STRIDE
    ? out
    : new Float64Array(N * T6_ELEMENT_STRAIN_STRIDE);
  for (let e = 0; e < N; e += 1) {
    const bBase = e * T6_ELEMENT_B_STRIDE;
    const dofBase = e * T6_ELEMENT_DOF_STRIDE;
    const u = new Float64Array(12);
    for (let k = 0; k < 12; k += 1) u[k] = Number(displacement?.[buffer.dofs[dofBase + k]]) || 0;
    const sBase = e * T6_ELEMENT_STRAIN_STRIDE;
    for (let g = 0; g < 3; g += 1) {
      const gpBase = bBase + g * 36;
      let exx = 0, eyy = 0, gxy = 0;
      for (let k = 0; k < 12; k += 1) {
        exx += buffer.B[gpBase + 0 * 12 + k] * u[k];
        eyy += buffer.B[gpBase + 1 * 12 + k] * u[k];
        gxy += buffer.B[gpBase + 2 * 12 + k] * u[k];
      }
      result[sBase + g * 3 + 0] = exx;
      result[sBase + g * 3 + 1] = eyy;
      result[sBase + g * 3 + 2] = gxy;
    }
  }
  return result;
}
```

**`elementInternalForceReferenceT6` body** — Gauss-summed:

```js
export function elementInternalForceReferenceT6(buffer, stressFlat, out = null) {
  const N = buffer.elementCount;
  const result = out && out.length === N * T6_ELEMENT_FORCE_STRIDE
    ? out
    : new Float64Array(N * T6_ELEMENT_FORCE_STRIDE);
  for (let e = 0; e < N; e += 1) {
    const bBase = e * T6_ELEMENT_B_STRIDE;
    const sigmaBase = e * T6_ELEMENT_STRAIN_STRIDE;
    const detJ = 2 * Number(buffer.area?.[e] || 0);
    const fBase = e * T6_ELEMENT_FORCE_STRIDE;
    for (let i = 0; i < 12; i += 1) result[fBase + i] = 0;
    for (let g = 0; g < 3; g += 1) {
      const gpBase = bBase + g * 36;
      const wDet = T6_GAUSS_WEIGHT * detJ;
      const sxx = Number(stressFlat?.[sigmaBase + g * 3 + 0]) || 0;
      const syy = Number(stressFlat?.[sigmaBase + g * 3 + 1]) || 0;
      const txy = Number(stressFlat?.[sigmaBase + g * 3 + 2]) || 0;
      for (let i = 0; i < 12; i += 1) {
        result[fBase + i] += wDet * (
          buffer.B[gpBase + 0 * 12 + i] * sxx
          + buffer.B[gpBase + 1 * 12 + i] * syy
          + buffer.B[gpBase + 2 * 12 + i] * txy
        );
      }
    }
  }
  return result;
}
```

**`elementElasticStiffnessReferenceT6` body** — Gauss-summed K_e[i,j]:

```js
export function elementElasticStiffnessReferenceT6(buffer, tangentFlat, out = null) {
  const N = buffer.elementCount;
  const result = out && out.length === N * T6_ELEMENT_STIFFNESS_STRIDE
    ? out
    : new Float64Array(N * T6_ELEMENT_STIFFNESS_STRIDE);
  // Allow a 9-float broadcast tangent (linear elastic case) or a per-Gauss
  // 27-float tangent (Stage 1 / Stage 2 plastic predictor).
  const broadcast = (tangentFlat?.length || 0) === 9;
  for (let e = 0; e < N; e += 1) {
    const bBase = e * T6_ELEMENT_B_STRIDE;
    const detJ = 2 * Number(buffer.area?.[e] || 0);
    const kBase = e * T6_ELEMENT_STIFFNESS_STRIDE;
    for (let kk = 0; kk < 144; kk += 1) result[kBase + kk] = 0;
    for (let g = 0; g < 3; g += 1) {
      const gpBase = bBase + g * 36;
      const wDet = T6_GAUSS_WEIGHT * detJ;
      const dBase = broadcast ? 0 : e * 27 + g * 9;
      const d00 = Number(tangentFlat?.[dBase + 0]) || 0;
      const d01 = Number(tangentFlat?.[dBase + 1]) || 0;
      const d02 = Number(tangentFlat?.[dBase + 2]) || 0;
      const d10 = Number(tangentFlat?.[dBase + 3]) || 0;
      const d11 = Number(tangentFlat?.[dBase + 4]) || 0;
      const d12 = Number(tangentFlat?.[dBase + 5]) || 0;
      const d20 = Number(tangentFlat?.[dBase + 6]) || 0;
      const d21 = Number(tangentFlat?.[dBase + 7]) || 0;
      const d22 = Number(tangentFlat?.[dBase + 8]) || 0;
      for (let i = 0; i < 12; i += 1) {
        const bi0 = buffer.B[gpBase + 0 * 12 + i];
        const bi1 = buffer.B[gpBase + 1 * 12 + i];
        const bi2 = buffer.B[gpBase + 2 * 12 + i];
        for (let j = 0; j < 12; j += 1) {
          const bj0 = buffer.B[gpBase + 0 * 12 + j];
          const bj1 = buffer.B[gpBase + 1 * 12 + j];
          const bj2 = buffer.B[gpBase + 2 * 12 + j];
          const db0 = d00 * bj0 + d01 * bj1 + d02 * bj2;
          const db1 = d10 * bj0 + d11 * bj1 + d12 * bj2;
          const db2 = d20 * bj0 + d21 * bj1 + d22 * bj2;
          result[kBase + i * 12 + j] += wDet * (bi0 * db0 + bi1 * db1 + bi2 * db2);
        }
      }
    }
  }
  return result;
}
```

These are bit-for-bit equivalent (in f64) to what `element-t6.js` `elementStiffnessT6FromTangents2D` and friends compute element by element. Their purpose is to provide the deterministic GPU-equivalent CPU reference for testing.

---

## 5. WebGL kernels (T6)

Three new kernels mirror the existing T3 ones in [webgl-backend.js](../../src/lib/cpt-app/deformation/gpu/webgl-backend.js):

### 5.1 `buildElementStrainKernelT6(gpu, elementCount)`

Output length: `elementCount * 9` (3 GP × 3 components per element).

```js
return gpu.createKernel(function (bFlat, dofsFlat, displacement) {
  const flatIndex = this.thread.x;
  const elementIndex = Math.floor(flatIndex / 9.0);
  const remainder = flatIndex - elementIndex * 9;
  const gpIndex = Math.floor(remainder / 3.0);
  const component = remainder - gpIndex * 3;

  const bElementBase = elementIndex * 108;
  const bGpBase = bElementBase + gpIndex * 36;
  const bRowBase = bGpBase + component * 12;
  const dofBase = elementIndex * 12;

  let sum = 0.0;
  for (let k = 0; k < 12; k++) {
    sum += bFlat[bRowBase + k] * displacement[dofsFlat[dofBase + k]];
  }
  return sum;
}, {
  output: [Math.max(elementCount * 9, 1)],
  pipeline: false,
  precision: 'single',
  optimizeFloatMemory: true
});
```

### 5.2 `buildElementInternalForceKernelT6(gpu, elementCount)`

Output length: `elementCount * 12`. The kernel performs the **3-Gauss-point sum** internally so the host doesn't reduce afterwards.

```js
return gpu.createKernel(function (bFlat, areaFlat, stressFlat) {
  const flatIndex = this.thread.x;
  const elementIndex = Math.floor(flatIndex / 12.0);
  const localDof = flatIndex - elementIndex * 12;
  const bElementBase = elementIndex * 108;
  const sigmaElementBase = elementIndex * 9;
  const detJ = 2.0 * areaFlat[elementIndex];
  const wDet = (1.0 / 6.0) * detJ;
  let sum = 0.0;
  for (let g = 0; g < 3; g++) {
    const bGpBase = bElementBase + g * 36;
    const sigmaBase = sigmaElementBase + g * 3;
    const sxx = stressFlat[sigmaBase];
    const syy = stressFlat[sigmaBase + 1];
    const txy = stressFlat[sigmaBase + 2];
    sum +=
      wDet * (bFlat[bGpBase + 0 * 12 + localDof] * sxx
            + bFlat[bGpBase + 1 * 12 + localDof] * syy
            + bFlat[bGpBase + 2 * 12 + localDof] * txy);
  }
  return sum;
}, {
  output: [Math.max(elementCount * 12, 1)],
  pipeline: false,
  precision: 'single',
  optimizeFloatMemory: true,
  loopMaxIterations: 3
});
```

### 5.3 `buildElementElasticStiffnessKernelT6(gpu, elementCount)`

Output length: `elementCount * 144`. Threads index `(element, i, j)` and the kernel sums over Gauss points.

```js
return gpu.createKernel(function (bFlat, areaFlat, tangentFlat, broadcastTangent) {
  const flatIndex = this.thread.x;
  const elementIndex = Math.floor(flatIndex / 144.0);
  const localOffset = flatIndex - elementIndex * 144;
  const i = Math.floor(localOffset / 12.0);
  const j = localOffset - i * 12;

  const bElementBase = elementIndex * 108;
  const detJ = 2.0 * areaFlat[elementIndex];
  const wDet = (1.0 / 6.0) * detJ;

  let sum = 0.0;
  for (let g = 0; g < 3; g++) {
    const bGpBase = bElementBase + g * 36;
    const dBase = broadcastTangent > 0.5 ? 0 : (elementIndex * 27 + g * 9);

    const bi0 = bFlat[bGpBase + 0 * 12 + i];
    const bi1 = bFlat[bGpBase + 1 * 12 + i];
    const bi2 = bFlat[bGpBase + 2 * 12 + i];
    const bj0 = bFlat[bGpBase + 0 * 12 + j];
    const bj1 = bFlat[bGpBase + 1 * 12 + j];
    const bj2 = bFlat[bGpBase + 2 * 12 + j];

    const db0 = tangentFlat[dBase    ] * bj0 + tangentFlat[dBase + 1] * bj1 + tangentFlat[dBase + 2] * bj2;
    const db1 = tangentFlat[dBase + 3] * bj0 + tangentFlat[dBase + 4] * bj1 + tangentFlat[dBase + 5] * bj2;
    const db2 = tangentFlat[dBase + 6] * bj0 + tangentFlat[dBase + 7] * bj1 + tangentFlat[dBase + 8] * bj2;

    sum += wDet * (bi0 * db0 + bi1 * db1 + bi2 * db2);
  }
  return sum;
}, {
  output: [Math.max(elementCount * 144, 1)],
  pipeline: false,
  precision: 'single',
  optimizeFloatMemory: true,
  loopMaxIterations: 3
});
```

### 5.4 Kernel-cache key

The webgl backend caches kernels by `(numRows, maxRowLen)` for matvec. For element kernels, cache by `(elementType, elementCount)`. The recompilation cost on shape change is fine — element count changes only on mesh rebuild.

### 5.5 Sanity probe per-kernel

Each new kernel ships with a 1-element sanity check on backend creation, identical in spirit to the matvec sanity probe in [webgl-backend.js:198](../../src/lib/cpt-app/deformation/gpu/webgl-backend.js#L198): build a synthetic 1-element T6, run the kernel, compare to the CPU reference, fail-safe back to CPU if the kernel diverges by more than `1e-3` relative on any output. **This check is non-negotiable** — it catches GPU.js compilation quirks (loop unrolling, math-precision differences) on day one rather than mid-run.

---

## 6. Backend dispatcher changes

### 6.1 `cpu-f32-backend.js`

Today the backend returns one element-kernel buffer. Extend to detect element type and dispatch:

```js
function ensureElementBuffer(elementCaches) {
  const kind = elementCaches?.[0]?.kind || 't3';
  // Reject mixed-element-type meshes (single-mesh assumption per T6 doc).
  if (elementCaches.some((c) => (c?.kind || 't3') !== kind)) {
    throw new Error('Element-kernel buffer received mixed element types; this configuration is not supported.');
  }
  if (kind === 't6') {
    return ensureElementKernelBufferT6(elementBufferT6, elementCaches);
  }
  return ensureElementKernelBufferT3(elementBufferT3, elementCaches);
}

function elementStrain(elementCaches, displacement) {
  const buffer = ensureElementBuffer(elementCaches);
  const narrowed = ensureFloat32Buffer(displacement, displacementF32Buffer);
  return buffer.elementType === 't6'
    ? elementStrainReferenceT6(buffer, narrowed)
    : elementStrainReference(buffer, narrowed);
}
```

Same pattern for `elementInternalForce` and `elementElasticStiffness`. The CPU-f32 backend's `name` and `precision` getters are unchanged — element type is orthogonal to precision.

### 6.2 `webgl-backend.js`

Two element-kernel buffer caches (T3 and T6) and a per-call dispatch on `elementCaches[0]?.kind`. The kernel cache holds compiled GPU.js kernels for both shapes; either is rebuilt only when the mesh element count changes.

The probe-time sanity check (§5.5) runs both T3 and T6 sanity probes when the backend is created. If T6 kernel compilation fails, the backend reports `supportsT6ElementKernels = false` while keeping `supportsT3ElementKernels = true`. The solver then routes T6 calls to CPU and T3 calls to GPU on the same backend — partial graceful degradation.

### 6.3 `solver.js` gate

Currently:

```js
function backendElementStrain(elementCaches, vector) {
  if ((elementCaches || []).some((cache) => cache?.kind !== 't3')) return null;
  ...
}
```

Replace with:

```js
function backendElementStrain(elementCaches, vector) {
  if (!activeMatvecBackend || typeof activeMatvecBackend.elementStrain !== 'function') return null;
  const kind = elementCaches?.[0]?.kind || 't3';
  if (kind === 't6' && !activeMatvecBackend.supportsT6ElementKernels) return null;
  if (kind === 't3' && !activeMatvecBackend.supportsT3ElementKernels) return null;
  try {
    return activeMatvecBackend.elementStrain(elementCaches, vector);
  } catch (error) {
    handleActiveBackendFailure('element-strain', error);
    return null;
  }
}
```

Same shape for the other two entrypoints.

---

## 7. Verification

### 7.1 Reference-vs-WebGL parity (mandatory)

Add to `verify_deformation_phase_1.mjs`:

- Build a small T6 mesh (single element minimum, four-element minimum recommended).
- Pack into both T6 element-kernel buffers (CPU-f32 reference + WebGL).
- Run all three kernels (strain, internal force, elastic stiffness) on a non-trivial displacement / stress / tangent input.
- Assert: WebGL output matches CPU-f64 reference to within **5e-5 relative** (matches the existing T3 parity tolerance).

The CPU-f64 reference is whatever `element-t6.js` itself computes, called through the existing solver-side `kernel.elementStiffness(...)` etc. The WebGL output is normalised through `normalizeKernelOutput`.

### 7.2 Solver-level parity (mandatory)

For each existing T3 GPU verification case (Cases 42–44 in `verify_deformation_phase_1.mjs`), add a T6 sibling case:

- Same problem, `meshElementType: 't6'`.
- Run with `useGpuAcceleration: false` (CPU baseline).
- Run with `useGpuAcceleration: true` (GPU element kernels active).
- Assert: max settlement, MC utilization, and final convergence state match within the same 1e-3 to 1e-2 envelope as the T3 cases.
- Assert: `result.solver.linearAlgebraBackend.name === 'webgl2-f32'` (or `'cpu-f64'` if probe failed) and that `result.solver.linearAlgebraBackend.elementKernels.t6 === true` is reported on a successful WebGL run.

### 7.3 Load conservation (mandatory)

Re-run the §11.5 load-conservation tests from [T6_mesh.md](T6_mesh.md) on both element-kernel paths. The internal-force assembly result must conserve total load to within `1e-10` relative on both T3 and T6, on both CPU and GPU. **This is the single most important test** — it catches `wDet`, sign, and Gauss-point-ordering mistakes in the GPU kernel that subtler tests miss.

### 7.4 Patch test on GPU

T6-A (constant strain) and T6-B (linear strain) from §11.1 of [T6_mesh.md](T6_mesh.md) must pass when the backend's `elementStrain` is called directly with a known displacement field. T6-A on a regular mesh validates basic plumbing; T6-B on a distorted mesh validates the per-Gauss B packing. Both must pass at the same precision (~5e-5 relative) as the CPU-f32 path because the kernel is single-precision.

### 7.5 Stage 2 plasticity smoke test

A tiny Stage 2 footing problem (single load step, ~50 elements) on T6 with GPU on. Assert the run converges, the safety phase reports the expected envelope, and the linear-iteration count stays within 4× of the T3-equivalent baseline. This catches active-set pathologies where per-Gauss tangent variation interacts badly with GPU f32 stiffness assembly.

---

## 8. Sequencing

1. **Refactor `elements.js` strides into `T3_*` names.** No behavior change. Single-PR mechanical rename. Verification: existing tests pass unchanged.
2. **Create `elements-t6.js` with strides + reference functions.** No backend wiring yet. Add unit tests in `verify_deformation_phase_1.mjs` that call the references directly with a hand-computed expected result (single element, known displacement / stress / tangent). Verification: hand-computed values match.
3. **Extend `cpu-f32-backend.js` to dispatch on element type.** Use the new T6 references. The WebGL backend is still T3-only at this point. Verification: T6 runs end-to-end with `linearAlgebraBackend: 'cpu-f32'` produce identical results to the CPU-f64 path within f32 tolerance, and the new §7.3 load-conservation tests pass on both element types.
4. **Add T6 WebGL kernels to `webgl-backend.js`.** Wire the per-kernel sanity probe. Verification: §7.1 reference-vs-WebGL parity tests pass.
5. **Loosen the solver-side gate.** §7.2 solver-level parity tests pass. §7.3 load-conservation passes on the GPU path. §7.4 patch test on GPU passes.
6. **Stage 2 smoke (§7.5) and final acceptance criteria.** Promote T6 + GPU to a default-allowed combination.

This sequencing keeps T3 GPU and T6 CPU paths working at every step; the only step that risks regression on T3 is step 1, and that's a mechanical rename behind a small test.

---

## 9. Risk register

- **Per-Gauss B packing order.** GPU.js indexes through `this.thread.x`; mismapping (element, gp, row, col) silently corrupts only some entries. The §7.1 parity test catches this on the first run because reference and kernel disagree on at least one entry.
- **Gauss weight constant.** The 3-point rule has `w = 1/6` per point on the reference triangle (with `det J = 2A`, the product `w · det J = A/3` per Gauss point and 3 GP × A/3 = A total — the consistent integral). Hard-code `1.0/6.0` in the kernel; do **not** read it from a uniform unless the kernel can support multi-point rules later. The patch test T6-A (§7.4) confirms the correct combined factor `w · det J`.
- **Single-precision drift in stiffness assembly.** K_e for T6 has ~1e6 magnitude entries while individual contributions are ~1e3; cancellations in `B^T D B` integration can lose 3–4 digits in f32. Already accepted in T3 GPU, but the T6 case is more sensitive because the Gauss sum compounds the rounding. Track this in the §7.5 Stage-2 smoke test by comparing iteration counts; if T6 GPU iter counts grow past 4× T3-CPU baseline, evaluate moving the elastic-stiffness kernel to **double-single** (mirror the existing matvec double-single path) before falling back to CPU.
- **Active-set transitions and per-Gauss D.** Stage 2 plasticity provides the GPU kernel a 27-float tangent (3 per-Gauss D) per element. If those tangents differ sharply across Gauss points (sharp active-set switching), the integrated stiffness can be near-singular. This is the same pathology as T6 on CPU; the GPU does not make it worse, but it does not solve it either. The Armijo line-search and adaptive continuation in `solver.js` handle it. Do not symmetrize tangents on the GPU as an "optimization".
- **Texture budget on very large meshes.** A 50,000-element T6 mesh allocates ~24 MB stiffness output. Within 16384² f32 texture budget. Beyond ~700,000 elements the stiffness output exceeds the texture budget; the backend should detect and downgrade element kernels to CPU at that point. Add a `checkTextureBudget('T6 stiffness', N * 144, maxTextureSize)` call in the backend constructor, mirroring the existing matvec check.
- **Mixed-element-type meshes.** The implementation rejects them explicitly. Engineering meshes are single-element-type (the UI provides one toggle for the whole run); enforcement protects against accidental construction of mixed caches.

---

## 10. Out of scope (future work)

- **Curved-edge isoparametric T6.** Variable Jacobian per Gauss point — needs a Jacobian buffer per (element, gp) and per-call recomputation. Defer until a project actually requests it.
- **7-point Gauss rule.** Same kernel structure with 7 instead of 3 in the loop — trivial extension once the 3-point version is solid. Useful only for stress-concentration problems where 3-point under-integrates.
- **GPU MC return map.** Same answer as before: don't. Branching, variable-iteration, and f64 sensitivity make it a poor GPU candidate. Leave on CPU per Gauss point.
- **GPU sparse assembly scatter.** Atomic adds into the global K. WebGL2 has no such primitive available through GPU.js. Stays on CPU.
- **WebGPU backend.** A separate effort with substantially different kernel ergonomics (compute shaders, bind groups, native f32). The structural plan here transfers; only the kernel bodies change.

---

## 11. File-change checklist

| File | Change | Effort |
|---|---|---|
| `gpu/elements.js` | rename T3 stride/function exports with `T3_` prefix; keep behavior unchanged | Small |
| `gpu/elements-t6.js` | **NEW** — T6 strides + buffer pack + 3 reference kernels (strain, internal force, elastic stiffness) | Medium |
| `gpu/cpu-f32-backend.js` | dispatch element-kernel calls on `elementCaches[0].kind`; carry both T3 and T6 buffers | Small-medium |
| `gpu/webgl-backend.js` | 3 new GPU.js kernels + caches, sanity probes, dispatch on element type, optional T6 unsupported flag | Medium |
| `gpu/index.js` | surface `supportsT3ElementKernels` and `supportsT6ElementKernels` on the returned info | Trivial |
| `solver.js` | loosen `backendElementStrain`/`InternalForce`/`ElasticStiffness` gates to allow T6 when backend supports it | Small |
| `verify_deformation_phase_1.mjs` | reference-vs-WebGL parity (one new case per kernel), solver-level parity (3 cases), load-conservation gate (T6 GPU), patch test T6-A/T6-B on GPU | Medium |

Total new lines of code: ~700, of which `elements-t6.js` is ~250, `webgl-backend.js` additions ~200, verification ~200, others ~50.

---

## 12. Acceptance criteria

T6 GPU element-kernel acceleration is considered production-ready when **all** the following hold:

1. `npm run check` and `npm run build` are clean with the T6 GPU path enabled.
2. All existing T3 GPU verification cases pass unchanged (Cases 42–44 in particular).
3. New reference-vs-WebGL parity tests pass at 5e-5 relative tolerance for all three T6 element kernels.
4. T6 patch tests T6-A and T6-B pass on the GPU element-kernel path (regular and distorted meshes).
5. T6 load-conservation tests pass on the GPU element-kernel path (1e-10 relative).
6. T6 solver-level parity (CPU vs GPU) at 1e-3 to 1e-2 relative on max settlement and MC utilization.
7. Stage 2 plasticity T6 smoke test converges with linear-iteration counts within 4× of the T3 CPU baseline.
8. Backend reports `supportsT6ElementKernels: true` in the run record's `linearAlgebraBackend` block when the WebGL kernels compile and pass the sanity probe.
9. Memory and texture-budget checks pass on the largest T6 verification mesh.

Once those criteria hold, T6 + `useGpuAcceleration: true` becomes a fully supported combination.
