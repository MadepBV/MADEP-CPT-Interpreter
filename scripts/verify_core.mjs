#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit checks for src/lib/cpt-app/core/* — the helpers moved out of
// legacy-controller.js in refactor step 1 (PR 4). The modules are pure ES
// modules, so they are imported directly under Node (no Vite, no DOM); the
// DOM-touching ones (readCssToken, destroyChart, dom.js) get a throw-away stub
// installed only for the cases that need it.
//
// Also asserts the extraction is complete: none of the moved names may be
// re-declared as a function inside legacy-controller.js again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { escAttr, escJsString, tooltip, noteHtml, auditTableHtml, loadSummaryHtml, compactNumber } = await import('../src/lib/cpt-app/core/format.js');
const { readCssToken } = await import('../src/lib/cpt-app/core/css-tokens.js');
const { destroyChart, attachChart, chartAvailable, waitForChart } = await import('../src/lib/cpt-app/core/chart-host.js');
const { byId, setText, setHtml, toggleClass } = await import('../src/lib/cpt-app/core/dom.js');

let fails = 0;
let count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').join('\n      ')}`); }
}

// ---------------------------------------------------------------- format.js
check('escAttr escapes & " < > and nothing else', () => {
  assert.equal(escAttr('a&b"c<d>e\'f'), 'a&amp;b&quot;c&lt;d&gt;e\'f');
  assert.equal(escAttr('plain 1.5 m'), 'plain 1.5 m');
});
check('escAttr: null/undefined → "", numbers stringified, double-escape is literal', () => {
  assert.equal(escAttr(null), '');
  assert.equal(escAttr(undefined), '');
  assert.equal(escAttr(0), '0');
  assert.equal(escAttr(12.5), '12.5');
  assert.equal(escAttr('&amp;'), '&amp;amp;');
});
check('escJsString = escAttr(JSON.stringify(String(v)))', () => {
  assert.equal(escJsString('CPT-1'), '&quot;CPT-1&quot;');
  assert.equal(escJsString('a"b'), '&quot;a\\&quot;b&quot;');
  assert.equal(escJsString('x<y'), '&quot;x&lt;y&quot;');
  assert.equal(escJsString(null), '&quot;&quot;');
  assert.equal(escJsString(3), '&quot;3&quot;');
});
check('tooltip wraps the escaped text in the .st6-tip span with ⓘ', () => {
  const html = tooltip('B′ < L′ & "safe"');
  assert.equal(html, '<span class="st6-tip" tabindex="0" data-tip="B′ &lt; L′ &amp; &quot;safe&quot;" aria-label="B′ &lt; L′ &amp; &quot;safe&quot;">ⓘ</span>');
});
check('noteHtml: empty/null → "", one .info div per note with level colours', () => {
  assert.equal(noteHtml(null), '');
  assert.equal(noteHtml([]), '');
  const html = noteHtml([{ level: 'warn', text: 'W' }, { level: 'error', text: 'E' }, { level: 'info', text: 'I' }]);
  assert.equal(html,
    '<div class="info" style="margin-top:8px;background:var(--wnl);border-color:var(--wn)">W</div>'
    + '<div class="info" style="margin-top:8px;background:var(--bad-soft);border-color:var(--bad)">E</div>'
    + '<div class="info" style="margin-top:8px;background:var(--bg2);border-color:var(--ac)">I</div>');
});
check('auditTableHtml: one <th> per key, one <td> per value, unescaped (callers escape)', () => {
  const html = auditTableHtml([{ k: 'B', v: '1.5 m' }, { k: 'q<sub>d</sub>', v: '<b>320</b> kPa' }]);
  assert.ok(html.includes('<table class="tbl st6-audit">'));
  assert.ok(html.includes('<thead><tr><th>B</th><th>q<sub>d</sub></th></tr></thead>'));
  assert.ok(html.includes('<tbody><tr><td>1.5 m</td><td><b>320</b> kPa</td></tr></tbody>'));
});
check('loadSummaryHtml embeds the title and the audit table', () => {
  const html = loadSummaryHtml('Load summary', [{ k: 'G', v: '10' }]);
  assert.ok(html.includes('>Load summary</div>'));
  assert.ok(html.includes(auditTableHtml([{ k: 'G', v: '10' }])));
});
check('compactNumber: non-finite → "—", zero → "0"', () => {
  assert.equal(compactNumber(NaN), '—');
  assert.equal(compactNumber('abc'), '—');
  assert.equal(compactNumber(Infinity), '—');
  assert.equal(compactNumber(null), '0'); // Number(null) === 0, as in the monolith
  assert.equal(compactNumber(0), '0');
  assert.equal(compactNumber(-0), '0');
});
check('compactNumber: exponential below 1e-2 and at/above 1e4, "E" notation, digits-1 decimals', () => {
  assert.equal(compactNumber(12345), '1.2E+4');
  assert.equal(compactNumber(12345, 3), '1.23E+4');
  assert.equal(compactNumber(12345, 1), '1E+4');
  assert.equal(compactNumber(1e4), '1.0E+4');
  assert.equal(compactNumber(0.001), '1.0E-3');
  assert.equal(compactNumber(-0.0042), '-4.2E-3');
});
check('compactNumber: fixed bands 100+ / 10+ / 1+ / <1 with trailing zeros stripped', () => {
  assert.equal(compactNumber(100), '100');
  assert.equal(compactNumber(123.45), '123.5');
  assert.equal(compactNumber(99.999), '100');
  assert.equal(compactNumber(12.5), '12.5');
  assert.equal(compactNumber(10), '10');
  assert.equal(compactNumber(1.5), '1.5');
  assert.equal(compactNumber(1), '1');
  assert.equal(compactNumber(0.5), '0.5');
  assert.equal(compactNumber(0.25), '0.25');
  assert.equal(compactNumber(0.0123), '0.0123');
  assert.equal(compactNumber(0.01), '0.01');
  assert.equal(compactNumber('2.5'), '2.5');
});

