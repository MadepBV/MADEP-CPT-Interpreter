// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Tiny HTML helpers shared by the input panels (pure string builders; the window handlers they
 * reference — retwallSet, retwallSetBool, retwallAction — are registered by retaining-ui.js).
 */
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 2) => Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v).toFixed(d) : '—';
export const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export function numberRow(label, path, value, { unit = '', step = 0.05, min, max, title = '' } = {}) {
  const u = unit ? `<span class="st6-rw-unit">${esc(unit)}</span>` : '';
  const attrs = `${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}${title ? ` title="${esc(title)}"` : ''}`;
  return `<label class="st6-rw-field"><span>${label}</span><span class="st6-rw-inwrap"><input type="number" step="${step}"${attrs} value="${esc(value)}" onchange="retwallSet('${path}', this.value)">${u}</span></label>`;
}

export function selectRow(label, path, value, options, { title = '' } = {}) {
  const opts = options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<label class="st6-rw-field"${title ? ` title="${esc(title)}"` : ''}><span>${label}</span><select onchange="retwallSet('${path}', this.value)">${opts}</select></label>`;
}

export function checkRow(label, path, checked, { title = '' } = {}) {
  return `<label class="st6-rw-check"${title ? ` title="${esc(title)}"` : ''}><input type="checkbox" ${checked ? 'checked' : ''} onchange="retwallSetBool('${path}', this.checked)"> ${label}</label>`;
}

export function segmented(path, value, options) {
  return `<span class="st6-rw-seg">${options.map((o) => `<button type="button" class="${String(o.value) === String(value) ? 'sel' : ''}" onclick="retwallSet('${path}', '${esc(o.value)}')">${esc(o.label)}</button>`).join('')}</span>`;
}

export function help(text, cls = '') { return `<div class="st6-help ${cls}" style="margin-top:5px">${text}</div>`; }
export function note(text, warn = false) { return `<div class="st6-rw-note${warn ? ' warn' : ''}">${text}</div>`; }

export function accordion(id, title, body, { open = false, pill = '' } = {}) {
  return `<details class="st6-rw-acc" data-acc="${id}"${open ? ' open' : ''}><summary>${esc(title)}${pill ? `<span class="st6-rw-pill">${esc(pill)}</span>` : ''}</summary><div class="st6-rw-accbody">${body}</div></details>`;
}
