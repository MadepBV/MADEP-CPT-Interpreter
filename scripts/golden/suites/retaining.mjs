// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier A lock of the Stage 6 retaining-wall application (design §1.8, §2.1): for the 5 wall
// types × {default, overrides, RK scheme 0, RK scheme 2} on two fixed CPT layer profiles,
// the pure chain buildRequest → WASM engine (static/wasm/retaining, pinned by
// wasm.sha256.json) → computeEmbeddedStructural → result views (HTML as text) →
// scene objects (what the canvas draws) → buildNotePayload → runDrivability (vibratory,
// impact, Alm & Hamre SRD, supplier data sheet). Modelled on scripts/verify_retaining_ui.mjs
// but yielding the numbers. Tolerance class `wasm` (engine crosses -ffast-math WASM).
import { defaults, ensure } from '../../../src/lib/cpt-app/retaining/wall-state.js';
import { buildRequest } from '../../../src/lib/cpt-app/retaining/request-builder.js';
import { layerKey } from '../../../src/lib/cpt-app/retaining/soil-profile.js';
import { isEmbedded } from '../../../src/lib/cpt-app/retaining/wall-types.js';
import { computeEmbeddedStructural } from '../../../src/lib/cpt-app/retaining/results/embedded-structural.js';
import { summaryCard } from '../../../src/lib/cpt-app/retaining/results/summary-card.js';
import { checksView } from '../../../src/lib/cpt-app/retaining/results/checks-view.js';
import { gravityChecksView } from '../../../src/lib/cpt-app/retaining/results/gravity-results.js';
import { branchesView } from '../../../src/lib/cpt-app/retaining/results/branches-view.js';
import { plaxisView } from '../../../src/lib/cpt-app/retaining/results/plaxis-view.js';
import { structuralView } from '../../../src/lib/cpt-app/retaining/results/structural-view.js';
import { diagramsView } from '../../../src/lib/cpt-app/retaining/results/diagrams-view.js';
import { vibrationView, computeVibration } from '../../../src/lib/cpt-app/retaining/panels/vibration-panel.js';
import { runDrivability, drivabilityView } from '../../../src/lib/cpt-app/retaining/panels/drivability-panel.js';
import { buildEmbeddedScene } from '../../../src/lib/cpt-app/retaining/scenes/embedded-scene.js';
import { buildGravityScene } from '../../../src/lib/cpt-app/retaining/scenes/gravity-scene.js';
import { buildNotePayload } from '../../../src/lib/cpt-app/retaining/report/note-view.js';
import { htmlToText } from '../lib/html-text.mjs';
import { digest } from '../lib/normalize.mjs';

export const name = 'retaining';
export const tolerance = 'wasm';
export const description = 'Retaining walls: request → WASM → structural → views → scene → note → drivability';

const WALL_TYPES = ['cantilever', 'gravity', 'sheetpile', 'anchored', 'soldierpile'];
const PROFILES = {
  'sand-over-clay': {
    layers: [
      { type: 'Sand', subtype: 'zand, matig', g: 19, gs: 21, phi: 33, c: 0, cu: 0, top: 0, bot: 8, avgQc: 12 },
      { type: 'Clay', subtype: 'klei, vast', g: 17, gs: 17, phi: 22, c: 4, cu: 60, top: 8, bot: 20, avgQc: 1.2 }
    ],
    cpt: { id: 'CPT-A', depth: Array.from({ length: 200 }, (_, i) => i * 0.1), qc: Array.from({ length: 200 }, (_, i) => (i < 80 ? 12 : 1.2)), fs: Array.from({ length: 200 }, (_, i) => (i < 80 ? 60 : 40)), waterTable: 2 }
  },
  'clay-over-sand': {
    layers: [
      { type: 'Sandy clay', subtype: 'leem, vast', g: 18, gs: 19, phi: 26, c: 3, cu: 45, top: 0, bot: 3.5, avgQc: 2.0 },
      { type: 'Clay', subtype: 'klei, weinig vast', g: 16, gs: 16.5, phi: 20, c: 2, cu: 30, top: 3.5, bot: 7.0, avgQc: 0.7 },
      { type: 'Sand', subtype: 'zand, vast', g: 19, gs: 21, phi: 35, c: 0, cu: 0, top: 7.0, bot: 18, avgQc: 18 }
    ],
    cpt: { id: 'CPT-B', depth: Array.from({ length: 180 }, (_, i) => i * 0.1), qc: Array.from({ length: 180 }, (_, i) => (i < 35 ? 2 : i < 70 ? 0.7 : 18)), fs: Array.from({ length: 180 }, (_, i) => (i < 35 ? 50 : i < 70 ? 30 : 90)), waterTable: 1.2 }
  }
};

function freshState(wallType) {
  const stage6 = { retwall: defaults() };
  ensure(stage6);
  stage6.retwall.wallType = wallType;
  return stage6.retwall;
}

function variants(rw, layers) {
  return {
    default: () => {},
    overrides: () => {
      rw.embedded.retainedHeight = 3.0; rw.embedded.embedment = 5.0; rw.profile.offset = -0.5;
      rw.profile.overrides = { [layerKey(layers[1], 1)]: { c: 0.5, drained: true } };
      rw.water.mode = 'levels'; rw.water.retainedDepth = 1.5; rw.water.frontDepth = 0.5;
      rw.surcharge = 20; rw.loads.surchargePermanent = 5;
      rw.cantilever.stemHeight = 3.5; rw.gravity.stemHeight = 3.0;
    },
    rk0: () => { rw.settings.riskScheme = 0; rw.settings.consequenceClass = 3; },
    rk2: () => { rw.settings.riskScheme = 2; rw.settings.materialOverride = { enabled: true, gPhi: 1.35, gC: 1.35, gCu: 1.5, applyToDA12: true }; }
  };
}

