// SPDX-License-Identifier: AGPL-3.0-or-later
// HTML string → whitespace-collapsed visible text, the Node-side stand-in for
// Playwright's innerText (design §1: "DOM text"). Used to lock rendered
// controller markup (#lb, #ma, #cmet, #tuningArea, #stage6Area, the import-review
// overlay) as text, so a restyle that only changes tags/classes is invisible while
// wording, numbers and order stay locked. Style and script blocks are dropped.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', times: '×', rarr: '→', larr: '←', middot: '·', plusmn: '±', sup2: '²', sup3: '³', ndash: '–', mdash: '—', hellip: '…', le: '≤', ge: '≥', ne: '≠', minus: '−' };

export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|section|article|details|summary|table|thead|tbody|option|label|br)\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(td|th)\s*>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n') + '\n';
}
