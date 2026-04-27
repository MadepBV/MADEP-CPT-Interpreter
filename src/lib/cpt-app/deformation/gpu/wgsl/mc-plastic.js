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
  dsSqrt, dsAbs, dsSign, dsFromF64, dsToF64
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
// WGSL @compute kernel for MC return mapping.  One thread per Gauss point.
//
// The kernel mirrors the CPU reference algorithm exactly:
//
//   1. Closed-form plane-strain principal-stress eigenvalue solve.
//   2. Yield- and tension-cap surface evaluation (F12, F13, F23, T3).
//   3. Pre-test for multi-cap-violation → tension apex shortcut.
//   4. Regime-based dispatch (ELASTIC / SHEAR / TENSION / MIXED).
//   5. Per-regime active-set return with bounded promotion (face → edge → apex).
//   6. Algorithmic-tangent assembly D_ep = D_e − D_e M (Nᵀ D_e M)⁻¹ Nᵀ D_e.
//   7. Inverse-rotation to Voigt-6.
//
// WGSL has no recursion, so the dispatcher is unrolled into linear control
// flow with switch+break.  All promotions are bounded by Clausen-Damkilde-
// Andersen: face return promotes at most twice (to edge, then to apex), so
// the unrolled depth is finite and tiny.
//
// Buffer layout (per thread = per Gauss point):
//
//   sigmaTrial[gp * 6 + k]  : DS trial stress (Voigt-6, k = 0..5)
//   matIndex[gp]            : u32 material index
//   matParams[mat * 8 + k]  : DS material constants in this order:
//                              [0]=sinPhi   [1]=cosPhi
//                              [2]=sinPsi   [3]=cosPsi
//                              [4]=cohesion [5]=tensionLimit
//                              [6]=KBulk    [7]=G
//   sigmaReturned[gp * 6 + k]   : DS returned stress (Voigt-6)
//   branchKind[gp]              : u32 region id (0..10)
//   tangentPrincipal[gp * 9 + k]: DS algorithmic tangent in principal space
//                                  (row-major 3x3, k = 0..8)
//   converged[gp]               : u32  (1 = ok, 0 = singular promotion)
//
// =============================================================================
export const KERNEL_MC_RETURN_WGSL = /* wgsl */ `
${DS_WGSL}

// ---- branch-id constants -----------------------------------------------------
const BR_ELASTIC:                u32 = 0u;
const BR_FACE_F13:               u32 = 1u;
const BR_EDGE_S23_EQUAL:         u32 = 2u;
const BR_EDGE_S12_EQUAL:         u32 = 3u;
const BR_APEX_FORMAL:            u32 = 4u;
const BR_TENSION_FACE_T3:        u32 = 5u;
const BR_TENSION_EDGE_T23:       u32 = 6u;
const BR_TENSION_EDGE_F13_T3:    u32 = 7u;
const BR_TENSION_CORNER_S23_T3:  u32 = 8u;
const BR_TENSION_CORNER_S12_T3:  u32 = 9u;
const BR_TENSION_APEX_T123:      u32 = 10u;

// ---- ordering / yield tolerances --------------------------------------------
const ORDERING_TOL: f32 = 1e-9;
const SURFACE_TOL:  f32 = 1e-8;

struct McParams { numGp: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       sigmaTrial: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       matIndex:   array<u32>;
@group(0) @binding(2) var<storage, read>       matParams:  array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> sigmaReturned: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> branchKind:    array<u32>;
@group(0) @binding(5) var<storage, read_write> tangentPrincipal: array<vec2<f32>>;
@group(0) @binding(6) var<storage, read_write> converged:     array<u32>;
@group(0) @binding(7) var<uniform>             params: McParams;

// =============================================================================
// Eigenvalue / sort helpers in DS.  Plane-strain: σzz is one principal; the
// other two come from the 2x2 in-plane block.
// =============================================================================
struct PrincipalRecord {
  sortedPrincipal: array<vec2<f32>, 3>,
  // sortedKinds: 0=inPlane+, 1=inPlane-, 2=zz   (which trial slot maps to slot i)
  sortedKinds: array<u32, 3>,
  inPlaneCenter:   vec2<f32>,
  inPlaneHalfDiff: vec2<f32>,
  inPlaneRadius:   vec2<f32>,
  sxy: vec2<f32>
};

fn principalPlaneStrain(sxx: vec2<f32>, syy: vec2<f32>, szz: vec2<f32>, sxy: vec2<f32>) -> PrincipalRecord {
  let half: vec2<f32> = vec2<f32>(0.5, 0.0);
  let sum: vec2<f32> = dsAdd(sxx, syy);
  let diff: vec2<f32> = dsAdd(sxx, dsNeg(syy));
  let center: vec2<f32> = dsMul(sum, half);
  let halfDiff: vec2<f32> = dsMul(diff, half);
  let radSq: vec2<f32> = dsAdd(dsMul(halfDiff, halfDiff), dsMul(sxy, sxy));
  let R: vec2<f32> = dsSqrt(radSq);
  let sIPplus:  vec2<f32> = dsAdd(center, R);
  let sIPminus: vec2<f32> = dsAdd(center, dsNeg(R));
  // Sort the three values descending.  Use a 3-element comparison sort with f32
  // comparison on hi parts (ties broken by lo); DS pairs are non-overlapping so
  // the hi+lo order matches the real-line order.
  var values: array<vec2<f32>, 3>;
  var kinds:  array<u32, 3>;
  values[0] = sIPplus;  kinds[0] = 0u;
  values[1] = sIPminus; kinds[1] = 1u;
  values[2] = szz;      kinds[2] = 2u;
  // Descending bubble: at most three swaps.
  for (var i: i32 = 0; i < 2; i = i + 1) {
    for (var j: i32 = 0; j < 2 - i; j = j + 1) {
      let a: vec2<f32> = values[j];
      let b: vec2<f32> = values[j + 1];
      var swap: bool = false;
      if (a.x < b.x) { swap = true; }
      else if (a.x == b.x && a.y < b.y) { swap = true; }
      if (swap) {
        values[j] = b;
        values[j + 1] = a;
        let tk: u32 = kinds[j];
        kinds[j] = kinds[j + 1];
        kinds[j + 1] = tk;
      }
    }
  }
  var rec: PrincipalRecord;
  rec.sortedPrincipal = values;
  rec.sortedKinds = kinds;
  rec.inPlaneCenter = center;
  rec.inPlaneHalfDiff = halfDiff;
  rec.inPlaneRadius = R;
  rec.sxy = sxy;
  return rec;
}

// Yield evaluations on a sorted principal triple.
struct McSurfaces {
  F12: vec2<f32>,
  F13: vec2<f32>,
  F23: vec2<f32>,
  T3:  vec2<f32>
};

fn evalMcSurfaces(s1: vec2<f32>, s2: vec2<f32>, s3: vec2<f32>,
                  sinPhi: vec2<f32>, cosPhi: vec2<f32>,
                  cohesion: vec2<f32>, tensionLimit: vec2<f32>) -> McSurfaces {
  let two: vec2<f32> = vec2<f32>(2.0, 0.0);
  let twoCcosPhi: vec2<f32> = dsMul(dsMul(two, cohesion), cosPhi);
  let F12: vec2<f32> = dsAdd(
    dsAdd(dsAdd(s1, dsNeg(s2)), dsNeg(dsMul(dsAdd(s1, s2), sinPhi))),
    dsNeg(twoCcosPhi));
  let F13: vec2<f32> = dsAdd(
    dsAdd(dsAdd(s1, dsNeg(s3)), dsNeg(dsMul(dsAdd(s1, s3), sinPhi))),
    dsNeg(twoCcosPhi));
  let F23: vec2<f32> = dsAdd(
    dsAdd(dsAdd(s2, dsNeg(s3)), dsNeg(dsMul(dsAdd(s2, s3), sinPhi))),
    dsNeg(twoCcosPhi));
  let T3: vec2<f32> = dsAdd(dsNeg(s3), dsNeg(tensionLimit));
  return McSurfaces(F12, F13, F23, T3);
}

// Surface gradient in principal-stress space (constant in σ, depends only on
// the surface id and the angle parameter).  Returns vec3 of DS scalars.
fn flowGradF12(sinPsi: vec2<f32>) -> array<vec2<f32>, 3> {
  let one: vec2<f32> = vec2<f32>(1.0, 0.0);
  let oneMinus: vec2<f32> = dsAdd(one, dsNeg(sinPsi));
  let negOnePlus: vec2<f32> = dsNeg(dsAdd(one, sinPsi));
  let zero: vec2<f32> = vec2<f32>(0.0, 0.0);
  return array<vec2<f32>, 3>(oneMinus, negOnePlus, zero);
}
fn flowGradF13(sinPsi: vec2<f32>) -> array<vec2<f32>, 3> {
  let one: vec2<f32> = vec2<f32>(1.0, 0.0);
  let oneMinus: vec2<f32> = dsAdd(one, dsNeg(sinPsi));
  let negOnePlus: vec2<f32> = dsNeg(dsAdd(one, sinPsi));
  let zero: vec2<f32> = vec2<f32>(0.0, 0.0);
  return array<vec2<f32>, 3>(oneMinus, zero, negOnePlus);
}
fn flowGradF23(sinPsi: vec2<f32>) -> array<vec2<f32>, 3> {
  let one: vec2<f32> = vec2<f32>(1.0, 0.0);
  let oneMinus: vec2<f32> = dsAdd(one, dsNeg(sinPsi));
  let negOnePlus: vec2<f32> = dsNeg(dsAdd(one, sinPsi));
  let zero: vec2<f32> = vec2<f32>(0.0, 0.0);
  return array<vec2<f32>, 3>(zero, oneMinus, negOnePlus);
}
fn flowGradT3() -> array<vec2<f32>, 3> {
  let zero: vec2<f32> = vec2<f32>(0.0, 0.0);
  let minusOne: vec2<f32> = vec2<f32>(-1.0, 0.0);
  return array<vec2<f32>, 3>(zero, zero, minusOne);
}

// Elastic D in principal space.  Returns row-major 3x3 = 9 DS entries.
fn elasticD(KBulk: vec2<f32>, G: vec2<f32>) -> array<vec2<f32>, 9> {
  let twoThirds: vec2<f32> = vec2<f32>(0.6666666666666666, 0.0);
  let two: vec2<f32> = vec2<f32>(2.0, 0.0);
  let lambda: vec2<f32> = dsAdd(KBulk, dsNeg(dsMul(twoThirds, G)));
  let twoG: vec2<f32> = dsMul(two, G);
  let diag: vec2<f32> = dsAdd(lambda, twoG);
  return array<vec2<f32>, 9>(
    diag,   lambda, lambda,
    lambda, diag,   lambda,
    lambda, lambda, diag);
}

fn applyD(D: array<vec2<f32>, 9>, v: array<vec2<f32>, 3>) -> array<vec2<f32>, 3> {
  let r0: vec2<f32> = dsAdd(dsAdd(dsMul(D[0], v[0]), dsMul(D[1], v[1])), dsMul(D[2], v[2]));
  let r1: vec2<f32> = dsAdd(dsAdd(dsMul(D[3], v[0]), dsMul(D[4], v[1])), dsMul(D[5], v[2]));
  let r2: vec2<f32> = dsAdd(dsAdd(dsMul(D[6], v[0]), dsMul(D[7], v[1])), dsMul(D[8], v[2]));
  return array<vec2<f32>, 3>(r0, r1, r2);
}

fn dot3(a: array<vec2<f32>, 3>, b: array<vec2<f32>, 3>) -> vec2<f32> {
  return dsAdd(dsAdd(dsMul(a[0], b[0]), dsMul(a[1], b[1])), dsMul(a[2], b[2]));
}

// 2x2 DS solve.  Returns lambda; returns [0,0] in both slots if singular.
fn solve2x2(C: array<vec2<f32>, 4>, rhs: array<vec2<f32>, 2>) -> array<vec2<f32>, 2> {
  // det = C00*C11 - C01*C10
  let det: vec2<f32> = dsAdd(dsMul(C[0], C[3]), dsNeg(dsMul(C[1], C[2])));
  if (abs(det.x) < 1e-30) {
    return array<vec2<f32>, 2>(vec2<f32>(0.0, 0.0), vec2<f32>(0.0, 0.0));
  }
  let invDet: vec2<f32> = dsRecip(det);
  let l0: vec2<f32> = dsMul(dsAdd(dsMul(C[3], rhs[0]), dsNeg(dsMul(C[1], rhs[1]))), invDet);
  let l1: vec2<f32> = dsMul(dsAdd(dsMul(C[0], rhs[1]), dsNeg(dsMul(C[2], rhs[0]))), invDet);
  return array<vec2<f32>, 2>(l0, l1);
}

// 3x3 DS solve via partial-pivoting Gaussian elimination.  Returns
// (lambda, success): success is 0 on singular.  Inputs are row-major.
struct Solve3 { x: array<vec2<f32>, 3>, ok: u32 };

fn solve3x3(C0: array<vec2<f32>, 9>, b0: array<vec2<f32>, 3>) -> Solve3 {
  var A: array<vec2<f32>, 9> = C0;
  var b: array<vec2<f32>, 3> = b0;
  for (var col: u32 = 0u; col < 3u; col = col + 1u) {
    var pivotRow: u32 = col;
    var pivotMag: f32 = abs(A[col * 3u + col].x);
    for (var r: u32 = col + 1u; r < 3u; r = r + 1u) {
      let mag: f32 = abs(A[r * 3u + col].x);
      if (mag > pivotMag) { pivotMag = mag; pivotRow = r; }
    }
    if (pivotMag < 1e-30) {
      var fail: Solve3;
      fail.x = array<vec2<f32>, 3>(vec2<f32>(0.0, 0.0), vec2<f32>(0.0, 0.0), vec2<f32>(0.0, 0.0));
      fail.ok = 0u;
      return fail;
    }
    if (pivotRow != col) {
      for (var cc: u32 = 0u; cc < 3u; cc = cc + 1u) {
        let tmp: vec2<f32> = A[col * 3u + cc];
        A[col * 3u + cc] = A[pivotRow * 3u + cc];
        A[pivotRow * 3u + cc] = tmp;
      }
      let tb: vec2<f32> = b[col]; b[col] = b[pivotRow]; b[pivotRow] = tb;
    }
    let invPivot: vec2<f32> = dsRecip(A[col * 3u + col]);
    for (var r: u32 = col + 1u; r < 3u; r = r + 1u) {
      let factor: vec2<f32> = dsMul(A[r * 3u + col], invPivot);
      for (var cc: u32 = col; cc < 3u; cc = cc + 1u) {
        A[r * 3u + cc] = dsAdd(A[r * 3u + cc], dsNeg(dsMul(factor, A[col * 3u + cc])));
      }
      b[r] = dsAdd(b[r], dsNeg(dsMul(factor, b[col])));
    }
  }
  var x: array<vec2<f32>, 3>;
  for (var rs: i32 = 2; rs >= 0; rs = rs - 1) {
    let r: u32 = u32(rs);
    var sum: vec2<f32> = b[r];
    for (var cc: u32 = r + 1u; cc < 3u; cc = cc + 1u) {
      sum = dsAdd(sum, dsNeg(dsMul(A[r * 3u + cc], x[cc])));
    }
    x[r] = dsMul(sum, dsRecip(A[r * 3u + r]));
  }
  var ok: Solve3;
  ok.x = x;
  ok.ok = 1u;
  return ok;
}

// =============================================================================
// Active-set return-mapping kernels (face / edge / corner / apex).
// Each returns the post-return principal stress and, for non-apex returns,
// the gradients (n[k], m[k], Dm[k]) that feed the algorithmic tangent.
// =============================================================================
struct ActiveSet1 {
  sigma: array<vec2<f32>, 3>,
  n0: array<vec2<f32>, 3>,
  m0: array<vec2<f32>, 3>,
  Dm0: array<vec2<f32>, 3>,
  ok: u32
};

fn faceReturn1(s: array<vec2<f32>, 3>,
               n: array<vec2<f32>, 3>,
               m: array<vec2<f32>, 3>,
               surfaceVal: vec2<f32>,
               KBulk: vec2<f32>, G: vec2<f32>) -> ActiveSet1 {
  let D: array<vec2<f32>, 9> = elasticD(KBulk, G);
  let Dm: array<vec2<f32>, 3> = applyD(D, m);
  let C: vec2<f32> = dot3(n, Dm);
  if (abs(C.x) < 1e-30) {
    var fail: ActiveSet1;
    fail.sigma = s; fail.n0 = n; fail.m0 = m; fail.Dm0 = Dm; fail.ok = 0u;
    return fail;
  }
  let lambda: vec2<f32> = dsMul(surfaceVal, dsRecip(C));
  var sigma: array<vec2<f32>, 3>;
  sigma[0] = dsAdd(s[0], dsNeg(dsMul(Dm[0], lambda)));
  sigma[1] = dsAdd(s[1], dsNeg(dsMul(Dm[1], lambda)));
  sigma[2] = dsAdd(s[2], dsNeg(dsMul(Dm[2], lambda)));
  var ok: ActiveSet1;
  ok.sigma = sigma; ok.n0 = n; ok.m0 = m; ok.Dm0 = Dm; ok.ok = 1u;
  return ok;
}

struct ActiveSet2 {
  sigma: array<vec2<f32>, 3>,
  n0: array<vec2<f32>, 3>, n1: array<vec2<f32>, 3>,
  m0: array<vec2<f32>, 3>, m1: array<vec2<f32>, 3>,
  Dm0: array<vec2<f32>, 3>, Dm1: array<vec2<f32>, 3>,
  ok: u32
};

fn edgeReturn2(s: array<vec2<f32>, 3>,
               n0: array<vec2<f32>, 3>, n1: array<vec2<f32>, 3>,
               m0: array<vec2<f32>, 3>, m1: array<vec2<f32>, 3>,
               surf0: vec2<f32>, surf1: vec2<f32>,
               KBulk: vec2<f32>, G: vec2<f32>) -> ActiveSet2 {
  let D: array<vec2<f32>, 9> = elasticD(KBulk, G);
  let Dm0: array<vec2<f32>, 3> = applyD(D, m0);
  let Dm1: array<vec2<f32>, 3> = applyD(D, m1);
  let C: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
    dot3(n0, Dm0), dot3(n0, Dm1),
    dot3(n1, Dm0), dot3(n1, Dm1));
  let rhs: array<vec2<f32>, 2> = array<vec2<f32>, 2>(surf0, surf1);
  let det: vec2<f32> = dsAdd(dsMul(C[0], C[3]), dsNeg(dsMul(C[1], C[2])));
  if (abs(det.x) < 1e-30) {
    var fail: ActiveSet2;
    fail.sigma = s; fail.n0 = n0; fail.n1 = n1; fail.m0 = m0; fail.m1 = m1;
    fail.Dm0 = Dm0; fail.Dm1 = Dm1; fail.ok = 0u;
    return fail;
  }
  let lambda: array<vec2<f32>, 2> = solve2x2(C, rhs);
  var sigma: array<vec2<f32>, 3>;
  sigma[0] = dsAdd(dsAdd(s[0], dsNeg(dsMul(Dm0[0], lambda[0]))), dsNeg(dsMul(Dm1[0], lambda[1])));
  sigma[1] = dsAdd(dsAdd(s[1], dsNeg(dsMul(Dm0[1], lambda[0]))), dsNeg(dsMul(Dm1[1], lambda[1])));
  sigma[2] = dsAdd(dsAdd(s[2], dsNeg(dsMul(Dm0[2], lambda[0]))), dsNeg(dsMul(Dm1[2], lambda[1])));
  var ok: ActiveSet2;
  ok.sigma = sigma; ok.n0 = n0; ok.n1 = n1; ok.m0 = m0; ok.m1 = m1;
  ok.Dm0 = Dm0; ok.Dm1 = Dm1; ok.ok = 1u;
  return ok;
}

struct ActiveSet3 {
  sigma: array<vec2<f32>, 3>,
  n0: array<vec2<f32>, 3>, n1: array<vec2<f32>, 3>, n2: array<vec2<f32>, 3>,
  m0: array<vec2<f32>, 3>, m1: array<vec2<f32>, 3>, m2: array<vec2<f32>, 3>,
  Dm0: array<vec2<f32>, 3>, Dm1: array<vec2<f32>, 3>, Dm2: array<vec2<f32>, 3>,
  ok: u32
};

fn cornerReturn3(s: array<vec2<f32>, 3>,
                 n0: array<vec2<f32>, 3>, n1: array<vec2<f32>, 3>, n2: array<vec2<f32>, 3>,
                 m0: array<vec2<f32>, 3>, m1: array<vec2<f32>, 3>, m2: array<vec2<f32>, 3>,
                 surf0: vec2<f32>, surf1: vec2<f32>, surf2: vec2<f32>,
                 KBulk: vec2<f32>, G: vec2<f32>) -> ActiveSet3 {
  let D: array<vec2<f32>, 9> = elasticD(KBulk, G);
  let Dm0: array<vec2<f32>, 3> = applyD(D, m0);
  let Dm1: array<vec2<f32>, 3> = applyD(D, m1);
  let Dm2: array<vec2<f32>, 3> = applyD(D, m2);
  let C: array<vec2<f32>, 9> = array<vec2<f32>, 9>(
    dot3(n0, Dm0), dot3(n0, Dm1), dot3(n0, Dm2),
    dot3(n1, Dm0), dot3(n1, Dm1), dot3(n1, Dm2),
    dot3(n2, Dm0), dot3(n2, Dm1), dot3(n2, Dm2));
  let rhs: array<vec2<f32>, 3> = array<vec2<f32>, 3>(surf0, surf1, surf2);
  let r: Solve3 = solve3x3(C, rhs);
  var sigma: array<vec2<f32>, 3>;
  if (r.ok == 0u) {
    var fail: ActiveSet3;
    fail.sigma = s; fail.n0 = n0; fail.n1 = n1; fail.n2 = n2;
    fail.m0 = m0; fail.m1 = m1; fail.m2 = m2;
    fail.Dm0 = Dm0; fail.Dm1 = Dm1; fail.Dm2 = Dm2;
    fail.ok = 0u;
    return fail;
  }
  let lambda: array<vec2<f32>, 3> = r.x;
  for (var k: u32 = 0u; k < 3u; k = k + 1u) {
    var acc: vec2<f32> = s[k];
    acc = dsAdd(acc, dsNeg(dsMul(Dm0[k], lambda[0])));
    acc = dsAdd(acc, dsNeg(dsMul(Dm1[k], lambda[1])));
    acc = dsAdd(acc, dsNeg(dsMul(Dm2[k], lambda[2])));
    sigma[k] = acc;
  }
  var ok: ActiveSet3;
  ok.sigma = sigma;
  ok.n0 = n0; ok.n1 = n1; ok.n2 = n2;
  ok.m0 = m0; ok.m1 = m1; ok.m2 = m2;
  ok.Dm0 = Dm0; ok.Dm1 = Dm1; ok.Dm2 = Dm2;
  ok.ok = 1u;
  return ok;
}

// Inverse-rotate principal triple (sortedReturned in DS) back to Voigt-6.
fn principalToVoigt6(sortedReturned: array<vec2<f32>, 3>, rec: PrincipalRecord) -> array<vec2<f32>, 6> {
  // Map sortedKinds back to (in-plane+, in-plane-, zz) slots.
  var sIPplus:  vec2<f32> = vec2<f32>(0.0, 0.0);
  var sIPminus: vec2<f32> = vec2<f32>(0.0, 0.0);
  var szz:      vec2<f32> = vec2<f32>(0.0, 0.0);
  for (var i: u32 = 0u; i < 3u; i = i + 1u) {
    if (rec.sortedKinds[i] == 0u) { sIPplus  = sortedReturned[i]; }
    if (rec.sortedKinds[i] == 1u) { sIPminus = sortedReturned[i]; }
    if (rec.sortedKinds[i] == 2u) { szz      = sortedReturned[i]; }
  }
  let half: vec2<f32> = vec2<f32>(0.5, 0.0);
  let sumIP:   vec2<f32> = dsAdd(sIPplus, sIPminus);
  let center:  vec2<f32> = dsMul(sumIP, half);
  let diffIP:  vec2<f32> = dsAdd(sIPplus, dsNeg(sIPminus));
  let halfDiffRet: vec2<f32> = dsMul(diffIP, half);
  var cos2t: vec2<f32> = vec2<f32>(1.0, 0.0);
  var sin2t: vec2<f32> = vec2<f32>(0.0, 0.0);
  if (rec.inPlaneRadius.x > 1e-30) {
    let invR: vec2<f32> = dsRecip(rec.inPlaneRadius);
    cos2t = dsMul(rec.inPlaneHalfDiff, invR);
    sin2t = dsMul(rec.sxy, invR);
  }
  let sxxRet: vec2<f32> = dsAdd(center, dsMul(halfDiffRet, cos2t));
  let syyRet: vec2<f32> = dsAdd(center, dsNeg(dsMul(halfDiffRet, cos2t)));
  let sxyRet: vec2<f32> = dsMul(halfDiffRet, sin2t);
  let zero: vec2<f32> = vec2<f32>(0.0, 0.0);
  return array<vec2<f32>, 6>(sxxRet, syyRet, szz, sxyRet, zero, zero);
}

// Compute the algorithmic tangent D_ep = D - D M (Nᵀ D M)⁻¹ Nᵀ D for k = 1, 2, 3.
// k = 0 (elastic) returns D itself.  k = 0 special case is handled by caller.

fn algoTangent1(D: array<vec2<f32>, 9>, n0: array<vec2<f32>, 3>, Dm0: array<vec2<f32>, 3>) -> array<vec2<f32>, 9> {
  let C: vec2<f32> = dot3(n0, Dm0);
  if (abs(C.x) < 1e-30) { return D; }
  let invC: vec2<f32> = dsRecip(C);
  var Dep: array<vec2<f32>, 9>;
  for (var q: u32 = 0u; q < 3u; q = q + 1u) {
    let nDq: vec2<f32> = dsAdd(dsAdd(dsMul(n0[0], D[0u * 3u + q]), dsMul(n0[1], D[1u * 3u + q])),
                                dsMul(n0[2], D[2u * 3u + q]));
    let lambdaQ: vec2<f32> = dsMul(invC, nDq);
    for (var r: u32 = 0u; r < 3u; r = r + 1u) {
      let corr: vec2<f32> = dsMul(Dm0[r], lambdaQ);
      Dep[r * 3u + q] = dsAdd(D[r * 3u + q], dsNeg(corr));
    }
  }
  return Dep;
}

fn algoTangent2(D: array<vec2<f32>, 9>,
                n0: array<vec2<f32>, 3>, n1: array<vec2<f32>, 3>,
                Dm0: array<vec2<f32>, 3>, Dm1: array<vec2<f32>, 3>) -> array<vec2<f32>, 9> {
  let C: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
    dot3(n0, Dm0), dot3(n0, Dm1),
    dot3(n1, Dm0), dot3(n1, Dm1));
  let det: vec2<f32> = dsAdd(dsMul(C[0], C[3]), dsNeg(dsMul(C[1], C[2])));
  if (abs(det.x) < 1e-30) { return D; }
  var Dep: array<vec2<f32>, 9>;
  for (var q: u32 = 0u; q < 3u; q = q + 1u) {
    let nDq0: vec2<f32> = dsAdd(dsAdd(dsMul(n0[0], D[0u * 3u + q]), dsMul(n0[1], D[1u * 3u + q])),
                                 dsMul(n0[2], D[2u * 3u + q]));
    let nDq1: vec2<f32> = dsAdd(dsAdd(dsMul(n1[0], D[0u * 3u + q]), dsMul(n1[1], D[1u * 3u + q])),
                                 dsMul(n1[2], D[2u * 3u + q]));
    let rhs: array<vec2<f32>, 2> = array<vec2<f32>, 2>(nDq0, nDq1);
    let lambdaQ: array<vec2<f32>, 2> = solve2x2(C, rhs);
    for (var r: u32 = 0u; r < 3u; r = r + 1u) {
      var corr: vec2<f32> = dsMul(Dm0[r], lambdaQ[0]);
      corr = dsAdd(corr, dsMul(Dm1[r], lambdaQ[1]));
      Dep[r * 3u + q] = dsAdd(D[r * 3u + q], dsNeg(corr));
    }
  }
  return Dep;
}

fn algoTangent3(D: array<vec2<f32>, 9>,
                n0: array<vec2<f32>, 3>, n1: array<vec2<f32>, 3>, n2: array<vec2<f32>, 3>,
                Dm0: array<vec2<f32>, 3>, Dm1: array<vec2<f32>, 3>, Dm2: array<vec2<f32>, 3>) -> array<vec2<f32>, 9> {
  let C: array<vec2<f32>, 9> = array<vec2<f32>, 9>(
    dot3(n0, Dm0), dot3(n0, Dm1), dot3(n0, Dm2),
    dot3(n1, Dm0), dot3(n1, Dm1), dot3(n1, Dm2),
    dot3(n2, Dm0), dot3(n2, Dm1), dot3(n2, Dm2));
  var Dep: array<vec2<f32>, 9>;
  for (var q: u32 = 0u; q < 3u; q = q + 1u) {
    let nDq0: vec2<f32> = dsAdd(dsAdd(dsMul(n0[0], D[0u * 3u + q]), dsMul(n0[1], D[1u * 3u + q])),
                                 dsMul(n0[2], D[2u * 3u + q]));
    let nDq1: vec2<f32> = dsAdd(dsAdd(dsMul(n1[0], D[0u * 3u + q]), dsMul(n1[1], D[1u * 3u + q])),
                                 dsMul(n1[2], D[2u * 3u + q]));
    let nDq2: vec2<f32> = dsAdd(dsAdd(dsMul(n2[0], D[0u * 3u + q]), dsMul(n2[1], D[1u * 3u + q])),
                                 dsMul(n2[2], D[2u * 3u + q]));
    let rhs: array<vec2<f32>, 3> = array<vec2<f32>, 3>(nDq0, nDq1, nDq2);
    let r3: Solve3 = solve3x3(C, rhs);
    if (r3.ok == 0u) { return D; }
    let lambdaQ: array<vec2<f32>, 3> = r3.x;
    for (var r: u32 = 0u; r < 3u; r = r + 1u) {
      var corr: vec2<f32> = dsMul(Dm0[r], lambdaQ[0]);
      corr = dsAdd(corr, dsMul(Dm1[r], lambdaQ[1]));
      corr = dsAdd(corr, dsMul(Dm2[r], lambdaQ[2]));
      Dep[r * 3u + q] = dsAdd(D[r * 3u + q], dsNeg(corr));
    }
  }
  return Dep;
}

// =============================================================================
// Top-level dispatcher (per Gauss point).
// =============================================================================
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  if (gp >= params.numGp) { return; }

  // Load trial stress (Voigt-6).
  let sxx: vec2<f32> = sigmaTrial[gp * 6u + 0u];
  let syy: vec2<f32> = sigmaTrial[gp * 6u + 1u];
  let szz: vec2<f32> = sigmaTrial[gp * 6u + 2u];
  let sxy: vec2<f32> = sigmaTrial[gp * 6u + 3u];

  // Load material params.
  let mi: u32 = matIndex[gp];
  let sinPhi:       vec2<f32> = matParams[mi * 8u + 0u];
  let cosPhi:       vec2<f32> = matParams[mi * 8u + 1u];
  let sinPsi:       vec2<f32> = matParams[mi * 8u + 2u];
  let cohesion:     vec2<f32> = matParams[mi * 8u + 4u];
  let tensionLimit: vec2<f32> = matParams[mi * 8u + 5u];
  let KBulk:        vec2<f32> = matParams[mi * 8u + 6u];
  let G:            vec2<f32> = matParams[mi * 8u + 7u];

  // Closed-form principal stresses.
  let rec: PrincipalRecord = principalPlaneStrain(sxx, syy, szz, sxy);
  let sortedTrial: array<vec2<f32>, 3> = rec.sortedPrincipal;

  // Surface evaluations.
  let surf: McSurfaces = evalMcSurfaces(
    sortedTrial[0], sortedTrial[1], sortedTrial[2],
    sinPhi, cosPhi, cohesion, tensionLimit);
  let f13Pos: bool = surf.F13.x + surf.F13.y > SURFACE_TOL;
  let t3Pos:  bool = surf.T3.x  + surf.T3.y  > SURFACE_TOL;

  // Default outputs (overwritten on each branch).
  var sigmaOut: array<vec2<f32>, 3>;
  var branch: u32 = BR_ELASTIC;
  var ok: u32 = 1u;
  let D: array<vec2<f32>, 9> = elasticD(KBulk, G);
  var tangent: array<vec2<f32>, 9> = D;

  // Cap-violation count (used by tension/mixed shortcut).
  let minusT_x: f32 = -tensionLimit.x;
  let minusT_y: f32 = -tensionLimit.y;
  // Compare each principal with -tensionLimit.
  var cnt: u32 = 0u;
  for (var i: u32 = 0u; i < 3u; i = i + 1u) {
    let sumPi: f32 = sortedTrial[i].x + sortedTrial[i].y;
    let cap:   f32 = minusT_x + minusT_y - SURFACE_TOL;
    if (sumPi < cap) { cnt = cnt + 1u; }
  }

  if (!f13Pos && !t3Pos) {
    sigmaOut = sortedTrial;
    branch = BR_ELASTIC;
    tangent = D;
  } else {
    // Multi-violation shortcut.
    if (cnt >= 2u && (t3Pos || f13Pos)) {
      let mt: vec2<f32> = dsNeg(tensionLimit);
      sigmaOut = array<vec2<f32>, 3>(mt, mt, mt);
      branch = BR_TENSION_APEX_T123;
      // Apex tangent is degenerate; emit elastic D as a benign default
      // (downstream code never builds K from a fully-collapsed apex).
      tangent = D;
    } else {
      // Build the surface gradients we may need.
      let nF12: array<vec2<f32>, 3> = flowGradF12(sinPhi);
      let nF13: array<vec2<f32>, 3> = flowGradF13(sinPhi);
      let nF23: array<vec2<f32>, 3> = flowGradF23(sinPhi);
      let nT3:  array<vec2<f32>, 3> = flowGradT3();
      let mF12: array<vec2<f32>, 3> = flowGradF12(sinPsi);
      let mF13: array<vec2<f32>, 3> = flowGradF13(sinPsi);
      let mF23: array<vec2<f32>, 3> = flowGradF23(sinPsi);
      let mT3:  array<vec2<f32>, 3> = flowGradT3();

      if (f13Pos && !t3Pos) {
        // SHEAR regime.  Try FACE_F13.
        let fr: ActiveSet1 = faceReturn1(sortedTrial, nF13, mF13, surf.F13, KBulk, G);
        let upperVio: bool = (fr.sigma[0].x + fr.sigma[0].y) + ORDERING_TOL < (fr.sigma[1].x + fr.sigma[1].y);
        let lowerVio: bool = (fr.sigma[1].x + fr.sigma[1].y) + ORDERING_TOL < (fr.sigma[2].x + fr.sigma[2].y);
        let postT3: f32 = (-fr.sigma[2].x - fr.sigma[2].y) - (tensionLimit.x + tensionLimit.y);
        if (postT3 > SURFACE_TOL && !upperVio && !lowerVio) {
          // Promote into mixed regime: try {F13, T3} edge.
          let er: ActiveSet2 = edgeReturn2(sortedTrial, nF13, nT3, mF13, mT3, surf.F13, surf.T3, KBulk, G);
          let uV: bool = (er.sigma[0].x + er.sigma[0].y) + ORDERING_TOL < (er.sigma[1].x + er.sigma[1].y);
          let lV: bool = (er.sigma[1].x + er.sigma[1].y) + ORDERING_TOL < (er.sigma[2].x + er.sigma[2].y);
          if (er.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_EDGE_F13_T3; tangent = D; }
          else if (!uV && !lV) {
            sigmaOut = er.sigma; branch = BR_TENSION_EDGE_F13_T3;
            tangent = algoTangent2(D, er.n0, er.n1, er.Dm0, er.Dm1);
          } else if (uV && lV) {
            let mt: vec2<f32> = dsNeg(tensionLimit);
            sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
          } else if (lV) {
            let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF12, nF13, nT3, mF12, mF13, mT3,
                                                surf.F12, surf.F13, surf.T3, KBulk, G);
            if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S23_T3; tangent = D; }
            else {
              let upV2: bool = (cr.sigma[0].x + cr.sigma[0].y) + ORDERING_TOL < (cr.sigma[1].x + cr.sigma[1].y);
              if (upV2) {
                let mt: vec2<f32> = dsNeg(tensionLimit);
                sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
              } else {
                sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S23_T3;
                tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
              }
            }
          } else {
            // upperVio: corner {F13, F23, T3}
            let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF13, nF23, nT3, mF13, mF23, mT3,
                                                surf.F13, surf.F23, surf.T3, KBulk, G);
            if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S12_T3; tangent = D; }
            else {
              let lwV2: bool = (cr.sigma[1].x + cr.sigma[1].y) + ORDERING_TOL < (cr.sigma[2].x + cr.sigma[2].y);
              if (lwV2) {
                let mt: vec2<f32> = dsNeg(tensionLimit);
                sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
              } else {
                sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S12_T3;
                tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
              }
            }
          }
        } else if (!upperVio && !lowerVio) {
          sigmaOut = fr.sigma; branch = BR_FACE_F13;
          tangent = algoTangent1(D, fr.n0, fr.Dm0);
        } else if (upperVio && lowerVio) {
          // Apex (formal).  σ_apex = c · cot φ.
          if (abs(sinPhi.x) < 1e-15) { ok = 0u; sigmaOut = sortedTrial; branch = BR_APEX_FORMAL; tangent = D; }
          else {
            let cot: vec2<f32> = dsDiv(cosPhi, sinPhi);
            let apex: vec2<f32> = dsMul(cohesion, cot);
            sigmaOut = array<vec2<f32>, 3>(apex, apex, apex); branch = BR_APEX_FORMAL; tangent = D;
          }
        } else if (lowerVio) {
          // EDGE_S23: {F12, F13}.
          let er: ActiveSet2 = edgeReturn2(sortedTrial, nF12, nF13, mF12, mF13, surf.F12, surf.F13, KBulk, G);
          if (er.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_EDGE_S23_EQUAL; tangent = D; }
          else {
            let upV: bool = (er.sigma[0].x + er.sigma[0].y) + ORDERING_TOL < (er.sigma[1].x + er.sigma[1].y);
            let postT3e: f32 = (-er.sigma[2].x - er.sigma[2].y) - (tensionLimit.x + tensionLimit.y);
            if (upV) {
              if (abs(sinPhi.x) < 1e-15) { ok = 0u; sigmaOut = sortedTrial; branch = BR_APEX_FORMAL; tangent = D; }
              else {
                let cot: vec2<f32> = dsDiv(cosPhi, sinPhi);
                let apex: vec2<f32> = dsMul(cohesion, cot);
                sigmaOut = array<vec2<f32>, 3>(apex, apex, apex); branch = BR_APEX_FORMAL; tangent = D;
              }
            } else if (postT3e > SURFACE_TOL) {
              // Promote to corner {F12, F13, T3}.
              let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF12, nF13, nT3, mF12, mF13, mT3,
                                                  surf.F12, surf.F13, surf.T3, KBulk, G);
              if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S23_T3; tangent = D; }
              else {
                let upV2: bool = (cr.sigma[0].x + cr.sigma[0].y) + ORDERING_TOL < (cr.sigma[1].x + cr.sigma[1].y);
                if (upV2) {
                  let mt: vec2<f32> = dsNeg(tensionLimit);
                  sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
                } else {
                  sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S23_T3;
                  tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
                }
              }
            } else {
              sigmaOut = er.sigma; branch = BR_EDGE_S23_EQUAL;
              tangent = algoTangent2(D, er.n0, er.n1, er.Dm0, er.Dm1);
            }
          }
        } else {
          // upperVio in shear: EDGE_S12 = {F13, F23}.
          let er: ActiveSet2 = edgeReturn2(sortedTrial, nF13, nF23, mF13, mF23, surf.F13, surf.F23, KBulk, G);
          if (er.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_EDGE_S12_EQUAL; tangent = D; }
          else {
            let lwV: bool = (er.sigma[1].x + er.sigma[1].y) + ORDERING_TOL < (er.sigma[2].x + er.sigma[2].y);
            let postT3e: f32 = (-er.sigma[2].x - er.sigma[2].y) - (tensionLimit.x + tensionLimit.y);
            if (lwV) {
              if (abs(sinPhi.x) < 1e-15) { ok = 0u; sigmaOut = sortedTrial; branch = BR_APEX_FORMAL; tangent = D; }
              else {
                let cot: vec2<f32> = dsDiv(cosPhi, sinPhi);
                let apex: vec2<f32> = dsMul(cohesion, cot);
                sigmaOut = array<vec2<f32>, 3>(apex, apex, apex); branch = BR_APEX_FORMAL; tangent = D;
              }
            } else if (postT3e > SURFACE_TOL) {
              let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF13, nF23, nT3, mF13, mF23, mT3,
                                                  surf.F13, surf.F23, surf.T3, KBulk, G);
              if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S12_T3; tangent = D; }
              else {
                let lwV2: bool = (cr.sigma[1].x + cr.sigma[1].y) + ORDERING_TOL < (cr.sigma[2].x + cr.sigma[2].y);
                if (lwV2) {
                  let mt: vec2<f32> = dsNeg(tensionLimit);
                  sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
                } else {
                  sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S12_T3;
                  tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
                }
              }
            } else {
              sigmaOut = er.sigma; branch = BR_EDGE_S12_EQUAL;
              tangent = algoTangent2(D, er.n0, er.n1, er.Dm0, er.Dm1);
            }
          }
        }
      } else if (t3Pos && !f13Pos) {
        // TENSION regime.  Try TENSION_FACE_T3.
        let fr: ActiveSet1 = faceReturn1(sortedTrial, nT3, mT3, surf.T3, KBulk, G);
        let post: McSurfaces = evalMcSurfaces(fr.sigma[0], fr.sigma[1], fr.sigma[2],
                                              sinPhi, cosPhi, cohesion, tensionLimit);
        let upperVio: bool = (fr.sigma[0].x + fr.sigma[0].y) + ORDERING_TOL < (fr.sigma[1].x + fr.sigma[1].y);
        let lowerVio: bool = (fr.sigma[1].x + fr.sigma[1].y) + ORDERING_TOL < (fr.sigma[2].x + fr.sigma[2].y);
        let f13Vio: bool = (post.F13.x + post.F13.y) > SURFACE_TOL;
        if (!upperVio && !lowerVio && !f13Vio) {
          sigmaOut = fr.sigma; branch = BR_TENSION_FACE_T3;
          tangent = algoTangent1(D, fr.n0, fr.Dm0);
        } else if (f13Vio) {
          // Promote {F13, T3}.
          let er: ActiveSet2 = edgeReturn2(sortedTrial, nF13, nT3, mF13, mT3, surf.F13, surf.T3, KBulk, G);
          if (er.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_EDGE_F13_T3; tangent = D; }
          else {
            let uV2: bool = (er.sigma[0].x + er.sigma[0].y) + ORDERING_TOL < (er.sigma[1].x + er.sigma[1].y);
            let lV2: bool = (er.sigma[1].x + er.sigma[1].y) + ORDERING_TOL < (er.sigma[2].x + er.sigma[2].y);
            if (!uV2 && !lV2) {
              sigmaOut = er.sigma; branch = BR_TENSION_EDGE_F13_T3;
              tangent = algoTangent2(D, er.n0, er.n1, er.Dm0, er.Dm1);
            } else if (uV2 && lV2) {
              let mt: vec2<f32> = dsNeg(tensionLimit);
              sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
            } else if (lV2) {
              let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF12, nF13, nT3, mF12, mF13, mT3,
                                                  surf.F12, surf.F13, surf.T3, KBulk, G);
              if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S23_T3; tangent = D; }
              else {
                let upV3: bool = (cr.sigma[0].x + cr.sigma[0].y) + ORDERING_TOL < (cr.sigma[1].x + cr.sigma[1].y);
                if (upV3) {
                  let mt: vec2<f32> = dsNeg(tensionLimit);
                  sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
                } else {
                  sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S23_T3;
                  tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
                }
              }
            } else {
              let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF13, nF23, nT3, mF13, mF23, mT3,
                                                  surf.F13, surf.F23, surf.T3, KBulk, G);
              if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S12_T3; tangent = D; }
              else {
                let lwV3: bool = (cr.sigma[1].x + cr.sigma[1].y) + ORDERING_TOL < (cr.sigma[2].x + cr.sigma[2].y);
                if (lwV3) {
                  let mt: vec2<f32> = dsNeg(tensionLimit);
                  sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
                } else {
                  sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S12_T3;
                  tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
                }
              }
            }
          }
        } else if (lowerVio) {
          // {F12, T3} edge.
          let er: ActiveSet2 = edgeReturn2(sortedTrial, nF12, nT3, mF12, mT3, surf.F12, surf.T3, KBulk, G);
          if (er.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_EDGE_T23; tangent = D; }
          else {
            let uV2: bool = (er.sigma[0].x + er.sigma[0].y) + ORDERING_TOL < (er.sigma[1].x + er.sigma[1].y);
            if (uV2) {
              let mt: vec2<f32> = dsNeg(tensionLimit);
              sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
            } else {
              sigmaOut = er.sigma; branch = BR_TENSION_EDGE_T23;
              tangent = algoTangent2(D, er.n0, er.n1, er.Dm0, er.Dm1);
            }
          }
        } else if (upperVio) {
          // {F23, T3} edge (rare).
          let er: ActiveSet2 = edgeReturn2(sortedTrial, nF23, nT3, mF23, mT3, surf.F23, surf.T3, KBulk, G);
          if (er.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_EDGE_T23; tangent = D; }
          else {
            let lV2: bool = (er.sigma[1].x + er.sigma[1].y) + ORDERING_TOL < (er.sigma[2].x + er.sigma[2].y);
            if (lV2) {
              let mt: vec2<f32> = dsNeg(tensionLimit);
              sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
            } else {
              sigmaOut = er.sigma; branch = BR_TENSION_EDGE_T23;
              tangent = algoTangent2(D, er.n0, er.n1, er.Dm0, er.Dm1);
            }
          }
        }
      } else {
        // MIXED regime (f13Pos AND t3Pos).  Try {F13, T3} edge.
        let er: ActiveSet2 = edgeReturn2(sortedTrial, nF13, nT3, mF13, mT3, surf.F13, surf.T3, KBulk, G);
        if (er.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_EDGE_F13_T3; tangent = D; }
        else {
          let upperVio: bool = (er.sigma[0].x + er.sigma[0].y) + ORDERING_TOL < (er.sigma[1].x + er.sigma[1].y);
          let lowerVio: bool = (er.sigma[1].x + er.sigma[1].y) + ORDERING_TOL < (er.sigma[2].x + er.sigma[2].y);
          if (!upperVio && !lowerVio) {
            sigmaOut = er.sigma; branch = BR_TENSION_EDGE_F13_T3;
            tangent = algoTangent2(D, er.n0, er.n1, er.Dm0, er.Dm1);
          } else if (upperVio && lowerVio) {
            let mt: vec2<f32> = dsNeg(tensionLimit);
            sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
          } else if (lowerVio) {
            let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF12, nF13, nT3, mF12, mF13, mT3,
                                                surf.F12, surf.F13, surf.T3, KBulk, G);
            if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S23_T3; tangent = D; }
            else {
              let upV2: bool = (cr.sigma[0].x + cr.sigma[0].y) + ORDERING_TOL < (cr.sigma[1].x + cr.sigma[1].y);
              if (upV2) {
                let mt: vec2<f32> = dsNeg(tensionLimit);
                sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
              } else {
                sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S23_T3;
                tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
              }
            }
          } else {
            let cr: ActiveSet3 = cornerReturn3(sortedTrial, nF13, nF23, nT3, mF13, mF23, mT3,
                                                surf.F13, surf.F23, surf.T3, KBulk, G);
            if (cr.ok == 0u) { ok = 0u; sigmaOut = sortedTrial; branch = BR_TENSION_CORNER_S12_T3; tangent = D; }
            else {
              let lwV2: bool = (cr.sigma[1].x + cr.sigma[1].y) + ORDERING_TOL < (cr.sigma[2].x + cr.sigma[2].y);
              if (lwV2) {
                let mt: vec2<f32> = dsNeg(tensionLimit);
                sigmaOut = array<vec2<f32>, 3>(mt, mt, mt); branch = BR_TENSION_APEX_T123; tangent = D;
              } else {
                sigmaOut = cr.sigma; branch = BR_TENSION_CORNER_S12_T3;
                tangent = algoTangent3(D, cr.n0, cr.n1, cr.n2, cr.Dm0, cr.Dm1, cr.Dm2);
              }
            }
          }
        }
      }
    }
  }

  // Rotate principal-space sigma back to Voigt-6.
  let voigt: array<vec2<f32>, 6> = principalToVoigt6(sigmaOut, rec);
  for (var k: u32 = 0u; k < 6u; k = k + 1u) {
    sigmaReturned[gp * 6u + k] = voigt[k];
  }
  branchKind[gp] = branch;
  for (var k: u32 = 0u; k < 9u; k = k + 1u) {
    tangentPrincipal[gp * 9u + k] = tangent[k];
  }
  converged[gp] = ok;
}
`;

// =============================================================================
// Bind-group layout descriptor for the MC kernel.  Used by the device-bound
// runtime to construct the pipeline; kept here next to the WGSL source so the
// two stay in lockstep.
// =============================================================================
export const MC_BIND_GROUP_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },   // sigmaTrial
    { binding: 1, type: 'read-only-storage' },   // matIndex
    { binding: 2, type: 'read-only-storage' },   // matParams
    { binding: 3, type: 'storage' },             // sigmaReturned
    { binding: 4, type: 'storage' },             // branchKind
    { binding: 5, type: 'storage' },             // tangentPrincipal
    { binding: 6, type: 'storage' },             // converged
    { binding: 7, type: 'uniform' }              // params
  ]
};

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