// ---------------------------------------------------------------- css-tokens.js
check('readCssToken: no document → fallback', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(readCssToken('--chart-red', '#9B3A32'), '#9B3A32');
});
check('readCssToken: stub getComputedStyle → trimmed token, empty → fallback', () => {
  const seen = [];
  globalThis.document = { documentElement: { tag: 'html' } };
  globalThis.getComputedStyle = (el) => ({ getPropertyValue: (name) => { seen.push([el, name]); return name === '--chart-red' ? '  #c0392b \n' : ''; } });
  try {
    assert.equal(readCssToken('--chart-red', '#9B3A32'), '#c0392b');
    assert.equal(readCssToken('--missing', 'fb'), 'fb');
    assert.deepEqual(seen, [[globalThis.document.documentElement, '--chart-red'], [globalThis.document.documentElement, '--missing']]);
  } finally {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

// ---------------------------------------------------------------- chart-host.js
function withDom(fn) {
  const els = new Map();
  const mk = (id) => {
    const classes = new Set();
    return { id, textContent: '', innerHTML: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)), contains: (c) => classes.has(c) } };
  };
  globalThis.document = { getElementById: (id) => els.get(id) || null, _add: (id) => { els.set(id, mk(id)); return els.get(id); } };
  try { return fn(globalThis.document); }
  finally { delete globalThis.document; }
}
check('destroyChart: destroys canvas._chartRef when present and returns the canvas; null when absent', () => {
  withDom((doc) => {
    let destroyed = 0;
    const canvas = doc._add('c1');
    canvas._chartRef = { destroy: () => { destroyed++; } };
    assert.equal(destroyChart('c1'), canvas);
    assert.equal(destroyed, 1);
    const bare = doc._add('c2');
    assert.equal(destroyChart('c2'), bare);
    bare._chartRef = {};
    assert.equal(destroyChart('c2'), bare);
    assert.equal(destroyChart('nope'), null);
  });
});
check('attachChart sets canvas._chartRef and returns the chart; null canvas → null', () => {
  const canvas = {};
  const chart = { id: 'x' };
  assert.equal(attachChart(canvas, chart), chart);
  assert.equal(canvas._chartRef, chart);
  assert.equal(attachChart(null, chart), null);
});
check('chartAvailable / waitForChart follow the global Chart', () => {
  assert.equal(typeof globalThis.Chart, 'undefined');
  assert.equal(chartAvailable(), false);
  let calls = 0;
  const timers = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push([fn, ms]); return 1; };
  try {
    assert.equal(waitForChart(() => { calls++; }, 120), false);
    assert.equal(calls, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0][1], 120);
    globalThis.Chart = function Chart() {};
    timers[0][0]();
    assert.equal(calls, 1);
    assert.equal(waitForChart(() => { calls++; }), true);
    assert.equal(calls, 2);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete globalThis.Chart;
  }
});

// ---------------------------------------------------------------- dom.js
check('dom helpers are no-ops without a document', () => {
  assert.equal(byId('x'), null);
  assert.equal(setText('x', 'a'), null);
  assert.equal(setHtml('x', 'a'), null);
  assert.equal(toggleClass('x', 'on', true), null);
});
check('byId / setText / setHtml / toggleClass against a stub document', () => {
  withDom((doc) => {
    const el = doc._add('lb');
    assert.equal(byId('lb'), el);
    assert.equal(byId('missing'), null);
    assert.equal(setText('lb', '-> 5 layers'), el);
    assert.equal(el.textContent, '-> 5 layers');
    assert.equal(setHtml('lb', '<b>x</b>'), el);
    assert.equal(el.innerHTML, '<b>x</b>');
    toggleClass('lb', 'active', true); assert.ok(el.classList.contains('active'));
    toggleClass('lb', 'active', false); assert.ok(!el.classList.contains('active'));
    toggleClass('lb', 'active'); assert.ok(el.classList.contains('active'));
    toggleClass('lb', 'active'); assert.ok(!el.classList.contains('active'));
    assert.equal(setText('missing', 'x'), null);
  });
});

// ---------------------------------------------------------------- extraction complete
check('legacy-controller.js no longer declares the moved helpers and imports them from core/', () => {
  const src = readFileSync(resolve(ROOT, 'src/lib/cpt-app/legacy-controller.js'), 'utf8');
  const moved = ['stage6EscAttr', 'stage6EscJsString', 'stage6Tooltip', 'stage6NoteHtml', 'stage6AuditTableHtml', 'stage6LoadSummaryHtml', 'stage6CompactNumber', 'readCssToken', 'stage6DestroyChart'];
  for (const name of moved) {
    assert.ok(!new RegExp(`^function ${name}\\(`, 'm').test(src), `${name} is still declared in legacy-controller.js`);
  }
  assert.ok(/from '\.\/core\/format\.js'/.test(src), 'core/format.js import missing');
  assert.ok(/from '\.\/core\/css-tokens\.js'/.test(src), 'core/css-tokens.js import missing');
  assert.ok(/from '\.\/core\/chart-host\.js'/.test(src), 'core/chart-host.js import missing');
});

console.log(`\n${count - fails}/${count} checks passed`);
if (fails) process.exit(1);
