// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck — plain ES module with JSDoc contracts and runtime input guards (repo pattern, see PLAN §5)
/**
 * Static resistance to driving (SRD) profiles from a single CPT trace.
 *
 * Purpose
 *   Turn a CPT (depth, q_c, f_s) into per-depth unit resistances and an integrated
 *   static resistance at every trial toe depth, on a uniform grid below the
 *   pile-driving platform. The result feeds the vibratory (force-envelope) and impact
 *   (wave-equation) drivability runners.
 *
 * Units (SI, explicit in names)
 *   depth / z ........ m below the platform (positive down)
 *   q_c .............. MPa in the input, kPa in the output (1 kPa·m² = 1 kN)
 *   f_s, τ ........... kPa
 *   areas ............ m², perimeters m, forces kN
 *
 * Methods
 *   'reference'  — course §7.2 "static reference unit resistance": q_s = q_c, τ_s = f_s,
 *                  optionally scaled by user factors (options.toeFactor, options.shaftFactor).
 *                  This is an illustrative upper-bound screen, not a pile design method
 *                  (course §7.2, §18.2). Averaging of q_c around the toe is optional
 *                  (options.toeAveragingWindow_m; default 0 = point value, as in the course).
 *   'alm-hamre'  — Alm, T. & Hamre, L. (2001) "Soil model for pile driveability predictions
 *                  based on CPT interpretations", Proc. 15th ICSMGE Istanbul, pp. 1297-1302.
 *                  Verified from the ISSMGE open-access PDF
 *                  (https://www.issmge.org/uploads/publications/1/30/2001_02_0104.pdf):
 *                    (1) f_s(z; p) = f_s,res + (f_s,i − f_s,res)·exp(−k·(p − z))   p = tip penetration
 *                    (2) clay:  f_s,i = f_s(CPT),  f_s,res = 0.004·q_T·(1 − 0.0025·q_T/p0′)
 *                    (3,4) sand: f_s,i = K·p0′·tan δ with K·p0′ = 0.0132·q_T·(p0′/p_a)^0.13, f_s,res = 0.2·f_s,i
 *                    (5) k = (q_T/p0′)^0.5 / 80
 *                    (6) sand: q_tip = 0.15·q_T·(q_T/p0′)^0.2 ; clay: q_tip = 0.6·q_T
 *                  p0′ = effective overburden, p_a = 100 kPa, δ = constant-volume interface
 *                  friction angle (degrees), q_T = total (pore-pressure corrected) cone resistance.
 *                  The paper's sand friction is calibrated for OUTSIDE friction only; for open
 *                  piles with inside friction the authors recommend 50 % on both faces
 *                  (options.almHamre.insideFriction = 'half-both'). Unplugged piles assumed.
 *                  The paper recommends ×1.25 for an upper-bound profile (options.srdFactor).
 *
 * Assumptions / caveats (also emitted as notes where relevant)
 *   - q_c is used where Alm & Hamre write q_T (no u2 correction is applied here).
 *   - Depths beyond the CPT: last value held, note emitted.
 *   - Null f_s: replaced by options.assumedFrictionRatioPct·q_c/100, note emitted.
 *   - p0′ for Alm & Hamre is computed from options.almHamre.gamma_kN_m3 (bulk) and
 *     waterTable_m (depth below platform) unless sigmaV0_kPa[] is supplied; floor 1 kPa.
 *   - No Eurocode partial factors are applied (course §18.5; PLAN D10).
 */

const PA_KPA = 100;
const GAMMA_W = 9.81;

/**
 * @param {object} args
 * @param {{depth:number[], qc:number[], fs?:(number|null)[], groundLevelOffset?:number}} args.cpt
 * @param {{toeArea_m2:number, shaftPerimeter_m:number, innerPerimeter_m?:number,
 *          interlockResistance_kN_m?:number, plugRatio?:number, steelArea_m2?:number}} args.pile
 * @param {'reference'|'alm-hamre'} [args.method]
 * @param {object} [args.options]
 * @returns {{ok:boolean, method:string, z:number[], dz:number, qToe_kPa:number[], tauShaft_kPa:number[],
 *   frictionRatioPct:number[], cumulativeShaft_kN:number[], interlock_kN:number[], toe_kN:number[],
 *   Rstatic_kN:number[], pile:object, almHamre?:object, notes:string[]}}
 */
