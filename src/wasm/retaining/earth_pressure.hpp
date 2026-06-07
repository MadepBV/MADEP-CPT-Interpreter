// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Earth-pressure core — implements docs/stage6/retaining_wall_methodology.md §2.
// Conventions: elevations y up (m); depth measured downward; forces kN per metre
// run; stresses kPa; unit weights kN/m^3; angles stored in radians internally.
// Earth pressure is computed on effective stress; water is added separately so the
// partial-factor engine can factor permanent earth, variable surcharge, and water
// independently (single-source principle handled by the caller via action tagging).
#pragma once

#include <vector>
#include <cmath>
#include <algorithm>

namespace madep {

constexpr double PI = 3.14159265358979323846;
constexpr double GAMMA_W = 9.81;  // kN/m^3

inline double deg2rad(double d) { return d * PI / 180.0; }
inline double rad2deg(double r) { return r * 180.0 / PI; }
inline double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

// A soil stratum (design values are passed in — material factors already applied).
struct Stratum {
  double topEl;       // elevation of the top of this stratum (m)
  double gammaMoist;  // moist/bulk unit weight above water table (kN/m^3)
  double gammaSat;    // saturated unit weight below water table (kN/m^3)
  double phi;         // design effective friction angle (rad)
  double c;           // design effective cohesion (kPa)
  double cu;          // design undrained shear strength (kPa)
  bool drained;       // true → effective (phi,c); false → undrained (cu)
  double qc;          // representative CPT cone resistance q_c (kPa) for the De Beer bearing method
};

// Resolve which stratum applies at elevation `el` (strata sorted top→down by topEl).
inline int stratumAt(const std::vector<Stratum>& strata, double el) {
  int idx = 0;
  for (int i = 0; i < (int)strata.size(); ++i) {
    if (strata[i].topEl >= el - 1e-9) idx = i;
    else break;
  }
  return idx;
}

// -------------------- coefficient functions (§2.1–2.4) --------------------
inline double k0Jaky(double phi) { return 1.0 - std::sin(phi); }
inline double k0Oc(double phi, double ocr) {
  double s = std::sin(phi);
  double k = (1.0 - s) * std::pow(std::max(ocr, 1.0), s);
  double kp = (1.0 + s) / (1.0 - s);   // cap at Kp (§2.1)
  return k < kp ? k : kp;
}

inline double rankineKaLevel(double phi) {
  double s = std::sin(phi);
  return (1.0 - s) / (1.0 + s);
}
inline double rankineKpLevel(double phi) {
  double s = std::sin(phi);
  return (1.0 + s) / (1.0 - s);
}
// Sloping backfill beta (rad). Physically the surface slope cannot exceed the angle of
// repose: |beta| < phi'. Above that the Rankine radicand goes negative and the formula
// silently returns a too-small (unsafe) Ka, so we cap |beta| at phi'-epsilon. The caller
// should additionally REJECT beta > phi' at the UI; this cap is the engine-side backstop.
inline double rankineKaSlope(double phi, double beta) {
  double bcap = phi - deg2rad(0.1);
  if (beta > bcap) beta = bcap; else if (beta < -bcap) beta = -bcap;
  double cb = std::cos(beta);
  double root = std::sqrt(std::max(std::cos(beta) * std::cos(beta) - std::cos(phi) * std::cos(phi), 0.0));
  return cb * (cb - root) / (cb + root);
}
inline double rankineKpSlope(double phi, double beta) {
  double bcap = phi - deg2rad(0.1);
  if (beta > bcap) beta = bcap; else if (beta < -bcap) beta = -bcap;
  double cb = std::cos(beta);
  double root = std::sqrt(std::max(std::cos(beta) * std::cos(beta) - std::cos(phi) * std::cos(phi), 0.0));
  double denom = (cb - root);
  if (denom < 1e-9) denom = 1e-9;
  return cb * (cb + root) / denom;
}

// Coulomb active (§2.3). delta wall friction, theta wall batter from vertical, beta slope.
inline double coulombKa(double phi, double delta, double theta, double beta) {
  double num = std::cos(phi - theta);
  num *= num;
  double s = std::sin(delta + phi) * std::sin(phi - beta);
  double d = std::cos(delta + theta) * std::cos(beta - theta);
  double rootArg = (d != 0.0) ? (s / d) : 0.0;
  if (rootArg < 0.0) rootArg = 0.0;
  double bracket = 1.0 + std::sqrt(rootArg);
  double denom = std::cos(theta) * std::cos(theta) * std::cos(delta + theta) * bracket * bracket;
  if (std::fabs(denom) < 1e-12) return rankineKaLevel(phi);
  return num / denom;
}
// NOTE: passive earth pressure is computed exclusively from the EN 1997-1 Annex C
// closed-form below (annexCPassive). The legacy planar Coulomb-passive coefficient and the
// digitised Kerisel-Absi lookup table were removed in the method-consolidation pass: Coulomb
// passive over-predicts K_p for delta > phi'/3 (unsafe) and the table only added interpolation
// error over the rigorous closed form. Active still uses Rankine/Coulomb (coulombKa above).

// EN 1997-1:2004 Annex C closed-form earth-pressure coefficients (Brinch-Hansen
// log-spiral plasticity field), eqs C.3–C.9. Rigorous, self-contained, handles surface
// slope beta and wall batter theta analytically, reproduces Rankine exactly at delta=0,
// and is conservative (lower K_p) vs Kerisel-Absi at high phi'/delta — safe for passive.
// All angles in radians; for PASSIVE all are inserted positive. Returns the coefficient
// for the pressure NORMAL to the wall (= horizontal for a vertical wall).
struct AnnexCK {
  double Kgamma;  // self-weight coefficient (the "Kp"/"Ka" applied to sigma'_v)
  double Kq;      // vertical-surcharge coefficient
  double Kc;      // cohesion coefficient (Kpc / Kac)
};
inline AnnexCK annexCPassive(double phi, double delta, double beta, double theta) {
  double sphi = std::sin(phi);
  double sb = clampd(std::sin(beta) / sphi, -1.0, 1.0);
  double sd = clampd(std::sin(delta) / sphi, -1.0, 1.0);
  double mt = 0.5 * (std::acos(-sb) - phi - beta);   // C.3
  double mw = 0.5 * (std::acos(sd) - phi - delta);   // C.4
  double v = mt + beta - mw - theta;                  // C.5
  double denom = 1.0 - sphi * std::sin(2.0 * mt + phi);
  if (std::fabs(denom) < 1e-9) denom = (denom < 0 ? -1e-9 : 1e-9);
  double Kn = (1.0 + sphi * std::sin(2.0 * mw + phi)) / denom * std::exp(2.0 * v * std::tan(phi));  // C.6
  AnnexCK r;
  r.Kgamma = Kn * std::cos(beta) * std::cos(beta - theta);  // C.9 (Kp = Kγ)
  r.Kq = Kn * std::cos(beta) * std::cos(beta);              // C.7
  r.Kc = (Kn - 1.0) / std::tan(phi);                        // C.8  (= (Kn-1)·cot φ')
  return r;
}

enum class EpMethod { Rankine, Coulomb, CaquotKerisel };

// Active coefficient dispatcher. Returns K applied to sigma'_v (along the resultant
// direction); incl (rad, out) is the resultant inclination from horizontal.
inline double activeK(EpMethod method, double phi, double delta, double theta, double beta,
                      double* incl) {
  switch (method) {
    case EpMethod::Coulomb:
      if (incl) *incl = delta + theta;  // from wall normal; vertical wall normal is horizontal
      return coulombKa(phi, delta, theta, beta);
    default:  // Rankine (and CaquotKerisel uses Rankine/Coulomb for active)
      if (incl) *incl = beta;
      return (std::fabs(beta) > 1e-9) ? rankineKaSlope(phi, beta) : rankineKaLevel(phi);
  }
}

// Passive coefficient — ALWAYS the rigorous EN 1997-1 Annex C closed-form (single
// consolidated method; no Coulomb-passive over-prediction, no coarse table). Returns the
// wall-normal (horizontal, for a vertical wall) coefficient K_p applied to sigma'_v, and
// (via *Kc) the C.8 cohesion coefficient K_pc = (Kn-1)·cot φ' — NOT 2√K_p. incl is set to 0
// because the returned force is already horizontal; the vertical drag R_p,v = R_p,h·tan δ
// is formed by the caller for the wall vertical-equilibrium check.
inline double passiveK(EpMethod /*method*/, double phi, double delta, double theta, double beta,
                       double* incl, double* Kc = nullptr, double* Kq = nullptr) {
  AnnexCK k = annexCPassive(phi, delta, beta, theta);
  if (incl) *incl = 0.0;
  if (Kc) *Kc = k.Kc;      // C.8 cohesion coefficient
  if (Kq) *Kq = k.Kq;      // C.7 surcharge coefficient (= Kgamma only when theta=0)
  return k.Kgamma;         // C.9 self-weight coefficient
}

// Resultants on one side of the wall over a vertical region, decomposed by action type
// so the partial-factor engine can factor each independently.
struct SideThrust {
  double soilN = 0;      // permanent earth-pressure resultant along its direction (kN/m)
  double soilZbar = 0;   // depth of soilN below region top (m)
  double surchN = 0;     // variable surcharge-induced resultant (kN/m)
  double surchZbar = 0;
  double waterN = 0;     // water thrust, horizontal (kN/m)
  double waterZbar = 0;
  double crackN = 0;     // hydrostatic thrust in tension crack, horizontal (kN/m)
  double crackZbar = 0;
  double crackDepth = 0; // tension-crack depth z0 below region top (m)
  double incl = 0;       // earth-pressure resultant inclination from horizontal (rad)
  double regionHeight = 0;
  // pressure ordinates for plotting (depth below region top, kPa)
  std::vector<double> plotZ, plotSoil, plotWater;
};

struct SideInput {
  const std::vector<Stratum>* strata;
  double surfaceEl;     // elevation where sigma'_v = 0 (retained/front surface)
  double regionTopEl;   // top of integration region (usually = surfaceEl)
  double regionBotEl;   // bottom of integration region
  double waterEl;       // water-table elevation on this side
  double surcharge;     // uniform variable surcharge q (kPa)
  EpMethod method;
  double delta;         // interface friction (rad) — active face, or fixed passive delta
  double passiveDeltaK; // if >0, PASSIVE delta is recomputed PER LAYER as k*phi'_d(cell)
  double theta;         // wall batter from vertical (rad)
  double beta;          // backfill slope (rad)
  bool isActive;
  bool assumeCrackWater;  // fill tension crack with water (active only)
  int nSteps;             // integration resolution
};

// O(N) downward march from surface to regionBot accumulating sigma'_v and resultants.
inline SideThrust integrateSide(const SideInput& in) {
  SideThrust out;
  const auto& strata = *in.strata;
  double H = in.regionTopEl - in.regionBotEl;
  out.regionHeight = std::max(H, 0.0);
  if (H <= 1e-9 || strata.empty()) return out;

  int N = std::max(in.nSteps, 50);
  double topMarch = in.surfaceEl;
  double dz = (in.surfaceEl - in.regionBotEl) / N;
  if (dz <= 0) return out;

  double sigmaV = 0.0;           // running effective vertical stress (kPa)
  double soilF = 0, soilM = 0;   // resultant + first moment (about region top)
  double surchF = 0, surchM = 0;
  double crackF = 0, crackM = 0;
  double z0 = 0.0;              // tension-crack depth (below region top)
  bool sawPositive = false;
  int plotEvery = std::max(N / 120, 1);
  int stepCount = 0;

  for (double el = in.surfaceEl - 0.5 * dz; el > in.regionBotEl - 1e-9; el -= dz, ++stepCount) {
    const Stratum& st = strata[stratumAt(strata, el)];
    bool submerged = (el < in.waterEl);
    double gammaEff = submerged ? (st.gammaSat - GAMMA_W) : st.gammaMoist;
    // sigma'_v at the CELL MIDPOINT (el is the midpoint); accumulate full cell after.
    double sigmaMid = sigmaV + 0.5 * gammaEff * dz;
    sigmaV += gammaEff * dz;  // running effective overburden to the cell bottom

    if (el > in.regionTopEl) continue;  // not yet in the integration region
    double depth = in.regionTopEl - el;  // below region top

    // Coefficient + cohesion term at this depth
    double incl = 0.0;
    double K, Kc, cohes, Kq;   // Kq = surcharge coefficient (Ka active, C.7 Kq passive)
    if (st.drained) {
      if (in.isActive) {
        K = activeK(in.method, st.phi, in.delta, in.theta, in.beta, &incl);
        Kc = 2.0 * std::sqrt(std::max(K, 0.0));   // active Kac (Rankine/Coulomb, zero adhesion)
        Kq = K;                                    // active surcharge uses Ka
      } else {
        // passive: Annex C gives K_p (C.9, horizontal), the C.8 cohesion coeff K_pc, and the
        // C.7 surcharge coeff K_q (which differs from K_p only on a battered face, theta>0).
        // delta is taken PER LAYER as k*phi'_d(cell) when passiveDeltaK>0 (consistent
        // wall-friction model across a layered front soil); otherwise the fixed in.delta.
        double dlt = (in.passiveDeltaK > 0.0) ? clampd(in.passiveDeltaK, 0.0, 1.0) * st.phi : in.delta;
        K = passiveK(in.method, st.phi, dlt, in.theta, in.beta, &incl, &Kc, &Kq);
      }
      cohes = st.c;
    } else {
      K = 1.0;  // undrained total-stress (phi_u = 0)
      cohes = st.cu;
      Kc = 2.0;
      Kq = 1.0;
      incl = 0.0;
    }
    out.incl = incl;

    // permanent earth pressure (effective for drained; for undrained use total sigma_v).
    // Active: K*sigma'_v - Kac*c' ; Passive: K*sigma'_v + Kpc*c' (cohesion adds passive).
    double pSoil;
    if (st.drained) {
      pSoil = in.isActive ? (K * sigmaMid - Kc * cohes) : (K * sigmaMid + Kc * cohes);
    } else {
      // undrained: sigma_a = sigma_v(total) - 2 cu ; sigma_p = sigma_v(total) + 2 cu
      double u = submerged ? GAMMA_W * (in.waterEl - el) : 0.0;
      double svTotal = sigmaMid + u;
      pSoil = in.isActive ? (svTotal - Kc * cohes) : (svTotal + Kc * cohes);
      // For undrained we fold water into pSoil (total stress); skip separate water below.
    }

    if (in.isActive) {
      if (pSoil < 0.0) {
        pSoil = 0.0;  // ignore tension above the crack depth
      } else if (!sawPositive) {
        sawPositive = true;
        z0 = depth;   // crossover depth = tension-crack depth
      }
    } else {
      if (pSoil < 0.0) pSoil = 0.0;
    }

    double dF = pSoil * dz;
    soilF += dF;
    soilM += dF * depth;

    // variable surcharge lateral pressure: Ka*q (active) or the Annex C.7 Kq*q (passive); K=1 undrained
    if (in.surcharge > 0.0) {
      double pS = Kq * in.surcharge;
      double dFs = pS * dz;
      surchF += dFs;
      surchM += dFs * depth;
    }

    // water (only for drained; undrained already folded into pSoil)
    if (st.drained && submerged) {
      double u = GAMMA_W * (in.waterEl - el);
      out.waterN += u * dz;            // accumulate; centroid computed after loop
      out.waterZbar += u * dz * depth;
    }

    if ((stepCount % plotEvery) == 0) {
      double u = (st.drained && submerged) ? GAMMA_W * (in.waterEl - el) : 0.0;
      out.plotZ.push_back(depth);
      out.plotSoil.push_back(pSoil);
      out.plotWater.push_back(u);
    }
  }

  out.soilN = soilF;
  out.soilZbar = (soilF > 1e-9) ? soilM / soilF : 0.5 * H;
  out.surchN = surchF;
  out.surchZbar = (surchF > 1e-9) ? surchM / surchF : 0.5 * H;
  if (out.waterN > 1e-9) out.waterZbar /= out.waterN;
  out.crackDepth = (z0 > 0.0) ? z0 : 0.0;

  // Active tension crack filled with water (§2.5) — hydrostatic over the DRY part of z0.
  // The "crack ponds rainwater" assumption only adds water above the ambient water table;
  // below it the phreatic thrust (waterN) already covers the same zone, so capping the
  // crack-water column to min(z0, depth-to-water) removes the double count. For an
  // undrained crack the pore pressure was discarded with the zeroed tension ordinate, so
  // the full z0 column is retained there (no overlap to remove).
  if (in.isActive && in.assumeCrackWater && out.crackDepth > 0.01) {
    double z0d = out.crackDepth;
    const Stratum& crackStr = strata[stratumAt(strata, in.regionTopEl - 0.5 * z0d)];
    double zc = z0d;
    if (crackStr.drained) {
      double dw = in.regionTopEl - in.waterEl;     // depth from region top down to water table
      if (dw < 0.0) dw = 0.0;
      zc = std::min(z0d, dw);
    }
    out.crackN = 0.5 * GAMMA_W * zc * zc;           // triangular hydrostatic in the dry crack
    out.crackZbar = (2.0 / 3.0) * zc;               // resultant at 2/3 of the wet-crack depth
  }
  return out;
}

// Convert characteristic strength to design via material factors (M-set).
inline double designPhi(double phiCharRad, double gPhi) {
  return std::atan(std::tan(phiCharRad) / gPhi);
}
inline double designC(double cChar, double gC) { return cChar / gC; }
inline double designCu(double cuChar, double gCu) { return cuChar / gCu; }

}  // namespace madep
