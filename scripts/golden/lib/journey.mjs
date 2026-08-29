// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier C (browser) golden journeys — the Node side of design §2.3 / §4.5.
//
// A journey is a linear list of steps; each step locks
//   <journey>/<step>.state.json   window.__golden.captureState(), normalised by the
//                                 same normalize.mjs as the Node tiers, compared with
//                                 tolerances.browser (1e-6: the retaining numbers cross
//                                 WASM; everything pure-JS is still expected to be identical)
//   <journey>/<step>.dom.txt      innerText of the step's containers (exact after masks)
//   <journey>/<step>.png          secondary, tolerant screenshot (canvases masked) —
//                                 never blocking unless GOLDEN_VISUAL=strict
// plus ad-hoc JSON / text goldens for downloads, report payloads and note payloads.
//
// Modes (GOLDEN_MODE): record — write everything; check (default) — compare, write the
// normalised actual of every mismatch to tests/golden/.actual/browser/…, fail the test at
// finish() with a readable diff; update — rewrite the failing/new cases only.
//
// Large parts that are locked in full at the step where they change are stored as a
// digest at every later step where they are unchanged (`{"<unchanged-since>": step,
// "<digest>": …}`), the same idea as the Node tier's D4: any change still flips the
// golden and the readable diff lives at the step that owns the data.
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { ACTUAL, GOLDEN, ROOT, listGoldens, readGolden, writeActual, writeGolden } from './store.mjs';
import { normalize, normalizeText, digest } from './normalize.mjs';
import { compare, formatDiffs, textDiff } from './compare.mjs';

export const MODES = ['record', 'check', 'update'];
export const TOLERANCES = JSON.parse(readFileSync(join(GOLDEN, 'tolerances.json'), 'utf8'));
export const BROWSER_TOL = TOLERANCES.browser;
export const CAPTURE_SCRIPT = join(ROOT, 'scripts/golden/lib/browser-capture.js');
export const CHART_VENDOR = join(GOLDEN, 'vendor/chart.umd.js');
export const CHART_CDN_GLOB = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/**';
export const ANALYTICS_GLOB = 'https://analytics.madep.digital/**';

/** Containers captured by default (design §1); `.panel.active` is the stage the user sees. */
export const DEFAULT_DOM = ['#cptTabs', '.panel.active'];

/** Parts of the state that are digested while unchanged since an earlier step. */
export const DIGEST_IF_UNCHANGED = [
  'active.data',
  'active.classified',
  'active.tuning',
  'active.stage6.retwall.result',
  'active.stage6.retwall.drivability.result',
  'active.stage6.bishop.results',
  'active.stage6.bishop.seepage.mesh',
  'active.stage6.bishop.seepage.result',
  'active.stage6.bishop.deformation.mesh',
  'active.stage6.bishop.deformation.result',
  'project.cpts[*].data',
  'project.cpts[*].classified',
  'cache.*'
];

/**
 * Text masks applied to DOM text and download names. Everything here is time- or
 * clock-derived; the values themselves are locked in state.json where they are
 * deterministic, or masked there by normalize.mjs.
 */
export const TEXT_MASKS = [
  // nl-BE "1 jan 2026 01:00" (report headers: fmtDateTime of generatedAt) — the
  // journey clock is shifted to a fixed epoch but still advances (Chart.js animations
  // need a moving Date.now), so the minute depends on run speed.
  [/\b\d{1,2} [a-z]{3,4}\.? \d{4},? \d{2}:\d{2}\b/g, '<datetime>'],
  // "Search + Spencer check complete in 1234 ms." (stage6BishopCompleteMessage)
  [/\b\d+(?:\.\d+)? ms\b/g, '<ms> ms'],
  // saveProject file name: <name>_YYYYMMDD-HHMM.madep.json (project-io/index.js:19)
  [/_\d{8}-\d{4}\.madep\.json/g, '_<stamp>.madep.json']
];

export function maskText(text) {
  let t = String(text ?? '');
  for (const [re, rep] of TEXT_MASKS) t = t.replace(re, rep);
  return t;
}

/** Resolve a dotted path with `[*]` / `.*` wildcards; calls cb(parent, key) for every match. */
function walkPath(obj, path, cb) {
  const parts = path.split('.');
  const step = (node, i) => {
    if (node == null || typeof node !== 'object') return;
    if (i === parts.length) return;
    let part = parts[i];
    const last = i === parts.length - 1;
    let wild = false;
    if (part.endsWith('[*]')) { part = part.slice(0, -3); wild = true; }
    if (part === '*') {
      for (const k of Object.keys(node)) { if (last) cb(node, k); else step(node[k], i + 1); }
      return;
    }
    const child = node[part];
    if (wild) {
      if (!Array.isArray(child)) return;
      child.forEach((c, idx) => { if (last) cb(child, idx); else step(c, i + 1); });
      return;
    }
    if (last) { if (part in node) cb(node, part); }
    else step(child, i + 1);
  };
  step(obj, 0);
}

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

