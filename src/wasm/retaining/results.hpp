// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared result structures for the retaining-wall engine. A CheckResult is one
// Eurocode verification (E_d <= R_d, or EQU E_dst <= E_stb). The engine evaluates
// every check for every applicable combination and keeps the governing (worst) one.
#pragma once

#include <string>
#include <vector>
#include <utility>
#include <cmath>

namespace madep {

struct KV {
  std::string key;
  double value;
  std::string unit;
};

struct CheckResult {
  std::string id;       // "sliding", "bearing", "eccentricity", "overturning", ...
  std::string label;    // human label
  std::string combo;    // governing combination id ("C1"/"C2"/"EQU"/...)
  std::string comboLabel;
  std::string verb;     // "E_d <= R_d" or "E_dst <= E_stb" or "ODF >= 1"
  double Ed = 0;        // demand / destabilising
  double Rd = 0;        // resistance / stabilising
  std::string unit;     // unit of Ed/Rd
  double util = 0;      // utilisation Ed/Rd (>1 fails); for ODF we store Ed/Rd too
  bool pass = true;
  std::vector<KV> extra;  // labelled supporting numbers
  std::string note;

  void setFromEdRd(double ed, double rd) {
    Ed = ed; Rd = rd;
    util = (rd > 1e-12) ? ed / rd : (ed > 0 ? 1e9 : 0.0);
    pass = util <= 1.0 + 1e-9;
  }
};

// Keep the more onerous of two evaluations of the same check.
inline void keepWorst(CheckResult& acc, const CheckResult& cand, bool& seeded) {
  if (!seeded || cand.util > acc.util) { acc = cand; seeded = true; }
}

// A polyline series for plotting (depth below region top vs value).
struct Series {
  std::string id;
  std::string label;
  std::string unit;
  std::vector<double> z;   // depth (m) below reference
  std::vector<double> v;   // value
};

struct EngineOutput {
  bool ok = true;
  std::string error;
  std::string wallType;
  std::vector<CheckResult> checks;
  std::vector<Series> diagrams;
  std::vector<KV> summary;      // headline numbers (B, e_max, governing util, etc.)
  std::vector<std::string> notes;
  double maxUtil = 0;
  bool overallPass = true;
};

}  // namespace madep
