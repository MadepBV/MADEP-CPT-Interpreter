// SPDX-License-Identifier: AGPL-3.0-or-later
//
// interface.hpp — zero-thickness Coulomb soil-wall interface constitutive kernel
// (Phase 2). This header is the CONSTITUTIVE CORE only (local frame + return map +
// consistent tangent); node-splitting, wire format, and global assembly land in
// separate, separately-verified steps.
//
// CONVENTION: TENSION-POSITIVE, matching the continuum (types.hpp). The local
// traction is t = [t_t (shear), t_n (normal)], work-conjugate to the local jump
// [[u]] = [u_t, u_n] = R·(u_soil − u_wall), with R built from the wall local frame
// (beam.hpp): tangent ŝ = (sx,sy) = (dx,dy)/L (wall top→tip), normal n̂ = (−sy, sx).
//   t_n > 0  ⇒ tension  (⇒ gap),   t_n < 0 ⇒ compression (closed).
//   u_n > 0  ⇒ opening.
//
// LAW (Goodman–Taylor–Brekke 1968; Plaxis Material Models; DIANA Coulomb-friction;
// Potts & Zdravković 1999): elastic-perfectly-plastic Coulomb with a tension
// cut-off. Closed-state elastic operator D_e = diag(k_s, k_n). Interface strength
// reduced from the adjacent soil by R_inter (= deltaActiveRatio, default 0.667):
//   c_i = R_inter·c',   tan φ_i = R_inter·tan φ',   ψ_i = 0 (non-dilatant, default).
//   τ_max(t_n) = c_i − t_n·tan φ_i        (t_n < 0 ⇒ τ_max = c_i + |t_n|·tan φ_i)
//   yield  f = |t_t| − τ_max = |t_t| + t_n·tan φ_i − c_i
//
// Branches, evaluated on the elastic trial t^tr = t_committed + D_e·Δ[[u]]:
//   GAP   (t_n^tr ≥ 0, would go tensile):  t = 0, D_ep = 0 (+ tiny ε floor).
//   STICK (t_n^tr < 0, f ≤ 0):             t = t^tr, D_ep = D_e.
//   SLIP  (t_n^tr < 0, f > 0, ψ=0):        t_n = t_n^tr, t_t = sign(t_t^tr)·τ_max(t_n^tr),
//                                          D_ep = [[0, −s·tanφ_i·k_n],[0, k_n]]  (NON-symmetric).
//
// The consistent tangent rows are the returned traction [t_t, t_n]; columns are the
// jump [u_t, u_n]. The SLIP tangent is derived from first principles below and is
// finite-difference-validated in scripts/scratch/interface_unit.cpp.
//
#pragma once

#include <cmath>
#include <cstdint>

