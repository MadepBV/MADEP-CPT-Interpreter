// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Soldier-pile (Berliner wall) specifics that sit next to the shared embedded solver:
//   • PLAXIS 2D Embedded-Beam-Row lateral-resistance tables T_lat,max(z) [kN/m of ONE pile]
//     from the Brinch Hansen coefficients (brinch_hansen.hpp) with B = flange width — never
//     divided by the spacing, never 3B (Rekennota §5.7; course chapter §8.3).
//     Two conventions are tabulated side by side and the engineer chooses:
//       equal-level  T = B·(σ′_v,f·K_q + c·K_c)                       (Rekennota Table 5-7)
//       A–L          T = B·[σ′_v,f·K_q + c·K_c − Δq·K_q^A]⁺            (Andersen & Lodahl 2023;
//                    Δq = σ′_v,back − σ′_v,front incl. surcharges)     course chapter eq. 5)
//     plus the continuous-wall row cap s·p_net (chapter §4.4, an engineering safeguard).
//   • Lagging design pressure at the excavation level (course/Rekennota §7.8).
#pragma once

#include "embedded_model.hpp"
#include <vector>
#include <string>
#include <cmath>

namespace madep {

struct BhLayerInfo {
  double topEl = 0, phiDeg = 0, c = 0, cu = 0; bool drained = true;
  BrinchHansenConstants k;
};

struct TlatRow {
  double z = 0;            // distance from the top of the EBR (= design excavation) (m)
  double sigmaVf = 0;      // front-side vertical effective stress (kPa)
  double dq = 0;           // retained-side minus front-side vertical stress difference (kPa)
  double Kq = 0, Kc = 0, KqA = 0;
  double tlatEqual = 0;    // kN/m pile, equal-level convention
  double tlatAL = 0;       // kN/m pile, Andersen–Lodahl convention (positive part)
  double rowCap = 0;       // kN/m pile, s·p_net,continuous
  double tlatAdopted = 0;  // min(AL, rowCap) when the cap is enabled, else AL
};

struct TlatTable {
  std::string id, label;
  double gPhi = 1, gC = 1, gCu = 1;
  double B = 0, s = 0, topEl = 0, toeEl = 0;
  std::vector<BhLayerInfo> layers;
  std::vector<TlatRow> rows;
  double Ru = 0, Mu = 0, zBar = 0;   // integrals of the adopted profile (kN/pile, kNm/pile about the EBR top)
};

// m must be built with WallKind::SoldierBrinchHansen for the wanted material set and excavation.
inline TlatTable buildTlatTable(const EmbeddedModel& m, double toeEl, const char* id, const char* label,
                                double rowStep = 0.25) {
  TlatTable t;
  t.id = id; t.label = label;
  t.gPhi = m.branch.m.gPhi; t.gC = m.branch.m.gC; t.gCu = m.branch.m.gCu;
  t.B = m.geom.pileWidthB; t.s = m.geom.spacingS; t.topEl = m.excavationEl; t.toeEl = toeEl;
  for (size_t i = 0; i < m.frontD.size(); ++i) {
    BhLayerInfo li;
    li.topEl = m.frontD[i].topEl; li.phiDeg = rad2deg(m.frontD[i].phi); li.c = m.frontD[i].c; li.cu = m.frontD[i].cu;
    li.drained = m.frontD[i].drained; li.k = m.frontK[i].bh;
    t.layers.push_back(li);
  }
  // rows: every rowStep from the EBR top, every layer boundary inside, and the toe
  std::vector<double> zs;
  const double L = m.excavationEl - toeEl;
  if (L <= 0) return t;
  for (double z = 0; z < L - 1e-9; z += rowStep) zs.push_back(z);
  for (const Stratum& st : m.frontD) {
    double z = m.excavationEl - st.topEl;
    if (z > 1e-6 && z < L - 1e-6) { zs.push_back(z - 1e-4); zs.push_back(z + 1e-4); }
  }
  zs.push_back(L);
  // sort + unique
  for (size_t i = 1; i < zs.size(); ++i) { double k = zs[i]; size_t j = i; while (j > 0 && zs[j - 1] > k) { zs[j] = zs[j - 1]; --j; } zs[j] = k; }
  for (double z : zs) {
    const double el = m.excavationEl - z - 1e-9;
    EmbeddedModel::BhOrd o = m.brinchHansenOrdinate(el);
    TlatRow r;
    r.z = z; r.sigmaVf = o.sigmaVf; r.Kq = o.Kq; r.Kc = o.Kc; r.KqA = o.KqA;
    // recompute the A–L term with the variable surcharge included (representative loads)
    const int idx = stratumAt(m.frontD, el);
    const LayerCoefficients& Lf = m.frontK[(size_t)idx];
    const double cohes = Lf.drained ? Lf.c : Lf.cu;
    const double ub = m.back.u(el), uf = m.front.u(el);
    const double svB = Lf.drained ? m.back.at(el) : (m.back.at(el) + ub);
    r.dq = std::max(svB - o.sigmaVf, 0.0) + m.qVar;
    const double eEqual = o.sigmaVf * o.Kq + cohes * o.Kc;
    r.tlatEqual = t.B * std::max(eEqual, 0.0);
    r.tlatAL = t.B * std::max(eEqual - r.dq * o.KqA, 0.0);
    r.rowCap = o.rowCap;
    r.tlatAdopted = m.geom.rowCap ? std::min(r.tlatAL, r.rowCap) : r.tlatAL;
    (void)uf;
    t.rows.push_back(r);
  }
  // trapezoidal integrals of the adopted profile
  for (size_t i = 1; i < t.rows.size(); ++i) {
    const TlatRow& a = t.rows[i - 1]; const TlatRow& b = t.rows[i];
    const double dz = b.z - a.z; if (dz <= 0) continue;
    t.Ru += 0.5 * (a.tlatAdopted + b.tlatAdopted) * dz;
    t.Mu += 0.5 * (a.tlatAdopted * a.z + b.tlatAdopted * b.z) * dz;
  }
  t.zBar = (t.Ru > 1e-9) ? t.Mu / t.Ru : 0.0;
  return t;
}

// Factored horizontal pressure on the lagging at the branch's excavation level (kPa, per unit area),
// i.e. the deepest lagging board: γ_G·(K_a σ′_v − K_ac c)⁺ + γ_Q·K_a q (+ water if watertight).
struct LaggingPressure { double pEarth = 0, pSurch = 0, u = 0, total = 0; };
inline LaggingPressure laggingPressureAt(const EmbeddedModel& m) {
  LaggingPressure lp;
  const double el = m.excavationEl + 1e-6;
  EmbeddedModel::FaceOrd a = m.activeOrdinate(el);
  lp.pEarth = m.branch.gG * a.pEarth;
  lp.pSurch = m.branch.gQ * a.pSurch;
  lp.u = m.geom.laggingWatertight ? m.branch.gG * a.u : 0.0;
  lp.total = (lp.pEarth + lp.pSurch + lp.u) * m.branch.effectFactor;
  return lp;
}

}  // namespace madep
