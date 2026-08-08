// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Tabular CPT parsing core — the single implementation of header detection,
// number parsing, unit conversion and row building shared by the Excel and
// CSV importers (previously duplicated inside the legacy controller) and by
// the import-review dialog, which re-derives rows live when the engineer
// remaps a column. Pure: no DOM, fully testable in Node.

export function normalizeHeaderLabel(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
}

export const isDepthHeader = (label) =>
  /\bdepth\b/.test(label) || /\bdiepte\b/.test(label) || /penetratie lengte/.test(label);
export const isQcHeader = (label) =>
  /\bqc\b/.test(label) || /cone resistance/.test(label) || /conus weerstand/.test(label);
export const isFsHeader = (label) =>
  /\bfs\b/.test(label) || /sleeve friction/.test(label) || /plaatselijke wrijving/.test(label);
export const isRfHeader = (label) =>
  /\brf\b/.test(label) || /friction ratio/.test(label) || /wrijvingsgetal/.test(label);

/** First row (scanning the top 40) containing both a depth and a qc header. */
export function findDataHeaderRow(rows) {
  const max = Math.min(rows.length, 40);
  for (let i = 0; i < max; i++) {
    const labels = (rows[i] || []).map(normalizeHeaderLabel);
    if (labels.some(isDepthHeader) && labels.some(isQcHeader)) return i;
  }
  return -1;
}

export function findColumn(headers, predicate) {
  for (let i = 0; i < headers.length; i++) {
    if (predicate(normalizeHeaderLabel(headers[i]))) return i;
  }
  return -1;
}

/** Auto-detected column mapping for a grid's header row. -1 = not found. */
export function detectColumns(headers) {
  return {
    z: findColumn(headers, isDepthHeader),
    qc: findColumn(headers, isQcHeader),
    fs: findColumn(headers, isFsHeader),
    rf: findColumn(headers, isRfHeader)
  };
}

/** Tolerant numeric parse: handles strings, comma decimals, thousands marks. */
export function parseCptNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Convert a raw qc/fs value to MPa using the column label's declared unit,
    falling back to magnitude heuristics per measurement kind. */
export function cptValueToMPa(raw, unit, fallbackKind) {
  if (raw == null || isNaN(raw)) return null;
  const u = String(unit || '').toLowerCase();
  if (u.includes('mpa')) return raw;
  if (u.includes('kpa')) return raw / 1000;
  if (u === 'pa' || u.endsWith(' pa') || u.startsWith('pa ') || /\bpa\b/.test(u)) return raw / 1e6;
  if (fallbackKind === 'qc') {
    return raw > 100 ? raw / 1000 : raw;
  }
  if (fallbackKind === 'fs') {
    if (Math.abs(raw) > 1000) return raw / 1e6;
    if (Math.abs(raw) > 10) return raw / 1000;
  }
  return raw;
}

/**
 * Build CPT readings from a tabular grid with a given column mapping.
 * Identical semantics to the historical Excel/CSV import loop.
 *
 * @param {Array<Array>} grid      raw sheet rows (header row included)
 * @param {number} headerIdx       index of the header row in grid
 * @param {{z:number, qc:number, fs:number, rf:number}} cols  -1 = absent
 * @returns {{ rows: Array<{z,qc,fs,rf,u2}>,
 *             skipped: Array<{gridRow:number, reason:string}> }}
 */
export function buildRowsFromGrid(grid, headerIdx, cols) {
  const headers = grid[headerIdx] || [];
  const qcUnit = cols.qc >= 0 ? headers[cols.qc] || '' : '';
  const fsUnit = cols.fs >= 0 ? headers[cols.fs] || '' : '';
  const rows = [];
  const skipped = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = grid[i] || [];
    const z = parseCptNumber(raw[cols.z]);
    const qcRaw = parseCptNumber(raw[cols.qc]);
    const fsRaw = cols.fs >= 0 ? parseCptNumber(raw[cols.fs]) : null;
    const rfRaw = cols.rf >= 0 ? parseCptNumber(raw[cols.rf]) : null;
    if (z == null || qcRaw == null || z < 0) {
      skipped.push({ gridRow: i, reason: z == null || qcRaw == null ? 'diepte/qc niet numeriek' : 'negatieve diepte' });
      continue;
    }

    const qc = cptValueToMPa(qcRaw, qcUnit, 'qc');
    const fs = fsRaw != null ? cptValueToMPa(fsRaw, fsUnit, 'fs') : null;
    if (qc == null || qc < 0.02) {
      skipped.push({ gridRow: i, reason: `qc < 0.02 MPa (conus niet in de grond)` });
      continue;
    }

    let rf = null;
    if (rfRaw != null && rfRaw >= 0 && rfRaw < 50) {
      rf = Math.min(rfRaw, 20);
    } else if (fs != null && qc > 0.05) {
      rf = Math.max(0, Math.min(20, (Math.abs(fs) / qc) * 100));
    }

    rows.push({
      z: +z.toFixed(4),
      qc: +qc.toFixed(4),
      fs: fs != null ? +fs.toFixed(6) : null,
      rf: rf != null ? +rf.toFixed(3) : null,
      u2: null
    });
  }
  rows.sort((a, b) => a.z - b.z);
  return { rows, skipped };
}

/** First non-empty sample values of one grid column below the header. */
export function columnSamples(grid, headerIdx, colIdx, count = 3) {
  if (colIdx < 0) return [];
  const out = [];
  for (let i = headerIdx + 1; i < grid.length && out.length < count; i++) {
    const v = (grid[i] || [])[colIdx];
    if (v != null && String(v).trim() !== '') out.push(v);
  }
  return out;
}

/** Data-quality summary of built readings, per measurement channel. */
export function summarizeRows(rows) {
  const n = rows.length;
  const missingFsRf = rows.filter((r) => r.fs == null && r.rf == null);
  return {
    n,
    depthMin: n ? rows[0].z : null,
    depthMax: n ? rows[n - 1].z : null,
    fsCount: rows.filter((r) => r.fs != null).length,
    rfCount: rows.filter((r) => r.rf != null).length,
    u2Count: rows.filter((r) => r.u2 != null).length,
    missingFsRfCount: missingFsRf.length,
    missingFsRfDepths: missingFsRf.map((r) => r.z),
    // Are the fs/Rf gaps confined to the profile's tail? (typical: the final
    // reading of a push carries qc only)
    missingOnlyTrailing:
      missingFsRf.length > 0 && missingFsRf.every((r, i) => r.z === rows[n - missingFsRf.length + i]?.z)
  };
}
