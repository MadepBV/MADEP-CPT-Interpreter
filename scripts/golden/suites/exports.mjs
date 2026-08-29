// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the text exports (design §1.5, F8): exportCSV (layer CSV), exportPlaxisCommands
// (PLAXIS material commands + its nu/drainage alert), exportPlaxisCpt (simulated CPT
// trace, CRLF normalised to LF), and saveProject (normalised project snapshot); download
// file names are locked with the clock stamp masked.

import { digest } from '../lib/normalize.mjs';

export const name = 'exports';
export const tolerance = 'pure';
export const description = 'CSV / PLAXIS / simulated CPT / project downloads as text';

const decode = (entry) => entry.href.startsWith('data:') ? decodeURIComponent(entry.href.slice(entry.href.indexOf(',') + 1)) : null;
const maskStamp = (s) => String(s).replace(/_\d{8}-\d{4}\.madep\.json$/, '_<stamp>.madep.json');

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.cptNames()) {
    await ctx.classify(fx, 'sb260');
    api.goS(3);
    const names = {};
    c.captured.length = 0; c.alerts.length = 0;
    api.exportCSV(); names.csv = c.captured.at(-1)?.download; yield { id: `${fx}.layers`, kind: 'csv', value: decode(c.captured.at(-1)) };
    api.exportPlaxisCommands(); names.plaxis = c.captured.at(-1)?.download; yield { id: `${fx}.plaxis`, kind: 'txt', value: decode(c.captured.at(-1)) };
    yield { id: `${fx}.plaxis-alerts`, value: c.alerts.slice() };
    api.exportPlaxisCpt(); names.plaxisCpt = c.captured.at(-1)?.download; yield { id: `${fx}.plaxis-cpt`, kind: 'txt', value: decode(c.captured.at(-1)) };
    api.saveProject(); const dl = c.captured.at(-1); names.project = maskStamp(dl?.download);
    const snap = dl?.blob ? JSON.parse(await dl.blob.text()) : null;
    if (snap) snap.project.cpts = snap.project.cpts.map((cpt) => ({ ...cpt, data: digest(cpt.data), classified: digest(cpt.classified) }));   // rows are locked by import/classification
    yield { id: `${fx}.project`, value: snap };
    yield { id: `${fx}.filenames`, value: names };
  }
  // guard paths: exports without layers alert instead of downloading
  await ctx.resetProject();
  c.captured.length = 0; c.alerts.length = 0;
  api.exportCSV(); api.exportPlaxisCommands(); api.exportPlaxisCpt();
  yield { id: 'no-layers.alerts', value: { alerts: c.alerts.slice(), downloads: c.captured.length } };

}
