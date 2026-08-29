// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// core/dom.js — the small DOM helpers of monolith map §6.1 (`core/` row).
//
// Nothing was moved here: src/lib/cpt-app/legacy-controller.js has no such
// wrappers today (≈600 inline `document.getElementById(...)` calls). They are
// introduced in PR 4 so the following extraction steps can adopt them; the
// monolith is not rewritten to use them in this PR (pure move, bit-identical).
// All helpers are null-safe and no-ops under Node (no `document`).

export function byId(id){
  if(typeof document === 'undefined') return null;
  return document.getElementById(id);
}

export function setText(id, text){
  const el = byId(id);
  if(el) el.textContent = text;
  return el;
}

export function setHtml(id, html){
  const el = byId(id);
  if(el) el.innerHTML = html;
  return el;
}

export function toggleClass(id, className, on){
  const el = byId(id);
  if(!el || !el.classList) return el;
  if(on === undefined) el.classList.toggle(className);
  else if(on) el.classList.add(className);
  else el.classList.remove(className);
  return el;
}
