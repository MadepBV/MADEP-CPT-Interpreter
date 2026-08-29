// SPDX-License-Identifier: AGPL-3.0-or-later
// Structural golden comparison with per-suite numeric tolerance (design §2.5,
// §4.2): same key set (a missing or extra key fails regardless of value), same
// array lengths, numbers within |a-b| <= max(abs, rel*max(|a|,|b|)), everything
// else strictly equal. Also the readable diff formatter and a line-level text diff.

export function compare(expected, actual, { rel, abs }, path = '', out = []) {
  if (out.length > 500) return out;
  const te = typeof expected, ta = typeof actual;
  if (te === 'number' && ta === 'number') {
    const d = Math.abs(expected - actual);
    if (d > Math.max(abs, rel * Math.max(Math.abs(expected), Math.abs(actual)))) {
      out.push({ path, expected, actual, drel: d / Math.max(Math.abs(expected), 1e-300) });
    }
    return out;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) { out.push({ path, expected: `len ${expected.length}`, actual: `len ${actual.length}` }); return out; }
    expected.forEach((e, i) => compare(e, actual[i], { rel, abs }, `${path}[${i}]`, out));
    return out;
  }
  if (expected && actual && te === 'object' && ta === 'object' && !Array.isArray(expected) && !Array.isArray(actual)) {
    for (const k of Object.keys(expected)) if (!(k in actual)) out.push({ path: `${path}.${k}`, expected: '<present>', actual: '<missing>' });
    for (const k of Object.keys(actual)) if (!(k in expected)) out.push({ path: `${path}.${k}`, expected: '<absent>', actual: '<new key>' });
    for (const k of Object.keys(expected)) if (k in actual) compare(expected[k], actual[k], { rel, abs }, `${path}.${k}`, out);
    return out;
  }
  if (expected !== actual) out.push({ path, expected, actual });
  return out;
}

const fmt = (v) => {
  if (typeof v === 'string') return v.length > 80 ? JSON.stringify(v.slice(0, 77) + '…') : JSON.stringify(v);
  if (v && typeof v === 'object') { const s = JSON.stringify(v); return s.length > 80 ? s.slice(0, 77) + '…' : s; }
  return String(v);
};

export function formatDiffs(diffs, limit = 25) {
  const lines = diffs.slice(0, limit).map((d) =>
    `  ${d.path || '<root>'}: ${fmt(d.expected)} → ${fmt(d.actual)}${d.drel != null ? `  (Δrel ${d.drel.toExponential(2)})` : ''}`);
  if (diffs.length > limit) lines.push(`  … ${diffs.length - limit} more`);
  return lines.join('\n');
}

/** First differing lines of two text goldens (exact compare after normalisation). */
export function textDiff(expected, actual, limit = 25) {
  if (expected === actual) return [];
  const a = String(expected).split('\n'), b = String(actual).split('\n');
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < limit; i++) {
    if (a[i] !== b[i]) out.push({ path: `line ${i + 1}`, expected: a[i] ?? '<eof>', actual: b[i] ?? '<eof>' });
  }
  if (!out.length) out.push({ path: '<text>', expected: `${a.length} lines`, actual: `${b.length} lines` });
  return out;
}
