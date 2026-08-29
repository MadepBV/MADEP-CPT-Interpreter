// SPDX-License-Identifier: AGPL-3.0-or-later
// Native (g++) unit checks for the retaining-wall engine — hand-calc parity.
// Build: g++ -std=c++20 -O2 -I src/wasm/retaining src/wasm/retaining/test_native.cpp -o /tmp/rwtest
#include "earth_pressure.hpp"
#include "gravity_wall.hpp"
#include "embedded_wall.hpp"
#include "brinch_hansen.hpp"
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

  // ---------------------------------------------------------------------------------
  // Embedded engine v2 — parity with the course manual (Sheet_Pile_Retaining_Walls_Manual_EC7_PLAXIS_v24 §6)
  // ---------------------------------------------------------------------------------
  auto findBranch = [](const EmbeddedResult& R, const char* id) -> const BranchResult* {
    for (const auto& b : R.branches) if (b.spec.id == id) return &b;
    return nullptr;
  };
  auto sand = [](double topEl, double phiDeg, double gamma, double c = 0) {
    Stratum s; s.topEl = topEl; s.gammaMoist = gamma; s.gammaSat = gamma; s.phi = deg2rad(phiDeg);
    s.c = c; s.cu = 0; s.drained = true; s.qc = 0; return s;
  };

  std::printf("\n== course §6: one-level supported wall, H=6, a=1.2, phi=30, gamma=18, q=10 (RK2, dry +0.30 m) ==\n");
  {
    EmbeddedInput in;
    in.kind = WallKind::Continuous;
    in.geom.retainedSurfaceEl = 6.0; in.geom.excavationElNominal = 0.0; in.geom.embedment = 3.56806;
    in.geom.anchored = true; in.geom.anchorEl = 6.0 - 1.2;
    in.retained = {sand(6.0, 30, 18)}; in.front = {sand(6.0, 30, 18)};
    in.loads.surchargeVariable = 10.0;
    in.opt.deltaPassiveRatio = 0.0; in.opt.surchargeFloor = 0.0;
    in.branches.riskScheme = 2; in.branches.overdigRule = OverdigRule::Belgian;
    EmbeddedResult R = analyzeEmbedded(in);
    check("overdig ULS (Belgian dry)", R.overdigUls, 0.30, 1e-9);
    const BranchResult* d2 = findBranch(R, "DA1-2");
    const BranchResult* bgt = findBranch(R, "BGT");
    const BranchResult* sls = findBranch(R, "SLS");
    checkTrue("all four branches present", d2 && bgt && sls && findBranch(R, "DA1-1"));
    if (d2) {
      check("DA1/2 gamma_Q = 1.10 (RK2)", d2->spec.gQ, 1.10, 1e-9);
      check("DA1/2 phi_d", d2->back[0].phiDDeg, 24.7913, 1e-4);
      check("DA1/2 Ka,d", d2->back[0].Ka, 0.4091315, 1e-5);
      check("DA1/2 Kp,d (Rankine, delta=0)", d2->front[0].Kp, 2.4442018, 1e-5);
      check("DA1/2 free-earth D", d2->d0, 3.56806, 2e-4);
      check("DA1/2 support T", d2->T, 122.9213, 2e-4);
      check("DA1/2 M_max", d2->Mmax, 258.2326, 3e-3);
      check("DA1/2 y at M_max", d2->yMmax, 5.19899, 1e-2);
      check("DA1/2 p at surface", d2->pSurface, 4.500, 2e-3);
      check("DA1/2 p at excavation", d2->pExcavation, 50.896, 2e-3);
      check("DA1/2 net at toe", d2->pToeBack - d2->pToeFront, -79.807, 3e-3);
      check("DA1/2 zero net pressure z0", d2->zNetZero, 1.38941, 2e-2);
      check("DA1/2 ODF at provided (= required) ~ 1", d2->odfProvided, 1.0, 2e-3);
    }
    if (bgt) {
      check("BGT gamma_Q = alpha_ver 1.10", bgt->spec.gQ, 1.10, 1e-9);
      check("BGT nominal excavation (no over-dig)", bgt->excavationEl, 0.0, 1e-9);
      check("BGT free-earth D", bgt->d0, 2.4513, 3e-4);
      check("BGT T", bgt->T, 83.021, 3e-4);
      check("BGT T x1.35", bgt->TEd, 112.078, 3e-4);
      check("BGT M_max", bgt->Mmax, 146.265, 3e-3);
      check("BGT M x1.35", bgt->MEd, 197.458, 3e-3);
    }
    if (sls) {
      check("SLS free-earth D", sls->d0, 2.4362, 3e-4);
      check("SLS T", sls->T, 81.380, 3e-4);
      check("SLS M_max", sls->Mmax, 144.209, 3e-3);
      check("SLS z0", sls->zNetZero, 0.8194, 2e-2);
    }
    check("required D governed by DA1/2", R.requiredD, 3.56806, 2e-4);
    checkTrue("required D combo is DA1-2", R.requiredDCombo == "DA1-2");
    // default DA1/1 = separate-source (1.35 on retained side, 1.00 on passive): stricter than the course envelope
    checkTrue("separate-source DA1/1 governs the STR envelope", R.MCombo == "DA1-1" && R.MEd > 258.2);
    // guideline route (single-source DA1/1): envelope = max(DA1/2, 1.35 x BGT) as in the course
    in.branches.da11SeparateSource = false; in.anchor.spacing = 2.0; in.anchor.angleDeg = 15.0;
    EmbeddedResult Rs = analyzeEmbedded(in);
    checkTrue("single-source: M_Ed envelope governed by DA1-2", Rs.MCombo == "DA1-2");
    check("single-source: M_Ed envelope", Rs.MEd, 258.2326, 3e-3);
    check("single-source: T_Ed envelope", Rs.TEd, 122.9213, 3e-4);
    check("anchor axial per anchor (s=2, 15 deg)", Rs.anchorAxial, 254.5, 2e-3);
    check("anchor vertical component per m (65.9 kN / 2 m)", Rs.anchorVertical, 65.9 / 2.0, 3e-3);
  }

  std::printf("\n== course §4.3: cantilever illustration H=3, phi=30, gamma=18, q=0 (SLS branch) ==\n");
  {
    EmbeddedInput in;
    in.geom.retainedSurfaceEl = 3.0; in.geom.excavationElNominal = 0.0; in.geom.embedment = 3.5;
    in.retained = {sand(3.0, 30, 18)}; in.front = {sand(3.0, 30, 18)};
    in.opt.deltaPassiveRatio = 0.0;
    EmbeddedResult R = analyzeEmbedded(in);
    const BranchResult* sls = findBranch(R, "SLS");
    checkTrue("SLS branch present", sls != nullptr);
    if (sls) {
      check("cantilever free-earth D0", sls->d0, 2.778, 2e-3);
      check("cantilever design D = 1.2 D0", sls->dDesign, 1.2 * 2.778, 2e-3);
      check("cantilever zero net pressure z0", sls->zNetZero, 0.375, 3e-2);
      checkTrue("cantilever M_max positive", sls->Mmax > 0);
    }
    checkTrue("embedment check present", !R.checks.empty() && R.checks[0].id == "embedment");
  }

  std::printf("\n== Brinch Hansen coefficients (chapter §7.3 phi=20.5; Rekennota Table 5-6 phi=25) ==\n");
  {
    BrinchHansenConstants k = brinchHansenConstants(deg2rad(20.5));
    check("BH Pq", k.Pq, 2.776880, 1e-5); check("BH KqA", k.KqA, 0.412869, 1e-5);
    check("BH Kq0", k.Kq0, 2.364011, 1e-5); check("BH Kc0", k.Kc0, 4.752482, 1e-5);
    check("BH K0", k.K0, 0.649793, 1e-5); check("BH dcInf", k.dcInf, 1.659923, 1e-5);
    check("BH Nc", k.Nc, 15.314396, 1e-5); check("BH KcInf", k.KcInf, 25.420725, 1e-5);
    check("BH KqInf", k.KqInf, 6.175902, 1e-5); check("BH aq", k.aq, 0.171761, 1e-5); check("BH ac", k.ac, 0.377861, 1e-5);
    check("BH Kq(z/B=10)", brinchHansenKq(k, 10.0), 4.7732, 1e-4);
    check("BH Kq(z/B=14)", brinchHansenKq(k, 14.0), 5.0563, 1e-4);
    BrinchHansenConstants k25 = brinchHansenConstants(deg2rad(25.0));
    check("BH25 Kq0", k25.Kq0, 3.2869, 2e-4); check("BH25 Kc0", k25.Kc0, 5.6339, 2e-4);
    check("BH25 KqInf", k25.KqInf, 9.8932, 2e-4); check("BH25 KcInf", k25.KcInf, 36.7454, 2e-4);
    check("BH25 aq", k25.aq, 0.14395, 2e-4); check("BH25 ac", k25.ac, 0.30545, 2e-4);
    BrinchHansenConstants k0 = brinchHansenConstants(0.0);
    check("BH phi=0 Kc0 = 1+pi/2", k0.Kc0, 2.5708, 1e-4); check("BH phi=0 KcInf", k0.KcInf, 8.1237, 1e-4);
    check("BH phi=0 ac", k0.ac, 0.6547, 2e-4); check("BH phi=0 Kq(any) = 0", brinchHansenKq(k0, 5.0), 0.0, 1e-9);
  }

  std::printf("\n== Rekennota HEA180 h.o.h. 1.00 m — Blum with effective width, SF 1.30, berm 1.577 m @ 45 deg ==\n");
  {
    EmbeddedInput in;
    in.kind = WallKind::SoldierEffWidth;
    in.geom.retainedSurfaceEl = 71.216; in.geom.excavationElNominal = 69.600; in.geom.embedment = 4.484;
    in.geom.pileWidthB = 0.180; in.geom.spacingS = 1.00; in.geom.effectiveWidthFactor = 3.0;
    in.retained = {sand(71.216, 25, 19.5)}; in.front = {sand(71.216, 25, 19.5)};
    in.loads.berm.active = true; in.loads.berm.height = 1.577; in.loads.berm.slopeRad = deg2rad(45); in.loads.berm.gamma = 19.5;
    in.opt.deltaPassiveRatio = 0.0; in.opt.assumeCrackWater = false;
    in.branches.riskScheme = 2; in.branches.overdigRule = OverdigRule::Custom; in.branches.overdigCustom = 0.30;
    in.branches.materialOverride = true; in.branches.mOverride = {1.30, 1.30, 1.40, 1.0};
    EmbeddedResult R = analyzeEmbedded(in);
    const BranchResult* d2 = findBranch(R, "DA1-2");
    const BranchResult* d1 = findBranch(R, "DA1-1");
    if (d2) {
      check("Rekennota phi_red (1.30)", d2->back[0].phiDDeg, 19.733, 1e-4);
      check("Rekennota Ka (1.30)", d2->back[0].Ka, 0.4952, 2e-4);
      check("Rekennota Kp (1.30)", d2->front[0].Kp, 2.0195, 2e-4);
      check("Rekennota H_d", d2->excavationEl, 69.300, 1e-9);
      check("Rekennota sigma'_v,a at H_d = 55.46 kPa (via Ka)", d2->pExcavation / d2->back[0].Ka, 55.46, 2e-3);
      check("Rekennota t0 (SF 1.30)", d2->d0, 3.5393, 3e-3);
      check("Rekennota D_req = 1.2 t0", d2->dDesign, 4.247, 3e-3);
      check("Rekennota D_d provided", d2->dProvided, 4.484, 1e-6);
      checkTrue("Rekennota UC < 1 (D_req/D_d = 0.947)", d2->dDesign / d2->dProvided < 1.0);
    }
    if (d1) {
      check("Rekennota DA1/1 gamma_G,fav on passive = 1.00", d1->spec.gGResist, 1.00, 1e-9);
      check("Rekennota DA1/1 t0 (info)", d1->d0, 3.346, 3e-3);
      check("Rekennota DA1/1 M_Ed per pile", d1->MEd, 57.64, 1.5e-2);
      check("Rekennota DA1/1 V_Ed per pile (Blum C at t0)", d1->VEd, 85.03, 3e-2);
      check("Rekennota lagging p_Ed at H_d (DA1/1)", d1->lagging.total, 30.39, 3e-3);
    }
    // RK2 (1.25) sensitivity: t0 = 3.431 m
    in.branches.materialOverride = false;
    EmbeddedResult R2 = analyzeEmbedded(in);
    const BranchResult* d2b = findBranch(R2, "DA1-2");
    if (d2b) check("Rekennota t0 (RK2, 1.25)", d2b->d0, 3.431, 3e-3);
    // T_lat tables (c' = 0.5 kPa as in the note; B = b; equal-level convention rows)
    in.retained = {sand(71.216, 25, 19.5, 0.5)}; in.front = {sand(71.216, 25, 19.5, 0.5)};
    in.branches.materialOverride = true; in.materialOverrideForTlat = true;
    EmbeddedResult R3 = analyzeEmbedded(in);
    checkTrue("T_lat tables: characteristic, design, sensitivity", R3.tlat.size() == 3);
    if (R3.tlat.size() == 3) {
      const TlatTable& tk = R3.tlat[0]; const TlatTable& ts = R3.tlat[2];
      auto rowAt = [](const TlatTable& t, double z) -> const TlatRow* { for (auto& r : t.rows) if (std::fabs(r.z - z) < 1e-6) return &r; return nullptr; };
      const TlatRow* r1 = rowAt(tk, 1.0); const TlatRow* r3 = rowAt(tk, 3.0); const TlatRow* r1s = rowAt(ts, 1.0);
      checkTrue("T_lat rows at 1.0 / 3.0 m exist", r1 && r3 && r1s);
      if (r1) { check("T_lat char z=1: Kq", r1->Kq, 6.223, 1e-3); check("T_lat char z=1: Kc", r1->Kc, 25.210, 1e-3); check("T_lat char z=1: equal-level", r1->tlatEqual, 24.11, 2e-3); check("T_lat char z=1: row cap Kp*sv*s", r1->rowCap / 1.0, 48.05 + 2.0 * std::sqrt(2.4639) * 0.5 - 0.4059 * (19.5 * 2.916 + 30.752 - 24.248 / 2.916) + 2.0 * std::sqrt(0.4059) * 0.5, 5e-2); }
      if (r3) check("T_lat char z=3: equal-level", r3->tlatEqual, 86.56, 2e-3);
      if (r1s) check("T_lat 1.30 z=1: equal-level", r1s->tlatEqual, 15.10, 3e-3);
      check("T_lat char toe row", tk.rows.back().z, 4.484, 1e-6);
    }
  }

  std::printf("\n== soldier pile: Brinch Hansen hand-calc model runs and is more favourable than 1x width ==\n");
  {
    EmbeddedInput in;
    in.kind = WallKind::SoldierBrinchHansen;
    in.geom.retainedSurfaceEl = 3.0; in.geom.excavationElNominal = 0.0; in.geom.embedment = 4.0;
    in.geom.pileWidthB = 0.18; in.geom.spacingS = 1.5;
    in.retained = {sand(3.0, 30, 19)}; in.front = {sand(3.0, 30, 19)};
    in.opt.deltaPassiveRatio = 0.0;
    EmbeddedResult R = analyzeEmbedded(in);
    const BranchResult* d2 = findBranch(R, "DA1-2");
    checkTrue("BH model DA1/2 bracketed", d2 && d2->bracketed);
    EmbeddedInput ew = in; ew.kind = WallKind::SoldierEffWidth; ew.geom.effectiveWidthFactor = 1.0;
    EmbeddedResult Rw = analyzeEmbedded(ew);
    const BranchResult* w2 = findBranch(Rw, "DA1-2");
    if (d2 && w2) { std::printf("  d0 BH=%.3f  d0 effwidth(1b)=%.3f\n", d2->d0, w2->d0); checkTrue("BH needs less embedment than plane-strain on 1b", d2->d0 < w2->d0); }
  }

  std::printf("\n== embedded undrained crack water (full-tension clay) ==\n");
  {
    EmbeddedInput ci;
    ci.geom.retainedSurfaceEl = 3.0; ci.geom.excavationElNominal = 0.0; ci.geom.embedment = 3.0;
    Stratum clay; clay.topEl = 3.0; clay.gammaMoist = 18; clay.gammaSat = 18; clay.phi = 0; clay.c = 0; clay.cu = 60; clay.drained = false; clay.qc = 0;
    ci.retained = {clay}; ci.front = {clay};
    ci.branches.overdigRule = OverdigRule::None;
    EmbeddedInput cOff = ci; cOff.opt.assumeCrackWater = false;
    BranchSpec sls; sls.id = "SLS"; sls.gG = 1; sls.gQ = 1; sls.m = M1();
    EmbeddedModel mOn; mOn.build(WallKind::Continuous, ci.geom, ci.retained, ci.front, ci.loads, ci.opt, sls);
    EmbeddedModel mOff; mOff.build(WallKind::Continuous, cOff.geom, cOff.retained, cOff.front, cOff.loads, cOff.opt, sls);
    EmbStat stOn = integrateEmbedded(mOn, -3.0, -3.0);
    EmbStat stOff = integrateEmbedded(mOff, -3.0, -3.0);
    checkTrue("undrained crack ON drives the wall (Hdrive > 0)", stOn.Hdrive > 1.0);
    checkTrue("crack ON drives harder than OFF", stOn.Hdrive > stOff.Hdrive + 1.0);
  }

  std::printf("\n== anchored: out-of-range anchor level is clamped ==\n");
  {
    EmbeddedInput base;
    base.geom.retainedSurfaceEl = 6.0; base.geom.excavationElNominal = 0.0; base.geom.embedment = 2.5; base.geom.anchored = true; base.geom.anchorEl = 5.8;
    base.retained = {sand(6.0, 30, 18)}; base.front = {sand(6.0, 30, 18)};
    EmbeddedInput bad = base; bad.geom.anchorEl = 7.0;
    EmbeddedResult rc = analyzeEmbedded(base), rb = analyzeEmbedded(bad);
    bool noted = false; for (auto& n : rb.notes) if (n.find("clamped") != std::string::npos) noted = true;
    checkTrue("clamped anchor produces a note", noted);
    check("clamped M_Ed ~ control", rb.MEd, rc.MEd, 0.10);
    checkTrue("anchored needs less embedment than cantilever", rc.requiredD < analyzeEmbedded([&]{ EmbeddedInput c = base; c.geom.anchored = false; return c; }()).requiredD);
  }

  std::printf("\n%s (%d failure%s)\n", failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED",
              failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
