// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Import review — public entry point.
//
// A CPT file import is a two-step handshake: parse the file into a staged
// result, present it for review (columns, statistics, data-quality notes),
// and only apply it to the project after explicit confirmation. The parsing
// core (tabular.js) is pure and shared; the dialog (modal.js) owns the DOM.

export { presentImportReview } from './modal.js';
export {
  buildRowsFromGrid,
  columnSamples,
  detectColumns,
  findDataHeaderRow,
  normalizeHeaderLabel,
  parseCptNumber,
  cptValueToMPa,
  summarizeRows
} from './tabular.js';
