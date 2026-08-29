// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Embedded retaining-wall engine — orchestration. Runs the four Belgian design branches
// (embedded_branches.hpp) on the selected wall idealisation (embedded_model.hpp) with the shared
// limit-equilibrium solver (embedded_solver.hpp) and assembles the Eurocode verifications:
//
//   GEO  embedment  d_provided ≥ d_required = max(DA1/2, DA1/1) design embedment (Blum ×1.2 cantilever)
//   STR  M_Ed, V_Ed, T_Ed = envelope of DA1/2, DA1/1 and 1.35 × (BGT + α_ver)   (guideline §3.5)
//   HYD  heave / piping at the toe (continuous walls)
//   anchor pull-out (EN 1537 / EC7 Table A.12) and wall vertical screening (anchored continuous walls)
//   soldier piles: lagging pressure, PLAXIS EBR T_lat tables (characteristic / design / sensitivity)
//
// Every branch returns its full intermediate set (design strengths and coefficients per layer,
// pressures, d₀, d_design, T, M(z), V(z)) so the results can be reproduced by hand.
#pragma once

#include "embedded_model.hpp"
#include "embedded_solver.hpp"
#include "soldier_pile_wall.hpp"
#include "results.hpp"
#include <vector>
#include <string>
#include <cmath>

