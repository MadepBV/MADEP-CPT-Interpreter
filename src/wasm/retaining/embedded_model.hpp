// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pressure model of an embedded wall for ONE design branch: geometry, design strata,
// per-layer earth-pressure coefficients and the net horizontal pressure components at any
// elevation. Serves three wall idealisations through one interface:
//
//   Continuous          steel sheet pile / diaphragm — plane strain, all quantities per metre of wall
//   SoldierEffWidth     Berliner wall, hand calculation with effective widths (EAB / Belgian
//                       guideline §5): above the excavation the lagging transfers the full
//                       tributary width s; below it the active side acts on the flange width b and
//                       the passive side on b_eff = min(k·b, s) with the plane-strain K_p.
//                       All quantities per PILE.
//   SoldierBrinchHansen Berliner wall, below-excavation net resistance B·[e_w(z)]⁺ from the
//                       Brinch Hansen (1961) coefficients with the Andersen–Lodahl (2023)
//                       retained-height active term, optionally capped by the continuous-wall
//                       tributary resistance s·p_net. All quantities per PILE.
//
// Conventions: elevations y up (m); pressures kPa (× width → kN/m of wall or of pile);
// earth pressure on effective stress, water added separately; angles in radians.
#pragma once

#include "earth_pressure.hpp"
#include "stress_profile.hpp"
#include "brinch_hansen.hpp"
#include "embedded_branches.hpp"
#include <vector>
#include <cmath>

namespace madep {

enum class WallKind { Continuous = 0, SoldierEffWidth = 1, SoldierBrinchHansen = 2 };

// Apply material partial factors to a characteristic profile (γ never factored).
inline std::vector<Stratum> designProfile(const std::vector<Stratum>& strata, const MaterialFactors& m) {
  std::vector<Stratum> out = strata;
  for (auto& st : out) {
    st.phi = designPhi(st.phi, m.gPhi);
    st.c = designC(st.c, m.gC);
    st.cu = designCu(st.cu, m.gCu);
  }
  return out;
}

struct EmbeddedGeometry {
  double retainedSurfaceEl = 6;   // retained ground surface
  double excavationElNominal = 0; // nominal (planned) excavation level
  double embedment = 4;           // provided embedment below the DESIGN excavation of the governing ULS branch
  bool anchored = false;
  double anchorEl = 4.5;
  // soldier pile
  double pileWidthB = 0.18;       // flange width b normal to loading (m)
  double spacingS = 1.0;          // centre-to-centre spacing (m)
  double effectiveWidthFactor = 3.0;  // b_eff = min(k·b, s)
  bool laggingWatertight = false;     // apply water pressure on the lagging above the excavation
  bool rowCap = true;                 // Brinch Hansen: cap by s·p_net,continuous
};

struct EmbeddedLoads {
  double surchargeVariable = 0;   // kPa, retained surface (γ_Q · α_ver)
  double surchargePermanent = 0;  // kPa, retained surface (γ_G)
  BermSurcharge berm;             // optional retained berm / slope as equivalent surcharge
  double waterRetainedEl = -1000;
  double waterFrontEl = -1000;
};

struct EmbeddedOptions {
  double deltaPassiveRatio = 0.667;  // δ_p / φ′_d on the passive face (Annex C)
  bool assumeCrackWater = true;
  double surchargeFloor = 0.0;       // explicit minimum variable surcharge (kPa)
  double dzProfile = 0.01;
};

struct LayerCoefficients {
  double phi = 0, c = 0, cu = 0; bool drained = true;
  double Ka = 0, Kac = 0;           // active (Rankine, vertical wall, δ = 0)
  double Kp = 0, Kpc = 0, deltaP = 0;  // passive (EN 1997-1 Annex C)
  BrinchHansenConstants bh;         // soldier-pile coefficients (design φ, this layer)
};

// Net pressure components at an elevation — already multiplied by the acting width
// (1 m for a continuous wall; s, b, b_eff or B for a soldier pile), so the solver is
// idealisation-agnostic. Positive = pushes the wall toward the excavation.
struct NetTerms {
  double pEarth = 0;    // permanent active earth (incl. berm/permanent surcharge through σ′_v)
  double pSurch = 0;    // variable surcharge (γ_Q)
  double uBack = 0;     // permanent water behind (incl. crack water)
  double pResist = 0;   // permanent resistance in front (passive, or Brinch Hansen net)
  double uFront = 0;    // permanent water in front
  // diagnostics (kPa, unfactored, per unit width): raw ordinates for plotting
  double pBackKpa = 0, pFrontKpa = 0, uBackKpa = 0, uFrontKpa = 0;
};

class EmbeddedModel {
 public:
  WallKind kind = WallKind::Continuous;
  EmbeddedGeometry geom;
  EmbeddedLoads loads;
  EmbeddedOptions opt;
  BranchSpec branch;
  double excavationEl = 0;                    // this branch's excavation level (nominal − Δa)
  std::vector<Stratum> backD, frontD;         // design strata for this branch
  std::vector<LayerCoefficients> backK, frontK;
  StressProfile back, front;
  double qVar = 0;                             // variable surcharge actually applied (after the floor)

