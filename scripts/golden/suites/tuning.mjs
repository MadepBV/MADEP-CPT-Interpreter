// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks Stage 5 (design §1.6): runTuning()/fitLayer per layer (m_fit, Eoed_ref_fit, R², the
// regression point sets, quality flags), the accept/reject effects on layer overrides and
// hsParams, the slider helpers (tuningSliderBounds, tuningPreviewEoedRef,
// tuningPreviewLineData, getTuningPreviewM) and the tuning-card text (#tuningArea).
import { htmlToText } from '../lib/html-text.mjs';

export const name = 'tuning';
export const tolerance = 'pure';
export const description = 'Stage 5 m-fit per layer, accept/reject, slider helpers';

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.cptNames()) {
    const S = await ctx.classify(fx, 'sb260');
    api.goS(3); api.goS(4);
    api.runTuning();
    yield { id: fx, value: S.tuning };
    yield { id: `${fx}.dom`, kind: 'txt', value: htmlToText(c.document.getElementById('tuningArea').innerHTML) };
    yield { id: `${fx}.helpers`, value: S.tuning.map((t) => ({ i: t.i, previewM: api.getTuningPreviewM(t), bounds: t.fit ? api.tuningSliderBounds(t.fit) : null, eoedRef: t.fit ? api.tuningPreviewEoedRef(t.fit, api.getTuningPreviewM(t)) : null, line: t.fit ? api.tuningPreviewLineData(t.fit, api.getTuningPreviewM(t)) : null })) };
    api.acceptFit(0);
    yield { id: `${fx}.accepted0`, value: { layers: S.layers.map((l) => ({ m_ovr: l.m_ovr ?? null, ovr: l.ovr })), hs: S.layers.map((l) => api.hsParams(l)) } };
    S.tuning.forEach((t) => api.acceptFit(t.i));
    yield { id: `${fx}.accepted-all`, value: { layers: S.layers.map((l) => ({ m_ovr: l.m_ovr ?? null, ovr: l.ovr })), hs: S.layers.map((l) => api.hsParams(l)) } };
    S.tuning.forEach((t) => api.rejectFit(t.i));
    yield { id: `${fx}.rejected-all`, value: { layers: S.layers.map((l) => ({ m_ovr: l.m_ovr ?? null, ovr: l.ovr })), hs: S.layers.map((l) => api.hsParams(l)) } };
    if (S.tuning[0]?.fit) {
      api.updateTuningPreviewM(0, String(+(api.getTuningPreviewM(S.tuning[0]) * 1.1).toFixed(3)));
      yield { id: `${fx}.preview-slider`, value: { previewM: S.tuning[0].previewM, hs0: api.hsParams(S.layers[0]) } };
    }
  }
}
