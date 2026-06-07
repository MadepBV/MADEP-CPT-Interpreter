#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Headless smoke test of the retaining-wall UI module: state defaults, ensure(),
// renderBody() HTML generation, renderResults with a fake engine result, and the
// window handlers' state mutations. Does not exercise the wasm loader (browser-only
// path) — the engine itself is covered by verify_retaining_wasm.mjs.
import assert from 'node:assert';

// minimal DOM stubs so module-level + render paths are safe under Node
globalThis.document = { getElementById: () => null, createElement: () => ({ getContext: () => ({}) }) };
globalThis.window = {};

const { installRetainingApp } = await import('../src/lib/cpt-app/retaining/retaining-ui.js');

let fails = 0;
const ok = (n, c) => { console.log(`${c ? 'OK  ' : 'FAIL'}  ${n}`); if (!c) fails++; };

// mock state + context
const state = { stage6: {} };
const layers = [{ type: 'Sand', g: 19, gs: 21, phi: 33, c: 0, cu: 0, top: 0, bot: 8 }];
let renderCount = 0;
const app = installRetainingApp({
  getState: () => state,
  requestRender: () => { renderCount++; },
  workingLayers: () => layers
});

// defaults + ensure
state.stage6.retwall = app.defaults();
app.ensure(state.stage6);
ok('default wallType cantilever', state.stage6.retwall.wallType === 'cantilever');
ok('ensure idempotent (no throw)', (() => { app.ensure(state.stage6); return true; })());

// renderBody for each wall type
for (const t of ['cantilever', 'gravity', 'sheetpile', 'anchored']) {
  state.stage6.retwall.wallType = t;
  const html = app.renderBody();
  ok(`renderBody(${t}) returns html`, typeof html === 'string' && html.length > 500);
  ok(`renderBody(${t}) has canvas`, html.includes('id="retwallCanvas"'));
  ok(`renderBody(${t}) has results region`, html.includes('id="retwallResults"'));
  ok(`renderBody(${t}) has all 4 tabs`, ['RC cantilever', 'Gravity', 'Sheet pile', 'Anchored'].every((x) => html.includes(x)));
}

// renderResults via a fake engine result embedded in state
state.stage6.retwall.wallType = 'cantilever';
state.stage6.retwall.status = 'done';
state.stage6.retwall.result = {
  ok: true, wallType: 'cantilever', overallPass: false, maxUtil: 1.4,
  checks: [
    { id: 'sliding', label: 'Base sliding (GEO)', combo: 'C2', comboLabel: 'DA1 C2', verb: 'H_d <= R_d', Ed: 150, Rd: 170, unit: 'kN/m', util: 0.88, pass: true, extra: [{ key: 'B_eff', value: 2.1, unit: 'm' }] },
    { id: 'bearing', label: 'Base bearing (GEO)', combo: 'C2', comboLabel: 'DA1 C2', verb: 'V_d <= R_d', Ed: 300, Rd: 210, unit: 'kN/m', util: 1.4, pass: false, extra: [] }
  ],
  structural: { stem: { M: 277, V: 138, combo: 'C1' }, toe: { M: 65, V: 40, combo: 'C1' }, heel: { M: 270, V: 120, combo: 'C1' } },
  diagrams: [], summary: [], notes: ['Both DA1 combinations evaluated.']
};
const html = app.renderBody();
ok('results show governing util', html.includes('1.40'));
ok('results show PASS and FAIL badges', html.includes('PASS') && html.includes('FAIL'));
ok('results show structural stem moment', html.includes('277'));
ok('verdict NOT VERIFIED when a check fails', html.includes('NOT VERIFIED'));

// handlers
app.handlers.retwallSetType('sheetpile');
ok('retwallSetType mutates wallType', state.stage6.retwall.wallType === 'sheetpile');
ok('retwallSetType requests render', renderCount > 0);

app.handlers.retwallSet('embedded.retainedHeight', '7.5');
ok('retwallSet parses number', state.stage6.retwall.embedded.retainedHeight === 7.5);
app.handlers.retwallSet('settings.assumeCrackWater', false);
ok('retwallSet keeps boolean', state.stage6.retwall.settings.assumeCrackWater === false);

app.handlers.retwallPullCpt();
ok('retwallPullCpt reads CPT phi', state.stage6.retwall.insitu.phi === 33);
ok('retwallPullCpt marks source cpt', state.stage6.retwall.insitu.source === 'cpt');

console.log(`\n${fails ? 'FAILED' : 'PASS'}: retaining UI smoke (${fails} failure${fails === 1 ? '' : 's'})`);
process.exit(fails ? 1 : 0);