  void build(WallKind k, const EmbeddedGeometry& g, const std::vector<Stratum>& backChar,
             const std::vector<Stratum>& frontChar, const EmbeddedLoads& L, const EmbeddedOptions& o,
             const BranchSpec& b) {
    kind = k; geom = g; loads = L; opt = o; branch = b;
    excavationEl = g.excavationElNominal - std::max(b.overdig, 0.0);
    backD = designProfile(backChar, b.m);
    frontD = designProfile(frontChar, b.m);
    computeCoefficients(backD, backK);
    computeCoefficients(frontD, frontK);
    const double bottom = std::min(excavationEl, g.retainedSurfaceEl) - 60.0;
    BermSurcharge berm = L.berm;
    if (berm.active && berm.gamma <= 0 && !backChar.empty()) berm.gamma = backChar[0].gammaMoist;
    back = StressProfile::build(backD, g.retainedSurfaceEl, L.waterRetainedEl, bottom, L.surchargePermanent, berm, o.dzProfile);
    BermSurcharge none;
    front = StressProfile::build(frontD, excavationEl, L.waterFrontEl, bottom, 0.0, none, o.dzProfile);
    qVar = std::max(L.surchargeVariable, o.surchargeFloor);
  }

  bool perPile() const { return kind != WallKind::Continuous; }
  double widthAbove() const { return perPile() ? geom.spacingS : 1.0; }
  double widthActiveBelow() const { return perPile() ? geom.pileWidthB : 1.0; }
  double widthPassiveBelow() const {
    return perPile() ? std::min(geom.effectiveWidthFactor * geom.pileWidthB, geom.spacingS) : 1.0;
  }

  // ---- back (active) face ordinates at elevation el, per unit width, unfactored ----
  struct FaceOrd { double pEarth = 0, pSurch = 0, u = 0; };
  FaceOrd activeOrdinate(double el) const {
    FaceOrd o;
    int idx = stratumAt(backD, el);
    const LayerCoefficients& L = backK[(size_t)idx];
    double sv = back.at(el);
    double u = back.u(el);
    double sref = L.drained ? sv : (sv + u);
    double cohes = L.drained ? L.c : L.cu;
    double pa = L.Ka * sref - L.Kac * cohes;
    if (pa < 0) {
      pa = 0;
      if (opt.assumeCrackWater) {
        // Tension crack filled with water (EN 1997-1 9.6(5)P): hydrostatic from the retained surface;
        // below the phreatic line only the excess over the phreatic term (added further down).
        if (!L.drained || el > loads.waterRetainedEl) o.u += GAMMA_W * (geom.retainedSurfaceEl - el);
        else o.u += GAMMA_W * std::max(geom.retainedSurfaceEl - loads.waterRetainedEl, 0.0);
      }
    }
    o.pEarth = pa;
    o.pSurch = L.Ka * qVar;
    if (L.drained) o.u += u;
    return o;
  }
  // ---- front (passive) face ordinate below the excavation, per unit width ----
  struct PassOrd { double p = 0, u = 0; };
  PassOrd passiveOrdinate(double el) const {
    PassOrd o;
    if (el >= excavationEl - 1e-9) return o;
    int idx = stratumAt(frontD, el);
    const LayerCoefficients& L = frontK[(size_t)idx];
    double sv = front.at(el), u = front.u(el);
    double sref = L.drained ? sv : (sv + u);
    double cohes = L.drained ? L.c : L.cu;
    double pp = L.Kp * sref + L.Kpc * cohes;
    if (pp < 0) pp = 0;
    o.p = pp;
    if (L.drained) o.u = u;
    return o;
  }

