// SPDX-License-Identifier: AGPL-3.0-or-later
// The `ctx` handed to every suite (design §4.3 makeContext): fixture lookup from
// fixtures/manifest.json, the lazily loaded controller (Tier B), the retaining WASM
// (Tier A), and `loadCpt(name)` which resets the project and imports a fixture through
// the controller's real user path (loadGEF → importCptFiles → parseGEF/parseCsvCpt/
// parseExcelCpt → import-review auto-apply → applyParsedCpt → selectCpt), so every
// suite starts from exactly the state a fresh browser session would have.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GOLDEN } from './store.mjs';
import { loadController } from './load-controller.mjs';
import { retainingModule, runRetaining } from './wasm.mjs';

export const FIXTURES = join(GOLDEN, 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred, { timeout = 15000, step = 5, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(step);
  }
}

export async function makeContext() {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
  const cptEntries = Object.entries(manifest.fixtures).filter(([k]) => k.startsWith('cpt/'));
  let ctl = null;

  const ctx = {
    manifest,
    fixtures: {
      /** Profile fixtures that go through the whole Stage 2–7 chain (GEF + state-injected). */
      cptNames: () => cptEntries.filter(([, e]) => e.role === 'profile').map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, '')),
      /** Profiles for the Stage 6 / report suites: the layered import variants whose
          only difference is upstream (trailing rows, injected water table) are skipped
          there to keep the goldens small; their behaviour is locked in import/classification/layers/model. */
      stage6Names: () => ctx.fixtures.cptNames().filter((n) => !['trailing-qc-only', 'wt-above-surface'].includes(n)),
      /** Every importable CPT fixture (GEF/CSV/XLSX + state-injected), for the import suite. */
      importNames: () => cptEntries.filter(([, e]) => e.role !== 'aux').map(([k]) => k.slice(4).replace(/\.state\.json$/, '')),
      projectNames: () => Object.keys(manifest.fixtures).filter((k) => k.startsWith('projects/')).map((k) => basename(k, '.madep.json')),
      path: (rel) => join(FIXTURES, rel),
      read: (rel) => readFileSync(join(FIXTURES, rel)),
      text: (rel) => readFileSync(join(FIXTURES, rel), 'utf8'),
      json: (rel) => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8')),
      /** Manifest entry for a CPT fixture name, with or without extension; carries its manifest key. */
      entry(name) {
        for (const key of [`cpt/${name}`, `cpt/${name}.gef`, `cpt/${name}.state.json`]) {
          if (manifest.fixtures[key]) return { key, ...manifest.fixtures[key] };
        }
        return null;
      }
    },
    async controller() { if (!ctl) ctl = await loadController(); return ctl; },
    /** Active CPT state (S in the controller). */
    S: () => { const P = globalThis.PROJECT; return P.cpts[P.activeCptIdx]; },
    /** Reset PROJECT to a fresh single-CPT project (what a page load gives). */
    async resetProject() {
      const { api } = await ctx.controller();
      const P = api.PROJECT;
      P.cpts.splice(0, P.cpts.length, api.newCptState('CPT-1'));
      P.activeCptIdx = 0; P.sectionOrder = [0]; P.name = 'CPT Project'; P.phase = 'analysis'; P.stratigraphy = null;
      api.selectCpt(0);
      return P;
    },
    /** Import a fixture into the ACTIVE CPT through loadGEF (the file-input path). */
    async importCpt(name) {
      const c = await ctx.controller();
      const { api } = c;
      const entry = ctx.fixtures.entry(name);
      if (!entry) throw new Error(`unknown CPT fixture ${name}`);
      const fileRel = entry.base ? `cpt/${entry.base}` : entry.key;
      const fname = basename(fileRel);
      const file = new File([ctx.fixtures.read(fileRel)], fname);
      c.captured.length = 0; c.alerts.length = 0; c.opened.length = 0;
      const before = c.alerts.length;
      api.loadGEF({ target: { files: [file], value: '' } });
      await waitFor(() => (ctx.S().meta?.fname === fname && ctx.S().data.length > 0) || c.alerts.length > before, { label: `import of ${fname}` });
      if (entry.inject) Object.assign(ctx.S(), entry.inject);
      return ctx.S();
    },
    /** Fresh project + import (the usual suite entry point). */
    async loadCpt(name) { await ctx.resetProject(); return ctx.importCpt(name); },
    /** Classify with `method` and return the active CPT (runClass also detects layers). */
    async classify(name, method = 'sb260') { const S = await ctx.loadCpt(name); const { api } = await ctx.controller(); S.method = method; api.runClass(); return S; },
    async retainingWasm() { const M = await retainingModule(); return { M, run: (req) => runRetaining(M, req) }; },
    async close() { if (ctl) { const c = ctl; ctl = null; await c.close(); } }
  };
  return ctx;
}
