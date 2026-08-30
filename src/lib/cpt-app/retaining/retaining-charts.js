// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Small, dependency-free canvas charts for the retaining-wall results:
 *   drawDepthChart  — value on x, depth on y (downwards): pressure / shear / moment diagrams
 *   drawXYChart     — generic x–y line chart (drivability force envelope, blow counts, PPV vs distance)
 * Crisp on HiDPI, no external libraries. Axes, grid and text read the `--viz-*` tokens through
 * theme.ts vizTheme() on every draw (design-system §3.13 / §3.14), so a theme switch redraws in the
 * new palette; the series colours come from the caller (retainingVizSeries()).
 */
import { vizTheme, withAlpha } from '../../styles/theme.ts';

const FONT = '11px JetBrains Mono, monospace';
const TITLE_FONT = '600 11.5px DM Sans, system-ui, sans-serif';

function prepare(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(rect.width, 160), H = Math.max(rect.height, 120);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = FONT;
  const t = vizTheme();
  return { ctx, W, H, t };
}

function niceStep(range, target = 5) {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
  const m = raw / p;
  const f = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return f * p;
}

function fmtTick(v, step) {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return Number(v).toFixed(d);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{series:{z:number[], v:number[], color:string, label:string, fill?:string}[], depthMax:number, unit:string, title?:string, markers?:{depth:number,label:string,color?:string}[], zero?:boolean}} spec
 */
