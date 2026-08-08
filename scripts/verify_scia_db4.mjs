#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification of the SCIA geologic-profile db4 writer (scia-db4.js):
//   - parses the reference payload (exported by SCIA Engineer itself from
//     borehole S1 — embedded below) and checks the decoded values
//   - CLONE TEST: rebuilding that payload from its own parsed data must be
//     byte-identical — proves the writer emits exactly what SCIA emits
//   - ZEP container round-trip (zlib)
//   - 3-profile build → parse-back (the multi-borehole case), absent units
//     at the nominal 0.01 m, tail profile-count patch
//   - integration: stratigraphy store → SOILIN payload → db4

import zlib from 'node:zlib';
import {
  buildGeologicProfilesPayload,
  wrapDb4Container,
  parseGeologicProfilesPayload
} from '../src/lib/cpt-app/stratigraphy/scia-db4.js';
import { createStratigraphyStore } from '../src/lib/cpt-app/stratigraphy/store.js';
import { buildSoilinReportPayload } from '../src/lib/cpt-app/stratigraphy/soilin-report.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Reference payload: inflated from EP_GeologicProfile.db4 (SCIA export, S1).
const SAMPLE_PAYLOAD = Buffer.from(
  'X0VQAFoBAAACAAAABAAAAAEAAAACBwAAAPSlP0+IiNQRq8YAwGxFIzD0pT9PiIjUEavGAMBsRSMwAQAAAALMLeYDw3LcS7kmpEzH6howm2yHGu5m5E+0tekHvhn8nAADAAAAAQAAAAAAAAAZBAIAAAD0pT9PiIjUEavGAMBsRSMwAwAAAAIAAAARBQAAAAAAAFUBAAAAgAEAAAAAAAAAewYAAACOAAAAPABBAFIAQwBIAEkAVgBFAD4APABDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AFUAbgBpAHEAdQBlAEkAZAA+AHsARgAyADkARgBEAEIARgA5AC0AQQBGADIAMQAtADQANABEADkALQBCADAARABEAC0ANQBDAEEANQA3AEYAQwBDADUANABCADUAfQA8AC8AVQBuAGkAcQB1AGUASQBkAD4APABDAE8AYgBqAEQAUwBJAG0AcABsAD4APABJAEQAPgAwADwALwBJAEQAPgA8AC8AQwBPAGIAagBEAFMASQBtAHAAbAA+ADwALwBDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AC8AQQBSAEMASABJAFYARQA+AA0ACgAA+duf8iGv2USw3Vylf8xUtQAAAAAAAAIAAAAAAAEBAAAAAQAAACMDAAAAgAEAAAABAAAAewYAAACOAAAAPABBAFIAQwBIAEkAVgBFAD4APABDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AFUAbgBpAHEAdQBlAEkAZAA+AHsANAAyADIANAAwADQARQA2AC0AQgA5AEEANgAtADQAQgA1ADAALQBCADEAQwA4AC0AMAAyADQAMwBCADgAQwA0ADgANgA5AEIAfQA8AC8AVQBuAGkAcQB1AGUASQBkAD4APABDAE8AYgBqAEQAUwBJAG0AcABsAD4APABJAEQAPgAxADwALwBJAEQAPgA8AC8AQwBPAGIAagBEAFMASQBtAHAAbAA+ADwALwBDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AC8AQQBSAEMASABJAFYARQA+AA0ACgAA5gQkQqa5UEuxyAJDuMSGmwAAAQAAAAIAUwAxAAAIAAAAAQBBAAAAAADAXEVBZmZmZmZm1j8AAAAAAOXQQJqZmZmZmck/zczMzMzMAEAAAAAAAOXQQAAAAAABAEIAAAAAAMIgeEEzMzMzMzPTPwAAAAAAmtBAmpmZmZmZyT+amZmZmZkTQAAAAAAAjtJAAAAAAAEARAABAAAAAGpIQdejcD0K19M/AAAAAABD0kCamZmZmZnJPzMzMzMzMwNAAAAAAABD0kAAAAAAAQBFAAEAAADmFHlBw/UoXI/C1T8AAAAAADDRQJqZmZmZmck/AAAAAAAA8D8AAAAAACTTQAAAAAABAEYAAAAAAAIue0EfhetRuB7VPwAAAAAAxtFAmpmZmZmZyT9mZmZmZmYWQAAAAAAAiNNAAAAAAAEARwAAAAAAOGdQQXsUrkfhetQ/AAAAAAAq0kCamZmZmZnJP83MzMzMzARAAAAAAAAq0kAAAAAAAQBIAAAAAAB4dFNBexSuR+F61D8AAAAAAPjRQJqZmZmZmck/ZmZmZmZm9j8AAAAAAPjRQAAAAAABAEkAAQAAAO7vh0HD9Shcj8LVPwAAAAAA39FAmpmZmZmZyT9mZmZmZmb+PwAAAAAA+NFAAAAAAPYoXI/C9fg/AAAAAAAA/////wIAAACiSIhEw1HUEbNiABBLw7UxAQD0pT9PiIjUEavGAMBsRSMwBQAAAAAAAJEAAAAAAAAAAAAAAAAAAQAAAAHqAQAAAAAAAAAAAAAAAA==',
  'base64'
);

