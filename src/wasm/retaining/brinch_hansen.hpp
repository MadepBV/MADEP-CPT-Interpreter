// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Brinch Hansen (1961) ultimate lateral resistance of a rigid pile — depth-dependent
// net pressure coefficients K_q(z/B) and K_c(z/B).
//
//   e(z) = q̄(z)·K_q(z) + c·K_c(z)            [kPa, net passive − active around one pile]
//   T_lat,max(z) = B·e(z)                    [kN/m of pile]
//
// Source: J. Brinch Hansen, "The ultimate resistance of rigid piles against transversal
// forces", Danish Geotechnical Institute Bulletin No. 12 (1961), pp. 5–9. The surface
// coefficients (K_q⁰, K_c⁰), the great-depth coefficients (K_q^∞, K_c^∞ via N_c, d_c^∞ and
// Jáky's K₀) and the rational interpolation with a_q, a_c are transcribed from the paper;
// the φ → 0 limits are the analytical limits of the same expressions. Verified against the
// worked tables in the course chapter (φ = 20.5°) and the MADEP Rekennota (φ = 25°, 19.733°).
//
// Angles in radians. This header is the single source of truth for the coefficients — the
// PLAXIS Embedded-Beam-Row T_lat tables and the soldier-pile hand calculation both use it.
#pragma once

#include <cmath>

namespace madep {

struct BrinchHansenConstants {
  double phi = 0;      // friction angle used (rad)
  double Pq = 1;       // passive overburden term at the surface (rough wall, translation)
  double KqA = 1;      // shallow active coefficient
  double Kq0 = 0;      // K_q at z/B = 0  (= Pq − KqA)
  double Kc0 = 0;      // K_c at z/B = 0  (= (Pq − 1)·cot φ)
  double K0 = 1;       // Jáky at-rest coefficient 1 − sin φ
  double dcInf = 1.58; // deep depth factor 1.58 + 4.09·tan⁴φ
  double Nq = 1;       // exp(π tan φ)·tan²(45° + φ/2)
  double Nc = 0;       // (Nq − 1)·cot φ
  double KcInf = 0;    // Nc·dcInf
  double KqInf = 0;    // KcInf·K0·tan φ
  double aq = 0;       // interpolation parameter for K_q
  double ac = 0;       // interpolation parameter for K_c
};

// φ below this threshold (≈ 0.006°) uses the analytical φ → 0 limits (undrained, φ_u = 0).
constexpr double BH_PHI_ZERO_RAD = 1e-4;

inline BrinchHansenConstants brinchHansenConstants(double phi) {
  const double PI_ = 3.14159265358979323846;
  BrinchHansenConstants k;
  k.phi = phi;
  if (phi < BH_PHI_ZERO_RAD) {
    // Limits for φ → 0 (Brinch Hansen 1961 §φ = 0; course chapter §3.7).
    k.Pq = 1.0; k.KqA = 1.0; k.Kq0 = 0.0;
    k.Kc0 = 1.0 + PI_ / 2.0;          // 2.5708
    k.K0 = 1.0; k.dcInf = 1.58;
    k.Nq = 1.0; k.Nc = PI_ + 2.0;     // 5.1416
    k.KcInf = k.Nc * k.dcInf;         // 8.1237
    k.KqInf = 0.0;
    k.aq = 0.0;                       // K_q ≡ 0
    k.ac = k.Kc0 / (k.KcInf - k.Kc0) * 2.0 * std::sin(PI_ / 4.0);  // 0.6547
    return k;
  }
  const double t = std::tan(phi), s = std::sin(phi), c = std::cos(phi);
  const double tp = std::tan(PI_ / 4.0 + phi / 2.0);   // tan(45° + φ/2)
  const double tm = std::tan(PI_ / 4.0 - phi / 2.0);   // tan(45° − φ/2)
  k.Pq = std::exp((PI_ / 2.0 + phi) * t) * c * tp;
  k.KqA = std::exp(-(PI_ / 2.0 - phi) * t) * c * tm;
  k.Kq0 = k.Pq - k.KqA;
  k.Kc0 = (k.Pq - 1.0) / t;
  k.K0 = 1.0 - s;
  k.dcInf = 1.58 + 4.09 * t * t * t * t;
  k.Nq = std::exp(PI_ * t) * tp * tp;
  k.Nc = (k.Nq - 1.0) / t;
  k.KcInf = k.Nc * k.dcInf;
  k.KqInf = k.KcInf * k.K0 * t;
  const double sp = std::sin(PI_ / 4.0 + phi / 2.0);
  k.aq = (k.KqInf > k.Kq0) ? k.Kq0 / (k.KqInf - k.Kq0) * k.K0 * s / sp : 0.0;
  k.ac = (k.KcInf > k.Kc0) ? k.Kc0 / (k.KcInf - k.Kc0) * 2.0 * sp : 0.0;
  return k;
}

// Rational interpolation between the surface and great-depth coefficients (ξ = z/B ≥ 0).
inline double brinchHansenKq(const BrinchHansenConstants& k, double xi) {
  if (xi < 0) xi = 0;
  return (k.Kq0 + k.KqInf * k.aq * xi) / (1.0 + k.aq * xi);
}
inline double brinchHansenKc(const BrinchHansenConstants& k, double xi) {
  if (xi < 0) xi = 0;
  return (k.Kc0 + k.KcInf * k.ac * xi) / (1.0 + k.ac * xi);
}

}  // namespace madep
