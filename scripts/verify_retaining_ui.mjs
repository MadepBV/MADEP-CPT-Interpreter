#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Headless smoke test of the retaining-wall UI shell: state defaults/migration, renderBody() for
// every wall type, the panels, the result views with a real engine result, and the window handlers'
// state mutations (overrides, cohesion-for-all, tabs). The wasm engine runs through the JS bridge
// with a stubbed loader so the full state → request → result → view path is exercised under Node.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// minimal DOM stubs so render paths are safe under Node
const elements = new Map();
const makeEl = (id) => ({ id, innerHTML: '', getAttribute: () => null, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 800, height: 440, left: 0, top: 0 }), getContext: () => new Proxy({}, { get: () => () => ({}) }), style: {}, parentElement: null, textContent: '' });
globalThis.document = { getElementById: (id) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); }, createElement: () => makeEl('tmp'), querySelectorAll: () => [], body: { appendChild() {} } };
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, localStorage: null };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { installRetainingApp } = await import('../src/lib/cpt-app/retaining/retaining-ui.js');
const { defaults } = await import('../src/lib/cpt-app/retaining/wall-state.js');
const { buildRequest } = await import('../src/lib/cpt-app/retaining/request-builder.js');
const { computeEmbeddedStructural } = await import('../src/lib/cpt-app/retaining/results/embedded-structural.js');
const { checksView } = await import('../src/lib/cpt-app/retaining/results/checks-view.js');
const { branchesView } = await import('../src/lib/cpt-app/retaining/results/branches-view.js');
const { plaxisView } = await import('../src/lib/cpt-app/retaining/results/plaxis-view.js');
const { structuralView } = await import('../src/lib/cpt-app/retaining/results/structural-view.js');
const { summaryCard } = await import('../src/lib/cpt-app/retaining/results/summary-card.js');
const { vibrationView } = await import('../src/lib/cpt-app/retaining/panels/vibration-panel.js');
const { runDrivability, drivabilityView, drivabilityPanel } = await import('../src/lib/cpt-app/retaining/panels/drivability-panel.js');
const { buildEmbeddedScene } = await import('../src/lib/cpt-app/retaining/scenes/embedded-scene.js');
const { buildNotePayload } = await import('../src/lib/cpt-app/retaining/report/note-view.js');

const glue = await import(pathToFileURL(resolve(root, 'static/wasm/retaining/retaining.js')).href);
const M = await (glue.default || glue.createRetainingModule)({ wasmBinary: readFileSync(resolve(root, 'static/wasm/retaining/retaining.wasm')) });
function run(req) { const j = JSON.stringify(req); const l = M.lengthBytesUTF8(j); const p = M._malloc(l + 1); M.stringToUTF8(j, p, l + 1); const rp = M._madepRunRetainingAnalysis(p, l); const r = JSON.parse(M.UTF8ToString(rp)); M._madepFreeBuffer(rp); M._free(p); return r; }

let fails = 0;
const ok = (n, c) => { console.log(`${c ? 'OK  ' : 'FAIL'}  ${n}`); if (!c) fails++; };

const layers = [{ type: 'Sand', g: 19, gs: 21, phi: 33, c: 0, cu: 0, top: 0, bot: 8, avgQc: 12 }, { type: 'Clay', g: 17, gs: 17, phi: 22, c: 4, cu: 60, top: 8, bot: 20, avgQc: 1.2 }];
const cptTrace = { id: 'CPT-1', depth: Array.from({ length: 200 }, (_, i) => i * 0.1), qc: Array.from({ length: 200 }, (_, i) => (i < 80 ? 12 : 1.2)), fs: Array.from({ length: 200 }, (_, i) => (i < 80 ? 60 : 40)), waterTable: 2 };
const state = { stage6: {} };
let renderCount = 0;
const app = installRetainingApp({ getState: () => state, requestRender: () => { renderCount++; }, workingLayers: () => layers, getCpt: () => cptTrace, getProjectMeta: () => ({ projectName: 'Test', cptId: 'CPT-1' }) });

