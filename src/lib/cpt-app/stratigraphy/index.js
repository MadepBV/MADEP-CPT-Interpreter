// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stratigraphy application — public entry point.
//
// Replaces the legacy cross-CPT "Correlatie" feature with an engineering-
// grade stratigraphy builder: per-CPT layer models are correlated into
// shared soil units by order-preserving sequence alignment (pinch-outs and
// lenses included), unit properties derive from their member layers, and
// the result feeds the Doorsnede section, the exports (CSV / PLAXIS 2D /
// section DXF) and the SCIA SOILIN borehole report.
//
// Wired into the legacy controller through a small context, like the
// retaining-walls module:
//   installStratigraphyApp({
//     getProject:           () => PROJECT,
//     layerParamsFor:       (cpt, layer) => ({ hs, kh }),   // Stage 4 params
//     requestSectionRender: () => renderSection()
//   })

import { createStratigraphyStore } from './store.js';
import { createStratigraphyView } from './view.js';
import { buildUnitsCsv, buildPlaxisUnitCommands, buildSectionDxf } from './exports.js';
import { buildSoilinReportPayload, saveSoilinPayload } from './soilin-report.js';
import { buildGeologicProfilesPayload, wrapDb4Container } from './scia-db4.js';
import { projectOntoSectionLine } from './profiles.js';
import { toast } from '../../styles/toast.ts';

function download({ filename, mime, text }) {
  const a = document.createElement('a');
  a.href = `data:${mime};charset=utf-8,` + encodeURIComponent(text);
  a.download = filename;
  a.click();
}

function downloadBinary(filename, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* zlib-deflate via the browser-native CompressionStream ('deflate' = RFC 1950,
   the format the db4 container expects). */
async function zlibDeflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function installStratigraphyApp(ctx) {
  const store = createStratigraphyStore(ctx);
  const projectName = () => ctx.getProject().name || 'CPT Project';

  const view = createStratigraphyView({
    store,
    actions: {
      onChanged: () => ctx.requestSectionRender(),
      async export(kind) {
        const d = store.derived();
        if (!d.units.length) return;
        if (kind === 'csv') download(buildUnitsCsv(d, projectName()));
        else if (kind === 'plaxis') download(buildPlaxisUnitCommands(d, projectName()));
        else if (kind === 'dxf') download(buildSectionDxf(d, projectName()));
        else if (kind === 'db4') {
          // SCIA geologic-profile library: one borehole profile per CPT,
          // every unit in fixed order (absent units at the nominal 0.01 m).
          const soilin = buildSoilinReportPayload(d, {
            projectName: projectName(),
            generatedAt: new Date().toISOString()
          });
          const payload = buildGeologicProfilesPayload(soilin);
          try {
            const file = wrapDb4Container(payload, await zlibDeflate(payload));
            downloadBinary('EP_GeologicProfile.db4', file);
          } catch (err) {
            toast(`Het db4-bestand kon niet worden aangemaakt: ${err?.message || err}`, { tone: 'bad' });
          }
        }
      },
      openSoilinReport() {
        const d = store.derived();
        if (!d.units.length) return;
        const payload = buildSoilinReportPayload(d, {
          projectName: projectName(),
          generatedAt: new Date().toISOString()
        });
        const key = saveSoilinPayload(window.localStorage, payload);
        if (!key) {
          toast('Het SOILIN-rapport kon niet worden opgeslagen voor weergave.', { tone: 'bad' });
          return;
        }
        window.open(`/report/soilin?key=${encodeURIComponent(key)}`, '_blank', 'noopener');
      }
    }
  });

  return {
    /** Render the Correlatie phase panel (auto-runs on first entry). */
    render() {
      store.ensureRun();
      view.install();
      view.render();
    },

    /**
     * Section-line projection over the *eligible* CPTs, exposed so the
     * Doorsnede uses the exact same chainage as the stratigraphy.
     * Returns [{cptIdx, dist}] sorted by dist, or null when < 2 CPTs.
     */
    projection() {
      const project = ctx.getProject();
      const eligible = project.cpts
        .map((cpt, cptIdx) => ({ cpt, cptIdx }))
        .filter(({ cpt }) => cpt.elev != null && cpt.layers.length);
      if (eligible.length < 2) return null;
      const dists = projectOntoSectionLine(eligible.map(({ cpt }) => cpt));
      const d0 = Math.min(...dists);
      return eligible
        .map(({ cptIdx }, i) => ({ cptIdx, dist: dists[i] - d0 }))
        .sort((a, b) => a.dist - b.dist);
    },

    /**
     * Unit polygons for the Doorsnede: [{unitId, name, color, points}] in
     * (chainage, m TAW), or null when there is no fresh correlation.
     */
    sectionGeometry() {
      store.ensureRun();
      const d = store.derived();
      if (!d.hasResult || d.stale) return null;
      return { polygons: d.polygons, units: d.units };
    },

    store
  };
}
