// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Eurocode 7 settings: partial-factor scheme, over-excavation rule, branches, wall friction, floors.
import { numberRow, selectRow, checkRow, help, accordion, fmt, note } from './panel-kit.js';
import { isEmbedded, isSoldierPile } from '../wall-types.js';

const SCHEMES = [
  { value: 2, label: 'Belgian guideline 2022 — RK2 (γ_Q 1.10, M2 1.25/1.25/1.40)' },
  { value: 1, label: 'Belgian guideline 2022 — RK1 (γ_Q 1.10, M2 1.10/1.10/1.25)' },
  { value: 3, label: 'Belgian guideline 2022 — RK3 (γ_Q 1.20, M2 1.40/1.40/1.55)' },
  { value: 0, label: 'NBN EN 1997-1 ANB generic DA1 (γ_Q 1.30 / 1.50, K_FI)' }
];

export function ec7Panel(rw) {
  const s = rw.settings;
  const embedded = isEmbedded(rw.wallType);
  const soldier = isSoldierPile(rw.wallType);
  if (!embedded) return gravityEc7Panel(rw);
  const mo = s.materialOverride || {};
  const deltaPath = soldier ? 'settings.deltaPassiveSoldier' : 'settings.deltaPassiveSheet';
  const delta = soldier ? Number(s.deltaPassiveSoldier) || 0 : Number(s.deltaPassiveSheet) || 0;
  const cap = soldier ? 0.5 : 0.667;
  const deltaWarn = delta > cap + 1e-9 ? note(`δ<sub>p</sub>/φ′ = ${fmt(delta, 2)} exceeds the Belgian guideline cap for this wall type (${soldier ? 'Berliner wall: φ′/3 straight, φ′/2 curved' : 'steel sheet pile: ⅔φ′ straight, φ′ − 2.5° curved'}). Justify explicitly.`, true) : '';
  const body = `
    ${selectRow('Partial-factor scheme', 'settings.riskScheme', s.riskScheme, SCHEMES)}
    ${Number(s.riskScheme) === 0 ? selectRow('Consequence class (K<sub>FI</sub>)', 'settings.consequenceClass', s.consequenceClass, [{ value: 1, label: 'CC1 (0.90)' }, { value: 2, label: 'CC2 (1.00)' }, { value: 3, label: 'CC3 (1.10)' }]) : help('The risk class already differentiates reliability — K<sub>FI</sub> is not applied on top (it would double-count).')}
    ${help('Branches run: <strong>DA1/2</strong> (A2 + M2, design excavation) governs the embedment; <strong>DA1/1</strong> (A1 + M1); <strong>BGT + α<sub>ver</sub></strong> at the nominal excavation, effects × 1.35 for STR (guideline §3.5); <strong>SLS</strong>. Section and support forces are the envelope of the first three.')}
    <div class="card__eyebrow">Design excavation</div>
    ${selectRow('Over-excavation Δa', 'settings.overdigRule', s.overdigRule, [{ value: 'belgian', label: 'Belgian guideline: +0.30 m dry / min(0.1h, 0.5 m) under water' }, { value: 'en', label: 'EN 1997-1 §9.3.2.2: 10 % of h, ≤ 0.5 m' }, { value: 'custom', label: 'Custom value' }, { value: 'none', label: 'None (justified control measures)' }])}
    ${s.overdigRule === 'custom' ? numberRow('Δa', 'settings.overdigCustom', s.overdigCustom, { unit: 'm', step: 0.05, min: 0 }) : ''}
    ${help('Applied to the ULS branches only; BGT and SLS use the nominal excavation (guideline §3.3). h = retained height (cantilever) or height below the lowest support (anchored).')}
    <div class="card__eyebrow">Branch details</div>
    ${numberRow('α<sub>ver</sub> on variable actions (BGT)', 'settings.alphaVer', s.alphaVer, { step: 0.05, min: 1, max: 1.5 })}
    ${selectRow('DA1/1 passive treatment', 'settings.da11Mode', s.da11Mode, [{ value: 'separate', label: 'γ_G 1.35 on retained side, 1.00 on passive (conservative, Rekennota)' }, { value: 'single-source', label: 'single source: 1.35 on both sides (EN 1997-1 2.4.2(9)P)' }])}
    ${numberRow('Minimum variable surcharge', 'settings.surchargeFloor', s.surchargeFloor, { unit: 'kPa', step: 1, min: 0, title: 'Practice floor (e.g. 10 kPa site load) — not a Belgian requirement; the larger of q_k and this value is used' })}
    <div class="card__eyebrow">Earth-pressure assumptions</div>
    ${numberRow('δ<sub>p</sub>/φ′ passive face', deltaPath, delta, { step: 0.05, min: 0, max: 1, title: 'Annex C wall friction on the excavation side, applied to φ′_d per layer. 0 = Rankine (course baseline).' })}
    ${deltaWarn}
    ${help(soldier ? 'Active side: Rankine (δ = 0). Passive side: EN 1997-1 Annex C with the ratio above per layer (0 = Rankine as in the Rekennota). Belgian cap for Berliner walls: φ′/3 (straight), φ′/2 (curved).' : 'Active side: Rankine on the vertical wall (δ = 0). Passive side: EN 1997-1 Annex C (log-spiral) with δ<sub>p</sub> = ratio × φ′<sub>d</sub> per layer. Belgian cap for untreated steel sheet piles: ⅔φ′<sub>k</sub> (straight surface), φ′<sub>k</sub> − 2.5° and ≤ 30° (curved).')}
    ${checkRow('Water-filled tension crack (EN 1997-1 9.6(5)P)', 'settings.assumeCrackWater', !!s.assumeCrackWater)}
    <div class="card__eyebrow">Strength sensitivity (e.g. SB260 γ<sub>φ</sub> = 1.30)</div>
    ${checkRow('Add a sensitivity strength set', 'settings.materialOverride.enabled', !!mo.enabled)}
    ${mo.enabled ? `<div class="cols-2 cols-2--fields">${numberRow('γ<sub>φ</sub>', 'settings.materialOverride.gPhi', mo.gPhi, { step: 0.05, min: 1 })}${numberRow('γ<sub>c</sub>', 'settings.materialOverride.gC', mo.gC, { step: 0.05, min: 1 })}${numberRow('γ<sub>cu</sub>', 'settings.materialOverride.gCu', mo.gCu, { step: 0.05, min: 1 })}</div>
      ${checkRow('Use it as the DA1/2 material set (replaces M2)', 'settings.materialOverride.applyToDA12', !!mo.applyToDA12)}
      ${help('When not applied to DA1/2 it only adds a sensitivity column to the PLAXIS T<sub>lat</sub> tables (soldier piles). SB260 requires SF ≥ 1.30 drained for permanent works — stricter than RK2.')}` : ''}`;
  return accordion('ec7', 'Eurocode 7 — Belgian workflow', body, { open: false, pill: SCHEMES.find((x) => x.value === Number(s.riskScheme))?.label.split('—')[1]?.trim().split(' ')[0] || 'ANB' });
}

