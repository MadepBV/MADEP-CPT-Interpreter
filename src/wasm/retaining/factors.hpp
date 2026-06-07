// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Eurocode-7 partial-factor sets for Belgium (NBN EN 1997-1 ANB, DA1) plus the
// EQU/UPL/HYD sets and the optional Buildwise embedded-wall risk-class overlay.
// Numbers are the verified values from docs/stage6/retaining_wall_methodology.md §1.
// Treated as configurable data so the 2nd-generation EN 1997-1:2024 sets can be
// re-mapped later.
#pragma once

#include <string>

namespace madep {

// Action factors (set A1 or A2).
struct ActionFactors {
  double gG_unfav;  // permanent unfavourable
  double gG_fav;    // permanent favourable
  double gQ_unfav;  // variable unfavourable
  double gQ_fav;    // variable favourable (always 0)
};

// Material factors (set M1 or M2). Applied to characteristic strengths.
struct MaterialFactors {
  double gPhi;    // on tan(phi')
  double gC;      // on c'
  double gCu;     // on c_u
  double gGamma;  // on unit weight (always 1.0)
};

// Resistance factors (set R1 for the wall body in DA1).
struct ResistanceFactors {
  double gBearing;  // R;v
  double gSliding;  // R;h
  double gPassive;  // R;e (earth resistance)
};

// A fully-resolved verification combination.
struct Combination {
  std::string id;     // "C1", "C2", "EQU", "UPL", "HYD"
  std::string label;  // human label
  ActionFactors a;
  MaterialFactors m;
  ResistanceFactors r;
  bool splitFavUnfav = false;  // EQU/UPL/HYD: stabilising vs destabilising split
  double gG_stb = 1.0;         // stabilising permanent (EQU/UPL/HYD)
  double gG_dst = 1.0;         // destabilising permanent (EQU/UPL/HYD)
  double gQ_dst = 1.0;         // destabilising variable
  double kFI = 1.0;            // consequence-class multiplier on unfavourable actions
};

// ---- EN/ANB recommended sets (the verified Belgian DA1 defaults, §1.2) ----
inline ActionFactors A1() { return {1.35, 1.00, 1.50, 0.0}; }
inline ActionFactors A2_default() { return {1.00, 1.00, 1.30, 0.0}; }  // gQ=1.30 (verdict)
inline MaterialFactors M1() { return {1.00, 1.00, 1.00, 1.00}; }
inline MaterialFactors M2_default() { return {1.25, 1.25, 1.40, 1.00}; }
inline ResistanceFactors R1() { return {1.00, 1.00, 1.00}; }

// Consequence-class multiplier K_FI applied to unfavourable actions (§1.3).
inline double kFIfor(int consequenceClass) {
  if (consequenceClass <= 1) return 0.90;  // CC1
  if (consequenceClass >= 3) return 1.10;  // CC3
  return 1.00;                              // CC2
}

// Optional Buildwise risk-class overlay (§1.5) — NOT the default; project-confirmed only.
// Returns A2/M2 overrides for RK1/RK2/RK3; scheme==0 keeps the EN/ANB default.
inline void riskClassOverride(int scheme, ActionFactors& a1, ActionFactors& a2,
                              MaterialFactors& m2) {
  switch (scheme) {
    case 1:  // RK1
      a1 = {1.20, 1.00, 1.30, 0.0};
      a2 = {1.00, 1.00, 1.10, 0.0};
      m2 = {1.10, 1.10, 1.25, 1.00};
      break;
    case 2:  // RK2
      a1 = {1.35, 1.00, 1.50, 0.0};
      a2 = {1.00, 1.00, 1.10, 0.0};
      m2 = {1.25, 1.25, 1.40, 1.00};
      break;
    case 3:  // RK3
      a1 = {1.50, 1.00, 1.80, 0.0};
      a2 = {1.00, 1.00, 1.20, 0.0};
      m2 = {1.40, 1.40, 1.55, 1.00};
      break;
    default:
      break;  // EN/ANB default — leave as-is
  }
}

// Build the two DA1 GEO/STR combinations for the given scheme + consequence class.
inline Combination makeC1(int scheme, int cc) {
  ActionFactors a1 = A1(), a2 = A2_default();
  MaterialFactors m2 = M2_default();
  riskClassOverride(scheme, a1, a2, m2);
  Combination c;
  c.id = "C1";
  c.label = "DA1 Combination 1 (A1+M1+R1)";
  c.a = a1;
  c.m = M1();
  c.r = R1();
  c.kFI = kFIfor(cc);
  return c;
}
inline Combination makeC2(int scheme, int cc) {
  ActionFactors a1 = A1(), a2 = A2_default();
  MaterialFactors m2 = M2_default();
  riskClassOverride(scheme, a1, a2, m2);
  Combination c;
  c.id = "C2";
  c.label = "DA1 Combination 2 (A2+M2+R1)";
  c.a = a2;
  c.m = m2;
  c.r = R1();
  c.kFI = kFIfor(cc);
  return c;
}

// EQU static equilibrium (§1.2). Materials = M2; stabilising/destabilising split.
// K_FI is deliberately NOT applied to EQU (the §3 Check 4 overturning formula uses the
// EQU Set-A factors directly; K_FI is tied to the 6.10/6.10a-b GEO/STR combinations, §1.3).
inline Combination makeEQU(int cc) {
  (void)cc;
  Combination c;
  c.id = "EQU";
  c.label = "EQU static equilibrium";
  c.a = {1.10, 0.90, 1.50, 0.0};  // dst/stb permanent, dst variable
  c.m = M2_default();
  c.r = R1();
  c.splitFavUnfav = true;
  c.gG_dst = 1.10;
  c.gG_stb = 0.90;
  c.gQ_dst = 1.50;
  c.kFI = 1.0;
  return c;
}

// HYD heave/piping (§5.6).
inline Combination makeHYD() {
  Combination c;
  c.id = "HYD";
  c.label = "HYD hydraulic heave/piping";
  c.a = {1.35, 0.90, 1.50, 0.0};
  c.m = M1();
  c.r = R1();
  c.splitFavUnfav = true;
  c.gG_dst = 1.35;
  c.gG_stb = 0.90;
  c.gQ_dst = 1.50;
  return c;
}

// UPL flotation (§5.6).
inline Combination makeUPL() {
  Combination c;
  c.id = "UPL";
  c.label = "UPL uplift/flotation";
  c.a = {1.00, 0.90, 1.50, 0.0};
  c.m = M2_default();
  c.r = R1();
  c.splitFavUnfav = true;
  c.gG_dst = 1.00;
  c.gG_stb = 0.90;
  c.gQ_dst = 1.50;
  return c;
}

}  // namespace madep
