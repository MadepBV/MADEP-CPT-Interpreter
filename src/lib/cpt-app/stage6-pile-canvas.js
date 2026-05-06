// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stage 6 — Pile Estimator: interactive SVG section view.
//
// Renders the soil column (from S.layers + S.wt), the parametric pile
// geometry, the active-shaft band, the downdrag band and neutral plane
// (when applicable), drag handles for {head, toe, shaft edges, base
// edges, neutral plane}, dimension callouts, and a hover tooltip / layer
// popover.
//
// The module is split into:
//   - pure markup builder       : `buildPileSectionMarkup({...})`
//   - DOM wrapper + handlers    : `drawStage6PileSection(elId, ...)`
//   - lazy canvas state init    : `ensurePileCanvasState(state)`
//   - snap helper               : `stage6PileSnapZ(z, layers, mode)`
//
// The markup builder is deterministic from inputs and is safe to test in
// isolation. The DOM wrapper attaches event delegation on the host SVG
// element and re-renders the markup on every meaningful state change.

import {
  worldToScreen,
  screenToWorld,
  fitViewport,
  attachPanZoomPointer,
  snapToAnchors,
  snapToGrid,
  clampValue,
  makeViewport
} from './stage6-canvas-utils.js';

import { SOIL_FILL_COLORS } from './soil-styles.js';

const SVG_W = 320;
const SVG_H = 520;
const PADDING_X = 28;
const PADDING_TOP = 18;
const PADDING_BOT = 18;
const HANDLE_RADIUS = 7;
const HANDLE_HIT_PADDING = 4;
const SNAP_TOL_LAYER = 0.10;     // m, layer-boundary snap tolerance
const SNAP_GRID = 0.10;          // m, secondary grid snap
const Z_MIN_PILE_LENGTH = 0.50;  // m
const MIN_DS = 0.10;             // m
const MAX_DS = 5.0;              // m
const MAX_DB = 5.0;              // m

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export function ensurePileCanvasState(host) {
  if (!host.pileCanvas) {
    host.pileCanvas = {
      viewport: makeViewport(),
      hoverHandleId: null,
      hoverLayerIndex: null,
      drag: null,
      popover: null,
      lastFitKey: ''
    };
  }
  return host.pileCanvas;
}

// Snap a z value to the nearest layer boundary within tolerance, then to a
// grid step. mode: 'free' | 'layers' | 'grid' | 'layers+grid' (default).
export function stage6PileSnapZ(z, layers, mode = 'layers+grid') {
  if (!Number.isFinite(z)) return z;
  if (mode === 'free') return z;
  let v = z;
  let snapped = false;
  if (mode.includes('layers') && Array.isArray(layers) && layers.length) {
    const anchors = [];
    for (const l of layers) {
      anchors.push(l.top);
      anchors.push(l.bot);
    }
    const r = snapToAnchors(v, anchors, SNAP_TOL_LAYER);
    if (r.snapped) {
      v = r.value;
      snapped = true;
    }
  }
  if (!snapped && mode.includes('grid')) {
    v = snapToGrid(v, SNAP_GRID);
  }
  return v;
}

export function drawStage6PileSection(elId, analysis, cfg, canvasState, hooks = {}) {
  const el = typeof elId === 'string' ? document.getElementById(elId) : elId;
  if (!el) return;
  const layers = hooks.getLayers ? hooks.getLayers() : [];
  const wt = hooks.getWt ? hooks.getWt() : null;
  const maxDepth = hooks.getMaxDepth ? hooks.getMaxDepth() : 0;

  const state = canvasState;
  const fitKey = computeFitKey(layers, cfg, maxDepth);
  if (state.lastFitKey !== fitKey || !state.viewport.fitted) {
    const worldBox = computeWorldBox(layers, cfg, maxDepth);
    state.viewport = fitViewport(worldBox, { width: SVG_W, height: SVG_H }, 16);
    state.lastFitKey = fitKey;
  }

  const markup = buildPileSectionMarkup({
    layers,
    wt,
    cfg,
    analysis,
    viewport: state.viewport,
    viewBox: { width: SVG_W, height: SVG_H },
    hover: {
      handleId: state.hoverHandleId,
      layerIndex: state.hoverLayerIndex,
      drag: state.drag,
      popover: state.popover
    },
    maxDepth
  });
  el.setAttribute('viewBox', `0 0 ${SVG_W} ${SVG_H}`);
  el.setAttribute('role', 'application');
  el.setAttribute('aria-label', 'Pile section editor');
  el.style.touchAction = 'none';
  el.innerHTML = markup;

  bindEvents(el, state, layers, cfg, hooks);
}

// Pure markup builder ---------------------------------------------------