export function buildDrivingResistanceProfile({ cpt, pile, method = 'reference', options = {} }) {
  const notes = [];
  const fail = (msg) => ({ ok: false, method, z: [], dz: 0, qToe_kPa: [], tauShaft_kPa: [], frictionRatioPct: [],
    cumulativeShaft_kN: [], interlock_kN: [], toe_kN: [], Rstatic_kN: [], pile: null, notes: [msg] });

  if (!cpt || !Array.isArray(cpt.depth) || !Array.isArray(cpt.qc) || cpt.depth.length < 2) return fail('CPT needs depth[] and qc[] with at least two points.');
  if (cpt.depth.length !== cpt.qc.length) return fail('CPT depth[] and qc[] lengths differ.');
  const P = normalizePile(pile, notes);
  if (!P) return fail('Pile needs finite toeArea_m2 > 0 and shaftPerimeter_m > 0.');

  const dz = finitePos(options.dz) ? options.dz : 0.10;
  const offset = Number.isFinite(cpt.groundLevelOffset) ? cpt.groundLevelOffset : 0;
  const assumedFR = finitePos(options.assumedFrictionRatioPct) ? options.assumedFrictionRatioPct : 1.0;
  const toeFactor = finitePos(options.toeFactor) ? options.toeFactor : 1.0;
  const shaftFactor = finitePos(options.shaftFactor) ? options.shaftFactor : 1.0;
  const srdFactor = finitePos(options.srdFactor) ? options.srdFactor : 1.0;
  const toeWin = finitePos(options.toeAveragingWindow_m) ? options.toeAveragingWindow_m : 0;

  // --- clean the trace: depth below platform, finite q_c, f_s fallback ------------------
  const pts = [];
  let nullFs = 0, badQc = 0;
  for (let i = 0; i < cpt.depth.length; i++) {
    const d = cpt.depth[i], q = cpt.qc[i];
    if (!Number.isFinite(d) || !Number.isFinite(q)) { badQc++; continue; }
    const qkPa = Math.max(0, q) * 1000;
    let f = Array.isArray(cpt.fs) ? cpt.fs[i] : null;
    if (!Number.isFinite(f) || f < 0) { f = assumedFR / 100 * qkPa; nullFs++; }
    pts.push({ z: d - offset, qc: qkPa, fs: f });
  }
  if (pts.length < 2) return fail('CPT has fewer than two usable (finite) points.');
  pts.sort((a, b) => a.z - b.z);
  if (badQc) notes.push(`${badQc} CPT rows with non-finite depth/q_c were skipped.`);
  if (nullFs) notes.push(`${nullFs} CPT rows without f_s: f_s = ${assumedFR} % · q_c assumed (options.assumedFrictionRatioPct).`);
  if (offset !== 0) notes.push(`CPT ground level is ${offset > 0 ? 'above' : 'below'} the platform by ${Math.abs(offset).toFixed(2)} m; depths shifted accordingly.`);

  const zCptTop = pts[0].z, zCptBot = pts[pts.length - 1].z;
  const zMax = finitePos(options.maxDepth_m) ? options.maxDepth_m : zCptBot;
  if (zMax > zCptBot + 1e-9) notes.push(`Profile extends ${(zMax - zCptBot).toFixed(2)} m below the CPT end (${zCptBot.toFixed(2)} m): last q_c/f_s held constant.`);
  if (zCptTop > dz + 1e-9) notes.push(`CPT starts ${zCptTop.toFixed(2)} m below the platform: first q_c/f_s held constant above it.`);
  if (zCptTop < -1e-9) notes.push(`CPT data above the platform (${(-zCptTop).toFixed(2)} m) ignored.`);

  const n = Math.max(1, Math.round(zMax / dz));
  const z = new Array(n);
  const qc = new Array(n), fs = new Array(n), FR = new Array(n);
  for (let j = 0; j < n; j++) {
    z[j] = +(dz * (j + 1)).toFixed(6);
    const zc = z[j] - dz / 2; // interval centre for shaft, toe point at z[j]
    const s = interp(pts, zc);
    qc[j] = s.qc; fs[j] = s.fs;
    FR[j] = s.qc > 0 ? 100 * s.fs / s.qc : 0;
  }
  const qcToe = new Array(n);
  for (let j = 0; j < n; j++) {
    if (toeWin > 0) {
      let sum = 0, m = 0;
      for (let zz = z[j] - toeWin; zz <= z[j] + toeWin + 1e-9; zz += dz / 2) { sum += interp(pts, zz).qc; m++; }
      qcToe[j] = sum / m;
    } else qcToe[j] = interp(pts, z[j]).qc;
  }
  if (toeWin > 0) notes.push(`Toe q_c averaged over ±${toeWin} m (arithmetic mean).`);

  const perim = P.shaftPerimeter_m + P.innerPerimeter_m;
  const toeArea = P.toeArea_m2 * P.plugRatio;
  const out = { ok: true, method, z, dz, qToe_kPa: new Array(n), tauShaft_kPa: new Array(n), frictionRatioPct: FR,
    cumulativeShaft_kN: new Array(n), interlock_kN: new Array(n), toe_kN: new Array(n), Rstatic_kN: new Array(n),
    pile: P, effectiveToeArea_m2: toeArea, contactPerimeter_m: perim, notes };

  if (method === 'reference') {
    for (let j = 0; j < n; j++) { out.qToe_kPa[j] = toeFactor * srdFactor * qcToe[j]; out.tauShaft_kPa[j] = shaftFactor * srdFactor * fs[j]; }
    if (toeFactor !== 1 || shaftFactor !== 1) notes.push(`Reference profile scaled: toe ×${toeFactor}, shaft ×${shaftFactor}.`);
    notes.push('Reference method q_s = q_c, τ_s = f_s (course §7.2): illustrative screen, not a pile design method.');
  } else if (method === 'alm-hamre') {
    const ah = options.almHamre || {};
    const layers = Array.isArray(ah.layers) && ah.layers.length ? ah.layers : null;
    if (!layers) return fail("method 'alm-hamre' needs options.almHamre.layers[] = [{ zTop_m, zBot_m, soilType: 'sand'|'clay', deltaCv_deg?, gamma_kN_m3? }].");
    const gammaDefault = finitePos(ah.gamma_kN_m3) ? ah.gamma_kN_m3 : 19;
    const wt = Number.isFinite(ah.waterTable_m) ? ah.waterTable_m : 0;
    const inside = ah.insideFriction === 'half-both' ? 0.5 : 1.0;
    const sigma = Array.isArray(ah.sigmaV0_kPa) && ah.sigmaV0_kPa.length === n ? ah.sigmaV0_kPa : effectiveStress(z, dz, layers, gammaDefault, wt);
    const fsi = new Array(n), fsres = new Array(n), k = new Array(n), type = new Array(n);
    let unknown = 0;
    for (let j = 0; j < n; j++) {
      const zc = z[j] - dz / 2;
      const L = layerAt(layers, zc);
      const p0 = Math.max(1, sigma[j]);
      const qT = qc[j];
      if (!L) { unknown++; }
      const t = L && L.soilType === 'clay' ? 'clay' : 'sand';
      type[j] = t;
      if (t === 'clay') {
        fsi[j] = fs[j];
        fsres[j] = 0.004 * qT * (1 - 0.0025 * qT / p0);
        out.qToe_kPa[j] = 0.6 * qcToe[j];
      } else {
        const delta = L && finitePos(L.deltaCv_deg) ? L.deltaCv_deg : 29;
        const Kp0 = 0.0132 * qT * Math.pow(p0 / PA_KPA, 0.13);
        fsi[j] = inside * Kp0 * Math.tan(delta * Math.PI / 180);
        fsres[j] = 0.2 * fsi[j];
        out.qToe_kPa[j] = 0.15 * qcToe[j] * Math.pow(Math.max(qcToe[j], 1e-9) / p0, 0.2);
      }
      fsres[j] = Math.max(0, Math.min(fsres[j], fsi[j]));
      k[j] = Math.sqrt(Math.max(qT, 0) / p0) / 80;
      fsi[j] *= srdFactor; fsres[j] *= srdFactor; out.qToe_kPa[j] *= srdFactor;
      out.tauShaft_kPa[j] = fsi[j];
    }
    if (unknown) notes.push(`${unknown} intervals outside options.almHamre.layers: treated as sand with δ = 29°.`);
    if (inside === 0.5) notes.push('Alm & Hamre sand friction halved and applied on both faces (inside friction included).');
    notes.push('Alm & Hamre (2001): q_c used as q_T (no pore-pressure correction); unplugged pile assumed; friction fatigue e^{-k(p-z)}.');
    out.almHamre = { fsi_kPa: fsi, fsres_kPa: fsres, k_1_m: k, soilType: type, sigmaV0_kPa: sigma };
  } else {
    return fail(`Unknown method '${method}'. Use 'reference' or 'alm-hamre'.`);
  }
  if (srdFactor !== 1) notes.push(`All unit resistances scaled by srdFactor = ${srdFactor}.`);

  // --- integrate at every trial toe depth -------------------------------------------------
  for (let j = 0; j < n; j++) {
    const tau = shaftStressAtTip(out, j);
    let R = 0;
    for (let i = 0; i <= j; i++) R += tau[i] * perim * dz;
    out.cumulativeShaft_kN[j] = R;
    out.interlock_kN[j] = P.interlockResistance_kN_m * z[j];
    out.toe_kN[j] = out.qToe_kPa[j] * toeArea;
    out.Rstatic_kN[j] = R + out.interlock_kN[j] + out.toe_kN[j];
  }
  if (P.interlockResistance_kN_m > 0) notes.push(`Interlock/clutch resistance ${P.interlockResistance_kN_m} kN per metre embedded added (course §6.5: not derivable from CPT).`);
  return out;
}

