// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks Stage 3 (design §1.4, §4.4) — the single most important golden: detectLayers()
// output for smartMerge on/off × 5 classification methods, minThk ∈ {0.3, 1.0},
// smartMergeSensitivity ∈ {0.9, 1.3}, the manual edit path (changeSubtype + editL
// override flags), the layer table text (#lb) and the compatibility warnings.
import { htmlToText } from '../lib/html-text.mjs';
import { METHODS } from './classification.mjs';

export const name = 'layers';
export const tolerance = 'pure';
export const description = 'Stage 3 detectLayers() grid + manual edit path per fixture';

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.cptNames()) {
    const S = await ctx.loadCpt(fx);
    for (const method of METHODS) {
      S.method = method; S.smartMerge = true; S.minThk = 0.5; S.smartMergeSensitivity = 1.1;
      api.runClass();
      yield { id: `${fx}.${method}.smart`, value: S.layers };
      S.smartMerge = false; api.detectLayers();
      yield { id: `${fx}.${method}.simple`, value: S.layers };
    }
    S.method = 'sb260'; S.smartMerge = true; api.runClass();
    for (const minThk of [0.3, 1.0]) { S.minThk = minThk; api.detectLayers(); yield { id: `${fx}.minThk${minThk}`, value: S.layers }; }
    for (const sens of [0.9, 1.3]) { S.minThk = 0.5; S.smartMergeSensitivity = sens; api.detectLayers(); yield { id: `${fx}.sens${sens}`, value: S.layers }; }
    // manual edit path (Stage 3): subtype change + parameter override flags
    S.minThk = 0.5; S.smartMergeSensitivity = 1.1; api.detectLayers(); api.renderLayers();
    yield { id: `${fx}.dom-lb`, kind: 'txt', value: htmlToText(c.document.getElementById('lb').innerHTML) };
    yield { id: `${fx}.warnings`, kind: 'txt', value: htmlToText(c.document.getElementById('layerWarnings').innerHTML) };
    if (S.layers.length > 1) {
      api.changeSubtype({ dataset: { i: '1' }, value: 'klei, vast' });
      api.editL({ dataset: { i: '0', f: 'phi' }, value: '35', classList: { add() {} } });
      yield { id: `${fx}.edited`, value: S.layers };
      yield { id: `${fx}.edited.dom-lb`, kind: 'txt', value: htmlToText(c.document.getElementById('lb').innerHTML) };
      yield { id: `${fx}.edited.warnings`, kind: 'txt', value: htmlToText(c.document.getElementById('layerWarnings').innerHTML) };
    }
  }
}
