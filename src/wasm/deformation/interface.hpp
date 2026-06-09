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

  if (tn >= 0.0) {
    // GAP: the node-pair has separated — an open contact carries no normal or
    // shear traction (DIANA: t_n → 0 immediately on gap; a separated interface
    // transmits no shear). This is the release that lets the retained crest soil
    // pull away from the wall instead of being dragged into MC-unsustainable
    // tension (the glued-band barrier capping staged construction).
    r.branch = Branch::Gap;
    r.t_t = 0.0;
    r.t_n = 0.0;
    r.D[0][0] = p.epsFloor * k_s; r.D[0][1] = 0.0;
    r.D[1][0] = 0.0;              r.D[1][1] = p.epsFloor * k_n;
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
  const double s = (tt >= 0.0) ? 1.0 : -1.0;
  r.branch = Branch::Slip;
  r.t_n = tn;
  r.t_t = s * tauMax;
  r.D[0][0] = 0.0; r.D[0][1] = -s * p.tanPhi_i * k_n;
  r.D[1][0] = 0.0; r.D[1][1] = k_n;
  return r;
}

}  // namespace madep::interface
