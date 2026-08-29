// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WASM entry point for the Eurocode-7 retaining-wall engine. Speaks JSON on both
// ends: JS passes a request JSON (pointer + length), the engine returns a malloc'd
// null-terminated JSON result string. Single translation unit (pulls all headers),
// mirroring the deformation module build. No exceptions / no RTTI.
//
// Request schema (embedded family, engine v2):
//   wallType: "sheetpile" | "anchored" | "soldierpile"
//   geom: { retainedSurfaceEl, excavationEl (nominal), embedment (below the ULS design excavation),
//           anchored?, anchorEl, anchorAngleDeg, anchorFixedLen, anchorDia, anchorSpacing, anchorTfk,
//           anchorGammaA, pileWidth, spacing, effectiveWidthFactor, laggingWatertight, rowCap }
//   retained[], front[]: strata (characteristic) { topEl, gammaMoist, gammaSat, phi(deg), c, cu, drained, qc }
//   water: { retained, front }
//   loads: { surcharge (variable), surchargePermanent, berm: { height, slopeDeg, gamma } }
//   settings: { riskScheme (0 generic ANB, 1..3 RK), consequenceClass, overdigRule ("belgian"|"en"|"custom"|"none"),
//               overdigCustom, alphaVer, effectFactorBGT, materialOverride: { gPhi, gC, gCu } | null,
//               deltaPassiveRatio, assumeCrackWater, surchargeFloor, resistanceModel ("effective-width"|"brinch-hansen"),
//               da11Mode ("separate" | "single-source") }
//   Legacy keys still honoured: settings.overdig (→ custom rule), settings.minSurcharge (→ surchargeFloor),
//   top-level surcharge (→ loads.surcharge).
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
  s.qc = v.getNum("qc", 0.0);
  return s;
}
static std::vector<Stratum> parseStrata(const JsonValue* arr) {
  std::vector<Stratum> out;
  if (!arr || arr->type != JsonType::Array) return out;
  for (const auto& e : arr->arr) out.push_back(parseStratum(e));
  for (size_t i = 1; i < out.size(); ++i) {   // sort top → down (descending topEl)
    Stratum key = out[i]; size_t j = i;
    while (j > 0 && out[j - 1].topEl < key.topEl) { out[j] = out[j - 1]; --j; }
    out[j] = key;
  }
  return out;
}

