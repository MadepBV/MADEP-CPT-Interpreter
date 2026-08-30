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
//   2. collects everything that reaches `window`: since PR 20 (the composition root) that is
//      the union of the per-package `handlers` maps, so the controller is loaded for real
//      under the Tier-B DOM stub and `initLegacyController()` is run — the keys it adds to
//      `window` ARE the published surface, no source parsing involved;
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
/**
 * The real surface: load the controller under the Tier-B DOM stub, run
 * `initLegacyController()` and diff the keys of `globalThis` before and after. Since PR 20 the
 * controller composes `handlers` out of the per-package maps, so there is no object to parse —
 * and this is the stronger check anyway: it is exactly what the browser sees.
 *
 * Every name is attributed back to the package whose `handlers` map carries it, so the summary
 * still names its origin (and a name published by two packages would be reported).
 */
async function publishedNames() {
  const { installDomStub } = await import('./golden/lib/load-controller.mjs');
  const { createServer } = await import('vite');
  installDomStub();
  const server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { $lib: resolve(ROOT, 'src/lib') } },
    define: { __APP_VERSION__: JSON.stringify(globalThis.__APP_VERSION__) }
  });
  const before = new Set(Object.keys(globalThis));
  const ctl = await server.ssrLoadModule('/src/lib/cpt-app/legacy-controller.js');
  ctl.initLegacyController();
  const added = Object.keys(globalThis).filter((k) => !before.has(k));
  await server.close();
  return added;
}

// Which package's handlers map owns each name (for the summary line only).
async function handlerOrigins() {
  const origins = new Map();
  const dirs = ['load', 'classification', 'layers', 'model-params', 'tuning', 'stage6', 'bearing',
    'seepslope', 'section', 'export', 'report', 'project', 'project-io', 'retaining'];
  for (const dir of dirs) {
    const file = dir === 'retaining' ? RETAINING_UI : resolve(APP_DIR, dir, 'index.js');
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const block = text.match(/handlers\s*=\s*\{([\s\S]*?)\n\s*\};/);
    if (!block) continue;
    for (const m of block[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)) {
      if (!origins.has(m[1])) origins.set(m[1], dir);
    }
  }
  return origins;
}

// ---------------------------------------------------------------- main
const controllerSrc = readFileSync(CONTROLLER, 'utf8');
const published = new Map(); // name → origin
const origins = await handlerOrigins();
for (const n of await publishedNames()) published.set(n, origins.get(n) || 'composition root');
const unknownTargets = [...controllerSrc.matchAll(/Object\.assign\(\s*window\s*,\s*([^)]+?)\s*\)/g)]
  .map((m) => m[1].trim())
  .filter((t) => t !== 'handlers');

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
if (unknownTargets.length) console.log(`WARN  Object.assign(window, …) with a source other than the composed \`handlers\`: ${unknownTargets.join(', ')}`);

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
  console.log(`\n${fails} unpublished handler name(s). Add them to the owning package's \`handlers\` map.`);
  process.exit(1);
}
console.log('OK    every inline handler callee is published on window');
