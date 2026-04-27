// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Mohr-Coulomb exact return mapping in principal-stress space.
// Plane strain, double-single arithmetic, Clausen-Damkilde-Andersen
// region-based dispatch with post-return promotion.
// ============================================================================
//
// The algorithm follows
//
//   Clausen, Damkilde, Andersen (2007), "An efficient return algorithm for
//   non-associated plasticity with linear yield criteria in principal stress
//   space", Computers & Structures 85, 1795-1807.
//
// In principal-stress space (σ1 ≥ σ2 ≥ σ3, compression-positive) the
// Mohr-Coulomb yield surface is a hexagonal cone with apex on the
// hydrostatic axis at σ_apex = c · cot φ.  With a tension cut-off σ3 ≥ -σ_T
// the admissible region is the cone truncated by the plane σ3 = -σ_T
// (capped if σ_T < c cot φ, otherwise the cap is inside the cone and
// inactive).
//
// For any inadmissible trial state σ^t, the projection back onto the
// admissible region lies in *exactly one* of the following sub-regions:
//
//   region 0  ELASTIC                                   (admissible already)
//   region 1  FACE_F13                                  (project along D·m_F13)
//   region 2  EDGE_S23_EQUAL    σ2 = σ3                 (project along D·m_F12, D·m_F13)
//   region 3  EDGE_S12_EQUAL    σ1 = σ2                 (project along D·m_F13, D·m_F23)
//   region 4  APEX_FORMAL       σ1 = σ2 = σ3 = c cot φ
//   region 5  TENSION_FACE_T3                            (project along D·m_T3)
//   region 6  TENSION_EDGE_T23  σ2 = σ3 = -σ_T          (T3 + the F12 surface)
//   region 7  TENSION_EDGE_F13_T3                       (F13 + T3)
//   region 8  TENSION_CORNER_S23_T3   σ2 = σ3 = -σ_T, F13 = 0
//   region 9  TENSION_CORNER_S12_T3   σ1 = σ2,         F13 = 0,  T3 = 0
//   region 10 TENSION_APEX_T123  σ1 = σ2 = σ3 = -σ_T
//
// The dispatcher's logic:
//
//   Step 1: classify regime by surface-function signs.
//     - F13 ≤ 0 AND T3 ≤ 0           → ELASTIC.
//     - T3  > 0  AND F13 ≤ 0          → tension regime  (regions 5-10).
//     - F13 > 0  AND T3  ≤ 0          → shear regime    (regions 1-4).
//     - F13 > 0  AND T3  > 0          → mixed regime; resolve by trying
//                                        TENSION_EDGE_F13_T3 first.
//
//   Step 2: in each regime, attempt the SIMPLEST candidate first
//     (face / single-surface), then check the ordering and admissibility
//     of the post-return state and PROMOTE to the next-larger active set
//     on a violation.  Promotion is deterministic and bounded in depth (at
//     most three promotions: face → edge → apex).
//
//   Step 3: at each level the active set is solved by a small linear
//     system (1×1, 2×2, 3×3) in DS arithmetic.  All linear systems are
//     SPD (associated flow) or general unsymmetric (non-associated); we
//     use Gaussian elimination with partial pivoting either way.
//
// The algorithm is provably correct (Clausen-Damkilde-Andersen, Theorem 1)
// and converges in O(1) work per Gauss point: at most one face return,
// one edge return, and one apex projection.

import { DS_WGSL } from './ds.js';
import {
  dsAdd, dsMul, dsAddF32, dsMulF32, dsNeg, dsRecip, dsDiv,
  dsSqrt, dsAbs, dsFromF64, dsToF64
} from './ds.js';

export const MC_BRANCH = Object.freeze({
  ELASTIC:                 0,
  FACE_F13:                1,
  EDGE_S23_EQUAL:          2,
  EDGE_S12_EQUAL:          3,
  APEX_FORMAL:             4,
  TENSION_FACE_T3:         5,
  TENSION_EDGE_T23:        6,
  TENSION_EDGE_F13_T3:     7,
  TENSION_CORNER_S23_T3:   8,
  TENSION_CORNER_S12_T3:   9,
  TENSION_APEX_T123:       10
});

// =============================================================================
// Primitives.  Eigenvalue solve, yield evaluations, gradients, elastic D.
// =============================================================================

