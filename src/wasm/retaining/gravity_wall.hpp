// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gravity & RC cantilever wall engine — methodology §3 (GEO/EQU/SLS) and §4
// (structural design forces only). Coordinates: x from toe tip (front) = 0;
// elevation y up with base underside = 0. Per metre run (strip), forces kN/m.
#pragma once

#include "earth_pressure.hpp"
#include "factors.hpp"
#include "results.hpp"
#include <vector>
#include <cmath>
#include <cstdio>
#include <string>

namespace madep {

struct GravityGeom {
  double toe;          // toe length Ltoe (m)
  double heel;         // heel length Lheel (m)
  double stemThkTop;   // stem thickness at top (m)
  double stemThkBot;   // stem thickness at base (m)
  double stemHeight;   // stem height (base top -> top of wall) (m)
  double baseThk;      // base slab thickness (m)
  double keyDepth;     // shear-key depth below base (m, 0 = none)
  double keyThk;       // shear-key thickness (m)
  double gammaConc;    // concrete unit weight (kN/m^3)
  double beta;         // backfill slope (rad)
  double backBatter;   // back-face batter from vertical (rad) — gravity wall
  double frontSoilEl;  // front soil surface elevation above base underside (m)
  bool isGravity;      // true = mass gravity (Coulomb back face); false = RC cantilever
  // derived
  double B() const { return toe + stemThkBot + heel; }
  double topOfWallEl() const { return baseThk + stemHeight; }
  double xStemFront() const { return toe; }
  double xStemBackBase() const { return toe + stemThkBot; }
};

struct GravitySettings {
  EpMethod activeMethod;   // Rankine (cantilever virtual plane) or Coulomb (gravity back face)
  double deltaActiveRatio; // delta/phi' on the active face (Coulomb gravity); 0 on the virtual plane
  double deltaBaseRatio;   // delta_b/phi' for base sliding (1.0 cast-in-situ, 2/3 precast)
  double baseAdhesion;     // c_a on base (kPa)
  bool passiveToe;         // include passive resistance in front of the toe (front soil)
  double passiveDeltaRatio;// k = delta_p/phi'_d on the passive face (default 2/3, EN 1993-5)
  bool assumeCrackWater;   // fill tension crack with water
  int bearingMethod;       // 0 = EN 1997-1 Annex D (c-phi); 1 = De Beer CPT-direct
  bool bearingDepthFactors;// Annex D: include Brinch-Hansen/Vesic depth factors (opt-in refinement)
  int consequenceClass;    // 1..3
  int riskScheme;          // 0 = EN/ANB default
  int nSteps;
};

struct GravityInput {
  GravityGeom geom;
  Stratum backfill;              // characteristic backfill (single material)
  std::vector<Stratum> insitu;   // characteristic in-situ profile (foundation/front)
  double waterRetainedEl;        // water-table elevation behind wall
  double waterFrontEl;           // water-table elevation in front
  double surcharge;              // uniform variable surcharge on backfill (kPa)
  GravitySettings s;
};

// A single permanent vertical (down) load with its lever about the toe tip.
struct VLoad { double W; double x; const char* name; };

// Assemble the characteristic permanent vertical loads (weights). γ never factored.
inline std::vector<VLoad> gravityWeights(const GravityInput& in) {
  const GravityGeom& g = in.geom;
  std::vector<VLoad> v;
  double gc = g.gammaConc;
  // base slab
  v.push_back({gc * g.B() * g.baseThk, 0.5 * g.B(), "base"});
  // stem (trapezoid: front vertical at x=toe; thickness top..bot)
  double As = 0.5 * (g.stemThkTop + g.stemThkBot) * g.stemHeight;
  // centroid x of trapezoid with front face vertical at x=toe:
  // measure thickness from front face; centroid offset from front:
  double tt = g.stemThkTop, tb = g.stemThkBot;
  double xc = (tb * tb + tb * tt + tt * tt) / (3.0 * (tb + tt));  // from front face
  v.push_back({gc * As, g.toe + xc, "stem"});
  // shear key
  if (g.keyDepth > 1e-6 && g.keyThk > 1e-6) {
    v.push_back({gc * g.keyDepth * g.keyThk, g.toe + 0.5 * g.stemThkBot, "key"});
  }
  // soil on heel (backfill): rectangle from base-top to top-of-wall, plus slope wedge
  double hsoil = g.topOfWallEl() - g.baseThk;  // height of soil over heel up to top of wall
  if (hsoil > 0 && g.heel > 0) {
    double gb = in.backfill.gammaMoist;
    double xheel = g.xStemBackBase() + 0.5 * g.heel;
    // Split the heel soil column at the retained water table for ALL water positions:
    // total (moist) weight above, total (saturated) weight below. Buoyancy of the whole
    // submerged free body is handled by the explicit base uplift (gravityBaseUplift).
    double wtc = clampd(in.waterRetainedEl, g.baseThk, g.topOfWallEl());
    double hAbove = g.topOfWallEl() - wtc;
    double hBelow = wtc - g.baseThk;
    double Wrect = g.heel * (gb * hAbove + in.backfill.gammaSat * hBelow);
    v.push_back({Wrect, xheel, "heel-soil"});
    // sloping backfill wedge above top of wall over the heel
    if (g.beta > 1e-6) {
      double rise = g.heel * std::tan(g.beta);
      double Wtri = 0.5 * gb * g.heel * rise;
      v.push_back({Wtri, g.xStemBackBase() + (2.0 / 3.0) * g.heel, "heel-wedge"});
    }
  }
  return v;
}

// Trapezoidal hydrostatic uplift on the base underside (permanent water action,
// single-source with the lateral water thrust). Pore pressure varies linearly from
// u_front at the toe edge (x=0) to u_back at the heel edge (x=B). Returns the upward
// resultant U (kN/m) and its lever x from the toe. Zero when the water table is at or
// below the base underside.
struct BaseUplift { double U; double x; };
inline BaseUplift gravityBaseUplift(const GravityInput& in) {
  double B = in.geom.B();
  double uFront = GAMMA_W * std::max(in.waterFrontEl, 0.0);    // head at toe edge (x=0)
  double uBack = GAMMA_W * std::max(in.waterRetainedEl, 0.0);  // head at heel edge (x=B)
  double U = 0.5 * (uFront + uBack) * B;
  double denom = uFront + uBack;
  double x = denom > 1e-9 ? B * (uFront + 2.0 * uBack) / (3.0 * denom) : 0.5 * B;
  return {U, x};
}

// Active thrust on the virtual back plane (cantilever) or back face (gravity).
struct GravityThrust {
  double Hsoil, ySoil;   // permanent horizontal + height above base
  double Vsoil;          // permanent vertical (down) at heel
  double Hsurch, ySurch; // variable horizontal
  double Hwater, yWater; // permanent water horizontal
  double Hcrack, yCrack;
  double crackDepth;
  SideThrust raw;
};

inline GravityThrust gravityActive(const GravityInput& in, const MaterialFactors& m) {
  const GravityGeom& g = in.geom;
  // backfill design strength
  Stratum bf = in.backfill;
  double phid = designPhi(bf.phi, m.gPhi);
  double cd = designC(bf.c, m.gC);
  double cud = designCu(bf.cu, m.gCu);
  double Hv = g.topOfWallEl() + g.heel * std::tan(g.beta);  // virtual-plane height
  Stratum bfd = bf; bfd.phi = phid; bfd.c = cd; bfd.cu = cud; bfd.topEl = Hv;
  std::vector<Stratum> col = {bfd};

  double delta = in.s.activeMethod == EpMethod::Coulomb ? in.s.deltaActiveRatio * phid : 0.0;
  // Coulomb back-face batter taken from the DRAWN geometry (stem taper), so the analysed
  // wall equals the drawn wall; falls back to the explicit backBatter for a prismatic stem.
  double theta = 0.0;
  if (in.s.activeMethod == EpMethod::Coulomb) {
    double geomBatter = (g.stemHeight > 1e-6)
                            ? std::atan((g.stemThkBot - g.stemThkTop) / g.stemHeight) : 0.0;
    theta = std::fabs(geomBatter) > 1e-4 ? geomBatter : g.backBatter;
  }

  SideInput si;
  si.strata = &col;
  si.surfaceEl = Hv; si.regionTopEl = Hv; si.regionBotEl = 0.0;
  si.waterEl = in.waterRetainedEl;
  si.surcharge = in.surcharge;
  si.method = in.s.activeMethod;
  si.delta = delta; si.theta = theta; si.beta = g.beta;
  si.isActive = true; si.assumeCrackWater = in.s.assumeCrackWater;
  si.nSteps = in.s.nSteps;
  SideThrust t = integrateSide(si);

  GravityThrust gt; gt.raw = t;
  double incl = t.incl;
  gt.Hsoil = t.soilN * std::cos(incl);
  gt.Vsoil = t.soilN * std::sin(incl);
  gt.ySoil = Hv - t.soilZbar;
  gt.Hsurch = t.surchN * std::cos(incl);
  gt.ySurch = Hv - t.surchZbar;
  gt.Hwater = t.waterN;
  gt.yWater = Hv - t.waterZbar;
  gt.Hcrack = t.crackN;
  gt.yCrack = Hv - t.crackZbar;
  gt.crackDepth = t.crackDepth;
  return gt;
}

// Transparent breakdown of the bearing resistance so the UI can show exactly how q_Rd is built.
struct BearingDetail {
  double qRd = 0;                 // gross design bearing resistance per unit effective area (kPa)
  double Nq = 0, Nc = 0, Ng = 0;  // EN 1997-1 Annex D capacity factors
  double iq = 1, ic = 1, ig = 1;  // load-inclination factors
  double dq = 1, dc = 1, dg = 1;  // Brinch-Hansen/Vesic depth factors (d_gamma = 1)
  double Dembed = 0, k = 0;       // embedment and the depth-factor parameter k = D/B' (or atan)
  double qc_eq = 0, kc = 0;       // De Beer / CPT-direct: equivalent cone resistance, bearing factor
  int method = 0;                 // 0 = Annex D (c-phi), 1 = De Beer (CPT-direct)
};

// Brinch-Hansen / Vesic depth factors (D.2-1 / Vesic 1973). d_gamma = 1; only the surcharge (q)
// and cohesion (c) terms gain a depth bonus from the soil shear above founding. k = D/B' for
// D/B' <= 1, else arctan(D/B') in radians. EN 1997-1 Annex D is INFORMATIVE and omits these, so
// they are an opt-in, physically-justified refinement for a buried toe (never the safe default).
inline void hansenDepthFactors(double phi, double Nc, double Dembed, double Bp, bool enable,
                               double& dq, double& dc, double& dg, double& kOut) {
  dq = 1.0; dc = 1.0; dg = 1.0; kOut = 0.0;
  if (!enable || Bp <= 1e-6 || Dembed <= 0.0) return;
  double DB = Dembed / Bp;
  double k = (DB <= 1.0) ? DB : std::atan(DB);
  kOut = k;
  double s = std::sin(phi);
  dq = 1.0 + 2.0 * std::tan(phi) * (1.0 - s) * (1.0 - s) * k;   // d_q
  dc = dq - (1.0 - dq) / (Nc * std::tan(phi));                  // d_c (phi > 0)
  dg = 1.0;                                                      // d_gamma = 1
}

// Annex D drained bearing resistance (strip, shape factors = 1) with inclination and optional
// depth factors. Fills the BearingDetail breakdown for transparency.
inline void bearingDrained(double phi, double c, double gammaPrime, double Bp,
                           double qOverburden, double H, double V, double Dembed,
                           bool depthFactors, BearingDetail& out) {
  if (phi < deg2rad(1.0)) phi = deg2rad(1.0);
  double Nq = std::exp(PI * std::tan(phi)) * std::pow(std::tan(deg2rad(45) + 0.5 * phi), 2.0);
  double Nc = (Nq - 1.0) / std::tan(phi);
  double Ng = 2.0 * (Nq - 1.0) * std::tan(phi);
  double m = 2.0;  // strip: B'/L' -> 0
  double denom = V + Bp * c / std::tan(phi);
  double base = (denom > 1e-9) ? (1.0 - H / denom) : 0.0;
  base = clampd(base, 0.0, 1.0);
  double iq = std::pow(base, m);
  double ig = std::pow(base, m + 1.0);
  double ic = iq - (1.0 - iq) / (Nc * std::tan(phi));
  ic = clampd(ic, 0.0, 1.0);
  double dq, dc, dg, k;
  hansenDepthFactors(phi, Nc, Dembed, Bp, depthFactors, dq, dc, dg, k);
  out.method = 0; out.Nq = Nq; out.Nc = Nc; out.Ng = Ng;
  out.iq = iq; out.ic = ic; out.ig = ig; out.dq = dq; out.dc = dc; out.dg = dg;
  out.Dembed = Dembed; out.k = k;
  out.qRd = c * Nc * ic * dc + qOverburden * Nq * iq * dq + 0.5 * gammaPrime * Bp * Ng * ig * dg;
}
inline void bearingUndrained(double cu, double qOverburden, double Bp, double H, double V,
                             double Dembed, bool depthFactors, BearingDetail& out) {
  double ratio = (Bp * cu > 1e-9) ? (H / (Bp * cu)) : 1.0;
  ratio = clampd(ratio, 0.0, 1.0);
  double ic = 0.5 * (1.0 + std::sqrt(std::max(1.0 - ratio, 0.0)));
  double dc = 1.0, k = 0.0;
  if (depthFactors && Bp > 1e-6 && Dembed > 0.0) {
    double DB = Dembed / Bp;
    k = (DB <= 1.0) ? DB : std::atan(DB);
    dc = 1.0 + 0.4 * k;   // Skempton/Hansen undrained (phi=0) depth factor
  }
  out.method = 0; out.ic = ic; out.dc = dc; out.Dembed = Dembed; out.k = k;
  out.qRd = (PI + 2.0) * cu * ic * dc + qOverburden;
}

struct GravityResult {
  std::vector<CheckResult> checks;
  std::vector<Series> diagrams;
  std::vector<KV> summary;
  std::vector<std::string> notes;
  // structural design forces (envelope)
  double M_stem = 0, V_stem = 0;
  double M_toe = 0, V_toe = 0;
  double M_heel = 0, V_heel = 0;
  std::string strComboStem, strComboToe, strComboHeel;
};

// Foundation stratum at founding elevation (just below base underside). Used where a single
// representative soil is correct (base-interface friction, Annex D bearing).
inline Stratum foundationStratum(const GravityInput& in) {
  if (in.insitu.empty()) return in.backfill;  // fallback
  int idx = stratumAt(in.insitu, -0.001);
  return in.insitu[idx];
}

// EN 1997-1 §9.3.2.2 unplanned (over-)excavation allowance in front of the wall: for a
// normally-controlled site, Δa = min(0.10·H, 0.5 m) with H the retained height above the
// front excavation level. Design passive/overburden is counted below (frontSoilEl − Δa).
inline double overDigAllowance(const GravityGeom& g) {
  double Href = g.topOfWallEl() - g.frontSoilEl;
  if (Href <= 0.0) return 0.0;
  return std::min(0.10 * Href, 0.5);
}

// Design-factored copy of the LAYERED in-situ profile (all CPT layers preserved), so the
// passive toe and the resistance-side overburden subdivide per layer exactly like the
// embedded engine — continuous σ'_v, per-layer φ'_d, c'_d, K_p and the C.8 K_pc.
inline std::vector<Stratum> designInsitu(const GravityInput& in, const MaterialFactors& m) {
  std::vector<Stratum> out = in.insitu;
  if (out.empty()) out.push_back(in.backfill);
  for (auto& st : out) {
    st.phi = designPhi(st.phi, m.gPhi);
    st.c = designC(st.c, m.gC);
    st.cu = designCu(st.cu, m.gCu);
  }
  return out;
}

// Effective vertical stress at founding level (el=0) from the front soil column between
// `qTopEl` and the base underside, integrating the LAYERED in-situ profile with buoyant
// unit weight below the front water table (characteristic γ; γ is never factored, M·γ=1.0).
inline double frontEffectiveOverburden(const GravityInput& in, double qTopEl) {
  if (qTopEl <= 1e-6 || in.insitu.empty()) return 0.0;
  const std::vector<Stratum>& prof = in.insitu;
  int N = 200; double dz = qTopEl / N; double sig = 0.0;
  for (double el = qTopEl - 0.5 * dz; el > 0.0; el -= dz) {
    const Stratum& st = prof[stratumAt(prof, el)];
    bool sub = el < in.waterFrontEl;
    sig += (sub ? (st.gammaSat - GAMMA_W) : st.gammaMoist) * dz;
  }
  return sig;
}

// ============================ De Beer / NF P94-261 CPT-direct bearing ============================
// SHALLOW-strip-footing bearing from the CPT cone resistance: q_net = kc·q_ce·i_delta. This is the
// shallow-foundation method (De Beer's 1965 shallow-footing lineage, codified in NF P94-261 /
// Fascicule 62-V): a shallow toe mobilises only a FRACTION kc << 1 of q_c. It is DISTINCT from the
// deep-pile BGGG-GBMS De Beer method (q_b ~ q_c, with the cone->pile scale transformation) used in
// the pile module — a different failure mechanism (general/surface shear vs deep punching). It is a
// DIRECT method: the resistance is the measured q_c, divided by the NF resistance + model factors
// gamma_R;v · gamma_R;d (1.4 · 1.2), NOT the DA1 M-factored strength route.
struct KcTab { double kc0, a, b, c, kcmax; };
inline KcTab deBeerKcTable(const Stratum& fnd) {
  // NF P94-261 Tableau E.2.3, STRIP footing (B/L = 0). Two auto-classified categories.
  bool sandLike = fnd.drained && fnd.phi >= deg2rad(25.0);
  if (sandLike) return {0.09, 0.04, 0.006, 2.0, 0.141};   // sables & graves
  return {0.27, 0.07, 0.007, 1.3, 0.348};                 // argiles & limons
}
// Equivalent cone resistance q_ce over the influence zone [founding, founding − 1.5·B'] with the
// De Beer / NF peak clip (q_c > 1.3·q_cm → 1.3·q_cm). q_c is per layer (kPa). NF Formule E.2.2.1.
inline double deBeerQce(const std::vector<Stratum>& prof, double hr, double& clipLim) {
  clipLim = 0.0;
  if (prof.empty() || hr <= 1e-6) return 0.0;
  int N = 120; double dz = hr / N; double sum = 0.0; int cnt = 0;
  for (double el = -0.5 * dz; el > -hr; el -= dz) { sum += prof[stratumAt(prof, el)].qc; cnt++; }
  if (!cnt) return 0.0;
  double qcm = sum / cnt; clipLim = 1.3 * qcm; double sum2 = 0.0;
  for (double el = -0.5 * dz; el > -hr; el -= dz) sum2 += std::min(prof[stratumAt(prof, el)].qc, clipLim);
  return sum2 / cnt;
}
// Equivalent embedment D_e = (1/q_ce)·∫_0^D q_cc dz (NF Formule C.2.2). The integrand is the SAME
// clipped q_cc = min(q_c, 1.3·q_cm) used for q_ce — a strong band in the cover must not inflate D_e.
inline double deBeerDe(const std::vector<Stratum>& prof, double Dembed, double qce, double clipLim) {
  if (prof.empty() || qce <= 1e-6 || Dembed <= 1e-6) return 0.0;
  int N = 60; double dz = Dembed / N, sum = 0.0;
  for (double el = Dembed - 0.5 * dz; el > 0.0; el -= dz) {
    double qc = prof[stratumAt(prof, el)].qc;
    if (clipLim > 0.0 && qc > clipLim) qc = clipLim;
    sum += qc * dz;
  }
  return sum / qce;
}
// Returns true if q_c data is available (so De Beer can run); fills the BearingDetail breakdown.
inline bool bearingDeBeer(const GravityInput& in, double Bp, double Dembed, double q0,
                          double Hd, double Vd, const Stratum& fnd, BearingDetail& out) {
  double clipLim = 0.0;
  double qce = deBeerQce(in.insitu, 1.5 * Bp, clipLim);
  if (!(qce > 1e-3)) return false;             // no CPT q_c → caller falls back to Annex D
  double De = deBeerDe(in.insitu, Dembed, qce, clipLim);
  double DeB = (Bp > 1e-6) ? De / Bp : 0.0;
  KcTab t = deBeerKcTable(fnd);
  double kc = t.kc0 + (t.a + t.b * DeB) * (1.0 - std::exp(-t.c * DeB));   // NF Formule E.2.3
  if (kc > t.kcmax) kc = t.kcmax;
  double iDelta = (Vd > 1e-9) ? clampd(1.0 - Hd / Vd, 0.0, 1.0) : 0.0;    // load-inclination (NF Annex Q spirit)
  iDelta *= iDelta;
  double qnet = kc * qce * iDelta;             // net ultimate bearing (kPa)
  double gammaR = 1.4 * 1.2;                   // gamma_R;v (1.4 ULS) · gamma_R;d (1.2 model factor)
  out.method = 1; out.qc_eq = qce; out.kc = kc; out.Dembed = De; out.iq = iDelta;
  out.qRd = qnet / gammaR + q0;                // design gross bearing per unit area (incl. overburden R_0)
  return true;
}

// Passive resistance developed in the front soil over the buried toe/base front face.
// Strength is M-factored at source and resistance divided by R1 (=1.0) — NO lumped
// mobilisation factor (the embedded-wall convention; mobilisation belongs in a separate SLS
// movement check, not the ULS path). The front soil subdivides per CPT layer, the unplanned
// over-dig Δa removes the top band, the wall friction is delta_p = k·φ'_d per layer (Annex C),
// and the cohesion uses the C.8 K_pc. Returns the horizontal resistance (kN/m); *yOut = height
// of its resultant above the base; *vOut = the vertical drag R_p,v = R_p,h·tan(delta_p).
inline double gravityPassiveToe(const GravityInput& in, const Combination& cb, double* yOut,
                                double* vOut = nullptr) {
  if (yOut) *yOut = 0.0;
  if (vOut) *vOut = 0.0;
  if (!in.s.passiveToe) return 0.0;
  const GravityGeom& g = in.geom;
  double over = overDigAllowance(g);
  double top = g.frontSoilEl - over;          // passive only below the unplanned-dig level
  if (top <= 0.05) return 0.0;
  std::vector<Stratum> col = designInsitu(in, cb.m);  // layered, design strength
  double k = clampd(in.s.passiveDeltaRatio, 0.0, 1.0);
  SideInput si;
  si.strata = &col;
  // The unplanned over-dig Δa REMOVES the top band of front soil, so σ'_v restarts at ZERO at the
  // design dig level (frontSoilEl − Δa) — accumulating it from the real surface would wrongly add
  // the removed soil's overburden Kp·γ'·Δa to every ordinate below (unsafe). This matches the
  // bearing-side overburden, which also starts at frontSoilEl − Δa (frontEffectiveOverburden).
  si.surfaceEl = top;             // excavated (design) front surface — sigma'_v = 0 here
  si.regionTopEl = top;           // passive counted from the design dig level down
  si.regionBotEl = 0.0;           // base underside
  si.waterEl = in.waterFrontEl;
  si.surcharge = 0.0;
  si.method = EpMethod::CaquotKerisel;        // ignored — passiveK is always Annex C
  si.delta = 0.0; si.passiveDeltaK = k;       // delta_p = k·φ'_d recomputed per layer
  si.theta = 0.0; si.beta = 0.0;
  si.isActive = false; si.assumeCrackWater = false; si.nSteps = in.s.nSteps;
  SideThrust t = integrateSide(si);
  double Hp = t.soilN;                         // horizontal (Annex C, incl=0); C.8 cohesion folded in
  if (yOut) *yOut = top - t.soilZbar;          // height above base of the passive resultant
  if (vOut) {                                  // vertical drag for the wall vertical free body
    Stratum f = foundationStratum(in);
    double deltaF = k * designPhi(f.phi, cb.m.gPhi);
    *vOut = Hp * std::tan(deltaF);
  }
  return Hp / cb.r.gPassive;                    // R1 = 1.0 (DA1); no mobilisation factor
}

// Evaluate sliding + bearing + eccentricity for one GEO/STR combination.
inline void evalGravityGeo(const GravityInput& in, const Combination& cb, GravityResult& R) {
  const GravityGeom& g = in.geom;
  double B = g.B();
  auto W = gravityWeights(in);
  GravityThrust t = gravityActive(in, cb.m);
  double kFI = cb.kFI;

  double sumW = 0, sumWx = 0;
  for (auto& w : W) { sumW += w.W; sumWx += w.W * w.x; }
  BaseUplift up = gravityBaseUplift(in);  // base hydrostatic uplift (permanent water)

  // ---- SLIDING ----
  {
    double gG = cb.a.gG_unfav * kFI, gQ = cb.a.gQ_unfav * kFI, gGf = cb.a.gG_fav;
    double Hdrive = gG * t.Hsoil + gQ * t.Hsurch + gG * (t.Hwater + t.Hcrack);
    // net base-normal force: favourable weights, uplift single-sourced with the water
    // thrust (gamma_G,unfav) — consistent with the BEARING and EQU blocks.
    double Vres = gGf * (sumW + t.Vsoil) - gG * up.U;
    // base friction design
    Stratum fnd = foundationStratum(in);
    double phiB = designPhi(fnd.phi, cb.m.gPhi) * in.s.deltaBaseRatio;
    double tanDeltaB = std::tan(phiB);
    // eccentricity for B'
    double Mstb = gGf * (sumWx + t.Vsoil * B) - gG * up.U * up.x;
    double Mdst = gG * (t.Hsoil * t.ySoil + t.Hwater * t.yWater + t.Hcrack * t.yCrack)
                + gQ * (t.Hsurch * t.ySurch);
    double xR = (Vres > 1e-9) ? (Mstb - Mdst) / Vres : 0.5 * B;
    double e = std::fabs(0.5 * B - xR);
    double Bp = std::max(B - 2.0 * e, 0.05 * B);
    double caTerm = in.s.baseAdhesion * Bp;
    double Rd = (Vres * tanDeltaB + caTerm) / cb.r.gSliding;
    if (!fnd.drained) {
      double Rcu = designCu(fnd.cu, cb.m.gCu) * Bp / cb.r.gSliding;
      Rd = std::min(Rcu, 0.4 * Vres);  // undrained interface cap
    }
    double yp = 0.0, vp = 0.0;
    double Rp = gravityPassiveToe(in, cb, &yp, &vp);  // passive resistance in front of the toe
    Rd += Rp;
    CheckResult cr;
    cr.id = "sliding"; cr.label = "Base sliding (GEO)";
    cr.combo = cb.id; cr.comboLabel = cb.label; cr.verb = "H_d <= R_d + R_p,d"; cr.unit = "kN/m";
    cr.setFromEdRd(Hdrive, Rd);
    cr.extra.push_back({"H_drive", Hdrive, "kN/m"});
    cr.extra.push_back({"V_resist", Vres, "kN/m"});
    cr.extra.push_back({"uplift_U", up.U, "kN/m"});
    cr.extra.push_back({"R_passive", Rp, "kN/m"});
    cr.extra.push_back({"R_passive_vert", vp, "kN/m"});
    cr.extra.push_back({"tan_delta_b", tanDeltaB, ""});
    cr.extra.push_back({"B_eff", Bp, "m"});
    R.checks.push_back(cr);
  }

  // ---- BEARING (single-source gG on all permanent incl. uplift) ----
  {
    double gG = cb.a.gG_unfav * kFI, gQ = cb.a.gQ_unfav * kFI;
    double Vd = gG * (sumW + t.Vsoil - up.U);
    double Hd = gG * t.Hsoil + gQ * t.Hsurch + gG * (t.Hwater + t.Hcrack);
    double Mstb = gG * (sumWx + t.Vsoil * B - up.U * up.x);
    double Mdst = gG * (t.Hsoil * t.ySoil + t.Hwater * t.yWater + t.Hcrack * t.yCrack)
                + gQ * (t.Hsurch * t.ySurch);
    double xR = (Vd > 1e-9) ? (Mstb - Mdst) / Vd : 0.5 * B;
    double e = std::fabs(0.5 * B - xR);
    double Bp = std::max(B - 2.0 * e, 0.05 * B);
    Stratum fnd = foundationStratum(in);
    // Effective (buoyant) unit weight for the N_gamma failure wedge below the footing when the
    // founding level is below the water table. The wedge straddles the wall, so it is submerged
    // whenever EITHER the retained or the front water table reaches founding — keying off the
    // FRONT level alone wrongly used moist weight for a water-retaining wall (dry front, high
    // back water), over-stating the N_gamma term ~2x. Use the higher of the two tables.
    double wtAtFound = std::max(in.waterRetainedEl, in.waterFrontEl);
    double gammaPrime = (wtAtFound > -0.001) ? (fnd.gammaSat - GAMMA_W) : fnd.gammaMoist;
    // overburden at founding level on the resistance side, integrated over the LAYERED front
    // soil with EFFECTIVE (buoyant) unit weight below the water table (§3 Check 2). The
    // unplanned over-dig Δa removes the top band, consistent with the passive cut.
    double qFront = std::max(g.frontSoilEl - overDigAllowance(g), 0.0);
    double qOv = frontEffectiveOverburden(in, qFront);
    double Dembed = qFront;   // design founding depth below the front surface (embedment)
    BearingDetail det;
    bool deBeer = false;
    if (in.s.bearingMethod == 1)
      deBeer = bearingDeBeer(in, Bp, Dembed, qOv, Hd, Vd, fnd, det);  // false if no q_c → fall back
    if (!deBeer) {
      if (fnd.drained) {
        double phid = designPhi(fnd.phi, cb.m.gPhi);
        double cd = designC(fnd.c, cb.m.gC);
        bearingDrained(phid, cd, gammaPrime, Bp, qOv, Hd, Vd, Dembed, in.s.bearingDepthFactors, det);
      } else {
        double cud = designCu(fnd.cu, cb.m.gCu);
        bearingUndrained(cud, qOv, Bp, Hd, Vd, Dembed, in.s.bearingDepthFactors, det);
      }
    }
    double qRd = det.qRd;
    // Cross-check: also evaluate the OTHER bearing route at this combo (transparency). The
    // direct-CPT (De Beer) and phi-capped Annex D routes legitimately diverge — most at shallow
    // embedment, where Annex D loses its overburden (q') and depth-factor terms under the inclined
    // load while the measured q_c does not — so showing both means a method switch is never a
    // surprise. The cross-check value uses R1=1.0 (Annex D) or the NF factors (De Beer), matching
    // each route's own normalisation, so it is directly comparable to q_Rd above.
    double qRdXcheck = 0.0; const char* xLabel = nullptr; BearingDetail xd;
    if (deBeer) {                       // selected De Beer -> cross-check Annex D
      if (fnd.drained)
        bearingDrained(designPhi(fnd.phi, cb.m.gPhi), designC(fnd.c, cb.m.gC), gammaPrime, Bp, qOv, Hd, Vd, Dembed, in.s.bearingDepthFactors, xd);
      else
        bearingUndrained(designCu(fnd.cu, cb.m.gCu), qOv, Bp, Hd, Vd, Dembed, in.s.bearingDepthFactors, xd);
      qRdXcheck = xd.qRd / cb.r.gBearing; xLabel = "q_Rd (Annex D)";
    } else {                            // selected Annex D -> cross-check De Beer (if q_c present)
      if (bearingDeBeer(in, Bp, Dembed, qOv, Hd, Vd, fnd, xd)) { qRdXcheck = xd.qRd; xLabel = "q_Rd (De Beer)"; }
    }
    // De Beer already carries its own resistance + model factors (gamma_R;v·gamma_R;d) in qRd;
    // Annex D uses the DA1 R1 resistance factor (=1.0).
    double Rd = deBeer ? Bp * qRd : Bp * qRd / cb.r.gBearing;
    CheckResult cr;
    cr.id = "bearing";
    cr.label = deBeer ? "Base bearing resistance (De Beer / NF P94-261, CPT-direct)"
                      : "Base bearing resistance (GEO, Annex D)";
    cr.combo = cb.id; cr.comboLabel = cb.label; cr.verb = "V_d <= R_d"; cr.unit = "kN/m";
    cr.setFromEdRd(Vd, Rd);
    cr.extra.push_back({"q_Ed", Vd / Bp, "kPa"});
    cr.extra.push_back({"q_Rd", qRd, "kPa"});
    cr.extra.push_back({"e", e, "m"});
    cr.extra.push_back({"B_eff", Bp, "m"});
    if (deBeer) {
      cr.extra.push_back({"q_ce", det.qc_eq, "kPa"});
      cr.extra.push_back({"k_c", det.kc, ""});
      cr.extra.push_back({"D_e", det.Dembed, "m"});
      cr.extra.push_back({"i_delta", det.iq, ""});
      cr.note = "De Beer / NF P94-261 CPT-direct method: q_net = k_c·q_ce·i_delta from the cone "
                "resistance near founding (k_c << 1 for a shallow footing), divided by the NF "
                "resistance+model factors gamma_R;v·gamma_R;d = 1.4·1.2. This is a DIRECT method, "
                "distinct from the DA1 Annex D (c-phi) check and from the deep-pile De Beer method "
                "(q_b ~ q_c) in the pile module — a shallow surface-shear, not deep-punching, mechanism.";
    } else {
      if (fnd.drained) {
        cr.extra.push_back({"i_q", det.iq, ""});   // load-inclination penalty (key bearing driver)
        cr.extra.push_back({"N_q", det.Nq, ""});
        cr.extra.push_back({"N_gamma", det.Ng, ""});
      }
      if (in.s.bearingDepthFactors && det.Dembed > 0.0) {
        cr.extra.push_back({"D_embed", det.Dembed, "m"});
        cr.extra.push_back({"d_q", det.dq, ""});
        if (fnd.drained) cr.extra.push_back({"d_c", det.dc, ""});
        cr.note = "Includes the opt-in Brinch-Hansen/Vesic depth factors for the embedded toe "
                  "(d_q, d_c above); EN 1997-1 Annex D itself omits depth factors (conservative). "
                  "The inclined, eccentric load on a shallow footing is what governs bearing.";
      }
    }
    if (xLabel && qRdXcheck > 0.0) {
      cr.extra.push_back({xLabel, qRdXcheck, "kPa"});
      cr.note += std::string(cr.note.empty() ? "" : " ") +
        "Cross-check: the alternative bearing route's q_Rd is listed above. The direct-CPT (De Beer) "
        "and phi-capped Annex D routes legitimately differ — most at shallow embedment, where Annex D "
        "loses its overburden and depth terms under the inclined load while the CPT q_c does not. "
        "Choose per the docs: direct CPT for competent granular ground, Annex D for soft/low-q_c soil.";
    }
    cr.extra.push_back({"V_d", Vd, "kN/m"});
    cr.extra.push_back({"H_d", Hd, "kN/m"});
    R.checks.push_back(cr);

    // ---- ECCENTRICITY (ULS e <= B/3) on bearing-case loads ----
    CheckResult ce;
    ce.id = "eccentricity"; ce.label = "Eccentricity (ULS, e <= B/3)";
    ce.combo = cb.id; ce.comboLabel = cb.label; ce.verb = "e <= B/3"; ce.unit = "m";
    ce.setFromEdRd(e, B / 3.0);
    ce.extra.push_back({"e", e, "m"});
    ce.extra.push_back({"B/3", B / 3.0, "m"});
    R.checks.push_back(ce);
  }
}

// EQU overturning (only reported for information / rock-pinned bases).
inline void evalGravityEQU(const GravityInput& in, const Combination& cb, GravityResult& R) {
  const GravityGeom& g = in.geom;
  double B = g.B();
  auto W = gravityWeights(in);
  GravityThrust t = gravityActive(in, cb.m);
  double sumWx = 0, sumW = 0;
  for (auto& w : W) { sumW += w.W; sumWx += w.W * w.x; }
  BaseUplift up = gravityBaseUplift(in);  // uplift is destabilising for overturning
  double Mdst = cb.gG_dst * (t.Hsoil * t.ySoil + t.Hwater * t.yWater + t.Hcrack * t.yCrack + up.U * up.x)
              + cb.gQ_dst * (t.Hsurch * t.ySurch);
  double Mstb = cb.gG_stb * (sumWx + t.Vsoil * B);
  CheckResult cr;
  cr.id = "overturning"; cr.label = "Overturning about toe (EQU)";
  cr.combo = cb.id; cr.comboLabel = cb.label; cr.verb = "M_dst <= M_stb"; cr.unit = "kNm/m";
  cr.setFromEdRd(Mdst, Mstb);
  cr.extra.push_back({"M_dst", Mdst, "kNm/m"});
  cr.extra.push_back({"M_stb", Mstb, "kNm/m"});
  cr.note = "Pure EQU is rare for soil-founded walls; bearing/eccentricity (GEO) normally governs.";
  R.checks.push_back(cr);
}

// SLS middle-third (characteristic).
inline void evalGravitySLS(const GravityInput& in, GravityResult& R) {
  const GravityGeom& g = in.geom;
  double B = g.B();
  auto W = gravityWeights(in);
  GravityThrust t = gravityActive(in, M1());  // characteristic
  double sumW = 0, sumWx = 0;
  for (auto& w : W) { sumW += w.W; sumWx += w.W * w.x; }
  BaseUplift up = gravityBaseUplift(in);
  double V = sumW + t.Vsoil - up.U;
  double Mstb = sumWx + t.Vsoil * B - up.U * up.x;
  double Mdst = t.Hsoil * t.ySoil + t.Hwater * t.yWater + t.Hcrack * t.yCrack + t.Hsurch * t.ySurch;
  double xR = (V > 1e-9) ? (Mstb - Mdst) / V : 0.5 * B;
  double e = std::fabs(0.5 * B - xR);
  double qmax, qmin;
  if (e <= B / 6.0 + 1e-9) {
    qmax = (V / B) * (1.0 + 6.0 * e / B);
    qmin = (V / B) * (1.0 - 6.0 * e / B);
  } else {
    qmax = 2.0 * V / (3.0 * (0.5 * B - e));
    qmin = 0.0;
  }
  CheckResult cr;
  cr.id = "middle_third"; cr.label = "Bearing resultant in middle third (SLS, e <= B/6)";
  cr.combo = "SLS"; cr.comboLabel = "Characteristic (SLS)"; cr.verb = "e <= B/6"; cr.unit = "m";
  cr.setFromEdRd(e, B / 6.0);
  cr.extra.push_back({"e", e, "m"});
  cr.extra.push_back({"q_max", qmax, "kPa"});
  cr.extra.push_back({"q_min", qmin, "kPa"});
  R.checks.push_back(cr);
  R.summary.push_back({"q_max_SLS", qmax, "kPa"});
  R.summary.push_back({"e_SLS", e, "m"});
}

// UPL flotation (EN 1997-1 §10.2, eq 2.8): the base hydrostatic uplift must not exceed the
// favourable dead weight. V_dst,d (uplift, γ_G,dst on the destabilising water) ≤ G_stb,d
// (favourable weight, γ_G,stb=0.90). Reported for every wall; governs only a deeply
// submerged, light section. Any base passive/side friction resistance is conservatively
// ignored here.
inline void evalGravityUPL(const GravityInput& in, GravityResult& R) {
  Combination upl = makeUPL();
  auto W = gravityWeights(in);
  GravityThrust t = gravityActive(in, upl.m);
  BaseUplift up = gravityBaseUplift(in);
  double sumW = 0; for (auto& w : W) sumW += w.W;
  double Gstb = sumW + t.Vsoil;
  double Vstb = upl.gG_stb * Gstb;
  double Udst = upl.gG_dst * up.U;
  CheckResult cr;
  cr.id = "flotation"; cr.label = "Uplift / flotation (UPL)";
  cr.combo = upl.id; cr.comboLabel = upl.label; cr.verb = "U_dst <= G_stb"; cr.unit = "kN/m";
  cr.setFromEdRd(Udst, Vstb);
  cr.extra.push_back({"U_uplift", up.U, "kN/m"});
  cr.extra.push_back({"G_favourable", Gstb, "kN/m"});
  cr.note = "Whole-body buoyancy (γ_G,stb=0.90 on weight, γ_G,dst=1.00 on uplift). Side/base "
            "friction conservatively neglected; governs only a deeply submerged, light wall.";
  R.checks.push_back(cr);
}

// Structural design forces at stem base / toe / heel for one combination.
inline void evalGravityStructural(const GravityInput& in, const Combination& cb, GravityResult& R) {
  const GravityGeom& g = in.geom;
  double B = g.B();
  double kFI = cb.kFI;
  double gG = cb.a.gG_unfav * kFI, gQ = cb.a.gQ_unfav * kFI;

  // STEM: active pressure on back face over stem height (top-of-wall -> base-top).
  Stratum bf = in.backfill;
  double phid = designPhi(bf.phi, cb.m.gPhi);
  double cd = designC(bf.c, cb.m.gC);
  Stratum bfd = bf; bfd.phi = phid; bfd.c = cd; bfd.topEl = g.topOfWallEl();
  std::vector<Stratum> col = {bfd};
  double delta = in.s.activeMethod == EpMethod::Coulomb ? in.s.deltaActiveRatio * phid : 0.0;
  SideInput si; si.strata = &col;
  si.surfaceEl = g.topOfWallEl(); si.regionTopEl = g.topOfWallEl(); si.regionBotEl = g.baseThk;
  si.waterEl = in.waterRetainedEl; si.surcharge = in.surcharge;
  si.method = in.s.activeMethod; si.delta = delta; si.theta = 0; si.beta = g.beta;
  si.isActive = true; si.assumeCrackWater = in.s.assumeCrackWater; si.nSteps = in.s.nSteps;
  SideThrust st = integrateSide(si);
  double Hs = g.stemHeight;
  // lever arms below top of stem region; moment about stem base (region bottom)
  double Msoil = st.soilN * (Hs - st.soilZbar);
  double Msurch = st.surchN * (Hs - st.surchZbar);
  double Mwater = st.waterN * (Hs - st.waterZbar) + st.crackN * (Hs - st.crackZbar);
  double Mstem = gG * Msoil + gQ * Msurch + gG * Mwater;
  double Vstem = gG * st.soilN + gQ * st.surchN + gG * (st.waterN + st.crackN);
  if (Mstem > R.M_stem) { R.M_stem = Mstem; R.strComboStem = cb.id; }
  if (Vstem > R.V_stem) R.V_stem = Vstem;  // independent shear envelope

  // Bearing pressure under base for toe/heel (bearing-case factored loads).
  auto W = gravityWeights(in);
  GravityThrust t = gravityActive(in, cb.m);
  double sumW = 0, sumWx = 0; for (auto& w : W) { sumW += w.W; sumWx += w.W * w.x; }
  double Vd = gG * (sumW + t.Vsoil);
  double Mstb = gG * (sumWx + t.Vsoil * B);
  double Mdst = gG * (t.Hsoil * t.ySoil + t.Hwater * t.yWater + t.Hcrack * t.yCrack) + gQ * (t.Hsurch * t.ySurch);
  double xR = (Vd > 1e-9) ? (Mstb - Mdst) / Vd : 0.5 * B;
  double e = 0.5 * B - xR;  // signed: +e toward toe
  // linear pressure q(x) = a + b*x (x from toe); resultant Vd at xR
  double qmean = Vd / B;
  double qx0, slope;  // q at toe (x=0) and slope
  if (std::fabs(e) <= B / 6.0 + 1e-9) {
    double qToe = qmean * (1.0 + 6.0 * e / B);
    double qHeel = qmean * (1.0 - 6.0 * e / B);
    qx0 = qToe; slope = (qHeel - qToe) / B;
  } else {
    // triangular over length a = 3*(B/2 - |e|) from the nearer edge
    double a = 3.0 * (0.5 * B - std::fabs(e));
    double qpk = 2.0 * Vd / a;
    if (e > 0) { qx0 = qpk; slope = -qpk / a; }            // peak at toe, zero at x=a
    else { qx0 = qpk * (a - B) / a; slope = qpk / a; }     // peak at heel, confined to [B-a, B]
  }
  auto qAt = [&](double x) { double q = qx0 + slope * x; return q > 0 ? q : 0.0; };

  // TOE: net upward pressure minus toe slab self weight, moment about stem front (x=toe)
  {
    double L = g.toe;
    if (L > 1e-6) {
      // integrate q(x)*(toe - x) over [0,toe]
      int n = 60; double dx = L / n; double M = 0, Vsh = 0;
      // toe slab self-weight is FAVOURABLE relief -> gamma_G,fav = 1.0 (no K_FI), §4.1
      double wSlab = cb.a.gG_fav * g.gammaConc * g.baseThk;
      for (int i = 0; i < n; i++) {
        double x = (i + 0.5) * dx;
        double qnet = qAt(x) - wSlab;  // upward positive
        M += qnet * (L - x) * dx;
        Vsh += qnet * dx;
      }
      double Mt = std::fabs(M);
      if (Mt > R.M_toe) { R.M_toe = Mt; R.strComboToe = cb.id; }
      if (std::fabs(Vsh) > R.V_toe) R.V_toe = std::fabs(Vsh);
    }
  }
  // HEEL: downward (soil+slab+surcharge) minus upward pressure, moment about stem back
  {
    double xb = g.xStemBackBase();
    double L = g.heel;
    double tanb = std::tan(g.beta);
    if (L > 1e-6) {
      // heel soil down-load uses the TRUE soil-column height at each x: the rectangular
      // column to top-of-wall PLUS the sloping backfill wedge — matching the wedge that the
      // upward bearing pressure q(x) already carries via gravityWeights()->sumW->Vd. Total
      // (saturated) weight below the retained water table (§2.6/§4.1).
      double wSlab = gG * g.gammaConc * g.baseThk;
      double wSurch = gQ * in.surcharge;
      int n = 60; double dx = L / n; double M = 0, Vsh = 0;
      for (int i = 0; i < n; i++) {
        double x = xb + (i + 0.5) * dx;  // global x
        double surfEl = g.topOfWallEl() + (x - xb) * tanb;  // sloping ground surface over the heel
        double wtc = clampd(in.waterRetainedEl, g.baseThk, surfEl);
        double hAbove = surfEl - wtc, hBelow = wtc - g.baseThk;
        double wSoil = gG * (in.backfill.gammaMoist * hAbove + in.backfill.gammaSat * hBelow);
        double down = wSoil + wSlab + wSurch;
        double qnet = down - qAt(x);  // downward positive
        M += qnet * (x - xb) * dx;
        Vsh += qnet * dx;
      }
      double Mh = std::fabs(M);
      if (Mh > R.M_heel) { R.M_heel = Mh; R.strComboHeel = cb.id; }
      if (std::fabs(Vsh) > R.V_heel) R.V_heel = std::fabs(Vsh);
    }
  }
}

inline GravityResult analyzeGravity(const GravityInput& in) {
  GravityResult R;
  Combination c1 = makeC1(in.s.riskScheme, in.s.consequenceClass);
  Combination c2 = makeC2(in.s.riskScheme, in.s.consequenceClass);
  Combination equ = makeEQU(in.s.consequenceClass);

  // collect per-combination GEO checks, then keep worst per id
  std::vector<CheckResult> all;
  GravityResult tmp;
  evalGravityGeo(in, c1, tmp);
  evalGravityGeo(in, c2, tmp);
  evalGravityEQU(in, equ, tmp);
  evalGravitySLS(in, R);
  evalGravityUPL(in, R);
  evalGravityStructural(in, c1, R);
  evalGravityStructural(in, c2, R);

  // merge worst per check id
  const char* ids[] = {"sliding", "bearing", "eccentricity", "overturning"};
  for (const char* id : ids) {
    CheckResult acc; bool seeded = false;
    for (auto& cr : tmp.checks) {
      if (cr.id == id) keepWorst(acc, cr, seeded);
    }
    if (seeded) R.checks.push_back(acc);
  }
  // append SLS (already in R from evalGravitySLS)
  // summary
  double mu = 0; bool pass = true;
  for (auto& cr : R.checks) { if (cr.util > mu) mu = cr.util; if (!cr.pass) pass = false; }
  R.summary.push_back({"B", in.geom.B(), "m"});
  R.summary.push_back({"governing_util", mu, ""});
  R.notes.push_back("Both DA1 combinations evaluated; governing shown per check.");

  // §3.0 Rankine virtual-plane validity (RC cantilever only): the active wedge at psi = 45deg +
  // phi'_d/2 from the rear of the heel must clear the back of the stem. For a short heel the wedge
  // is interrupted by the stem and a Coulomb analysis on the real stem back face is preferable.
  // Advisory only — the direction of error is indeterminate (the virtual-plane Rankine thrust is
  // often conservative on the horizontal component), so this never fails the design.
  if (!in.geom.isGravity) {
    Combination c2w = makeC2(in.s.riskScheme, in.s.consequenceClass);
    double phidW = designPhi(in.backfill.phi, c2w.m.gPhi);          // design phi' (C2, most onerous)
    double psiW = deg2rad(45.0) + 0.5 * phidW;
    double HvW = in.geom.topOfWallEl() + in.geom.heel * std::tan(in.geom.beta);
    double heelMin = (std::tan(psiW) > 1e-6) ? HvW / std::tan(psiW) : 0.0;
    if (in.geom.heel + 1e-6 < heelMin) {
      char buf[400];
      std::snprintf(buf, sizeof(buf),
        "Short-heel cantilever: heel %.2f m is below the Rankine wedge-clearance length %.2f m "
        "(psi = %.0f deg from the design phi'). The virtual-plane Rankine active thrust is outside "
        "its strict validity envelope here; cross-check the active thrust with Coulomb on the real "
        "stem back face.", in.geom.heel, heelMin, rad2deg(psiW));
      R.notes.push_back(std::string(buf));
    }
  }

  // ---- pressure diagrams for the canvas (characteristic strength for display) ----
  {
    GravityThrust at = gravityActive(in, M1());
    Series sa; sa.id = "active_pressure"; sa.label = "Active earth pressure"; sa.unit = "kPa";
    sa.z = at.raw.plotZ; sa.v = at.raw.plotSoil; R.diagrams.push_back(sa);
    Series sw; sw.id = "active_water"; sw.label = "Water pressure"; sw.unit = "kPa";
    sw.z = at.raw.plotZ; sw.v = at.raw.plotWater; R.diagrams.push_back(sw);
  }
  double overDig = overDigAllowance(in.geom);
  if (in.s.passiveToe && (in.geom.frontSoilEl - overDig) > 0.05) {
    std::vector<Stratum> col = designInsitu(in, M1());  // layered, characteristic for display
    SideInput si; si.strata = &col; si.surfaceEl = in.geom.frontSoilEl - overDig;  // excavated front surface
    si.regionTopEl = in.geom.frontSoilEl - overDig; si.regionBotEl = 0.0;
    si.waterEl = in.waterFrontEl; si.surcharge = 0.0; si.method = EpMethod::CaquotKerisel;
    si.delta = 0.0; si.passiveDeltaK = clampd(in.s.passiveDeltaRatio, 0.0, 1.0);
    si.theta = 0.0; si.beta = 0.0; si.isActive = false;
    si.assumeCrackWater = false; si.nSteps = in.s.nSteps;
    SideThrust t = integrateSide(si);
    Series sp; sp.id = "passive_pressure";
    sp.label = "Passive earth pressure (EN 1997-1 Annex C, characteristic)"; sp.unit = "kPa";
    sp.z = t.plotZ; sp.v = t.plotSoil; R.diagrams.push_back(sp);
  }
  return R;
}

}  // namespace madep
