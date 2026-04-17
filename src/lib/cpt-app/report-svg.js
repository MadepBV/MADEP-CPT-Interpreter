// @ts-nocheck
import { SOIL_FILL_COLORS } from './soil-styles';

export function buildLayerColumnSvgMarkup({
  layers = [],
  maxDepth = 20,
  wt = null,
  width = 60,
  height = 400,
  emptyLabel = 'Run class.'
} = {}) {
  if (!layers.length) {
    return `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="9" fill="#9a9a96">${emptyLabel}</text>`;
  }

  const zMax = Math.max(layers[layers.length - 1]?.bot || maxDepth || 1, 0.1);
  const scale = (value) => +((value / zMax) * height).toFixed(1);

  const rects = layers
    .map((layer) => {
      const y1 = scale(layer.top);
      const y2 = scale(layer.bot);
      const fill = SOIL_FILL_COLORS[layer.type] || '#D3D1C7';
      const shortLabel = String(layer.type || '')
        .split('/')[0]
        .trim()
        .split(' ')[0];
      return `<rect x="0" y="${y1}" width="${width}" height="${Math.max(y2 - y1, 1)}" fill="${fill}" stroke="rgba(0,0,0,0.12)" stroke-width="0.5"/>
      <text x="${width / 2}" y="${(y1 + y2) / 2 + 3}" text-anchor="middle" font-size="7" fill="rgba(0,0,0,0.55)" font-family="sans-serif">${shortLabel}</text>`;
    })
    .join('');

  const wtLine =
    wt != null
      ? `<line x1="0" x2="${width}" y1="${scale(wt)}" y2="${scale(wt)}" stroke="#378ADD" stroke-width="1.5" stroke-dasharray="4,3"/>`
      : '';

  const ticks = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25].filter((value) => value <= zMax);
  const tickSvg = ticks
    .map((value) => {
      const y = scale(value);
      return `<line x1="0" x2="4" y1="${y}" y2="${y}" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>
      <text x="5" y="${y + 3}" font-size="6" fill="#9a9a96" font-family="sans-serif">${value}</text>`;
    })
    .join('');

  return rects + wtLine + tickSvg;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function readDepth(row) {
  return Number(row?.z ?? row?.depth ?? 0);
}

function readFsKPa(row) {
  if (row?.fsKPa != null && Number.isFinite(Number(row.fsKPa))) return Number(row.fsKPa);
  if (row?.fs != null && Number.isFinite(Number(row.fs))) return Number(row.fs) * 1000;
  return null;
}

