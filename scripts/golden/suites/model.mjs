// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks Stage 4 (design §1.5): hsParams(l) and khParams(l) per layer over the full method
// grid alphaMethod × stiffMethod × khKvMethod ∈ {A,B}³ × paramMethod ∈ {sb260, def}, set
// through the real setters (setParamMethod re-detects layers, :3050-3061), plus the layers
// after each paramMethod and the model-card text (#ma) for the default combination.
import { htmlToText } from '../lib/html-text.mjs';

export const name = 'model';
export const tolerance = 'pure';
export const description = 'Stage 4 hsParams/khParams over the {A,B}³ × paramMethod grid';

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.cptNames()) {
    const S = await ctx.classify(fx, 'sb260');
    api.goS(3);
    for (const p of ['sb260', 'def']) {
      api.setParamMethod(p);
      yield { id: `${fx}.layers.${p}`, value: S.layers };
      for (const a of ['A', 'B']) for (const s of ['A', 'B']) for (const k of ['A', 'B']) {
        api.setAlphaMethod(a); api.setStiffMethod(s); api.setKhKvMethod(k);
        yield { id: `${fx}.${a}${s}${k}.${p}`, value: S.layers.map((l) => ({ hs: api.hsParams(l), kh: api.khParams(l) })) };
        if (p === 'sb260' && a === 'B' && s === 'B' && k === 'A') yield { id: `${fx}.BBA.sb260.dom-ma`, kind: 'txt', value: htmlToText(c.document.getElementById('ma').innerHTML) };
      }
    }
    api.setParamMethod('sb260'); api.setAlphaMethod('B'); api.setStiffMethod('B'); api.setKhKvMethod('A');
    yield { id: `${fx}.state`, value: { alphaMethod: S.alphaMethod, stiffMethod: S.stiffMethod, khKvMethod: S.khKvMethod, paramMethod: S.paramMethod } };
  }
}
