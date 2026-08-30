// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/probe/clipboard.js — the two-column TSV the "Copy graph data" button puts on the
// clipboard. Refactor step 9d (01-monolith-map.md §2.11 group "Geometry, picking, line probe";
// PLAN §2 row 18d). Moved verbatim from legacy-controller.js (integration-r 4974167):
//
//   stage6ClipboardNumber 5352-5359                        → clipboardNumber
//   stage6BishopLineProbeClipboardValueHeader 5361-5373    → lineProbeClipboardValueHeader
//   stage6BishopLineProbeClipboardText 5375-5385           → lineProbeClipboardText
//
// Pure text: no `S`, no DOM. The clipboard write itself (`stage6CopyTextToClipboard` and its
// `<textarea>` fallback) is a browser API and stays in the controller.

/**
 * A number as the clipboard writes it: full precision without trailing zeros, exponential
 * outside [1e-6, 1e6). Non-finite (and the probe's `null` gaps) become an empty cell.
 */
export function clipboardNumber(value){
  const n = Number(value);
  if(!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if(abs === 0) return '0';
  if(abs < 1e-6 || abs >= 1e6) return n.toExponential(10);
  return n.toFixed(10).replace(/\.?0+$/, '');
}

/** The value column's header: `<quantity>_<unit>` slugged, e.g. `head_m`, `gradient`, `value`. */
export function lineProbeClipboardValueHeader(lineProbe){
  const quantity = lineProbe?.quantity || lineProbe?.meta?.label || 'value';
  const unit = lineProbe?.meta?.unit || '';
  const slug = String(quantity)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'value';
  const unitSlug = String(unit)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return unitSlug ? `${slug}_${unitSlug}` : slug;
}

/** `distance_along_line_m\t<value header>` + one row per sample; `''` unless the probe is ready. */
export function lineProbeClipboardText(lineProbe){
  if(!lineProbe || lineProbe.status !== 'ready') return '';
  const valueHeader = lineProbeClipboardValueHeader(lineProbe);
  const rows = [
    `distance_along_line_m\t${valueHeader}`
  ];
  (lineProbe.samples || []).forEach((sample)=>{
    rows.push(`${clipboardNumber(sample?.s)}\t${clipboardNumber(sample?.value)}`);
  });
  return rows.join('\n');
}
