// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier A lock of the multi-CPT stratigraphy (design §1.9, §2.1): on the `multi-3cpt`
// project fixture (and its first two CPTs as a 2-CPT project) the pure chain
// buildProfiles → correlateProfiles → store.run()/derived() (deriveUnitProperties,
// buildSectionPolygons) → the manual interpretation (renameUnit / assignMember /
// mergeUnits, staleness after a layer edit) → buildSoilinReportPayload → the exports
// (units CSV, PLAXIS commands, section DXF, SCIA geologic-profile db4 payload + the
// container's SHA-256 with Node's zlib deflate) → the Doorsnede SVG (section/render.js
// buildSectionSvg, the markup renderSection writes into #sectionSvg). Stage 4 parameters
// for the unit aggregation and the PLAXIS export come from the controller (Tier B glue:
// the same hsParams / khParams the app's layerParamsFor evaluates per member CPT).
import { deflateSync } from 'node:zlib';
import { buildProfiles, projectOntoSectionLine, profilesFingerprint, medianSpacing } from '../../../src/lib/cpt-app/stratigraphy/profiles.js';
import { correlateProfiles } from '../../../src/lib/cpt-app/stratigraphy/correlate.js';
import { deriveUnitProperties } from '../../../src/lib/cpt-app/stratigraphy/units.js';
import { buildSectionPolygons } from '../../../src/lib/cpt-app/stratigraphy/geometry.js';
import { createStratigraphyStore, DEFAULT_SETTINGS } from '../../../src/lib/cpt-app/stratigraphy/store.js';
import { buildSoilinReportPayload, isSoilinPayload } from '../../../src/lib/cpt-app/stratigraphy/soilin-report.js';
import { buildUnitsCsv, buildPlaxisUnitCommands, buildSectionDxf } from '../../../src/lib/cpt-app/stratigraphy/exports.js';
import { buildGeologicProfilesPayload, wrapDb4Container, parseGeologicProfilesPayload } from '../../../src/lib/cpt-app/stratigraphy/scia-db4.js';
import { buildSectionSvg, sectionCpts, sectionTokens, SECTION_TOKENS } from '../../../src/lib/cpt-app/section/render.js';
import { sectionSvgDocument, sectionSvgFileName } from '../../../src/lib/cpt-app/section/export-svg.js';
import { sha256Hex } from '../lib/store.mjs';

export const name = 'stratigraphy';
export const tolerance = 'pure';
export const description = 'Multi-CPT stratigraphy: profiles → correlation → units/polygons → manual edits → SOILIN / exports / db4 → Doorsnede SVG';

const GENERATED_AT = '2026-01-01T00:00:00.000Z';

/** Lightweight project view (what the stratigraphy reads): id, x, y, elev, wt, layers, meta. */
function projectOf(snapshot, cptCount = null) {
  const cpts = snapshot.project.cpts.slice(0, cptCount ?? snapshot.project.cpts.length).map((c) => ({ id: c.id, x: c.x, y: c.y, elev: c.elev, wt: c.wt, data: c.data, layers: JSON.parse(JSON.stringify(c.layers)), meta: c.meta || {} }));
  return { name: snapshot.project.name, cpts, stratigraphy: cptCount == null ? JSON.parse(JSON.stringify(snapshot.project.stratigraphy)) : null };
}

const slimDerived = (d) => ({ hasResult: d.hasResult, stale: d.stale, spacing: d.spacing, settings: d.settings, warnings: d.warnings, excluded: d.excluded, profiles: { fingerprint: d.profiles.fingerprint, cpts: d.profiles.cpts.map((c) => ({ cptIdx: c.cptIdx, dist: c.dist, layerCount: c.layers.length })) }, units: d.units, polygons: d.polygons });

