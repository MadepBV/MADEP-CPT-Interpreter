// SPDX-License-Identifier: AGPL-3.0-or-later
// The single normaliser applied to every JSON golden at record AND check time.
// It owns the mask list (design §2.5, findings F5): timestamps, timing fields,
// random storage keys and entity ids, PNG data URLs, and functions (the
// dewatering result carries `waterTableAtDistance`, stage6-engineering.js:827;
// chart configs carry tick formatters). Keys are sorted at every level so a diff
// is free of positional noise. Numbers are stored raw — never rounded here —
// because rounding hides drift; tolerance belongs to compare.mjs.
export const MASK_KEYS = new Set([
  'generatedAt', 'savedAt', 'capturedAt', 'timing', 'totalMs', 'solveMs', 'generatedMs', 'elapsedMs',
  'runId', 'dataUrl', 'copyMessage', 'copyTone'
]);
// *Ms timings; private/transient keys — except `_maxStage`, which is behaviour
// (stage-nav unlock, legacy-controller.js:1031) and is kept.
export const MASK_KEY_PATTERNS = [/Ms$/, /^_(?!maxStage$)/];
export const MASK_STRING_PATTERNS = [
  [/^(wall|drain|region)_[0-9a-z]+_[0-9a-z]{5}$/, '<id>'],                    // legacy-controller.js:5182, 5323, 5390
  [/^bc-[0-9a-z]+-[0-9a-z]{4}$/, '<id>'],                                      // :5524, :6286
  [/^(stage7-report|retaining-note|soilin-report):\d+-[0-9a-z]+$/, '<key>'],  // report-storage.js:51, note-view.js:35, soilin-report.js:101
  [/^data:image\/png;base64,.*/s, '<png>'],
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, '<iso>']
];
// Substring masks for strings that embed a timing (whole-string patterns above replace
// the value entirely; these keep the wording): stage6BishopCompleteMessage writes
// `… complete in <totalMs> ms.` into bishop.progress.message (legacy-controller.js),
// which is saved with the project and shown in the Stage 6 banner.
export const MASK_SUBSTRING_PATTERNS = [
  [/\b\d+(?:\.\d+)? ms\b/g, '<ms> ms']
];
// Chart.js instances and their ready flag (project-io/snapshot.js:21 strips the same).
export const DROP_KEYS = new Set(['charts', 'chartsReady']);

export function normalize(v, path = '') {
  if (typeof v === 'function' || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);   // NaN / ±Infinity survive JSON as strings
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'string') {
    for (const [re, rep] of MASK_STRING_PATTERNS) if (re.test(v)) return rep;
    let s = v;
    for (const [re, rep] of MASK_SUBSTRING_PATTERNS) s = s.replace(re, rep);
    return s;
  }
  if (Array.isArray(v)) return v.map((x, i) => { const n = normalize(x, `${path}[${i}]`); return n === undefined ? null : n; });
  if (ArrayBuffer.isView(v)) return normalize(Array.from(v), path);        // typed arrays → plain arrays
  if (v instanceof Map) return normalize(Object.fromEntries(v), path);
  if (v instanceof Set) return normalize([...v], path);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (DROP_KEYS.has(k)) continue;
      if (MASK_KEYS.has(k) || MASK_KEY_PATTERNS.some((re) => re.test(k))) { o[k] = '<masked>'; continue; }
      const n = normalize(v[k], `${path}.${k}`);
      if (n !== undefined) o[k] = n;
    }
    return o;
  }
  return v;
}

/** Normalise text goldens: `\n` line endings, single trailing newline. */
export function normalizeText(s) {
  const t = String(s ?? '').replace(/\r\n?/g, '\n');
  return t.endsWith('\n') ? t : t + '\n';
}

import { createHash } from 'node:crypto';
/**
 * Digest of a (normalised) value for parts that are locked in full elsewhere and would
 * only be duplicated here (e.g. the retaining note's copy of the engine result, the CPT
 * rows inside a project snapshot). Any change still flips the golden; the readable diff
 * lives in the suite that owns the data.
 */
export function digest(v) {
  const text = JSON.stringify(normalize(v));
  return { '<digest>': createHash('sha256').update(text).digest('hex').slice(0, 24), bytes: text.length, ...(Array.isArray(v) ? { n: v.length } : {}) };
}
