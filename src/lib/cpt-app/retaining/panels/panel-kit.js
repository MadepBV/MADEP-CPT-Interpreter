// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Tiny HTML helpers shared by the input panels (pure string builders; the window handlers they
 * reference — retwallSet, retwallSetBool, retwallAction — are registered by retaining-ui.js).
 * Markup is the component vocabulary of src/lib/styles/components.css §24 (design-system §5.2 row 2f).
 */
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 2) => Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v).toFixed(d) : '—';
export const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export function numberRow(label, path, value, { unit = '', step = 0.05, min, max, title = '' } = {}) {
  const u = unit ? `<span class="field__unit">${esc(unit)}</span>` : '';
  const attrs = `${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}${title ? ` title="${esc(title)}"` : ''}`;
  return `<label class="field field--inline"><span class="field__text">${label}</span><span class="field__row"><input class="input input--sm input--num" type="number" step="${step}"${attrs} value="${esc(value)}" onchange="retwallSet('${path}', this.value)">${u}</span></label>`;
}

export function selectRow(label, path, value, options, { title = '' } = {}) {
  const opts = options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<label class="field field--inline"${title ? ` title="${esc(title)}"` : ''}><span class="field__text">${label}</span><select class="input input--sm" onchange="retwallSet('${path}', this.value)">${opts}</select></label>`;
}

export function checkRow(label, path, checked, { title = '' } = {}) {
  return `<label class="check"${title ? ` title="${esc(title)}"` : ''}><input type="checkbox" ${checked ? 'checked' : ''} onchange="retwallSetBool('${path}', this.checked)"> ${label}</label>`;
}

export function segmented(path, value, options) {
  return `<span class="segmented segmented--sm segmented--text" role="group">${options.map((o) => `<button type="button" class="segmented__btn" aria-pressed="${String(o.value) === String(value) ? 'true' : 'false'}" onclick="retwallSet('${path}', '${esc(o.value)}')">${esc(o.label)}</button>`).join('')}</span>`;
}

/** Quiet help note; `cls === 'warn'` renders it as a warning verdict instead. */
export function help(text, cls = '') {
  if (cls === 'warn') return `<div class="verdict verdict--warn"><span class="verdict__body">${text}</span></div>`;
  return `<div class="card card--quiet card--note">${text}</div>`;
}
export function note(text, warn = false) {
  return warn ? `<div class="verdict verdict--warn"><span class="verdict__body">${text}</span></div>` : `<div class="card__text">${text}</div>`;
}

export function accordion(id, title, body, { open = false, pill = '' } = {}) {
  return `<details class="acc" data-acc="${id}"${open ? ' open' : ''}><summary class="acc__head acc__head--title">${esc(title)}${pill ? `<span class="pill pill--data acc__badge">${esc(pill)}</span>` : ''}</summary><div class="acc__body acc__body--dense">${body}</div></details>`;
}