export async function* cases(ctx) {
  const { run } = await ctx.retainingWasm();
  yield { id: 'defaults', value: defaults() };
  for (const [pname, profile] of Object.entries(PROFILES)) {
    const { layers, cpt } = profile;
    for (const wt of WALL_TYPES) {
      const rw = freshState(wt);
      const vs = variants(rw, layers);
      for (const [vname, apply] of Object.entries(vs)) {
        apply();
        const id = `${pname}.${wt}.${vname}`;
        let built;
        try { built = buildRequest(rw, layers); } catch (e) { yield { id: `${id}.error`, value: { phase: 'buildRequest', message: String(e?.message || e) } }; continue; }
        yield { id: `${id}.request`, value: built.request };
        yield { id: `${id}.profile`, value: built.profile };
        const result = run(built.request);
        // the pressure / force diagrams are locked in full for default + overrides; the partial-factor
        // variants keep every scalar and digest the diagram vectors (the same sampler, other factors)
        const slimResult = /^rk/.test(vname) && result.branches ? { ...result, diagrams: digest(result.diagrams), branches: result.branches.map((b) => ({ ...b, diagrams: digest(b.diagrams) })) } : result;
        yield { id: `${id}.result`, value: slimResult };
        rw.result = result; rw.status = result.ok ? 'done' : 'error';
        const st = isEmbedded(wt) && result.ok ? computeEmbeddedStructural(rw, result, built.profile) : null;
        if (st) yield { id: `${id}.structural`, value: st };
        const views = {
          summary: summaryCard(rw, result, st),
          checks: isEmbedded(wt) ? checksView(rw, result, st) : gravityChecksView(rw, result),
          branches: branchesView(rw, result),
          plaxis: plaxisView(rw, result, st),
          structural: isEmbedded(wt) ? structuralView(rw, result, st) : '',
          diagrams: diagramsView(rw, result),
          vibration: isEmbedded(wt) ? vibrationView(rw) : ''
        };
        for (const [v, html] of Object.entries(views)) if (html) yield { id: `${id}.view-${v}`, kind: 'txt', value: htmlToText(html) };
        yield { id: `${id}.scene`, value: isEmbedded(wt) ? buildEmbeddedScene(rw, result, layers) : buildGravityScene(rw, result, layers) };
        const note = buildNotePayload({ rw, layers, profile: built.profile, structural: st, vibration: isEmbedded(wt) ? computeVibration(rw) : null, meta: { projectName: 'Golden', cptId: cpt.id, appVersion: 'golden' } });
        // result / structural / layers are locked in full above — the note only clones them
        yield { id: `${id}.note`, value: { ...note, result: digest(note.result), structural: digest(note.structural), layers: digest(note.layers) } };
      }
      if (isEmbedded(wt)) {
        // drivability on the default state (result of the last variant kept — drivability reads rw.embedded + section)
        const rw2 = freshState(wt);
        for (const method of ['vibratory', 'impact']) {
          rw2.drivability.method = method;
          const drv = runDrivability(rw2, cpt, layers);
          rw2.drivability.result = drv; rw2.drivability.status = drv?.ok ? 'done' : 'idle';
          yield { id: `${pname}.${wt}.drivability-${method}`, value: drv };
          yield { id: `${pname}.${wt}.drivability-${method}.view`, kind: 'txt', value: htmlToText(drivabilityView(rw2)) };
        }
        rw2.drivability.method = 'vibratory'; rw2.drivability.srdMethod = 'alm-hamre';
        yield { id: `${pname}.${wt}.drivability-alm-hamre`, value: runDrivability(rw2, cpt, layers) };
        rw2.drivability.srdMethod = 'reference';
        rw2.drivability.vibrator.source = 'sheet';
        Object.assign(rw2.drivability.vibrator.sheet, { name: 'SAES HST070', force_kN: 205, rpmMax: 2900, rpmMin: 2400, amplitude_mm: 12, amplitudeConvention: 'pp', totalMass_kg: 965, flow_lmin: 175, flowMax_lmin: 215, pressure_bar: 200, pressureMax_bar: 230, power_kW: 66, carrierMin_t: 22, carrierMax_t: 37 });
        Object.assign(rw2.drivability.vibrator.carrier, { mass_t: 30, flow_lmin: 200, pressure_bar: 220 });
        const drvSheet = runDrivability(rw2, cpt, layers);
        rw2.drivability.result = drvSheet; rw2.drivability.status = 'done';
        yield { id: `${pname}.${wt}.drivability-datasheet`, value: drvSheet };
        yield { id: `${pname}.${wt}.drivability-datasheet.view`, kind: 'txt', value: htmlToText(drivabilityView(rw2)) };
        rw2.result = run(buildRequest(rw2, layers).request);
        yield { id: `${pname}.${wt}.drivability-datasheet.scene`, value: buildEmbeddedScene(rw2, rw2.result, layers) };
      }
    }
  }
}