function projection(project) {
  const eligible = project.cpts.map((cpt, cptIdx) => ({ cpt, cptIdx })).filter(({ cpt }) => cpt.elev != null && cpt.layers.length);
  if (eligible.length < 2) return null;
  const dists = projectOntoSectionLine(eligible.map(({ cpt }) => cpt));
  const d0 = Math.min(...dists);
  return eligible.map(({ cptIdx }, i) => ({ cptIdx, dist: dists[i] - d0 })).sort((a, b) => a.dist - b.dist);
}

function sectionSvg(project, derived, vex = 2) {
  const tokens = sectionTokens(() => '');       // no CSS under Node → the fallbacks of SECTION_TOKENS
  const projCpts = sectionCpts(project, projection(project));
  const geometry = derived && derived.hasResult && !derived.stale ? { polygons: derived.polygons, units: derived.units } : null;
  return buildSectionSvg({ projCpts, vex, getGeometry: () => geometry, allCpts: project.cpts, tokens });
}

async function* exportsOf(id, derived, projectName) {
  const csv = buildUnitsCsv(derived, projectName);
  yield { id: `${id}.units-csv`, kind: 'csv', value: csv.text };
  const plaxis = buildPlaxisUnitCommands(derived, projectName);
  yield { id: `${id}.plaxis`, kind: 'txt', value: plaxis.text };
  const dxf = buildSectionDxf(derived, projectName);
  yield { id: `${id}.section-dxf`, kind: 'txt', value: dxf.text };
  yield { id: `${id}.export-names`, value: { csv: { filename: csv.filename, mime: csv.mime }, plaxis: { filename: plaxis.filename, mime: plaxis.mime }, dxf: { filename: dxf.filename, mime: dxf.mime } } };
  const soilin = buildSoilinReportPayload(derived, { projectName, generatedAt: GENERATED_AT });
  yield { id: `${id}.soilin`, value: { payload: soilin, valid: isSoilinPayload(soilin) } };
  const payload = buildGeologicProfilesPayload(soilin);
  yield { id: `${id}.db4-payload`, kind: 'txt', value: payload };
  const file = wrapDb4Container(payload, deflateSync(Buffer.from(payload, 'utf8')));
  yield { id: `${id}.db4`, value: { bytes: file.length, sha256: sha256Hex(file), reparsed: parseGeologicProfilesPayload(payload) } };
}

