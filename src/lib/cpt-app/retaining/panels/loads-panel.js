// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Water, surcharges and the retained berm/slope.
import { numberRow, selectRow, checkRow, help, accordion } from './panel-kit.js';
import { isEmbedded } from '../wall-types.js';

export function loadsPanel(rw) {
  const wm = rw.water.mode;
  const embedded = isEmbedded(rw.wallType);
  const berm = rw.loads?.berm || {};
  let body = `${selectRow('Water table', 'water.mode', wm, [{ value: 'none', label: 'None (dry)' }, { value: 'retained', label: 'Behind the wall only' }, { value: 'both', label: 'Both sides' }])}
    ${wm !== 'none' ? numberRow('Water depth (retained side)', 'water.retainedDepth', rw.water.retainedDepth, { unit: 'm', title: 'Depth below the retained surface' }) : ''}
    ${wm === 'retained' ? help('"Behind the wall only" treats the excavation side as dry (cut-off or dewatered pit). Pore pressures are hydrostatic on each face — no seepage (EN 1997-1 §9.3.1.6); a differential head triggers the HYD check and a note.') : ''}
    ${wm === 'both' ? numberRow('Water depth (excavation side)', 'water.frontDepth', rw.water.frontDepth, { unit: 'm', title: 'Depth below the nominal excavation level' }) : ''}
    <div class="st6-rw-card-title" style="margin-top:10px">Surcharges on the retained surface</div>
    ${numberRow('Variable surcharge q<sub>k</sub>', 'surcharge', rw.surcharge, { unit: 'kPa', step: 1, title: 'Variable action: γ_Q (1.10 in DA1/2 RK2, 1.50 in DA1/1) and α_ver = 1.1 in the BGT branch' })}`;
  if (embedded) {
    body += `${numberRow('Permanent surcharge g<sub>k</sub>', 'loads.surchargePermanent', rw.loads?.surchargePermanent, { unit: 'kPa', step: 1, title: 'Permanent action, enters σ′_v on the retained side (γ_G)' })}
    <div class="st6-rw-card-title" style="margin-top:10px">Retained berm / slope</div>
    ${checkRow('Slope rising behind the wall head', 'loads.berm.enabled', !!berm.enabled)}
    ${berm.enabled ? numberRow('Berm height Δh', 'loads.berm.height', berm.height, { unit: 'm', step: 0.1 }) + numberRow('Slope angle β', 'loads.berm.slopeDeg', berm.slopeDeg, { unit: '°', step: 5, min: 5, max: 90 }) + help('Treated as an equivalent permanent surcharge averaged under a 45° spread (Rekennota §7.3) — an approximation, not the EN 1997-1 Annex C sloping-ground coefficient. The berm fill takes the unit weight of the top layer.') : ''}`;
  }
  return accordion('loads', 'Water & loads', body, { open: false, pill: wm === 'none' ? 'dry' : 'water' });
}
