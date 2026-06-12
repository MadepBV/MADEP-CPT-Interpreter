// SPDX-License-Identifier: AGPL-3.0-or-later
// Native (g++) unit checks for the retaining-wall engine — hand-calc parity.
// Build: g++ -std=c++20 -O2 -I src/wasm/retaining src/wasm/retaining/test_native.cpp -o /tmp/rwtest
#include "earth_pressure.hpp"
#include "gravity_wall.hpp"
#include "embedded_wall.hpp"
#include <cstdio>
#include <cmath>

using namespace madep;

static int failures = 0;
static void check(const char* name, double got, double want, double tol) {
  double err = std::fabs(got - want);
  bool ok = err <= tol * (1.0 + std::fabs(want));
  std::printf("%-44s got=%-12.5f want=%-12.5f %s\n", name, got, want, ok ? "OK" : "  <<< FAIL");
  if (!ok) failures++;
}
static void checkTrue(const char* name, bool cond) {
  std::printf("%-44s %s\n", name, cond ? "OK" : "  <<< FAIL");
  if (!cond) failures++;
}

int main() {
  std::printf("== earth-pressure coefficients ==\n");
  check("Rankine Ka phi=30", rankineKaLevel(deg2rad(30)), 1.0 / 3.0, 1e-4);
  check("Rankine Kp phi=30", rankineKpLevel(deg2rad(30)), 3.0, 1e-4);
  check("Rankine Ka phi=20", rankineKaLevel(deg2rad(20)), 0.4903, 2e-3);
  check("Rankine Kp phi=20", rankineKpLevel(deg2rad(20)), 2.0396, 2e-3);
  check("tan^2(45-phi/2) phi=35", rankineKaLevel(deg2rad(35)),
        std::pow(std::tan(deg2rad(45 - 17.5)), 2), 1e-6);

  std::printf("\n== Coulomb active degenerates to Rankine (delta=theta=beta=0) ==\n");
  check("Coulomb Ka == Rankine Ka", coulombKa(deg2rad(30), 0, 0, 0), rankineKaLevel(deg2rad(30)), 1e-4);

  std::printf("\n== EN 1997-1 Annex C passive (closed form) ==\n");
  // delta=beta=theta=0 reproduces Rankine passive exactly.
  check("AnnexC Kp phi=30 d=0 == Rankine", annexCPassive(deg2rad(30), 0, 0, 0).Kgamma,
        rankineKpLevel(deg2rad(30)), 1e-3);
  check("AnnexC Kp phi=35 d=0 == Rankine", annexCPassive(deg2rad(35), 0, 0, 0).Kgamma,
        rankineKpLevel(deg2rad(35)), 1e-3);
  // at delta=0 the C.8 cohesion coefficient K_pc reduces to the Rankine 2*sqrt(Kp).
  check("AnnexC Kpc phi=30 d=0 == 2 sqrt(Kp)", annexCPassive(deg2rad(30), 0, 0, 0).Kc,
        2.0 * std::sqrt(rankineKpLevel(deg2rad(30))), 1e-3);
  {  // wall friction raises Kp above Rankine and stays finite/positive.
    double kp0 = annexCPassive(deg2rad(30), 0, 0, 0).Kgamma;
    double kp23 = annexCPassive(deg2rad(30), (2.0 / 3.0) * deg2rad(30), 0, 0).Kgamma;
    checkTrue("AnnexC Kp increases with delta", kp23 > kp0 && std::isfinite(kp23));
    std::printf("  phi=30: Kp(d=0)=%.3f  Kp(d=2/3 phi)=%.3f\n", kp0, kp23);
  }

  std::printf("\n== active thrust integrator (dry cohesionless) ==\n");
  // H=6 m, gamma=18, phi=30, Rankine level, no water/surcharge/cohesion.
  Stratum s; s.topEl = 6; s.gammaMoist = 18; s.gammaSat = 20; s.phi = deg2rad(30);
  s.c = 0; s.cu = 0; s.drained = true;
  std::vector<Stratum> col = {s};
  SideInput si; si.strata = &col; si.surfaceEl = 6; si.regionTopEl = 6; si.regionBotEl = 0;
  si.waterEl = -100; si.surcharge = 0; si.method = EpMethod::Rankine; si.delta = 0; si.theta = 0;
  si.beta = 0; si.isActive = true; si.assumeCrackWater = false; si.nSteps = 2000;
  SideThrust t = integrateSide(si);
  check("Pa = 1/2 Ka gamma H^2", t.soilN, 0.5 * (1.0 / 3.0) * 18 * 36, 5e-3);  // 108
  check("Pa resultant depth = 2H/3", t.soilZbar, 4.0, 5e-3);                    // 2/3*6

  std::printf("\n== active with uniform surcharge ==\n");
  si.surcharge = 20;  // q=20 kPa -> Ka*q*H = 1/3*20*6 = 40 at H/2
  t = integrateSide(si);
  check("surcharge thrust Ka*q*H", t.surchN, (1.0 / 3.0) * 20 * 6, 5e-3);  // 40
  check("surcharge resultant at H/2", t.surchZbar, 3.0, 5e-3);

  std::printf("\n== active with water table mid-height ==\n");
  si.surcharge = 0; si.waterEl = 3;  // water at 3 m elevation (3 m below top)
  t = integrateSide(si);
  // hydrostatic over lower 3 m: 1/2*9.81*3^2 = 44.1
  check("water thrust 1/2 gw h^2", t.waterN, 0.5 * 9.81 * 9.0, 1e-2);

  std::printf("\n== active with cohesion + tension crack ==\n");
  Stratum sc = s; sc.c = 10; col[0] = sc; si.waterEl = -100;
  t = integrateSide(si);
  // z0 = 2c/(gamma*sqrt(Ka)) = 2*10/(18*sqrt(1/3)) = 1.9245 m
  check("tension crack depth z0", t.crackDepth, 2 * 10 / (18 * std::sqrt(1.0 / 3.0)), 2e-2);

  std::printf("\n== FULL-HEIGHT tension zone (EN 1997-1 9.6(5)P) ==\n");
  {
    // Undrained stiff clay, 2cu >= gamma*H: the whole retained height is in
    // tension. The water-filled crack must deliver 0.5*gw*H^2, not zero.
    Stratum uc; uc.topEl = 3; uc.gammaMoist = 18; uc.gammaSat = 18; uc.phi = 0;
    uc.c = 0; uc.cu = 60; uc.drained = false;
    std::vector<Stratum> ucol = {uc};
    SideInput ui; ui.strata = &ucol; ui.surfaceEl = 3; ui.regionTopEl = 3; ui.regionBotEl = 0;
    ui.waterEl = 3; ui.surcharge = 0; ui.method = EpMethod::Rankine; ui.delta = 0; ui.theta = 0;
    ui.beta = 0; ui.isActive = true; ui.assumeCrackWater = true; ui.nSteps = 2000;
    SideThrust tu = integrateSide(ui);
    check("undrained full-tension crack depth = H", tu.crackDepth, 3.0, 1e-3);
    check("undrained full-tension crack water 1/2 gw H^2", tu.crackN, 0.5 * 9.81 * 9.0, 1e-3);
    check("undrained full-tension soil ordinates zero", tu.soilN, 0.0, 1e-6);
    // Continuity across the 2cu = gamma*H threshold: a 0.02 kPa cu change must
    // not collapse the total destabilising action (old code: 44.1 -> 0).
    ucol[0].cu = 26.99; SideThrust tlo = integrateSide(ui);
    ucol[0].cu = 27.01; SideThrust thi = integrateSide(ui);
    double totLo = tlo.soilN + tlo.waterN + tlo.crackN;
    double totHi = thi.soilN + thi.waterN + thi.crackN;
    check("total action continuous across 2cu=gamma*H", totHi, totLo, 2e-2);
    // Drained with large c': z0_theory = 2c'/(gamma*sqrt(Ka)) = 4.96 m > H=3.
    Stratum dc; dc.topEl = 3; dc.gammaMoist = 19; dc.gammaSat = 21; dc.phi = deg2rad(25);
    dc.c = 30; dc.cu = 0; dc.drained = true;
    std::vector<Stratum> dcol = {dc};
    SideInput di = ui; di.strata = &dcol; di.waterEl = -100;
    SideThrust td = integrateSide(di);
    check("drained full-tension crack depth = H", td.crackDepth, 3.0, 1e-3);
    check("drained full-tension crack water 1/2 gw H^2", td.crackN, 0.5 * 9.81 * 9.0, 1e-3);
  }

  std::printf("\n== crack water crossing the water table (excess-over-phreatic) ==\n");
  {
    // c'=10, phi=25, gamma=gammaSat=19, H=4, WT 1 m below the top. The crack
    // (z0 = 2.349 m) crosses the WT: crack water = dry triangle 0.5*gw*dw^2
    // + the constant excess rectangle gw*dw*(z0-dw) below it. The old cap at
    // dw dropped the rectangle (13.23 of 18.13 kN/m).
    Stratum mc; mc.topEl = 4; mc.gammaMoist = 19; mc.gammaSat = 19; mc.phi = deg2rad(25);
    mc.c = 10; mc.cu = 0; mc.drained = true;
    std::vector<Stratum> mcol = {mc};
    SideInput mi; mi.strata = &mcol; mi.surfaceEl = 4; mi.regionTopEl = 4; mi.regionBotEl = 0;
    mi.waterEl = 3; mi.surcharge = 0; mi.method = EpMethod::Rankine; mi.delta = 0; mi.theta = 0;
    mi.beta = 0; mi.isActive = true; mi.assumeCrackWater = true; mi.nSteps = 4000;
    SideThrust tm = integrateSide(mi);
    const double Ka25 = (1 - std::sin(deg2rad(25))) / (1 + std::sin(deg2rad(25)));
    const double svCrack = 2 * 10 / std::sqrt(Ka25);            // sigma'_v at crossover (kPa)
    const double z0 = 1.0 + (svCrack - 19.0) / (19.0 - 9.81);   // 2.349 m
    check("crack depth crossing WT", tm.crackDepth, z0, 5e-3);
    const double dw = 1.0;
    const double tri = 0.5 * 9.81 * dw * dw;
    const double rect = 9.81 * dw * (z0 - dw);
    check("crack water = triangle + excess rectangle", tm.crackN, tri + rect, 5e-3);
    check("crack water centroid (composite)", tm.crackZbar,
          (tri * (2.0 / 3.0) * dw + rect * 0.5 * (dw + z0)) / (tri + rect), 5e-3);
    check("phreatic thrust unchanged 1/2 gw 3^2", tm.waterN, 0.5 * 9.81 * 9.0, 1e-2);
  }

  std::printf("\n== MULTI-LAYER subdivision (2-layer active, Rankine) ==\n");
  // L1: 6..3 m, gamma=18, phi=30 (Ka1=1/3); L2: 3..0 m, gamma=20, phi=34 (Ka2).
  // sigma'_v at the 3 m interface = 18*3 = 54 kPa (continuous); Ka jumps 1/3 -> 0.2827.
  // Pa = 1/2*Ka1*g1*h1^2 + Ka2*sigma1*h2 + 1/2*Ka2*g2*h2^2.
  {
    double Ka1 = (1 - std::sin(deg2rad(30))) / (1 + std::sin(deg2rad(30)));
    double Ka2 = (1 - std::sin(deg2rad(34))) / (1 + std::sin(deg2rad(34)));
    double sig1 = 18 * 3.0;
    double Pa_hand = 0.5 * Ka1 * 18 * 9 + Ka2 * sig1 * 3 + 0.5 * Ka2 * 20 * 9;
    double zbar_hand;
    {  // resultant depth by moment about the top
      double m = 0.5 * Ka1 * 18 * 9 * (2.0)                      // L1 triangle at 2/3*3=2 m
               + Ka2 * sig1 * 3 * (3 + 1.5)                       // L2 rectangle centroid 4.5 m
               + 0.5 * Ka2 * 20 * 9 * (3 + 2.0);                  // L2 triangle centroid 5 m
      zbar_hand = m / Pa_hand;
    }
    Stratum a1; a1.topEl = 6; a1.gammaMoist = 18; a1.gammaSat = 20; a1.phi = deg2rad(30); a1.c = 0; a1.cu = 0; a1.drained = true;
    Stratum a2; a2.topEl = 3; a2.gammaMoist = 20; a2.gammaSat = 22; a2.phi = deg2rad(34); a2.c = 0; a2.cu = 0; a2.drained = true;
    std::vector<Stratum> two = {a1, a2};
    SideInput sl; sl.strata = &two; sl.surfaceEl = 6; sl.regionTopEl = 6; sl.regionBotEl = 0;
    sl.waterEl = -100; sl.surcharge = 0; sl.method = EpMethod::Rankine; sl.delta = 0; sl.theta = 0;
    sl.beta = 0; sl.isActive = true; sl.assumeCrackWater = false; sl.nSteps = 4000;
    SideThrust tl = integrateSide(sl);
    check("2-layer active thrust = subdivided hand calc", tl.soilN, Pa_hand, 3e-3);
    check("2-layer resultant depth", tl.soilZbar, zbar_hand, 5e-3);
    std::printf("  Ka1=%.4f Ka2=%.4f Pa=%.2f (hand %.2f) zbar=%.3f (hand %.3f)\n",
                Ka1, Ka2, tl.soilN, Pa_hand, tl.soilZbar, zbar_hand);
  }

  std::printf("\n== gravity/cantilever sanity ==\n");
  GravityInput gi;
  gi.geom = {0.8, 2.2, 0.3, 0.45, 5.5, 0.6, 0.0, 0.0, 24.0, 0.0, 0.0, 0.0, false};
  gi.backfill = {0, 18, 20, deg2rad(32), 0, 0, true};
  gi.insitu = {{0, 19, 21, deg2rad(34), 5, 0, true}};
  gi.waterRetainedEl = -100; gi.waterFrontEl = -100; gi.surcharge = 10;
  gi.s = {EpMethod::Rankine, 0.0, 1.0, 0.0, true, 0.667, true, 0, true, 2, 0, 1500};
  GravityResult gr = analyzeGravity(gi);
  std::printf("  checks: %zu\n", gr.checks.size());
  for (auto& c : gr.checks)
    std::printf("    %-14s combo=%-3s Ed=%-10.2f Rd=%-10.2f util=%.3f %s\n",
                c.id.c_str(), c.combo.c_str(), c.Ed, c.Rd, c.util, c.pass ? "PASS" : "FAIL");
  std::printf("  M_stem=%.1f V_stem=%.1f M_toe=%.1f M_heel=%.1f\n",
              gr.M_stem, gr.V_stem, gr.M_toe, gr.M_heel);
  checkTrue("gravity produces sliding+bearing checks", gr.checks.size() >= 4);
  checkTrue("stem moment positive & finite", gr.M_stem > 0 && std::isfinite(gr.M_stem));

  std::printf("\n== embedded cantilever sheet pile (dry sand) ==\n");
  EmbeddedInput ei;
  ei.geom = {6.0, 0.0, 3.0, false, 0.0};  // retained surf=6, exc=0, d=3, cantilever
  ei.retained = {{6.0, 18, 20, deg2rad(30), 0, 0, true}};
  ei.front = {{0.0, 18, 20, deg2rad(30), 0, 0, true}};
  ei.waterRetainedEl = -100; ei.waterFrontEl = -100; ei.surcharge = 0;
  ei.s = {EpMethod::Rankine, 0.0, 0.667, false, 0.0, 0.0, 2, 0, 1500};
  {
    auto backD = designProfile(ei.retained, M1());
    auto frontD = designProfile(ei.front, M1());
    double odf2 = odfAt(ei, backD, frontD, 2.0, 0, 1.0, 1.0, false, 0);
    double odf4 = odfAt(ei, backD, frontD, 4.0, 0, 1.0, 1.0, false, 0);
    checkTrue("cantilever ODF increases with embedment", odf4 > odf2);
    double dReq = requiredEmbedment(ei, backD, frontD, 0, 1.0, 1.0, false, 0);
    double odfAtReq = odfAt(ei, backD, frontD, dReq, 0, 1.0, 1.0, false, 0);
    check("cantilever ODF at required d ~ 1.0", odfAtReq, 1.0, 1e-2);
    std::printf("  cantilever d_required(free-earth)=%.2f m\n", dReq);
    checkTrue("cantilever d_required in plausible range", dReq > 1.0 && dReq < 8.0);
  }
  EmbeddedResult er = analyzeEmbedded(ei);
  std::printf("  M_max=%.1f kNm/m  d_required(x1.2)=%.2f m\n", er.Mmax, er.requiredD);
  checkTrue("cantilever M_max positive", er.Mmax > 0 && std::isfinite(er.Mmax));

  std::printf("\n== embedded anchored sheet pile (dry sand) ==\n");
  EmbeddedInput ai = ei;
  ai.geom = {6.0, 0.0, 2.5, true, 5.0};  // anchor at el=5 (1 m below top), exc=0
  EmbeddedResult ar = analyzeEmbedded(ai);
  std::printf("  M_max=%.1f kNm/m  anchor=%.1f kN/m  d_required=%.2f m\n",
              ar.Mmax, ar.anchorForce, ar.requiredD);
  checkTrue("anchored anchor force positive", ar.anchorForce > 0 && std::isfinite(ar.anchorForce));
  checkTrue("anchored M_max positive", ar.Mmax > 0);
  checkTrue("anchored needs less embedment than cantilever", ar.requiredD < er.requiredD);

  std::printf("\n== deep-anchor moment diagram: span lobe survives the tail clamp ==\n");
  {
    // H=8 m, anchor 5 m below top, d=6 m, sand phi'=30. The governing peak is
    // the anchor hogging (~230 kNm/m); the genuine span-sagging lobe below it
    // (~-27 kNm/m) and the closure must remain in the plotted series. The old
    // clamp (first M-zero below the governing peak) zeroed them away.
    EmbeddedInput di;
    di.geom = {8.0, 0.0, 6.0, true, 3.0};  // anchorEl = 8 - 5
    di.retained = {{8.0, 18, 20, deg2rad(30), 0, 0, true}};
    di.front = {{0.0, 18, 20, deg2rad(30), 0, 0, true}};
    di.waterRetainedEl = -1000; di.waterFrontEl = -1000; di.surcharge = 0;
    di.s = {EpMethod::Rankine, 0.0, 0.667, false, 0.0, 0.0, 2, 0, 1500};
    EmbeddedResult dr = analyzeEmbedded(di);
    const Series* sM = nullptr;
    for (auto& d : dr.diagrams) if (d.id.rfind("M_", 0) == 0) { sM = &d; break; }
    checkTrue("deep-anchor M series shipped", sM != nullptr);
    if (sM) {
      double mMin = 0, mEnd = sM->v.empty() ? 1e9 : sM->v.back();
      for (double v : sM->v) mMin = std::min(mMin, v);
      std::printf("  Mmax=%.1f (%s)  span lobe min=%.1f  M(end)=%.2f\n",
                  dr.Mmax, dr.strCombo.c_str(), mMin, mEnd);
      checkTrue("governing anchor-hogging Mmax plausible (150..320)", dr.Mmax > 150 && dr.Mmax < 320);
      checkTrue("span-sagging lobe preserved (min M <= -10)", mMin <= -10.0);
      checkTrue("divergent tail clamped (|M(end)| < 1)", std::fabs(mEnd) < 1.0);
    }
  }

  std::printf("\n== out-of-range anchor level is clamped (T no longer dropped) ==\n");
  {
    EmbeddedInput base;
    base.geom = {6.0, 0.0, 2.5, true, 5.8};  // anchor 0.2 m below top (control)
    base.retained = {{6.0, 18, 20, deg2rad(30), 0, 0, true}};
    base.front = {{0.0, 18, 20, deg2rad(30), 0, 0, true}};
    base.waterRetainedEl = -1000; base.waterFrontEl = -1000; base.surcharge = 0;
    base.s = {EpMethod::Rankine, 0.0, 0.667, false, 0.0, 0.0, 2, 0, 1500};
    EmbeddedInput bad = base;
    bad.geom.anchorEl = 7.0;  // ABOVE the wall top: previously T was silently dropped
    EmbeddedResult rc = analyzeEmbedded(base);
    EmbeddedResult rb = analyzeEmbedded(bad);
    bool noted = false;
    for (auto& n : rb.notes) if (n.find("clamped") != std::string::npos) noted = true;
    std::printf("  Mmax control=%.1f  clamped=%.1f\n", rc.Mmax, rb.Mmax);
    checkTrue("clamped anchor produces a note", noted);
    check("clamped Mmax ~ control Mmax", rb.Mmax, rc.Mmax, 0.10);
  }

  std::printf("\n== embedded undrained crack water (full-tension clay) ==\n");
  {
    // Uniform stiff clay cu=60, 3 m cut: 2cu > gamma*H over the retained
    // height, so the active ordinate is in tension everywhere. With the crack
    // water assumption ON the wall must still see the hydrostatic crack column
    // (old code: zero driving water for undrained strata -> requiredD collapses).
    EmbeddedInput ci;
    ci.geom = {3.0, 0.0, 3.0, false, 0.0};
    ci.retained = {{3.0, 18, 18, 0, 0, 60, false}};
    ci.front = {{0.0, 18, 18, 0, 0, 60, false}};
    ci.waterRetainedEl = -100; ci.waterFrontEl = -100; ci.surcharge = 0;
    ci.s = {EpMethod::Rankine, 0.0, 0.667, true, 0.0, 0.0, 2, 0, 1500};
    EmbeddedInput cOff = ci; cOff.s.assumeCrackWater = false;
    auto backOn  = designProfile(ci.retained, M1());
    auto frontOn = designProfile(ci.front, M1());
    EmbStat stOn  = integrateEmbedded(ci,   backOn, frontOn, -3.0, -3.0, 0, 1.0, 1.0);
    EmbStat stOff = integrateEmbedded(cOff, backOn, frontOn, -3.0, -3.0, 0, 1.0, 1.0);
    checkTrue("undrained crack ON drives the wall (Hdrive > 0)", stOn.Hdrive > 1.0);
    checkTrue("crack ON drives harder than OFF", stOn.Hdrive > stOff.Hdrive + 1.0);
  }

  std::printf("\n%s (%d failure%s)\n", failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED",
              failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