// In-plane principal stresses for plane strain (closed form).  σzz is
// already a principal because σxz = σyz = 0; the other two come from the
// 2×2 block of (σxx, σyy, σxy).  Returns sortedPrincipal in descending
// order, the orientation parameters (center, halfDiff, R) needed to
// rotate the returned principal stress back to (xx, yy, zz, xy), and the
// kinds of each sorted slot.
export function principalStressesPlaneStrainDs(sigma) {
  const sxx = sigma[0];
  const syy = sigma[1];
  const szz = sigma[2];
  const sxy = sigma[3];
  const half = dsFromF64(0.5);
  const sum = dsAdd(sxx, syy);
  const diff = dsAdd(sxx, dsNeg(syy));
  const center = dsMul(sum, half);
  const halfDiff = dsMul(diff, half);
  const radSq = dsAdd(dsMul(halfDiff, halfDiff), dsMul(sxy, sxy));
  const R = dsSqrt(radSq);
  const sInPlanePlus = dsAdd(center, R);
  const sInPlaneMinus = dsAdd(center, dsNeg(R));
  const candidates = [
    { value: sInPlanePlus, kind: 'inPlane+' },
    { value: sInPlaneMinus, kind: 'inPlane-' },
    { value: szz, kind: 'zz' }
  ];
  candidates.sort((a, b) => dsToF64(b.value) - dsToF64(a.value));
  return {
    sortedPrincipal: candidates.map((c) => c.value),
    sortedKinds: candidates.map((c) => c.kind),
    inPlaneCenter: center,
    inPlaneHalfDiff: halfDiff,
    inPlaneRadius: R,
    sxy
  };
}

// Yield-and-cutoff functions in principal-stress space.
export function evaluateMcSurfaces({ sortedPrincipal, sinPhi, cosPhi, cohesion, tensionLimit }) {
  const [s1, s2, s3] = sortedPrincipal;
  const two = dsFromF64(2);
  const F12 = dsAdd(
    dsAdd(dsAdd(s1, dsNeg(s2)), dsNeg(dsMul(dsAdd(s1, s2), sinPhi))),
    dsNeg(dsMul(dsMul(two, cohesion), cosPhi))
  );
  const F13 = dsAdd(
    dsAdd(dsAdd(s1, dsNeg(s3)), dsNeg(dsMul(dsAdd(s1, s3), sinPhi))),
    dsNeg(dsMul(dsMul(two, cohesion), cosPhi))
  );
  const F23 = dsAdd(
    dsAdd(dsAdd(s2, dsNeg(s3)), dsNeg(dsMul(dsAdd(s2, s3), sinPhi))),
    dsNeg(dsMul(dsMul(two, cohesion), cosPhi))
  );
  const T3 = dsAdd(dsNeg(s3), dsNeg(tensionLimit));
  return { F12, F13, F23, T3 };
}

// Plastic-flow gradient `m_i` and yield-function gradient `n_i` in
// principal-stress space.  The four surfaces' gradients are constants in
// principal space (no σ-dependence beyond ψ / φ).
export function flowGradient(surfaceId, sinPsi) {
  const one = dsFromF64(1);
  const oneMinus = dsAdd(one, dsNeg(sinPsi));
  const negOnePlus = dsNeg(dsAdd(one, sinPsi));
  const zero = dsFromF64(0);
  const minusOne = dsFromF64(-1);
  switch (surfaceId) {
    case 'F12': return [oneMinus, negOnePlus, zero];
    case 'F13': return [oneMinus, zero, negOnePlus];
    case 'F23': return [zero, oneMinus, negOnePlus];
    case 'T3':  return [zero, zero, minusOne];
    default: throw new Error(`Unknown surface ${surfaceId}`);
  }
}

export function yieldGradient(surfaceId, sinPhi) {
  return flowGradient(surfaceId, sinPhi);
}

// Isotropic elastic stiffness in principal-stress space (3×3, row-major
// flat).  D_ii = lambda + 2G;  D_ij = lambda  (i ≠ j);  lambda = K - 2G/3.
export function elasticDsMatrixPrincipal(KBulk, G) {
  const lambda = dsAdd(KBulk, dsNeg(dsMul(dsFromF64(2 / 3), G)));
  const twoG = dsMul(dsFromF64(2), G);
  const diag = dsAdd(lambda, twoG);
  return [
    diag,   lambda, lambda,
    lambda, diag,   lambda,
    lambda, lambda, diag
  ];
}

// Compute D · m for a principal-space gradient (returns 3-vector in DS).
function applyD3x3(D, m) {
  const out = [dsFromF64(0), dsFromF64(0), dsFromF64(0)];
  for (let r = 0; r < 3; r += 1) {
    let acc = dsFromF64(0);
    for (let c = 0; c < 3; c += 1) {
      acc = dsAdd(acc, dsMul(D[r * 3 + c], m[c]));
    }
    out[r] = acc;
  }
  return out;
}

// Compute n · v (3-vector dot product in DS).
function dot3(n, v) {
  let acc = dsFromF64(0);
  for (let r = 0; r < 3; r += 1) acc = dsAdd(acc, dsMul(n[r], v[r]));
  return acc;
}