export function drawDepthChart(canvas, spec) {
  const { ctx, W, H, t } = prepare(canvas);
  const mL = 48, mR = 14, mT = spec.title ? 26 : 12, mB = 30;
  const pw = W - mL - mR, ph = H - mT - mB;
  let vMin = 0, vMax = 0;
  for (const s of spec.series) for (const v of s.v) { if (Number.isFinite(v)) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); } }
  if (vMax - vMin < 1e-9) { vMin -= 1; vMax += 1; }
  const pad = (vMax - vMin) * 0.06; vMin -= pad; vMax += pad;
  const dMax = Math.max(spec.depthMax || 1, 0.1);
  const X = (v) => mL + (v - vMin) / (vMax - vMin) * pw;
  const Y = (d) => mT + (d / dMax) * ph;
  // grid + axes
  ctx.strokeStyle = t.grid; ctx.lineWidth = 1;
  const sv = niceStep(vMax - vMin, 5);
  for (let v = Math.ceil(vMin / sv) * sv; v <= vMax + 1e-9; v += sv) { ctx.beginPath(); ctx.moveTo(X(v), mT); ctx.lineTo(X(v), mT + ph); ctx.stroke(); }
  const sd = niceStep(dMax, 6);
  for (let d = 0; d <= dMax + 1e-9; d += sd) { ctx.beginPath(); ctx.moveTo(mL, Y(d)); ctx.lineTo(mL + pw, Y(d)); ctx.stroke(); }
  ctx.strokeStyle = t.axis; ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + ph); ctx.lineTo(mL + pw, mT + ph); ctx.stroke();
  if (vMin < 0 && vMax > 0) { ctx.strokeStyle = withAlpha(t.axis, 0.35); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(0), mT); ctx.lineTo(X(0), mT + ph); ctx.stroke(); ctx.setLineDash([]); }
  // ticks
  ctx.fillStyle = t.textMuted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let v = Math.ceil(vMin / sv) * sv; v <= vMax + 1e-9; v += sv) ctx.fillText(fmtTick(v, sv), X(v), mT + ph + 4);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let d = 0; d <= dMax + 1e-9; d += sd) ctx.fillText(fmtTick(d, sd), mL - 5, Y(d));
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(spec.unit || '', mL + pw / 2, H - 2);
  ctx.save(); ctx.translate(12, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('depth (m)', 0, 0); ctx.restore();
  if (spec.title) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = t.text; ctx.font = TITLE_FONT; ctx.fillText(spec.title, mL, 4); ctx.font = FONT; }
  // markers (excavation, anchor, toe)
  for (const mk of spec.markers || []) {
    if (!Number.isFinite(mk.depth)) continue;
    ctx.strokeStyle = mk.color || withAlpha(t.axis, 0.45); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(mL, Y(mk.depth)); ctx.lineTo(mL + pw, Y(mk.depth)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = mk.color || t.textMuted; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(mk.label, mL + pw - 3, Y(mk.depth) - 2);
  }
  // series
  for (const s of spec.series) {
    if (!s.z || s.z.length < 2) continue;
    if (s.fill) {
      ctx.beginPath(); ctx.moveTo(X(0), Y(s.z[0]));
      for (let i = 0; i < s.z.length; i++) ctx.lineTo(X(s.v[i]), Y(s.z[i]));
      ctx.lineTo(X(0), Y(s.z[s.z.length - 1])); ctx.closePath(); ctx.fillStyle = s.fill; ctx.fill();
    }
    ctx.beginPath();
    for (let i = 0; i < s.z.length; i++) { const x = X(s.v[i]), y = Y(s.z[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6; ctx.stroke();
  }
  // legend
  let lx = mL + 6, ly = mT + 6;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const s of spec.series) {
    ctx.fillStyle = s.color; ctx.fillRect(lx, ly - 4, 10, 8);
    ctx.fillStyle = t.textMuted; ctx.fillText(s.label, lx + 14, ly);
    ly += 14;
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{series:{x:number[], y:number[], color:string, label:string, dash?:number[], points?:boolean}[], xLabel:string, yLabel:string, title?:string, logY?:boolean, xMin?:number, xMax?:number, yMin?:number, yMax?:number, hlines?:{y:number,label:string,color?:string}[], vlines?:{x:number,label:string,color?:string}[]}} spec
 */
export function drawXYChart(canvas, spec) {
  const { ctx, W, H, t } = prepare(canvas);
  const mL = 52, mR = 14, mT = spec.title ? 26 : 12, mB = 34;
  const pw = W - mL - mR, ph = H - mT - mB;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const s of spec.series) for (let i = 0; i < s.x.length; i++) {
    if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) continue;
    xMin = Math.min(xMin, s.x[i]); xMax = Math.max(xMax, s.x[i]); yMin = Math.min(yMin, s.y[i]); yMax = Math.max(yMax, s.y[i]);
  }
  for (const h of spec.hlines || []) { yMin = Math.min(yMin, h.y); yMax = Math.max(yMax, h.y); }
  if (Number.isFinite(spec.xMin)) xMin = spec.xMin; if (Number.isFinite(spec.xMax)) xMax = spec.xMax;
  if (Number.isFinite(spec.yMin)) yMin = spec.yMin; if (Number.isFinite(spec.yMax)) yMax = spec.yMax;
  if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; } if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (xMax - xMin < 1e-9) xMax = xMin + 1; if (yMax - yMin < 1e-9) yMax = yMin + 1;
  const logY = !!spec.logY && yMin > 0;
  if (!logY) { const p = (yMax - yMin) * 0.06; yMin = spec.yMin != null ? yMin : Math.min(0, yMin - p); yMax += p; }
  const ty = (y) => logY ? Math.log10(y) : y;
  const X = (x) => mL + (x - xMin) / (xMax - xMin) * pw;
  const Y = (y) => mT + ph - (ty(y) - ty(yMin)) / (ty(yMax) - ty(yMin)) * ph;
  ctx.strokeStyle = t.grid; ctx.lineWidth = 1;
  const sx = niceStep(xMax - xMin, 6);
  for (let x = Math.ceil(xMin / sx) * sx; x <= xMax + 1e-9; x += sx) { ctx.beginPath(); ctx.moveTo(X(x), mT); ctx.lineTo(X(x), mT + ph); ctx.stroke(); }
  const yTicks = [];
  if (logY) { for (let e = Math.floor(Math.log10(yMin)); e <= Math.ceil(Math.log10(yMax)); e++) for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= yMin && v <= yMax) yTicks.push(v); } }
  else { const sy = niceStep(yMax - yMin, 5); for (let y = Math.ceil(yMin / sy) * sy; y <= yMax + 1e-9; y += sy) yTicks.push(y); }
  for (const y of yTicks) { ctx.beginPath(); ctx.moveTo(mL, Y(y)); ctx.lineTo(mL + pw, Y(y)); ctx.stroke(); }
  ctx.strokeStyle = t.axis; ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + ph); ctx.lineTo(mL + pw, mT + ph); ctx.stroke();
  ctx.fillStyle = t.textMuted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let x = Math.ceil(xMin / sx) * sx; x <= xMax + 1e-9; x += sx) ctx.fillText(fmtTick(x, sx), X(x), mT + ph + 4);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const y of yTicks) ctx.fillText(logY ? String(y) : fmtTick(y, niceStep(yMax - yMin, 5)), mL - 5, Y(y));
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(spec.xLabel || '', mL + pw / 2, H - 2);
  ctx.save(); ctx.translate(12, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(spec.yLabel || '', 0, 0); ctx.restore();
  if (spec.title) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = t.text; ctx.font = TITLE_FONT; ctx.fillText(spec.title, mL, 4); ctx.font = FONT; }
  for (const h of spec.hlines || []) { const c = h.color || t.s4; ctx.strokeStyle = c; ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(mL, Y(h.y)); ctx.lineTo(mL + pw, Y(h.y)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = c; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(h.label, mL + pw - 3, Y(h.y) - 2); }
  // vertical lines; labels stacked in rows when their x-positions would overlap
  let lastLabelEnd = -Infinity, row = 0;
  for (const v of (spec.vlines || []).slice().sort((a, b) => a.x - b.x)) {
    ctx.strokeStyle = v.color || withAlpha(t.axis, 0.45); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(X(v.x), mT); ctx.lineTo(X(v.x), mT + ph); ctx.stroke(); ctx.setLineDash([]);
    const x0 = X(v.x) + 3, w = ctx.measureText(v.label).width;
    row = x0 < lastLabelEnd + 6 ? row + 1 : 0;
    lastLabelEnd = Math.max(lastLabelEnd, x0 + w);
    ctx.fillStyle = v.color || t.textMuted; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(v.label, x0, mT + 2 + row * 12);
  }
  for (const s of spec.series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6; ctx.setLineDash(s.dash || []);
    ctx.beginPath(); let started = false;
    for (let i = 0; i < s.x.length; i++) {
      if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i]) || (logY && s.y[i] <= 0)) { started = false; continue; }
      const x = X(s.x[i]), y = Y(s.y[i]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
    if (s.points) { ctx.fillStyle = s.color; for (let i = 0; i < s.x.length; i++) { if (!Number.isFinite(s.y[i])) continue; ctx.beginPath(); ctx.arc(X(s.x[i]), Y(s.y[i]), 3, 0, Math.PI * 2); ctx.fill(); } }
  }
  let lx = mL + 8, ly = mT + 8;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const s of spec.series) { ctx.fillStyle = s.color; ctx.fillRect(lx, ly - 4, 10, 8); ctx.fillStyle = t.textMuted; ctx.fillText(s.label, lx + 14, ly); ly += 14; }
}
