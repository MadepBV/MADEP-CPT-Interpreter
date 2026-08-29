// SPDX-License-Identifier: AGPL-3.0-or-later
// rows → GEF text. Emits exactly the header lines the app's parser reads
// (legacy-controller.js parseGEF :1346-1434): #COLUMNINFO (index, unit,
// description, quantity id), #MEASUREMENTVAR 14 (water table) and 3 (area ratio),
// #ZID, #PROJECTID/#TESTID/#STARTDATE/#FILEOWNER, #MEASUREMENTTEXT location, #EOH.
// Used only by make-fixtures.mjs; it locks nothing itself.

const DEFAULT_COLUMNS = [
  { qid: 1, unit: 'm', desc: 'Sondeerlengte', key: 'z', dec: 3 },
  { qid: 2, unit: 'MPa', desc: 'Conusweerstand qc', key: 'qc', dec: 4 },
  { qid: 3, unit: 'MPa', desc: 'Wrijvingsweerstand fs', key: 'fs', dec: 6 },
  { qid: 4, unit: '%', desc: 'Wrijvingsgetal Rf', key: 'rf', dec: 3 }
];

/**
 * @param {object} o
 *   rows      [{z,qc,fs,rf,u2}] — fs/rf/u2 may be null (written as the GEF void -9999)
 *   columns   optional column list [{qid, unit, desc, key, dec, scale?}] (default: 1/2/3/4)
 *   header    { project, testid, date, owner, location, wt, zid, aRatio, xy:[x,y] }
 */
export function writeGef({ rows, columns = DEFAULT_COLUMNS, header = {} }) {
  const lines = ['#GEFID= 1, 1, 0', '#FILEDATE= 2026, 1, 1'];
  if (header.project != null) lines.push(`#PROJECTID= ${header.project}`);
  if (header.testid != null) lines.push(`#TESTID= ${header.testid}`);
  if (header.date != null) lines.push(`#STARTDATE= ${header.date}`);
  if (header.owner != null) lines.push(`#FILEOWNER= ${header.owner}`);
  if (header.location != null) lines.push(`#MEASUREMENTTEXT= 9, ${header.location}, lokatie`);
  if (header.zid != null) lines.push(`#ZID= 31000, ${header.zid.toFixed(2)}, 0.0`);
  if (header.xy) lines.push(`#XYID= 31000, ${header.xy[0].toFixed(2)}, ${header.xy[1].toFixed(2)}, 0.0, 0.0`);
  if (header.aRatio != null) lines.push(`#MEASUREMENTVAR= 3, ${header.aRatio}, -, netto oppervlaktequotient`);
  if (header.wt != null) lines.push(`#MEASUREMENTVAR= 14, ${header.wt.toFixed(2)}, m, grondwaterstand`);
  lines.push(`#COLUMN= ${columns.length}`);
  columns.forEach((c, i) => lines.push(`#COLUMNINFO= ${i + 1}, ${c.unit}, ${c.desc}, ${c.qid}`));
  columns.forEach((_, i) => lines.push(`#COLUMNVOID= ${i + 1}, -9999.000`));
  lines.push('#LASTSCAN= ' + rows.length, '#EOH=');
  for (const r of rows) {
    lines.push(columns.map((c) => {
      const v = r[c.key];
      if (v == null || !Number.isFinite(v)) return '-9999.000';
      return ((c.scale ?? 1) * v).toFixed(c.dec);
    }).join(' '));
  }
  return lines.join('\r\n') + '\r\n';
}

export { DEFAULT_COLUMNS as GEF_DEFAULT_COLUMNS };