function gravityEc7Panel(rw) {
  const s = rw.settings;
  const body = `
    ${help('The earth-pressure method follows from the geometry — Rankine on the vertical virtual plane (RC cantilever) or Coulomb on the real back face (mass gravity); passive resistance always uses the EN 1997-1 Annex C closed form.')}
    ${numberRow('δ/φ′ active (Coulomb back face)', 'settings.deltaActiveRatio', s.deltaActiveRatio, { step: 0.05 })}
    ${numberRow('δ<sub>b</sub>/φ′ base sliding', 'settings.deltaBaseRatio', s.deltaBaseRatio, { step: 0.05 })}
    ${help('EN 1997-1 6.5.3(10): δ<sub>b</sub> = φ′<sub>cv</sub> (cast in situ) or ⅔φ′<sub>cv</sub> (precast) — for dense soils enter ≈ tan φ′<sub>cv</sub>/tan φ′ to avoid overstating the sliding resistance.')}
    ${numberRow('δ<sub>p</sub>/φ′ passive face', 'settings.passiveDeltaRatio', s.passiveDeltaRatio, { step: 0.05 })}
    ${checkRow('Include passive resistance at the toe', 'settings.passiveToe', s.passiveToe !== false)}
    ${s.passiveToe !== false ? help('Annex C coefficient at M-factored strength, R1 = 1.0 — no lumped mobilisation factor. The unplanned over-dig Δa = min(0.10·H, 0.5 m) removes the top band automatically. Full passive needs large movement; verify SLS separately or switch it off.') : ''}
    ${selectRow('Bearing method', 'settings.bearingMethod', s.bearingMethod, [{ value: 'annexd', label: 'EN 1997-1 Annex D (c−φ)' }, { value: 'debeer', label: 'De Beer CPT-direct' }])}
    ${s.bearingMethod !== 'debeer' ? checkRow('Bearing depth factors (Brinch-Hansen)', 'settings.bearingDepthFactors', s.bearingDepthFactors !== false) : help('De Beer / EN 1997-2 direct method from q<sub>c</sub> near founding (needs a CPT profile).')}
    ${selectRow('Consequence class', 'settings.consequenceClass', s.consequenceClass, [{ value: 1, label: 'CC1 (K_FI 0.90)' }, { value: 2, label: 'CC2 (K_FI 1.00)' }, { value: 3, label: 'CC3 (K_FI 1.10)' }])}
    ${checkRow('Water-filled tension crack', 'settings.assumeCrackWater', !!s.assumeCrackWater)}
    ${help('DA1 — both combinations C1 (A1+M1) and C2 (A2+M2, γ<sub>Q</sub> = 1.30 NBN EN 1997-1 ANB) are evaluated; the worst governs each check.')}`;
  return accordion('ec7', 'Eurocode 7 settings', body, { open: false });
}