state.stage6.retwall = app.defaults();
app.ensure(state.stage6);
ok('default wallType cantilever', state.stage6.retwall.wallType === 'cantilever');
ok('ensure idempotent', (() => { app.ensure(state.stage6); return true; })());

for (const t of ['cantilever', 'gravity', 'sheetpile', 'anchored', 'soldierpile']) {
  state.stage6.retwall.wallType = t;
  const html = app.renderBody();
  ok(`renderBody(${t}) returns html`, typeof html === 'string' && html.length > 2000);
  ok(`renderBody(${t}) has canvas, inputs, summary, result tabs`, ['id="retwallCanvas"', 'id="retwallInputs"', 'id="retwallSummary"', 'id="retwallResultTabs"'].every((x) => html.includes(x)));
  ok(`renderBody(${t}) has all 5 wall tabs`, ['RC cantilever', 'Gravity', 'Sheet pile', 'Anchored sheet pile', 'Soldier pile'].every((x) => html.includes(x)));
  ok(`renderBody(${t}) has the soil profile panel with overrides`, html.includes('CPT ground level vs. reference') && html.includes('c′ for all layers'));
}

// handlers: overrides + cohesion for all
state.stage6.retwall.wallType = 'sheetpile';
const key = app.layerKey(layers[0], 0);
app.handlers.retwallOverride(key, 'c', '0.5');
ok('override stored under the layer key', state.stage6.retwall.profile.overrides[key].c === 0.5);
app.handlers.retwallSetAllC('0.2');
ok('c′ for all layers', Object.values(state.stage6.retwall.profile.overrides).every((o) => o.c === 0.2));
app.handlers.retwallClearOverrides();
ok('clear overrides', Object.keys(state.stage6.retwall.profile.overrides).length === 0);
app.handlers.retwallSet('ui.resultTab', 'plaxis');
ok('tab handler is a string path', state.stage6.retwall.ui.resultTab === 'plaxis');
app.handlers.retwallSet('embedded.embedment', '5.5');
ok('numeric handler parses', state.stage6.retwall.embedded.embedment === 5.5);
app.handlers.retwallSetType('soldierpile');
ok('type switch triggers a full render', state.stage6.retwall.wallType === 'soldierpile' && renderCount > 0);

