// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * The one-line outcome of a drivability run, shared by the section drawing, the summary and the
 * calculation note: how deep the described machine drives the element (predicted refusal depth,
 * marginal reach, or target reached). Depths are measured from the platform (retained surface).
 */
const fmt = (v, d = 2) => (v != null && Number.isFinite(Number(v))) ? Number(v).toFixed(d) : '—';

/** @returns {{ z:number, reaches:boolean, level:'ok'|'warn'|'bad', label:string, short:string } | null} */
export function drivabilityMarker(rw) {
  const R = rw?.drivability?.result;
  if (!R?.ok) return null;
  if (R.vibratory?.candidateCheck) {
    const c = R.vibratory.candidateCheck;
    const name = R.machineLabel || 'vibrator';
    if (!c.reachesTarget) return { z: c.refusalDepth_m, reaches: false, level: 'bad', short: `refusal ≈ ${fmt(c.refusalDepth_m)} m`, label: `${name}: refusal ≈ ${fmt(c.refusalDepth_m)} m` };
    if (!c.reachesTarget125) return { z: c.refusalDepth125_m, reaches: true, level: 'warn', short: `reaches target, no 1.25 reserve below ${fmt(c.refusalDepth125_m)} m`, label: `${name}: target reached, no 1.25 reserve below ${fmt(c.refusalDepth125_m)} m` };
    return { z: c.targetDepth_m, reaches: true, level: 'ok', short: `reaches ${fmt(c.targetDepth_m)} m with 1.25 reserve`, label: `${name}: reaches ${fmt(c.targetDepth_m)} m (1.25 reserve)` };
  }
  if (R.push) {
    const c = R.push;
    const name = `push ${fmt(c.force_kN, 0)} kN`;
    if (!c.reachesTarget) return { z: c.refusalDepth_m, reaches: false, level: 'bad', short: `refusal ≈ ${fmt(c.refusalDepth_m)} m`, label: `${name}: refusal ≈ ${fmt(c.refusalDepth_m)} m` };
    if (!c.reachesTarget125) return { z: c.refusalDepth125_m, reaches: true, level: 'warn', short: `reaches target, no 1.25 reserve below ${fmt(c.refusalDepth125_m)} m`, label: `${name}: target reached, no 1.25 reserve below ${fmt(c.refusalDepth125_m)} m` };
    return { z: c.targetDepth_m, reaches: true, level: 'ok', short: `reaches ${fmt(c.targetDepth_m)} m with 1.25 reserve`, label: `${name}: reaches ${fmt(c.targetDepth_m)} m (1.25 reserve)` };
  }
  if (R.impact) {
    if (R.impact.refusalDepth_m != null) return { z: R.impact.refusalDepth_m, reaches: false, level: 'bad', short: `refusal ≈ ${fmt(R.impact.refusalDepth_m)} m`, label: `impact refusal ≈ ${fmt(R.impact.refusalDepth_m)} m` };
    return { z: R.target, reaches: true, level: 'ok', short: `reaches ${fmt(R.target)} m`, label: `impact hammer reaches ${fmt(R.target)} m` };
  }
  return null;
}