namespace madep {

struct AnchorConfig {
  double angleDeg = 20, fixedLen = 5, dia = 0.15, spacing = 2.0, tfk = 150, gammaA = 1.1;
};

struct EmbeddedInput {
  WallKind kind = WallKind::Continuous;
  EmbeddedGeometry geom;
  EmbeddedLoads loads;
  EmbeddedOptions opt;
  BranchSettings branches;
  AnchorConfig anchor;
  std::vector<Stratum> retained;  // characteristic
  std::vector<Stratum> front;     // characteristic
  bool materialOverrideForTlat = false;  // build the sensitivity T_lat table with branches.mOverride
};

struct LayerReport {
  double topEl = 0, phiKDeg = 0, phiDDeg = 0, cK = 0, cD = 0, cuK = 0, cuD = 0; bool drained = true;
  double Ka = 0, Kac = 0, Kp = 0, Kpc = 0, deltaPDeg = 0;
};

struct BranchResult {
  BranchSpec spec;
  double excavationEl = 0;
  double toeEl = 0;
  double dProvided = 0;       // below this branch's excavation
  double d0 = 0;              // free-earth depth
  double dDesign = 0;         // ×1.2 for a cantilever
  bool bracketed = true;
  double odfProvided = 0;
  double T = 0, Mmax = 0, yMmax = 0, Vmax = 0, yVmax = 0;
  double TEd = 0, MEd = 0, VEd = 0;   // × effectFactor
  double zNetZero = -1;
  bool closed = false;
  double pSurface = 0, pExcavation = 0, pToeBack = 0, pToeFront = 0;  // kPa design ordinates (factored, per unit width)
  LaggingPressure lagging;
  std::vector<LayerReport> back, front;
  DiagramSet diagrams;
};

struct EmbeddedResult {
  std::vector<CheckResult> checks;
  std::vector<BranchResult> branches;
  std::vector<TlatTable> tlat;
  std::vector<KV> summary;
  std::vector<std::string> notes;
  double overdigUls = 0;
  double requiredD = 0;  std::string requiredDCombo;
  double MEd = 0;        std::string MCombo;
  double VEd = 0;        std::string VCombo;
  double TEd = 0;        std::string TCombo;
  double pLaggingEd = 0; std::string laggingCombo;
  double anchorAxial = 0, anchorVertical = 0;
};

inline std::vector<LayerReport> layerReports(const std::vector<Stratum>& K, const std::vector<Stratum>& D,
                                             const std::vector<LayerCoefficients>& C) {
  std::vector<LayerReport> out;
  for (size_t i = 0; i < D.size(); ++i) {
    LayerReport r;
    r.topEl = D[i].topEl; r.phiKDeg = rad2deg(K[i].phi); r.phiDDeg = rad2deg(D[i].phi);
    r.cK = K[i].c; r.cD = D[i].c; r.cuK = K[i].cu; r.cuD = D[i].cu; r.drained = D[i].drained;
    r.Ka = C[i].Ka; r.Kac = C[i].Kac; r.Kp = C[i].Kp; r.Kpc = C[i].Kpc; r.deltaPDeg = rad2deg(C[i].deltaP);
    out.push_back(r);
  }
  return out;
}

inline EmbeddedResult analyzeEmbedded(const EmbeddedInput& in) {
  EmbeddedResult R;
  const EmbeddedGeometry& g = in.geom;
  const bool perPile = in.kind != WallKind::Continuous;
  const bool underWater = in.loads.waterFrontEl > g.excavationElNominal + 1e-6;
  const double hRule = g.anchored ? std::max(g.anchorEl - g.excavationElNominal, 0.0)
                                  : std::max(g.retainedSurfaceEl - g.excavationElNominal, 0.0);
  R.overdigUls = overdigFor(in.branches, hRule, underWater);
  const double toeEl = g.excavationElNominal - R.overdigUls - std::max(g.embedment, 0.05);

  std::vector<BranchSpec> specs = makeEmbeddedBranches(in.branches, R.overdigUls);
  EmbeddedGeometry gg = g;
  if (gg.anchored) {  // clamp the anchor into the wall
    const double hiEl = gg.retainedSurfaceEl - 0.1;
    const double loEl = std::min(toeEl + 0.2, hiEl - 0.1);
    const double cl = std::min(std::max(gg.anchorEl, loEl), hiEl);
    if (cl != gg.anchorEl) { gg.anchorEl = cl; R.notes.push_back("Anchor level was outside the wall and has been clamped into the pile; review the anchor depth."); }
  }

  for (const BranchSpec& spec : specs) {
    EmbeddedModel m;
    m.build(in.kind, gg, in.retained, in.front, in.loads, in.opt, spec);
    BranchResult br;
    br.spec = spec;
    br.excavationEl = m.excavationEl;
    br.toeEl = toeEl;
    br.dProvided = m.excavationEl - toeEl;
    EmbedRoot root = freeEarthEmbedment(m);
    br.d0 = root.d0; br.bracketed = root.bracketed;
    br.dDesign = gg.anchored ? root.d0 : 1.2 * root.d0;
    br.odfProvided = odfAt(m, br.dProvided);
    br.T = supportReaction(m, root.d0);
    const double dClose = (gg.retainedSurfaceEl - m.excavationEl) + root.d0;
    br.diagrams = buildDiagrams(m, toeEl, br.T, dClose);
    br.Mmax = br.diagrams.Mmax; br.yMmax = br.diagrams.yMmax;
    br.Vmax = br.diagrams.Vmax; br.yVmax = br.diagrams.yVmax;
    br.zNetZero = br.diagrams.zNetZero; br.closed = br.diagrams.closed;
    br.TEd = br.T * spec.effectFactor; br.MEd = br.Mmax * spec.effectFactor; br.VEd = br.Vmax * spec.effectFactor;
    {
      EmbeddedModel::FaceOrd s0 = m.activeOrdinate(gg.retainedSurfaceEl - 1e-6);
      EmbeddedModel::FaceOrd s1 = m.activeOrdinate(m.excavationEl + 1e-6);
      EmbeddedModel::FaceOrd s2 = m.activeOrdinate(toeEl + 1e-6);
      EmbeddedModel::PassOrd p2 = m.passiveOrdinate(toeEl + 1e-6);
      // factored (design) ordinates of this branch, per unit width
      br.pSurface = spec.gG * (s0.pEarth + s0.u) + spec.gQ * s0.pSurch;
      br.pExcavation = spec.gG * (s1.pEarth + s1.u) + spec.gQ * s1.pSurch;
      br.pToeBack = spec.gG * (s2.pEarth + s2.u) + spec.gQ * s2.pSurch;
      br.pToeFront = spec.gGResist * (p2.p + p2.u);
    }
    if (perPile) br.lagging = laggingPressureAt(m);
    br.back = layerReports(in.retained, m.backD, m.backK);
    br.front = layerReports(in.front, m.frontD, m.frontK);
    R.branches.push_back(br);
  }

  // ---- GEO embedment: DA1/2 (and DA1/1 with the generic EN/ANB sets) ----
  const BranchResult* gov = nullptr;
  for (const BranchResult& b : R.branches) {
    if (!b.spec.governsEmbedment) continue;
    if (!gov || b.dDesign > gov->dDesign) gov = &b;
  }
  if (gov) {
    R.requiredD = gov->dDesign; R.requiredDCombo = gov->spec.id;
    CheckResult cr;
    cr.id = "embedment";
    cr.label = perPile ? (gg.anchored ? "Embedment / rotational stability (anchored soldier pile, free-earth)"
                                       : "Embedment / rotational stability (soldier pile, Blum)")
                       : (gg.anchored ? "Embedment / rotational stability (anchored, free-earth)"
                                       : "Embedment / rotational stability (cantilever, Blum)");
    cr.combo = gov->spec.id; cr.comboLabel = gov->spec.label;
    cr.verb = "d_provided >= d_required"; cr.unit = "m";
    cr.setFromEdRd(R.requiredD, std::max(g.embedment, 1e-6));
    cr.extra.push_back({"ODF_at_provided", gov->odfProvided, "-"});
    cr.extra.push_back({"d_provided", g.embedment, "m"});
    cr.extra.push_back({"d_required", R.requiredD, "m"});
    cr.extra.push_back({"d_free_earth", gov->d0, "m"});
    cr.extra.push_back({"overdig", R.overdigUls, "m"});
    if (!gov->bracketed) cr.note = "No equilibrium found within 40 m of embedment — the wall cannot be stabilised by embedment alone with these inputs.";
    R.checks.push_back(cr);
  }

  // ---- STR envelope ----
  for (const BranchResult& b : R.branches) {
    if (b.spec.id == "SLS") continue;
    if (b.MEd > R.MEd) { R.MEd = b.MEd; R.MCombo = b.spec.id; }
    if (b.VEd > R.VEd) { R.VEd = b.VEd; R.VCombo = b.spec.id; }
    if (b.TEd > R.TEd) { R.TEd = b.TEd; R.TCombo = b.spec.id; }
    if (b.lagging.total > R.pLaggingEd) { R.pLaggingEd = b.lagging.total; R.laggingCombo = b.spec.id; }
  }

  // ---- HYD heave / piping (continuous walls) ----
  if (!perPile) {
    const double dProv = std::max(g.embedment, 0.0) + R.overdigUls;  // below the nominal excavation
    const bool hasRetWater = in.loads.waterRetainedEl > -100.0;
    const double frontExitEl = std::max(in.loads.waterFrontEl, g.excavationElNominal - R.overdigUls);
    const double dh = hasRetWater ? std::max(in.loads.waterRetainedEl - frontExitEl, 0.0) : 0.0;
    const double dSeep = g.excavationElNominal - R.overdigUls - toeEl;
    Combination hyd = makeHYD();
    Stratum ft = in.front.empty() ? Stratum{toeEl, 18, 20, deg2rad(30), 0, 0, true, 0}
                                  : in.front[(size_t)stratumAt(in.front, toeEl + 0.01)];
    double gPrime = ft.gammaSat - GAMMA_W; if (gPrime < 1.0) gPrime = 1.0;
    const bool active = (dh > 1e-3) && (dSeep > 0.05);
    const double udst = active ? GAMMA_W * dh : 0.0;
    const double sstb = gPrime * dSeep;
    CheckResult ch;
    ch.id = "heave"; ch.label = "Hydraulic heave / piping (HYD)";
    ch.combo = hyd.id; ch.comboLabel = hyd.label; ch.verb = "u_dst <= sigma'_stb"; ch.unit = "kPa";
    ch.setFromEdRd(hyd.gG_dst * udst, hyd.gG_stb * sstb);
    ch.extra.push_back({"delta_h", dh, "m"});
    ch.extra.push_back({"embedment", dSeep, "m"});
    ch.extra.push_back({"i_exit", active ? dh / dSeep : 0.0, "-"});
    ch.extra.push_back({"i_crit", gPrime / GAMMA_W, "-"});
    ch.note = "Conservative exit gradient: the whole differential head is dissipated over the downstream embedment (no upstream seepage-path credit). Confirm with a flow net for stratified ground.";
    R.checks.push_back(ch);
    (void)dProv;
  }

  // ---- anchor pull-out + wall vertical screening ----
  if (gg.anchored) {
    const double ang = in.anchor.angleDeg * PI / 180.0;
    double cosA = std::cos(ang); if (cosA < 0.2) cosA = 0.2;
    const double sA = std::max(in.anchor.spacing, 0.1);
    const double TperM = perPile ? R.TEd / std::max(g.spacingS, 0.1) : R.TEd;   // kN per metre of wall
    const double T_axial = TperM / cosA * sA;
    const double V_anchor = TperM * std::tan(ang);
    const double Rak = PI * in.anchor.dia * in.anchor.fixedLen * in.anchor.tfk;
    const double gA = std::max(in.anchor.gammaA, 1.0);
    const double Rad = Rak / gA;
    R.anchorAxial = T_axial; R.anchorVertical = V_anchor;
    CheckResult ca;
    ca.id = "anchor_pullout"; ca.label = "Ground-anchor pull-out (EN 1537, per anchor)";
    ca.combo = R.TCombo; ca.comboLabel = "STR envelope (R4 anchor resistance)";
    ca.verb = "T_d <= R_a,d"; ca.unit = "kN";
    ca.setFromEdRd(T_axial, Rad);
    ca.extra.push_back({"T_axial", T_axial, "kN"});
    ca.extra.push_back({"R_ak", Rak, "kN"});
    ca.extra.push_back({"R_ad", Rad, "kN"});
    ca.extra.push_back({"gamma_a", gA, "-"});
    ca.extra.push_back({"spacing", sA, "m"});
    ca.extra.push_back({"V_vert_on_wall", V_anchor, "kN/m"});
    ca.note = "R_ak = pi*D*L_fixed*tau is a CALCULATED (untested) grout-body bond. EN 1997-1 Table A.12 gives gamma_a = 1.1 for anchorages; it presumes a proof-tested R_ak — until EN 1537 acceptance tests confirm the bond, treat R_ak as preliminary (model factor / reduced tau).";
    R.checks.push_back(ca);

    if (!perPile) {
      const double dProv = g.excavationElNominal - R.overdigUls - toeEl;
      MaterialFactors m1 = M1();
      std::vector<Stratum> frontD = designProfile(in.front, m1);
      double Rv = 0.0, sig = 0.0; const int Nz = 100; const double dz = dProv / Nz;
      const double exc = g.excavationElNominal - R.overdigUls;
      for (double el = exc - 0.5 * dz; el > toeEl && dz > 0; el -= dz) {
        const Stratum& st = frontD[(size_t)stratumAt(frontD, el)];
        const bool sub = el < in.loads.waterFrontEl;
        sig += (sub ? (st.gammaSat - GAMMA_W) : st.gammaMoist) * dz;
        const double k0 = 1.0 - std::sin(st.phi);
        Rv += 2.0 * k0 * sig * std::tan((2.0 / 3.0) * st.phi) * dz;
      }
      CheckResult cv;
      cv.id = "wall_vertical"; cv.label = "Wall vertical equilibrium (anchor down-drag)";
      cv.combo = R.TCombo; cv.comboLabel = "screening — confirm against the section";
      cv.verb = "V_anchor <= R_v,shaft"; cv.unit = "kN/m";
      cv.setFromEdRd(V_anchor, Rv);
      cv.extra.push_back({"V_anchor", V_anchor, "kN/m"});
      cv.extra.push_back({"R_v_shaft", Rv, "kN/m"});
      cv.note = "Screening estimate: embedded shaft friction only (K0*sigma'_v*tan(2/3 phi'), both faces); base resistance and wall self-weight neglected.";
      R.checks.push_back(cv);
    }
  }

  // ---- soldier piles: PLAXIS EBR T_lat tables ----
  if (perPile) {
    struct Set { const char* id; const char* label; MaterialFactors m; };
    std::vector<Set> sets;
    sets.push_back({"characteristic", "Characteristic (M1) — staged/SLS phases and phi-c reduction", M1()});
    for (const BranchSpec& s : specs) if (s.id == "DA1-2") { sets.push_back({"design", "Design (M2 of the risk class) — explicit DA1/2 plastic phase", s.m}); }
    if (in.materialOverrideForTlat) sets.push_back({"sensitivity", "Sensitivity (user strength reduction)", in.branches.mOverride});
    for (const Set& s : sets) {
      BranchSpec ps; ps.id = s.id; ps.label = s.label; ps.gG = 1; ps.gQ = 1; ps.m = s.m; ps.overdig = R.overdigUls;
      EmbeddedModel m;
      m.build(WallKind::SoldierBrinchHansen, gg, in.retained, in.front, in.loads, in.opt, ps);
      R.tlat.push_back(buildTlatTable(m, toeEl, s.id, s.label));
    }
    if (in.loads.waterRetainedEl > g.excavationElNominal - R.overdigUls && !gg.laggingWatertight) {
      R.notes.push_back("Retained water table above the excavation with permeable lagging: no water pressure is applied to the wall, which presumes free drainage through the lagging and a dewatered pit. This is a binding execution condition (Rekennota §8.1).");
    }
    R.notes.push_back(in.kind == WallKind::SoldierEffWidth
      ? "Hand calculation below the excavation: active on the flange width b, passive on b_eff = min(k*b, s) with the plane-strain K_p (EAB / Belgian guideline §5). The PLAXIS T_lat tables use Brinch Hansen with B = b; the two models are never mixed."
      : "Hand calculation below the excavation: Brinch Hansen net line resistance B*[e_w]+ with the Andersen-Lodahl retained-height term, capped by the continuous-wall tributary resistance. The net coefficient cannot separate active from passive: DA1/1 factoring is applied to the retained-side load above the excavation only.");
  }

  R.summary.push_back({"M_Ed", R.MEd, perPile ? "kNm/pile" : "kNm/m"});
  R.summary.push_back({"V_Ed", R.VEd, perPile ? "kN/pile" : "kN/m"});
  R.summary.push_back({"d_required", R.requiredD, "m"});
  if (gg.anchored) R.summary.push_back({"T_Ed", R.TEd, perPile ? "kN/pile" : "kN/m"});
  R.notes.push_back(std::string("Partial factors: ") + schemeLabel(in.branches.riskScheme) + ". Embedment from the design excavation (nominal - " +
                    std::to_string((int)std::round(R.overdigUls * 100)) + " cm over-excavation); section forces enveloped over DA1/2, DA1/1 and 1.35 x (BGT + alpha_ver).");
  if (in.loads.waterRetainedEl > in.loads.waterFrontEl + 0.01 && !perPile) {
    R.notes.push_back("Differential water head: pore pressures are hydrostatic on each face with no seepage modelling (EN 1997-1 9.3.1.6). Seepage around the toe reduces the front passive resistance — use a flow net / FE seepage where the head difference is significant.");
  }
  return R;
}

}  // namespace madep
