// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks project save/load (design §1.10): buildProjectSnapshot / validateProjectSnapshot /
// applyProjectSnapshot (pure, project-io/snapshot.js) on every project fixture, the
// round-trip identity normalize(snapshot(load(snapshot(P)))) === normalize(snapshot(P)),
// and the controller glue behind loadProjectFromFile → afterLoad (banner, runClass, saved
// layers restored over the auto-detected ones, goS, setPhase; legacy-controller.js:182-200).
// newCptState is the controller's own (:207), so the forward-compat merge onto today's
// defaults is what gets locked.
import { buildProjectSnapshot, validateProjectSnapshot, applyProjectSnapshot, PROJECT_SNAPSHOT_VERSION } from '../../../src/lib/cpt-app/project-io/snapshot.js';
import { createStratigraphyStore } from '../../../src/lib/cpt-app/stratigraphy/store.js';
import { normalize, digest } from '../lib/normalize.mjs';
import { stableJson } from '../lib/store.mjs';
import { htmlToText } from '../lib/html-text.mjs';

export const name = 'project-io';
export const tolerance = 'pure';
export const description = 'Project snapshot / validate / restore / round-trip + loadProjectFromFile glue';

const META = { activeStage: 3, savedAt: '2026-01-01T00:00:00.000Z', appVersion: 'golden' };
/** Project with the row arrays (committed fixture input, locked by import/classification) replaced by digests. */
const slim = (project) => ({ ...project, cpts: project.cpts.map((cpt) => ({ ...cpt, data: digest(cpt.data), classified: digest(cpt.classified) })) });

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  const newCptState = api.newCptState;
  const freshProject = () => ({ name: 'CPT Project', cpts: [newCptState('CPT-1')], activeCptIdx: 0, phase: 'analysis', stratigraphy: null, sectionOrder: [0] });
  for (const fx of ctx.fixtures.projectNames()) {
    const snapshot = ctx.fixtures.json(`projects/${fx}.madep.json`);
    yield { id: `${fx}.validate`, value: {
      good: validateProjectSnapshot(snapshot),
      foreign: validateProjectSnapshot({ hello: 'world' }),
      wrongKind: validateProjectSnapshot({ ...snapshot, kind: 'other' }),
      versionZero: validateProjectSnapshot({ ...snapshot, version: 0 }),
      newerVersion: validateProjectSnapshot({ ...snapshot, version: PROJECT_SNAPSHOT_VERSION + 1 }),
      noCpts: validateProjectSnapshot({ ...snapshot, project: { ...snapshot.project, cpts: [] } }),
      cptWithoutLayers: validateProjectSnapshot({ ...snapshot, project: { ...snapshot.project, cpts: [{ data: [] }] } }),
      text: validateProjectSnapshot('{}')
    } };
    const project = freshProject();
    const position = applyProjectSnapshot(project, snapshot, { newCptState });
    yield { id: `${fx}.restored`, value: { position, project: slim(project) } };
    const again = buildProjectSnapshot(project, META);
    yield { id: `${fx}.resnapshot`, value: { ...again, project: slim(again.project) } };
    const p2 = freshProject();
    applyProjectSnapshot(p2, JSON.parse(JSON.stringify(again)), { newCptState });
    const a = stableJson(normalize(buildProjectSnapshot(p2, META)));
    const b = stableJson(normalize(again));
    const strat = project.stratigraphy ? createStratigraphyStore({ getProject: () => project, layerParamsFor: null }).derived() : null;
    yield { id: `${fx}.roundtrip`, value: { identical: a === b, bytes: a.length, stratigraphy: strat ? { hasResult: strat.hasResult, stale: strat.stale, units: strat.units.map((u) => ({ id: u.id, name: u.name, members: u.members })) } : null } };
    // controller glue: loadProjectFromFile → afterLoad
    await ctx.resetProject();
    c.alerts.length = 0;
    await api.loadProjectFromFile(new File([stableJson(snapshot)], `${fx}.madep.json`));
    api.ensureStage6State();
    yield { id: `${fx}.loaded-via-controller`, value: { project: slim(api.PROJECT), alerts: c.alerts.slice(), activeStage: api.PROJECT.cpts[api.PROJECT.activeCptIdx]._maxStage ?? null } };
    yield { id: `${fx}.loaded-via-controller.dom`, kind: 'txt', value: ['cptTabs', 'lb', 'ma', 'stratPanel'].map((id) => `[#${id}]\n${htmlToText(c.document.getElementById(id).innerHTML)}`).join('') };
    yield { id: `${fx}.loaded-via-controller.resave`, value: (() => { c.captured.length = 0; api.saveProject(); return c.captured.at(-1)?.blob ? { download: c.captured.at(-1).download.replace(/_\d{8}-\d{4}\./, '_<stamp>.') } : null; })() };
  }
  // invalid file paths through the controller
  await ctx.resetProject();
  c.alerts.length = 0;
  await api.loadProjectFromFile(new File(['not json'], 'bad.madep.json'));
  await api.loadProjectFromFile(new File(['{"kind":"other"}'], 'bad2.madep.json'));
  yield { id: 'invalid-files', value: { alerts: c.alerts.slice(), cpts: api.PROJECT.cpts.length } };
}
