// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
function chartTitle(text) {
  return text ? { display: true, text, font: { size: 10 } } : { display: false };
}

function getChartTheme() {
  const prefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  const fallback = {
    text: prefersDark ? '#ede9e1' : '#18181a',
    textMuted: prefersDark ? '#d3cec5' : '#4a4a52',
    border: prefersDark ? 'rgba(237,233,225,0.28)' : 'rgba(24,24,26,0.18)',
    grid: prefersDark ? 'rgba(237,233,225,0.14)' : 'rgba(24,24,26,0.08)',
    gridStrong: prefersDark ? 'rgba(237,233,225,0.24)' : 'rgba(24,24,26,0.14)',
    bandFill: prefersDark ? 'rgba(237,233,225,0.08)' : 'rgba(24,24,26,0.05)',
    tooltipBg: prefersDark ? 'rgba(21,22,21,0.96)' : 'rgba(255,255,255,0.96)'
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
    bandFill: fallback.bandFill,
    tooltipBg: fallback.tooltipBg
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
          borderColor: '#378ADD',
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
  return applyChartTheme({
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'CPT data',
          data: scatter,
          backgroundColor: 'rgba(53,162,235,0.55)',
          pointRadius: 3,
          pointHoverRadius: 5
        },
        {
          label: `Default m=${mDefault}`,
          data: defaultLine,
          type: 'line',
          borderColor: '#534AB7',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false
        },
        {
          label: `Preview m=${mPreview}`,
          data: previewLine,
          type: 'line',
          borderColor: invalidSlope ? '#A32D2D' : '#1D9E75',
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
          backgroundColor: 'rgba(53,162,235,0.5)',
          pointRadius: 2.5,
          pointHoverRadius: 5
        },
        {
          label: `HS default m=${mDefault}`,
          data: defDep,
          type: 'line',
          borderColor: '#534AB7',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.3
        },
        {
          label: `HS preview m=${mPreview}`,
          data: fitDep,
          type: 'line',
          borderColor: invalidSlope ? '#A32D2D' : '#1D9E75',
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
          borderColor: '#378ADD',
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
  const drained = data.drained;
  const undrained = data.undrained;
  const xMax =
    Math.max(50, Math.ceil(Math.max(...drained.map((p) => p.x || 0), ...undrained.map((p) => p.x || 0)) / 50) * 50);
  const datasets = [];
  if (cfg.showMode !== 'undrained') {
    datasets.push({
      label: 'Drained',
      data: drained,
      borderColor: '#1D9E75',
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
      borderColor: '#D85A30',
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
    borderColor: '#378ADD',
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
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Delta sigma_v',
          data: analysis.deltaStressCurve,
          borderColor: '#1D9E75',
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
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Cumulative S',
          data: analysis.cumulativeCurve,
          borderColor: '#378ADD',
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
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'S(t)',
          data: curve,
          borderColor: '#D85A30',
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
          borderColor: 'rgba(107,107,104,.50)',
          borderWidth: 1.3,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'WT profile',
          data: profile,
          borderColor: '#378ADD',
          backgroundColor: 'rgba(55,138,221,.12)',
          borderWidth: 2.4,
          pointRadius: 0,
          tension: 0,
          fill: '-1'
        },
        {
          label: 'Influence radius',
          data: influenceLine,
          borderColor: 'rgba(29,158,117,.45)',
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
          borderColor: 'rgba(216,90,48,.55)',
          borderWidth: 1.4,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Target head at source',
          data: [{ x: 0, y: analysis.targetWt }],
          borderColor: '#1D9E75',
          pointRadius: 4,
          pointHoverRadius: 4,
          showLine: false
        },
        {
          label: 'WT at CPT',
          data: [{ x: analysis.geometry.distanceToCpt || 0, y: analysis.newWtAtCpt }],
          borderColor: '#D85A30',
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
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'sigma_v before',
          data: analysis.beforeTotalStressCurve,
          borderColor: 'rgba(107,107,104,.60)',
          borderWidth: 1.2,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'sigma_v after',
          data: analysis.afterTotalStressCurve,
          borderColor: 'rgba(29,158,117,.55)',
          borderWidth: 1.2,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'sigma_eff before',
          data: analysis.beforeStressCurve,
          borderColor: '#6b6b68',
          borderWidth: 2,
          pointRadius: 0,
          fill: false
        },
        {
          label: 'sigma_eff after',
          data: analysis.afterStressCurve,
          borderColor: '#1D9E75',
          borderWidth: 2,
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Delta sigma',
          data: analysis.deltaStressCurve,
          borderColor: '#D85A30',
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
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Total settlement',
          data: analysis.settlementDistanceCurve,
          borderColor: '#378ADD',
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
          borderColor: 'rgba(216,90,48,.55)',
          borderWidth: 1.4,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Settlement at CPT',
          data: [{ x: analysis.geometry.distanceToCpt || 0, y: analysis.totalSettlementMm }],
          borderColor: '#D85A30',
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
  const deflectionData = analysis.sls.xSamples.map((x, i) => ({ x, y: analysis.sls.wSamples[i] * 1000 }));
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'w(x)',
          data: deflectionData,
          borderColor: '#378ADD',
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
  const momentData = analysis.uls.xSamples.map((x, i) => ({ x, y: analysis.uls.mSamples[i] }));
  return applyChartTheme({
    type: 'line',
    data: {
      datasets: [
        {
          label: 'M(x)',
          data: momentData,
          borderColor: '#D85A30',
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
