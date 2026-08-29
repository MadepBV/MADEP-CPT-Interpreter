// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared case factory for the five Stage 6 application suites (design §1.8, §4.4): for
// every profile fixture the app is rendered through setStage6App()/renderStage6() so the
// controller's own glue (ensureStage6State clamping, stage6WorkingLayers, the cache
// written at :16787-16808) is what gets locked, with three configs: the defaults, a
// "heavy" set and an "edge" set (values outside the CPT, zero loads, tiny footings).
import { htmlToText } from '../lib/html-text.mjs';
import { digest } from '../lib/normalize.mjs';

export function stage6Cases(app, { heavy, edge, extra, slim = (v) => v }) {
  return async function* cases(ctx) {
    const c = await ctx.controller();
    const { api } = c;
    for (const fx of ctx.fixtures.stage6Names()) {
      const S = await ctx.classify(fx, 'sb260');
      api.goS(3); api.goS(5);
      c.alerts.length = 0;
      api.setStage6App(app);
      yield { id: `${fx}.default`, value: S.stage6Cache[app] ?? null };
      yield { id: `${fx}.default.config`, value: S.stage6[app] };
      yield { id: `${fx}.default.dom`, kind: 'txt', value: htmlToText(c.document.getElementById('stage6Area').innerHTML) };
      for (const [label, cfg] of [['heavy', heavy], ['edge', edge]]) {
        Object.assign(S.stage6[app], typeof cfg === 'function' ? cfg(S) : cfg);
        api.renderStage6();
        yield { id: `${fx}.${label}`, value: slim(S.stage6Cache[app] ?? null) };
        yield { id: `${fx}.${label}.config`, value: S.stage6[app] };
      }
      yield { id: `${fx}.alerts`, value: c.alerts.slice() };
      if (extra) yield* extra({ ctx, api, S, fx, c });
    }
  };
}

export { digest };

/** Working layers exactly as every Stage 6 app consumes them (stage6WorkingLayers, :4162) via the Stage 7 payload clone. */
export function workingLayers(api) {
  return api.buildStage7Payload()?.stage6?.layers ?? [];
}