// =============================================================================
// k×k DS linear solve via LU with partial pivoting.  Used for 1×1, 2×2, 3×3
// active-set systems.
// =============================================================================
export function solveDsLinear(matFlat, rhs, k) {
  const A = matFlat.map((v) => [v[0], v[1]]);
  const b = rhs.map((v) => [v[0], v[1]]);
  for (let col = 0; col < k; col += 1) {
    let pivotRow = col;
    let pivotMag = Math.abs(dsToF64(A[col * k + col]));
    for (let r = col + 1; r < k; r += 1) {
      const mag = Math.abs(dsToF64(A[r * k + col]));
      if (mag > pivotMag) { pivotMag = mag; pivotRow = r; }
    }
    if (pivotMag < 1e-300) {
      throw new Error(`Singular matrix at column ${col}`);
    }
    if (pivotRow !== col) {
      for (let cc = 0; cc < k; cc += 1) {
        const tmp = A[col * k + cc];
        A[col * k + cc] = A[pivotRow * k + cc];
        A[pivotRow * k + cc] = tmp;
      }
      const tmp = b[col]; b[col] = b[pivotRow]; b[pivotRow] = tmp;
    }
    const invPivot = dsRecip(A[col * k + col]);
    for (let r = col + 1; r < k; r += 1) {
      const factor = dsMul(A[r * k + col], invPivot);
      for (let cc = col; cc < k; cc += 1) {
        A[r * k + cc] = dsAdd(A[r * k + cc], dsNeg(dsMul(factor, A[col * k + cc])));
      }
      b[r] = dsAdd(b[r], dsNeg(dsMul(factor, b[col])));
    }
  }
  const x = new Array(k);
  for (let r = k - 1; r >= 0; r -= 1) {
    let sum = b[r];
    for (let cc = r + 1; cc < k; cc += 1) {
      sum = dsAdd(sum, dsNeg(dsMul(A[r * k + cc], x[cc])));
    }
    x[r] = dsMul(sum, dsRecip(A[r * k + r]));
  }
  return x;
}

// =============================================================================
// Per-branch return-mapping kernels.  Each returns the post-return
// principal stress (σ1', σ2', σ3') in DS plus the plastic multipliers.
// =============================================================================

// Single-surface FACE_F13 return.
function faceF13Return({ sortedPrincipal, F13, sinPhi, sinPsi, KBulk, G }) {
  const D = elasticDsMatrixPrincipal(KBulk, G);
  const n = yieldGradient('F13', sinPhi);
  const m = flowGradient('F13', sinPsi);
  const Dm = applyD3x3(D, m);
  const C = dot3(n, Dm);                      // scalar
  const lambda = dsMul(F13, dsRecip(C));      // F13 / C
  const sigma = sortedPrincipal.map((s, r) => dsAdd(s, dsNeg(dsMul(Dm[r], lambda))));
  return { sigma, lambda: [lambda], n: [n], m: [m], Dm: [Dm], C };
}

// Two-surface return for an edge {S_a, S_b}.  Solves a 2×2 system.
function twoSurfaceReturn({ sortedPrincipal, surfaces, ids, sinPhi, sinPsi, KBulk, G }) {
  const D = elasticDsMatrixPrincipal(KBulk, G);
  const n0 = yieldGradient(ids[0], sinPhi);
  const n1 = yieldGradient(ids[1], sinPhi);
  const m0 = flowGradient(ids[0], sinPsi);
  const m1 = flowGradient(ids[1], sinPsi);
  const Dm0 = applyD3x3(D, m0);
  const Dm1 = applyD3x3(D, m1);
  // C = [[n0·Dm0, n0·Dm1], [n1·Dm0, n1·Dm1]]
  const C = [dot3(n0, Dm0), dot3(n0, Dm1), dot3(n1, Dm0), dot3(n1, Dm1)];
  const rhs = [surfaces[ids[0]], surfaces[ids[1]]];
  let lambda;
  try { lambda = solveDsLinear(C, rhs, 2); }
  catch { return { converged: false }; }
  const sigma = sortedPrincipal.map((s, r) => {
    let acc = s;
    acc = dsAdd(acc, dsNeg(dsMul(Dm0[r], lambda[0])));
    acc = dsAdd(acc, dsNeg(dsMul(Dm1[r], lambda[1])));
    return acc;
  });
  return {
    converged: true,
    sigma,
    lambda,
    n: [n0, n1],
    m: [m0, m1],
    Dm: [Dm0, Dm1],
    C
  };
}

// Three-surface return for a corner {S_a, S_b, S_c}.  Solves a 3×3 system.
function threeSurfaceReturn({ sortedPrincipal, surfaces, ids, sinPhi, sinPsi, KBulk, G }) {
  const D = elasticDsMatrixPrincipal(KBulk, G);
  const n = ids.map((id) => yieldGradient(id, sinPhi));
  const m = ids.map((id) => flowGradient(id, sinPsi));
  const Dm = m.map((mi) => applyD3x3(D, mi));
  const C = [
    dot3(n[0], Dm[0]), dot3(n[0], Dm[1]), dot3(n[0], Dm[2]),
    dot3(n[1], Dm[0]), dot3(n[1], Dm[1]), dot3(n[1], Dm[2]),
    dot3(n[2], Dm[0]), dot3(n[2], Dm[1]), dot3(n[2], Dm[2])
  ];
  const rhs = ids.map((id) => surfaces[id]);
  let lambda;
  try { lambda = solveDsLinear(C, rhs, 3); }
  catch { return { converged: false }; }
  const sigma = sortedPrincipal.map((s, r) => {
    let acc = s;
    for (let j = 0; j < 3; j += 1) acc = dsAdd(acc, dsNeg(dsMul(Dm[j][r], lambda[j])));
    return acc;
  });
  return { converged: true, sigma, lambda, n, m, Dm, C };
}

