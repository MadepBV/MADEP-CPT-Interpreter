// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// SCIA Engineer geologic-profile library writer (EP_GeologicProfile.db4).
//
// Format reverse-engineered from a user-provided sample exported by SCIA
// Engineer (EP_GeologicProfile.db4, one borehole "S1", 8 layers):
//
//   file      = "ZEP\0" "MX8e" u32 uncompressedLen, u32 compressedLen,
//               zlib(payload)
//   payload   = HEAD (816 B, constant class registry: "_EP\0Z" header, two
//               UTF-16 <ARCHIVE><CLASSPARENT> blocks with the geologic-
//               profile class GUIDs)
//             + u32 profileCount
//             + profileCount × profile
//             + TAIL (74 B, class CLSIDs + library epilogue; the u32 at
//               tail offset 55 mirrors the profile count)
//   profile   = u16 nameLen, UTF-16LE name, u8 0, u32 layerCount,
//               layerCount × layer,
//               f64 waterDepth, 6×u8 0, i32 -1, u32 2
//   layer     = u16 nameLen, UTF-16LE name,
//               f64 E_def [N/m²], f64 ν [-], f64 γ_dry [N/m³], f64 m [-],
//               f64 thickness [m], f64 γ_sat [N/m³], u32 0
//
// All multi-byte values little-endian. Verified by byte-identical
// reconstruction of the sample payload (scripts/verify_scia_db4.mjs).
// The per-profile trailing scalar is written as the borehole's water-table
// depth (the sample carried a hand-entered value there) — check it once in
// SCIA's profile dialog after the first import.

const HEAD_B64 =
  'X0VQAFoBAAACAAAABAAAAAEAAAACBwAAAPSlP0+IiNQRq8YAwGxFIzD0pT9PiIjUEavGAMBsRSMwAQAAAALMLeYDw3LcS7kmpEzH6howm2yHGu5m5E+0tekHvhn8nAADAAAAAQAAAAAAAAAZBAIAAAD0pT9PiIjUEavGAMBsRSMwAwAAAAIAAAARBQAAAAAAAFUBAAAAgAEAAAAAAAAAewYAAACOAAAAPABBAFIAQwBIAEkAVgBFAD4APABDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AFUAbgBpAHEAdQBlAEkAZAA+AHsARgAyADkARgBEAEIARgA5AC0AQQBGADIAMQAtADQANABEADkALQBCADAARABEAC0ANQBDAEEANQA3AEYAQwBDADUANABCADUAfQA8AC8AVQBuAGkAcQB1AGUASQBkAD4APABDAE8AYgBqAEQAUwBJAG0AcABsAD4APABJAEQAPgAwADwALwBJAEQAPgA8AC8AQwBPAGIAagBEAFMASQBtAHAAbAA+ADwALwBDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AC8AQQBSAEMASABJAFYARQA+AA0ACgAA+duf8iGv2USw3Vylf8xUtQAAAAAAAAIAAAAAAAEBAAAAAQAAACMDAAAAgAEAAAABAAAAewYAAACOAAAAPABBAFIAQwBIAEkAVgBFAD4APABDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AFUAbgBpAHEAdQBlAEkAZAA+AHsANAAyADIANAAwADQARQA2AC0AQgA5AEEANgAtADQAQgA1ADAALQBCADEAQwA4AC0AMAAyADQAMwBCADgAQwA0ADgANgA5AEIAfQA8AC8AVQBuAGkAcQB1AGUASQBkAD4APABDAE8AYgBqAEQAUwBJAG0AcABsAD4APABJAEQAPgAxADwALwBJAEQAPgA8AC8AQwBPAGIAagBEAFMASQBtAHAAbAA+ADwALwBDAEwAQQBTAFMAUABBAFIARQBOAFQAPgA8AC8AQQBSAEMASABJAFYARQA+AA0ACgAA5gQkQqa5UEuxyAJDuMSGmwAA';
const TAIL_B64 =
  'okiIRMNR1BGzYgAQS8O1MQEA9KU/T4iI1BGrxgDAbEUjMAUAAAAAAACRAAAAAAAAAAAAAAAAAAEAAAAB6gEAAAAAAAAAAAAAAAA=';
const TAIL_COUNT_OFFSET = 55; // u32 mirroring the profile count