// full path: state → request → engine → views (soldier pile with CPT layers, override on clay)
const rw = state.stage6.retwall;
rw.embedded.retainedHeight = 3.0; rw.embedded.embedment = 5.0; rw.profile.offset = -0.5;
rw.profile.overrides = { [app.layerKey(layers[1], 1)]: { c: 0.5, drained: true } };
const built = buildRequest(rw, layers);
ok('request built with shifted profile + override', built.request.retained.length === 2 && built.request.retained[1].c === 0.5 && built.request.retained[0].topEl === 3.0);
const result = run(built.request);
ok('engine ok (soldier pile)', result.ok && result.perPile && result.branches.length === 4 && result.tlat.length >= 2);
rw.result = result; rw.status = 'done';
const st = computeEmbeddedStructural(rw, result, built.profile);
ok('structural derived (steel, lagging, vertical, plaxis)', st && st.steel && st.lagging && st.vertical && st.plaxis.plate && st.plaxis.ebr && st.plaxis.tskin && st.plaxis.tlat.length >= 2);
ok('summary renders', summaryCard(rw, result, st).includes('Governing values'));
ok('checks view renders steel + lagging rows', (() => { const h = checksView(rw, result, st); return h.includes('Lagging plate') && h.includes('Bending'); })());
ok('branches view renders 4 cards', (branchesView(rw, result).match(/st6-rw-branchcard/g) || []).length >= 4);
ok('plaxis view renders EBR + T_lat', (() => { const h = plaxisView(rw, result, st); return h.includes('Embedded beam row') && h.includes('Multi-linear') && h.includes('data-copy'); })());
ok('structural view renders', structuralView(rw, result, st).includes('Steel checks'));
ok('vibration view renders', vibrationView(rw).includes('Receiver assessment'));
const drv = runDrivability(rw, cptTrace, layers);
ok('drivability (vibratory) runs on the CPT trace', drv.ok && drv.vibratory && drv.vibratory.FcRequired_kN > 0);
rw.drivability.result = drv; rw.drivability.status = 'done';
ok('drivability view renders', drivabilityView(rw).includes('Minimum vibrator'));
// data-sheet vibrator (SAES HST070 fixture) — drive-to-refusal outcome and carrier check
rw.drivability.vibrator.source = 'sheet';
Object.assign(rw.drivability.vibrator.sheet, { name: 'SAES HST070', force_kN: 205, rpmMax: 2900, rpmMin: 2400, amplitude_mm: 12, amplitudeConvention: 'pp', totalMass_kg: 965, flow_lmin: 175, flowMax_lmin: 215, pressure_bar: 200, pressureMax_bar: 230, power_kW: 66, carrierMin_t: 22, carrierMax_t: 37 });
Object.assign(rw.drivability.vibrator.carrier, { mass_t: 30, flow_lmin: 200, pressure_bar: 220 });
const drvSheet = runDrivability(rw, cptTrace, layers);
ok('data-sheet vibrator runs (derived M_e, M_dyn)', drvSheet.ok && drvSheet.datasheet?.ok && drvSheet.vibratory?.candidateCheck && Math.abs(drvSheet.datasheet.eccentricMoment_kgm - 2.2228) < 1e-3);
ok('data-sheet run reports an achievable / refusal depth', drvSheet.vibratory.candidateCheck.targetDepth_m > 0 && (drvSheet.vibratory.candidateCheck.reachesTarget || drvSheet.vibratory.candidateCheck.refusalDepth_m > 0));
ok('carrier check rows present', drvSheet.carrier?.rows?.length === 4 && drvSheet.carrier.rows.find((r) => r.id === 'class').ok === true);
rw.drivability.result = drvSheet; rw.drivability.status = 'done';
ok('data-sheet view renders the verdict and carrier table', (() => { const h = drivabilityView(rw); return h.includes('Will it drive the element?') && h.includes('Carrier check') && h.includes('Minimum vibrator'); })());
ok('drivability panel renders the data-sheet form with derived summary', (() => { const h = drivabilityPanel(rw); return h.includes('Centrifugal force') && h.includes('Derived') && h.includes('Your carrier'); })());
ok('section scene carries the drivability marker', (() => { const sc = buildEmbeddedScene(rw, rw.result, layers); return sc.dims.some((d) => /refusal|reaches|reserve/.test(d.text)); })());
rw.drivability.vibrator.source = 'required';
rw.drivability.srdMethod = 'alm-hamre';
const drvAH = runDrivability(rw, cptTrace, layers);
ok('drivability with Alm & Hamre SRD runs (layers passed in the module contract)', drvAH.ok && drvAH.profile?.method === 'alm-hamre' && drvAH.profile.almHamre?.soilType?.includes('clay'));
rw.drivability.srdMethod = 'reference';
rw.drivability.method = 'impact';
const drvI = runDrivability(rw, cptTrace, layers);
ok('drivability (impact) runs', drvI.ok && drvI.impact && drvI.impact.perDepth.length > 3);
const payload = buildNotePayload({ rw, layers, profile: built.profile, structural: st, vibration: null, meta: { projectName: 'T' } });
ok('note payload is JSON-serialisable and complete', JSON.stringify(payload).length > 10000 && payload.result.branches.length === 4 && payload.state.result === undefined);

// sheet pile path
rw.wallType = 'anchored'; rw.result = null;
const b2 = buildRequest(rw, layers); const r2 = run(b2.request); rw.result = r2;
const st2 = computeEmbeddedStructural(rw, r2, b2.profile);
ok('anchored sheet pile: steel check + plate set', st2.steel && st2.plaxis.plate && !st2.lagging && r2.structural.anchorForce > 0);
ok('plaxis view (sheet pile) renders plate table', plaxisView(rw, r2, st2).includes('Plate — continuous sheet pile'));

console.log(fails ? `\nFAILED: retaining ui verifier (${fails} failure${fails === 1 ? '' : 's'})` : '\nPASSED: retaining ui verifier');
process.exit(fails ? 1 : 0);
