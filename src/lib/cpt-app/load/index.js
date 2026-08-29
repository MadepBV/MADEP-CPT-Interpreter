// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stage 1 "Load" package — refactor step 5 (PR 9, worklog/refactor/10-pr9-load.md).
// Pure parsers (GEF / CSV / Excel → parsed-CPT result), the apply patch, the
// serial multi-file loader with an explicit target CPT, the demo generator and
// the Stage 1 DOM syncs as functions of (document, cpt). The controller keeps
// its old names as thin wrappers over the active CPT.

export { stripCptFileExtension, isExcelCptFile, isCsvCptFile } from './file-kind.js';
export { parseGEF, GEF_CHANNELS } from './parsers/gef.js';
export { parseCsvCpt, splitDelimitedLine, parseDelimitedText, detectDelimitedTextSeparator } from './parsers/csv.js';
export { parseExcelCpt, loadXlsxModule } from './parsers/excel.js';
export {
  pad2,
  formatExcelHeaderValue,
  normalizeExcelLabel,
  excelHeaderLookup,
  excelHeaderText,
  excelHeaderNumber,
  findExcelSheetName
} from './parsers/excel-headers.js';
export { applyParsedCpt, reviewStaging, NO_DATA_ROWS_MESSAGE } from './apply-parsed-cpt.js';
export { importCptFiles } from './import-files.js';
export { demoRows, demoPatch } from './demo.js';
export {
  syncWaterTableControls,
  syncElevationControl,
  syncCoordinateControls,
  renderElevationSource,
  renderWaterTableDisplay,
  renderAssumedRfControls,
  renderMetaCard,
  showStage1Body,
  syncParsedCptDom,
  syncDemoDom
} from './controls.js';