// Hydrostatic apex projection.  Returns σ' = (a, a, a) where a is the
// shear-cone apex stress c · cot φ.
function apexFormalReturn({ cohesion, sinPhi, cosPhi }) {
  // cot φ = cos φ / sin φ.  Guard against sin φ → 0 (cohesionless apex
  // is at infinity; in that case the formal apex doesn't exist and the
  // caller should not have routed us here).
  const sinPhiF = dsToF64(sinPhi);
  if (Math.abs(sinPhiF) < 1e-15) {
    return { converged: false, reason: 'apex-rank-deficient-zero-friction' };
  }
  const cotPhi = dsDiv(cosPhi, sinPhi);
  const apex = dsMul(cohesion, cotPhi);
  return { converged: true, sigma: [apex, apex, apex], lambda: [], apex };
}

// Tension-cap apex projection: σ' = (-σ_T, -σ_T, -σ_T).
function tensionApexReturn({ tensionLimit }) {
  const minusT = dsNeg(tensionLimit);
  return { converged: true, sigma: [minusT, minusT, minusT], lambda: [] };
}

// =============================================================================
// Region predicates.  Tolerances are absolute values in stress units; the
// caller chooses them based on the local stress scale.
// =============================================================================
const ORDERING_TOL = 1e-9;

function violatesUpperEdge(sigma) {
  return dsToF64(sigma[0]) + ORDERING_TOL < dsToF64(sigma[1]);
}

function violatesLowerEdge(sigma) {
  return dsToF64(sigma[1]) + ORDERING_TOL < dsToF64(sigma[2]);
}

function surfaceValueAt(sigma, surfaceId, sinPhi, cosPhi, cohesion, tensionLimit) {
  const surfaces = evaluateMcSurfaces({
    sortedPrincipal: sigma, sinPhi, cosPhi, cohesion, tensionLimit
  });
  return dsToF64(surfaces[surfaceId]);
}

// =============================================================================
// Shear-regime dispatch.  Tries FACE_F13 first; promotes to edge or apex on
// ordering violation.
// =============================================================================
function dispatchShearReturn(ctx) {
  const { sortedPrincipal, surfaces, sinPhi, cosPhi, sinPsi, cohesion, tensionLimit, KBulk, G } = ctx;
  const tol = 1e-8;

  // Try FACE_F13.
  const face = faceF13Return({ sortedPrincipal, F13: surfaces.F13, sinPhi, sinPsi, KBulk, G });
  const upperVio = violatesUpperEdge(face.sigma);
  const lowerVio = violatesLowerEdge(face.sigma);
  // Tension promotion: if FACE_F13 brought σ3 above -σ_T (i.e. didn't reach
  // the tension cap) the shear-only return is insufficient; we need T3 in
  // the active set.  Re-evaluate T3 at the post-return state and, if still
  // violated, route through the mixed-regime dispatcher with the proper
  // active set {F13, T3} (and further promotion as needed).
  const postFaceT3 = dsToF64(dsAdd(dsNeg(face.sigma[2]), dsNeg(tensionLimit)));
  if (postFaceT3 > tol && !upperVio && !lowerVio) {
    return dispatchMixedReturn(ctx);
  }

  if (!upperVio && !lowerVio) {
    return {
      converged: true, branchKind: MC_BRANCH.FACE_F13,
      sigma: face.sigma, lambda: face.lambda,
      M: face.m, N: face.n, DM: face.Dm
    };
  }
  if (upperVio && lowerVio) {
    const apex = apexFormalReturn({ cohesion, sinPhi, cosPhi });
    if (!apex.converged) return apex;
    return {
      converged: true, branchKind: MC_BRANCH.APEX_FORMAL,
      sigma: apex.sigma, lambda: apex.lambda,
      M: null, N: null, DM: null
    };
  }
  if (lowerVio) {
    // EDGE_S23: σ2 = σ3, active {F12, F13}.
    const edge = twoSurfaceReturn({
      sortedPrincipal, surfaces, ids: ['F12', 'F13'], sinPhi, sinPsi, KBulk, G
    });
    if (!edge.converged) return { converged: false, reason: 'edge-S23-singular' };
    if (violatesUpperEdge(edge.sigma)) {
      const apex = apexFormalReturn({ cohesion, sinPhi, cosPhi });
      if (!apex.converged) return apex;
      return {
        converged: true, branchKind: MC_BRANCH.APEX_FORMAL,
        sigma: apex.sigma, lambda: apex.lambda,
        M: null, N: null, DM: null
      };
    }
    // Tension promotion check on the edge return.
    const postEdgeT3 = dsToF64(dsAdd(dsNeg(edge.sigma[2]), dsNeg(tensionLimit)));
    if (postEdgeT3 > tol) return dispatchMixedReturn(ctx);
    return {
      converged: true, branchKind: MC_BRANCH.EDGE_S23_EQUAL,
      sigma: edge.sigma, lambda: edge.lambda,
      M: edge.m, N: edge.n, DM: edge.Dm
    };
  }
  // upperVio.
  const edge = twoSurfaceReturn({
    sortedPrincipal, surfaces, ids: ['F13', 'F23'], sinPhi, sinPsi, KBulk, G
  });
  if (!edge.converged) return { converged: false, reason: 'edge-S12-singular' };
  if (violatesLowerEdge(edge.sigma)) {
    const apex = apexFormalReturn({ cohesion, sinPhi, cosPhi });
    if (!apex.converged) return apex;
    return {
      converged: true, branchKind: MC_BRANCH.APEX_FORMAL,
      sigma: apex.sigma, lambda: apex.lambda,
      M: null, N: null, DM: null
    };
  }
  const postEdgeT3 = dsToF64(dsAdd(dsNeg(edge.sigma[2]), dsNeg(tensionLimit)));
  if (postEdgeT3 > tol) return dispatchMixedReturn(ctx);
  return {
    converged: true, branchKind: MC_BRANCH.EDGE_S12_EQUAL,
    sigma: edge.sigma, lambda: edge.lambda,
    M: edge.m, N: edge.n, DM: edge.Dm
  };
}

