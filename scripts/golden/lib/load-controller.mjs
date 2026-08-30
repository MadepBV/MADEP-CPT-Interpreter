// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier B loader: brings src/lib/cpt-app/legacy-controller.js (18 503 lines, browser-only
// by construction — extension-less imports, a Vite `define`, top-level DOM access) up
// under Node through Vite's SSR module loader plus a hand-rolled DOM stub, so the
// monolith's OWN functions (runClass, detectLayers, hsParams, fitLayer, bearingProfile,
// exportCSV, buildStage7Payload, …) can be locked by goldens before each extraction.
// Design: worklog/refactor/03-characterization-tests.md §2.2 (findings F3, F4).
//
// Stub approach (not happy-dom): every element is an auto-created plain object;
// `innerHTML`/`textContent` are plain data properties read back as text goldens;
// `<a download>` clicks are captured (data: and blob: hrefs); `alert()` is captured;
// `Chart` is a stub that keeps the config it was built with (stops the 120 ms poll of
// initCharts, :1670); `requestAnimationFrame` runs synchronously so chart/canvas side
// effects are deterministic and complete before a snapshot is taken; the import-review
// overlay (import-review/modal.js) is auto-confirmed the moment it is appended to
// document.body, so parseGEF/parseCsvCpt/parseExcelCpt run their real path.
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT } from './store.mjs';

const CTRL_PATH = '/src/lib/cpt-app/legacy-controller.js';

function memoryStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _map: m
  };
}

function makeClassList() {
  const s = new Set();
  return {
    add: (...c) => c.forEach((x) => s.add(x)),
    remove: (...c) => c.forEach((x) => s.delete(x)),
    toggle(c, force) { const on = force === undefined ? !s.has(c) : !!force; on ? s.add(c) : s.delete(c); return on; },
    contains: (c) => s.has(c),
    get value() { return [...s].join(' '); }
  };
}

const ctx2d = new Proxy({}, { get: (_, k) => (k === 'canvas' ? {} : () => ({ width: 0 })) });

