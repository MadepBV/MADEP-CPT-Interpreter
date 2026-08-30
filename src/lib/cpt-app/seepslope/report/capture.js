// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/report/capture.js — the Stage 7 workspace screenshot, rasterised **offscreen**
// (refactor step 9g, PLAN §2 row 18g; 01-monolith-map.md §2.14 `stage7CaptureCanvasImage`
// 17916-17951 / `stage7CaptureWorkspaceView` 17952-17988 / `stage7CaptureBishopWorkspaceView`
// 17999-18084, §3.4 #10 and §6.3 item 7 — "Stage 7 capture that mutates app/workspace state").
//
// What the monolith did, and what this replaces
// ---------------------------------------------
// `stage7CaptureBishopWorkspaceView(workspace)` was the report's only way to get a picture of an
// analysis it had no manual capture for. It could only photograph what was on screen, so it made
// the screen show it:
//
//     prevApp = stage6.app; prevWorkspace = bishop.workspace;
//     stage6.app = 'bishop'; bishop.workspace = targetWorkspace;   // ← writes S.stage6
//     renderStage6();                                              // ← re-renders #stage6Area
//     initStage6BishopCanvas();                                    // ← rebinds, and auto-fits
//     stage6BishopDrawCanvas();                                    // ← paints the live canvas
//     … grab #stage6BishopCanvas …
//     finally { stage6.app = prevApp; bishop.workspace = prevWorkspace; renderStage6(); }
//
// Building a report therefore mutated the UI state, re-rendered Stage 6 twice, could leave a
// fitted viewport behind, and briefly showed the user an app they had not opened.
//
// PR 18e made that unnecessary: `buildCanvasViewModel` is pure and `drawCanvasFrame(ctx, vm, theme)`
// takes **any** 2D context (report 27 §7.5). So the capture is now a frame like any other, painted
// on a canvas nobody ever sees:
//
//     (state, results, options) → dataURL
//
// with `state` = `{bishop, model}`, `results` = `{workspace, width, height, dpr}` (which analysis to
// paint, and in what box), and `options` the host's three non-pure pieces — a canvas factory, the
// resolved theme and the draw-time `env` of `seepslope/canvas`. **Nothing here writes**: no
// `S.stage6`, no render, no canvas element, no `document`.
//
// Reproducing the monolith's pixels
// ---------------------------------
// The old image was the *live* canvas: a backing store of `round(cssWidth·dpr) × round(cssHeight·dpr)`
// painted under `setTransform(dpr,0,0,dpr,0,0)` from a view model built with the **CSS** width and
// height, then down-scaled into a ≤ 1400 px canvas and encoded as JPEG at 0.9. All four steps are
// reproduced here in the same order — same backing-store size, same transform, same view model,
// same `drawImage` down-scale, same `toDataURL` — so the bytes are the monolith's as long as the
// host hands in the box the on-screen canvas has (or would have). The host's two remaining jobs
// are therefore the box (`bishopCanvasProbeHtml` below is the layout it is measured through) and a
// real `HTMLCanvasElement`; where there is none (SSR, the Node golden harness) the capture is null,
// exactly as the monolith's `instanceof HTMLCanvasElement` guard made it null.
//
// The one frame input that is deliberately *not* taken from the host is the pointer hover: a report
// image must not carry a tool's hover preview. In the monolith the two agreed anyway — the capture
// is triggered by a click on a button outside the canvas, and `pointerleave` has cleared
// `canvasState.hoverWorld` by then.
import { buildCanvasViewModel, canvasWorkspace, canvasWorldBounds, drawCanvasFrame, fitViewport } from '../canvas/index.js';
import { safeClone } from '../../report/clone.js';

/** The three analyses that can be captured — the monolith's `valid` array (17955). */
export const CAPTURE_WORKSPACES = Object.freeze(['stability', 'seepage', 'deformation']);

/** `stage7CaptureCanvasImage`'s defaults (17910-17914): ≤ 1400 px wide, JPEG at 0.9. */
export const CAPTURE_IMAGE_DEFAULTS = Object.freeze({ maxWidth: 1400, quality: 0.9, mimeType: 'image/jpeg' });

