#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Window-handler verifier (monolith map §2.15, §8 risk 9, PLAN §4 defect 1).
//
// The CPT app's HTML is built as template strings whose inline handlers
// (`onclick="name(...)"`, `onchange="name(this.value)"`, …) resolve their
// callee as a *global* at event time. A handler that is not published on
// `window` fails silently in the browser (ReferenceError in the console, the
// control does nothing). Nothing type-checks this surface, so this script does:
//
//   1. walks src/lib/cpt-app/**.js (the monolith and every package that returns
//      HTML strings), finds every `on<event>="…"` / `on<event>='…'` attribute
//      inside the source, strips template-time `${…}` interpolations (those are
//      evaluated while rendering, not at event time) and collects every bare
//      call `name(` in the remaining event-time JavaScript;
//   2. collects everything that reaches `window`: the `legacyApi` object of
//      legacy-controller.js (parsed from source) and the `handlers` object that
//      `installRetainingApp(ctx)` returns (loaded for real under a DOM stub —
//      that is what `initLegacyController` spreads onto `window`);
//   3. fails (exit 1) when a called name is not published, listing every
//      call site as file:line.
//
// Usage: node scripts/verify_window_handlers.mjs [--verbose]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = resolve(ROOT, 'src/lib/cpt-app');
const CONTROLLER = resolve(APP_DIR, 'legacy-controller.js');
const RETAINING_UI = resolve(APP_DIR, 'retaining/retaining-ui.js');
const VERBOSE = process.argv.includes('--verbose');

// Names that are legitimately resolvable inside an inline handler without
// being published by the app: JS keywords/statements that look like calls, and
// browser/ECMAScript globals.
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'function', 'typeof', 'new',
  'void', 'delete', 'in', 'instanceof', 'try', 'catch', 'finally', 'throw', 'await', 'yield',
  'var', 'let', 'const', 'with'
]);
const BUILTINS = new Set([
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'Promise', 'Error', 'RegExp', 'Map', 'Set',
  'parseFloat', 'parseInt', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
  'alert', 'confirm', 'prompt', 'open', 'print', 'scrollTo'
]);

// ---------------------------------------------------------------- sources
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out.sort();
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Find `on<event>=` attributes and return their raw values. The value is read
// character by character so a quote inside a `${…}` interpolation does not end
// it early (template-literal source, not parsed HTML).
function* handlerAttributes(text) {
  const re = /\bon[a-z]+\s*=\s*(["'])/g;
  let m;
  while ((m = re.exec(text))) {
    const quote = m[1];
    let i = re.lastIndex;
    let depth = 0;
    let value = '';
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '$' && text[i + 1] === '{') { depth++; value += '${'; i++; continue; }
      if (depth > 0) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        value += c;
        continue;
      }
      if (c === quote) break;
      value += c;
    }
    yield { value, index: m.index, line: lineOf(text, m.index) };
    re.lastIndex = i + 1;
  }
}

// Remove balanced `${…}` interpolations (template time) from a handler body.
function stripInterpolations(value) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '$' && value[i + 1] === '{') { depth++; i++; out += ' __TPL__ '; continue; }
    if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      continue;
    }
    out += c;
  }
  return out;
}

// Every bare `name(` in event-time JS: not preceded by `.` (member call) and
// not a keyword or a runtime built-in.
function calledNames(body) {
  const names = new Set();
  const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[2];
    if (KEYWORDS.has(name) || BUILTINS.has(name) || name === '__TPL__') continue;
    names.add(name);
  }
  return names;
}

// ---------------------------------------------------------------- published
function legacyApiNames(controllerSrc) {
  const m = controllerSrc.match(/\nconst legacyApi\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) throw new Error('legacy-controller.js: `const legacyApi={…};` block not found');
  const names = new Set();
  for (const raw of m[1].split(',')) {
    const entry = raw.replace(/\/\/.*$/gm, '').trim();
    if (!entry) continue;
    const key = entry.split(':')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
    else throw new Error(`legacy-controller.js: unexpected legacyApi entry "${entry}"`);
  }
  return names;
}