export function buildPileSectionMarkup({
  layers,
  wt,
  cfg,
  analysis,
  viewport,
  viewBox,
  hover,
  maxDepth
}) {
  const W = viewBox?.width || SVG_W;
  const H = viewBox?.height || SVG_H;
  const empty = !Array.isArray(layers) || !layers.length;
  if (empty) {
    return `<g><rect x="0" y="0" width="${W}" height="${H}" fill="var(--bg2,#f6f4ef)"/>
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="11" fill="var(--tx2,#666)">
        Run Stages 2–5 to build the soil model
      </text></g>`;
  }
  const v = viewport;
  const zMax = Math.max(maxDepth, cfg.zToe + 1.0, 1.0);
  const xWidth = pileSectionDisplayWidth(cfg) || 0.4;
  const xHalf = Math.max(2.0, xWidth * 1.5);

  const partsBg = drawBackground(v, W, H, zMax);
  const partsSoil = drawSoilColumn(layers, v, W, hover);
  const partsWt = drawWaterTable(wt, v, W);
  const partsActive = drawActiveShaftBand(analysis, v, cfg, xWidth);
  const partsDowndrag = drawDowndragBand(analysis, v, cfg, xWidth);
  const partsNp = drawNeutralPlane(analysis, v, W, hover, cfg);
  const partsPile = drawPile(cfg, v, xWidth);
  const partsHandles = drawHandles(cfg, v, xWidth, analysis, hover);
  const partsDims = drawDimensions(cfg, v, xWidth, W, H);
  const partsTooltip = drawHoverOverlay(hover, analysis, layers, cfg, v, W, H);

  return `
    ${defs(zMax)}
    <g class="pile-bg">${partsBg}</g>
    <g class="pile-soil" pointer-events="visible">${partsSoil}</g>
    <g class="pile-wt" pointer-events="none">${partsWt}</g>
    <g class="pile-active" pointer-events="none">${partsActive}</g>
    <g class="pile-downdrag" pointer-events="none">${partsDowndrag}</g>
    <g class="pile-np">${partsNp}</g>
    <g class="pile-body" pointer-events="visible">${partsPile}</g>
    <g class="pile-handles">${partsHandles}</g>
    <g class="pile-dims" pointer-events="none">${partsDims}</g>
    <g class="pile-overlay" pointer-events="none">${partsTooltip}</g>
  `;
}

// ---------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------

// Drawing-style note (mirrors the Bishop/Seep/Def canvas feel):
// - subtle coordinate grid behind everything;
// - low-opacity soil fills with confident strokes — borders dominate;
// - all on-canvas text painted with a white halo so labels read on any soil
//   colour (paint-order: stroke fill);
// - accent colours grouped by engineering meaning rather than competing:
//     · water table        — cool navy (universal convention)
//     · active shaft       — quiet green (positive contribution)
//     · downdrag + N.P.    — same amber family (paired warning state)
function defs(zMax) {
  // Grid spacing chosen so the rendered grid sits comfortably at the active
  // viewport scale; matches the Bishop logic of "only show the grid when the
  // step is big enough to read." The subtle dot-grid pattern reads as a
  // measured-drawing background without competing with the geometry.
  const gridStep = chooseDepthTick(zMax);
  return `<defs>
    <pattern id="pileGrid" width="${gridStep * 36}" height="${gridStep * 36}" patternUnits="userSpaceOnUse">
      <path d="M ${gridStep * 36} 0 L 0 0 0 ${gridStep * 36}" fill="none"
        stroke="rgba(140, 150, 170, 0.18)" stroke-width="1"/>
    </pattern>
    <pattern id="pileHatchConcrete" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(40, 50, 65, 0.55)" stroke-width="1.4"/>
    </pattern>
    <pattern id="pileHatchSteel" width="6" height="6" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="6" y2="6" stroke="rgba(30, 40, 55, 0.65)" stroke-width="0.9"/>
      <line x1="6" y1="0" x2="0" y2="6" stroke="rgba(30, 40, 55, 0.65)" stroke-width="0.9"/>
    </pattern>
    <pattern id="pileHatchTimber" width="8" height="6" patternUnits="userSpaceOnUse">
      <rect width="8" height="6" fill="rgba(180, 120, 60, 0.18)"/>
      <path d="M0 3 Q2 1 4 3 T8 3" stroke="rgba(120, 80, 30, 0.55)" stroke-width="0.9" fill="none"/>
    </pattern>
    <pattern id="pileHatchDowndrag" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
      <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(180, 90, 30, 0.55)" stroke-width="1.1"/>
    </pattern>
    <style>
      .pile-soil rect { vector-effect: non-scaling-stroke; }
      .pile-text-haloed {
        paint-order: stroke fill;
        stroke: rgba(255, 255, 255, 0.92);
        stroke-width: 3;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      @media (prefers-color-scheme: dark) {
        .pile-text-haloed {
          stroke: rgba(17, 17, 16, 0.92);
          fill: #EDE9E1 !important;
        }
        .pile-label-water { fill: #6FB0E0 !important; }
        .pile-label-neutral { fill: #E0A571 !important; }
        .pile-grid-line { stroke: rgba(237, 233, 225, 0.18) !important; }
      }
    </style>
  </defs>`;
}

function drawBackground(viewport, W, H, zMax) {
  const lines = [];
  const labels = [];
  const tickStep = chooseDepthTick(zMax);
  // Show the SVG grid only when the rendered spacing is comfortably readable
  // (≥ 18 px), matching the Bishop canvas's grid-visibility rule.
  const showGrid = viewport && viewport.scale * tickStep >= 18;
  for (let z = 0; z <= zMax; z += tickStep) {
    const py = worldToScreen({ x: 0, z }, viewport).y;
    if (py < 0 || py > H) continue;
    lines.push(`<line x1="${W - PADDING_X + 4}" y1="${py.toFixed(1)}" x2="${W - PADDING_X + 10}" y2="${py.toFixed(1)}" stroke="var(--bd2,#bbb)" stroke-width="0.8"/>`);
    labels.push(`<text class="pile-text-haloed" x="${W - 2}" y="${(py + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="rgba(33, 49, 66, 0.85)">${z.toFixed(z >= 10 ? 0 : 1)} m</text>`);
  }
  return `<rect x="0" y="0" width="${W}" height="${H}" fill="var(--bg,#fbfaf6)"/>
    ${showGrid ? `<rect x="0" y="0" width="${W - PADDING_X}" height="${H}" fill="url(#pileGrid)"/>` : ''}
    <line x1="${W - PADDING_X}" y1="${PADDING_TOP}" x2="${W - PADDING_X}" y2="${H - PADDING_BOT}" stroke="var(--bd2,#bbb)" stroke-width="0.8"/>
    ${lines.join('')}
    ${labels.join('')}`;
}

