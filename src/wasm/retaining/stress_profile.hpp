// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Vertical effective-stress profile on one side of an embedded wall, precomputed once on a
// fine grid so every pressure query is O(1). Replaces the per-query 60-step re-integration
// of the first engine version (which made the four-branch analysis O(N²)).
//
//   σ′_v(el) = Σ γ_eff·dz  from the ground surface down   (γ_eff = γ_sat − γ_w below the water table)
//            + q_perm                                       (uniform permanent surcharge on this surface)
//            + q_berm(depth)                                (optional retained berm/slope treated as an
//                                                            equivalent surcharge spread under 45°, see below)
//
// Berm-as-surcharge (Rekennota §7.3, an approximation — NOT EN 1997-1 Annex C sloping ground):
// a slope of height Δh at angle β starting at the wall head gives q(x) = γ·x·tan β for
// x ≤ L = Δh/tan β and q = γ·Δh beyond. Averaging over the 45° spread width z gives
//   q_eff(z) = γ·tan β·z/2                     z ≤ L
//   q_eff(z) = γ·Δh·(1 − L/(2z))                z > L
// γ is the unit weight of the berm fill (top stratum by default).
#pragma once

#include "earth_pressure.hpp"
#include <vector>
#include <cmath>

namespace madep {

struct BermSurcharge {
  bool active = false;
  double height = 0;      // Δh (m)
  double slopeRad = 0;    // β from horizontal (rad), 0 < β ≤ 90°
  double gamma = 18;      // fill unit weight (kN/m³)
  double at(double depth) const {
    if (!active || height <= 0 || slopeRad <= 0 || depth <= 0) return 0.0;
    double tb = std::tan(slopeRad);
    if (tb < 1e-6) return 0.0;
    double L = height / tb;
    if (depth <= L) return gamma * tb * depth / 2.0;
    return gamma * height * (1.0 - L / (2.0 * depth));
  }
};

struct StressProfile {
  double surfaceEl = 0;
  double waterEl = -1000;
  double bottomEl = -60;
  double dz = 0.01;
  double qPerm = 0;
  BermSurcharge berm;
  std::vector<double> sigmaV;  // effective vertical stress from self-weight only, at el = surfaceEl − i·dz

  static StressProfile build(const std::vector<Stratum>& strata, double surfaceEl, double waterEl,
                             double bottomEl, double qPerm, const BermSurcharge& berm, double dz = 0.01) {
    StressProfile p;
    p.surfaceEl = surfaceEl; p.waterEl = waterEl; p.bottomEl = bottomEl; p.dz = dz;
    p.qPerm = qPerm; p.berm = berm;
    int n = (int)std::ceil((surfaceEl - bottomEl) / dz) + 2;
    if (n < 2) n = 2;
    p.sigmaV.assign((size_t)n, 0.0);
    double s = 0.0;
    for (int i = 1; i < n; ++i) {
      double elMid = surfaceEl - (i - 0.5) * dz;
      const Stratum& st = strata[stratumAt(strata, elMid)];
      bool sub = elMid < waterEl;
      double g = sub ? (st.gammaSat - GAMMA_W) : st.gammaMoist;
      if (g < 0) g = 0;
      s += g * dz;
      p.sigmaV[(size_t)i] = s;
    }
    return p;
  }

  // Self-weight effective stress only (no surcharge terms).
  double selfWeight(double el) const {
    double d = surfaceEl - el;
    if (d <= 0) return 0.0;
    double x = d / dz;
    size_t i = (size_t)x;
    if (i + 1 >= sigmaV.size()) return sigmaV.back();
    double f = x - (double)i;
    return sigmaV[i] * (1.0 - f) + sigmaV[i + 1] * f;
  }
  // Full effective vertical stress incl. permanent surcharge and berm equivalent surcharge.
  double at(double el) const {
    double d = surfaceEl - el;
    if (d <= 0) return 0.0;
    return selfWeight(el) + qPerm + berm.at(d);
  }
  // Hydrostatic pore pressure (kPa).
  double u(double el) const { return (el < waterEl) ? GAMMA_W * (waterEl - el) : 0.0; }
};

}  // namespace madep