console.log('\n[1] parse the SCIA-authored reference payload');
const parsed = parseGeologicProfilesPayload(new Uint8Array(SAMPLE_PAYLOAD));
check('one profile named S1', parsed.profiles.length === 1 && parsed.profiles[0].name === 'S1');
const s1 = parsed.profiles[0];
check('8 layers', s1.layers.length === 8);
check('layer letters A,B,D..I', s1.layers.map((l) => l.name).join('') === 'ABDEFGHI');
const A = s1.layers[0];
check(
  'A values decoded',
  A.EdefMPa === 2.8 && A.nu === 0.35 && A.gammaDry === 17.3 && A.m === 0.2 && A.thickness === 2.1 && A.gammaSat === 17.3,
  JSON.stringify(A)
);
check('thicknesses sum to 21.9 m', Math.abs(s1.layers.reduce((s, l) => s + l.thickness, 0) - 21.9) < 1e-9);
check('profile scalar read', Math.abs(s1.waterDepth - 1.56) < 1e-9, String(s1.waterDepth));

console.log('\n[2] clone test — rebuild must match SCIA byte-for-byte (up to float dust)');
// The sample stores three Edef values with 1-ulp noise from SCIA's own unit
// conversion (e.g. 3.2 MPa as 3200000.0000000005 N/m²). Our writer emits the
// clean integers, so the only tolerated byte diffs are those mantissa LSBs —
// every diff must sit inside an Edef double whose value differs < 1 N/m².
const cloneSoilin = {
  units: s1.layers.map((l) => ({ letter: l.name, EdefMPa: l.EdefMPa, nu: l.nu, gammaDry: l.gammaDry, gammaSat: l.gammaSat, m: l.m })),
  boreholes: [
    { id: 'S1', waterDepth: s1.waterDepth, rows: s1.layers.map((l, i) => ({ unit: i, thickness: l.thickness, absent: false })) }
  ]
};
const rebuilt = buildGeologicProfilesPayload(cloneSoilin);
check('payload length matches', rebuilt.length === SAMPLE_PAYLOAD.length, `${rebuilt.length} vs ${SAMPLE_PAYLOAD.length}`);
const diffOffsets = [];
for (let i = 0; i < SAMPLE_PAYLOAD.length; i++) if (SAMPLE_PAYLOAD[i] !== rebuilt[i]) diffOffsets.push(i);
const dustOnly = diffOffsets.every((o) => {
  // Locate the enclosing 8-byte double (doubles are unaligned; scan starts).
  for (let start = o - 7; start <= o; start++) {
    if (start < 0 || start + 8 > SAMPLE_PAYLOAD.length) continue;
    const a = SAMPLE_PAYLOAD.readDoubleLE(start);
    const b = Buffer.from(rebuilt).readDoubleLE(start);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 1000 && Math.abs(a - b) < 1) return true;
  }
  return false;
});
check('diffs confined to SCIA float dust', diffOffsets.length <= 8 && dustOnly, `diffs at ${diffOffsets.join(',')}`);
const reparsed = parseGeologicProfilesPayload(rebuilt);
const valuesEqual = reparsed.profiles[0].layers.every((l, i) => {
  const ref = s1.layers[i];
  return (
    l.name === ref.name &&
    Math.abs(l.EdefMPa - ref.EdefMPa) < 1e-6 &&
    l.nu === ref.nu &&
    l.m === ref.m &&
    l.thickness === ref.thickness &&
    Math.abs(l.gammaDry - ref.gammaDry) < 1e-9 &&
    Math.abs(l.gammaSat - ref.gammaSat) < 1e-9
  );
});
check('reparsed rebuild is value-identical', valuesEqual);

console.log('\n[3] ZEP container round-trip');
const deflated = zlib.deflateSync(Buffer.from(rebuilt));
const file = wrapDb4Container(rebuilt, new Uint8Array(deflated));
check('magic ZEP\\0MX8e', Buffer.from(file.slice(0, 8)).equals(Buffer.from([0x5a, 0x45, 0x50, 0x00, 0x4d, 0x58, 0x38, 0x65])));
const dv = new DataView(file.buffer);
check('header sizes', dv.getUint32(8, true) === rebuilt.length && dv.getUint32(12, true) === deflated.length);
const reinflated = zlib.inflateSync(Buffer.from(file.slice(16)));
check('container payload inflates identically', Buffer.compare(reinflated, Buffer.from(rebuilt)) === 0);

