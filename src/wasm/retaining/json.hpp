// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal, dependency-free, exception-free JSON DOM + parser + builder for the
// retaining-wall wasm engine. Built for -fno-exceptions / -fno-rtti. Numbers are
// stored as double; objects preserve insertion order (vector of key/value pairs).
//
// The engine speaks JSON on both ends: JS passes a JSON request string, the engine
// returns a JSON result string. This keeps the wasm boundary self-describing and
// removes the field-ordering fragility of a packed binary buffer.
#pragma once

#include <string>
#include <vector>
#include <utility>
#include <cstdint>
#include <cstdio>
#include <cmath>

namespace madep {

enum class JsonType : uint8_t { Null, Bool, Number, String, Array, Object };

struct JsonValue {
  JsonType type = JsonType::Null;
  bool b = false;
  double num = 0.0;
  std::string str;
  std::vector<JsonValue> arr;
  std::vector<std::pair<std::string, JsonValue>> obj;

  // ---- accessors (all total / default-returning; never throw) ----
  bool isObject() const { return type == JsonType::Object; }
  bool isArray() const { return type == JsonType::Array; }
  bool isNumber() const { return type == JsonType::Number; }
  bool isString() const { return type == JsonType::String; }

  const JsonValue* find(const char* key) const {
    if (type != JsonType::Object) return nullptr;
    for (const auto& kv : obj) {
      if (kv.first == key) return &kv.second;
    }
    return nullptr;
  }
  bool has(const char* key) const { return find(key) != nullptr; }

  double getNum(const char* key, double dflt) const {
    const JsonValue* v = find(key);
    if (v && v->type == JsonType::Number) return v->num;
    if (v && v->type == JsonType::Bool) return v->b ? 1.0 : 0.0;
    return dflt;
  }
  bool getBool(const char* key, bool dflt) const {
    const JsonValue* v = find(key);
    if (v && v->type == JsonType::Bool) return v->b;
    if (v && v->type == JsonType::Number) return v->num != 0.0;
    return dflt;
  }
  std::string getStr(const char* key, const char* dflt) const {
    const JsonValue* v = find(key);
    if (v && v->type == JsonType::String) return v->str;
    return std::string(dflt);
  }
  const JsonValue* getArr(const char* key) const {
    const JsonValue* v = find(key);
    return (v && v->type == JsonType::Array) ? v : nullptr;
  }
  const JsonValue* getObj(const char* key) const {
    const JsonValue* v = find(key);
    return (v && v->type == JsonType::Object) ? v : nullptr;
  }
};

// ----------------------------- parser -----------------------------
class JsonParser {
 public:
  explicit JsonParser(const char* text, size_t len) : s_(text), n_(len), i_(0) {}

  bool parse(JsonValue& out) {
    skipWs();
    if (!parseValue(out)) return false;
    skipWs();
    return true;  // trailing content tolerated
  }

 private:
  const char* s_;
  size_t n_;
  size_t i_;

  void skipWs() {
    while (i_ < n_) {
      char c = s_[i_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i_++;
      else break;
    }
  }
  bool parseValue(JsonValue& out) {
    skipWs();
    if (i_ >= n_) return false;
    char c = s_[i_];
    switch (c) {
      case '{': return parseObject(out);
      case '[': return parseArray(out);
      case '"': {
        out.type = JsonType::String;
        return parseString(out.str);
      }
      case 't': case 'f': return parseBool(out);
      case 'n': return parseNull(out);
      default: return parseNumber(out);
    }
  }
  bool parseObject(JsonValue& out) {
    out.type = JsonType::Object;
    i_++;  // {
    skipWs();
    if (i_ < n_ && s_[i_] == '}') { i_++; return true; }
    while (i_ < n_) {
      skipWs();
      if (i_ >= n_ || s_[i_] != '"') return false;
      std::string key;
      if (!parseString(key)) return false;
      skipWs();
      if (i_ >= n_ || s_[i_] != ':') return false;
      i_++;  // :
      JsonValue val;
      if (!parseValue(val)) return false;
      out.obj.emplace_back(std::move(key), std::move(val));
      skipWs();
      if (i_ >= n_) return false;
      if (s_[i_] == ',') { i_++; continue; }
      if (s_[i_] == '}') { i_++; return true; }
      return false;
    }
    return false;
  }
  bool parseArray(JsonValue& out) {
    out.type = JsonType::Array;
    i_++;  // [
    skipWs();
    if (i_ < n_ && s_[i_] == ']') { i_++; return true; }
    while (i_ < n_) {
      JsonValue val;
      if (!parseValue(val)) return false;
      out.arr.push_back(std::move(val));
      skipWs();
      if (i_ >= n_) return false;
      if (s_[i_] == ',') { i_++; continue; }
      if (s_[i_] == ']') { i_++; return true; }
      return false;
    }
    return false;
  }
  bool parseString(std::string& out) {
    i_++;  // opening quote
    while (i_ < n_) {
      char c = s_[i_++];
      if (c == '"') return true;
      if (c == '\\') {
        if (i_ >= n_) return false;
        char e = s_[i_++];
        switch (e) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'n': out.push_back('\n'); break;
          case 'r': out.push_back('\r'); break;
          case 't': out.push_back('\t'); break;
          case 'u': {
            // Minimal \uXXXX handling: decode to UTF-8 (BMP only).
            if (i_ + 4 > n_) return false;
            unsigned int cp = 0;
            for (int k = 0; k < 4; k++) {
              char h = s_[i_++];
              cp <<= 4;
              if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
              else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
              else return false;
            }
            if (cp < 0x80) {
              out.push_back((char)cp);
            } else if (cp < 0x800) {
              out.push_back((char)(0xC0 | (cp >> 6)));
              out.push_back((char)(0x80 | (cp & 0x3F)));
            } else {
              out.push_back((char)(0xE0 | (cp >> 12)));
              out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
              out.push_back((char)(0x80 | (cp & 0x3F)));
            }
            break;
          }
          default: return false;
        }
      } else {
        out.push_back(c);
      }
    }
    return false;
  }
  bool parseBool(JsonValue& out) {
    if (i_ + 4 <= n_ && s_[i_] == 't' && s_[i_ + 1] == 'r' && s_[i_ + 2] == 'u' && s_[i_ + 3] == 'e') {
      out.type = JsonType::Bool; out.b = true; i_ += 4; return true;
    }
    if (i_ + 5 <= n_ && s_[i_] == 'f' && s_[i_ + 1] == 'a' && s_[i_ + 2] == 'l' && s_[i_ + 3] == 's' && s_[i_ + 4] == 'e') {
      out.type = JsonType::Bool; out.b = false; i_ += 5; return true;
    }
    return false;
  }
  bool parseNull(JsonValue& out) {
    if (i_ + 4 <= n_ && s_[i_] == 'n' && s_[i_ + 1] == 'u' && s_[i_ + 2] == 'l' && s_[i_ + 3] == 'l') {
      out.type = JsonType::Null; i_ += 4; return true;
    }
    return false;
  }
  bool parseNumber(JsonValue& out) {
    size_t start = i_;
    if (i_ < n_ && (s_[i_] == '-' || s_[i_] == '+')) i_++;
    bool any = false;
    while (i_ < n_) {
      char c = s_[i_];
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
        i_++; any = true;
      } else break;
    }
    if (!any) return false;
    std::string tok(s_ + start, i_ - start);
    out.type = JsonType::Number;
    out.num = std::strtod(tok.c_str(), nullptr);
    return true;
  }
};