/**
 * Unit shaft resistance of every interval i ≤ j when the toe is at z[j].
 * Reference method: constant. Alm & Hamre: friction-fatigue degraded with distance to the tip.
 * @returns {number[]} τ (kPa) for intervals 0..j
 */
export function shaftStressAtTip(profile, j) {
  const tau = new Array(j + 1);
  if (profile.almHamre) {
    const { fsi_kPa, fsres_kPa, k_1_m } = profile.almHamre;
    const p = profile.z[j];
    for (let i = 0; i <= j; i++) {
      const dist = p - (profile.z[i] - profile.dz / 2);
      tau[i] = fsres_kPa[i] + (fsi_kPa[i] - fsres_kPa[i]) * Math.exp(-k_1_m[i] * Math.max(0, dist));
    }
  } else {
    for (let i = 0; i <= j; i++) tau[i] = profile.tauShaft_kPa[i];
  }
  return tau;
}

/** Index of the profile interval whose toe depth is nearest to zTarget (clamped). */
export function indexAtDepth(profile, zTarget) {
  if (!profile.z.length) return -1;
  let best = 0, bd = Infinity;
  for (let j = 0; j < profile.z.length; j++) { const d = Math.abs(profile.z[j] - zTarget); if (d < bd) { bd = d; best = j; } }
  return best;
}