function b64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  bytes(arr) {
    this.chunks.push(arr);
    this.length += arr.length;
  }
  u8(v) {
    this.bytes(new Uint8Array([v & 0xff]));
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.bytes(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.bytes(b);
  }
  i32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this.bytes(b);
  }
  f64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, Number.isFinite(v) ? v : 0, true);
    this.bytes(b);
  }
  utf16(text) {
    const s = String(text ?? '');
    const b = new Uint8Array(s.length * 2);
    const dv = new DataView(b.buffer);
    for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
    this.bytes(b);
  }
  concat() {
    const out = new Uint8Array(this.length);
    let o = 0;
    this.chunks.forEach((c) => {
      out.set(c, o);
      o += c.length;
    });
    return out;
  }
}

/**
 * Build the uncompressed db4 payload from the SOILIN report payload
 * (soilin-report.js buildSoilinReportPayload) — one geologic profile per
 * borehole, every unit present in fixed order (locally absent units carry
 * the nominal 0.01 m thickness the payload already assigns).
 */
export function buildGeologicProfilesPayload(soilin) {
  const w = new ByteWriter();
  w.bytes(b64ToBytes(HEAD_B64));

  w.u32(soilin.boreholes.length);
  soilin.boreholes.forEach((bh) => {
    const name = String(bh.id || 'CPT');
    w.u16(name.length);
    w.utf16(name);
    w.u8(0);
    w.u32(bh.rows.length);
    bh.rows.forEach((row) => {
      const u = soilin.units[row.unit];
      const layerName = String(u.letter || '?');
      w.u16(layerName.length);
      w.utf16(layerName);
      // Whole N/m² / N/m³ — matches SCIA's own storage granularity and keeps
      // parse→build reconstruction byte-exact.
      w.f64(Math.round((u.EdefMPa ?? 0) * 1e6)); // MPa → N/m²
      w.f64(u.nu ?? 0);
      w.f64(Math.round((u.gammaDry ?? 0) * 1000)); // kN/m³ → N/m³
      w.f64(u.m ?? 0);
      w.f64(row.thickness ?? 0);
      w.f64(Math.round((u.gammaSat ?? 0) * 1000));
      w.u32(0);
    });
    w.f64(bh.waterDepth ?? 0);
    w.bytes(new Uint8Array(6));
    w.i32(-1);
    w.u32(2);
  });

  const tail = b64ToBytes(TAIL_B64).slice();
  new DataView(tail.buffer, tail.byteOffset).setUint32(TAIL_COUNT_OFFSET, soilin.boreholes.length, true);
  w.bytes(tail);
  return w.concat();
}

/** Wrap a payload and its zlib-deflated form in the ZEP db4 container. */
export function wrapDb4Container(payload, deflated) {
  const out = new Uint8Array(16 + deflated.length);
  out.set([0x5a, 0x45, 0x50, 0x00, 0x4d, 0x58, 0x38, 0x65], 0); // "ZEP\0MX8e"
  const dv = new DataView(out.buffer);
  dv.setUint32(8, payload.length, true);
  dv.setUint32(12, deflated.length, true);
  out.set(deflated, 16);
  return out;
}

/** Parse a db4 payload's profile table — used by verification and available
    for future import support. Throws on structural mismatch. */
export function parseGeologicProfilesPayload(payload) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let o = b64ToBytes(HEAD_B64).length;
  const readName = () => {
    const len = dv.getUint16(o, true);
    o += 2;
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(dv.getUint16(o, true));
      o += 2;
    }
    return s;
  };
  const profileCount = dv.getUint32(o, true);
  o += 4;
  const profiles = [];
  for (let p = 0; p < profileCount; p++) {
    const name = readName();
    o += 1; // pad
    const layerCount = dv.getUint32(o, true);
    o += 4;
    const layers = [];
    for (let i = 0; i < layerCount; i++) {
      const layerName = readName();
      const vals = [];
      for (let k = 0; k < 6; k++) {
        vals.push(dv.getFloat64(o, true));
        o += 8;
      }
      o += 4; // trailing u32 0
      layers.push({
        name: layerName,
        EdefMPa: vals[0] / 1e6,
        nu: vals[1],
        gammaDry: vals[2] / 1000,
        m: vals[3],
        thickness: vals[4],
        gammaSat: vals[5] / 1000
      });
    }
    const waterDepth = dv.getFloat64(o, true);
    o += 8 + 6 + 4 + 4; // waterDepth, pad, -1, 2
    profiles.push({ name, waterDepth, layers });
  }
  return { profiles, tailOffset: o };
}