// ----------------------------- serialization -----------------------------
static void writeKV(JsonWriter& w, const KV& kv) {
  w.beginObject(); w.str("key", kv.key); w.num("value", kv.value); w.str("unit", kv.unit); w.endObject();
}
static void writeCheck(JsonWriter& w, const CheckResult& c) {
  w.beginObject();
  w.str("id", c.id); w.str("label", c.label); w.str("combo", c.combo); w.str("comboLabel", c.comboLabel);
  w.str("verb", c.verb); w.num("Ed", c.Ed); w.num("Rd", c.Rd); w.str("unit", c.unit);
  w.num("util", c.util); w.boolean("pass", c.pass); w.str("note", c.note);
  w.beginArray("extra"); for (const auto& kv : c.extra) writeKV(w, kv); w.endArray();
  w.endObject();
}
static void writeSeries(JsonWriter& w, const Series& s) {
  w.beginObject();
  w.str("id", s.id); w.str("label", s.label); w.str("unit", s.unit);
  w.beginArray("z"); for (double z : s.z) w.value(z); w.endArray();
  w.beginArray("v"); for (double v : s.v) w.value(v); w.endArray();
  w.endObject();
}
static void writeSeriesKeyed(JsonWriter& w, const char* key, const Series& s) {
  w.beginObject(key);
  w.str("id", s.id); w.str("label", s.label); w.str("unit", s.unit);
  w.beginArray("z"); for (double z : s.z) w.value(z); w.endArray();
  w.beginArray("v"); for (double v : s.v) w.value(v); w.endArray();
  w.endObject();
}
static void writeLayerReports(JsonWriter& w, const char* key, const std::vector<LayerReport>& L) {
  w.beginArray(key);
  for (const LayerReport& r : L) {
    w.beginObject();
    w.num("topEl", r.topEl); w.boolean("drained", r.drained);
    w.num("phiK", r.phiKDeg); w.num("phiD", r.phiDDeg); w.num("cK", r.cK); w.num("cD", r.cD);
    w.num("cuK", r.cuK); w.num("cuD", r.cuD);
    w.num("Ka", r.Ka); w.num("Kac", r.Kac); w.num("Kp", r.Kp); w.num("Kpc", r.Kpc); w.num("deltaP", r.deltaPDeg);
    w.endObject();
  }
  w.endArray();
}
static void writeBranch(JsonWriter& w, const BranchResult& b, bool perPile) {
  w.beginObject();
  w.str("id", b.spec.id); w.str("label", b.spec.label);
  w.beginObject("factors");
  w.num("gG", b.spec.gG); w.num("gGResist", b.spec.gGResist); w.num("gQ", b.spec.gQ); w.num("alphaVer", b.spec.alphaVer);
  w.num("gPhi", b.spec.m.gPhi); w.num("gC", b.spec.m.gC); w.num("gCu", b.spec.m.gCu);
  w.num("effectFactor", b.spec.effectFactor); w.num("overdig", b.spec.overdig); w.boolean("uls", b.spec.uls);
  w.endObject();
  w.num("excavationEl", b.excavationEl); w.num("toeEl", b.toeEl); w.num("dProvided", b.dProvided);
  w.num("d0", b.d0); w.num("dDesign", b.dDesign); w.boolean("bracketed", b.bracketed);
  w.num("odfProvided", b.odfProvided);
  w.num("T", b.T); w.num("Mmax", b.Mmax); w.num("yMmax", b.yMmax); w.num("Vmax", b.Vmax); w.num("yVmax", b.yVmax);
  w.num("TEd", b.TEd); w.num("MEd", b.MEd); w.num("VEd", b.VEd);
  w.num("zNetZero", b.zNetZero); w.boolean("closed", b.closed); w.num("closureDepth", b.diagrams.closureDepth);
  w.num("pSurface", b.pSurface); w.num("pExcavation", b.pExcavation); w.num("pToeBack", b.pToeBack); w.num("pToeFront", b.pToeFront);
  if (perPile) {
    w.beginObject("lagging");
    w.num("pEarth", b.lagging.pEarth); w.num("pSurch", b.lagging.pSurch); w.num("u", b.lagging.u); w.num("total", b.lagging.total);
    w.endObject();
  }
  writeLayerReports(w, "back", b.back);
  writeLayerReports(w, "front", b.front);
  w.beginObject("diagrams");
  writeSeriesKeyed(w, "pBack", b.diagrams.pBack); writeSeriesKeyed(w, "pFront", b.diagrams.pFront);
  writeSeriesKeyed(w, "uBack", b.diagrams.uBack); writeSeriesKeyed(w, "uFront", b.diagrams.uFront);
  writeSeriesKeyed(w, "net", b.diagrams.net); writeSeriesKeyed(w, "V", b.diagrams.V); writeSeriesKeyed(w, "M", b.diagrams.M);
  w.endObject();
  w.endObject();
}
static void writeTlat(JsonWriter& w, const TlatTable& t) {
  w.beginObject();
  w.str("id", t.id); w.str("label", t.label);
  w.num("gPhi", t.gPhi); w.num("gC", t.gC); w.num("gCu", t.gCu);
  w.num("B", t.B); w.num("s", t.s); w.num("topEl", t.topEl); w.num("toeEl", t.toeEl);
  w.num("Ru", t.Ru); w.num("Mu", t.Mu); w.num("zBar", t.zBar);
  w.beginArray("layers");
  for (const BhLayerInfo& L : t.layers) {
    w.beginObject();
    w.num("topEl", L.topEl); w.num("phi", L.phiDeg); w.num("c", L.c); w.num("cu", L.cu); w.boolean("drained", L.drained);
    w.num("Pq", L.k.Pq); w.num("KqA", L.k.KqA); w.num("Kq0", L.k.Kq0); w.num("Kc0", L.k.Kc0); w.num("K0", L.k.K0);
    w.num("dcInf", L.k.dcInf); w.num("Nq", L.k.Nq); w.num("Nc", L.k.Nc); w.num("KqInf", L.k.KqInf); w.num("KcInf", L.k.KcInf);
    w.num("aq", L.k.aq); w.num("ac", L.k.ac);
    w.endObject();
  }
  w.endArray();
  w.beginArray("rows");
  for (const TlatRow& r : t.rows) {
    w.beginObject();
    w.num("z", r.z); w.num("sigmaVf", r.sigmaVf); w.num("dq", r.dq); w.num("Kq", r.Kq); w.num("Kc", r.Kc); w.num("KqA", r.KqA);
    w.num("tlatEqual", r.tlatEqual); w.num("tlatAL", r.tlatAL); w.num("rowCap", r.rowCap); w.num("tlatAdopted", r.tlatAdopted);
    w.endObject();
  }
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
  w.beginObject(); w.boolean("ok", false); w.str("error", msg); w.endObject();
  return dupString(w.take());
}