// =============================================================================
// Tension-regime dispatch.  Tries TENSION_FACE_T3 first; promotes to
// tension edges / corners / apex on the various violations.
// =============================================================================
function dispatchTensionReturn(ctx) {
  const { sortedPrincipal, surfaces, sinPhi, cosPhi, sinPsi, cohesion, tensionLimit, KBulk, G } = ctx;
  const tol = 1e-8;

  // Count how many of the sorted trial principals violate the tension cap
  // σ_i ≥ -σ_T.  When two or three violate, the only feasible target is the
  // tension apex σ' = (-σ_T, -σ_T, -σ_T): a single-surface T3 return only
  // forces the most-tensile slot to the cap, leaving the others tensile and
  // requiring further returns whose post-return slot ordering scrambles
  // unhelpfully.  Direct projection is correct, fast, and admissible.
  const minusT = -dsToF64(tensionLimit);
  const violations = [
    dsToF64(sortedPrincipal[0]) < minusT - tol,
    dsToF64(sortedPrincipal[1]) < minusT - tol,
    dsToF64(sortedPrincipal[2]) < minusT - tol
  ];
  const violCount = violations.filter(Boolean).length;
  if (violCount >= 2) {
    const apex = tensionApexReturn({ tensionLimit });
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
      sigma: apex.sigma, lambda: apex.lambda,
      M: null, N: null, DM: null
    };
  }

  // Try TENSION_FACE_T3 alone.
  const face = (function () {
    const D = elasticDsMatrixPrincipal(KBulk, G);
    const n = yieldGradient('T3', sinPhi);
    const m = flowGradient('T3', sinPsi);
    const Dm = applyD3x3(D, m);
    const C = dot3(n, Dm);
    const lambda = dsMul(surfaces.T3, dsRecip(C));
    const sigma = sortedPrincipal.map((s, r) => dsAdd(s, dsNeg(dsMul(Dm[r], lambda))));
    return { sigma, lambda: [lambda], n: [n], m: [m], Dm: [Dm], C };
  })();

  // Re-evaluate surfaces at the post-return principal stress.
  const post = evaluateMcSurfaces({
    sortedPrincipal: face.sigma, sinPhi, cosPhi, cohesion, tensionLimit
  });
  const upperVio = violatesUpperEdge(face.sigma);
  const lowerVio = violatesLowerEdge(face.sigma);
  const f13Vio = dsToF64(post.F13) > tol;

  if (!upperVio && !lowerVio && !f13Vio) {
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_FACE_T3,
      sigma: face.sigma, lambda: face.lambda,
      M: face.m, N: face.n, DM: face.Dm
    };
  }

  // If F13 violated → activate F13 too: TENSION_EDGE_F13_T3.
  if (f13Vio) {
    const eft = twoSurfaceReturn({
      sortedPrincipal, surfaces, ids: ['F13', 'T3'], sinPhi, sinPsi, KBulk, G
    });
    if (!eft.converged) return { converged: false, reason: 'tension-edge-F13-T3-singular' };
    const upperVio2 = violatesUpperEdge(eft.sigma);
    const lowerVio2 = violatesLowerEdge(eft.sigma);
    if (!upperVio2 && !lowerVio2) {
      return {
        converged: true, branchKind: MC_BRANCH.TENSION_EDGE_F13_T3,
        sigma: eft.sigma, lambda: eft.lambda,
        M: eft.m, N: eft.n, DM: eft.Dm
      };
    }
    if (upperVio2 && lowerVio2) {
      const apex = tensionApexReturn({ tensionLimit });
      return {
        converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
        sigma: apex.sigma, lambda: apex.lambda,
        M: null, N: null, DM: null
      };
    }
    if (lowerVio2) {
      // TENSION_CORNER_S23_T3: F12, F13, T3 active (σ2 = σ3).
      const corner = threeSurfaceReturn({
        sortedPrincipal, surfaces, ids: ['F12', 'F13', 'T3'], sinPhi, sinPsi, KBulk, G
      });
      if (!corner.converged) return { converged: false, reason: 'tension-corner-S23-T3-singular' };
      if (violatesUpperEdge(corner.sigma)) {
        const apex = tensionApexReturn({ tensionLimit });
        return {
          converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
          sigma: apex.sigma, lambda: apex.lambda,
          M: null, N: null, DM: null
        };
      }
      return {
        converged: true, branchKind: MC_BRANCH.TENSION_CORNER_S23_T3,
        sigma: corner.sigma, lambda: corner.lambda,
        M: corner.m, N: corner.n, DM: corner.Dm
      };
    }
    // upperVio2: TENSION_CORNER_S12_T3 (F13, F23, T3).
    const corner = threeSurfaceReturn({
      sortedPrincipal, surfaces, ids: ['F13', 'F23', 'T3'], sinPhi, sinPsi, KBulk, G
    });
    if (!corner.converged) return { converged: false, reason: 'tension-corner-S12-T3-singular' };
    if (violatesLowerEdge(corner.sigma)) {
      const apex = tensionApexReturn({ tensionLimit });
      return {
        converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
        sigma: apex.sigma, lambda: apex.lambda,
        M: null, N: null, DM: null
      };
    }
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_CORNER_S12_T3,
      sigma: corner.sigma, lambda: corner.lambda,
      M: corner.m, N: corner.n, DM: corner.Dm
    };
  }

  // F13 not violated, but lower-edge or upper-edge violation under T3 alone.
  if (lowerVio) {
    // TENSION_EDGE_T23: T3 + the σ2 = σ3 constraint gives a 2-surface system
    // {F12=0 implicit when σ2=σ3 but with F12=0 acting as constraint, T3=0}.
    // Equivalent: solve {F12, T3} active.
    const eL = twoSurfaceReturn({
      sortedPrincipal, surfaces, ids: ['F12', 'T3'], sinPhi, sinPsi, KBulk, G
    });
    if (!eL.converged) return { converged: false, reason: 'tension-edge-T23-singular' };
    if (violatesUpperEdge(eL.sigma)) {
      const apex = tensionApexReturn({ tensionLimit });
      return {
        converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
        sigma: apex.sigma, lambda: apex.lambda,
        M: null, N: null, DM: null
      };
    }
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_EDGE_T23,
      sigma: eL.sigma, lambda: eL.lambda,
      M: eL.m, N: eL.n, DM: eL.Dm
    };
  }
  // upperVio:  σ1 = σ2 with T3 active.  Rare.  Solve {F23, T3} active.
  if (upperVio) {
    const eU = twoSurfaceReturn({
      sortedPrincipal, surfaces, ids: ['F23', 'T3'], sinPhi, sinPsi, KBulk, G
    });
    if (!eU.converged) return { converged: false, reason: 'tension-edge-T12-singular' };
    if (violatesLowerEdge(eU.sigma)) {
      const apex = tensionApexReturn({ tensionLimit });
      return {
        converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
        sigma: apex.sigma, lambda: apex.lambda,
        M: null, N: null, DM: null
      };
    }
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_EDGE_T23,    // upper variant lumped here for branch reporting
      sigma: eU.sigma, lambda: eU.lambda,
      M: eU.m, N: eU.n, DM: eU.Dm
    };
  }

  // Should be unreachable.
  return { converged: false, reason: 'tension-dispatch-fallthrough' };
}

