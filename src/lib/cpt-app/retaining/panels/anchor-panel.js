// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Ground-anchor configuration (EN 1537 / EC7 Table A.12) for anchored walls.
import { numberRow, help, accordion } from './panel-kit.js';
import { isAnchoredType, isSoldierPile } from '../wall-types.js';

export function anchorPanel(rw) {
  if (!isAnchoredType(rw)) return '';
  const e = rw.embedded;
  const body = `
    ${numberRow('Anchor depth (below top)', 'embedded.anchorDepth', e.anchorDepth, { unit: 'm' })}
    ${numberRow('Inclination', 'embedded.anchorAngle', e.anchorAngle, { unit: '°', step: 1 })}
    ${numberRow('Free (tendon) length', 'embedded.freeLen', e.freeLen, { unit: 'm', step: 0.5 })}
    ${numberRow('Fixed (grout) length', 'embedded.fixedLen', e.fixedLen, { unit: 'm', step: 0.5 })}
    ${numberRow('Grout body Ø', 'embedded.anchorDia', e.anchorDia, { unit: 'm', step: 0.01 })}
    ${numberRow('Horizontal spacing', 'embedded.anchorSpacing', e.anchorSpacing, { unit: 'm', step: 0.25, title: isSoldierPile(rw.wallType) ? 'Anchor spacing along the wall (a multiple of the pile spacing when anchors sit on the walers)' : '' })}
    ${numberRow('Grout/soil bond τ', 'embedded.anchorTfk', e.anchorTfk, { unit: 'kPa', step: 10 })}
    ${numberRow('Anchor resistance γ<sub>a</sub>', 'embedded.anchorGammaA', e.anchorGammaA, { step: 0.05 })}
    ${help('Pull-out R<sub>a,k</sub> = π·Ø·L<sub>fixed</sub>·τ (EN 1537 — a preliminary bond estimate to be proven by acceptance testing). T<sub>d</sub> per anchor = T<sub>Ed</sub>·s/cos(angle) ≤ R<sub>a,d</sub> = R<sub>a,k</sub>/γ<sub>a</sub>; γ<sub>a</sub> = 1.1 is the EN 1997-1 Table A.12 anchorage factor. The inclined anchor adds V = T·tan(angle) downward on the wall. Drag the anchor tip in the drawing to set the inclination.')}`;
  return accordion('anchor', 'Ground anchor (EN 1537)', body, { open: false });
}