export function installDomStub() {
  const captured = [];   // { href, download, text? } — every <a download> click
  const alerts = [];
  const opened = [];     // window.open urls
  const appended = [];   // elements appended to document.body
  const rafErrors = [];
  const importReviews = [];   // overlay innerHTML captured when auto-applied
  const blobs = new Map();
  const els = new Map();
  let blobSeq = 0;

  function mkEl(tag, id = '') {
    const listeners = {};
    const attrs = new Map();
    const el = {
      tagName: String(tag).toUpperCase(), id, className: '', innerHTML: '', textContent: '', innerText: '', value: '', checked: false, disabled: false, open: false,
      style: {}, dataset: {}, href: '', download: '', title: '', type: '', name: '',
      scrollTop: 0, scrollLeft: 0, scrollHeight: 0, scrollWidth: 0,
      width: 800, height: 400, offsetWidth: 800, offsetHeight: 400, clientWidth: 800, clientHeight: 400,
      parentElement: null, parentNode: null, children: [], childNodes: [], firstChild: null, nextSibling: null,
      classList: makeClassList(),
      getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
      setAttribute: (n, v) => { attrs.set(n, String(v)); if (n === 'id') el.id = String(v); },
      removeAttribute: (n) => { attrs.delete(n); },
      hasAttribute: (n) => attrs.has(n),
      querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
      querySelectorAll(sel) {
        // The import-review dialog binds its buttons through querySelectorAll('[data-ir]')
        // (modal.js:86); hand it stable button objects so the auto-apply can click one.
        if (/\[data-ir/.test(sel)) {
          if (!el._ir) el._ir = { cancel: mkEl('button'), apply: mkEl('button') };
          el._ir.cancel.dataset.ir = 'cancel'; el._ir.apply.dataset.ir = 'apply';
          const m = sel.match(/data-ir="?(\w+)/);
          return m ? [el._ir[m[1]]].filter(Boolean) : [el._ir.cancel, el._ir.apply];
        }
        return [];
      },
      appendChild(c) { el.children.push(c); c.parentElement = el; c.parentNode = el; if (el === document.body) onBodyAppend(c); return c; },
      removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
      insertBefore(c) { el.children.unshift(c); return c; },
      insertAdjacentHTML() {}, insertAdjacentElement() {},
      remove() { if (el.parentElement) el.parentElement.removeChild(el); },
      addEventListener(t, fn) { (listeners[t] ??= []).push(fn); },
      removeEventListener(t, fn) { if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn); },
      dispatchEvent() { return true; },
      getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400, x: 0, y: 0 }),
      getContext: () => ctx2d,
      toDataURL: () => 'data:image/png;base64,',
      focus() {}, blur() {}, select() {}, scrollIntoView() {},
      closest: () => null, contains: () => false, matches: () => false,
      cloneNode() { return mkEl(tag, id); },
      click() {
        if (el.tagName === 'A' && (el.href || el.download)) {
          const entry = { href: el.href, download: el.download };
          if (blobs.has(el.href)) entry.blob = blobs.get(el.href);
          captured.push(entry);
        }
        (listeners.click || []).forEach((fn) => fn({ target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} }));
      },
      _listeners: listeners
    };
    return el;
  }

  function onBodyAppend(node) {
    appended.push(node);
    if (node.className === 'import-review-overlay') {
      // modal.js appends the overlay first, then renders and binds its buttons synchronously;
      // a macrotask later the apply button exists and can be clicked.
      setTimeout(() => {
        importReviews.push(node.innerHTML);
        node._ir?.apply?.click();
      }, 0);
    }
  }

  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, mkEl('div', id)); return els.get(id); },
    createElement: (t) => mkEl(t),
    createElementNS: (_ns, t) => mkEl(t),
    createTextNode: (t) => ({ textContent: t, nodeType: 3 }),
    createDocumentFragment: () => mkEl('fragment'),
    querySelector(sel) { const key = 'sel:' + sel; if (!els.has(key)) els.set(key, mkEl('div')); return els.get(key); },
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener() {}, removeEventListener() {}, execCommand: () => true,
    activeElement: null, readyState: 'complete', title: '',
    body: null, documentElement: null, head: null
  };
  document.body = mkEl('body'); document.documentElement = mkEl('html'); document.head = mkEl('head');
  document.documentElement.style = {};

  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.location = { hash: '', origin: 'http://localhost:5199', href: 'http://localhost:5199/', pathname: '/', search: '', protocol: 'http:', host: 'localhost:5199' };
  globalThis.devicePixelRatio = 1; globalThis.innerWidth = 1500; globalThis.innerHeight = 950; globalThis.scrollY = 0; globalThis.scrollX = 0;
  globalThis.scrollTo = () => {}; globalThis.scroll = () => {};
  globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {}; globalThis.dispatchEvent = () => true;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => { try { fn(0); } catch (e) { rafErrors.push(String(e?.stack || e)); } return 0; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.requestIdleCallback = (fn) => { try { fn({ timeRemaining: () => 0, didTimeout: false }); } catch (e) { rafErrors.push(String(e?.stack || e)); } return 0; };
  globalThis.alert = (m) => { alerts.push(String(m)); };
  globalThis.confirm = () => true;
  globalThis.prompt = () => null;
  globalThis.open = (url) => { opened.push(String(url)); return null; };
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  globalThis.Chart = class ChartStub {
    constructor(canvas, config) { this.canvas = canvas; this.config = config; this.data = config?.data || { datasets: [] }; this.options = config?.options || {}; }
    update() {} destroy() {} resize() {} reset() {} toBase64Image() { return 'data:image/png;base64,'; }
    static register() {}
  };
  globalThis.Chart.defaults = { font: {}, plugins: {} };
  globalThis.Worker = undefined;   // bishop / seepage / deformation workers are guarded (:7665, :7713, :7789)
  globalThis.Image = class { constructor() { this.onload = null; } set src(v) { this._src = v; } };
  globalThis.HTMLElement = class {}; globalThis.HTMLCanvasElement = class {}; globalThis.Element = class {}; globalThis.Node = class {};
  globalThis.FileReader = class {
    readAsText(file) { file.text().then((r) => this.onload?.({ target: { result: r } }), (e) => this.onerror?.(e)); }
    readAsArrayBuffer(file) { file.arrayBuffer().then((r) => this.onload?.({ target: { result: r } }), (e) => this.onerror?.(e)); }
  };
  URL.createObjectURL = (blob) => { const id = `blob:stub/${++blobSeq}`; blobs.set(id, blob); return id; };
  URL.revokeObjectURL = () => {};
  globalThis.__APP_VERSION__ = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;   // vite define (vite.config.ts:11)

  const elementText = (id) => document.getElementById(id).innerHTML;
  return { captured, alerts, opened, appended, rafErrors, importReviews, elementText, document, blobs, els };
}

let loaded = null;

/**
 * Load the controller once (idempotent for the process). Returns
 * { api: globalThis (== window, carrying the composed handler surface), captured, alerts, …, close() }.
 */
export async function loadController() {
  if (loaded) return loaded;
  const stub = installDomStub();
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
  const ctl = await server.ssrLoadModule(CTRL_PATH);
  ctl.initLegacyController();   // Object.assign(window, handlers) — the union of the packages' maps
  loaded = {
    api: globalThis,
    ...stub,
    async close() { await server.close(); loaded = null; }
  };
  return loaded;
}

/** Text of a stub element's innerHTML (the Node stand-in for innerText, see html-text.mjs). */
export function elementHtml(id) {
  return globalThis.document.getElementById(id).innerHTML;
}
