// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
function chartTitle(text) {
  return text ? { display: true, text, font: { size: 10 } } : { display: false };
}

function getChartTheme() {
  const fallback = {
    text: '#18181a',
    textMuted: '#4a4a52',
    border: 'rgba(24,24,26,0.18)',
    grid: 'rgba(24,24,26,0.08)',
    gridStrong: 'rgba(24,24,26,0.14)',
    bandFill: 'rgba(24,24,26,0.05)',
    tooltipBg: 'rgba(255,255,255,0.96)',
    blue: '#4F8584',
    purple: '#18181A',
    green: '#3D6B6A',
    orange: '#8A620D',
    red: '#9B3A32',
    neutral: '#6D6962',
    blueSoft: 'rgba(61,107,106,0.10)',
    greenSoft: 'rgba(61,107,106,0.18)',
    orangeSoft: 'rgba(138,98,13,0.18)'
  };
  if (typeof document === 'undefined') return fallback;
  const styles = getComputedStyle(document.documentElement);
  const read = (name, value) => styles.getPropertyValue(name).trim() || value;
  return {
    text: read('--tx', fallback.text),
    textMuted: read('--tx2', fallback.textMuted),
    border: read('--bd2', fallback.border),
    grid: read('--chart-grid', fallback.grid),
    gridStrong: read('--chart-grid-strong', fallback.gridStrong),
    bandFill: read('--chart-band-fill', fallback.bandFill),
    tooltipBg: read('--chart-tooltip-bg', fallback.tooltipBg),
    blue: read('--chart-blue', fallback.blue),
    purple: read('--chart-purple', fallback.purple),
    green: read('--chart-green', fallback.green),
    orange: read('--chart-orange', fallback.orange),
    red: read('--chart-red', fallback.red),
    neutral: read('--chart-neutral', fallback.neutral),
    blueSoft: read('--chart-blue-soft', fallback.blueSoft),
    greenSoft: fallback.greenSoft,
    orangeSoft: fallback.orangeSoft
  };
}

function applyChartTheme(config) {
  const theme = getChartTheme();
  const options = config.options || (config.options = {});
  options.color = options.color || theme.textMuted;

  const plugins = options.plugins || (options.plugins = {});
  if (plugins.legend) {
    plugins.legend.labels = {
      ...(plugins.legend.labels || {}),
      color: plugins.legend.labels?.color || theme.textMuted
    };
  }
  plugins.tooltip = {
    ...(plugins.tooltip || {}),
    backgroundColor: plugins.tooltip?.backgroundColor || theme.tooltipBg,
    titleColor: plugins.tooltip?.titleColor || theme.text,
    bodyColor: plugins.tooltip?.bodyColor || theme.text,
    borderColor: plugins.tooltip?.borderColor || theme.border,
    borderWidth: plugins.tooltip?.borderWidth || 1
  };

  const scales = options.scales || {};
  Object.values(scales).forEach((scale) => {
    if (!scale) return;
    if (scale.grid !== false) {
      const grid = typeof scale.grid === 'object' && scale.grid ? scale.grid : {};
      grid.color = !grid.color || grid.color === 'rgba(128,128,128,0.07)' ? theme.grid : grid.color;
      scale.grid = grid;
    }
    if (scale.border !== false) {
      const border = typeof scale.border === 'object' && scale.border ? scale.border : {};
      border.color = border.color || theme.gridStrong;
      scale.border = border;
    }
    scale.ticks = {
      ...(scale.ticks || {}),
      color: scale.ticks?.color || theme.textMuted
    };
    if (scale.title?.display) {
      scale.title = {
        ...scale.title,
        color: scale.title.color || theme.textMuted
      };
    }
  });

  return config;
}

