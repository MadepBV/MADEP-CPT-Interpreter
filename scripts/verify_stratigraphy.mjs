#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification of the multi-CPT stratigraphy engine:
//   - consistent layering correlates into one unit per bed, no crossings
//   - a local lens pinches out (member count, lobe geometry, half-distance)
//   - lithologically incompatible layers never share a unit
//   - dipping strata still correlate across an elevation offset
//   - unit property aggregation (thickness weighting, envelopes, char. min)
//   - store lifecycle: staleness detection, manual reassignment
//   - SOILIN report payload: fixed unit order, zero-thickness absents
//   - determinism

import { buildProfiles } from '../src/lib/cpt-app/stratigraphy/profiles.js';
import { alignSequences } from '../src/lib/cpt-app/stratigraphy/alignment.js';
import { correlateProfiles } from '../src/lib/cpt-app/stratigraphy/correlate.js';
import { deriveUnitProperties } from '../src/lib/cpt-app/stratigraphy/units.js';
import { buildSectionPolygons } from '../src/lib/cpt-app/stratigraphy/geometry.js';
import { createStratigraphyStore } from '../src/lib/cpt-app/stratigraphy/store.js';
import { buildSoilinReportPayload } from '../src/lib/cpt-app/stratigraphy/soilin-report.js';
import { buildUnitsCsv, buildPlaxisUnitCommands } from '../src/lib/cpt-app/stratigraphy/exports.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function layer(top, bot, type, subtype, props = {}) {
  return {
    top,
    bot,
    type,
    subtype,
    avgQc: props.qc ?? 5,
    avgFs: props.fs ?? null,
    avgRf: props.rf ?? 2,
    g: props.g ?? 18,
    gs: props.gs ?? 20,
    phi: props.phi ?? 30,
    c: props.c ?? 0,
    cu: props.cu ?? 0,
    ovr: {}
  };
}

function cpt(id, x, elev, layers) {
  return { id, x, y: 0, elev, wt: 1.5, data: [], layers, meta: {} };
}

const SAND = (top, bot, props = {}) => layer(top, bot, 'Sand', 'zand, matig', { qc: 12, rf: 0.7, phi: 32.5, ...props });
const CLAY = (top, bot, props = {}) => layer(top, bot, 'Clay', 'klei, matig', { qc: 1.2, rf: 4, phi: 22, c: 10, cu: 50, ...props });
const PEAT = (top, bot, props = {}) => layer(top, bot, 'Peat / organic', 'veen, matig vast', { qc: 0.6, rf: 7, phi: 15, c: 5, cu: 20, ...props });
const GRAVEL = (top, bot, props = {}) => layer(top, bot, 'Gravel', 'grind, matig', { qc: 22, rf: 0.5, phi: 37.5, ...props });

// ── 1. consistent three-bed profile over three CPTs ───────────────────────

console.log('\n[1] consistent stratigraphy — one unit per bed');
{
  const project = {
    name: 'test',
    cpts: [
      cpt('C1', 0, 10.0, [SAND(0, 3), CLAY(3, 6), SAND(6, 12, { qc: 15 })]),
      cpt('C2', 30, 10.4, [SAND(0, 3.4), CLAY(3.4, 6.2), SAND(6.2, 12, { qc: 14 })]),
      cpt('C3', 60, 9.8, [SAND(0, 2.8), CLAY(2.8, 5.9), SAND(5.9, 11.5, { qc: 16 })])
    ]
  };
  const profiles = buildProfiles(project);
  check('3 eligible CPTs', profiles.cpts.length === 3);
  check('chainage normalised to 0', profiles.cpts[0].dist === 0);

  const { units, links } = correlateProfiles(profiles);
  check('3 units', units.length === 3, `got ${units.length}`);
  check('every unit has 3 members', units.every((u) => u.members.length === 3));

  // Superposition: units sorted top→bottom, per-CPT layer order preserved.
  const orderPerCpt = new Map();
  units.forEach((u, ui) =>
    u.members.forEach((m) => {
      if (!orderPerCpt.has(m.cptIdx)) orderPerCpt.set(m.cptIdx, []);
      orderPerCpt.get(m.cptIdx).push({ ui, layerIdx: m.layerIdx });
    })
  );
  let monotone = true;
  orderPerCpt.forEach((list) => {
    list.sort((a, b) => a.ui - b.ui);
    for (let i = 1; i < list.length; i++) if (list[i].layerIdx <= list[i - 1].layerIdx) monotone = false;
  });
  check('no crossing correlations (superposition)', monotone);
  check('pairwise links are monotone', (() => {
    for (let k = 0; k < 2; k++) {
      const pair = links.filter((l) => l.a === k);
      for (let i = 1; i < pair.length; i++) {
        if (pair[i].ia <= pair[i - 1].ia || pair[i].ib <= pair[i - 1].ib) return false;
      }
    }
    return true;
  })());

  const again = correlateProfiles(buildProfiles(project));
  check('deterministic', JSON.stringify(again.units) === JSON.stringify(units));
}