function chooseDepthTick(zMax) {
  if (zMax <= 5) return 0.5;
  if (zMax <= 15) return 1.0;
  if (zMax <= 40) return 2.0;
  return 5.0;
}

function drawSoilColumn(layers, viewport, W, hover) {
  const out = [];
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    const yTop = worldToScreen({ x: 0, z: layer.top }, viewport).y;
    const yBot = worldToScreen({ x: 0, z: layer.bot }, viewport).y;
    const fill = SOIL_FILL_COLORS[layer.type] || '#dcdacf';
    const isHover = hover?.layerIndex === i;
    // Bishop-style hierarchy: low-opacity fill, confident stroke. Borders
    // dominate, soil colour reads as a tint, the geometry stays primary.
    const fillOp = isHover ? 0.45 : 0.32;
    const strokeOp = isHover ? 1.0 : 0.78;
    const stroke = `rgba(40, 50, 65, ${strokeOp})`;
    const strokeW = isHover ? 1.6 : 1.2;
    const x0 = 1;
    const x1 = W - PADDING_X;
    out.push(`<rect data-pile-layer="${i}" data-z-top="${layer.top}" data-z-bot="${layer.bot}"
      x="${x0}" y="${yTop.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${Math.max(0.5, yBot - yTop).toFixed(1)}"
      fill="${fill}" fill-opacity="${fillOp}" stroke="${stroke}" stroke-width="${strokeW}"
      style="cursor:pointer"/>`);
    // Per-layer label, haloed so it reads on any soil colour.
    const h = yBot - yTop;
    if (h > 18) {
      const labelY = (yTop + Math.min(13, h / 2)).toFixed(1);
      const qcText = Number.isFinite(+layer.avgQc) ? `q_c=${(+layer.avgQc).toFixed(1)} MPa` : '';
      out.push(`<text class="pile-text-haloed" x="${x1 - 4}" y="${labelY}" text-anchor="end" font-size="9" font-weight="600" fill="#213142" pointer-events="none">${escapeText(layer.type)} · ${qcText}</text>`);
    }
  }
  return out.join('');
}

function drawWaterTable(wt, viewport, W) {
  if (!Number.isFinite(+wt)) return '';
  const y = worldToScreen({ x: 0, z: +wt }, viewport).y;
  // Cool navy — universal phreatic-line convention; restrained so it reads as
  // technical signal, not as a competing accent.
  return `<line x1="0" y1="${y.toFixed(1)}" x2="${W - PADDING_X}" y2="${y.toFixed(1)}"
    stroke="rgba(38, 90, 150, 0.78)" stroke-width="1.2" stroke-dasharray="6 3"/>
    <text class="pile-text-haloed pile-label-water" x="2" y="${(y - 3).toFixed(1)}" font-size="9" font-weight="600" fill="rgba(38, 90, 150, 0.95)">WT ${(+wt).toFixed(2)} m</text>`;
}

function drawActiveShaftBand(analysis, viewport, cfg, displayWidth) {
  const cap = analysis?.capacity;
  if (!cap || !Array.isArray(cap.perLayer)) return '';
  const xCenter = worldToScreen({ x: 0, z: 0 }, viewport).x;
  const halfPx = (displayWidth / 2) * viewport.scale + 6;
  const out = [];
  for (const row of cap.perLayer) {
    if (row.excluded || row.aboveNeutral) continue;
    const yTop = worldToScreen({ x: 0, z: row.top }, viewport).y;
    const yBot = worldToScreen({ x: 0, z: row.bot }, viewport).y;
    // Quiet positive-action green; lower opacity so it tints the new
    // low-opacity soil fills without overpowering them.
    out.push(`<rect x="${(xCenter - halfPx).toFixed(1)}" y="${yTop.toFixed(1)}"
      width="${(2 * halfPx).toFixed(1)}" height="${Math.max(0.5, yBot - yTop).toFixed(1)}"
      fill="rgba(60, 140, 80, 0.16)"/>`);
  }
  return out.join('');
}

function drawDowndragBand(analysis, viewport, cfg, displayWidth) {
  const cap = analysis?.capacity;
  if (!cap || cap.neutralPlane == null || !Array.isArray(cap.perLayer)) return '';
  const xCenter = worldToScreen({ x: 0, z: 0 }, viewport).x;
  const halfPx = (displayWidth / 2) * viewport.scale + 6;
  const out = [];
  for (const row of cap.perLayer) {
    if (!row.aboveNeutral) continue;
    const yTop = worldToScreen({ x: 0, z: row.top }, viewport).y;
    const yBot = worldToScreen({ x: 0, z: row.bot }, viewport).y;
    out.push(`<rect x="${(xCenter - halfPx).toFixed(1)}" y="${yTop.toFixed(1)}"
      width="${(2 * halfPx).toFixed(1)}" height="${Math.max(0.5, yBot - yTop).toFixed(1)}"
      fill="url(#pileHatchDowndrag)"/>`);
  }
  return out.join('');
}