/** The host convention of PR 18a / 18d: every hook may be a value or a thunk. */
function resolve(hook, ...args){
  return typeof hook === 'function' ? hook(...args) : hook;
}

/** The monolith's three-way `targetWorkspace` switch (18001-18006): anything else is stability. */
export function captureWorkspace(workspace){
  return workspace === 'seepage' ? 'seepage' : workspace === 'deformation' ? 'deformation' : 'stability';
}

/** `stage7CaptureWorkspaceView`'s `valid.includes(workspace)` guard (17955-17956). */
export function isCaptureWorkspace(workspace){
  return CAPTURE_WORKSPACES.includes(workspace);
}

/** The monolith's `hasContent` guard (18007-18012): is there anything to photograph? */
export function workspaceHasContent(bishop, workspace){
  const target = captureWorkspace(workspace);
  if(!bishop) return false;
  return target === 'seepage'
    ? !!(bishop.seepage?.mesh && bishop.seepage?.result)
    : target === 'deformation'
    ? !!(bishop.deformation?.result)
    : !!(bishop.results?.allResults?.length);
}

/**
 * The `display` block the **automatic** capture records (18046-18066) — the seepage branch is an
 * explicit nine-flag projection with the render's own defaults, not a clone of the display state.
 */
export function autoCaptureDisplay(bishop, workspace){
  const target = captureWorkspace(workspace);
  if(target === 'seepage'){
    return {
      contourMode:bishop.seepage?.display?.contourMode || 'head',
      showContours:bishop.seepage?.display?.showContours !== false,
      showContourLines:bishop.seepage?.display?.showContourLines !== false,
      showContourLegend:bishop.seepage?.display?.showContourLegend !== false,
      showBoundaryConditions:bishop.seepage?.display?.showBoundaryConditions !== false,
      showBoundaryLabels:bishop.seepage?.display?.showBoundaryLabels !== false,
      showPhreatic:bishop.seepage?.display?.showPhreatic !== false,
      showFlowVectors:!!bishop.seepage?.display?.showFlowVectors,
      showExitGradient:!!bishop.seepage?.display?.showExitGradient
    };
  }
  if(target === 'deformation') return safeClone(bishop.deformation?.display || null);
  return {
    selectedResult:Math.min(Math.max(bishop.selectedResult || 0, 0), Math.max((bishop.results?.allResults?.length || 1) - 1, 0)),
    methodMode:bishop.methodMode || 'bishop_spencer'
  };
}

/**
 * The `display` block the **manual** capture records (17968-17978) — the "Capture for report"
 * button in the workspace toolbar. Deliberately different from `autoCaptureDisplay`: the seepage
 * and deformation branches clone the display state as it is, and the stability branch does not
 * clamp `selectedResult` to the result count. Returns null for an unknown workspace.
 */
export function manualCaptureDisplay(bishop, workspace){
  if(workspace === 'stability'){
    return {
      selectedResult: Math.max(0, bishop.selectedResult || 0),
      methodMode: bishop.methodMode || 'bishop_spencer'
    };
  }
  if(workspace === 'seepage') return safeClone(bishop.seepage?.display || null);
  if(workspace === 'deformation') return safeClone(bishop.deformation?.display || null);
  return null;
}

/**
 * The viewport the capture's frame uses. The monolith's re-render ran `initStage6BishopCanvas` →
 * `stage6BishopAutoFitViewportIfNeeded`, so an unfitted viewport was fitted **and written back to
 * `S.stage6`** before the frame was drawn. The fit is reproduced for this frame only; nothing is
 * written back. (On screen `fitted` is true by the time a report can be built — every Bishop render
 * ends in the same auto-fit — so this branch is the one the app-switch path used to take.)
 */
export function captureViewport(bishop, model, width, height){
  const viewport = bishop?.viewport || null;
  if(!viewport || viewport.fitted) return viewport;
  return { ...viewport, ...fitViewport(canvasWorldBounds(bishop, model), width, height) };
}

