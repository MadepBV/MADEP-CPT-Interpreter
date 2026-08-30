// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Project save/load — file glue around the pure snapshot module.
//
// Save writes the complete project (all CPTs, layer models with manual
// overrides, settings, Stage 6 state, stratigraphy, current phase/stage) to
// a .madep.json file; Load restores it and hands control back to the app to
// rebuild the UI exactly where the engineer left off.

import {
  buildProjectSnapshot,
  validateProjectSnapshot,
  applyProjectSnapshot
} from './snapshot.js';
import { toast } from '../../styles/toast.ts';

function fileStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

function safeName(value) {
  const txt = String(value ?? '')
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return txt || 'project';
}

export function installProjectIO(ctx) {
  // ctx: { getProject, newCptState, getActiveStage(): number,
  //        afterLoad({activeCptIdx, activeStage, phase}), appVersion? }

  function saveProject() {
    const project = ctx.getProject();
    const snapshot = buildProjectSnapshot(project, {
      activeStage: ctx.getActiveStage(),
      savedAt: new Date().toISOString(),
      appVersion: ctx.appVersion || ''
    });
    let text;
    try {
      text = JSON.stringify(snapshot, null, 1);
    } catch (err) {
      // A failed serialisation is reported, not acknowledged (design §3.15). The two
      // invalid-file alerts of `loadProjectFromFile` below stay blocking: their text is locked
      // by tests/golden/node/project-io/invalid-files.json and by the save-load journey's
      // 04-dialogs.json, so they convert with a golden re-record (worklog 25 §3).
      toast(`Project kon niet worden opgeslagen: ${err?.message || err}`, { tone: 'bad' });
      return;
    }
    const a = document.createElement('a');
    const blob = new Blob([text], { type: 'application/json' });
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName(project.name)}_${fileStamp(new Date())}.madep.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }

  async function loadProjectFromFile(file) {
    if (!file) return;
    let snapshot;
    try {
      snapshot = JSON.parse(await file.text());
    } catch {
      alert('Dit bestand is geen geldig MADEP-projectbestand (JSON kon niet worden gelezen).');
      return;
    }
    if (!validateProjectSnapshot(snapshot)) {
      alert('Dit bestand is geen geldig MADEP-projectbestand.');
      return;
    }

    const project = ctx.getProject();
    const hasWork = project.cpts.some((c) => c.data.length || c.layers.length);
    if (hasWork) {
      const ok = window.confirm(
        `Project "${snapshot.project.name}" laden?\n\nHet huidige project (${project.cpts.length} CPT${project.cpts.length === 1 ? '' : 's'}) wordt vervangen. Sla het eerst op als je het wilt bewaren.`
      );
      if (!ok) return;
    }

    const position = applyProjectSnapshot(project, snapshot, { newCptState: ctx.newCptState });
    ctx.afterLoad(position);
  }

  /* The two names the top bar's Save / Open buttons resolve on `window` (PR 20). */
  const handlers = { saveProject, loadProjectFromFile };

  return { saveProject, loadProjectFromFile, handlers };
}