export function buildLayerPreviewSvgMarkup({
  layers = [],
  rows = [],
  wt = null,
  width = 240,
  height = 520,
  showRf = true,
  showFs = false
} = {}) {
  if (!layers.length) {
    return `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="10" fill="#9a9a96">No layer preview</text>`;
  }

  const zMax = Math.max(layers[layers.length - 1]?.bot || 0, 0.1);
  const pad = 20;
  const avail = height - 2 * pad;
  const scaleDepth = (value) => pad + (value / zMax) * avail;
  const safeRows = rows
    .map((row) => ({
      depth: readDepth(row),
      qc: Number(row?.qc ?? 0),
      rf: row?.rf != null && Number.isFinite(Number(row.rf)) ? Number(row.rf) : null,
      fsKPa: readFsKPa(row)
    }))
    .filter((row) => Number.isFinite(row.depth));

  const depthX = 0;
  const colX = 22;
  const colW = 32;
  const qcX = 58;
  const secondaryMetric = showRf ? 'rf' : showFs ? 'fs' : null;
  const secondaryW = secondaryMetric === 'rf' ? 40 : secondaryMetric === 'fs' ? 54 : 0;
  const qcW = secondaryMetric ? 60 : Math.max(70, width - qcX - 18);
  const rfX = qcX + qcW + 4;
  const rfW = secondaryW;
  const profileEndX = secondaryMetric ? rfX + rfW : qcX + qcW;
  const hitEndX = Math.min(width - 4, profileEndX + 28);

  const qcVals = safeRows.map((row) => row.qc).filter((value) => value > 0);
  const rfVals = safeRows.map((row) => row.rf).filter((value) => value != null && value >= 0);
  const fsVals = safeRows.map((row) => row.fsKPa).filter((value) => value != null && value >= 0);
  const qcMax = qcVals.length ? Math.max(...qcVals) : 10;
  const rfMax = rfVals.length ? Math.max(...rfVals) : 10;
  const fsMax = fsVals.length ? Math.max(...fsVals) : 100;
  const scaleQc = (value) => qcX + (value / Math.max(qcMax, 0.1)) * qcW;
  const scaleRf = (value) => rfX + (value / Math.max(rfMax, 1)) * rfW;
  const scaleFs = (value) => rfX + (value / Math.max(fsMax, 1)) * rfW;

  let html = '';
  let overlaySvg = '';

  html += `<text x="${qcX + qcW / 2}" y="12" font-size="7" text-anchor="middle" fill="#9a9a96" font-family="sans-serif">qc (MPa)</text>`;
  if (secondaryMetric === 'rf') {
    html += `<text x="${rfX + rfW / 2}" y="12" font-size="7" text-anchor="middle" fill="#9a9a96" font-family="sans-serif">Rf (%)</text>`;
  } else if (secondaryMetric === 'fs') {
    html += `<text x="${rfX + rfW / 2}" y="12" font-size="7" text-anchor="middle" fill="#9a9a96" font-family="sans-serif">fs (kPa)</text>`;
  }

  let qcPath = '';
  let rfPath = '';
  let fsPath = '';
  if (safeRows.length > 1) {
    safeRows.forEach((row, index) => {
      const y = scaleDepth(row.depth);
      qcPath += `${index === 0 ? 'M' : 'L'}${scaleQc(row.qc).toFixed(1)},${y.toFixed(1)} `;
      if (secondaryMetric === 'rf' && row.rf != null) {
        rfPath += `${rfPath === '' ? 'M' : 'L'}${scaleRf(row.rf).toFixed(1)},${y.toFixed(1)} `;
      }
      if (secondaryMetric === 'fs' && row.fsKPa != null) {
        fsPath += `${fsPath === '' ? 'M' : 'L'}${scaleFs(row.fsKPa).toFixed(1)},${y.toFixed(1)} `;
      }
    });
  }

  html += `<line x1="${qcX}" x2="${qcX}" y1="${pad}" y2="${height - pad}" stroke="rgba(128,128,128,0.18)" stroke-width="0.5"/>`;
  html += `<line x1="${qcX + qcW}" x2="${qcX + qcW}" y1="${pad}" y2="${height - pad}" stroke="rgba(128,128,128,0.07)" stroke-width="0.4"/>`;
  if (secondaryMetric) {
    html += `<line x1="${rfX}" x2="${rfX}" y1="${pad}" y2="${height - pad}" stroke="rgba(128,128,128,0.18)" stroke-width="0.5"/>`;
    html += `<line x1="${rfX + rfW}" x2="${rfX + rfW}" y1="${pad}" y2="${height - pad}" stroke="rgba(128,128,128,0.07)" stroke-width="0.4"/>`;
  }

  for (const layer of layers) {
    const y1 = scaleDepth(layer.top);
    const y2 = scaleDepth(layer.bot);
    const h = Math.max(y2 - y1, 1.5);
    const fill = SOIL_FILL_COLORS[layer.type] || '#D3D1C7';
    const layerRows = safeRows.filter((row) => row.depth >= layer.top && row.depth <= layer.bot);
    const qcRows = layerRows.map((row) => row.qc).filter((value) => value >= 0);
    const rfRows = layerRows.map((row) => row.rf).filter((value) => value != null && value >= 0);
    const fsRows = layerRows.map((row) => row.fsKPa).filter((value) => value != null);

    html += `<text x="${depthX}" y="${y1 + 5}" font-size="7" fill="#9a9a96" font-family="sans-serif">${layer.top.toFixed(1)}</text>`;
    html += `<rect x="${colX}" y="${y1}" width="${colW}" height="${h}" fill="${fill}" fill-opacity="0.85" stroke="rgba(0,0,0,0.15)" stroke-width="0.5"/>`;
    html += `<rect class="section-layer-hit" data-layer-preview="1"
      data-type="${esc(layer.type)}"
      data-subtype="${esc(layer.subtype || '—')}"
      data-top="${Number(layer.top).toFixed(2)}" data-bot="${Number(layer.bot).toFixed(2)}" data-thk="${(layer.bot - layer.top).toFixed(2)}"
      data-points="${layerRows.length}"
      data-qcmin="${qcRows.length ? Math.min(...qcRows).toFixed(2) : '—'}"
      data-qcmax="${qcRows.length ? Math.max(...qcRows).toFixed(2) : '—'}"
      data-qcavg="${Number(layer.avgQc ?? 0).toFixed(2)}"
      data-rfmin="${rfRows.length ? Math.min(...rfRows).toFixed(2) : '—'}"
      data-rfmax="${rfRows.length ? Math.max(...rfRows).toFixed(2) : '—'}"
      data-rfavg="${layer.avgRf != null ? Number(layer.avgRf).toFixed(2) : '—'}"
      data-fsmin="${fsRows.length ? Math.min(...fsRows).toFixed(1) : '—'}"
      data-fsmax="${fsRows.length ? Math.max(...fsRows).toFixed(1) : '—'}"
      data-fsavg="${layer.avgFs != null ? (Number(layer.avgFs) * 1000).toFixed(1) : '—'}"
      x="${colX}" y="${y1}" width="${Math.max(hitEndX - colX, colW)}" height="${h}" fill="transparent"/>`;
    html += `<line x1="${colX}" x2="${hitEndX}" y1="${y1}" y2="${y1}" stroke="rgba(0,0,0,0.08)" stroke-width="0.4"/>`;
  }

  if (qcPath) {
    overlaySvg += `<path d="${qcPath.trim()}" fill="none" stroke="rgba(53,162,235,0.95)" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  if (secondaryMetric === 'rf' && rfPath) {
    overlaySvg += `<path d="${rfPath.trim()}" fill="none" stroke="rgba(235,100,53,0.95)" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  if (secondaryMetric === 'fs' && fsPath) {
    overlaySvg += `<path d="${fsPath.trim()}" fill="none" stroke="rgba(83,74,183,0.95)" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  html += `<text x="${qcX}" y="${height - 4}" font-size="6" fill="#9a9a96" font-family="sans-serif">0</text>`;
  html += `<text x="${qcX + qcW}" y="${height - 4}" font-size="6" text-anchor="end" fill="#9a9a96" font-family="sans-serif">${qcMax.toFixed(0)}</text>`;
  if (secondaryMetric === 'rf') {
    html += `<text x="${rfX}" y="${height - 4}" font-size="6" fill="#9a9a96" font-family="sans-serif">0</text>`;
    html += `<text x="${rfX + rfW}" y="${height - 4}" font-size="6" text-anchor="end" fill="#9a9a96" font-family="sans-serif">${rfMax.toFixed(0)}</text>`;
  } else if (secondaryMetric === 'fs') {
    html += `<text x="${rfX}" y="${height - 4}" font-size="6" fill="#9a9a96" font-family="sans-serif">0</text>`;
    html += `<text x="${rfX + rfW}" y="${height - 4}" font-size="6" text-anchor="end" fill="#9a9a96" font-family="sans-serif">${fsMax.toFixed(0)}</text>`;
  }

  const lastLayer = layers[layers.length - 1];
  html += `<text x="${depthX}" y="${scaleDepth(lastLayer.bot) + 5}" font-size="7" fill="#9a9a96" font-family="sans-serif">${lastLayer.bot.toFixed(1)}</text>`;

  if (wt != null && Number.isFinite(Number(wt))) {
    const wtY = scaleDepth(Number(wt));
    html += `<line x1="${colX - 4}" x2="${profileEndX}" y1="${wtY}" y2="${wtY}" stroke="#378ADD" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    html += `<text x="${profileEndX + 2}" y="${wtY + 3}" font-size="6.5" fill="#378ADD" font-family="sans-serif">WT</text>`;
  }

  return html + overlaySvg;
}
