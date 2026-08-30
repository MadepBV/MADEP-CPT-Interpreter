// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/contours/palettes.js — the three Seep/Slope contour colour ramps and the stop
// interpolator they share. 01-monolith-map.md §2.11 ("Seepage state + contours", "Deformation
// contours"); moved out of legacy-controller.js in PR 20 / refactor step 10, verbatim.
//
// The sequential and diverging ramps are used by *both* catalogues — the seepage one borrows
// them for every mode except the hydraulic safety factor, which has its own red→blue ramp with
// green at FS = 1 (t = 0.50). Pure: numbers in, {r, g, b} out.

export const ST6_SEEPAGE_HYDRAULIC_FS_CAP = 10;
export const ST6_SEEPAGE_HYDRAULIC_FS_PALETTE = [
  {t:0.00, rgb:[202, 32, 36]},
  {t:0.24, rgb:[243, 150, 36]},
  {t:0.50, rgb:[45, 170, 91]},
  {t:0.74, rgb:[50, 184, 205]},
  {t:1.00, rgb:[33, 93, 188]}
];

export const ST6_DEFORMATION_SEQ_PALETTE = [
  {t:0.00, rgb:[24, 52, 166]},
  {t:0.18, rgb:[36, 118, 224]},
  {t:0.36, rgb:[33, 193, 233]},
  {t:0.55, rgb:[46, 191, 104]},
  {t:0.72, rgb:[244, 223, 67]},
  {t:0.86, rgb:[243, 150, 36]},
  {t:1.00, rgb:[202, 32, 36]}
];
export const ST6_DEFORMATION_SIGNED_PALETTE = [
  {t:0.00, rgb:[25, 58, 168]},
  {t:0.20, rgb:[41, 131, 229]},
  {t:0.40, rgb:[79, 205, 232]},
  {t:0.50, rgb:[250, 245, 198]},
  {t:0.70, rgb:[244, 182, 58]},
  {t:0.85, rgb:[237, 114, 34]},
  {t:1.00, rgb:[196, 33, 34]}
];

export function stage6BishopInterpolatePalette(stops, t){
  const clamped = Math.max(0, Math.min(t, 1));
  for(let index = 1; index < stops.length; index += 1){
    const prev = stops[index - 1];
    const next = stops[index];
    if(clamped > next.t) continue;
    const span = Math.max(next.t - prev.t, 1e-9);
    const localT = (clamped - prev.t) / span;
    return {
      r:Math.round(prev.rgb[0] + (next.rgb[0] - prev.rgb[0]) * localT),
      g:Math.round(prev.rgb[1] + (next.rgb[1] - prev.rgb[1]) * localT),
      b:Math.round(prev.rgb[2] + (next.rgb[2] - prev.rgb[2]) * localT)
    };
  }
  const last = stops[stops.length - 1];
  return {r:last.rgb[0], g:last.rgb[1], b:last.rgb[2]};
}

