// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WASM entry point for the Eurocode-7 retaining-wall engine. Speaks JSON on both
// ends: JS passes a request JSON (pointer + length), the engine returns a malloc'd
// null-terminated JSON result string. Single translation unit (pulls all headers),
// mirroring the deformation module build. No exceptions / no RTTI.
#include "json.hpp"
#include "earth_pressure.hpp"
#include "factors.hpp"
#include "results.hpp"
#include "gravity_wall.hpp"
#include "embedded_wall.hpp"

#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define WASM_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define WASM_EXPORT extern "C"
#endif

using namespace madep;

static std::string g_lastError;

// ----------------------------- request parsing -----------------------------
static Stratum parseStratum(const JsonValue& v) {
  Stratum s;
  s.topEl = v.getNum("topEl", 0.0);
  s.gammaMoist = v.getNum("gammaMoist", 18.0);
  s.gammaSat = v.getNum("gammaSat", s.gammaMoist + 2.0);
  s.phi = deg2rad(v.getNum("phi", 30.0));        // input degrees
  s.c = v.getNum("c", 0.0);
  s.cu = v.getNum("cu", 0.0);
  s.drained = v.getBool("drained", true);
  s.qc = v.getNum("qc", 0.0);   // CPT cone resistance (kPa) for the De Beer bearing method
  return s;
}
static std::vector<Stratum> parseStrata(const JsonValue* arr) {
  std::vector<Stratum> out;
  if (!arr || arr->type != JsonType::Array) return out;
  for (const auto& e : arr->arr) out.push_back(parseStratum(e));
  // keep sorted top -> down (descending topEl) for stratumAt()
  for (size_t i = 1; i < out.size(); ++i) {
    Stratum key = out[i]; size_t j = i;
    while (j > 0 && out[j - 1].topEl < key.topEl) { out[j] = out[j - 1]; --j; }
    out[j] = key;
  }
  return out;
}
// Earth-pressure method is no longer user-selectable: it is auto-derived from geometry
// (Coulomb on the real inclined back face for a mass-gravity wall, Rankine on the vertical
// virtual plane otherwise) and passive is ALWAYS the EN 1997-1 Annex C closed form. The
// legacy parseMethod() dispatcher was removed in the method-consolidation pass.

// ----------------------------- serialization -----------------------------
static void writeKV(JsonWriter& w, const KV& kv) {
  w.beginObject();
  w.str("key", kv.key);
  w.num("value", kv.value);
  w.str("unit", kv.unit);
  w.endObject();
}
static void writeCheck(JsonWriter& w, const CheckResult& c) {
  w.beginObject();
  w.str("id", c.id);
  w.str("label", c.label);
  w.str("combo", c.combo);
  w.str("comboLabel", c.comboLabel);
  w.str("verb", c.verb);
  w.num("Ed", c.Ed);
  w.num("Rd", c.Rd);
  w.str("unit", c.unit);
  w.num("util", c.util);
  w.boolean("pass", c.pass);
  w.str("note", c.note);
  w.beginArray("extra");
  for (const auto& kv : c.extra) writeKV(w, kv);
  w.endArray();
  w.endObject();
}
static void writeSeries(JsonWriter& w, const Series& s) {
  w.beginObject();
  w.str("id", s.id);
  w.str("label", s.label);
  w.str("unit", s.unit);
  w.beginArray("z");
  for (double z : s.z) w.value(z);
  w.endArray();
  w.beginArray("v");
  for (double v : s.v) w.value(v);
  w.endArray();
  w.endObject();
}

static char* dupString(const std::string& s) {
  char* out = (char*)std::malloc(s.size() + 1);
  if (!out) return nullptr;
  std::memcpy(out, s.data(), s.size());
  out[s.size()] = '\0';
  return out;
}

static char* errorResult(const std::string& msg) {
  g_lastError = msg;
  JsonWriter w;
  w.beginObject();
  w.boolean("ok", false);
  w.str("error", msg);
  w.endObject();
  return dupString(w.take());
}

