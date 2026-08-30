// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/report — what Stage 7 needs from Seep / Slope (refactor step 9g, PLAN §2 row 18g;
// 01-monolith-map.md §6.2 step 9 "9g `report/capture.js`").
//
//   capture.js  the workspace screenshot, rasterised to an offscreen canvas from a view model
//               built for the target workspace — no app / workspace switch, no re-render, no
//               write to `S.stage6` (§3.4 #10 and §6.3 item 7, removed here).
//
// Nothing in the package reads `S`, the DOM, the canvas element or the clock: the host hands in a
// canvas factory, the frame box, the section model, the theme and the canvas package's draw-time
// `env`. `report/deps.js` binds them through `bishopWorkspaceCapture(cpt, host)`.
export {
  CAPTURE_IMAGE_DEFAULTS,
  CAPTURE_WORKSPACES,
  autoCaptureDisplay,
  bishopCanvasProbeHtml,
  bishopWorkspaceCapture,
  captureBishopWorkspaceView,
  captureViewport,
  captureWorkspace,
  captureWorkspaceImage,
  isCaptureWorkspace,
  manualCaptureDisplay,
  rasteriseCanvas,
  renderWorkspaceFrame,
  workspaceHasContent
} from './capture.js';

export * as capture from './capture.js';