export class Journey {
  /**
   * @param {string} name       journey id → tests/golden/browser/<name>/
   * @param {object} o          { page, context, mode, dom, visual }
   */
  constructor(name, { page, context, mode = process.env.GOLDEN_MODE || 'check', dom = DEFAULT_DOM, visual = process.env.GOLDEN_VISUAL || 'soft' } = {}) {
    if (!MODES.includes(mode)) throw new Error(`GOLDEN_MODE must be one of ${MODES.join('|')}, got ${mode}`);
    this.name = name;
    this.page = page;
    this.context = context;
    this.mode = mode;
    this.dom = dom;
    this.visual = visual;          // 'off' | 'soft' | 'strict'
    this.failures = [];            // { rel, diffs, kind }
    this.visualWarnings = [];      // { rel, message }
    this.notes = [];               // free text for the report (skipped optional steps …)
    this.produced = new Set();
    this.steps = [];               // { name, ms }
    this.errors = [];              // page errors + console errors (must be empty at finish)
    this.dialogs = [];             // alert() messages, auto-accepted
    this._prev = new Map();        // digest-if-unchanged bookkeeping: path → { text, step }
    this._t0 = Date.now();
    this._tStep = this._t0;
    if (mode === 'check') rmSync(join(ACTUAL, 'browser', name), { recursive: true, force: true });
  }

  rel(file) { return `browser/${this.name}/${file}`; }

  /** Attach page listeners: errors collected, dialogs accepted (alerts are guard paths, F-notes). */
  observe(page) {
    page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') this.errors.push(`console: ${m.text()}`); });
    page.on('dialog', (d) => { this.dialogs.push(d.message()); d.accept().catch(() => {}); });
  }

  // ---------------- waits ----------------
  /** State-predicate wait (F6). `pred` receives { project, active, cache, stage } (live objects). */
  async waitState(pred, { timeout = 30000, page = this.page } = {}) {
    await page.waitForFunction((src) => window.__golden.evalPredicate(src), pred.toString(), { timeout, polling: 50 });
  }

  /** Two animation frames (chart builds are scheduled in requestAnimationFrame). */
  async nextFrame(page = this.page) {
    await page.evaluate(() => window.__golden.nextFrame());
  }

  // ---------------- capture ----------------
  /**
   * Lock one step: state.json (unless state:false), dom.txt (opts.dom or the journey default),
   * png (unless screenshot:false). Extra `json` / `text` entries are locked next to it.
   */
  async step(name, { dom, state = true, screenshot = true, page = this.page } = {}) {
    const t = Date.now();
    if (state) {
      const captured = await page.evaluate(() => window.__golden.captureState());
      this._lockJson(`${name}.state.json`, captured, { digestUnchanged: true, step: name });
    }
    const sels = dom ?? this.dom;
    const text = await page.evaluate((s) => window.__golden.domText(s), sels);
    this._lockText(`${name}.dom.txt`, maskText(text));
    if (screenshot) await this._screenshot(page, name);
    this.steps.push({ name, ms: Date.now() - t, sinceLast: t - this._tStep });
    this._tStep = Date.now();
  }

  /** A step on another page (report tab / calculation note) — dom + optional screenshot only. */
  async stepPage(name, otherPage, { dom, screenshot = true } = {}) {
    await this.step(name, { dom, state: false, screenshot, page: otherPage });
  }

  /** Arbitrary JSON golden (normalised). */
  json(name, value, opts = {}) { this._lockJson(`${name}.json`, value, opts); }
  /** Arbitrary text golden (masked, `\n` endings). */
  text(name, value, ext = 'txt') { this._lockText(`${name}.${ext}`, maskText(value)); }

  /** Lock a Playwright Download: text files verbatim (masked), .json files as normalised JSON. */
  async download(name, dl, { digestPaths = [] } = {}) {
    const filename = maskText(dl.suggestedFilename());
    const path = await dl.path();
    const raw = readFileSync(path);
    if (/\.json$/i.test(filename)) {
      const parsed = JSON.parse(raw.toString('utf8'));
      // (no raw byte count: the raw file carries savedAt / timing digits that are masked in `snapshot`)
      this._lockJson(`${name}.json`, { filename, snapshot: parsed }, { digestPaths: digestPaths.map((p) => `snapshot.${p}`) });
    } else {
      this._lockText(`${name}.${filename.split('.').pop().toLowerCase()}`, `# ${filename}\n${maskText(raw.toString('utf8'))}`);
    }
    return filename;
  }

  /** Report-page / note payloads kept in localStorage under a prefix (F8). */
  async localStorage(name, prefix, { page = this.page, digestPaths = [] } = {}) {
    const entries = await page.evaluate((p) => window.__golden.localStorageByPrefix(p), prefix);
    this._lockJson(`${name}.json`, entries, { digestPaths: digestPaths.map((p) => `[*].value.${p}`) });
    return entries;
  }

