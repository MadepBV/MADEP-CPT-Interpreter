// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Geometry inputs per wall family.
import { numberRow, checkRow, help, accordion } from './panel-kit.js';
import { isEmbedded, isSoldierPile } from '../wall-types.js';

export function geometryPanel(rw) {
  let rows;
  if (!isEmbedded(rw.wallType)) {
    const key = rw.wallType === 'gravity' ? 'gravity' : 'cantilever';
    const g = rw[key];
    rows = [
      numberRow('Stem height', `${key}.stemHeight`, g.stemHeight, { unit: 'm' }),
      numberRow('Stem thk (top)', `${key}.stemThkTop`, g.stemThkTop, { unit: 'm' }),
      numberRow('Stem thk (base)', `${key}.stemThkBot`, g.stemThkBot, { unit: 'm' }),
      numberRow('Base thickness', `${key}.baseThk`, g.baseThk, { unit: 'm' }),
      numberRow('Toe length', `${key}.toe`, g.toe, { unit: 'm' }),
      numberRow('Heel length', `${key}.heel`, g.heel, { unit: 'm' }),
      numberRow('Backfill slope β', `${key}.betaDeg`, g.betaDeg, { unit: '°', step: 1 }),
      numberRow('Front soil depth', `${key}.frontSoilDepth`, g.frontSoilDepth, { unit: 'm' }),
      key === 'gravity' ? numberRow('Back batter', 'gravity.backBatterDeg', g.backBatterDeg, { unit: '°', step: 1 }) : numberRow('Shear key depth', 'cantilever.keyDepth', g.keyDepth, { unit: 'm' })
    ];
  } else {
    const e = rw.embedded;
    rows = [
      numberRow('Retained height H', 'embedded.retainedHeight', e.retainedHeight, { unit: 'm', title: 'Nominal retained height: retained surface to the planned excavation level' }),
      numberRow('Embedment d (provided)', 'embedded.embedment', e.embedment, { unit: 'm', title: 'Pile length below the ULS design excavation (nominal level minus over-excavation)' })
    ];
    if (isSoldierPile(rw.wallType)) {
      rows.push(numberRow('Pile spacing s', 'soldier.spacing', rw.soldier.spacing, { unit: 'm', step: 0.05 }));
      rows.push(numberRow('Pile head above ground', 'soldier.pileHeadAbove', rw.soldier.pileHeadAbove, { unit: 'm', step: 0.05, title: 'Only enters the self-weight of the pile' }));
      rows.push(checkRow('Anchored / propped (one level)', 'embedded.anchored', !!e.anchored));
    }
    rows.push(help('The embedment is measured below the <strong>design</strong> excavation (nominal level minus the over-excavation set in the Eurocode panel). The drawing shows both levels.'));
  }
  return accordion('geom', 'Geometry', `<div class="st6-rw-fields">${rows.join('')}</div>`, { open: true });
}