// =============================================================================
// Mixed-regime dispatch (T3 > 0 AND F13 > 0 simultaneously at trial).
// We try TENSION_EDGE_F13_T3 first because both surfaces are simultaneously
// violated; if that yields ordering or further violations, we promote.
// =============================================================================
function dispatchMixedReturn(ctx) {
  const { sortedPrincipal, surfaces, sinPhi, cosPhi, sinPsi, cohesion, tensionLimit, KBulk, G } = ctx;
  const tol = 1e-8;

  // Same multi-violation pre-test as the tension dispatcher (see comment
  // there): if two or three trial principals already violate the tension
  // cap, the only feasible projection is the tension apex.
  const minusT = -dsToF64(tensionLimit);
  const violations = [
    dsToF64(sortedPrincipal[0]) < minusT - tol,
    dsToF64(sortedPrincipal[1]) < minusT - tol,
    dsToF64(sortedPrincipal[2]) < minusT - tol
  ];
  if (violations.filter(Boolean).length >= 2) {
    const apex = tensionApexReturn({ tensionLimit });
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
      sigma: apex.sigma, lambda: apex.lambda,
      M: null, N: null, DM: null
    };
  }

  const eft = twoSurfaceReturn({
    sortedPrincipal, surfaces, ids: ['F13', 'T3'], sinPhi, sinPsi, KBulk, G
  });
  if (!eft.converged) return { converged: false, reason: 'tension-edge-F13-T3-singular' };
  const upperVio = violatesUpperEdge(eft.sigma);
  const lowerVio = violatesLowerEdge(eft.sigma);

  if (!upperVio && !lowerVio) {
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_EDGE_F13_T3,
      sigma: eft.sigma, lambda: eft.lambda,
      M: eft.m, N: eft.n, DM: eft.Dm
    };
  }
  if (upperVio && lowerVio) {
    const apex = tensionApexReturn({ tensionLimit });
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
      sigma: apex.sigma, lambda: apex.lambda,
      M: null, N: null, DM: null
    };
  }
  if (lowerVio) {
    const corner = threeSurfaceReturn({
      sortedPrincipal, surfaces, ids: ['F12', 'F13', 'T3'], sinPhi, sinPsi, KBulk, G
    });
    if (!corner.converged) return { converged: false, reason: 'tension-corner-S23-T3-singular' };
    if (violatesUpperEdge(corner.sigma)) {
      const apex = tensionApexReturn({ tensionLimit });
      return {
        converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
        sigma: apex.sigma, lambda: apex.lambda,
        M: null, N: null, DM: null
      };
    }
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_CORNER_S23_T3,
      sigma: corner.sigma, lambda: corner.lambda,
      M: corner.m, N: corner.n, DM: corner.Dm
    };
  }
  // upperVio.
  const corner = threeSurfaceReturn({
    sortedPrincipal, surfaces, ids: ['F13', 'F23', 'T3'], sinPhi, sinPsi, KBulk, G
  });
  if (!corner.converged) return { converged: false, reason: 'tension-corner-S12-T3-singular' };
  if (violatesLowerEdge(corner.sigma)) {
    const apex = tensionApexReturn({ tensionLimit });
    return {
      converged: true, branchKind: MC_BRANCH.TENSION_APEX_T123,
      sigma: apex.sigma, lambda: apex.lambda,
      M: null, N: null, DM: null
    };
  }
  return {
    converged: true, branchKind: MC_BRANCH.TENSION_CORNER_S12_T3,
    sigma: corner.sigma, lambda: corner.lambda,
    M: corner.m, N: corner.n, DM: corner.Dm
  };
}