/**
 * `stage7CaptureCanvasImage` (17916-17951) with the source canvas and the canvas factory handed in:
 * down-scale to `maxWidth`, paint white underneath, encode. Returns null when there is nothing to
 * scale (a 0 × 0 canvas) or no real canvas to scale into.
 */
export function rasteriseCanvas(source, options = {}){
  if(!source || !source.width || !source.height) return null;
  const { maxWidth = CAPTURE_IMAGE_DEFAULTS.maxWidth, quality = CAPTURE_IMAGE_DEFAULTS.quality,
          mimeType = CAPTURE_IMAGE_DEFAULTS.mimeType, createCanvas } = options;
  if(typeof createCanvas !== 'function') return null;
  try{
    const scale = Math.min(1, maxWidth / Math.max(source.width, 1));
    const out = createCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
    if(!out) return null;
    const ctx = out.getContext('2d');
    if(!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0, out.width, out.height);
    return {
      mimeType,
      width:out.width,
      height:out.height,
      dataUrl:out.toDataURL(mimeType, quality)
    };
  }catch(error){
    console.warn('Stage 7 canvas capture failed:', error);
    return null;
  }
}

/**
 * One Seep / Slope frame, painted on a canvas of its own — the offscreen replacement for
 * "switch the app, re-render, read the live canvas".
 *
 * @param state    `{bishop, model}` — the Seep / Slope block and the section model of the frame.
 * @param results  `{workspace, width, height, dpr}` — which analysis to paint, the canvas' CSS box
 *                 and the device pixel ratio the backing store is sized for.
 * @param options  `{createCanvas, theme, env, hoverWorld, excludeKey}`.
 * @returns the painted canvas, or null when the host cannot provide one.
 */
export function renderWorkspaceFrame(state, results, options = {}){
  const bishop = state?.bishop;
  const model = state?.model ?? null;
  if(!bishop) return null;
  const workspace = captureWorkspace(results?.workspace);
  const width = Number(results?.width) || 0;
  const height = Number(results?.height) || 0;
  const dpr = Number(results?.dpr) || 1;
  if(!(width > 0) || !(height > 0)) return null;
  const createCanvas = options.createCanvas;
  if(typeof createCanvas !== 'function') return null;
  const canvas = createCanvas(Math.round(width * dpr), Math.round(height * dpr));
  if(!canvas || !canvas.width || !canvas.height) return null;
  const ctx = canvas.getContext('2d');
  if(!ctx) return null;
  // The host half of stage6BishopDrawCanvas (4764-4810), verbatim: the backing store is sized for
  // the device pixel ratio and the frame is drawn in CSS pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const viewport = captureViewport(bishop, model, width, height);
  const viewModel = buildCanvasViewModel({
    // The workspace is an override on a shallow copy instead of a write to `bishop.workspace`;
    // `canvasWorkspace` is the only thing the view model reads it for, and every draw layer is a
    // pure reader of the block (PR 18e).
    bishop: canvasWorkspace(bishop) === workspace ? bishop : { ...bishop, workspace },
    model,
    viewport,
    width,
    height,
    hoverWorld: options.hoverWorld ?? null,
    excludeKey: options.excludeKey ?? ''
  }, options.env);
  drawCanvasFrame(ctx, viewModel, resolve(options.theme));
  return canvas;
}

/**
 * The brief's `(state, results, options) → dataURL`: paint the frame offscreen, then down-scale and
 * encode it exactly as `stage7CaptureCanvasImage` did.
 *
 * @returns `{mimeType, width, height, dataUrl}` or null.
 */
export function captureWorkspaceImage(state, results, options = {}){
  const canvas = renderWorkspaceFrame(state, results, options);
  if(!canvas) return null;
  return rasteriseCanvas(canvas, options);
}

/**
 * The whole annex entry the Stage 7 payload stores — `stage7CaptureBishopWorkspaceView`'s return
 * value (18042-18069), key for key and in the same order, minus the app switching.
 *
 * @returns the captured view, or null when there is nothing to capture or no canvas to capture on.
 */
