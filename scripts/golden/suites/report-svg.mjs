// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier A lock of the report SVG builders (design §2.1 `report-svg`): the pure
// buildLayerColumnSvgMarkup / buildLayerPreviewSvgMarkup of src/lib/cpt-app/report/svg.js
// (moved out of legacy-controller.js in PR 8) on the layers and rows of every profile
// fixture (classified through the controller so the inputs are the real Stage 2/3 output),
// in the three secondary-metric modes, plus the empty-input placeholders. The classification
// suite locks the same markup as rendered into #layerPreviewSvg / #layerColSvg; this suite
// is the function surface the extraction of the Stage 7 report keeps calling.
import { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from '../../../src/lib/cpt-app/report/svg.js';

export const name = 'report-svg';
export const tolerance = 'pure';
export const description = 'report/svg.js: buildLayerColumnSvgMarkup + buildLayerPreviewSvgMarkup per profile fixture';

export async function* cases(ctx) {
  yield { id: 'empty.column', kind: 'svg', value: buildLayerColumnSvgMarkup({}) };
  yield { id: 'empty.column-label', kind: 'svg', value: buildLayerColumnSvgMarkup({ layers: [], emptyLabel: 'Geen lagen' }) };
  yield { id: 'empty.preview', kind: 'svg', value: buildLayerPreviewSvgMarkup({}) };
  for (const fx of ctx.fixtures.cptNames()) {
    const S = await ctx.classify(fx, 'sb260');
    const maxDepth = S.layers.at(-1)?.bot ?? 20;
    yield { id: `${fx}.column`, kind: 'svg', value: buildLayerColumnSvgMarkup({ layers: S.layers, maxDepth, wt: S.wt }) };
    yield { id: `${fx}.column-no-wt`, kind: 'svg', value: buildLayerColumnSvgMarkup({ layers: S.layers, maxDepth, wt: null, width: 80, height: 300 }) };
    yield { id: `${fx}.preview-rf`, kind: 'svg', value: buildLayerPreviewSvgMarkup({ layers: S.layers, rows: S.data, wt: S.wt, showRf: true, showFs: false }) };
    yield { id: `${fx}.preview-fs`, kind: 'svg', value: buildLayerPreviewSvgMarkup({ layers: S.layers, rows: S.data, wt: S.wt, showRf: false, showFs: true }) };
    yield { id: `${fx}.preview-qc`, kind: 'svg', value: buildLayerPreviewSvgMarkup({ layers: S.layers, rows: S.data, wt: S.wt, showRf: false, showFs: false, width: 320, height: 600 }) };
  }
}
