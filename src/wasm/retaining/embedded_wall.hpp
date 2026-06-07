// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Embedded retaining-wall engine — methodology §5. Steel sheet pile / soldier pile /
// secant/diaphragm, modelled as cantilever (free-earth/Blum simplified) or singly
// anchored/propped (free-earth support). DA1 with strength factored at source AND
// action partial factors applied: permanent earth+water by gamma_G, variable surcharge
// by gamma_Q. Embedment by bisection on the over-design factor ODF = M_resist/M_drive
// (gamma_G single-sources out of the ratio except via the surcharge); structural M_max
// and anchor force are absolute factored effects, enveloped over C1/C2.
#pragma once

#include "earth_pressure.hpp"
#include "factors.hpp"
#include "results.hpp"
#include <vector>
#include <cmath>
#include <string>

namespace madep {

struct EmbeddedGeom {
  double retainedSurfaceEl;  // elevation of retained ground surface (m)
  double excavationEl;       // elevation of excavation (dredge) level in front (m)
  double embedment;          // user embedment d below excavation (m); toe = excavationEl - d
  bool anchored;             // true = singly anchored/propped (free-earth support)
  double anchorEl;           // anchor/prop elevation (m), for anchored
  // EN 1537 ground-anchor configuration (for the pull-out check)
  double anchorAngleDeg = 20;   // inclination from horizontal
  double anchorFixedLen = 5;    // fixed/grout body length (m)
  double anchorDia = 0.15;      // grout body diameter (m)
  double anchorSpacing = 2.0;   // horizontal spacing (m)
  double anchorTfk = 150;       // characteristic grout/soil bond stress (kPa)
  double anchorGammaA = 1.1;    // anchor resistance partial factor (R4; Buildwise ~1.1)
};

struct EmbeddedSettings {
  EpMethod activeMethod;     // Rankine (vertical wall); Coulomb reachable internally
  double deltaActiveRatio;   // delta/phi' active face
  double deltaPassiveRatio;  // k = delta_p/phi'_d passive face (default 2/3; no artificial cap)
  bool assumeCrackWater;
  double overdig;            // unplanned over-excavation Δa, lowering the front level (m)
  double minSurcharge;       // minimum variable surcharge (kPa)
  int consequenceClass;
  int riskScheme;
  int nSteps;
};

struct EmbeddedInput {
  EmbeddedGeom geom;
  std::vector<Stratum> retained;  // retained-side in-situ profile (characteristic)
  std::vector<Stratum> front;     // excavated-side in-situ profile (characteristic)
  double waterRetainedEl;
  double waterFrontEl;
  double surcharge;               // variable surcharge on retained surface (kPa)
  EmbeddedSettings s;
};

// Apply material factors to a whole profile (returns design strata).
inline std::vector<Stratum> designProfile(const std::vector<Stratum>& strata, const MaterialFactors& m) {
  std::vector<Stratum> out = strata;
  for (auto& st : out) {
    st.phi = designPhi(st.phi, m.gPhi);
    st.c = designC(st.c, m.gC);
    st.cu = designCu(st.cu, m.gCu);
  }
  return out;
}

// Net horizontal pressure components (kPa) at elevation `el`, kept SEPARATE by action
// type so the action partial factors can be applied: pEarth (permanent active earth),
// pSurch (variable surcharge), pResist (permanent passive earth, only below excavation),
// uBack/uFront (permanent water, incl. tension-crack water folded into uBack).
struct NetPressure {
  double pEarth = 0;
  double pSurch = 0;
  double pResist = 0;
  double uBack = 0;
  double uFront = 0;
};

inline NetPressure netPressureAt(const EmbeddedInput& in, const std::vector<Stratum>& backD,
                                 const std::vector<Stratum>& frontD, double el, double q,
                                 const EmbeddedSettings& s) {
  NetPressure np;
  const EmbeddedGeom& g = in.geom;
  // ----- back (active) -----
  {
    int idx = stratumAt(backD, el);
    const Stratum& st = backD[idx];
    double sv = 0.0;
    {
      double top = g.retainedSurfaceEl;
      int N = 60; double dz = (top - el) / N;
      if (dz > 0) {
        double sigma = 0;
        for (double e = top - 0.5 * dz; e > el; e -= dz) {
          int j = stratumAt(backD, e);
          bool sub = e < in.waterRetainedEl;
          double ge = sub ? (backD[j].gammaSat - GAMMA_W) : backD[j].gammaMoist;
          sigma += ge * dz;
        }
        sv = sigma;
      }
    }
    double incl;
    double Ka = st.drained
        ? activeK(s.activeMethod, st.phi, s.deltaActiveRatio * st.phi, 0.0, 0.0, &incl)
        : 1.0;
    double Kac = st.drained ? 2.0 * std::sqrt(Ka) : 2.0;
    double cohes = st.drained ? st.c : st.cu;
    double sref = st.drained ? sv : (sv + (el < in.waterRetainedEl ? GAMMA_W * (in.waterRetainedEl - el) : 0.0));
    double pa = Ka * sref - Kac * cohes;       // permanent active earth (effective for drained)
    if (pa < 0) {
      pa = 0;
      // tension crack — optionally fills with water (dry crack, above the water table)
      if (s.assumeCrackWater && st.drained && el > in.waterRetainedEl) {
        np.uBack += GAMMA_W * (g.retainedSurfaceEl - el);
      }
    }
    np.pEarth = pa;
    np.pSurch = Ka * q;                          // variable surcharge lateral
    if (st.drained && el < in.waterRetainedEl) np.uBack += GAMMA_W * (in.waterRetainedEl - el);
  }
  // ----- front (passive) — only below excavation -----
  if (el < g.excavationEl - 1e-9) {
    int idx = stratumAt(frontD, el);
    const Stratum& st = frontD[idx];
    double sv = 0.0;
    {
      double top = g.excavationEl;
      int N = 60; double dz = (top - el) / N;
      if (dz > 0) {
        double sigma = 0;
        for (double e = top - 0.5 * dz; e > el; e -= dz) {
          int j = stratumAt(frontD, e);
          bool sub = e < in.waterFrontEl;
          double ge = sub ? (frontD[j].gammaSat - GAMMA_W) : frontD[j].gammaMoist;
          sigma += ge * dz;
        }
        sv = sigma;
      }
    }
    double incl, Kpc = 2.0;
    double Kp = 1.0;  // undrained total-stress default
    if (st.drained) {
      // EN 1997-1 Annex C passive: K_p (horizontal) with the C.8 cohesion coeff K_pc;
      // wall friction delta_p = k·φ'_d on the front face (k = deltaPassiveRatio, default 2/3).
      Kp = passiveK(EpMethod::CaquotKerisel, st.phi, s.deltaPassiveRatio * st.phi, 0.0, 0.0, &incl, &Kpc);
    }
    double cohes = st.drained ? st.c : st.cu;
    double sref = st.drained ? sv : (sv + (el < in.waterFrontEl ? GAMMA_W * (in.waterFrontEl - el) : 0.0));
    double pp = Kp * sref + Kpc * cohes;
    if (pp < 0) pp = 0;
    np.pResist = pp;
    if (st.drained && el < in.waterFrontEl) np.uFront = GAMMA_W * (in.waterFrontEl - el);
  }
  return np;
}

// Factored driving/resisting resultants and moments about a reference elevation.
// drive = gG*(earth + uBack) + gQ*surch ; resist = gG*(passive + uFront).
struct EmbStat {
  double Hdrive = 0, Hresist = 0;       // horizontal resultants (kN/m)
  double Mdrive = 0, Mresist = 0;       // moments about reference (kNm/m), arm = (el - refEl)
};

inline EmbStat integrateEmbedded(const EmbeddedInput& in, const std::vector<Stratum>& backD,
                                 const std::vector<Stratum>& frontD, double toeEl, double refEl,
                                 double q, double gG, double gQ) {
  EmbStat st;
  const EmbeddedGeom& g = in.geom;
  double top = g.retainedSurfaceEl;
  int N = std::max(in.s.nSteps, 200);
  double dz = (top - toeEl) / N;
  if (dz <= 0) return st;
  for (double el = top - 0.5 * dz; el > toeEl; el -= dz) {
    NetPressure np = netPressureAt(in, backD, frontD, el, q, in.s);
    double drive = gG * (np.pEarth + np.uBack) + gQ * np.pSurch;
    double resist = gG * (np.pResist + np.uFront);
    double arm = el - refEl;
    st.Hdrive += drive * dz;
    st.Hresist += resist * dz;
    st.Mdrive += drive * dz * arm;
    st.Mresist += resist * dz * arm;
  }
  return st;
}

// Over-design factor about the rotation reference (toe for cantilever, anchor for propped).
inline double odfAt(const EmbeddedInput& in, const std::vector<Stratum>& backD,
                    const std::vector<Stratum>& frontD, double d, double q, double gG, double gQ,
                    bool anchored, double anchorEl) {
  double toeEl = in.geom.excavationEl - d;
  double refEl = anchored ? anchorEl : toeEl;
  EmbStat s = integrateEmbedded(in, backD, frontD, toeEl, refEl, q, gG, gQ);
  double Md = std::fabs(s.Mdrive);
  double Mr = std::fabs(s.Mresist);
  return (Md > 1e-9) ? Mr / Md : 1e9;
}

// Bisection for the minimum embedment giving ODF >= 1.0 (free-earth, before any Blum add).
inline double requiredEmbedment(const EmbeddedInput& in, const std::vector<Stratum>& backD,
                                const std::vector<Stratum>& frontD, double q, double gG, double gQ,
                                bool anchored, double anchorEl) {
  double lo = 0.10, hi = 40.0;
  double flo = odfAt(in, backD, frontD, lo, q, gG, gQ, anchored, anchorEl) - 1.0;
  double fhi = odfAt(in, backD, frontD, hi, q, gG, gQ, anchored, anchorEl) - 1.0;
  if (flo > 0) return lo;       // already adequate at tiny embedment (unusual)
  if (fhi < 0) return hi;       // cannot satisfy within range
  for (int i = 0; i < 60; ++i) {
    double mid = 0.5 * (lo + hi);
    double fm = odfAt(in, backD, frontD, mid, q, gG, gQ, anchored, anchorEl) - 1.0;
    if (fm > 0) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

struct EmbeddedResult {
  std::vector<CheckResult> checks;
  std::vector<Series> diagrams;
  std::vector<KV> summary;
  std::vector<std::string> notes;
  double Mmax = 0;       // max |bending moment| (kNm/m), factored, enveloped C1/C2
  double anchorForce = 0;
  double requiredD = 0;
  std::string strCombo;
  std::string anchorCombo;
};

// Factored bending-moment diagram by double integration of the net pressure, with the
// anchor reaction T (already factored) subtracted at the anchor station. Updates Mmax.
inline void bendingDiagram(const EmbeddedInput& in, const std::vector<Stratum>& backD,
                           const std::vector<Stratum>& frontD, double toeEl, double q,
                           double gG, double gQ, bool anchored, double anchorEl, double T,
                           EmbeddedResult& R, const char* combo) {
  const EmbeddedGeom& g = in.geom;
  double top = g.retainedSurfaceEl;
  int N = std::max(in.s.nSteps, 300);
  double dz = (top - toeEl) / N;
  if (dz <= 0) return;
  // First pass: accumulate shear V and moment M; the structural maximum is at a
  // zero-shear point (Blum). For an unpropped cantilever the simplified free-earth method
  // has no toe reaction, so below the first zero-shear point the moment is unphysical —
  // we report M_max there and truncate the plotted diagram at that depth.
  double V = 0.0, M = 0.0, Vprev = 0.0;
  double Mzero = 0.0, depthMax = top - toeEl, mAbsMax = 0.0;
  bool firstStep = true, sawCross = false;
  std::vector<double> zArr, mArr, vArr;
  int plotEvery = std::max(N / 160, 1);
  int k = 0;
  for (double el = top; el > toeEl - 1e-9; el -= dz, ++k) {
    NetPressure np = netPressureAt(in, backD, frontD, el, q, in.s);
    double net = gG * (np.pEarth + np.uBack) - gG * (np.pResist + np.uFront) + gQ * np.pSurch;
    if (anchored && el <= anchorEl && (el + dz) > anchorEl) V -= T;  // anchor reaction
    V += net * dz;
    M += V * dz;
    double depth = top - el;
    if (std::fabs(M) > mAbsMax) mAbsMax = std::fabs(M);
    if (!firstStep && ((Vprev > 0 && V <= 0) || (Vprev < 0 && V >= 0)) && depth > 0.1) {
      if (std::fabs(M) > Mzero) { Mzero = std::fabs(M); depthMax = depth; }
      sawCross = true;
    }
    firstStep = false; Vprev = V;
    if ((k % plotEvery) == 0) { zArr.push_back(depth); mArr.push_back(M); vArr.push_back(V); }
  }
  double Mmax = sawCross ? Mzero : mAbsMax;
  // Contraflexure: the first plotted station BELOW the GOVERNING peak (depthMax, found over
  // the whole pass — not a transient earlier crossing such as the small moment at an anchor)
  // where the moment returns through zero. That is the free-earth equilibrium depth at which
  // M -> 0 by the moment balance that sized the wall; below it the simplified full-passive
  // integration keeps mobilising passive with no modelled toe reaction, so the moment diverges
  // unphysically. We plot the real diagram over the WHOLE pile and clamp the post-contraflexure
  // tail to zero, so it reads as the textbook shape rising to M_max and returning to ~0 at the
  // free toe — for both the cantilever and the (over-embedded) anchored wall.
  double zContra = top - toeEl; bool foundContra = false;
  for (size_t i = 1; i < zArr.size(); ++i) {
    if (zArr[i] <= depthMax + 1e-9) continue;
    if ((mArr[i-1] > 0 && mArr[i] <= 0) || (mArr[i-1] < 0 && mArr[i] >= 0)) {
      zContra = zArr[i]; foundContra = true; break;
    }
  }

  if (Mmax > R.Mmax) {
    R.Mmax = Mmax; R.strCombo = combo;
    Series sM; sM.id = std::string("M_") + combo; sM.label = "Bending moment"; sM.unit = "kNm/m";
    Series sV; sV.id = std::string("V_") + combo; sV.label = "Shear"; sV.unit = "kN/m";
    // Plot the full pile (top -> toe); clamp the post-contraflexure divergent tail to zero.
    for (size_t i = 0; i < zArr.size(); ++i) {
      bool beyond = foundContra && zArr[i] > zContra + 1e-9;
      sM.z.push_back(zArr[i]); sM.v.push_back(beyond ? 0.0 : mArr[i]);
      sV.z.push_back(zArr[i]); sV.v.push_back(beyond ? 0.0 : vArr[i]);
    }
    R.diagrams.clear(); R.diagrams.push_back(sM); R.diagrams.push_back(sV);
  }
}

// Evaluate one combination: required embedment (this combo's factors) and the ODF at the
// user's provided embedment. Forces are computed later at the governing design embedment.
struct ComboEmbResult { double dReqDesign; double odfProvided; double gG; double gQ; double q;
                        std::vector<Stratum> backD; std::vector<Stratum> frontD; };

inline ComboEmbResult evalEmbeddedCombo(const EmbeddedInput& in, const Combination& cb) {
  ComboEmbResult cr;
  cr.backD = designProfile(in.retained, cb.m);
  cr.frontD = designProfile(in.front, cb.m);
  cr.q = std::max(in.surcharge, in.s.minSurcharge);
  cr.gG = cb.a.gG_unfav * cb.kFI;
  cr.gQ = cb.a.gQ_unfav * cb.kFI;
  const EmbeddedGeom& g = in.geom;
  bool anchored = g.anchored;
  double dReq = requiredEmbedment(in, cr.backD, cr.frontD, cr.q, cr.gG, cr.gQ, anchored, g.anchorEl);
  cr.dReqDesign = anchored ? dReq : 1.2 * dReq;  // Blum 20% addition for cantilever
  cr.odfProvided = odfAt(in, cr.backD, cr.frontD, g.embedment, cr.q, cr.gG, cr.gQ, anchored, g.anchorEl);
  return cr;
}

inline EmbeddedResult analyzeEmbedded(const EmbeddedInput& inRaw) {
  EmbeddedResult R;
  // The ENGINE owns the unplanned over-excavation Δa (EN 1997-1 §9.3.2.2): lower the front
  // (excavation) level by Δa so the active side acts over the deeper height and the front
  // passive cover is reduced. The provided embedment is measured below this over-dug level
  // (toe = excavationEl − Δa − d). A raw API caller therefore cannot lose the allowance.
  EmbeddedInput in = inRaw;
  in.geom.excavationEl -= std::max(in.s.overdig, 0.0);
  Combination c1 = makeC1(in.s.riskScheme, in.s.consequenceClass);
  Combination c2 = makeC2(in.s.riskScheme, in.s.consequenceClass);
  ComboEmbResult e1 = evalEmbeddedCombo(in, c1);
  ComboEmbResult e2 = evalEmbeddedCombo(in, c2);
  const EmbeddedGeom& g = in.geom;
  bool anchored = g.anchored;

  // Governing required embedment (worst of C1/C2 — normally C2) and the design toe level.
  R.requiredD = std::max(e1.dReqDesign, e2.dReqDesign);
  bool c2Gov = e2.dReqDesign >= e1.dReqDesign;
  double dDesign = std::max(R.requiredD, g.embedment);  // analyse at >= design embedment
  double toeEl = g.excavationEl - dDesign;

  // Embedment / rotational-stability check at the user's provided embedment (worst ODF).
  double odf = std::min(e1.odfProvided, e2.odfProvided);
  const ComboEmbResult& worst = (e1.odfProvided <= e2.odfProvided) ? e1 : e2;
  double refEl = anchored ? g.anchorEl : (g.excavationEl - g.embedment);
  EmbStat es = integrateEmbedded(in, worst.backD, worst.frontD, g.excavationEl - g.embedment, refEl, worst.q, worst.gG, worst.gQ);
  CheckResult cr;
  cr.id = "embedment";
  cr.label = anchored ? "Embedment / rotational stability (anchored, free-earth)"
                      : "Embedment / rotational stability (cantilever, Blum)";
  cr.combo = (&worst == &e1) ? "C1" : "C2";
  cr.comboLabel = (&worst == &e1) ? c1.label : c2.label;
  // Pass/fail on the provided embedment vs the required (incl. the cantilever Blum 1.2
  // margin folded into d_required); ODF at the provided depth is reported alongside.
  cr.verb = "d_provided >= d_required"; cr.unit = "m";
  cr.setFromEdRd(R.requiredD, std::max(g.embedment, 1e-6));
  cr.extra.push_back({"ODF_at_provided", odf, "-"});
  cr.extra.push_back({"d_provided", g.embedment, "m"});
  cr.extra.push_back({"d_required", R.requiredD, "m"});
  R.checks.push_back(cr);

  // ---- HYD hydraulic heave / piping (EN 1997-1 §10.3) ----
  // Upward seepage in front of the wall under the differential head Δh. Pressure form
  // (eq 2.9b): destabilising excess pore pressure at the toe ≤ stabilising buoyant
  // effective stress, with HYD factors (γ_G,dst=1.35, γ_G,stb=0.90). The full head is
  // conservatively dissipated over the downstream embedment d (steepest exit gradient
  // i = Δh/d), crediting no upstream seepage path. Uses the as-built (provided) embedment.
  {
    double dProv = std::max(g.embedment, 0.0);
    double toeProv = g.excavationEl - dProv;
    double dh = in.waterRetainedEl - in.waterFrontEl;            // differential head (m)
    Combination hyd = makeHYD();
    Stratum ft = in.front.empty() ? Stratum{toeProv, 18, 20, deg2rad(30), 0, 0, true}
                                  : in.front[stratumAt(in.front, toeProv + 0.01)];
    double gPrime = ft.gammaSat - GAMMA_W; if (gPrime < 1.0) gPrime = 1.0;
    bool active = (dh > 1e-3) && (dProv > 0.05);
    double udst = active ? GAMMA_W * dh : 0.0;                   // excess pore pressure at toe (kPa)
    double sstb = gPrime * dProv;                                // buoyant effective stress (kPa)
    double Ed = hyd.gG_dst * udst;
    double Rd = hyd.gG_stb * sstb;
    CheckResult ch;
    ch.id = "heave"; ch.label = "Hydraulic heave / piping (HYD)";
    ch.combo = hyd.id; ch.comboLabel = hyd.label; ch.verb = "u_dst <= sigma'_stb"; ch.unit = "kPa";
    ch.setFromEdRd(Ed, Rd);
    ch.extra.push_back({"delta_h", dh > 0 ? dh : 0.0, "m"});
    ch.extra.push_back({"embedment", dProv, "m"});
    ch.extra.push_back({"i_exit", active ? dh / dProv : 0.0, "-"});
    ch.extra.push_back({"i_crit", gPrime / GAMMA_W, "-"});
    ch.note = "Conservative exit gradient: the whole differential head is dissipated over the "
              "downstream embedment (no upstream seepage-path credit). For a stratified or "
              "anisotropic profile, confirm with a flow net.";
    R.checks.push_back(ch);
  }

  // Structural design forces. The anchor force (free-earth horizontal equilibrium) is
  // evaluated PER COMBO at that combo's own FES equilibrium depth (where the free body
  // balances) — integrating full passive over a deeper toe would under-predict T. The
  // span bending moment is insensitive to extra toe, so it is taken at the design depth.
  for (const ComboEmbResult* ec : {&e1, &e2}) {
    double T = 0.0;
    if (anchored) {
      double toeEl_ec = g.excavationEl - ec->dReqDesign;  // FES equilibrium depth (this combo)
      EmbStat full = integrateEmbedded(in, ec->backD, ec->frontD, toeEl_ec, 0.0, ec->q, ec->gG, ec->gQ);
      T = full.Hdrive - full.Hresist;
      if (T < 0) T = 0;
      if (T > R.anchorForce) { R.anchorForce = T; R.anchorCombo = (ec == &e1) ? "C1" : "C2"; }
    }
    bendingDiagram(in, ec->backD, ec->frontD, toeEl, ec->q, ec->gG, ec->gQ, anchored, g.anchorEl, T,
                   R, (ec == &e1) ? "C1" : "C2");
  }

  R.summary.push_back({"M_max", R.Mmax, "kNm/m"});
  R.summary.push_back({"d_required", R.requiredD, "m"});

  // ---- Ground-anchor pull-out (EN 1537 / EC7 R4) ----
  if (anchored) {
    double ang = g.anchorAngleDeg * PI / 180.0;  // inclination below horizontal
    double cosA = std::cos(ang); if (cosA < 0.2) cosA = 0.2;
    double s = std::max(g.anchorSpacing, 0.1);
    double T_axial = R.anchorForce / cosA * s;                 // design axial force per anchor (kN)
    double V_anchor = R.anchorForce * std::tan(ang);           // downward vertical component on wall (kN/m)
    double Rak = PI * g.anchorDia * g.anchorFixedLen * g.anchorTfk;  // characteristic pull-out (kN)
    double gA = std::max(g.anchorGammaA, 1.0);
    double Rad = Rak / gA;
    CheckResult ca;
    ca.id = "anchor_pullout"; ca.label = "Ground-anchor pull-out (EN 1537, per anchor)";
    ca.combo = R.anchorCombo.empty() ? "C1" : R.anchorCombo;
    ca.comboLabel = "DA1 (R4 anchor resistance)";
    ca.verb = "T_d <= R_a,d"; ca.unit = "kN";
    ca.setFromEdRd(T_axial, Rad);
    ca.extra.push_back({"T_axial", T_axial, "kN"});
    ca.extra.push_back({"R_ak", Rak, "kN"});
    ca.extra.push_back({"R_ad", Rad, "kN"});
    ca.extra.push_back({"gamma_a", gA, "-"});
    ca.extra.push_back({"spacing", s, "m"});
    ca.extra.push_back({"V_vert_on_wall", V_anchor, "kN/m"});
    ca.note = "R_ak = pi*D*L_fixed*tau is a CALCULATED (untested) grout-body bond. EN 1997-1 "
              "Table A.12 gives gamma_a = 1.1 for anchorages (temporary and permanent), which "
              "this uses and is EN-conforming — but that 1.1 PRESUMES a proof-tested R_ak. Until "
              "EN 1537 acceptance/investigation tests confirm the bond (with the correlation "
              "factor on the test results), treat R_ak as preliminary and apply a model factor / "
              "reduce tau. (gamma_a is NOT the pile R4 set ~1.5-1.6 — that range does not apply "
              "to anchors.)";
    R.checks.push_back(ca);

    // ---- Wall vertical equilibrium under the inclined-anchor down-drag (EC7 §9.x) ----
    // The inclined anchors apply V = T·tan(angle) (kN/m) downward on the wall, which the
    // wall's vertical capacity must carry. A conservative estimate of the embedded shaft
    // resistance (both faces, K0·σ'_v·tan δ over the embedded length, δ = 2/3·φ'_d, base
    // resistance neglected) is compared against it. This is a screening check — confirm
    // against the real section (sheet-pile/soldier-pile shaft + base).
    {
      double dProv = std::max(g.embedment, 0.0);
      double toeProv = g.excavationEl - dProv;
      auto frontD = designProfile(in.front, c1.m);
      double Rv = 0.0, sig = 0.0;
      int Nz = 100; double dz = dProv / Nz;
      for (double el = g.excavationEl - 0.5 * dz; el > toeProv && dz > 0; el -= dz) {
        const Stratum& st = frontD[stratumAt(frontD, el)];
        bool sub = el < in.waterFrontEl;
        sig += (sub ? (st.gammaSat - GAMMA_W) : st.gammaMoist) * dz;
        double k0 = 1.0 - std::sin(st.phi);
        double delta = (2.0 / 3.0) * st.phi;
        Rv += 2.0 * k0 * sig * std::tan(delta) * dz;  // 2 faces (per m run)
      }
      CheckResult cv;
      cv.id = "wall_vertical"; cv.label = "Wall vertical equilibrium (anchor down-drag)";
      cv.combo = R.anchorCombo.empty() ? "C1" : R.anchorCombo;
      cv.comboLabel = "DA1 (screening — confirm against section)";
      cv.verb = "V_anchor <= R_v,shaft"; cv.unit = "kN/m";
      cv.setFromEdRd(V_anchor, Rv);
      cv.extra.push_back({"V_anchor", V_anchor, "kN/m"});
      cv.extra.push_back({"R_v_shaft", Rv, "kN/m"});
      cv.note = "Screening estimate: embedded shaft friction only (K0·σ'_v·tan(2/3 φ'_d), both "
                "faces), base resistance and wall self-weight NEGLECTED. Confirm the vertical "
                "capacity against the real section before relying on a pass.";
      R.checks.push_back(cv);

    R.summary.push_back({"anchor_force", R.anchorForce, "kN/m"});
    R.summary.push_back({"anchor_axial", T_axial, "kN"});
    R.summary.push_back({"anchor_vertical", V_anchor, "kN/m"});
    R.notes.push_back("Inclined anchor adds a downward vertical V = T*tan(angle); a screening "
                      "wall vertical-equilibrium check is included — confirm against the section.");
    }
  }
  R.notes.push_back("DA1: strength factored at source; C2 normally governs embedment, C1 the structural forces.");
  R.notes.push_back(std::string("Embedment governed by ") + (c2Gov ? "C2" : "C1") + "; design forces enveloped over both combinations.");
  R.notes.push_back("Passive resistance is de-rated by the M2 strength factor; a separate SLS movement check is required.");
  return R;
}

}  // namespace madep