// ----------------------------- gravity / cantilever -----------------------------
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
  in.backfill = bf ? parseStratum(*bf) : Stratum{0, 18, 20, deg2rad(30), 0, 0, true, 0};
  in.insitu = parseStrata(req.getArr("insitu"));
  if (in.insitu.empty()) in.insitu.push_back(Stratum{0, 19, 21, deg2rad(32), 0, 0, true, 0});

  const JsonValue* water = req.getObj("water");
  in.waterRetainedEl = water ? water->getNum("retained", -1000.0) : -1000.0;
  in.waterFrontEl = water ? water->getNum("front", -1000.0) : -1000.0;
  in.surcharge = req.getNum("surcharge", 0.0);
  if (const JsonValue* lj = req.getObj("loads")) in.surcharge = lj->getNum("surcharge", in.surcharge);

  const JsonValue* sj = req.getObj("settings");
  GravitySettings& s = in.s;
  s.activeMethod = isGravity ? EpMethod::Coulomb : EpMethod::Rankine;
  s.deltaActiveRatio = 0.667;
  s.deltaBaseRatio = 1.0;
  s.baseAdhesion = 0.0;
  s.passiveToe = true;
  s.passiveDeltaRatio = 0.667;
  s.assumeCrackWater = true;
  s.bearingMethod = 0;
  s.bearingDepthFactors = true;
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
  w.beginArray("checks"); for (auto& c : R.checks) writeCheck(w, c); w.endArray();
  w.beginArray("diagrams"); for (auto& d : R.diagrams) writeSeries(w, d); w.endArray();
  w.beginArray("summary"); for (auto& kv : R.summary) writeKV(w, kv); w.endArray();
  w.beginObject("structural");
  w.beginObject("stem"); w.num("M", R.M_stem); w.num("V", R.V_stem); w.str("combo", R.strComboStem); w.endObject();
  w.beginObject("toe"); w.num("M", R.M_toe); w.num("V", R.V_toe); w.str("combo", R.strComboToe); w.endObject();
  w.beginObject("heel"); w.num("M", R.M_heel); w.num("V", R.V_heel); w.str("combo", R.strComboHeel); w.endObject();
  w.endObject();
  w.num("B", in.geom.B());
  w.num("maxUtil", maxUtil);
  w.boolean("overallPass", overall);
  w.beginArray("notes"); for (auto& n : R.notes) w.value(n.c_str()); w.endArray();
  w.endObject();
  return dupString(w.take());
}