export function buildRawProfileChartConfig({
  points,
  wt,
  xMax,
  maxDepth,
  color,
  valueLabel = 'value'
}) {
  const theme = getChartTheme();
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: valueLabel,
          data: points,
          borderColor: color,
          borderWidth: 1.2,
          pointRadius: 0,
          fill: false,
          tension: 0.04,
          spanGaps: true
        },
        {
          label: 'WT',
          data: [
            { x: 0, y: wt },
            { x: xMax, y: wt }
          ],
          borderColor: theme.blue,
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: xMax,
          position: 'top',
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 }, maxTicksLimit: 5 }
        },
        y: {
          type: 'linear',
          min: 0,
          max: maxDepth,
          reverse: true,
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildTuningRegressionChartConfig({
  scatter,
  defaultLine,
  previewLine,
  mDefault,
  mPreview,
  quality,
  invalidSlope = false
}) {
  const theme = getChartTheme();
  return applyChartTheme({
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'CPT data',
          data: scatter,
          backgroundColor: theme.blueSoft,
          pointRadius: 3,
          pointHoverRadius: 5
        },
        {
          label: `Default m=${mDefault}`,
          data: defaultLine,
          type: 'line',
          borderColor: theme.purple,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false
        },
        {
          label: `Preview m=${mPreview}`,
          data: previewLine,
          type: 'line',
          borderColor: invalidSlope ? theme.red : theme.green,
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          borderDash: quality === 'warn' || invalidSlope ? [5, 4] : []
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          title: chartTitle("ln(sigma'v0 stress ratio)"),
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 } }
        },
        y: {
          title: chartTitle('ln(E_oed,i)'),
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildTuningDepthChartConfig({
  depths,
  eoedI,
  hsDefault,
  hsPreview,
  layerTop,
  layerBot,
  wt,
  mDefault,
  mPreview,
  quality,
  invalidSlope = false
}) {
  const theme = getChartTheme();
  const allE = [...eoedI, ...hsDefault, ...hsPreview];
  const xMax = Math.ceil(Math.max(...allE) / 5000) * 5000;
  const scatterDep = depths.map((z, i) => ({ x: eoedI[i], y: z }));
  const defDep = depths.map((z, i) => ({ x: hsDefault[i], y: z }));
  const fitDep = depths.map((z, i) => ({ x: hsPreview[i], y: z }));
  const wtLine = [
    { x: 0, y: wt },
    { x: xMax, y: wt }
  ];
  const topLine = [
    { x: 0, y: layerTop },
    { x: xMax, y: layerTop }
  ];
  const botLine = [
    { x: 0, y: layerBot },
    { x: xMax, y: layerBot }
  ];
  const yMin = Math.max(0, layerTop - 0.5);
  const yMax = layerBot + 0.5;

  return applyChartTheme({
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'layer',
          data: [
            { x: 0, y: layerTop },
            { x: xMax, y: layerTop },
            { x: xMax, y: layerBot },
            { x: 0, y: layerBot }
          ],
          type: 'line',
          fill: true,
          backgroundColor: theme.bandFill,
          borderWidth: 0,
          pointRadius: 0,
          showLine: false
        },
        {
          label: 'E_oed,i (CPT)',
          data: scatterDep,
          backgroundColor: theme.blueSoft,
          pointRadius: 2.5,
          pointHoverRadius: 5
        },
        {
          label: `HS default m=${mDefault}`,
          data: defDep,
          type: 'line',
          borderColor: theme.purple,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.3
        },
        {
          label: `HS preview m=${mPreview}`,
          data: fitDep,
          type: 'line',
          borderColor: invalidSlope ? theme.red : theme.green,
          borderWidth: 2.5,
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          borderDash: quality === 'warn' || invalidSlope ? [5, 4] : []
        },
        {
          label: 'WT',
          data: wtLine,
          type: 'line',
          borderColor: theme.blue,
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'top',
          data: topLine,
          type: 'line',
          borderColor: theme.gridStrong,
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'bot',
          data: botLine,
          type: 'line',
          borderColor: theme.gridStrong,
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              if (ctx.dataset.label === 'WT') return `WT = ${wt.toFixed(2)} m`;
              return `${ctx.dataset.label}: ${Math.round(ctx.parsed.x).toLocaleString()} kPa @ ${ctx.parsed.y.toFixed(2)}m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: xMax,
          position: 'top',
          title: chartTitle('E_oed (kPa)'),
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 }, maxTicksLimit: 5 }
        },
        y: {
          type: 'linear',
          min: yMin,
          max: yMax,
          reverse: true,
          title: chartTitle('Diepte (m)'),
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildBearingChartConfig({ data, cfg, capacityAxisTitle, showLegend = false }) {
  const theme = getChartTheme();
  const drained = data.drained;
  const undrained = data.undrained;
  const xMax =
    Math.max(50, Math.ceil(Math.max(...drained.map((p) => p.x || 0), ...undrained.map((p) => p.x || 0)) / 50) * 50);
  const datasets = [];
  if (cfg.showMode !== 'undrained') {
    datasets.push({
      label: 'Drained',
      data: drained,
      borderColor: theme.green,
      borderWidth: 2.4,
      pointRadius: 0,
      fill: false,
      tension: 0.15
    });
  }
  if (cfg.showMode !== 'drained') {
    datasets.push({
      label: 'Undrained',
      data: undrained,
      borderColor: theme.orange,
      borderWidth: 2.4,
      pointRadius: 0,
      fill: false,
      tension: 0.15
    });
  }
  datasets.push({
    label: 'Selected Df',
    data: [
      { x: 0, y: cfg.Df },
      { x: xMax, y: cfg.Df }
    ],
    borderColor: theme.blue,
    borderWidth: 1.5,
    borderDash: [6, 4],
    pointRadius: 0,
    fill: false
  });
  return applyChartTheme({
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: showLegend,
          position: 'bottom',
          align: 'start',
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            padding: 8,
            font: { size: 10 }
          }
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              if (ctx.dataset.label === 'Selected Df') return `Df = ${cfg.Df.toFixed(2)} m`;
              return `${ctx.dataset.label}: ${Math.round(ctx.parsed.x).toLocaleString()} kPa @ ${ctx.parsed.y.toFixed(2)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: xMax,
          position: 'top',
          title: chartTitle(capacityAxisTitle),
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          min: 0,
          max: data.maxDepth + 0.25,
          reverse: true,
          title: chartTitle('Founding depth (m)'),
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildSettlementStressChartConfig({ analysis, maxDepth, showLegend = false }) {
  const theme = getChartTheme();
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Delta sigma_v',
          data: analysis.deltaStressCurve,
          borderColor: theme.green,
          borderWidth: 2.2,
          pointRadius: 0,
          tension: 0.15,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: showLegend,
          position: 'bottom',
          align: 'start',
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            padding: 8,
            font: { size: 10 }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'top',
          title: chartTitle('Delta sigma_v (kPa)'),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: 0,
          max: maxDepth + 0.25,
          title: chartTitle('Depth (m)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildSettlementCumulativeChartConfig({ analysis }) {
  const theme = getChartTheme();
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Cumulative S',
          data: analysis.cumulativeCurve,
          borderColor: theme.blue,
          borderWidth: 2.2,
          pointRadius: 0,
          tension: 0.12,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          type: 'linear',
          position: 'top',
          title: chartTitle('Cumulative settlement (mm)'),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: 0,
          max: analysis.truncationDepth + 0.25,
          title: chartTitle('Depth (m)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildTimeChartConfig({ curve, xTitle = 'Time (days)', yTitle = 'Settlement (mm)' }) {
  const theme = getChartTheme();
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'S(t)',
          data: curve,
          borderColor: theme.orange,
          borderWidth: 2.2,
          pointRadius: 0,
          fill: false,
          tension: 0.15
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          type: 'linear',
          title: chartTitle(xTitle),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          title: chartTitle(yTitle),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildDewateringDrawdownChartConfig({ analysis, originalWt }) {
  const theme = getChartTheme();
  const profile = analysis.drawdownDisplayCurve?.length ? analysis.drawdownDisplayCurve : analysis.drawdownCurve;
  const influenceX = Math.max(analysis.radiusInfluence || 0, analysis.geometry.distanceToCpt || 0, 1);
  const maxX = influenceX * 1.1;
  const minRelevantY = Math.min(
    originalWt,
    analysis.targetWt,
    analysis.newWtAtCpt,
    ...profile.map((p) => p.y ?? originalWt)
  );
  const maxRelevantY = Math.max(
    originalWt,
    analysis.targetWt,
    analysis.newWtAtCpt,
    ...profile.map((p) => p.y ?? originalWt)
  );
  const yPad = Math.max((maxRelevantY - minRelevantY) * 0.1, 0.15);
  const minY = Math.max(0, minRelevantY - yPad);
  const maxY = maxRelevantY + yPad;
  const originalLine = [
    { x: 0, y: originalWt },
    { x: maxX, y: originalWt }
  ];
  const influenceLine =
    analysis.radiusInfluence > 0
      ? [
          { x: analysis.radiusInfluence, y: 0 },
          { x: analysis.radiusInfluence, y: maxY }
        ]
      : [];

  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Original WT',
          data: originalLine,
          borderColor: theme.neutral,
          borderWidth: 1.3,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'WT profile',
          data: profile,
          borderColor: theme.blue,
          backgroundColor: theme.blueSoft,
          borderWidth: 2.4,
          pointRadius: 0,
          tension: 0,
          fill: '-1'
        },
        {
          label: 'Influence radius',
          data: influenceLine,
          borderColor: theme.green,
          borderWidth: 1.2,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'CPT location',
          data: [
            { x: analysis.geometry.distanceToCpt || 0, y: 0 },
            { x: analysis.geometry.distanceToCpt || 0, y: maxY }
          ],
          borderColor: theme.orange,
          borderWidth: 1.4,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Target head at source',
          data: [{ x: 0, y: analysis.targetWt }],
          borderColor: theme.green,
          pointRadius: 4,
          pointHoverRadius: 4,
          showLine: false
        },
        {
          label: 'WT at CPT',
          data: [{ x: analysis.geometry.distanceToCpt || 0, y: analysis.newWtAtCpt }],
          borderColor: theme.orange,
          pointRadius: 4,
          pointHoverRadius: 4,
          showLine: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter(ctx) {
            return (
              ctx.dataset.label === 'WT profile' ||
              ctx.dataset.label === 'WT at CPT' ||
              ctx.dataset.label === 'Target head at source'
            );
          },
          callbacks: {
            label(ctx) {
              if (ctx.dataset.label === 'WT at CPT') {
                return `WT at CPT: ${ctx.parsed.y.toFixed(2)} m @ ${ctx.parsed.x.toFixed(2)} m`;
              }
              if (ctx.dataset.label === 'Target head at source') {
                return `Installed target head: ${ctx.parsed.y.toFixed(2)} m @ source`;
              }
              return `WT depth: ${ctx.parsed.y.toFixed(2)} m @ ${ctx.parsed.x.toFixed(2)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: maxX,
          title: chartTitle(
            analysis.geometry.geometry === 'line_dewatering_trench'
              ? 'Perpendicular distance from trench (m)'
              : 'Distance from source / centroid (m)'
          ),
          grid: { color: 'rgba(128,128,128,0.07)' },
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: minY,
          max: maxY,
          title: chartTitle('Phreatic level depth below ground (m)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildDewateringStressChartConfig({ analysis, maxDepth, showLegend = false }) {
  const theme = getChartTheme();
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'sigma_v before',
          data: analysis.beforeTotalStressCurve,
          borderColor: theme.neutral,
          borderWidth: 1.2,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'sigma_v after',
          data: analysis.afterTotalStressCurve,
          borderColor: theme.green,
          borderWidth: 1.2,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'sigma_eff before',
          data: analysis.beforeStressCurve,
          borderColor: theme.neutral,
          borderWidth: 2,
          pointRadius: 0,
          fill: false
        },
        {
          label: 'sigma_eff after',
          data: analysis.afterStressCurve,
          borderColor: theme.green,
          borderWidth: 2,
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Delta sigma',
          data: analysis.deltaStressCurve,
          borderColor: theme.orange,
          borderWidth: 1.6,
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: showLegend,
          position: 'bottom',
          align: 'start',
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            padding: 8,
            font: { size: 10 }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'top',
          title: chartTitle('Total stress, effective stress, and increase (kPa)'),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: 0,
          max: maxDepth + 0.25,
          title: chartTitle('Depth (m)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildDewateringSettlementChartConfig({ analysis }) {
  const theme = getChartTheme();
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Total settlement',
          data: analysis.settlementDistanceCurve,
          borderColor: theme.blue,
          borderWidth: 2.2,
          pointRadius: 0,
          fill: false,
          tension: 0.12
        },
        {
          label: 'CPT location',
          data: [
            { x: analysis.geometry.distanceToCpt || 0, y: 0 },
            { x: analysis.geometry.distanceToCpt || 0, y: analysis.totalSettlementMm }
          ],
          borderColor: theme.orange,
          borderWidth: 1.4,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Settlement at CPT',
          data: [{ x: analysis.geometry.distanceToCpt || 0, y: analysis.totalSettlementMm }],
          borderColor: theme.orange,
          pointRadius: 4,
          pointHoverRadius: 4,
          showLine: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter(ctx) {
            return ctx.dataset.label === 'Total settlement' || ctx.dataset.label === 'Settlement at CPT';
          },
          callbacks: {
            label(ctx) {
              if (ctx.dataset.label === 'Settlement at CPT') {
                return `Settlement at CPT: ${ctx.parsed.y.toFixed(2)} mm @ ${ctx.parsed.x.toFixed(2)} m`;
              }
              return `Settlement: ${ctx.parsed.y.toFixed(2)} mm @ ${ctx.parsed.x.toFixed(2)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: chartTitle(
            analysis.geometry.geometry === 'line_dewatering_trench'
              ? 'Perpendicular distance from trench (m)'
              : 'Radial distance from well centre / excavation centroid (m)'
          ),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          beginAtZero: true,
          title: chartTitle('Total settlement (mm)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

export function buildBeamDeflectionChartConfig({ analysis, tickFormatter }) {
  const theme = getChartTheme();
  const deflectionData = analysis.sls.xSamples.map((x, i) => ({ x, y: analysis.sls.wSamples[i] * 1000 }));
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'w(x)',
          data: deflectionData,
          borderColor: theme.blue,
          borderWidth: 2.2,
          pointRadius: 0,
          fill: false,
          tension: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `w = ${tickFormatter(ctx.parsed.y, 2)} mm @ x = ${tickFormatter(ctx.parsed.x, 2)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: chartTitle('x along beam (m)'),
          ticks: { font: { size: 10 }, callback: tickFormatter }
        },
        y: {
          title: chartTitle('Deflection (mm)'),
          ticks: { font: { size: 10 }, callback: tickFormatter }
        }
      }
    }
  });
}

export function buildBeamMomentChartConfig({ analysis, tickFormatter }) {
  const theme = getChartTheme();
  const momentData = analysis.uls.xSamples.map((x, i) => ({ x, y: analysis.uls.mSamples[i] }));
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'M(x)',
          data: momentData,
          borderColor: theme.orange,
          borderWidth: 2.2,
          pointRadius: 0,
          fill: false,
          tension: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `M = ${tickFormatter(ctx.parsed.y, 2)} kNm/m @ x = ${tickFormatter(ctx.parsed.x, 2)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: chartTitle('x along beam (m)'),
          ticks: { font: { size: 10 }, callback: tickFormatter }
        },
        y: {
          title: chartTitle('Moment (kNm/m)'),
          ticks: { font: { size: 10 }, callback: tickFormatter }
        }
      }
    }
  });
}

export function buildLineProbeChartConfig({
  points,
  title = '',
  seriesLabel = 'Line probe',
  color = null,
  xAxisTitle = 'Distance along line s (m)',
  yAxisTitle = 'Value',
  xTickFormatter = (value) => value,
  yTickFormatter = (value) => value,
  tooltipLabel = null
}) {
  const theme = getChartTheme();
  const seriesColor = color || theme.blue;
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: seriesLabel,
          data: points,
          borderColor: seriesColor,
          backgroundColor: seriesColor,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          pointHitRadius: 12,
          fill: false,
          spanGaps: false,
          tension: 0.08
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        title: chartTitle(title),
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              if (typeof tooltipLabel === 'function') {
                return tooltipLabel(ctx.parsed?.y, ctx.parsed?.x, ctx);
              }
              return `${seriesLabel}: ${ctx.parsed?.y}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: chartTitle(xAxisTitle),
          ticks: { font: { size: 10 }, callback: xTickFormatter }
        },
        y: {
          title: chartTitle(yAxisTitle),
          ticks: { font: { size: 10 }, callback: yTickFormatter }
        }
      }
    }
  });
}

// =====================================================================
// Stage 6 — Pile Estimator chart factories
// =====================================================================

// De Beer transformation chain — q_c, q_h, q_d, q_u, q_p overlay vs depth.
export function buildPileDeBeerChartConfig({ deBeer, maxDepth, zToe }) {
  const series = (arr, color, label, dash) => ({
    label,
    data: (arr || []).map((p) => ({ x: p.q, y: p.z })),
    borderColor: color,
    borderDash: dash || [],
    borderWidth: 1.6,
    pointRadius: 0,
    fill: false,
    tension: 0
  });
  const datasets = [
    series(deBeer?.qc, 'rgba(120,120,120,0.85)', 'q_c (cone)'),
    series(deBeer?.qh, 'rgba(70,70,70,0.85)', 'q_h (homogeneous)', [3, 3]),
    series(deBeer?.qd, 'rgba(216,90,48,0.95)', 'q_d (downward)'),
    series(deBeer?.qu, 'rgba(40,90,180,0.95)', 'q_u (upward)'),
    series(deBeer?.qp, 'rgba(29,158,117,1.00)', 'q_p (mixed)')
  ];
  const allQ = (deBeer?.qp || []).map((p) => p.q);
  const xMax = Math.max(2, ...allQ) * 1.1;
  if (Number.isFinite(zToe)) {
    datasets.push({
      label: 'Pile toe',
      data: [{ x: 0, y: zToe }, { x: xMax, y: zToe }],
      borderColor: 'rgba(220,120,40,0.9)',
      borderWidth: 1.4,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false
    });
  }
  return applyChartTheme({
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          align: 'start',
          labels: { boxWidth: 10, boxHeight: 10, padding: 6, font: { size: 9 } }
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label}: ${ctx.parsed.x.toFixed(2)} MPa @ ${ctx.parsed.y.toFixed(2)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'top',
          min: 0,
          max: xMax,
          title: chartTitle('q (MPa)'),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: 0,
          max: (maxDepth || 1) + 0.25,
          title: chartTitle('Depth (m)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

// Per-layer shaft friction — point per layer at its mid-depth.
export function buildPileShaftChartConfig({ perLayer, maxDepth }) {
  const points = [];
  const colours = [];
  const labels = [];
  for (const row of (perLayer || [])) {
    const yMid = (row.top + row.bot) / 2;
    points.push({ x: row.qs, y: yMid });
    if (row.excluded) colours.push('rgba(160,160,160,0.6)');
    else if (row.aboveNeutral) colours.push('rgba(200,80,40,0.85)');
    else colours.push('rgba(60,170,90,0.95)');
    labels.push(`Layer ${row.layerIndex + 1} (${row.category})`);
  }
  const xMax = Math.max(50, ...points.map((p) => p.x));
  return applyChartTheme({
    type: 'scatter',
    data: {
      datasets: [{
        label: 'q_s per layer',
        data: points,
        backgroundColor: colours,
        borderColor: colours,
        pointRadius: 6,
        pointHoverRadius: 7,
        showLine: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const i = ctx.dataIndex;
              const row = (perLayer || [])[i];
              const tag = row?.excluded ? ' · excluded'
                : row?.aboveNeutral ? ' · above neutral plane' : '';
              return `${labels[i]}: q_s = ${ctx.parsed.x.toFixed(0)} kPa @ z=${ctx.parsed.y.toFixed(2)} m${tag}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'top',
          min: 0,
          max: xMax * 1.1,
          title: chartTitle('q_s (kPa)'),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: 0,
          max: (maxDepth || 1) + 0.25,
          title: chartTitle('Depth (m)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

// Load–settlement curve — F (kN) vs s_head (mm), settlement increasing down.
export function buildPileLoadSettlementChartConfig({ curve, Frep, Rcd, sAllowable }) {
  const data = (curve || []).map((p) => ({ x: p.F, y: p.s }));
  const Fmax = Math.max(1, ...data.map((d) => d.x), Rcd || 0, Frep || 0) * 1.1;
  const sMax = Math.max(10, ...data.map((d) => d.y), sAllowable || 0) * 1.1;
  const datasets = [
    {
      label: 'Load–settlement',
      data,
      borderColor: 'rgba(40,90,180,0.95)',
      backgroundColor: 'rgba(40,90,180,0.10)',
      borderWidth: 2,
      pointRadius: 0,
      fill: 'origin',
      tension: 0
    }
  ];
  if (Number.isFinite(Frep) && Frep > 0) {
    datasets.push({
      label: 'F_rep',
      data: [{ x: Frep, y: 0 }, { x: Frep, y: sMax }],
      borderColor: 'rgba(216,90,48,0.85)',
      borderDash: [4, 3],
      borderWidth: 1.4,
      pointRadius: 0,
      fill: false
    });
  }
  if (Number.isFinite(Rcd) && Rcd > 0) {
    datasets.push({
      label: 'R_c,d',
      data: [{ x: Rcd, y: 0 }, { x: Rcd, y: sMax }],
      borderColor: 'rgba(29,158,117,0.85)',
      borderDash: [6, 4],
      borderWidth: 1.4,
      pointRadius: 0,
      fill: false
    });
  }
  if (Number.isFinite(sAllowable) && sAllowable > 0) {
    datasets.push({
      label: 's_allow',
      data: [{ x: 0, y: sAllowable }, { x: Fmax, y: sAllowable }],
      borderColor: 'rgba(220,120,40,0.7)',
      borderDash: [3, 3],
      borderWidth: 1.2,
      pointRadius: 0,
      fill: false
    });
  }
  return applyChartTheme({
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          align: 'start',
          labels: { boxWidth: 10, boxHeight: 10, padding: 6, font: { size: 9 } }
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              if (ctx.dataset.label === 'Load–settlement') {
                return `${ctx.parsed.x.toFixed(0)} kN · ${ctx.parsed.y.toFixed(2)} mm`;
              }
              return ctx.dataset.label;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: Fmax,
          title: chartTitle('Load F (kN)'),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: 0,
          max: sMax,
          title: chartTitle('Pile-head settlement s (mm)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

// Axial-force distribution — N(z) along the pile.
export function buildPileAxialForceChartConfig({ trace, zHead, zToe, Frep }) {
  const data = (trace || []).map((p) => ({ x: p.N, y: p.z }));
  const xMax = Math.max(1, ...data.map((d) => d.x), Frep || 0) * 1.1;
  const datasets = [{
    label: 'N(z)',
    data,
    borderColor: 'rgba(40,90,180,0.95)',
    backgroundColor: 'rgba(40,90,180,0.10)',
    borderWidth: 2,
    pointRadius: 0,
    fill: 'origin',
    tension: 0
  }];
  return applyChartTheme({
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `N = ${ctx.parsed.x.toFixed(0)} kN @ z = ${ctx.parsed.y.toFixed(2)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'top',
          min: 0,
          max: xMax,
          title: chartTitle('Axial force N (kN)'),
          ticks: { font: { size: 10 } }
        },
        y: {
          type: 'linear',
          reverse: true,
          min: Math.min(0, zHead || 0) - 0.1,
          max: (zToe || 1) + 0.5,
          title: chartTitle('Depth (m)'),
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}
