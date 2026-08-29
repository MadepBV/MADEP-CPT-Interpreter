// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// core/format.js — HTML-string formatting helpers shared by every Stage 6 app.
//
// Moved verbatim out of src/lib/cpt-app/legacy-controller.js (PR 4, refactor step 1):
//   stage6NoteHtml         12433-12440  → noteHtml
//   stage6EscAttr          12442-12448  → escAttr
//   stage6EscJsString      12450-12452  → escJsString
//   stage6Tooltip          12454-12457  → tooltip
//   stage6AuditTableHtml   12686-12693  → auditTableHtml
//   stage6LoadSummaryHtml  12695-12702  → loadSummaryHtml
//   stage6CompactNumber    12704-12716  → compactNumber
// The monolith re-imports them under the old `stage6*` names. Pure: no state,
// no DOM, no imports — safe to load under plain Node.

export function noteHtml(notes){
  if(!notes || !notes.length) return '';
  return notes.map(note=>{
    const color = note.level === 'warn' ? 'var(--wn)' : note.level === 'error' ? 'var(--bad)' : 'var(--ac)';
    const bg = note.level === 'warn' ? 'var(--wnl)' : note.level === 'error' ? 'var(--bad-soft)' : 'var(--bg2)';
    return `<div class="info" style="margin-top:8px;background:${bg};border-color:${color}">${note.text}</div>`;
  }).join('');
}

export function escAttr(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escJsString(value){
  return escAttr(JSON.stringify(String(value ?? '')));
}

export function tooltip(text){
  const safe = escAttr(text);
  return `<span class="st6-tip" tabindex="0" data-tip="${safe}" aria-label="${safe}">ⓘ</span>`;
}

export function auditTableHtml(rows){
  return `
    <table class="tbl st6-audit">
      <thead><tr>${rows.map(r=>`<th>${r.k}</th>`).join('')}</tr></thead>
      <tbody><tr>${rows.map(r=>`<td>${r.v}</td>`).join('')}</tr></tbody>
    </table>
  `;
}

export function loadSummaryHtml(title, rows){
  return `
    <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">${title}</div>
      ${auditTableHtml(rows)}
    </div>
  `;
}

export function compactNumber(value, digits = 2){
  const n = Number(value);
  if(!Number.isFinite(n)) return '—';
  if(n === 0) return '0';
  const abs = Math.abs(n);
  if(abs < 1e-2 || abs >= 1e4){
    return n.toExponential(Math.max(0, digits - 1)).replace('e', 'E');
  }
  if(abs >= 100) return n.toFixed(1).replace(/\.0$/, '');
  if(abs >= 10) return n.toFixed(2).replace(/\.?0+$/, '');
  if(abs >= 1) return n.toFixed(3).replace(/\.?0+$/, '');
  return n.toFixed(4).replace(/\.?0+$/, '');
}