// =============================================================================
// Algorithmic tangent.  D_ep = D_e - D_e M (N^T D_e M)^-1 N^T D_e.
// Returns null for ELASTIC / pure apex branches (where the tangent is
// either D_e or zero respectively).
// =============================================================================
export function algorithmicTangentPrincipal({ M, N, DM, KBulk, G }) {
  if (!M || !N || !DM) return elasticDsMatrixPrincipal(KBulk, G);
  const k = M.length;
  const D = elasticDsMatrixPrincipal(KBulk, G);
  const C = new Array(k * k);
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      let acc = dsFromF64(0);
      for (let r = 0; r < 3; r += 1) {
        acc = dsAdd(acc, dsMul(N[i][r], DM[j][r]));
      }
      C[i * k + j] = acc;
    }
  }
  const Dep = new Array(9);
  for (let q = 0; q < 3; q += 1) {
    const rhs = new Array(k);
    for (let i = 0; i < k; i += 1) {
      let acc = dsFromF64(0);
      for (let r = 0; r < 3; r += 1) {
        acc = dsAdd(acc, dsMul(N[i][r], D[r * 3 + q]));
      }
      rhs[i] = acc;
    }
    let lambdaQ;
    try { lambdaQ = solveDsLinear(C, rhs, k); }
    catch { return null; }
    for (let r = 0; r < 3; r += 1) {
      let corr = dsFromF64(0);
      for (let j = 0; j < k; j += 1) {
        corr = dsAdd(corr, dsMul(DM[j][r], lambdaQ[j]));
      }
      Dep[r * 3 + q] = dsAdd(D[r * 3 + q], dsNeg(corr));
    }
  }
  return Dep;
}

