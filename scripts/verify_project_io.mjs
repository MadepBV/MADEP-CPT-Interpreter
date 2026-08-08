#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification of project save/load (project-io):
//   - full snapshot → JSON → restore round-trip preserves the engineer's work
//     (data rows, layer models incl. manual overrides, settings, stage6,
//     stratigraphy, phase/stage position)
//   - volatile runtime state (charts, caches) is stripped on save and fresh
//     after load — even when it contains circular references
//   - restored stratigraphy is NOT stale (fingerprint survives the trip)
//   - forward compatibility: fields missing from older saves keep defaults
//   - validation rejects foreign files

import {
  buildProjectSnapshot,
  validateProjectSnapshot,
  applyProjectSnapshot,
  PROJECT_SNAPSHOT_KIND
} from '../src/lib/cpt-app/project-io/snapshot.js';
import { createStratigraphyStore } from '../src/lib/cpt-app/stratigraphy/store.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Mirror of the app's newCptState defaults (subset + a future-field probe).
function newCptState(id) {
  return {
    id: id || 'CPT',
    x: null,
    y: null,
    data: [],
    wt: 1.7,
    wtFromFile: false,
    elev: null,
    minThk: 0.5,
    smartMerge: true,
    method: 'robertson2016',
    assumedRf: 3.0,
    stage6: { app: 'bearing', depth: 1.2, futureField: 'default-kept' },
    stage6Cache: {},
    classified: [],
    layers: [],
    charts: {},
    chartsReady: false,
    meta: {},
    _maxStage: 0
  };
}

function layer(top, bot, type, subtype, ovr = {}) {
  return { id: 0, top, bot, type, subtype, avgQc: 5, avgFs: null, avgRf: 2, g: 18, gs: 20, phi: 30, c: 0, cu: 0, ovr };
}

function makeProject() {
  const c1 = newCptState('S1');
  c1.x = 0;
  c1.y = 0;
  c1.elev = 10;
  c1.data = [{ z: 0.1, qc: 5, fs: 0.05, rf: 1, u2: null }, { z: 6, qc: 1.2, fs: 0.05, rf: 4, u2: null }];
  c1.layers = [layer(0, 3, 'Sand', 'zand, matig'), layer(3, 6, 'Clay', 'klei, matig', { aE: true })];
  c1.layers[1].subtype = 'klei, vast'; // manual engineer edit
  c1._maxStage = 3;
  // Volatile junk with a circular reference — must never reach the file.
  c1.charts = { qc: { canvas: {} } };
  c1.charts.qc.self = c1.charts.qc;
  c1.chartsReady = true;
  c1.stage6Cache = { big: new Array(10).fill({ x: 1 }) };

  const c2 = newCptState('S2');
  c2.x = 30;
  c2.y = 0;
  c2.elev = 10.4;
  c2.data = [{ z: 0.1, qc: 5, fs: 0.05, rf: 1, u2: null }];
  c2.layers = [layer(0, 3.2, 'Sand', 'zand, matig'), layer(3.2, 6.1, 'Clay', 'klei, matig')];

  return {
    name: 'Delaere K Oostende',
    cpts: [c1, c2],
    activeCptIdx: 1,
    phase: 'correlation',
    stratigraphy: null,
    sectionOrder: [0, 1]
  };
}

console.log('\n[1] snapshot build + serialisation');
const project = makeProject();
// Correlate so stratigraphy state (with a manual rename) is part of the save.
const store = createStratigraphyStore({ getProject: () => project, layerParamsFor: null });
store.run();
store.renameUnit(project.stratigraphy.result.units[0].id, 'Quartair zand');

const snapshot = buildProjectSnapshot(project, { activeStage: 3, savedAt: '2026-08-08T18:00:00Z', appVersion: '0.5.3' });
let text = '';
let serialised = true;
try {
  text = JSON.stringify(snapshot);
} catch {
  serialised = false;
}
check('serialises despite circular chart refs', serialised);
check('volatile keys absent from file', !text.includes('chartsReady') && !text.includes('stage6Cache'));
check('data + layers + stratigraphy present', text.includes('"z":0.1') && text.includes('klei, vast') && text.includes('Quartair zand'));
check('kind + version stamped', snapshot.kind === PROJECT_SNAPSHOT_KIND && snapshot.version === 1);

console.log('\n[2] validation');
const parsed = JSON.parse(text);
check('round-tripped snapshot validates', validateProjectSnapshot(parsed));
check('foreign JSON rejected', !validateProjectSnapshot({ hello: 'world' }));
check('wrong kind rejected', !validateProjectSnapshot({ ...parsed, kind: 'other' }));

console.log('\n[3] restore round-trip');
const fresh = { name: 'CPT Project', cpts: [newCptState('CPT-1')], activeCptIdx: 0, phase: 'analysis', stratigraphy: null, sectionOrder: [0] };
const position = applyProjectSnapshot(fresh, parsed, { newCptState });
check('project name restored', fresh.name === 'Delaere K Oostende');
check('both CPTs restored', fresh.cpts.length === 2 && fresh.cpts[0].id === 'S1' && fresh.cpts[1].id === 'S2');
check('data rows intact', fresh.cpts[0].data.length === 2 && fresh.cpts[0].data[1].qc === 1.2);
check('manual layer edit intact', fresh.cpts[0].layers[1].subtype === 'klei, vast' && fresh.cpts[0].layers[1].ovr.aE === true);
check('stage position returned', position.activeCptIdx === 1 && position.activeStage === 3 && position.phase === 'correlation');
check('_maxStage restored (stage nav unlocks)', fresh.cpts[0]._maxStage === 3);
check('volatile state fresh after load', fresh.cpts[0].chartsReady === false && Object.keys(fresh.cpts[0].charts).length === 0 && Object.keys(fresh.cpts[0].stage6Cache).length === 0);
check('future default kept (forward compat)', fresh.cpts[0].stage6.futureField === 'default-kept');
check('saved stage6 values win over defaults', fresh.cpts[0].stage6.depth === 1.2);

console.log('\n[4] stratigraphy survives the round-trip fresh');
const restoredStore = createStratigraphyStore({ getProject: () => fresh, layerParamsFor: null });
const derived = restoredStore.derived();
check('result present after load', derived.hasResult);
check('NOT stale (fingerprint matches restored layers)', !derived.stale);
check('units + manual rename intact', derived.units.length === 2 && derived.units.some((u) => u.name === 'Quartair zand'));
check('section polygons render from restored state', derived.polygons.length === 2);

console.log('\n[5] older save missing newer fields');
const older = JSON.parse(text);
delete older.project.cpts[0].assumedRf;
delete older.project.stratigraphy;
const fresh2 = { name: 'x', cpts: [newCptState('CPT-1')], activeCptIdx: 0, phase: 'analysis', stratigraphy: null, sectionOrder: [0] };
applyProjectSnapshot(fresh2, older, { newCptState });
check('missing field falls back to default', fresh2.cpts[0].assumedRf === 3.0);
check('missing stratigraphy → null (clean state)', fresh2.stratigraphy === null);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll project-io checks passed.');
process.exit(failures ? 1 : 0);