export function captureBishopWorkspaceView(state, results, options = {}){
  const bishop = state?.bishop;
  if(!bishop) return null;
  const workspace = captureWorkspace(results?.workspace);
  if(!workspaceHasContent(bishop, workspace)) return null;
  const image = captureWorkspaceImage(state, { ...results, workspace }, options);
  if(!image?.dataUrl) return null;
  const now = options.now ? resolve(options.now) : new Date();
  return safeClone({
    workspace,
    app:'bishop',
    capturedAt:now.toISOString(),
    display:autoCaptureDisplay(bishop, workspace),
    viewport:safeClone(bishop.viewport || null),
    image
  });
}

/**
 * `deps.captureBishopWorkspaceView(workspace)` for one CPT state — the shape `report/payload-stage6.js`
 * calls, with the host's non-pure pieces bound once.
 *
 * `host` (each entry a value or a thunk, PR 18a's convention):
 *   ensure()        the Stage 6 state normaliser the monolith opened with (`ensureStage6State`)
 *   box()           `{width, height, dpr}` — the canvas' CSS box on screen, or null when Stage 6 is
 *                   not laid out (the state in which the monolith measured a 0 × 0 canvas and
 *                   returned null too). See `bishopCanvasProbeHtml`.
 *   model()         the section model for the frame (`buildBishopModelFromStageLayers`)
 *   createCanvas(w, h)  a real offscreen `HTMLCanvasElement`, or null where there is none
 *   theme()         `seepslopeVizSeries()`, resolved once per frame as the sequencer does
 *   env             `SEEPSLOPE_CANVAS_ENV` — the draw-time reads the canvas package cannot own yet
 *
 * Without a host the capture is `() => null`: a payload built under Node has no canvas.
 * The guards run in the monolith's order — ensure, block, `hasContent`, then the frame — so a state
 * with no results costs nothing and never touches the DOM.
 */
export function bishopWorkspaceCapture(cpt, host){
  return (workspace)=>{
    if(!host) return null;
    resolve(host.ensure);
    const bishop = cpt?.stage6?.bishop;
    if(!bishop) return null;
    const target = captureWorkspace(workspace);
    if(!workspaceHasContent(bishop, target)) return null;
    const box = resolve(host.box);
    if(!box) return null;
    return captureBishopWorkspaceView({ bishop, model:resolve(host.model) }, { workspace:target, ...box }, host);
  };
}

/**
 * The markup a host measures the canvas' box through when the Seep / Slope app is **not** on screen.
 *
 * `seepslope/panels/layout.js` puts the canvas at
 * `.mc2.st6-bishop › .st6-bishop-layout › .st6-bishop-main › .st6-bishop-canvas-wrap ›
 * .st6-bishop-canvas-stage › canvas.st6-bishop-canvas`, and the canvas is `width:100%` with a fixed
 * CSS height. Appending this chain to `#stage6Area` — a plain block whose children all get its
 * content width, and which holds the app body as a direct child — therefore measures exactly the box
 * a Bishop render would give the canvas, with the real stylesheet doing the arithmetic and without
 * rendering anything. The empty settings panel is included so the `--settings-collapsed` /
 * `--settings-wide` grid places the main column in the same cell it would really occupy.
 *
 * `settingsCollapsed` is the render's own hard-coded `true` (`panels/view-model.js:84`, PLAN §6
 * "three write-only UI flags"); `settingsWide` is `ui.bishopSettingsWide === true` (:85).
 */
export function bishopCanvasProbeHtml({ settingsCollapsed = true, settingsWide = false } = {}){
  const layout = `st6-bishop-layout${settingsCollapsed ? ' st6-bishop-layout--settings-collapsed' : ''}${settingsWide ? ' st6-bishop-layout--settings-wide' : ''}`;
  return `<div class="mc2 st6-bishop"><div class="${layout}">`
    + '<div class="st6-bishop-side st6-bishop-settings-panel"></div>'
    + '<div class="st6-bishop-main"><div class="st6-bishop-canvas-wrap"><div class="st6-bishop-canvas-stage">'
    + '<canvas class="st6-bishop-canvas"></canvas>'
    + '</div></div></div></div></div>';
}