// ── 2. lens: peat bed only in the middle CPT ──────────────────────────────

console.log('\n[2] lens — local bed pinches out both ways');
{
  const project = {
    name: 'lens',
    cpts: [
      cpt('C1', 0, 10.0, [SAND(0, 3), CLAY(3, 6), SAND(6, 12, { qc: 15 })]),
      cpt('C2', 30, 10.0, [SAND(0, 3), CLAY(3, 5), PEAT(5, 6.2), SAND(6.2, 12, { qc: 15 })]),
      cpt('C3', 60, 10.0, [SAND(0, 3), CLAY(3, 6), SAND(6, 12, { qc: 15 })])
    ]
  };
  const profiles = buildProfiles(project);
  const { units } = correlateProfiles(profiles);
  check('4 units (3 beds + 1 lens)', units.length === 4, `got ${units.length}`);
  const lens = units.find((u) => u.members.length === 1);
  check('lens has a single member', !!lens);

  const lookup = new Map();
  profiles.cpts.forEach((c) => c.layers.forEach((l) => lookup.set(`${c.cptIdx}:${l.layerIdx}`, l)));
  const derived = units.map((u, i) => ({ id: `u${i}`, name: `U${i}`, type: 'x', subtype: '', members: u.members }));
  const polys = buildSectionPolygons(profiles.cpts, derived, lookup);

  const lensPoly = polys.filter((p) => p.unitId === derived[units.indexOf(lens)].id);
  check('lens forms exactly one lobe', lensPoly.length === 1);
  if (lensPoly.length === 1) {
    const xs = lensPoly[0].points.map((p) => p.dist);
    check('lens closes at half-distance left (15 m)', Math.abs(Math.min(...xs) - 15) < 1e-6, `min ${Math.min(...xs)}`);
    check('lens closes at half-distance right (45 m)', Math.abs(Math.max(...xs) - 45) < 1e-6, `max ${Math.max(...xs)}`);
  }
  // The continuous beds span the whole section as single lobes.
  const fullLobes = polys.filter((p) => {
    const xs = p.points.map((q) => q.dist);
    return Math.min(...xs) === 0 && Math.max(...xs) === 60;
  });
  check('continuous beds span the full section', fullLobes.length === 3, `got ${fullLobes.length}`);
}

// ── 3. lithological gate ──────────────────────────────────────────────────

console.log('\n[3] incompatible lithologies never merge');
{
  const project = {
    name: 'gate',
    cpts: [
      cpt('C1', 0, 10.0, [SAND(0, 3), PEAT(3, 6), SAND(6, 10)]),
      cpt('C2', 20, 10.0, [SAND(0, 3), GRAVEL(3, 6), SAND(6, 10)])
    ]
  };
  const { units } = correlateProfiles(buildProfiles(project));
  const mixed = units.find((u) =>
    u.members.length > 1 &&
    (() => {
      const types = u.members.map((m) => project.cpts[m.cptIdx].layers[m.layerIdx].type);
      return types.includes('Peat / organic') && types.includes('Gravel');
    })()
  );
  check('peat and gravel stay separate units', !mixed);
  check('both appear as pinch-outs (4 units total)', units.length === 4, `got ${units.length}`);
}