inline bool parseJson(const char* text, size_t len, JsonValue& out) {
  JsonParser p(text, len);
  return p.parse(out);
}

// ----------------------------- builder -----------------------------
// Streaming JSON writer with explicit begin/end and comma bookkeeping.
class JsonWriter {
 public:
  JsonWriter() { stack_.reserve(16); }

  std::string take() { return std::move(buf_); }

  void beginObject() { prefixValue(); buf_.push_back('{'); push(false); }
  void endObject() { buf_.push_back('}'); pop(); }
  void beginArray() { prefixValue(); buf_.push_back('['); push(true); }
  void endArray() { buf_.push_back(']'); pop(); }

  void beginObject(const char* key) { writeKey(key); buf_.push_back('{'); push(false); }
  void beginArray(const char* key) { writeKey(key); buf_.push_back('['); push(true); }

  void key(const char* k) { writeKey(k); }  // follow with a value*() that takes no key

  void value(double v) { prefixValue(); writeNumber(v); }
  void value(bool v) { prefixValue(); buf_ += v ? "true" : "false"; }
  void value(const char* v) { prefixValue(); writeString(v); }
  void valueNull() { prefixValue(); buf_ += "null"; }

  void num(const char* k, double v) { writeKey(k); writeNumber(v); }
  void boolean(const char* k, bool v) { writeKey(k); buf_ += v ? "true" : "false"; }
  void str(const char* k, const char* v) { writeKey(k); writeString(v); }
  void str(const char* k, const std::string& v) { writeKey(k); writeString(v.c_str()); }

 private:
  struct Frame { bool isArray; bool hasItems; };
  std::string buf_;
  std::vector<Frame> stack_;

  void push(bool isArray) { stack_.push_back({isArray, false}); }
  void pop() { if (!stack_.empty()) stack_.pop_back(); }

  void prefixValue() {
    if (stack_.empty()) return;
    Frame& f = stack_.back();
    if (f.hasItems) buf_.push_back(',');
    f.hasItems = true;
  }
  void writeKey(const char* k) {
    if (!stack_.empty()) {
      Frame& f = stack_.back();
      if (f.hasItems) buf_.push_back(',');
      f.hasItems = true;
    }
    writeString(k);
    buf_.push_back(':');
  }
  void writeNumber(double v) {
    if (!std::isfinite(v)) { buf_ += "null"; return; }
    char tmp[40];
    // %.10g gives compact, round-trip-friendly output for engineering values.
    std::snprintf(tmp, sizeof(tmp), "%.10g", v);
    buf_ += tmp;
  }
  void writeString(const char* v) {
    buf_.push_back('"');
    for (const char* p = v; *p; ++p) {
      unsigned char c = (unsigned char)*p;
      switch (c) {
        case '"': buf_ += "\\\""; break;
        case '\\': buf_ += "\\\\"; break;
        case '\n': buf_ += "\\n"; break;
        case '\r': buf_ += "\\r"; break;
        case '\t': buf_ += "\\t"; break;
        default:
          if (c < 0x20) { char e[8]; std::snprintf(e, sizeof(e), "\\u%04x", c); buf_ += e; }
          else buf_.push_back((char)c);
      }
    }
    buf_.push_back('"');
  }
};

}  // namespace madep