function drawNeutralPlane(analysis, viewport, W, hover, cfg) {
  const cap = analysis?.capacity;
  if (!cap || cap.neutralPlane == null) return '';
  const np = cap.neutralPlane;
  const y = worldToScreen({ x: 0, z: np }, viewport).y;
  const isHover = hover?.handleId === 'np';
  // Same amber family as the downdrag hatch — they belong together. Treats
  // the downdrag zone + neutral plane as one paired warning state instead
  // of two competing accents.
  const stroke = `rgba(180, 90, 30, ${isHover ? 1.0 : 0.88})`;
  return `<line x1="0" y1="${y.toFixed(1)}" x2="${W - PADDING_X}" y2="${y.toFixed(1)}"
    stroke="${stroke}" stroke-width="${isHover ? 2 : 1.3}" stroke-dasharray="4 3"/>
    <text class="pile-text-haloed pile-label-neutral" x="${W - PADDING_X - 4}" y="${(y - 3).toFixed(1)}" text-anchor="end" font-size="9" font-weight="600" fill="rgba(180, 90, 30, 0.96)">Neutral plane ${np.toFixed(2)} m</text>`;
}

function drawPile(cfg, viewport, displayWidth) {
  const xCenter = worldToScreen({ x: 0, z: 0 }, viewport).x;
  const halfShaftPx = (displayWidth / 2) * viewport.scale;
  const yHead = worldToScreen({ x: 0, z: cfg.zHead }, viewport).y;
  const yToe = worldToScreen({ x: 0, z: cfg.zToe }, viewport).y;
  const isEnlarged = cfg.Db > cfg.Ds + 0.05;
  const baseHeightW = isEnlarged ? Math.min(0.5, cfg.Db / 2) : 0;
  const baseHeightPx = baseHeightW * viewport.scale;
  const halfBasePx = isEnlarged ? (cfg.Db / 2) * viewport.scale : halfShaftPx;
  const hatchUrl = pileHatchUrl(cfg.pileMaterial);
  const yShaftBottom = yToe - baseHeightPx;
  // Shaft rectangle
  let out = '';
  out += `<rect x="${(xCenter - halfShaftPx).toFixed(1)}" y="${yHead.toFixed(1)}"
    width="${(2 * halfShaftPx).toFixed(1)}" height="${Math.max(0.5, yShaftBottom - yHead).toFixed(1)}"
    fill="${hatchUrl}" stroke="rgba(20,20,30,0.95)" stroke-width="1.4"/>`;
  // Base — trapezoid flaring from shaft to base
  if (isEnlarged) {
    const x1 = xCenter - halfShaftPx;
    const x2 = xCenter + halfShaftPx;
    const x3 = xCenter + halfBasePx;
    const x4 = xCenter - halfBasePx;
    const yA = yShaftBottom.toFixed(1);
    const yB = yToe.toFixed(1);
    out += `<polygon points="${x1.toFixed(1)},${yA} ${x2.toFixed(1)},${yA} ${x3.toFixed(1)},${yB} ${x4.toFixed(1)},${yB}"
      fill="${hatchUrl}" stroke="rgba(20,20,30,0.95)" stroke-width="1.4"/>`;
  }
  // Pile head cap
  out += `<line x1="${(xCenter - halfShaftPx - 6).toFixed(1)}" y1="${yHead.toFixed(1)}"
    x2="${(xCenter + halfShaftPx + 6).toFixed(1)}" y2="${yHead.toFixed(1)}"
    stroke="rgba(20,20,30,0.95)" stroke-width="2"/>`;
  // Toe tick
  out += `<line x1="${(xCenter - halfBasePx - 6).toFixed(1)}" y1="${yToe.toFixed(1)}"
    x2="${(xCenter + halfBasePx + 6).toFixed(1)}" y2="${yToe.toFixed(1)}"
    stroke="rgba(20,20,30,0.95)" stroke-width="2"/>`;
  return out;
}

function pileHatchUrl(material) {
  switch (material) {
    case 'steel': return 'url(#pileHatchSteel)';
    case 'timber': return 'url(#pileHatchTimber)';
    case 'concrete':
    default: return 'url(#pileHatchConcrete)';
  }
}

function drawHandles(cfg, viewport, displayWidth, analysis, hover) {
  const xCenter = worldToScreen({ x: 0, z: 0 }, viewport).x;
  const halfShaftPx = (displayWidth / 2) * viewport.scale;
  const isEnlarged = cfg.Db > cfg.Ds + 0.05;
  const baseDisplayWidth = pileSectionBaseWidth(cfg);
  const halfBasePx = (baseDisplayWidth / 2) * viewport.scale;
  const yHead = worldToScreen({ x: 0, z: cfg.zHead }, viewport).y;
  const yToe = worldToScreen({ x: 0, z: cfg.zToe }, viewport).y;
  const yShaftMid = (yHead + yToe) / 2;
  const npWorld = analysis?.capacity?.neutralPlane;
  const yNp = npWorld != null ? worldToScreen({ x: 0, z: npWorld }, viewport).y : null;
  const handles = [
    { id: 'head',     cx: xCenter,                cy: yHead,    cursor: 'ns-resize' },
    { id: 'toe',      cx: xCenter,                cy: yToe,     cursor: 'ns-resize' },
    { id: 'shaftL',   cx: xCenter - halfShaftPx,  cy: yShaftMid, cursor: 'ew-resize' },
    { id: 'shaftR',   cx: xCenter + halfShaftPx,  cy: yShaftMid, cursor: 'ew-resize' }
  ];
  if (isEnlarged) {
    handles.push({ id: 'baseL', cx: xCenter - halfBasePx, cy: yToe, cursor: 'ew-resize' });
    handles.push({ id: 'baseR', cx: xCenter + halfBasePx, cy: yToe, cursor: 'ew-resize' });
  }
  if (yNp != null) {
    handles.push({ id: 'np', cx: xCenter, cy: yNp, cursor: 'ns-resize' });
  }
  return handles.map((h) => {
    const isHover = hover?.handleId === h.id;
    const r = HANDLE_RADIUS + (isHover ? 1.5 : 0);
    const fill = h.id === 'np' ? 'rgba(220,120,40,0.95)' : 'rgba(40,90,180,0.95)';
    const stroke = isHover ? '#fff' : 'rgba(255,255,255,0.85)';
    return `<circle data-pile-handle="${h.id}" cx="${h.cx.toFixed(1)}" cy="${h.cy.toFixed(1)}" r="${r.toFixed(1)}"
      fill="${fill}" stroke="${stroke}" stroke-width="2"
      tabindex="0" role="slider" aria-label="${h.id}"
      style="cursor:${h.cursor}; outline:none"/>`;
  }).join('');
}