  // Brinch Hansen net line resistance of one pile below the excavation (kN/m of pile), with the
  // Andersen–Lodahl retained-height term and the optional row cap. Returns the permanent part;
  // the variable-surcharge part of the A–L term is handled separately (γ_Q) by the caller.
  struct BhOrd { double tlatPerm = 0; double tlatEqualLevel = 0; double rowCap = 0; double Kq = 0, Kc = 0, KqA = 0, sigmaVf = 0; };
  BhOrd brinchHansenOrdinate(double el) const {
    BhOrd o;
    if (el >= excavationEl - 1e-9) return o;
    int idx = stratumAt(frontD, el);
    const LayerCoefficients& L = frontK[(size_t)idx];
    const double B = std::max(geom.pileWidthB, 1e-3);
    const double z = excavationEl - el;
    const double xi = z / B;
    o.Kq = brinchHansenKq(L.bh, xi);
    o.Kc = brinchHansenKc(L.bh, xi);
    o.KqA = L.bh.KqA;
    const double uf = front.u(el);
    const double svF = L.drained ? front.at(el) : (front.at(el) + uf);
    o.sigmaVf = svF;
    const double cohes = L.drained ? L.c : L.cu;
    // Additional active term from the higher retained side: effective vertical-stress difference
    // (layered, incl. berm and permanent surcharge) times the shallow active coefficient.
    const double ub = back.u(el);
    const double svB = L.drained ? back.at(el) : (back.at(el) + ub);
    const double dq = std::max(svB - svF, 0.0);
    const double eEqual = svF * o.Kq + cohes * o.Kc;
    o.tlatEqualLevel = B * std::max(eEqual, 0.0);
    double ew = eEqual - dq * o.KqA;
    double t = B * std::max(ew, 0.0);
    // Row-interaction cap: the tributary strip cannot supply more than the continuous wall.
    const LayerCoefficients& Lb = backK[(size_t)stratumAt(backD, el)];
    const double cohesB = Lb.drained ? Lb.c : Lb.cu;
    double pnetCont = (L.Kp * svF + L.Kpc * cohes) - std::max(Lb.Ka * svB - Lb.Kac * cohesB, 0.0);
    o.rowCap = geom.spacingS * std::max(pnetCont, 0.0);
    if (geom.rowCap && t > o.rowCap) t = o.rowCap;
    o.tlatPerm = t;
    return o;
  }

  // ---- net terms at el, multiplied by the acting widths (solver input) ----
  NetTerms net(double el) const {
    NetTerms n;
    const bool above = el > excavationEl - 1e-9;
    FaceOrd a = activeOrdinate(el);
    n.pBackKpa = a.pEarth + a.pSurch; n.uBackKpa = a.u;
    if (kind == WallKind::Continuous) {
      n.pEarth = a.pEarth; n.pSurch = a.pSurch; n.uBack = a.u;
      PassOrd p = passiveOrdinate(el);
      n.pResist = p.p; n.uFront = p.u; n.pFrontKpa = p.p; n.uFrontKpa = p.u;
      return n;
    }
    if (above) {
      const double w = widthAbove();
      n.pEarth = a.pEarth * w; n.pSurch = a.pSurch * w;
      n.uBack = geom.laggingWatertight ? a.u * w : 0.0;
      if (!geom.laggingWatertight) n.uBackKpa = 0.0;
      return n;
    }
    // below the excavation: discrete piles, no net water (permeable lagging / flow around the pile)
    n.uBackKpa = 0.0;
    if (kind == WallKind::SoldierEffWidth) {
      n.pEarth = a.pEarth * widthActiveBelow();
      n.pSurch = a.pSurch * widthActiveBelow();
      PassOrd p = passiveOrdinate(el);
      n.pResist = p.p * widthPassiveBelow();
      n.pFrontKpa = p.p;
      return n;
    }
    // Brinch Hansen net line resistance (permanent); variable surcharge via the A–L term.
    BhOrd b = brinchHansenOrdinate(el);
    n.pResist = b.tlatPerm;
    n.pSurch = geom.pileWidthB * b.KqA * qVar;   // additional active from the variable surcharge (kN/m pile)
    n.pFrontKpa = (geom.pileWidthB > 0) ? b.tlatPerm / geom.pileWidthB : 0.0;
    return n;
  }

 private:
  void computeCoefficients(const std::vector<Stratum>& D, std::vector<LayerCoefficients>& out) const {
    out.clear();
    for (const Stratum& st : D) {
      LayerCoefficients L;
      L.phi = st.phi; L.c = st.c; L.cu = st.cu; L.drained = st.drained;
      if (st.drained) {
        double incl;
        L.Ka = activeK(EpMethod::Rankine, st.phi, 0.0, 0.0, 0.0, &incl);
        L.Kac = 2.0 * std::sqrt(std::max(L.Ka, 0.0));
        L.deltaP = clampd(opt.deltaPassiveRatio, 0.0, 1.0) * st.phi;
        double Kpc = 2.0;
        L.Kp = passiveK(EpMethod::CaquotKerisel, st.phi, L.deltaP, 0.0, 0.0, &incl, &Kpc);
        L.Kpc = Kpc;
        L.bh = brinchHansenConstants(st.phi);
      } else {
        L.Ka = 1.0; L.Kac = 2.0; L.Kp = 1.0; L.Kpc = 2.0; L.deltaP = 0.0;
        L.bh = brinchHansenConstants(0.0);
      }
      out.push_back(L);
    }
  }
};

}  // namespace madep