// ----------------------------- embedded (sheet pile / anchored / soldier pile) -----------------------------
static char* runEmbedded(const JsonValue& req, const std::string& wallType) {
  const JsonValue* gj = req.getObj("geom");
  if (!gj) return errorResult("missing geom");
  EmbeddedInput in;
  EmbeddedGeometry& g = in.geom;
  const bool soldier = (wallType == "soldierpile");
  g.retainedSurfaceEl = gj->getNum("retainedSurfaceEl", 6.0);
  g.excavationElNominal = gj->getNum("excavationEl", 0.0);
  g.embedment = gj->getNum("embedment", 3.0);
  g.anchored = (wallType == "anchored") || gj->getBool("anchored", false);
  g.anchorEl = gj->getNum("anchorEl", g.retainedSurfaceEl - 1.5);
  g.pileWidthB = gj->getNum("pileWidth", 0.18);
  g.spacingS = gj->getNum("spacing", 1.0);
  g.effectiveWidthFactor = gj->getNum("effectiveWidthFactor", 3.0);
  g.laggingWatertight = gj->getBool("laggingWatertight", false);
  g.rowCap = gj->getBool("rowCap", true);
  in.anchor.angleDeg = gj->getNum("anchorAngleDeg", 20.0);
  in.anchor.fixedLen = gj->getNum("anchorFixedLen", 5.0);
  in.anchor.dia = gj->getNum("anchorDia", 0.15);
  in.anchor.spacing = gj->getNum("anchorSpacing", soldier ? g.spacingS : 2.0);
  in.anchor.tfk = gj->getNum("anchorTfk", 150.0);
  in.anchor.gammaA = gj->getNum("anchorGammaA", 1.1);

  in.retained = parseStrata(req.getArr("retained"));
  if (in.retained.empty()) in.retained = parseStrata(req.getArr("insitu"));
  if (in.retained.empty()) in.retained.push_back(Stratum{g.retainedSurfaceEl, 18, 20, deg2rad(30), 0, 0, true, 0});
  in.front = parseStrata(req.getArr("front"));
  if (in.front.empty()) in.front = in.retained;

  const JsonValue* water = req.getObj("water");
  in.loads.waterRetainedEl = water ? water->getNum("retained", -1000.0) : -1000.0;
  in.loads.waterFrontEl = water ? water->getNum("front", -1000.0) : -1000.0;
  in.loads.surchargeVariable = req.getNum("surcharge", 0.0);
  if (const JsonValue* lj = req.getObj("loads")) {
    in.loads.surchargeVariable = lj->getNum("surcharge", in.loads.surchargeVariable);
    in.loads.surchargePermanent = lj->getNum("surchargePermanent", 0.0);
    if (const JsonValue* bj = lj->getObj("berm")) {
      in.loads.berm.active = bj->getNum("height", 0.0) > 0.0;
      in.loads.berm.height = bj->getNum("height", 0.0);
      in.loads.berm.slopeRad = deg2rad(bj->getNum("slopeDeg", 45.0));
      in.loads.berm.gamma = bj->getNum("gamma", in.retained.empty() ? 18.0 : in.retained[0].gammaMoist);
    }
  }

  const JsonValue* sj = req.getObj("settings");
  in.opt.deltaPassiveRatio = soldier ? 0.0 : 0.667;
  in.branches.riskScheme = 2;   // Belgian embedded-wall guideline RK2 by default
  if (sj) {
    in.opt.deltaPassiveRatio = sj->getNum("deltaPassiveRatio", in.opt.deltaPassiveRatio);
    in.opt.assumeCrackWater = sj->getBool("assumeCrackWater", true);
    in.opt.surchargeFloor = sj->getNum("surchargeFloor", sj->getNum("minSurcharge", 0.0));
    in.branches.riskScheme = (int)sj->getNum("riskScheme", 2);
    in.branches.consequenceClass = (int)sj->getNum("consequenceClass", 2);
    std::string rule = sj->getStr("overdigRule", sj->has("overdig") ? "custom" : "belgian");
    in.branches.overdigRule = rule == "en" ? OverdigRule::EN : rule == "custom" ? OverdigRule::Custom
                            : rule == "none" ? OverdigRule::None : OverdigRule::Belgian;
    in.branches.overdigCustom = sj->getNum("overdigCustom", sj->getNum("overdig", 0.30));
    in.branches.alphaVer = sj->getNum("alphaVer", 1.10);
    in.branches.effectFactorBGT = sj->getNum("effectFactorBGT", 1.35);
    in.branches.da11SeparateSource = sj->getStr("da11Mode", "separate") != "single-source";
    if (const JsonValue* mo = sj->getObj("materialOverride")) {
      in.branches.materialOverride = mo->getBool("applyToDA12", false);
      in.materialOverrideForTlat = true;
      in.branches.mOverride = {mo->getNum("gPhi", 1.30), mo->getNum("gC", 1.30), mo->getNum("gCu", 1.40), 1.0};
    }
    std::string model = sj->getStr("resistanceModel", "effective-width");
    in.kind = !soldier ? WallKind::Continuous
            : (model == "brinch-hansen" ? WallKind::SoldierBrinchHansen : WallKind::SoldierEffWidth);
  } else {
    in.kind = soldier ? WallKind::SoldierEffWidth : WallKind::Continuous;
  }

  EmbeddedResult R = analyzeEmbedded(in);
  const bool perPile = in.kind != WallKind::Continuous;
  double maxUtil = 0; bool overall = true;
  for (auto& c : R.checks) { if (c.util > maxUtil) maxUtil = c.util; if (!c.pass) overall = false; }

  JsonWriter w;
  w.beginObject();
  w.boolean("ok", true);
  w.str("wallType", wallType);
  w.str("engine", "v2");
  w.boolean("perPile", perPile);
  w.str("resistanceModel", in.kind == WallKind::SoldierBrinchHansen ? "brinch-hansen" : in.kind == WallKind::SoldierEffWidth ? "effective-width" : "continuous");
  w.num("overdigUls", R.overdigUls);
  w.beginArray("checks"); for (auto& c : R.checks) writeCheck(w, c); w.endArray();
  // legacy-compatible diagram list: governing-branch M and V
  w.beginArray("diagrams");
  for (const BranchResult& b : R.branches) {
    if (b.spec.id != R.MCombo) continue;
    Series m = b.diagrams.M; m.id = "M_" + b.spec.id;
    Series v = b.diagrams.V; v.id = "V_" + b.spec.id;
    writeSeries(w, m); writeSeries(w, v);
  }
  w.endArray();
  w.beginArray("branches"); for (const BranchResult& b : R.branches) writeBranch(w, b, perPile); w.endArray();
  w.beginArray("tlat"); for (const TlatTable& t : R.tlat) writeTlat(w, t); w.endArray();
  w.beginArray("summary"); for (auto& kv : R.summary) writeKV(w, kv); w.endArray();
  w.beginObject("structural");
  w.num("Mmax", R.MEd); w.str("combo", R.MCombo);
  w.num("Vmax", R.VEd); w.str("vCombo", R.VCombo);
  w.num("anchorForce", R.TEd); w.str("anchorCombo", R.TCombo);
  w.num("anchorAxial", R.anchorAxial); w.num("anchorVertical", R.anchorVertical);
  w.num("requiredD", R.requiredD); w.str("requiredDCombo", R.requiredDCombo);
  w.num("laggingPressure", R.pLaggingEd); w.str("laggingCombo", R.laggingCombo);
  w.endObject();
  w.num("maxUtil", maxUtil);
  w.boolean("overallPass", overall);
  w.beginArray("notes"); for (auto& n : R.notes) w.value(n.c_str()); w.endArray();
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
  if (wallType == "sheetpile" || wallType == "anchored" || wallType == "soldierpile") return runEmbedded(req, wallType);
  return errorResult(std::string("unknown wallType: ") + wallType);
}

WASM_EXPORT const char* madepRetainingLastError() { return g_lastError.c_str(); }

WASM_EXPORT void madepFreeBuffer(char* ptr) {
  if (ptr) std::free(ptr);
}

WASM_EXPORT const char* madepRetainingVersion() { return "2.0.0"; }