function drawDimensions(cfg, viewport, displayWidth, W, H) {
  const xCenter = worldToScreen({ x: 0, z: 0 }, viewport).x;
  const halfShaftPx = (displayWidth / 2) * viewport.scale;
  const baseDisplayWidth = pileSectionBaseWidth(cfg);
  const halfBasePx = (baseDisplayWidth / 2) * viewport.scale;
  const yHead = worldToScreen({ x: 0, z: cfg.zHead }, viewport).y;
  const yToe = worldToScreen({ x: 0, z: cfg.zToe }, viewport).y;
  const out = [];
  // D_s callout (horizontal at shaft mid)
  const yDs = (yHead + yToe) / 2 - 6;
  const dsLabel = displayWidth < 0.6 ? `${(displayWidth * 1000).toFixed(0)} mm` : `${displayWidth.toFixed(2)} m`;
  out.push(`<line x1="${(xCenter - halfShaftPx).toFixed(1)}" y1="${yDs.toFixed(1)}" x2="${(xCenter + halfShaftPx).toFixed(1)}" y2="${yDs.toFixed(1)}"
    stroke="rgba(40,40,40,0.7)" stroke-width="0.8"/>`);
  out.push(`<text x="${xCenter.toFixed(1)}" y="${(yDs - 2).toFixed(1)}" text-anchor="middle" class="pile-text-haloed" font-size="9" font-weight="600" fill="#213142">${svgSub('D','s')} ${dsLabel}</text>`);
  if (cfg.Db > cfg.Ds + 0.05) {
    const yDb = yToe + 14;
    const dbLabel = baseDisplayWidth < 0.6 ? `${(baseDisplayWidth * 1000).toFixed(0)} mm` : `${baseDisplayWidth.toFixed(2)} m`;
    out.push(`<line x1="${(xCenter - halfBasePx).toFixed(1)}" y1="${yDb.toFixed(1)}" x2="${(xCenter + halfBasePx).toFixed(1)}" y2="${yDb.toFixed(1)}"
      stroke="rgba(40,40,40,0.7)" stroke-width="0.8"/>`);
    out.push(`<text x="${xCenter.toFixed(1)}" y="${(yDb + 9).toFixed(1)}" text-anchor="middle" class="pile-text-haloed" font-size="9" font-weight="600" fill="#213142">${svgSub('D','b')} ${dbLabel}</text>`);
  }
  const xL = Math.max(8, xCenter - halfShaftPx - 18);
  const yMid = (yHead + yToe) / 2;
  out.push(`<line x1="${xL.toFixed(1)}" y1="${yHead.toFixed(1)}" x2="${xL.toFixed(1)}" y2="${yToe.toFixed(1)}"
    stroke="rgba(40,40,40,0.7)" stroke-width="0.8" marker-start="url(#dimArrow)" marker-end="url(#dimArrow)"/>`);
  out.push(`<text x="${(xL - 3).toFixed(1)}" y="${yMid.toFixed(1)}" text-anchor="end" class="pile-text-haloed" font-size="9" font-weight="600" fill="#213142" transform="rotate(-90 ${(xL - 3).toFixed(1)} ${yMid.toFixed(1)})">L=${(cfg.zToe - cfg.zHead).toFixed(2)} m</text>`);
  out.push(`<text x="${(xCenter + halfShaftPx + 10).toFixed(1)}" y="${(yHead + 3).toFixed(1)}" class="pile-text-haloed" font-size="9" font-weight="600" fill="#213142">${svgSub('z','head')} ${cfg.zHead.toFixed(2)} m</text>`);
  out.push(`<text x="${(xCenter + halfBasePx + 10).toFixed(1)}" y="${(yToe + 3).toFixed(1)}" class="pile-text-haloed" font-size="9" font-weight="600" fill="#213142">${svgSub('z','toe')} ${cfg.zToe.toFixed(2)} m</text>`);
  return out.join('');
}

function drawHoverOverlay(hover, analysis, layers, cfg, viewport, W, H) {
  if (hover?.drag) {
    return drawDragTooltip(hover.drag, viewport, W, H);
  }
  if (hover?.popover && hover.popover.layerIndex != null) {
    return drawLayerPopover(hover.popover, layers, cfg, W);
  }
  if (hover?.layerIndex != null) {
    return drawLayerTooltip(hover.layerIndex, layers, analysis, viewport, W);
  }
  return '';
}

