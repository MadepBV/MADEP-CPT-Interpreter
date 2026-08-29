// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Design branches for embedded walls — the Belgian RK workflow of the BGGG/WTCB (2022)
// embedded-wall guideline ("Richtlijnen EC7 beschoeiingen") as taught in the course manual §5:
//
//   DA1/2   A2 + M2 (risk class), design excavation (nominal − Δa)   → embedment (GEO)
//   DA1/1   A1 + M1,             design excavation                   → EN DA1 first combination
//           (γ_G = 1.35 on the retained-side actions; the favourable passive resistance keeps
//           γ_G,fav = 1.00 unless the single-source option is selected)
//   BGT+αv  γ = 1.0, α_ver = 1.1 on variable actions, characteristic strength, NOMINAL excavation
//           → section forces and support forces, multiplied by 1.35 for the STR values
//   SLS     γ = 1.0, characteristic, nominal excavation               → serviceability reference
//
// Over-excavation Δa (EN 1997-1 §9.3.2.2 / guideline §3.3) is a ULS geometry assumption and
// is applied to the two ULS branches only. K_FI (EN 1990 Annex B) is applied only with the
// generic NBN EN 1997-1 ANB set — the risk-class sets already differentiate reliability.
#pragma once

#include "factors.hpp"
#include <string>
#include <vector>
#include <cmath>

namespace madep {

enum class OverdigRule { Belgian = 0, EN = 1, Custom = 2, None = 3 };

struct BranchSpec {
  std::string id;        // "DA1-2", "DA1-1", "BGT", "SLS"
  std::string label;
  double gG = 1.0;       // permanent actions on the retained side (earth, water, permanent surcharge, berm)
  double gGResist = 1.0; // permanent favourable resistance in front (passive earth, front water)
  double gQ = 1.0;       // variable surcharge (already includes α_ver for BGT)
  double alphaVer = 1.0; // reported separately for transparency
  MaterialFactors m{1, 1, 1, 1};
  double effectFactor = 1.0;  // multiplies section/support forces for STR (1.35 for BGT)
  double overdig = 0.0;       // applied to the excavation level in this branch (m)
  bool uls = true;
  bool governsEmbedment = false;  // DA1/2 (and DA1/1 for information)
};

struct BranchSettings {
  int riskScheme = 2;          // 0 generic ANB, 1..3 = RK1..RK3
  int consequenceClass = 2;    // K_FI only with scheme 0
  OverdigRule overdigRule = OverdigRule::Belgian;
  double overdigCustom = 0.30;
  double alphaVer = 1.10;
  double effectFactorBGT = 1.35;
  bool materialOverride = false;   // replace M2 in DA1/2 by the values below (e.g. SB260: 1.30)
  MaterialFactors mOverride{1.30, 1.30, 1.40, 1.0};
  // DA1/1 treatment of the favourable passive resistance:
  //   true  → "separate source": γ_G = 1.35 on the retained-side actions, γ_G,fav = 1.00 on the passive
  //           resistance and front water (Rekennota §7.6; conservative)
  //   false → "single source" (EN 1997-1 2.4.2(9)P): 1.35 on both sides — equivalent to the Belgian
  //           simplified route (BGT + α_ver) × 1.35, which the app reports as its own branch anyway
  bool da11SeparateSource = true;
};

inline const char* schemeLabel(int scheme) {
  switch (scheme) {
    case 1: return "Belgian embedded-wall guideline (2022) — RK1";
    case 2: return "Belgian embedded-wall guideline (2022) — RK2";
    case 3: return "Belgian embedded-wall guideline (2022) — RK3";
    default: return "NBN EN 1997-1 ANB generic DA1 sets";
  }
}

// Δa for the ULS branches. h = retained height (cantilever) or height below the lowest support.
inline double overdigFor(const BranchSettings& s, double h, bool underWater) {
  switch (s.overdigRule) {
    case OverdigRule::Belgian: return underWater ? std::min(0.1 * h, 0.5) : 0.30;
    case OverdigRule::EN: return std::min(0.1 * h, 0.5);
    case OverdigRule::Custom: return std::max(s.overdigCustom, 0.0);
    default: return 0.0;
  }
}

inline std::vector<BranchSpec> makeEmbeddedBranches(const BranchSettings& s, double overdigUls) {
  ActionFactors a1 = A1(), a2 = A2_default();
  MaterialFactors m2 = M2_default();
  riskClassOverride(s.riskScheme, a1, a2, m2);
  if (s.materialOverride) m2 = s.mOverride;
  const double kFI = (s.riskScheme == 0) ? kFIfor(s.consequenceClass) : 1.0;

  std::vector<BranchSpec> out;
  {
    BranchSpec b; b.id = "DA1-2"; b.label = "DA1/2 (A2 + M2) — embedment, design excavation";
    b.gG = a2.gG_unfav * kFI; b.gGResist = a2.gG_unfav * kFI; b.gQ = a2.gQ_unfav * kFI; b.alphaVer = 1.0; b.m = m2;
    b.effectFactor = 1.0; b.overdig = overdigUls; b.uls = true; b.governsEmbedment = true;
    out.push_back(b);
  }
  {
    BranchSpec b; b.id = "DA1-1";
    b.label = s.da11SeparateSource
      ? "DA1/1 (A1 + M1) — γ_G 1.35 on retained-side actions, passive favourable 1.00, design excavation"
      : "DA1/1 (A1 + M1) — single-source γ_G 1.35 both sides, design excavation";
    b.gG = a1.gG_unfav * kFI; b.gGResist = s.da11SeparateSource ? a1.gG_fav : a1.gG_unfav * kFI;
    b.gQ = a1.gQ_unfav * kFI; b.alphaVer = 1.0; b.m = M1();
    b.effectFactor = 1.0; b.overdig = overdigUls; b.uls = true;
    // Under the Belgian guideline the embedment is governed by DA1/2 alone (guideline §3.5); with the
    // generic EN/ANB sets both DA1 combinations must be satisfied for GEO.
    b.governsEmbedment = (s.riskScheme == 0);
    out.push_back(b);
  }
  {
    BranchSpec b; b.id = "BGT"; b.label = "BGT + α_ver — characteristic strength, nominal excavation (× 1.35 for STR)";
    b.gG = 1.0; b.gGResist = 1.0; b.gQ = s.alphaVer; b.alphaVer = s.alphaVer; b.m = M1();
    b.effectFactor = s.effectFactorBGT; b.overdig = 0.0; b.uls = false;
    out.push_back(b);
  }
  {
    BranchSpec b; b.id = "SLS"; b.label = "SLS — characteristic, nominal excavation";
    b.gG = 1.0; b.gGResist = 1.0; b.gQ = 1.0; b.alphaVer = 1.0; b.m = M1();
    b.effectFactor = 1.0; b.overdig = 0.0; b.uls = false;
    out.push_back(b);
  }
  return out;
}

}  // namespace madep