// ----------------------------- engines -----------------------------
static char* runGravity(const JsonValue& req, bool isGravity) {
  const JsonValue* gj = req.getObj("geom");
  if (!gj) return errorResult("missing geom");
  GravityInput in;
  GravityGeom& g = in.geom;
  g.toe = gj->getNum("toe", 0.8);
  g.heel = gj->getNum("heel", 1.5);
  g.stemThkTop = gj->getNum("stemThkTop", 0.3);
  g.stemThkBot = gj->getNum("stemThkBot", 0.4);
  g.stemHeight = gj->getNum("stemHeight", 4.0);
  g.baseThk = gj->getNum("baseThk", 0.5);
  g.keyDepth = gj->getNum("keyDepth", 0.0);
  g.keyThk = gj->getNum("keyThk", 0.0);
  g.gammaConc = gj->getNum("gammaConc", 24.0);
  g.beta = deg2rad(gj->getNum("betaDeg", 0.0));
  g.backBatter = deg2rad(gj->getNum("backBatterDeg", 0.0));
  g.frontSoilEl = gj->getNum("frontSoilEl", 0.0);
  g.isGravity = isGravity;

  const JsonValue* bf = req.getObj("backfill");
  in.backfill = bf ? parseStratum(*bf) : Stratum{0, 18, 20, deg2rad(30), 0, 0, true};
  in.insitu = parseStrata(req.getArr("insitu"));
  if (in.insitu.empty()) in.insitu.push_back(Stratum{0, 19, 21, deg2rad(32), 0, 0, true});

  const JsonValue* water = req.getObj("water");
  in.waterRetainedEl = water ? water->getNum("retained", -1000.0) : -1000.0;
  in.waterFrontEl = water ? water->getNum("front", -1000.0) : -1000.0;
  in.surcharge = req.getNum("surcharge", 0.0);

  const JsonValue* sj = req.getObj("settings");
  GravitySettings& s = in.s;
  // Active method auto-selected by geometry (Coulomb back face for gravity, Rankine virtual
  // plane for cantilever); passive always EN 1997-1 Annex C. Not user-selectable.
  s.activeMethod = isGravity ? EpMethod::Coulomb : EpMethod::Rankine;
  s.deltaActiveRatio = 0.667;
  s.deltaBaseRatio = 1.0;
  s.baseAdhesion = 0.0;
  s.passiveToe = true;
  s.passiveDeltaRatio = 0.667;   // delta_p = 2/3·φ'_d on the passive face (EN 1993-5)
  s.assumeCrackWater = true;
  s.bearingMethod = 0;           // 0 = EN 1997-1 Annex D (c-phi); 1 = De Beer CPT-direct
  s.bearingDepthFactors = true;  // include Brinch-Hansen/Vesic depth factors (opt-in refinement)
  s.consequenceClass = 2;
  s.riskScheme = 0;
  s.nSteps = 1200;
  if (sj) {
    s.deltaActiveRatio = sj->getNum("deltaActiveRatio", s.deltaActiveRatio);
    s.deltaBaseRatio = sj->getNum("deltaBaseRatio", s.deltaBaseRatio);
    s.baseAdhesion = sj->getNum("baseAdhesion", 0.0);
    s.passiveToe = sj->getBool("passiveToe", true);
    s.passiveDeltaRatio = sj->getNum("passiveDeltaRatio", s.passiveDeltaRatio);
    s.assumeCrackWater = sj->getBool("assumeCrackWater", true);
    std::string bm = sj->getStr("bearingMethod", "annexd");
    s.bearingMethod = (bm == "debeer" || bm == "cpt") ? 1 : 0;
    s.bearingDepthFactors = sj->getBool("bearingDepthFactors", true);
    s.consequenceClass = (int)sj->getNum("consequenceClass", 2);
    s.riskScheme = (int)sj->getNum("riskScheme", 0);
  }

  GravityResult R = analyzeGravity(in);

  double maxUtil = 0; bool overall = true;
  for (auto& c : R.checks) { if (c.util > maxUtil) maxUtil = c.util; if (!c.pass) overall = false; }

  JsonWriter w;
  w.beginObject();
  w.boolean("ok", true);
  w.str("wallType", isGravity ? "gravity" : "cantilever");
  w.beginArray("checks");
  for (auto& c : R.checks) writeCheck(w, c);
  w.endArray();
  w.beginArray("diagrams");
  for (auto& d : R.diagrams) writeSeries(w, d);
  w.endArray();
  w.beginArray("summary");
  for (auto& kv : R.summary) writeKV(w, kv);
  w.endArray();
  w.beginObject("structural");
  w.beginObject("stem"); w.num("M", R.M_stem); w.num("V", R.V_stem); w.str("combo", R.strComboStem); w.endObject();
  w.beginObject("toe"); w.num("M", R.M_toe); w.num("V", R.V_toe); w.str("combo", R.strComboToe); w.endObject();
  w.beginObject("heel"); w.num("M", R.M_heel); w.num("V", R.V_heel); w.str("combo", R.strComboHeel); w.endObject();
  w.endObject();
  w.num("B", in.geom.B());
  w.num("maxUtil", maxUtil);
  w.boolean("overallPass", overall);
  w.beginArray("notes");
  for (auto& n : R.notes) w.value(n.c_str());
  w.endArray();
  w.endObject();
  return dupString(w.take());
}