function drawDragTooltip(drag, viewport, W, H) {
  if (!drag.tip) return '';
  const t = drag.tip;
  const x = clampValue(t.x ?? 80, 8, W - 100);
  const y = clampValue(t.y ?? 8, 8, H - 18);
  const txtLines = (t.lines || [t.text || '']).filter(Boolean);
  const lineH = 12;
  const padX = 5;
  const padY = 4;
  const boxW = Math.max(...txtLines.map((l) => l.length)) * 5.6 + 2 * padX;
  const boxH = txtLines.length * lineH + 2 * padY;
  const tspans = txtLines.map((l, i) => `<tspan x="${(x + padX).toFixed(1)}" dy="${i === 0 ? padY + 9 : lineH}">${escapeText(l)}</tspan>`).join('');
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}"
    rx="3" ry="3" fill="rgba(255,255,255,0.96)" stroke="rgba(40,40,40,0.6)"/>
    <text x="${(x + padX).toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="#222">${tspans}</text>`;
}

function drawLayerPopover(popover, layers, cfg, W) {
  const layer = layers[popover.layerIndex];
  if (!layer) return '';
  const x = clampValue(popover.x ?? 80, 8, W - 200);
  const y = clampValue(popover.y ?? 60, 8, 1e6);
  const lines = [
    `Set toe at top of layer (${layer.top.toFixed(2)} m)`,
    `Set toe at mid of layer (${((layer.top + layer.bot) / 2).toFixed(2)} m)`,
    `Set toe at bottom of layer (${layer.bot.toFixed(2)} m)`
  ];
  const items = lines.map((line, i) => {
    const action = i === 0 ? 'top' : (i === 1 ? 'mid' : 'bot');
    const cy = y + 18 + i * 22;
    return `<rect data-popover-action="${action}" data-layer-index="${popover.layerIndex}"
      x="${(x + 4).toFixed(1)}" y="${(cy - 12).toFixed(1)}" width="200" height="20" rx="3" ry="3"
      fill="rgba(245,245,240,0.9)" stroke="rgba(40,40,40,0.4)" style="cursor:pointer"/>
      <text x="${(x + 10).toFixed(1)}" y="${(cy + 1).toFixed(1)}" font-size="10" fill="#222" pointer-events="none">${escapeText(line)}</text>`;
  }).join('');
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="208" height="${(18 + lines.length * 22 + 4).toFixed(1)}"
    rx="4" ry="4" fill="rgba(255,255,255,0.97)" stroke="rgba(40,40,40,0.7)" data-popover-bg="1"/>
    <text x="${(x + 8).toFixed(1)}" y="${(y + 12).toFixed(1)}" font-size="10" font-weight="700" fill="#222">${escapeText(layer.type)} (${layer.subtype || '—'})</text>
    ${items}`;
}

function drawLayerTooltip(layerIndex, layers, analysis, viewport, W) {
  const layer = layers[layerIndex];
  if (!layer) return '';
  const cap = analysis?.capacity;
  const row = cap?.perLayer?.find((r) => r.layerIndex === layerIndex);
  const lines = [`${layer.type}${layer.subtype ? ' · ' + layer.subtype : ''}`];
  lines.push(`Top ${layer.top.toFixed(2)} m → Bot ${layer.bot.toFixed(2)} m (h=${(layer.bot - layer.top).toFixed(2)} m)`);
  if (Number.isFinite(+layer.avgQc)) lines.push(`q_c (layer mean) = ${(+layer.avgQc).toFixed(2)} MPa`);
  if (row) {
    if (row.excluded) {
      lines.push(`Excluded from shaft (q_c < 1 MPa or peat)`);
    } else if (row.aboveNeutral) {
      lines.push(`Above neutral plane — positive friction excluded`);
      lines.push(`Potential R_s = ${row.RsLayerPotential.toFixed(0)} kN (downdrag analogy)`);
    } else {
      lines.push(`η*_p = ${row.etaP != null ? row.etaP.toFixed(4) : '— (cap branch)'}`);
      lines.push(`q_s = ${row.qs.toFixed(0)} kPa, α_s = ${row.alphaS.toFixed(2)}`);
      lines.push(`R_s contribution = ${row.RsLayer.toFixed(0)} kN`);
    }
  }
  // Position to the LEFT of the soil column at layer mid
  const yMid = worldToScreen({ x: 0, z: (layer.top + layer.bot) / 2 }, viewport).y;
  const x = 8;
  const y = clampValue(yMid - 6 - lines.length * 6, 6, 1e6);
  const padX = 5;
  const padY = 4;
  const lineH = 11;
  const boxW = Math.max(...lines.map((l) => l.length)) * 5.4 + 2 * padX;
  const boxH = lines.length * lineH + 2 * padY;
  const tspans = lines.map((l, i) => `<tspan x="${(x + padX).toFixed(1)}" dy="${i === 0 ? padY + 8 : lineH}">${escapeText(l)}</tspan>`).join('');
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}"
    rx="3" ry="3" fill="rgba(255,255,255,0.96)" stroke="rgba(40,40,40,0.55)"/>
    <text x="${(x + padX).toFixed(1)}" y="${y.toFixed(1)}" font-size="9.5" fill="#222">${tspans}</text>`;
}

// ---------------------------------------------------------------------
// World box helpers
// ---------------------------------------------------------------------

function pileSectionDisplayWidth(cfg) {
  if (cfg.shape === 'circular') return cfg.Ds;
  if (cfg.shape === 'square') return positive(cfg.a, cfg.Ds);
  const a = positive(cfg.a, cfg.Ds);
  const b = positive(cfg.b, a);
  return Math.max(a, b);
}

function pileSectionBaseWidth(cfg) {
  if (cfg.shape === 'circular') return cfg.Db;
  if (cfg.shape === 'square') return Math.max(positive(cfg.a, cfg.Db), positive(cfg.Db, cfg.Ds));
  const a = positive(cfg.a, cfg.Ds);
  const b = positive(cfg.b, a);
  return Math.max(a, b);
}