// What initLegacyController spreads onto window besides legacyApi.
function windowAssignTargets(controllerSrc) {
  const targets = [];
  const re = /Object\.assign\(\s*window\s*,\s*([^)]+?)\s*\)/g;
  let m;
  while ((m = re.exec(controllerSrc))) targets.push(m[1].trim());
  const direct = [...controllerSrc.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=[^=]/g)].map((x) => x[1]);
  return { targets, direct };
}

async function retainingHandlerNames() {
  // The same minimal DOM stub scripts/verify_retaining_ui.mjs uses: the
  // handlers object is built inside installRetainingApp without touching it,
  // but the module's imports must be safe to evaluate.
  const elements = new Map();
  const makeEl = (id) => ({ id, innerHTML: '', getAttribute: () => null, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 800, height: 440, left: 0, top: 0 }), getContext: () => new Proxy({}, { get: () => () => ({}) }), style: {}, parentElement: null, textContent: '' });
  globalThis.document ??= { getElementById: (id) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); }, createElement: () => makeEl('tmp'), querySelectorAll: () => [], body: { appendChild() {} } };
  globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, localStorage: null };
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
  const { installRetainingApp } = await import(RETAINING_UI);
  const state = { stage6: {} };
  const app = installRetainingApp({ getState: () => state, requestRender() {}, workingLayers: () => [], getCpt: () => null, getProjectMeta: () => ({}) });
  return new Set(Object.keys(app.handlers || {}));
}

// ---------------------------------------------------------------- main
const controllerSrc = readFileSync(CONTROLLER, 'utf8');
const published = new Map(); // name → origin
for (const n of legacyApiNames(controllerSrc)) published.set(n, 'legacyApi');
const { targets, direct } = windowAssignTargets(controllerSrc);
const KNOWN_TARGETS = new Set(['legacyApi', 'retainingApp.handlers']);
const unknownTargets = targets.filter((t) => !KNOWN_TARGETS.has(t));
if (targets.includes('retainingApp.handlers')) {
  for (const n of await retainingHandlerNames()) published.set(n, 'retainingApp.handlers');
}
for (const n of direct) published.set(n, 'window.<name> =');

const calls = new Map(); // name → [{file, line}]
let attributeCount = 0;
const files = walk(APP_DIR);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  for (const attr of handlerAttributes(text)) {
    attributeCount++;
    const body = stripInterpolations(attr.value);
    for (const name of calledNames(body)) {
      if (!calls.has(name)) calls.set(name, []);
      calls.get(name).push({ file: rel, line: attr.line });
    }
  }
}

const missing = [...calls.keys()].filter((n) => !published.has(n)).sort();
const byOrigin = {};
for (const [, origin] of published) byOrigin[origin] = (byOrigin[origin] || 0) + 1;

console.log(`scanned ${files.length} files under src/lib/cpt-app, ${attributeCount} inline on*= attributes, ${calls.size} distinct event-time callees`);
console.log(`published on window: ${published.size} names (${Object.entries(byOrigin).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
if (unknownTargets.length) console.log(`WARN  Object.assign(window, …) with an unrecognised source: ${unknownTargets.join(', ')} — extend KNOWN_TARGETS`);

if (VERBOSE) {
  for (const name of [...calls.keys()].sort()) {
    const sites = calls.get(name);
    console.log(`  ${published.has(name) ? 'ok  ' : 'MISS'} ${name} ×${sites.length} (${published.get(name) || 'unpublished'})`);
  }
}

let fails = 0;
for (const name of missing) {
  fails++;
  const sites = calls.get(name);
  console.log(`FAIL  ${name} is called from ${sites.length} inline handler(s) but is not published on window:`);
  for (const s of sites) console.log(`        ${s.file}:${s.line}`);
}

if (fails) {
  console.log(`\n${fails} unpublished handler name(s). Add them to legacyApi (or the owning package's handlers).`);
  process.exit(1);
}
console.log('OK    every inline handler callee is published on window');
