// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit test for the zero-thickness Coulomb interface kernel (interface.hpp):
// validates the stick/slip/gap return map and finite-difference-checks the
// consistent tangent in each branch (including the slip non-symmetry).
#include "interface.hpp"
#include <cstdio>
#include <cmath>
#include <cstdlib>

using madep::interface::InterfaceParams;
using madep::interface::InterfaceResponse;
using madep::interface::Branch;
using madep::interface::interface_return;

static int g_fail = 0;
static void check(const char* name, bool ok, double got = 0, double exp = 0) {
  std::printf("%s  %s", ok ? "OK  " : "FAIL", name);
  if (!ok) std::printf("   got=%.8g exp=%.8g", got, exp);
  std::printf("\n");
  if (!ok) g_fail++;
}
static bool close(double a, double b, double rtol = 1e-5, double atol = 1e-6) {
  return std::fabs(a - b) <= atol + rtol * std::fabs(b);
}

// Central-difference the return-map traction wrt the local jump and compare to D.
static void fd_tangent_check(const char* tag, const InterfaceParams& p,
                             double u_t, double u_n, double u_t_c, double u_n_c,
                             double t_t_c, double t_n_c) {
  InterfaceResponse r = interface_return(p, u_t, u_n, u_t_c, u_n_c, t_t_c, t_n_c);
  const double h = 1e-9;
  // d/du_t
  InterfaceResponse rp = interface_return(p, u_t + h, u_n, u_t_c, u_n_c, t_t_c, t_n_c);
  InterfaceResponse rm = interface_return(p, u_t - h, u_n, u_t_c, u_n_c, t_t_c, t_n_c);
  double dtt_dut = (rp.t_t - rm.t_t) / (2 * h);
  double dtn_dut = (rp.t_n - rm.t_n) / (2 * h);
  // d/du_n
  InterfaceResponse qp = interface_return(p, u_t, u_n + h, u_t_c, u_n_c, t_t_c, t_n_c);
  InterfaceResponse qm = interface_return(p, u_t, u_n - h, u_t_c, u_n_c, t_t_c, t_n_c);
  double dtt_dun = (qp.t_t - qm.t_t) / (2 * h);
  double dtn_dun = (qp.t_n - qm.t_n) / (2 * h);
  char buf[128];
  std::snprintf(buf, sizeof buf, "%s: D[0][0]=dt_t/du_t", tag); check(buf, close(r.D[0][0], dtt_dut, 1e-4, 1e-2 * (p.k_s + 1)), r.D[0][0], dtt_dut);
  std::snprintf(buf, sizeof buf, "%s: D[1][0]=dt_n/du_t", tag); check(buf, close(r.D[1][0], dtn_dut, 1e-4, 1e-2 * (p.k_n + 1)), r.D[1][0], dtn_dut);
  std::snprintf(buf, sizeof buf, "%s: D[0][1]=dt_t/du_n", tag); check(buf, close(r.D[0][1], dtt_dun, 1e-4, 1e-2 * (p.k_n + 1)), r.D[0][1], dtt_dun);
  std::snprintf(buf, sizeof buf, "%s: D[1][1]=dt_n/du_n", tag); check(buf, close(r.D[1][1], dtn_dun, 1e-4, 1e-2 * (p.k_n + 1)), r.D[1][1], dtn_dun);
}