function computeWorldBox(layers, cfg, maxDepth) {
  const xWidth = pileSectionDisplayWidth(cfg);
  const baseWidth = pileSectionBaseWidth(cfg);
  const xHalf = Math.max(2.0, Math.max(xWidth, baseWidth) * 1.5);
  const zMin = -0.2;
  const zMax = Math.max(maxDepth + 1.0, cfg.zToe + 1.0, 1.0);
  return { xMin: -xHalf, xMax: xHalf, zMin, zMax };
}

function computeFitKey(layers, cfg, maxDepth) {
  return `${layers?.length || 0}|${(maxDepth || 0).toFixed(2)}|${cfg.zToe.toFixed(2)}|${cfg.Ds.toFixed(3)}|${cfg.Db.toFixed(3)}|${cfg.shape}`;
}

// ---------------------------------------------------------------------
// Event binding (delegation on the host SVG)
// ---------------------------------------------------------------------

function bindEvents(el, state, layers, cfg, hooks) {
  // Pan/zoom + handle drag scaffolding on the SVG element.
  attachPanZoomPointer(el,
    () => state.viewport,
    (v) => {
      state.viewport = v;
      hooks.requestRedraw?.();
    },
    {
      onDragStart(target, world, evt) {
        const handleEl = target?.closest?.('[data-pile-handle]');
        if (handleEl) {
          const handleId = handleEl.getAttribute('data-pile-handle');
          state.hoverHandleId = handleId;
          state.popover = null;
          return {
            kind: 'handle',
            handleId,
            startCfg: snapshotCfg(cfg),
            shiftKey: !!evt.shiftKey
          };
        }
        // Click on a layer rect (without modifier) → open popover
        const layerEl = target?.closest?.('[data-pile-layer]');
        if (layerEl && evt.button === 0 && !state.drag) {
          const layerIndex = +layerEl.getAttribute('data-pile-layer');
          const popoverEl = target?.closest?.('[data-popover-action]');
          if (popoverEl) {
            const action = popoverEl.getAttribute('data-popover-action');
            const li = +popoverEl.getAttribute('data-layer-index');
            applyPopoverAction(action, li, layers, cfg, hooks);
            state.popover = null;
            hooks.requestRedraw?.();
            return null;
          }
          const rect = el.getBoundingClientRect();
          state.popover = {
            layerIndex,
            x: evt.clientX - rect.left + 12,
            y: evt.clientY - rect.top - 8
          };
          hooks.requestRedraw?.();
        }
        return null;
      },
      onDragMove(descriptor, world, evt) {
        if (descriptor.kind !== 'handle') return;
        applyHandleDrag(descriptor, world, layers, cfg, state, hooks, evt);
      },
      onDragEnd(descriptor, world, evt) {
        state.hoverHandleId = null;
        if (descriptor.kind === 'handle') {
          state.drag = null;
          // Final flush — full recompute on release
          hooks.commitChange?.();
          hooks.requestRedraw?.();
        }
      },
      onDragCancel(descriptor) {
        // Roll back to the start config snapshot
        if (descriptor?.startCfg) {
          for (const k of Object.keys(descriptor.startCfg)) {
            hooks.setField?.(k, descriptor.startCfg[k]);
          }
        }
        state.drag = null;
        state.hoverHandleId = null;
        hooks.requestRedraw?.();
      },
      onHover(target, world, evt) {
        const handleEl = target?.closest?.('[data-pile-handle]');
        const layerEl = target?.closest?.('[data-pile-layer]');
        const popoverEl = target?.closest?.('[data-popover-action]');
        const popoverBgEl = target?.closest?.('[data-popover-bg]');
        const newHover = handleEl ? handleEl.getAttribute('data-pile-handle') : null;
        const newLayer = !handleEl && layerEl ? +layerEl.getAttribute('data-pile-layer') : null;
        if (state.hoverHandleId === newHover && state.hoverLayerIndex === newLayer
            && !popoverEl && !popoverBgEl) return;
        // Dismiss popover if we hover outside it (and not over a popover item)
        if (state.popover && !popoverEl && !popoverBgEl && !layerEl) {
          state.popover = null;
        }
        state.hoverHandleId = newHover;
        state.hoverLayerIndex = newLayer;
        hooks.requestRedraw?.();
      },
      onHoverLeave() {
        state.hoverHandleId = null;
        state.hoverLayerIndex = null;
        state.popover = null;
        hooks.requestRedraw?.();
      }
    }
  );

  // Keyboard nudges on the SVG (delegated)
  el.onkeydown = (evt) => {
    const target = evt.target?.closest?.('[data-pile-handle]');
    if (!target) return;
    const handleId = target.getAttribute('data-pile-handle');
    const stepBig = evt.shiftKey ? 0.10 : 0.01;
    const direction = (evt.key === 'ArrowUp' ? -1 : (evt.key === 'ArrowDown' ? 1 : 0));
    const dirX = (evt.key === 'ArrowLeft' ? -1 : (evt.key === 'ArrowRight' ? 1 : 0));
    if (direction === 0 && dirX === 0) {
      if (evt.key === 'Escape' && state.popover) {
        state.popover = null;
        hooks.requestRedraw?.();
        evt.preventDefault();
      }
      return;
    }
    evt.preventDefault();
    applyKeyboardNudge(handleId, direction * stepBig, dirX * stepBig, layers, cfg, hooks);
  };
}