// ── 4. dipping strata ─────────────────────────────────────────────────────

console.log('\n[4] dipping strata correlate across elevation offset');
{
  const project = {
    name: 'dip',
    cpts: [
      cpt('C1', 0, 10.0, [SAND(0, 3), CLAY(3, 6), SAND(6, 12, { qc: 15 })]),
      cpt('C2', 40, 8.0, [SAND(0, 3), CLAY(3, 6), SAND(6, 12, { qc: 15 })]) // whole column 2 m lower
    ]
  };
  const { units } = correlateProfiles(buildProfiles(project));
  check('3 units despite 2 m dip', units.length === 3, `got ${units.length}`);
  check('all beds fully correlated', units.every((u) => u.members.length === 2));
}

// ── 5. aggregation ────────────────────────────────────────────────────────

console.log('\n[5] unit property aggregation');
{
  const project = {
    name: 'agg',
    cpts: [
      cpt('C1', 0, 10.0, [CLAY(0, 4, { qc: 1.0, phi: 20 })]), // thk 4
      cpt('C2', 20, 10.0, [CLAY(0, 1, { qc: 2.0, phi: 26 })]) // thk 1
    ]
  };
  const profiles = buildProfiles(project);
  const { units } = correlateProfiles(profiles);
  check('single unit', units.length === 1);

  const lookup = new Map();
  profiles.cpts.forEach((c) => c.layers.forEach((l) => lookup.set(`${c.cptIdx}:${l.layerIdx}`, l)));
  const fakeParams = () => ({
    hs: { Eoed_i: 5000, Eoed_ref: 8000, E50_ref: 8000, Eur_ref: 24000, Emc: 5000, Edef: 4000, nu: 0.35, beta: 0.57, psi: 0, m: 1 },
    kh: { kh_rep: 1e-8, kv_rep: 1e-9 }
  });

  const wmean = deriveUnitProperties(units[0].members, lookup, fakeParams, { characteristic: 'wmean' });
  // qc: (1.0*4 + 2.0*1)/5 = 1.2
  check('thickness-weighted qc', Math.abs(wmean.agg.qc.wmean - 1.2) < 1e-9, `got ${wmean.agg.qc.wmean}`);
  check('qc envelope', wmean.agg.qc.min === 1 && wmean.agg.qc.max === 2);
  // phi: (20*4 + 26*1)/5 = 21.2
  check('weighted phi characteristic', Math.abs(wmean.characteristic.phi - 21.2) < 1e-9, `got ${wmean.characteristic.phi}`);

  const lower = deriveUnitProperties(units[0].members, lookup, fakeParams, { characteristic: 'min' });
  check("characteristic 'min' picks lower bound", lower.characteristic.phi === 20);
  check('permeability geometric mean', Math.abs(lower.params.kh - 1e-8) < 1e-12);
  check('lithology by thickness vote', wmean.type === 'Clay' && wmean.subtype === 'klei, matig');
}

// ── 6. store lifecycle ────────────────────────────────────────────────────