namespace madep::interface {

struct InterfaceParams {
  double k_n{ 0.0 };        // elastic normal stiffness (virtual-thickness penalty)
  double k_s{ 0.0 };        // elastic shear stiffness
  double c_i{ 0.0 };        // interface cohesion = R_inter·c'
  double tanPhi_i{ 0.0 };   // interface friction = R_inter·tan φ'
  double tanPsi_i{ 0.0 };   // interface dilatancy (0 ⇒ non-dilatant; recommended)
  double epsFloor{ 1e-8 };  // gap-branch stiffness floor (rigid-body-mode guard)
  // BILATERAL stations (soil on BOTH faces — the embedded depth below the
  // excavation level in the single-sided topology): a single node-pair spring
  // serves both contacts, so simultaneous two-face separation is impossible
  // and the unilateral gap law would mis-read "wall presses the passive face"
  // (t_n > 0 in the retained-ward convention) as an opening. Bilateral keeps
  // the normal spring bidirectional (NO gap branch) and takes the Coulomb
  // capacity from whichever face is engaged: τ_max = c_i + tanφ_i·|t_n|.
  // Unilateral (crest, retained-side-only) stations keep the gap law.
  bool bilateral{ false };
};

enum class Branch : std::uint8_t { Stick = 0, Slip = 1, Gap = 2 };

// One zero-thickness interface node-pair (per wall station). The element is a
// 4-translational-DOF point link between the soil-side node and its wall-side
// duplicate, integrated with the nodal (Newton-Cotes) tributary length `ell`
// (Schellekens & de Borst 1993 — nodal lumping decouples the node sets, so no
// Gauss traction oscillation along the closed interface). The committed
// constitutive state lives in a dedicated pseudo material-point slot `gpIndex`
// appended after the continuum Gauss points, so it rides the existing
// trial/commit/rollback, display, and safety state lifecycle for free:
//   effectiveStress[0] = t_t  (shear traction)
//   effectiveStress[1] = t_n  (normal traction, tension-positive)
//   effectiveStress[2] = u_t  (committed tangential jump)
//   effectiveStress[3] = u_n  (committed normal jump)
struct InterfaceElementCache {
  std::int32_t soilNode{ -1 };
  std::int32_t wallNode{ -1 };
  std::int32_t dofs[4]{ -1, -1, -1, -1 };  // [soil ux, soil uy, wall ux, wall uy]
  std::int32_t gpIndex{ -1 };              // pseudo-GP slot carrying the committed state
  double sx{ 0.0 }, sy{ 0.0 };             // wall tangent (top → tip), unit
  double nx{ 0.0 }, ny{ 0.0 };             // unit normal, oriented toward the RETAINED side
  double ell{ 0.0 };                       // tributary length (nodal Newton-Cotes weight)
  InterfaceParams params{};
};

struct InterfaceResponse {
  double t_t{ 0.0 };     // returned shear traction
  double t_n{ 0.0 };     // returned normal traction (tension-positive)
  double D[2][2]{};      // consistent tangent ∂t/∂[[u]] (rows = [t_t,t_n], cols = [u_t,u_n])
  Branch branch{ Branch::Stick };
};

// Incremental return map. (u_t,u_n) is the current local jump; (u_t_c,u_n_c) and
// (t_t_c,t_n_c) are the committed jump and committed traction (the committed
// traction carries the K0 seed at the start of excavation, so the interface
// starts CLOSED & STUCK and only mobilises/opens as the wall deflects).
inline InterfaceResponse interface_return(
    const InterfaceParams& p,
    double u_t, double u_n,
    double u_t_c, double u_n_c,
    double t_t_c, double t_n_c) {
  InterfaceResponse r;
  const double k_s = p.k_s, k_n = p.k_n;

  // Elastic trial (decoupled normal/shear penalty springs).
  const double tt = t_t_c + k_s * (u_t - u_t_c);
  const double tn = t_n_c + k_n * (u_n - u_n_c);
  const double tol = 1e-12 * (p.c_i + std::fabs(k_n * u_n) + std::fabs(k_s * u_t) + 1.0);

  if (p.bilateral) {
    // Embedded (two-face) station: normal spring is bidirectional, Coulomb cap
    // from the engaged face: τ_max = c_i + tanφ_i·|t_n|.
    const double tauMaxB = p.c_i + std::fabs(tn) * p.tanPhi_i;
    const double fB = std::fabs(tt) - tauMaxB;
    if (fB <= tol) {
      r.branch = Branch::Stick;
      r.t_t = tt;
      r.t_n = tn;
      r.D[0][0] = k_s; r.D[0][1] = 0.0;
      r.D[1][0] = 0.0; r.D[1][1] = k_n;
      return r;
    }
    // SLIP on the engaged face. With ψ_i = 0 (production default) t_n stays
    // elastic; the cap derivative follows the engaged face:
    // ∂τ_max/∂t_n = tanφ_i·sign(t_n), so ∂t_t/∂u_n = s·tanφ_i·sign(t_n)·k_n —
    // at t_n < 0 (retained face) this is −s·tanφ_i·k_n, identical to the
    // unilateral slip tangent (continuous). The exact `== 0.0` branch keeps
    // the production path byte-identical.
    //
    // General ψ_i ≥ 0 (task #56 Davis associated bracket, ψ_i* = φ_i*):
    // f = |t_t| − c_i − sn·t_n·tanφ_i, g = |t_t| − sn·t_n·tanψ_i with
    // sn = sign(t_n^tr); Δλ = f_tr/(k_s + k_n·tanφ_i·tanψ_i);
    // t = t^tr − Δλ·D_e·m, m = (s, −sn·tanψ_i). Consistent tangent
    // D = D_e − (D_e·m)(∂f_tr/∂u)ᵀ/den is SYMMETRIC iff ψ_i = φ_i.
    const double sB = (tt >= 0.0) ? 1.0 : -1.0;
    const double sn = (tn >= 0.0) ? 1.0 : -1.0;
    r.branch = Branch::Slip;
    if (p.tanPsi_i == 0.0) {
      r.t_n = tn;
      r.t_t = sB * tauMaxB;
      r.D[0][0] = 0.0; r.D[0][1] = sB * sn * p.tanPhi_i * k_n;
      r.D[1][0] = 0.0; r.D[1][1] = k_n;
      return r;
    }
    const double denB = k_s + k_n * p.tanPhi_i * p.tanPsi_i;
    const double dLamB = fB / denB;
    r.t_t = tt - dLamB * k_s * sB;
    r.t_n = tn + dLamB * k_n * sn * p.tanPsi_i;
    r.D[0][0] = k_s * k_n * p.tanPhi_i * p.tanPsi_i / denB;
    r.D[0][1] = sB * sn * k_s * k_n * p.tanPhi_i / denB;
    r.D[1][0] = sB * sn * k_s * k_n * p.tanPsi_i / denB;
    r.D[1][1] = k_n * k_s / denB;
    return r;
  }

  if (tn > 0.0) {
    // TENSION CUT-OFF (gap): multi-surface return, NOT a brittle kill. The
    // cut-off is a yield surface (Plaxis MM §interfaces; the brittle DIANA
    // variant zeroes both tractions discontinuously, which makes the global
    // residual non-continuous at the gap boundary and stalls Newton/LM on a
    // residual plateau — observed empirically before this fix):
    //   t_n returns to the cut-off (t_n = 0, plastic opening), and the shear
    //   is capped by the Coulomb cone AT the cut-off: |t_t| ≤ τ_max(0) = c_i.
    // Both tractions are CONTINUOUS across the closed↔open boundary (closed
    // slip gives ±(c_i − 0·tanφ_i) = ±c_i there), and an open interface still
    // carries at most the negligible c_i = R_inter·c′ shear (exactly zero for
    // a cohesionless soil) — the crest tension band is released either way.
    // STRICT inequality: the equilibrium-consistent staged start (t = 0 at
    // zero jump — the cut-face support, not the spring, carries the in-situ
    // confinement) must be CLOSED/STICK on the full elastic spring.
    r.branch = Branch::Gap;
    r.t_n = 0.0;
    const double cap = p.c_i;
    if (std::fabs(tt) <= cap) {
      r.t_t = tt;               // shear spring elastic below the t_n=0 cone
      r.D[0][0] = k_s;
    } else {
      r.t_t = (tt >= 0.0) ? cap : -cap;
      r.D[0][0] = 0.0;          // sliding on the cut-off cone
    }
    r.D[0][1] = 0.0;
    r.D[1][0] = 0.0;
    r.D[1][1] = p.epsFloor * k_n;  // opening direction: no normal stiffness (ε floor)
    return r;
  }

  // Closed (compressive). Coulomb shear cap with the tension-positive normal.
  const double tauMax = p.c_i - tn * p.tanPhi_i;   // tn < 0 ⇒ c_i + |tn|·tanφ_i
  const double f = std::fabs(tt) - tauMax;

  if (f <= tol) {
    // STICK: elastic, closed.
    r.branch = Branch::Stick;
    r.t_t = tt;
    r.t_n = tn;
    r.D[0][0] = k_s; r.D[0][1] = 0.0;
    r.D[1][0] = 0.0; r.D[1][1] = k_n;
    return r;
  }

  // SLIP: return to the Coulomb cone. With ψ_i = 0 there is no normal plastic
  // flow, so the normal traction stays elastic (t_n = tn) and the shear is capped
  // at ±τ_max. Consistent tangent (rows [t_t,t_n], cols [u_t,u_n]):
  //   t_n = t_n_c + k_n·(u_n − u_n_c)         ⇒ ∂t_n/∂u_t = 0,        ∂t_n/∂u_n = k_n
  //   t_t = s·τ_max = s·(c_i − t_n·tanφ_i)    ⇒ ∂t_t/∂u_t = 0 (frozen at the cap),
  //                                             ∂t_t/∂u_n = −s·tanφ_i·k_n
  // ⇒ D_ep = [[0, −s·tanφ_i·k_n],[0, k_n]] — singular in the slip direction and
  // NON-symmetric (the [t_t,u_n] coupling has no [t_n,u_t] partner); routes the
  // global solve to GMRES unless symmetrised, mirroring non-associated MC.
  // The exact `== 0.0` branch keeps the production path byte-identical.
  //
  // General ψ_i ≥ 0 (task #56 Davis associated bracket, ψ_i* = φ_i*):
  // f = |t_t| + t_n·tanφ_i − c_i, g = |t_t| + t_n·tanψ_i (dilatant slip);
  // Δλ = f_tr/(k_s + k_n·tanφ_i·tanψ_i); t = t^tr − Δλ·D_e·m, m = (s, tanψ_i).
  // D = D_e − (D_e·m)(s·k_s, tanφ_i·k_n)/den — SYMMETRIC iff ψ_i = φ_i.
  const double s = (tt >= 0.0) ? 1.0 : -1.0;
  r.branch = Branch::Slip;
  if (p.tanPsi_i == 0.0) {
    r.t_n = tn;
    r.t_t = s * tauMax;
    r.D[0][0] = 0.0; r.D[0][1] = -s * p.tanPhi_i * k_n;
    r.D[1][0] = 0.0; r.D[1][1] = k_n;
    return r;
  }
  const double den = k_s + k_n * p.tanPhi_i * p.tanPsi_i;
  const double dLam = f / den;
  r.t_t = tt - dLam * k_s * s;
  r.t_n = tn - dLam * k_n * p.tanPsi_i;
  r.D[0][0] = k_s * k_n * p.tanPhi_i * p.tanPsi_i / den;
  r.D[0][1] = -s * k_s * k_n * p.tanPhi_i / den;
  r.D[1][0] = -s * k_s * k_n * p.tanPsi_i / den;
  r.D[1][1] = k_n * k_s / den;
  return r;
}

}  // namespace madep::interface