int main() {
  InterfaceParams p;
  p.k_s = 1e5; p.k_n = 1e5; p.c_i = 5.0; p.tanPhi_i = 0.5; p.tanPsi_i = 0.0;

  // Committed: closed, compressive K0 seed t_n_c = -10 (tension-positive), at zero jump.
  const double utc = 0.0, unc = 0.0, ttc = 0.0, tnc = -10.0;

  // ---- STICK: small jump, closed, below the cone. ----
  {
    double u_t = 1e-5, u_n = -1e-5;  // tt=1, tn=-11
    InterfaceResponse r = interface_return(p, u_t, u_n, utc, unc, ttc, tnc);
    check("stick: branch", r.branch == Branch::Stick);
    check("stick: t_t", close(r.t_t, 1.0), r.t_t, 1.0);
    check("stick: t_n", close(r.t_n, -11.0), r.t_n, -11.0);
    check("stick: D=diag(k_s,k_n) off-diag 0", r.D[0][1] == 0.0 && r.D[1][0] == 0.0);
    fd_tangent_check("stick", p, u_t, u_n, utc, unc, ttc, tnc);
  }

  // ---- SLIP: large shear jump, closed ⇒ capped at τ_max, non-symmetric tangent. ----
  {
    double u_t = 1e-3, u_n = -1e-5;  // tt=100, tn=-11
    double tauMax = p.c_i - (-11.0) * p.tanPhi_i;  // 5 + 5.5 = 10.5
    InterfaceResponse r = interface_return(p, u_t, u_n, utc, unc, ttc, tnc);
    check("slip: branch", r.branch == Branch::Slip);
    check("slip: t_t = +tauMax", close(r.t_t, tauMax), r.t_t, tauMax);
    check("slip: t_n stays elastic", close(r.t_n, -11.0), r.t_n, -11.0);
    check("slip: D[0][0]=0 (shear frozen)", r.D[0][0] == 0.0, r.D[0][0], 0.0);
    check("slip: D[0][1]=-s*tanPhi*k_n", close(r.D[0][1], -1.0 * p.tanPhi_i * p.k_n), r.D[0][1], -p.tanPhi_i * p.k_n);
    check("slip: NON-symmetric (D[0][1]!=D[1][0])", r.D[0][1] != r.D[1][0]);
    fd_tangent_check("slip", p, u_t, u_n, utc, unc, ttc, tnc);
    // negative shear direction
    InterfaceResponse rn = interface_return(p, -u_t, u_n, utc, unc, ttc, tnc);
    check("slip(-): t_t = -tauMax", close(rn.t_t, -tauMax), rn.t_t, -tauMax);
  }

  // ---- TENSION CUT-OFF (gap): multi-surface return — t_n → 0, shear capped by
  // the Coulomb cone AT the cut-off (|t_t| ≤ c_i). Continuous at the boundary. ----
  {
    double u_t = 1e-4, u_n = 1e-3;  // tn^tr = -10 + 1e5*1e-3 = 90 > 0; tt^tr = 10 > c_i
    InterfaceResponse r = interface_return(p, u_t, u_n, utc, unc, ttc, tnc);
    check("gap: branch", r.branch == Branch::Gap);
    check("gap: t_n returned to cut-off (0)", r.t_n == 0.0, r.t_n, 0.0);
    check("gap: shear capped at c_i", close(r.t_t, p.c_i), r.t_t, p.c_i);
    check("gap: normal stiffness ~ 0 (eps floor)", r.D[1][1] < 1e-3 * p.k_n);
    // below the cone: shear stays elastic
    InterfaceResponse rl = interface_return(p, 1e-8, u_n, utc, unc, ttc, tnc);
    check("gap: small shear elastic (|tt|<c_i)", close(rl.t_t, 1e-3) && rl.D[0][0] == p.k_s, rl.t_t, 1e-3);
    // CONTINUITY across the closed↔open boundary: at tn→0⁻ closed slip gives
    // ±c_i; at tn→0⁺ the cut-off cap is ±c_i. Probe both sides of u_n = 1e-4.
    double unb = 1e-4;  // tn^tr = -10 + 10 = 0 exactly → closed (strict >)
    InterfaceResponse rc = interface_return(p, 1e-3, unb - 1e-12, utc, unc, ttc, tnc);
    InterfaceResponse ro = interface_return(p, 1e-3, unb + 1e-12, utc, unc, ttc, tnc);
    check("gap: shear continuous across boundary", std::fabs(rc.t_t - ro.t_t) < 1e-4, rc.t_t, ro.t_t);
    check("gap: normal continuous across boundary", std::fabs(rc.t_n - ro.t_n) < 1e-4, rc.t_n, ro.t_n);
  }

  // ---- ZERO-TRACTION START: the staged equilibrium seed (t=0, jump=0) must be
  // CLOSED/STICK (strict gap inequality), so the wished-in-place wall starts
  // coupled on the full elastic spring rather than the eps floor. ----
  {
    InterfaceResponse r = interface_return(p, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    check("zero-start: branch is STICK (not gap)", r.branch == Branch::Stick);
    check("zero-start: full elastic stiffness", r.D[0][0] == p.k_s && r.D[1][1] == p.k_n);
    check("zero-start: tractions zero", r.t_t == 0.0 && r.t_n == 0.0);
  }

  // ---- RE-CLOSURE: commit a gap state, then a closing jump re-establishes contact. ----
  {
    // After a gap step the committed state is (t=0) at the opened jump u_c=(0, 1e-3).
    double u_t = 0.0, u_n = 0.0;  // closing back: tn = 0 + 1e5*(0 - 1e-3) = -100 < 0
    InterfaceResponse r = interface_return(p, u_t, u_n, /*u_t_c=*/0.0, /*u_n_c=*/1e-3, /*t_t_c=*/0.0, /*t_n_c=*/0.0);
    check("reclose: branch closed (stick)", r.branch == Branch::Stick);
    check("reclose: t_n compressive", close(r.t_n, -100.0), r.t_n, -100.0);
  }

  // ---- BILATERAL (embedded, two-face): no gap; cap from the ENGAGED face. ----
  {
    InterfaceParams b = p;
    b.bilateral = true;
    // "Tension" trial (wall pressing the passive face): must stay CLOSED,
    // carry the normal force bidirectionally, and cap shear by c_i+tanφ|t_n|.
    double u_t = 1e-7, u_n = 1e-3;  // tn = -10 + 100 = +90 (passive face engaged)
    InterfaceResponse r = interface_return(b, u_t, u_n, utc, unc, ttc, tnc);
    check("bilateral: NO gap at t_n>0", r.branch != Branch::Gap);
    check("bilateral: normal carried bidirectionally", close(r.t_n, 90.0), r.t_n, 90.0);
    // slip on the passive face: large shear
    double tauMaxP = b.c_i + 90.0 * b.tanPhi_i;  // 5 + 45 = 50
    InterfaceResponse rs = interface_return(b, 1e-2, u_n, utc, unc, ttc, tnc);
    check("bilateral: slip capped by engaged-face friction", close(rs.t_t, tauMaxP), rs.t_t, tauMaxP);
    fd_tangent_check("bilateral-slip(+tn)", b, 1e-2, u_n, utc, unc, ttc, tnc);
    // retained face engaged (tn<0): must match the unilateral cap exactly
    InterfaceResponse rr = interface_return(b, 1e-3, -1e-5, utc, unc, ttc, tnc);
    InterfaceResponse ru = interface_return(p, 1e-3, -1e-5, utc, unc, ttc, tnc);
    check("bilateral(t_n<0) == unilateral slip traction", close(rr.t_t, ru.t_t) && close(rr.t_n, ru.t_n));
    fd_tangent_check("bilateral-slip(-tn)", b, 1e-3, -1e-5, utc, unc, ttc, tnc);
  }

  // ---- Coulomb cap monotonicity: deeper confinement ⇒ larger τ_max. ----
  {
    InterfaceResponse a = interface_return(p, 1e-3, -1e-5, utc, unc, ttc, tnc);   // tn=-11, tauMax=10.5
    InterfaceResponse b = interface_return(p, 1e-3, -1e-4, utc, unc, ttc, tnc);   // tn=-20, tauMax=15
    check("cap grows with confinement", b.t_t > a.t_t, b.t_t, a.t_t);
  }

  std::printf("\n%s: %d failure(s)\n", g_fail ? "FAILURES" : "ALL OK", g_fail);
  return g_fail ? 1 : 0;
}
