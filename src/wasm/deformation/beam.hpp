// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two-node Timoshenko beam element for embedded retaining walls.
//
// Local axis s follows the station order from wall top to wall tip. For
// the Phase-1 vertical-wall contract this is s=(0,-1), n=(+1,0), z out of
// plane. The element is perfectly bonded to the soil translations at its
// mesh nodes and contributes one independent drilling/section rotation
// DOF θ_z per wall node.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>

#include "types.hpp"

namespace madep::beam {

inline bool valid_beam_element(const BeamElementCache& el) {
  return el.length > 1e-9 &&
      std::isfinite(el.EA) && el.EA > 0.0 &&
      std::isfinite(el.EI) && el.EI > 0.0 &&
      std::isfinite(el.GA) && el.GA > 0.0 &&
      std::isfinite(el.kappa) && el.kappa > 0.0;
}

inline void local_timoshenko_stiffness(
    double L,
    double EA,
    double EI,
    double GA,
    double kappa,
    std::array<double, 36>& k) {
  k.fill(0.0);
  if (!(L > 1e-9)) return;
  const double axial = EA / L;
  k[0 * 6 + 0] += axial;
  k[0 * 6 + 3] -= axial;
  k[3 * 6 + 0] -= axial;
  k[3 * 6 + 3] += axial;

  const double bend = EI / L;
  k[2 * 6 + 2] += bend;
  k[2 * 6 + 5] -= bend;
  k[5 * 6 + 2] -= bend;
  k[5 * 6 + 5] += bend;

  // Selective reduced integration for the Timoshenko shear strain
  // gamma = dw/ds - theta at the element midpoint:
  // B_s = [0, -1/L, -1/2, 0, +1/L, -1/2].
  // K_s = kappa * GA * L * B_s^T * B_s.
  const double kGA_L = std::max(kappa * GA, 1e-30) / L;
  const double h = 0.5 * L;
  k[1 * 6 + 1] += kGA_L;
  k[1 * 6 + 2] += kGA_L * h;
  k[1 * 6 + 4] -= kGA_L;
  k[1 * 6 + 5] += kGA_L * h;

  k[2 * 6 + 1] += kGA_L * h;
  k[2 * 6 + 2] += kGA_L * h * h;
  k[2 * 6 + 4] -= kGA_L * h;
  k[2 * 6 + 5] += kGA_L * h * h;

  k[4 * 6 + 1] -= kGA_L;
  k[4 * 6 + 2] -= kGA_L * h;
  k[4 * 6 + 4] += kGA_L;
  k[4 * 6 + 5] -= kGA_L * h;

  k[5 * 6 + 1] += kGA_L * h;
  k[5 * 6 + 2] += kGA_L * h * h;
  k[5 * 6 + 4] -= kGA_L * h;
  k[5 * 6 + 5] += kGA_L * h * h;
}

inline void transformation_global_to_local(const BeamElementCache& el, std::array<double, 36>& T) {
  T.fill(0.0);
  const double dx = el.xB - el.xA;
  const double dy = el.yB - el.yA;
  const double invL = el.length > 1e-30 ? 1.0 / el.length : 0.0;
  const double sx = dx * invL;
  const double sy = dy * invL;
  const double nx = -sy;
  const double ny = sx;

  T[0 * 6 + 0] = sx; T[0 * 6 + 1] = sy;
  T[1 * 6 + 0] = nx; T[1 * 6 + 1] = ny;
  T[2 * 6 + 2] = 1.0;
  T[3 * 6 + 3] = sx; T[3 * 6 + 4] = sy;
  T[4 * 6 + 3] = nx; T[4 * 6 + 4] = ny;
  T[5 * 6 + 5] = 1.0;
}

inline void element_stiffness(const BeamElementCache& el, double* out36) {
  for (int i = 0; i < 36; ++i) out36[i] = 0.0;
  if (!valid_beam_element(el)) return;

  std::array<double, 36> kLocal{};
  std::array<double, 36> T{};
  std::array<double, 36> temp{};
  local_timoshenko_stiffness(el.length, el.EA, el.EI, el.GA, el.kappa, kLocal);
  transformation_global_to_local(el, T);

  // temp = k_local * T
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      double s = 0.0;
      for (int k = 0; k < 6; ++k) s += kLocal[i * 6 + k] * T[k * 6 + j];
      temp[i * 6 + j] = s;
    }
  }
  // K_global = T^T * k_local * T
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) {
      double s = 0.0;
      for (int k = 0; k < 6; ++k) s += T[k * 6 + i] * temp[k * 6 + j];
      out36[i * 6 + j] = s;
    }
  }
}

inline void element_internal_force(
    const BeamElementCache& el,
    const double* U_global,
    const double* U_base,
    double* out6,
    const double* U_reference = nullptr) {
  for (int i = 0; i < 6; ++i) out6[i] = 0.0;
  double Ke[36]{};
  element_stiffness(el, Ke);
  double ue[6]{};
  for (int i = 0; i < 6; ++i) {
    const std::int32_t dof = el.dofs[static_cast<std::size_t>(i)];
    ue[i] = U_global[dof] + (U_base ? U_base[dof] : 0.0) -
        (U_reference ? U_reference[dof] : 0.0);
  }
  for (int i = 0; i < 6; ++i) {
    double s = 0.0;
    for (int j = 0; j < 6; ++j) s += Ke[i * 6 + j] * ue[j];
    out6[i] = s;
  }
}

inline void local_end_forces(
    const BeamElementCache& el,
    const double* U_global,
    const double* U_base,
    double* out6,
    const double* U_reference = nullptr) {
  for (int i = 0; i < 6; ++i) out6[i] = 0.0;
  if (!valid_beam_element(el)) return;
  std::array<double, 36> kLocal{};
  std::array<double, 36> T{};
  local_timoshenko_stiffness(el.length, el.EA, el.EI, el.GA, el.kappa, kLocal);
  transformation_global_to_local(el, T);
  double ug[6]{};
  double ul[6]{};
  for (int i = 0; i < 6; ++i) {
    const std::int32_t dof = el.dofs[static_cast<std::size_t>(i)];
    ug[i] = U_global[dof] + (U_base ? U_base[dof] : 0.0) -
        (U_reference ? U_reference[dof] : 0.0);
  }
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) ul[i] += T[i * 6 + j] * ug[j];
  }
  for (int i = 0; i < 6; ++i) {
    for (int j = 0; j < 6; ++j) out6[i] += kLocal[i * 6 + j] * ul[j];
  }
}

}  // namespace madep::beam