console.log('\n[6] store — staleness and manual interpretation');
{
  const project = {
    name: 'store',
    cpts: [
      cpt('C1', 0, 10.0, [SAND(0, 3), CLAY(3, 6)]),
      cpt('C2', 30, 10.0, [SAND(0, 3), CLAY(3, 6)])
    ]
  };
  const store = createStratigraphyStore({ getProject: () => project, layerParamsFor: null });
  let d = store.run();
  check('run produces 2 units', d.units.length === 2);
  check('not stale after run', !d.stale);
  check('polygons produced', d.polygons.length === 2);

  // Manual: move C2's clay into its own unit → clay pinches out.
  const clayUnit = d.units.find((u) => u.type === 'Clay');
  store.assignMember(1, 1, 'new');
  d = store.derived();
  check('manual split creates third unit', d.units.length === 3);
  check('manual edits flagged', store.hasManualEdits());

  // Merge it back.
  const clayA = d.units.filter((u) => u.type === 'Clay');
  store.mergeUnits(clayA[1].id, clayA[0].id);
  d = store.derived();
  check('merge restores 2 units', d.units.length === 2);
  check('merged clay has 2 members', d.units.find((u) => u.type === 'Clay').members.length === 2);

  // Input change → stale, never silently wrong.
  project.cpts[0].layers[1].bot = 6.5;
  d = store.derived();
  check('layer edit flags result stale', d.stale);
  d = store.run();
  check('re-run clears staleness', !d.stale && d.units.length === 2);

  // Exports run on the derived model.
  const csv = buildUnitsCsv(d, project.name);
  check('units CSV builds', csv.text.includes('Unit,Name,Type') && csv.text.split('\n').length > 4);
  const plaxis = buildPlaxisUnitCommands(d, project.name);
  check('PLAXIS export skips units without Stage 4 params (Node context)', plaxis.text.includes('overgeslagen'));
}

// ── 7. SOILIN report payload ──────────────────────────────────────────────

console.log('\n[7] SOILIN payload — fixed order, zero-thickness absents');
{
  const project = {
    name: 'soilin',
    cpts: [
      cpt('C1', 0, 10.0, [SAND(0, 3), CLAY(3, 6), SAND(6, 12, { qc: 15 })]),
      cpt('C2', 30, 10.0, [SAND(0, 3), CLAY(3, 5), PEAT(5, 6.2), SAND(6.2, 12, { qc: 15 })]),
      cpt('C3', 60, 10.0, [SAND(0, 3), CLAY(3, 6), SAND(6, 12, { qc: 15 })])
    ]
  };
  const store = createStratigraphyStore({ getProject: () => project, layerParamsFor: null });
  const d = store.run();
  const payload = buildSoilinReportPayload(d, { projectName: project.name, generatedAt: '2026-08-08T00:00:00Z' });

  check('4 units in payload', payload.units.length === 4);
  check('every borehole lists every unit', payload.boreholes.every((b) => b.rows.length === 4));
  const peatIdx = payload.units.findIndex((u) => u.type === 'Peat / organic');
  const c1 = payload.boreholes.find((b) => b.id === 'C1');
  const c2 = payload.boreholes.find((b) => b.id === 'C2');
  check('lens gets nominal 0.01 m where absent (SOILIN rejects 0)', c1.rows[peatIdx].absent === true && c1.rows[peatIdx].thickness === 0.01);
  check('lens thickness real where present', Math.abs(c2.rows[peatIdx].thickness - 1.2) < 1e-9);
  check('borehole rows follow unit order', payload.boreholes.every((b) => b.rows.every((r, i) => r.unit === i)));
  const depthC2 = c2.rows.reduce((s, r) => s + r.thickness, 0);
  check('thicknesses sum to profile depth', Math.abs(depthC2 - 12) < 1e-9, `got ${depthC2}`);
}

// ── 8. alignment unit test ────────────────────────────────────────────────

console.log('\n[8] alignment primitives');
{
  const profiles = buildProfiles({
    name: 'a',
    cpts: [
      cpt('A', 0, 10, [SAND(0, 3), CLAY(3, 6), SAND(6, 10, { qc: 15 })]),
      cpt('B', 20, 10, [SAND(0, 2.8), SAND(2.8, 10, { qc: 15 })]) // clay missing
    ]
  });
  const { pairs, gapsA } = alignSequences(profiles.cpts[0].layers, profiles.cpts[1].layers, { spacing: 20 });
  check('two matches across the pair', pairs.length === 2);
  check('clay is the gap (pinch-out)', gapsA.length === 1 && gapsA[0] === 1);
  check('matches are monotone', pairs.every((p, i) => i === 0 || (p.ia > pairs[i - 1].ia && p.ib > pairs[i - 1].ib)));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll stratigraphy checks passed.');
process.exit(failures ? 1 : 0);