// =============================================================================
// Top-level CPU reference.
// =============================================================================
export function cpuMcReturnMapping({ sigmaTrial, params }) {
  const { sinPhi, cosPhi, sinPsi, cosPsi, cohesion, tensionLimit, KBulk, G } = params;
  const ds6 = sigmaTrial.map((v) => Array.isArray(v) ? v : dsFromF64(v));
  const ctx = {
    sinPhi:       Array.isArray(sinPhi)       ? sinPhi       : dsFromF64(sinPhi),
    cosPhi:       Array.isArray(cosPhi)       ? cosPhi       : dsFromF64(cosPhi),
    sinPsi:       Array.isArray(sinPsi)       ? sinPsi       : dsFromF64(sinPsi),
    cosPsi:       Array.isArray(cosPsi)       ? cosPsi       : dsFromF64(cosPsi),
    cohesion:     Array.isArray(cohesion)     ? cohesion     : dsFromF64(cohesion),
    tensionLimit: Array.isArray(tensionLimit) ? tensionLimit : dsFromF64(tensionLimit),
    KBulk:        Array.isArray(KBulk)        ? KBulk        : dsFromF64(KBulk),
    G:            Array.isArray(G)            ? G            : dsFromF64(G)
  };
  const principal = principalStressesPlaneStrainDs(ds6);
  ctx.sortedPrincipal = principal.sortedPrincipal;
  ctx.surfaces = evaluateMcSurfaces({
    sortedPrincipal: principal.sortedPrincipal,
    sinPhi: ctx.sinPhi, cosPhi: ctx.cosPhi,
    cohesion: ctx.cohesion, tensionLimit: ctx.tensionLimit
  });

  const tol = 1e-8;
  const f13Pos = dsToF64(ctx.surfaces.F13) > tol;
  const t3Pos  = dsToF64(ctx.surfaces.T3)  > tol;

  let result;
  if (!f13Pos && !t3Pos) {
    result = {
      converged: true,
      branchKind: MC_BRANCH.ELASTIC,
      sigma: principal.sortedPrincipal.map((v) => [v[0], v[1]]),
      lambda: [],
      M: null, N: null, DM: null
    };
  } else if (f13Pos && t3Pos) {
    result = dispatchMixedReturn(ctx);
  } else if (t3Pos) {
    result = dispatchTensionReturn(ctx);
  } else {
    result = dispatchShearReturn(ctx);
  }

  if (!result.converged) {
    return { converged: false, reason: result.reason || 'unknown' };
  }
  const tangent = algorithmicTangentPrincipal({
    M: result.M, N: result.N, DM: result.DM, KBulk: ctx.KBulk, G: ctx.G
  });
  const sigmaReturned = principalToVoigt6(result.sigma, principal);
  return {
    converged: true,
    branchKind: result.branchKind,
    sigmaReturned,
    sortedReturned: result.sigma,
    lambda: result.lambda,
    algorithmicTangentPrincipal: tangent
  };
}

// =============================================================================
// Rotate principal-stress space back to Voigt-6 (xx, yy, zz, xy, 0, 0).
//
// In plane strain, σzz is one of the three sorted principals; the other
// two are eigenvalues of the 2×2 in-plane block.  The eigenvector
// orientation θ is captured by (halfDiff, sxy) of the trial state and is
// preserved by the (co-axial) return mapping.
//
// Derivation:
//   σxx = center + halfDiff_returned · cos(2θ)
//   σyy = center - halfDiff_returned · cos(2θ)
//   σxy = halfDiff_returned · sin(2θ)
//   where center, cos(2θ), sin(2θ) are taken from the returned in-plane
//   eigenvalue pair.
// =============================================================================
function principalToVoigt6(sortedReturned, principalRecord) {
  const { sortedKinds, inPlaneHalfDiff, inPlaneRadius, sxy } = principalRecord;
  let sIPplus = null, sIPminus = null, szz = null;
  for (let i = 0; i < 3; i += 1) {
    if (sortedKinds[i] === 'inPlane+') sIPplus = sortedReturned[i];
    if (sortedKinds[i] === 'inPlane-') sIPminus = sortedReturned[i];
    if (sortedKinds[i] === 'zz')       szz = sortedReturned[i];
  }
  // Failsafe: when ordering changed during return (post-return σzz now
  // sits between the two in-plane eigenvalues, or below them, etc.) the
  // sortedReturned re-sorting still holds, but the *kind* tags are taken
  // from the trial sort.  For plane strain this is the right choice — the
  // material remains co-axial and the returned in-plane block has the
  // same eigenvectors as the trial.  We just take whichever sorted slot
  // the original "inPlane+" / "inPlane-" / "zz" mapped to.
  const half = dsFromF64(0.5);
  const sumIP = dsAdd(sIPplus, sIPminus);
  const center = dsMul(sumIP, half);
  const diffIP = dsAdd(sIPplus, dsNeg(sIPminus));
  const halfDiffRet = dsMul(diffIP, half);
  const Rf = dsToF64(inPlaneRadius);
  let cos2t, sin2t;
  if (Rf > 1e-300) {
    const invR = dsRecip(inPlaneRadius);
    cos2t = dsMul(inPlaneHalfDiff, invR);
    sin2t = dsMul(sxy, invR);
  } else {
    cos2t = dsFromF64(1); sin2t = dsFromF64(0);
  }
  const sxxRet = dsAdd(center, dsMul(halfDiffRet, cos2t));
  const syyRet = dsAdd(center, dsNeg(dsMul(halfDiffRet, cos2t)));
  const sxyRet = dsMul(halfDiffRet, sin2t);
  const zero = dsFromF64(0);
  return [sxxRet, syyRet, szz, sxyRet, zero, zero];
}
