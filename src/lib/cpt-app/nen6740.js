// SPDX-License-Identifier: AGPL-3.0-or-later

export const NEN6740_DEFAULT_RF = 3.0;

// Source basis:
// - The stress correction exponent 0.67 is documented by the Deltares
//   D-SHEET Piling User Manual for the NEN (Stress Dependent) CPT rule.
// - The RF coefficient magnitude 0.34 is not a published NEN coefficient;
//   it is the regression-fit chart-projection magnitude through the
//   14 digitised reference centres used by this app. The score uses
//   `log10(qcNen) - 0.34 * Rf`, so the conventional regression slope of
//   log10(qcNen) on Rf is approximately -0.34.
export const NEN6740_STRESS_EXPONENT = 0.67;
export const NEN6740_RF_SLOPE = 0.34;

const NEN6740_REFERENCE_POINTS = [
  {subtype:'gravel, slightly silty, moderate', type:'Gravel', g:19, gs:21, phi:37.5, c:0, cu:0, rf:0.35, qcNen:25},
  {subtype:'sand, clean, stiff',               type:'Sand',   g:20, gs:22, phi:40.0, c:0, cu:0, rf:1.00, qcNen:25},
  {subtype:'sand, slightly silty, moderate',   type:'Silty sand', g:19, gs:21, phi:32.5, c:0, cu:0, rf:1.60, qcNen:15},
  {subtype:'sand, very silty, loose',          type:'Silty sand', g:19, gs:21, phi:30.0, c:0, cu:0, rf:2.20, qcNen:7},
  {subtype:'loam, very sandy, stiff',          type:'Sandy clay', g:20, gs:20, phi:35.0, c:1, cu:0, rf:2.45, qcNen:6},
  {subtype:'loam, slightly sandy, weak',       type:'Sandy clay', g:20, gs:20, phi:30.0, c:1, cu:0, rf:3.00, qcNen:3.5},
  {subtype:'clay, very sandy, stiff',          type:'Sandy clay', g:20, gs:20, phi:32.5, c:1, cu:0, rf:3.40, qcNen:4},
  {subtype:'clay, slightly sandy, moderate',   type:'Clay',   g:20, gs:20, phi:22.5, c:13, cu:0, rf:3.85, qcNen:2.8},
  {subtype:'clay, clean, stiff',               type:'Clay',   g:20, gs:20, phi:25.0, c:15, cu:0, rf:4.45, qcNen:2.3},
  {subtype:'clay, clean, weak',                type:'Clay',   g:17, gs:17, phi:17.5, c:5, cu:0, rf:5.15, qcNen:1.0},
  {subtype:'clay, organic, moderate',          type:'Clay',   g:16, gs:16, phi:15.0, c:1, cu:0, rf:6.10, qcNen:0.75},
  {subtype:'clay, organic, weak',              type:'Clay',   g:15, gs:15, phi:15.0, c:1, cu:0, rf:7.05, qcNen:0.22},
  {subtype:'peat, moderately preloaded, moderate', type:'Peat / organic', g:13, gs:13, phi:15.0, c:5, cu:0, rf:8.30, qcNen:0.06},
  {subtype:'peat, not preloaded, weak',        type:'Peat / organic', g:12, gs:12, phi:15.0, c:2.5, cu:0, rf:9.25, qcNen:0.02}
];

/**
 * @param {number} qc
 * @param {number} sigVeff
 */
export function computeNen6740Qc(qc, sigVeff){
  const stress = Math.max(Number.isFinite(sigVeff) ? sigVeff : 1, 1);
  return Math.max(0.01, qc * Math.pow(100 / stress, NEN6740_STRESS_EXPONENT));
}

/**
 * @param {number} qcNen
 * @param {number} [rf]
 */
export function computeNen6740Score(qcNen, rf = NEN6740_DEFAULT_RF){
  return Math.log10(qcNen) - NEN6740_RF_SLOPE * rf;
}

export const NEN6740_MATERIALS = NEN6740_REFERENCE_POINTS.map((entry, index)=>({
  ...entry,
  order:index,
  score:computeNen6740Score(entry.qcNen, entry.rf)
}));

/**
 * @param {number} qcNen
 * @param {number} [rf]
 */
export function classifyNen6740ReferenceSpace(qcNen, rf = NEN6740_DEFAULT_RF){
  const score = computeNen6740Score(qcNen, rf);
  let best = NEN6740_MATERIALS[0];
  let bestDist = Infinity;

  for(const area of NEN6740_MATERIALS){
    const d = Math.abs(score - area.score);
    if(d < bestDist || (Math.abs(d - bestDist) < 1e-9 && area.order < best.order)){
      best = area;
      bestDist = d;
    }
  }

  return { area:best, score, distance:bestDist };
}

/**
 * @param {{qc:number, rf?:number, sigVeff:number}} input
 */
export function classifyNen6740Reading({qc, rf = NEN6740_DEFAULT_RF, sigVeff}){
  const qcNen = computeNen6740Qc(qc, sigVeff);
  const match = classifyNen6740ReferenceSpace(qcNen, rf);
  return { ...match, qcNen };
}
