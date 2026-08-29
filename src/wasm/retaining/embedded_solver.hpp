// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Limit-equilibrium solver for an embedded wall — idealisation-agnostic: it only sees the
// factored net terms of an EmbeddedModel.
//
//   cantilever : moments about the toe of a trial embedment d; the free-earth depth d₀ is the root
//                of ODF(d) = |M_resist| / |M_drive| = 1 (Blum's rotation point); design embedment
//                1.2·d₀ (Blum 1931; Rekennota §7.4). The 20 % is part of the method, not an EC7 factor.
//   anchored   : free-earth support — moments about the anchor give d₀; horizontal equilibrium
//                at d₀ gives the support reaction T (course manual §4.4, eq. 19–20).
//   diagrams   : shear V and moment M by double integration of the net pressure on the PROVIDED
//                pile (course eq. 21–22), the anchor reaction as a shear jump; M_max at the
//                governing zero-shear crossing inside the model-valid depth (≤ closure).
#pragma once

#include "embedded_model.hpp"
#include "results.hpp"
#include <vector>
#include <string>
#include <cmath>

namespace madep {

struct EmbStat {
  double Hdrive = 0, Hresist = 0;   // kN (per m of wall or per pile)
  double Mdrive = 0, Mresist = 0;   // kNm about the reference
};

inline double factoredDrive(const EmbeddedModel& m, const NetTerms& n) {
  return m.branch.gG * (n.pEarth + n.uBack) + m.branch.gQ * n.pSurch;
}
inline double factoredResist(const EmbeddedModel& m, const NetTerms& n) {
  return m.branch.gGResist * (n.pResist + n.uFront);
}

inline EmbStat integrateEmbedded(const EmbeddedModel& m, double toeEl, double refEl, int N = 800) {
  EmbStat st;
  const double top = m.geom.retainedSurfaceEl;
  const double dz = (top - toeEl) / N;
  if (dz <= 0) return st;
  for (int i = 0; i < N; ++i) {
    const double el = top - (i + 0.5) * dz;
    NetTerms n = m.net(el);
    const double drive = factoredDrive(m, n), resist = factoredResist(m, n);
    const double arm = el - refEl;
    st.Hdrive += drive * dz; st.Hresist += resist * dz;
    st.Mdrive += drive * dz * arm; st.Mresist += resist * dz * arm;
  }
  return st;
}

inline double odfAt(const EmbeddedModel& m, double d) {
  const double toeEl = m.excavationEl - d;
  const double refEl = m.geom.anchored ? m.geom.anchorEl : toeEl;
  EmbStat s = integrateEmbedded(m, toeEl, refEl);
  const double Md = std::fabs(s.Mdrive), Mr = std::fabs(s.Mresist);
  return (Md > 1e-9) ? Mr / Md : 1e9;
}

// Free-earth embedment d₀ with ODF = 1 (bisection). Returns {d0, bracketed}.
struct EmbedRoot { double d0 = 0; bool bracketed = false; };
inline EmbedRoot freeEarthEmbedment(const EmbeddedModel& m) {
  EmbedRoot r;
  double lo = 0.05, hi = 40.0;
  double flo = odfAt(m, lo) - 1.0, fhi = odfAt(m, hi) - 1.0;
  if (flo > 0) { r.d0 = lo; r.bracketed = true; return r; }
  if (fhi < 0) { r.d0 = hi; r.bracketed = false; return r; }
  for (int i = 0; i < 60; ++i) {
    double mid = 0.5 * (lo + hi);
    if (odfAt(m, mid) - 1.0 > 0) hi = mid; else lo = mid;
  }
  r.d0 = 0.5 * (lo + hi); r.bracketed = true;
  return r;
}

// Anchor / prop reaction (kN per m or per pile) from horizontal equilibrium at the free-earth depth.
inline double supportReaction(const EmbeddedModel& m, double d0) {
  if (!m.geom.anchored) return 0.0;
  EmbStat s = integrateEmbedded(m, m.excavationEl - d0, 0.0);
  double T = s.Hdrive - s.Hresist;
  return T < 0 ? 0.0 : T;
}

struct DiagramSet {
  Series pBack, pFront, uBack, uFront, net, V, M;   // depth below the retained surface
  double Mmax = 0, yMmax = 0, Vmax = 0, yVmax = 0;
  double zNetZero = -1;   // depth below the excavation where the factored net pressure changes sign
  double closureDepth = 0;
  bool closed = false;    // a moment zero-crossing (closure) exists inside the model-valid depth
};

// V/M by double integration on the provided pile (toeEl). T = support reaction (factored), dClose =
// depth below the retained surface of this branch's free-earth closure.
inline DiagramSet buildDiagrams(const EmbeddedModel& m, double toeEl, double T, double dClose, int N = 600) {
  DiagramSet D;
  const double top = m.geom.retainedSurfaceEl;
  const double dz = (top - toeEl) / N;
  if (dz <= 0) return D;
  const double dCloseTol = dClose + std::max(0.05, 2.0 * dz);
  D.closureDepth = dClose;
  double anchorEl = m.geom.anchorEl;
  if (m.geom.anchored && anchorEl >= top - dz) anchorEl = top - dz;
  double V = 0, M = 0, Vprev = 0, netPrev = 0;
  double Mzero = 0, mAbsMax = 0, yAbs = 0, yZero = 0;
  bool first = true, sawCross = false;
  std::vector<double> zArr, vArr, mArr;
  const int plotEvery = std::max(N / 200, 1);
  int k = 0;
  bool prevNetPositive = true; double prevDepth = 0;
  for (double el = top; el > toeEl - 1e-9; el -= dz, ++k) {
    NetTerms n = m.net(el);
    const double netF = factoredDrive(m, n) - factoredResist(m, n);
    // trapezoidal double integration (V from the net pressure, M from V); the support reaction is a
    // shear jump −T applied at its EXACT elevation inside the step that contains it
    double Vnew = first ? 0.0 : V + 0.5 * (netPrev + netF) * dz;
    double dM = first ? 0.0 : 0.5 * (V + Vnew) * dz;
    if (m.geom.anchored && !first && el <= anchorEl && (el + dz) > anchorEl) {
      dM -= T * (anchorEl - el);
      Vnew -= T;
    }
    M += dM; V = Vnew; netPrev = netF;
    const double depth = top - el;
    if (el < m.excavationEl && D.zNetZero < 0 && !first) {
      if (prevNetPositive && netF <= 0 && prevDepth > 1e-9) D.zNetZero = (top - el) - (m.geom.retainedSurfaceEl - m.excavationEl);
    }
    prevNetPositive = netF > 0; prevDepth = depth;
    if (depth <= dCloseTol && std::fabs(M) > mAbsMax) { mAbsMax = std::fabs(M); yAbs = depth; }
    if (!first && ((Vprev > 0 && V <= 0) || (Vprev < 0 && V >= 0)) && depth > 0.1 && depth <= dCloseTol) {
      if (std::fabs(M) > Mzero) { Mzero = std::fabs(M); yZero = depth; }
      sawCross = true;
    }
    first = false; Vprev = V;
    if ((k % plotEvery) == 0) {
      zArr.push_back(depth); vArr.push_back(V); mArr.push_back(M);
      D.pBack.z.push_back(depth); D.pBack.v.push_back(n.pBackKpa);
      D.pFront.z.push_back(depth); D.pFront.v.push_back(n.pFrontKpa);
      D.uBack.z.push_back(depth); D.uBack.v.push_back(n.uBackKpa);
      D.uFront.z.push_back(depth); D.uFront.v.push_back(n.uFrontKpa);
      D.net.z.push_back(depth); D.net.v.push_back(netF);
    }
  }
  D.Mmax = sawCross ? Mzero : mAbsMax;
  D.yMmax = sawCross ? yZero : yAbs;
  // last moment zero-crossing inside the valid depth = free-earth closure; the tail beyond diverges
  double zContra = top - toeEl; bool found = false;
  for (size_t i = 1; i < zArr.size(); ++i) {
    if (zArr[i] > dCloseTol + 1e-9) break;
    if (zArr[i] <= 0.1) continue;
    if ((mArr[i - 1] > 0 && mArr[i] <= 0) || (mArr[i - 1] < 0 && mArr[i] >= 0)) { zContra = zArr[i]; found = true; }
  }
  D.closed = found;
  for (size_t i = 0; i < zArr.size(); ++i) {
    const bool beyond = found && zArr[i] > zContra + 1e-9;
    D.V.z.push_back(zArr[i]); D.V.v.push_back(beyond ? 0.0 : vArr[i]);
    D.M.z.push_back(zArr[i]); D.M.v.push_back(beyond ? 0.0 : mArr[i]);
    const double av = std::fabs(beyond ? 0.0 : vArr[i]);
    if (av > D.Vmax) { D.Vmax = av; D.yVmax = zArr[i]; }
  }
  D.pBack.id = "p_back"; D.pBack.label = "Retained-side pressure (earth + surcharge)"; D.pBack.unit = "kPa";
  D.pFront.id = "p_front"; D.pFront.label = "Excavation-side resistance"; D.pFront.unit = "kPa";
  D.uBack.id = "u_back"; D.uBack.label = "Water pressure, retained side"; D.uBack.unit = "kPa";
  D.uFront.id = "u_front"; D.uFront.label = "Water pressure, excavation side"; D.uFront.unit = "kPa";
  D.net.id = "net"; D.net.label = "Factored net pressure"; D.net.unit = m.perPile() ? "kN/m pile" : "kPa";
  D.V.id = "V"; D.V.label = "Shear"; D.V.unit = m.perPile() ? "kN" : "kN/m";
  D.M.id = "M"; D.M.label = "Bending moment"; D.M.unit = m.perPile() ? "kNm" : "kNm/m";
  return D;
}

}  // namespace madep