export async function* cases(ctx) {
  const snapshot = ctx.fixtures.json('projects/multi-3cpt.madep.json');
  yield { id: 'defaults', value: { DEFAULT_SETTINGS, SECTION_TOKENS, tokens: sectionTokens(() => ''), svgFileName: sectionSvgFileName(snapshot.project.name) } };

  for (const [id, cptCount] of [['3cpt', null], ['2cpt', 2]]) {
    const project = projectOf(snapshot, cptCount);
    const profiles = buildProfiles(project);
    yield { id: `${id}.profiles`, value: { ...profiles, fingerprint2: profilesFingerprint(project.cpts), spacing: medianSpacing(profiles.cpts), projection: projection(project) } };
    const corr = correlateProfiles(profiles, { minMatch: DEFAULT_SETTINGS.minMatch });
    yield { id: `${id}.correlation`, value: corr };
    yield { id: `${id}.correlation-minMatch0.3`, value: correlateProfiles(profiles, { minMatch: 0.3 }).units };
    yield { id: `${id}.correlation-minMatch0.7`, value: correlateProfiles(profiles, { minMatch: 0.7 }).units };
    const lookup = new Map();
    profiles.cpts.forEach((c) => c.layers.forEach((l) => lookup.set(`${c.cptIdx}:${l.layerIdx}`, l)));
    yield { id: `${id}.unit-properties`, value: ['wmean', 'min'].map((characteristic) => ({ characteristic, units: corr.units.map((u) => deriveUnitProperties(u.members, lookup, () => null, { characteristic })) })) };
    const derivedUnits = corr.units.map((u, i) => ({ id: `u${i + 1}`, name: `U${i + 1}`, type: 'x', subtype: '', members: u.members }));
    yield { id: `${id}.polygons`, value: buildSectionPolygons(profiles.cpts, derivedUnits, lookup) };

    // store lifecycle on a fresh copy (no saved result): run → derived; the fixture's own saved result (renamed unit) for the 3-CPT case
    const store = createStratigraphyStore({ getProject: () => project, layerParamsFor: null });
    const saved = project.stratigraphy ? store.derived() : null;
    if (saved) yield { id: `${id}.derived-from-saved`, value: slimDerived(saved) };
    const d = store.run();
    yield { id: `${id}.derived`, value: slimDerived(d) };
    yield { id: `${id}.section-svg`, kind: 'svg', value: sectionSvgDocument(sectionSvg(project, d).html) };
    yield { id: `${id}.section-svg-vex4`, kind: 'svg', value: sectionSvg(project, d, 4).html };
    yield* exportsOf(id, d, project.name);
    // manual interpretation
    store.renameUnit(d.units[0].id, 'Quartair zand');
    const clay = d.units.find((u) => u.type === 'Clay') || d.units[1];
    store.assignMember(1, 1, 'new');
    let m = store.derived();
    const newest = m.units.find((u) => u.members.length === 1 && u.members[0].cptIdx === 1 && u.members[0].layerIdx === 1);
    yield { id: `${id}.manual-split`, value: { hasManualEdits: store.hasManualEdits(), state: project.stratigraphy.result, derived: slimDerived(m) } };
    if (newest && clay) store.mergeUnits(newest.id, clay.id);
    m = store.derived();
    yield { id: `${id}.manual-merge`, value: { state: project.stratigraphy.result, derived: slimDerived(m) } };
    yield* exportsOf(`${id}.manual`, m, project.name);
    project.cpts[0].layers[0].bot += 0.25;
    yield { id: `${id}.stale-after-edit`, value: slimDerived(store.derived()) };
    yield { id: `${id}.section-svg-stale`, kind: 'svg', value: sectionSvg(project, store.derived()).html };
    store.setSetting('characteristic', 'min'); store.setSetting('minMatch', 0.9);
    yield { id: `${id}.settings`, value: { settings: project.stratigraphy.settings, rerun: slimDerived(store.run()).units.map((u) => ({ id: u.id, members: u.members, characteristic: u.characteristic })) } };
  }
  // single CPT and no-elevation guards
  const one = projectOf(snapshot, 1);
  const storeOne = createStratigraphyStore({ getProject: () => one, layerParamsFor: null });
  storeOne.ensureRun();
  const noElev = projectOf(snapshot); noElev.cpts[1].elev = null;
  yield { id: 'guards', value: { single: slimDerived(storeOne.derived()), singleState: one.stratigraphy, noElevProfiles: buildProfiles(noElev).excluded, noElevProjection: projection(noElev), sectionSingle: sectionSvg(one, null) } };

  // Stage 4 parameters through the controller (the app's layerParamsFor): unit params + PLAXIS export with values
  const c = await ctx.controller();
  const { api } = c;
  await ctx.resetProject();
  await api.loadProjectFromFile(new File([ctx.fixtures.read('projects/multi-3cpt.madep.json')], 'multi-3cpt.madep.json'));
  const P = api.PROJECT;
  const layerParamsFor = (cpt, layer) => { const idx = P.cpts.indexOf(cpt); if (idx >= 0 && idx !== P.activeCptIdx) api.selectCpt(idx); return { hs: api.hsParams(layer), kh: api.khParams(layer) }; };
  const storeP = createStratigraphyStore({ getProject: () => P, layerParamsFor });
  const dp = storeP.derived();
  yield { id: 'with-stage4-params.derived', value: slimDerived(dp) };
  yield* exportsOf('with-stage4-params', dp, P.name);
  api.selectCpt(0);
}
