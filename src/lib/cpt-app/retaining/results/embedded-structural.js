// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Derived structural data of an embedded wall from the engine result + the selected section:
 * steel checks (EN 1993-1-1 / EN 1993-5), lagging plate, vertical equilibrium, PLAXIS sets.
 * One place, so the summary card, the Structural and PLAXIS tabs and the calculation note agree.
 */
import { isSoldierPile } from '../wall-types.js';
import { hSectionSI, sheetPileSI, yieldStrength } from '../sections/section-properties.js';
import { checkHPile, checkSheetPile, checkLaggingPlate, checkVerticalEquilibrium, hPileResistance, sheetPileResistance } from '../sections/steel-checks.js';
import { plateFromSheetPile, plateFromSoldierPile, ebrFromSoldierPile, tskinLinear, fmaxFromCpt, interfaceFactors, tlatRowsForPlaxis } from '../plaxis/plaxis-parameters.js';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export function computeEmbeddedStructural(rw, result, profile) {
  if (!result || !result.branches) return null;
  const soldier = isSoldierPile(rw.wallType);
  const st = result.structural || {};
  const da12 = result.branches.find((b) => b.id === 'DA1-2') || result.branches[0];
  const layersFront = da12?.front || [];
  const layersBack = da12?.back || [];
  const out = { soldier, perPile: !!result.perPile, section: null, steel: null, lagging: null, vertical: null, plaxis: {}, notes: [] };
  const strata = profile?.strata || [];
  const topStratum = strata[0] || { gammaMoist: 19, phi: 30 };
  const H = num(rw.embedded.retainedHeight, 5), d = num(rw.embedded.embedment, 4), overdig = num(result.overdigUls, 0);

  if (soldier) {
    const so = rw.soldier;
    const sec = hSectionSI(so.sectionId);
    out.section = sec;
    if (sec) {
      const fy = yieldStrength(so.grade) || 235;
      out.fy = fy;
      out.steel = checkHPile(sec, { MEd: st.Mmax, VEd: st.Vmax, fy });
      out.steel.resistance = hPileResistance(sec, { fy });
      const lagFy = yieldStrength(so.laggingGrade) || 235;
      // characteristic lagging pressure for the deflection: BGT branch total / effect factor
      const bgt = result.branches.find((b) => b.id === 'BGT');
      const pK = bgt?.lagging ? bgt.lagging.total / (bgt.factors?.effectFactor || 1.35) : null;
      out.lagging = checkLaggingPlate({ pEd: st.laggingPressure, pK, spacing: num(so.spacing, 1), flangeWidth: sec.b, thickness: num(so.laggingThk, 0.01), fy: lagFy, spanMode: so.laggingSpan === 'clear' ? 'clear' : 'centre', method: 'elastic' });
      out.lagging.combo = st.laggingCombo;
      // toe stratum for T_skin / F_max (front side, at the toe)
      const toeEl = da12 ? da12.toeEl : -overdig - d;
      const toeStratum = strata.find((s, i) => toeEl <= s.topEl && (i === strata.length - 1 || toeEl > (strata[i + 1]?.topEl ?? -1e9))) || strata[strata.length - 1] || topStratum;
      const gammaToe = num(toeStratum.gammaMoist, 19);
      const embedmentTotal = d;   // EBR length = design excavation to toe
      out.plaxis.plate = plateFromSoldierPile(sec, { spacing: num(so.spacing, 1), laggingThickness: num(so.laggingThk, 0.01) });
      out.plaxis.ebr = ebrFromSoldierPile(sec, { spacing: num(so.spacing, 1), gammaSoil: gammaToe });
      out.plaxis.tskin = tskinLinear(sec, { phiK: num(toeStratum.phi, 30), K: so.tskinK === 'k0' ? 'k0' : Number(so.tskinK), deltaRatio: num(so.tskinDeltaRatio, 0.667), includePlug: so.tskinPlug !== false, gamma: gammaToe, embedment: embedmentTotal });
      const qcToe = num(toeStratum.qc, 0);
      out.plaxis.fmax = qcToe > 0 ? fmaxFromCpt(sec, { qcToe_kPa: qcToe, alphaB: num(so.fmaxAlphaB, 0.5), plugged: so.fmaxPlugged !== false }) : null;
      if (!out.plaxis.fmax) out.notes.push('F_max needs a cone resistance at the toe (CPT profile); none available for the toe stratum.');
      out.plaxis.tlat = (result.tlat || []).map((t) => ({ ...t, plaxisRows: tlatRowsForPlaxis(t, { convention: so.tlatConvention === 'equal' ? 'equal' : 'AL', useRowCap: so.rowCap !== false }) }));
      out.plaxis.interfaces = interfaceFactors(layersBack, num(rw.settings.deltaPassiveSoldier, 0));
      const extraV = result.structural?.anchorVertical ? result.structural.anchorVertical * num(so.spacing, 1) : 0;
      out.vertical = checkVerticalEquilibrium({ section: sec, length: H + overdig + d + num(so.pileHeadAbove, 0), laggingThickness: num(so.laggingThk, 0.01), laggingHeight: H + overdig, spacing: num(so.spacing, 1), tskinSlope: out.plaxis.tskin.slope, embedment: embedmentTotal, extraVertical: extraV });
    }
  } else {
    const sh = rw.sheet;
    const sp = sheetPileSI(sh.sectionId, { corrosionLoss: num(sh.corrosionLoss, 0) });
    out.section = sp;
    if (sp) {
      const fy = yieldStrength(sh.grade) || 355;
      out.fy = fy;
      const cls = sp.classByGrade ? sp.classByGrade[sh.grade] : null;
      out.steel = checkSheetPile(sp, { MEd: st.Mmax, VEd: st.Vmax, fy, useWpl: !!sh.useWpl, betaB: num(sh.betaB, 1), sectionClass: cls });
      out.steel.resistance = sheetPileResistance(sp, { fy, useWpl: !!sh.useWpl, betaB: num(sh.betaB, 1), sectionClass: cls });
      out.plaxis.plate = plateFromSheetPile(sp, { fy });
      out.plaxis.interfaces = interfaceFactors(layersBack, num(rw.settings.deltaPassiveSheet, 0.667));
    }
  }
  out.layersBack = layersBack; out.layersFront = layersFront;
  return out;
}