console.log('\n[4] multi-profile build (3 boreholes, 10 units, lenses)');
const units10 = 'ABCDEFGHIJ'.split('').map((letter, i) => ({
  letter,
  EdefMPa: 2 + i,
  nu: 0.3,
  gammaDry: 17 + i * 0.1,
  gammaSat: 18 + i * 0.1,
  m: 0.2
}));
const mkRows = (absentIdx) =>
  units10.map((u, i) => ({ unit: i, absent: absentIdx.includes(i), thickness: absentIdx.includes(i) ? 0.01 : 1 + i * 0.1 }));
const soilin3 = {
  units: units10,
  boreholes: [
    { id: 'S1', waterDepth: 1.7, rows: mkRows([2, 9]) },
    { id: 'S2', waterDepth: 1.5, rows: mkRows([]) },
    { id: 'S3', waterDepth: 2.0, rows: mkRows([0]) }
  ]
};
const payload3 = buildGeologicProfilesPayload(soilin3);
const back = parseGeologicProfilesPayload(payload3);
check('3 profiles', back.profiles.length === 3 && back.profiles.map((p) => p.name).join(',') === 'S1,S2,S3');
check('every profile lists all 10 units', back.profiles.every((p) => p.layers.length === 10));
check(
  'absent units at 0.01 m',
  back.profiles[0].layers[2].thickness === 0.01 &&
    back.profiles[0].layers[9].thickness === 0.01 &&
    back.profiles[2].layers[0].thickness === 0.01
);
check('unit order identical across boreholes', back.profiles.every((p) => p.layers.map((l) => l.name).join('') === 'ABCDEFGHIJ'));
check('water depth per borehole', back.profiles.map((p) => p.waterDepth).join(',') === '1.7,1.5,2');
const tailStart = payload3.length - 74;
check('tail profile-count patched to 3', new DataView(payload3.buffer).getUint32(tailStart + 55, true) === 3);
check('parse consumed exactly to tail', back.tailOffset === tailStart);

console.log('\n[5] integration: stratigraphy → SOILIN payload → db4');
const layer = (top, bot, type, subtype) => ({
  top,
  bot,
  type,
  subtype,
  avgQc: 5,
  avgFs: null,
  avgRf: 2,
  g: 18,
  gs: 20,
  phi: 30,
  c: 0,
  cu: 0,
  ovr: {}
});
const project = {
  name: 'p',
  cpts: [
    {
      id: 'C1',
      x: 0,
      y: 0,
      elev: 10,
      wt: 1.7,
      data: [],
      layers: [layer(0, 3, 'Sand', 'zand, matig'), layer(3, 6, 'Clay', 'klei, matig')]
    },
    {
      id: 'C2',
      x: 30,
      y: 0,
      elev: 10,
      wt: 1.4,
      data: [],
      layers: [
        layer(0, 3, 'Sand', 'zand, matig'),
        layer(3, 5, 'Clay', 'klei, matig'),
        layer(5, 6.2, 'Peat / organic', 'veen, matig vast')
      ]
    }
  ]
};
const store = createStratigraphyStore({
  getProject: () => project,
  layerParamsFor: () => ({
    hs: { Eoed_i: 5000, Eoed_ref: 8000, E50_ref: 8000, Eur_ref: 24000, Emc: 5000, Edef: 4000, nu: 0.35, beta: 0.57, psi: 0, m: 1 },
    kh: { kh_rep: 1e-8, kv_rep: 1e-9 }
  })
});
const d = store.run();
const soilin = buildSoilinReportPayload(d, { projectName: 'p', generatedAt: '2026-08-08T00:00:00Z' });
check('peat lens absent in C1 at 0.01 m', soilin.boreholes.find((b) => b.id === 'C1').rows.some((r) => r.absent && r.thickness === 0.01));
check('water depth flows from CPT wt', soilin.boreholes.find((b) => b.id === 'C1').waterDepth === 1.7);
const dbFile = buildGeologicProfilesPayload(soilin);
const dbBack = parseGeologicProfilesPayload(dbFile);
check('db4 from real pipeline parses back', dbBack.profiles.length === 2 && dbBack.profiles[0].layers.length === soilin.units.length);
check('Edef transported in MPa', Math.abs(dbBack.profiles[0].layers[0].EdefMPa - 4) < 1e-9);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll SCIA db4 checks passed.');
process.exit(failures ? 1 : 0);
