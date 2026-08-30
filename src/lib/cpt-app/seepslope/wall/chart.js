// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/wall/chart.js — the five small wall-response diagrams under the Analysis tab, painted
// straight onto a 2D context (no Chart.js): the s-axis down the page, the value axis mirrored
// about the wall line, and a labelled marker at the min and the max. 01-monolith-map.md §2.11
// "Wall results"; moved out of legacy-controller.js in PR 20 / refactor step 10, verbatim.
//
// `deps` carries the three formatters from seepslope/wall/response.js so this module stays free
// of the active CPT: {wallQuantityFormat, cssColorWithAlpha, contrastingTextColor}.

import { readCssToken } from '../../core/css-tokens.js';
import { compactNumber as stage6CompactNumber } from '../../core/format.js';

export function stage6BishopRenderWallChart(canvas, sValues, values, options = {}, deps){
  if(!canvas || !sValues?.length || !values?.length) return;
  const {wallQuantityFormat, cssColorWithAlpha, contrastingTextColor} = deps;
  const dpr = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(rect.width || Number(canvas.getAttribute('width')) || 260, 160);
  const cssHeight = Math.max(rect.height || Number(canvas.getAttribute('height')) || 112, 80);
  if(canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)){
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  if(!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const padL = 42;
  const padR = 52;
  const padT = 14;
  const padB = 20;
  const plotW = Math.max(cssWidth - padL - padR, 1);
  const plotH = Math.max(cssHeight - padT - padB, 1);
  const finitePairs = values.map((value, index)=>({s:Number(sValues[index]), value:Number(value), index}))
    .filter((pair)=>Number.isFinite(pair.s) && Number.isFinite(pair.value));
  if(!finitePairs.length) return;
  const sMin = Math.min(...finitePairs.map((pair)=>pair.s));
  const sMax = Math.max(...finitePairs.map((pair)=>pair.s), sMin + 1e-6);
  const minValue = Math.min(...finitePairs.map((pair)=>pair.value));
  const maxValue = Math.max(...finitePairs.map((pair)=>pair.value));
  const minPair = finitePairs.reduce((best, pair)=>pair.value < best.value ? pair : best, finitePairs[0]);
  const maxPair = finitePairs.reduce((best, pair)=>pair.value > best.value ? pair : best, finitePairs[0]);
  const maxAbs = Math.max(Math.abs(minValue), Math.abs(maxValue), 1e-12);
  const px = (value)=>padL + 0.5 * plotW + 0.48 * plotW * (value / maxAbs);
  const py = (s)=>padT + plotH * ((s - sMin) / Math.max(sMax - sMin, 1e-9));
  const axis = readCssToken('--bd', 'rgba(90,100,120,0.35)');
  const stroke = options.stroke || readCssToken('--chart-blue', '#2f6f9f');
  const text = readCssToken('--tx2', '#586271');
  ctx.save();
  ctx.strokeStyle = axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px(0), padT);
  ctx.lineTo(px(0), padT + plotH);
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  finitePairs.forEach((pair, index)=>{
    const x = px(pair.value);
    const y = py(pair.s);
    if(index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const drawExtremum = (pair, label, fillColor, preferAbove = true)=>{
    if(!pair) return;
    const x = px(pair.value);
    const y = py(pair.s);
    const valueText = `${label} ${wallQuantityFormat(pair.value, {unit:options.unit || '', digits:3})}`;
    const stationText = `s=${stage6CompactNumber(pair.s, 3)} m`;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = fillColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = '10px system-ui, sans-serif';
    const labelW = Math.max(ctx.measureText(valueText).width, ctx.measureText(stationText).width) + 10;
    const labelH = 25;
    let lx = x + (pair.value >= 0 ? 8 : -labelW - 8);
    let ly = y + (preferAbove ? -labelH - 6 : 6);
    lx = Math.max(2, Math.min(cssWidth - labelW - 2, lx));
    ly = Math.max(2, Math.min(cssHeight - labelH - 2, ly));
    ctx.fillStyle = cssColorWithAlpha(fillColor, 0.88);
    ctx.strokeStyle = cssColorWithAlpha(fillColor, 0.96);
    ctx.lineWidth = 1;
    if(typeof ctx.roundRect === 'function'){
      ctx.beginPath();
      ctx.roundRect(lx, ly, labelW, labelH, 5);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(lx, ly, labelW, labelH);
      ctx.strokeRect(lx, ly, labelW, labelH);
    }
    ctx.fillStyle = contrastingTextColor(fillColor);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(valueText, lx + 5, ly + 3);
    ctx.fillText(stationText, lx + 5, ly + 14);
    ctx.restore();
  };
  const extremaSamePoint = minPair.index === maxPair.index || Math.abs(minPair.s - maxPair.s) < 1e-9 && Math.abs(minPair.value - maxPair.value) < 1e-12;
  drawExtremum(minPair, 'min', stroke, true);
  if(!extremaSamePoint) drawExtremum(maxPair, 'max', stroke, false);
  ctx.fillStyle = text;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('s=0', 4, padT + 4);
  ctx.fillText(wallQuantityFormat(minValue, {unit:options.unit || '', digits:3}), padL, cssHeight - 5);
  ctx.textAlign = 'right';
  ctx.fillText(wallQuantityFormat(maxValue, {unit:options.unit || '', digits:3}), cssWidth - padR, cssHeight - 5);
  ctx.textAlign = 'left';
  ctx.fillText(`s=${stage6CompactNumber(sMax, 3)} m`, 4, padT + plotH);
  ctx.restore();
}