// ---------------------------------------------------------------------------------------------
function finitePos(x) { return Number.isFinite(x) && x > 0; }

function normalizePile(pile, notes) {
  if (!pile || !finitePos(pile.toeArea_m2) || !finitePos(pile.shaftPerimeter_m)) return null;
  const P = {
    toeArea_m2: pile.toeArea_m2,
    shaftPerimeter_m: pile.shaftPerimeter_m,
    innerPerimeter_m: finitePos(pile.innerPerimeter_m) ? pile.innerPerimeter_m : 0,
    interlockResistance_kN_m: finitePos(pile.interlockResistance_kN_m) ? pile.interlockResistance_kN_m : 0,
    plugRatio: finitePos(pile.plugRatio) ? Math.min(pile.plugRatio, 1) : 1,
    steelArea_m2: finitePos(pile.steelArea_m2) ? pile.steelArea_m2 : null
  };
  if (pile.plugRatio > 1) notes.push('plugRatio > 1 clipped to 1 (fraction of the given toe area that is effective).');
  return P;
}

/** Linear interpolation on the sorted trace, clamped at both ends. */
function interp(pts, zq) {
  if (zq <= pts[0].z) return pts[0];
  const last = pts[pts.length - 1];
  if (zq >= last.z) return last;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].z <= zq) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi];
  const t = b.z > a.z ? (zq - a.z) / (b.z - a.z) : 0;
  return { z: zq, qc: a.qc + t * (b.qc - a.qc), fs: a.fs + t * (b.fs - a.fs) };
}

function layerAt(layers, zc) {
  for (const L of layers) if (zc >= (L.zTop_m ?? -Infinity) - 1e-9 && zc < (L.zBot_m ?? Infinity) + 1e-9) return L;
  return null;
}

/** Effective vertical stress at each interval centre from layer bulk unit weights and a water table. */
function effectiveStress(z, dz, layers, gammaDefault, wt) {
  const out = new Array(z.length);
  let s = 0, zPrev = 0;
  for (let j = 0; j < z.length; j++) {
    const zc = z[j] - dz / 2;
    // integrate from zPrev to zc
    const L = layerAt(layers, zc);
    const g = L && finitePos(L.gamma_kN_m3) ? L.gamma_kN_m3 : gammaDefault;
    const seg = zc - zPrev;
    const below = Math.max(0, Math.min(seg, zc - Math.max(zPrev, wt)));
    s += g * seg - GAMMA_W * below;
    out[j] = s; zPrev = zc;
  }
  return out;
}
