// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Soil-profile panel: CPT profile vs single material, vertical shift of the stratigraphy, and the
// per-layer parameter override table (c′ first — the "put c′ to a very low value" decision).
import { numberRow, selectRow, help, accordion, esc, fmt, note } from './panel-kit.js';
import { isEmbedded } from '../wall-types.js';
import { layerBaseParameters, layerKey, buildStrata } from '../soil-profile.js';

function soilInputs(key, m) {
  return `<div class="cols-2 cols-2--fields">
    ${numberRow('γ', `${key}.gammaMoist`, m.gammaMoist, { unit: 'kN/m³', step: 0.5 })}
    ${numberRow('γ<sub>sat</sub>', `${key}.gammaSat`, m.gammaSat, { unit: 'kN/m³', step: 0.5 })}
    ${numberRow("φ′", `${key}.phi`, m.phi, { unit: '°', step: 0.5 })}
    ${numberRow("c′", `${key}.c`, m.c, { unit: 'kPa', step: 0.5 })}
    ${numberRow('c<sub>u</sub>', `${key}.cu`, m.cu, { unit: 'kPa', step: 5 })}
    <label class="field field--inline"><span class="field__text">Framework</span><select class="input input--sm" onchange="retwallSetBool('${key}.drained', this.value === 'drained')"><option value="drained"${m.drained !== false ? ' selected' : ''}>drained (φ′, c′)</option><option value="undrained"${m.drained === false ? ' selected' : ''}>undrained (c<sub>u</sub>)</option></select></label>
  </div>`;
}

export function backfillPanel(rw) {
  if (isEmbedded(rw.wallType)) return '';
  return accordion('backfill', 'Backfill (retained fill)', soilInputs('backfill', rw.backfill), { open: true });
}

function overrideCell(key, field, base, ov, step, digits) {
  const has = ov && ov[field] !== undefined && ov[field] !== null && ov[field] !== '';
  const val = has ? ov[field] : '';
  return `<td><input class="input input--sm input--num${has ? ' is-override' : ''}" type="number" step="${step}" placeholder="${fmt(base, digits)}" value="${esc(val)}" onchange="retwallOverride('${esc(key)}','${field}',this.value)"><span class="tbl__sub mono">${fmt(base, digits)}</span></td>`;
}

export function soilPanel(rw, layers) {
  const embedded = isEmbedded(rw.wallType);
  const nLayers = (layers || []).length;
  const useCpt = rw.insitu.mode !== 'single' && nLayers > 0;
  const title = embedded ? 'Soil profile (retained & excavation side)' : 'Foundation / in-situ soil profile';
  let body = `<label class="field field--inline"><span class="field__text">Soil source</span>
      <select class="input input--sm" onchange="retwallSet('insitu.mode', this.value)">
        <option value="cpt"${rw.insitu.mode !== 'single' ? ' selected' : ''}>CPT layer model${nLayers ? ` (${nLayers} layers)` : ' (none yet)'}</option>
        <option value="single"${rw.insitu.mode === 'single' ? ' selected' : ''}>Single material</option>
      </select></label>`;
  if (!useCpt) {
    body += help(nLayers ? 'A single uniform material replaces the CPT profile:' : 'No CPT layer model yet (run Stages 3–4) — a single uniform material is used:') + soilInputs('insitu', rw.insitu);
    return accordion('soil', title, body, { open: true, pill: 'single material' });
  }
  const off = Number(rw.profile?.offset) || 0;
  body += numberRow('CPT ground level vs. reference', 'profile.offset', off, { unit: 'm', step: 0.1, title: 'CPT ground level minus the reference surface of the wall (retained surface for embedded walls, front ground for gravity walls). Positive: the CPT was pushed from a higher level (profile cut off at the surface). Negative: from a lower level (top layer extended upward).' });
  const surfaceEl = embedded ? Number(rw.embedded.retainedHeight) || 5 : Math.max(Number((rw.wallType === 'gravity' ? rw.gravity : rw.cantilever).frontSoilDepth) || 0, 0);
  const built = buildStrata({ layers, surfaceEl, offset: off, overrides: rw.profile?.overrides || {} });
  const shiftNote = built.notes.filter((t) => /extended upward|cut off/.test(t)).map((t) => note(esc(t), true)).join('');
  body += shiftNote || help('CPT ground level coincides with the reference surface. Enter a shift when the sounding was pushed from a different level than the wall datum.');
  // override table
  const ov = rw.profile?.overrides || {};
  const nOv = Object.keys(ov).filter((k) => ov[k] && Object.values(ov[k]).some((v) => v !== '' && v != null)).length;
  let rows = '';
  layers.forEach((L, i) => {
    const key = layerKey(L, i);
    const base = layerBaseParameters(L);
    const o = ov[key] || {};
    const drained = o.drained !== undefined && o.drained !== null ? !!o.drained : base.drained;
    rows += `<tr>
      <td title="${esc(L.type || '')}${L.subtype ? ' — ' + esc(L.subtype) : ''}"><strong>${esc(L.type || 'layer')}</strong><span class="tbl__sub mono">${fmt(L.top, 2)}–${fmt(L.bot, 2)} m · q<sub>c</sub> ${fmt(L.avgQc, 1)}</span></td>
      ${overrideCell(key, 'gammaMoist', base.gammaMoist, o, 0.5, 1)}
      ${overrideCell(key, 'gammaSat', base.gammaSat, o, 0.5, 1)}
      ${overrideCell(key, 'phi', base.phi, o, 0.5, 1)}
      ${overrideCell(key, 'c', base.c, o, 0.5, 1)}
      ${overrideCell(key, 'cu', base.cu, o, 5, 0)}
      <td><select class="input input--sm" onchange="retwallOverrideDrained('${esc(key)}', this.value)"><option value="base"${o.drained === undefined || o.drained === null ? ' selected' : ''}>auto (${base.drained ? 'dr' : 'undr'})</option><option value="drained"${o.drained === true ? ' selected' : ''}>drained</option><option value="undrained"${o.drained === false ? ' selected' : ''}>undrained</option></select></td>
    </tr>`;
    void drained;
  });
  body += `<div class="card__eyebrow">Characteristic parameters — override where needed</div>
    <div class="tbl-wrap tbl-wrap--capped"><table class="tbl tbl--dense">
      <thead><tr><th>Layer</th><th>γ</th><th>γ<sub>sat</sub></th><th>φ′</th><th>c′</th><th>c<sub>u</sub></th><th>framework</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="actions">
      <span class="field__row"><span class="field__text">c′ for all layers</span><input class="input input--sm input--num input--xs" type="number" step="0.5" min="0" id="retwallAllC" value="0.5"><button type="button" class="btn btn--sm btn--text" onclick="retwallSetAllC(document.getElementById('retwallAllC').value)">apply</button></span>
      <button type="button" class="btn btn--sm btn--text" onclick="retwallClearOverrides()">clear overrides</button>
    </div>
    ${help('Values in grey are the CPT-derived characteristic values (Stage 4). An orange field is an override; it is saved with the project and flagged in the calculation note. A deliberately low c′ (e.g. 0.5 kPa) is the usual conservative choice where the cohesion is uncertain — it raises the active pressure and lowers the passive resistance.')}`;
  return accordion('soil', title, body, { open: true, pill: nOv ? `${nOv} override${nOv > 1 ? 's' : ''}` : (off ? `shift ${off > 0 ? '+' : ''}${fmt(off, 2)} m` : 'CPT profile') });
}