function snapshotCfg(cfg) {
  return {
    'pile.zHead': cfg.zHead,
    'pile.zToe': cfg.zToe,
    'pile.Ds': cfg.Ds,
    'pile.Db': cfg.Db,
    'pile.a': cfg.a,
    'pile.b': cfg.b,
    'pile.neutralPlane': cfg.neutralPlane
  };
}

function applyHandleDrag(descriptor, world, layers, cfg, state, hooks, evt) {
  const id = descriptor.handleId;
  const snapMode = descriptor.shiftKey || evt?.shiftKey ? 'free' : 'layers+grid';
  let tip = null;
  if (id === 'toe') {
    let z = stage6PileSnapZ(world.z, layers, snapMode);
    z = clampValue(z, cfg.zHead + Z_MIN_PILE_LENGTH, hooks.getMaxDepth?.() ?? 1e3);
    hooks.setField?.('pile.zToe', z);
    tip = { lines: [`z_toe = ${z.toFixed(2)} m`, `L = ${(z - cfg.zHead).toFixed(2)} m`] };
  } else if (id === 'head') {
    let z = stage6PileSnapZ(world.z, layers, snapMode);
    z = clampValue(z, 0, cfg.zToe - Z_MIN_PILE_LENGTH);
    hooks.setField?.('pile.zHead', z);
    tip = { lines: [`z_head = ${z.toFixed(2)} m`, `L = ${(cfg.zToe - z).toFixed(2)} m`] };
  } else if (id === 'np') {
    let z = stage6PileSnapZ(world.z, layers, snapMode);
    z = clampValue(z, cfg.zHead + 0.05, cfg.zToe - 0.05);
    hooks.setField?.('pile.neutralPlane', z);
    tip = { lines: [`Neutral plane = ${z.toFixed(2)} m`] };
  } else if (id === 'shaftL' || id === 'shaftR') {
    const halfWidth = Math.abs(world.x);
    let Ds = clampValue(2 * halfWidth, MIN_DS, Math.min(MAX_DS, cfg.Db));
    if (snapMode !== 'free') Ds = snapToGrid(Ds, 0.01);
    hooks.setField?.('pile.Ds', Ds);
    tip = { lines: [`D_s = ${Ds.toFixed(3)} m`] };
  } else if (id === 'baseL' || id === 'baseR') {
    const halfWidth = Math.abs(world.x);
    let Db = clampValue(2 * halfWidth, cfg.Ds, MAX_DB);
    if (snapMode !== 'free') Db = snapToGrid(Db, 0.01);
    hooks.setField?.('pile.Db', Db);
    tip = { lines: [`D_b = ${Db.toFixed(3)} m`] };
  }
  state.drag = {
    ...descriptor,
    tip: tip ? { ...tip, x: 12, y: 12 } : null
  };
  hooks.requestRedraw?.();
}

function applyKeyboardNudge(handleId, dz, dx, layers, cfg, hooks) {
  if (handleId === 'toe') {
    const z = clampValue(cfg.zToe + dz, cfg.zHead + Z_MIN_PILE_LENGTH, hooks.getMaxDepth?.() ?? 1e3);
    hooks.setField?.('pile.zToe', z);
  } else if (handleId === 'head') {
    const z = clampValue(cfg.zHead + dz, 0, cfg.zToe - Z_MIN_PILE_LENGTH);
    hooks.setField?.('pile.zHead', z);
  } else if (handleId === 'np') {
    const z = clampValue((cfg.neutralPlane ?? cfg.zHead + 1) + dz, cfg.zHead + 0.05, cfg.zToe - 0.05);
    hooks.setField?.('pile.neutralPlane', z);
  } else if (handleId === 'shaftL' || handleId === 'shaftR') {
    const Ds = clampValue(cfg.Ds + dx * (handleId === 'shaftR' ? 2 : -2), MIN_DS, Math.min(MAX_DS, cfg.Db));
    hooks.setField?.('pile.Ds', Ds);
  } else if (handleId === 'baseL' || handleId === 'baseR') {
    const Db = clampValue(cfg.Db + dx * (handleId === 'baseR' ? 2 : -2), cfg.Ds, MAX_DB);
    hooks.setField?.('pile.Db', Db);
  }
  hooks.commitChange?.();
  hooks.requestRedraw?.();
}

function applyPopoverAction(action, layerIndex, layers, cfg, hooks) {
  const layer = layers[layerIndex];
  if (!layer) return;
  let z;
  if (action === 'top') z = layer.top;
  else if (action === 'bot') z = layer.bot;
  else z = (layer.top + layer.bot) / 2;
  z = clampValue(z, cfg.zHead + Z_MIN_PILE_LENGTH, hooks.getMaxDepth?.() ?? 1e3);
  hooks.setField?.('pile.zToe', z);
  hooks.commitChange?.();
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function positive(v, fallback) {
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : (Number.isFinite(+fallback) ? +fallback : 0);
}

function escapeText(text) {
  return String(text ?? '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// SVG-text subscript helper. baseline-shift is W3C standard and renders in
// modern Chromium/Safari/Firefox; the inner text is auto-escaped.
function svgSub(main, sub) {
  return `${escapeText(main)}<tspan baseline-shift="sub" font-size="0.72em">${escapeText(sub)}</tspan>`;
}

// Variant: emit a subscript inside an existing <text> followed by trailing
// plain text. Returns three-part tspan markup that explicitly resets baseline
// so older renderers without baseline-shift support still align reasonably.
function svgSubInline(main, sub, tail = '') {
  return `${escapeText(main)}<tspan baseline-shift="sub" font-size="0.72em">${escapeText(sub)}</tspan>${escapeText(tail)}`;
}