static char* runEmbedded(const JsonValue& req, bool anchored) {
  const JsonValue* gj = req.getObj("geom");
  if (!gj) return errorResult("missing geom");
  EmbeddedInput in;
  EmbeddedGeom& g = in.geom;
  g.retainedSurfaceEl = gj->getNum("retainedSurfaceEl", 6.0);
  g.excavationEl = gj->getNum("excavationEl", 0.0);
  g.embedment = gj->getNum("embedment", 3.0);
  g.anchored = anchored;
  g.anchorEl = gj->getNum("anchorEl", g.retainedSurfaceEl - 1.5);
  g.anchorAngleDeg = gj->getNum("anchorAngleDeg", 20.0);
  g.anchorFixedLen = gj->getNum("anchorFixedLen", 5.0);
  g.anchorDia = gj->getNum("anchorDia", 0.15);
  g.anchorSpacing = gj->getNum("anchorSpacing", 2.0);
  g.anchorTfk = gj->getNum("anchorTfk", 150.0);
  g.anchorGammaA = gj->getNum("anchorGammaA", 1.1);
  // (anchorGammaA configurable; default Buildwise ~1.1 — see the check note re EN R4 1.5-1.6)

  in.retained = parseStrata(req.getArr("retained"));
  if (in.retained.empty()) in.retained = parseStrata(req.getArr("insitu"));
  if (in.retained.empty()) in.retained.push_back(Stratum{g.retainedSurfaceEl, 18, 20, deg2rad(30), 0, 0, true});
  in.front = parseStrata(req.getArr("front"));
  if (in.front.empty()) in.front = in.retained;

  const JsonValue* water = req.getObj("water");
  in.waterRetainedEl = water ? water->getNum("retained", -1000.0) : -1000.0;
  in.waterFrontEl = water ? water->getNum("front", -1000.0) : -1000.0;
  in.surcharge = req.getNum("surcharge", 0.0);

  const JsonValue* sj = req.getObj("settings");
  EmbeddedSettings& s = in.s;
  // Active method is Rankine on the vertical wall; passive is always EN 1997-1 Annex C.
  // Not user-selectable (method consolidation).
  s.activeMethod = EpMethod::Rankine;
  s.deltaActiveRatio = 0.667;
  s.deltaPassiveRatio = 0.667;   // delta_p = 2/3·φ'_d on the passive face (EN 1993-5)
  s.assumeCrackWater = true;
  s.overdig = 0.0;
  s.minSurcharge = 0.0;
  s.consequenceClass = 2;
  s.riskScheme = 0;
  s.nSteps = 1200;
  if (sj) {
    s.deltaActiveRatio = sj->getNum("deltaActiveRatio", s.deltaActiveRatio);
    s.deltaPassiveRatio = sj->getNum("deltaPassiveRatio", s.deltaPassiveRatio);
    s.assumeCrackWater = sj->getBool("assumeCrackWater", true);
    s.overdig = sj->getNum("overdig", 0.0);
    s.minSurcharge = sj->getNum("minSurcharge", 0.0);
    s.consequenceClass = (int)sj->getNum("consequenceClass", 2);
    s.riskScheme = (int)sj->getNum("riskScheme", 0);
  }
  // The engine now OWNS the over-dig (analyzeEmbedded lowers excavationEl by s.overdig), so
  // the UI must pass settings.overdig and NOT pre-lower the excavation level itself.
  EmbeddedResult R = analyzeEmbedded(in);
  double maxUtil = 0; bool overall = true;
  for (auto& c : R.checks) { if (c.util > maxUtil) maxUtil = c.util; if (!c.pass) overall = false; }

  JsonWriter w;
  w.beginObject();
  w.boolean("ok", true);
  w.str("wallType", anchored ? "anchored" : "sheetpile");
  w.beginArray("checks");
  for (auto& c : R.checks) writeCheck(w, c);
  w.endArray();
  w.beginArray("diagrams");
  for (auto& d : R.diagrams) writeSeries(w, d);
  w.endArray();
  w.beginArray("summary");
  for (auto& kv : R.summary) writeKV(w, kv);
  w.endArray();
  w.beginObject("structural");
  w.num("Mmax", R.Mmax);
  w.num("anchorForce", R.anchorForce);
  w.num("requiredD", R.requiredD);
  w.str("combo", R.strCombo);
  w.endObject();
  w.num("maxUtil", maxUtil);
  w.boolean("overallPass", overall);
  w.beginArray("notes");
  for (auto& n : R.notes) w.value(n.c_str());
  w.endArray();
  w.endObject();
  return dupString(w.take());
}

// ----------------------------- exported API -----------------------------
WASM_EXPORT char* madepRunRetainingAnalysis(const char* json, int len) {
  g_lastError.clear();
  if (!json || len <= 0) return errorResult("empty request");
  JsonValue req;
  if (!parseJson(json, (size_t)len, req) || req.type != JsonType::Object) {
    return errorResult("invalid JSON request");
  }
  std::string wallType = req.getStr("wallType", "cantilever");
  if (wallType == "cantilever") return runGravity(req, false);
  if (wallType == "gravity") return runGravity(req, true);
  if (wallType == "sheetpile") return runEmbedded(req, false);
  if (wallType == "anchored") return runEmbedded(req, true);
  return errorResult(std::string("unknown wallType: ") + wallType);
}

WASM_EXPORT const char* madepRetainingLastError() { return g_lastError.c_str(); }

WASM_EXPORT void madepFreeBuffer(char* ptr) {
  if (ptr) std::free(ptr);
}

WASM_EXPORT const char* madepRetainingVersion() { return "1.0.0"; }