  // ---------------- internals ----------------
  _lockJson(file, value, { digestUnchanged = false, digestPaths = [], step = null } = {}) {
    const rel = this.rel(file);
    const actual = normalize(value);
    for (const p of digestPaths) walkPath(actual, p, (parent, key) => { if (parent[key] != null && typeof parent[key] === 'object') parent[key] = digest(parent[key]); });
    if (digestUnchanged) this._digestUnchanged(actual, step);
    this._record(rel, actual, 'json');
  }

  _lockText(file, text) {
    this._record(this.rel(file), normalizeText(text), 'txt');
  }

  _digestUnchanged(state, step) {
    for (const p of DIGEST_IF_UNCHANGED) {
      walkPath(state, p, (parent, key) => {
        const node = parent[key];
        if (node == null || typeof node !== 'object') return;
        const id = `${p}#${key}`;
        const text = JSON.stringify(node);
        const prev = this._prev.get(id);
        if (prev && prev.text === text) parent[key] = { '<unchanged-since>': prev.step, ...digest(node) };
        else this._prev.set(id, { text, step });
      });
    }
  }

  _record(rel, actual, kind) {
    this.produced.add(rel);
    if (this.mode === 'record') { writeGolden(rel, actual); return; }
    const expected = readGolden(rel);
    if (expected === undefined) {
      if (this.mode === 'update') { writeGolden(rel, actual); return; }
      writeActual(rel, actual);
      this.failures.push({ rel, kind: 'NEW', diffs: [{ path: '<file>', expected: '<no golden>', actual: 'record or GOLDEN_MODE=update' }] });
      return;
    }
    const diffs = kind === 'json' ? compare(expected, actual, BROWSER_TOL) : textDiff(expected, actual);
    if (!diffs.length) return;
    writeActual(rel, actual);
    if (this.mode === 'update') { writeGolden(rel, actual); return; }
    this.failures.push({ rel, kind: 'FAIL', diffs });
  }

  async _screenshot(page, name) {
    if (this.visual === 'off') return;
    const rel = this.rel(`${name}.png`);
    this.produced.add(rel);
    try {
      await expect(page).toHaveScreenshot([this.name, `${name}.png`], {
        mask: [page.locator('canvas')],
        maxDiffPixelRatio: BROWSER_TOL.maxDiffPixelRatio ?? 0.02,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        fullPage: false,
        timeout: this.visual === 'strict' ? 10000 : 2500
      });
    } catch (e) {
      if (this.visual === 'strict') throw e;
      this.visualWarnings.push({ rel, message: firstLine(e.message) });
    }
  }

  // ---------------- finish ----------------
  /** MISSING check + assertion. In record/update mode only reports stale goldens. */
  async finish({ expectNoErrors = true } = {}) {
    const stale = listGoldens(`browser/${this.name}`).filter((rel) => !this.produced.has(rel) && !(this.visual === 'off' && rel.endsWith('.png')));
    const totalMs = Date.now() - this._t0;
    const lines = [];
    lines.push(`[golden:${this.mode}] ${this.name}: ${this.steps.length} steps, ${(totalMs / 1000).toFixed(1)} s`);
    for (const s of this.steps) lines.push(`  ${s.name.padEnd(36)} ${String(s.sinceLast).padStart(6)} ms`);
    for (const n of this.notes) lines.push(`  note: ${n}`);
    for (const w of this.visualWarnings) lines.push(`  visual (${this.visual}): ${w.rel}: ${w.message}`);
    if (this.mode === 'check') {
      for (const rel of stale) this.failures.push({ rel, kind: 'MISSING', diffs: [{ path: '<file>', expected: '<golden on disk>', actual: '<no longer produced>' }] });
    } else if (stale.length) {
      for (const rel of stale) lines.push(`  STALE ${rel} (golden exists, no longer produced — delete it)`);
    }
    console.log(lines.join('\n'));
    if (this.failures.length) {
      const msg = this.failures.map((f) => `${f.kind.padEnd(7)} ${f.rel}\n${formatDiffs(f.diffs)}`).join('\n');
      console.log(msg);
      console.log(`\n${this.failures.length} golden mismatch(es). Diff: git diff --no-index tests/golden/browser/${this.name} tests/golden/.actual/browser/${this.name}`);
    }
    if (expectNoErrors) expect(this.errors, `page/console errors:\n${this.errors.join('\n')}`).toEqual([]);
    expect(this.failures.map((f) => `${f.kind} ${f.rel}`), 'browser golden mismatches (see console output for the diff)').toEqual([]);
  }
}

/** Exists so a spec can guard optional steps ("only if the golden already exists or we are recording"). */
export function goldenExists(journey, file) {
  return existsSync(join(GOLDEN, 'browser', journey, file));
}
