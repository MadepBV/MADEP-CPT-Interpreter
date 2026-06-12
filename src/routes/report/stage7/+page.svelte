<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<svelte:options runes={false} />

<script lang="ts">
  import '$lib/cpt-app/legacy.css';
  import { onMount, tick } from 'svelte';
  import {
    buildBeamDeflectionChartConfig,
    buildBeamMomentChartConfig,
    buildBearingChartConfig,
    buildDewateringDrawdownChartConfig,
    buildDewateringSettlementChartConfig,
    buildDewateringStressChartConfig,
    buildSettlementCumulativeChartConfig,
    buildSettlementStressChartConfig,
    buildTimeChartConfig,
    buildTuningDepthChartConfig,
    buildTuningRegressionChartConfig
  } from '$lib/cpt-app/chart-factories';
  import { loadStage7Payload, stage7PayloadFilename } from '$lib/cpt-app/report-storage';
  import { SOIL_FILL_COLORS } from '$lib/cpt-app/soil-styles';

  let payload: any = null;
  let loadError = '';
  let chartReady = false;
  let includePrintAppendices = true;
  let hoveredProfileLayerIndex: number | null = null;
  let profileSvgEl: SVGSVGElement | null = null;
  let profileTooltipEl: HTMLDivElement | null = null;
  let chartRefs: any[] = [];
  const soilFillColors = SOIL_FILL_COLORS as Record<string, string>;
  type LegacyMediaQueryList = MediaQueryList & {
    addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  };

  const levelLabels: Record<string, string> = {
    bad: 'Incompatible',
    adj: 'Transition'
  };

  function fmt(value: unknown, digits = 2) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return num.toFixed(digits).replace(/\.?0+$/, '');
  }

  function fmtInt(value: unknown) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return Math.round(num).toLocaleString('nl-BE');
  }

  function fmtDateTime(value: string) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return date.toLocaleString('nl-BE', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  }

  function compactNumber(value: unknown, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs < 1e-2 || abs >= 1e4) {
      return n.toExponential(Math.max(0, digits - 1)).replace('e', 'E');
    }
    if (abs >= 100) return n.toFixed(1).replace(/\.0$/, '');
    if (abs >= 10) return n.toFixed(2).replace(/\.?0+$/, '');
    if (abs >= 1) return n.toFixed(3).replace(/\.?0+$/, '');
    return n.toFixed(4).replace(/\.?0+$/, '');
  }

  function secondsLabelFromMs(value: unknown, digits = 3) {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return '—';
    return `${compactNumber(ms / 1000, digits)} s`;
  }

  function missingReportMessage(key: string) {
    return key
      ? 'No Stage 7 payload was found for this report key in this browser. Open a saved data file or launch a fresh report from the CPT app.'
      : 'No Stage 7 payload key was provided. Open a saved data file or launch a fresh report from the CPT app.';
  }

  function downloadPayloadFile() {
    if (!payload) return;
    const raw = JSON.stringify(payload, null, 2);
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = stage7PayloadFilename(payload);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function hasStage6(name: string) {
    return !!payload?.stage6?.[name];
  }

  function soilChipStyle(type: string) {
    return `background:${soilFillColors[type] || '#D3D1C7'};color:#2c2c2a;`;
  }

  function soilColor(type: string) {
    return soilFillColors[type] || '#D3D1C7';
  }

  function profileLayerName(layer: any) {
    return layer?.subtype || layer?.type || 'Layer';
  }

  function syncProfileLayerHighlight() {
    if (!profileSvgEl) return;
    const activeIndex = hoveredProfileLayerIndex;
    const fills = Array.from(profileSvgEl.querySelectorAll('[data-layer-fill]')) as SVGElement[];
    const hits = Array.from(profileSvgEl.querySelectorAll('[data-layer-preview]')) as SVGElement[];

    for (const fill of fills) {
      const isActive =
        activeIndex != null && Number(fill.getAttribute('data-layer-index') || '') === Number(activeIndex);
      fill.setAttribute('fill-opacity', isActive ? '1' : '0.85');
      fill.setAttribute('stroke', isActive ? 'rgba(36,88,107,0.95)' : 'rgba(0,0,0,0.15)');
      fill.setAttribute('stroke-width', isActive ? '1.2' : '0.5');
    }

    for (const hit of hits) {
      const isActive =
        activeIndex != null && Number(hit.getAttribute('data-layer-index') || '') === Number(activeIndex);
      hit.setAttribute('fill', isActive ? 'rgba(61,107,106,0.12)' : 'transparent');
      hit.setAttribute('stroke', isActive ? 'rgba(61,107,106,0.55)' : 'none');
      hit.setAttribute('stroke-width', isActive ? '0.8' : '0');
    }
  }

  function setHoveredProfileLayer(layerIndex: number | null) {
    hoveredProfileLayerIndex = layerIndex;
    syncProfileLayerHighlight();
  }

  function handleProfileLegendEnter(layerIndex: number) {
    setHoveredProfileLayer(layerIndex);
  }

  function handleProfileLegendLeave() {
    if (profileTooltipEl?.style.display === 'block') return;
    setHoveredProfileLayer(null);
  }

  function hideProfileTooltip() {
    setHoveredProfileLayer(null);
    if (profileTooltipEl) profileTooltipEl.style.display = 'none';
  }

  function showProfileTooltip(target: Element, event: MouseEvent) {
    if (!profileTooltipEl || !profileSvgEl) return;
    setHoveredProfileLayer(Number(target.getAttribute('data-layer-index') || '') || null);
    const data = (target as HTMLElement).dataset;
    profileTooltipEl.innerHTML = `<strong>${data.type || ''}</strong>
      <div class="mut">${data.subtype || '—'}</div>
      <div class="row"><span>Depth</span><span>${data.top}–${data.bot} m</span></div>
      <div class="row"><span>Thickness</span><span>${data.thk} m</span></div>
      <div class="row"><span>Original points</span><span>${data.points || '—'}</span></div>
      <div class="row"><span>qc original</span><span>${data.qcmin}–${data.qcmax} MPa</span></div>
      <div class="row"><span>qc layer avg</span><span>${data.qcavg} MPa</span></div>
      <div class="row"><span>Rf original</span><span>${data.rfmin}–${data.rfmax} %</span></div>
      <div class="row"><span>Rf layer avg</span><span>${data.rfavg} %</span></div>
      <div class="row"><span>fs original</span><span>${data.fsmin}–${data.fsmax} kPa</span></div>
      <div class="row"><span>fs layer avg</span><span>${data.fsavg} kPa</span></div>`;
    profileTooltipEl.style.display = 'block';

    const wrap = profileSvgEl.parentElement;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const pad = 12;
    const tipW = 250;
    const tipH = 210;
    let left = event.clientX - rect.left + 14;
    let top = event.clientY - rect.top + 14;
    if (left + tipW > rect.width - pad) left = Math.max(pad, event.clientX - rect.left - tipW - 14);
    if (top + tipH > rect.height - pad) top = Math.max(pad, event.clientY - rect.top - tipH - 14);
    profileTooltipEl.style.left = `${left}px`;
    profileTooltipEl.style.top = `${top}px`;
  }

  function handleProfileSvgMove(event: MouseEvent) {
    const target = (event.target as Element | null)?.closest?.('[data-layer-preview]') as Element | null;
    if (!target) {
      hideProfileTooltip();
      return;
    }
    showProfileTooltip(target, event);
  }

  $: if (profileSvgEl) {
    syncProfileLayerHighlight();
  }

  function methodMetricLabel() {
    return payload?.replication?.method === 'robertson'
      ? 'Ic (-)'
      : payload?.replication?.method === 'robertson2016'
        ? 'Qtn (-)'
      : payload?.replication?.method === 'nen6740'
        ? 'qc,NEN (MPa)'
        : 'Metric (-)';
  }

  function methodMetricValue(row: any) {
    if (payload?.replication?.method === 'robertson') return row.ic != null ? fmt(row.ic, 2) : '—';
    if (payload?.replication?.method === 'robertson2016')
      return row.qtOrQcNen != null ? fmt(row.qtOrQcNen, 1) : '—';
    if (payload?.replication?.method === 'nen6740') return row.qtOrQcNen != null ? fmt(row.qtOrQcNen, 2) : '—';
    return '—';
  }

  function bearingAxisTitle(cfg: any) {
    return (cfg?.factorMode || 'ec7') === 'ec7'
      ? 'Design bearing capacity q_d (kPa)'
      : 'Allowable bearing capacity q_allow (kPa)';
  }

  function bearingShapeModeNote(selected: any) {
    if (!selected) return '';
    if (selected.shapeMode === 'conservative') {
      return 'Shape factors follow conservative mode and are fixed at 1.0.';
    }
    return 'Shape factors follow the effective-dimension ratio r = B′/L′.';
  }

  function seepageFreeSurfaceLabel(value: string) {
    return value === 'iterate' ? 'Iterative free surface' : 'Fixed phreatic line';
  }

  function seepageTerminationLabel(reason: string | null | undefined) {
    if (reason === 'time-limit') return 'Stopped at runtime limit';
    if (reason === 'interrupted') return 'Interrupted by user';
    if (reason === 'fixed-boundary') return 'Solved with fixed phreatic boundary';
    if (reason === 'flow-error') return 'Converged on flow-rate error target';
    return '—';
  }

  function tuningPreviewEoedRef(fit: any, previewM: number) {
    return Math.exp(fit.meanY - previewM * fit.meanX);
  }

  function tuningLogLine(fit: any, previewM: number, eOedRef: number) {
    const xMin = Math.min(...fit.xs) - 0.1;
    const xMax = Math.max(...fit.xs) + 0.1;
    const linePts = 30;
    return Array.from({ length: linePts }, (_, index) => {
      const x = xMin + ((xMax - xMin) * index) / (linePts - 1);
      return { x, y: Math.log(eOedRef) + previewM * x };
    });
  }

  function tuningHsPreview(fit: any, previewM: number, eOedRef: number) {
    return fit.depthPts.map((_depth: number, index: number) => eOedRef * Math.exp(previewM * fit.xs[index]));
  }

  function destroyCharts() {
    chartRefs.forEach((chart) => chart?.destroy?.());
    chartRefs = [];
  }

  function syncPrintChartImages() {
    const canvases = Array.from(document.querySelectorAll('.report-canvas canvas')) as HTMLCanvasElement[];
    for (const canvas of canvases) {
      if (!canvas.width || !canvas.height) continue;
      const host = canvas.parentElement;
      if (!host) continue;
      let image = host.querySelector('.report-print-chart') as HTMLImageElement | null;
      if (!image) {
        image = document.createElement('img');
        image.className = 'report-print-chart';
        image.alt = '';
        host.appendChild(image);
      }
      image.src = canvas.toDataURL('image/png');
    }
  }

  function resizeChartsForLayout() {
    if (!chartRefs.length) return;
    const resize = () => {
      chartRefs.forEach((chart) => {
        chart?.resize?.();
        chart?.update?.('none');
      });
      syncPrintChartImages();
    };
    window.requestAnimationFrame(resize);
    window.setTimeout(resize, 80);
  }

  function clearSmartPrintBreaks() {
    document
      .querySelectorAll('.report-section--print-break-before')
      .forEach((section) => section.classList.remove('report-section--print-break-before'));
  }

  function applySmartPrintBreaks() {
    clearSmartPrintBreaks();

    const report = document.querySelector('.report') as HTMLElement | null;
    if (!report) return;

    const mmToPx = 96 / 25.4;
    // A4 height minus @page margins (14 + 16 mm) and the repeating running header row (~10 mm).
    const printablePageHeight = (297 - 40) * mmToPx;
    const minBodyBelowHeading = 28 * mmToPx;
    const reportTop = report.getBoundingClientRect().top + window.scrollY;
    const sections = Array.from(report.querySelectorAll('.report-section')) as HTMLElement[];

    for (const section of sections) {
      const head = section.querySelector(':scope > .report-section__head') as HTMLElement | null;
      const firstContent = head?.nextElementSibling as HTMLElement | null;
      if (!head || !firstContent) continue;

      const firstTable = firstContent.querySelector('table') as HTMLTableElement | null;
      const firstTableHead = firstTable?.querySelector('thead') as HTMLElement | null;
      const firstTableRow = firstTable?.querySelector('tbody tr') as HTMLElement | null;
      let minBodyBelowHeading = 28 * mmToPx;

      if (firstTable) {
        const tableLeadHeight =
          (firstTableHead?.getBoundingClientRect().height || 0) +
          (firstTableRow?.getBoundingClientRect().height || 0) * 2 +
          16;
        minBodyBelowHeading = Math.max(minBodyBelowHeading, tableLeadHeight);
      }

      if (section.classList.contains('report-section--layer-model')) {
        minBodyBelowHeading = Math.max(minBodyBelowHeading, 52 * mmToPx);
      }

      if (section.classList.contains('report-section--cpt-profile')) {
        minBodyBelowHeading = Math.max(minBodyBelowHeading, 40 * mmToPx);
      }

      const headTop = head.getBoundingClientRect().top + window.scrollY - reportTop;
      const offsetWithinPage = ((headTop % printablePageHeight) + printablePageHeight) % printablePageHeight;
      const remainingOnPage = printablePageHeight - offsetWithinPage;
      const requiredSpace =
        head.getBoundingClientRect().height + Math.min(firstContent.getBoundingClientRect().height, minBodyBelowHeading);

      if (offsetWithinPage > 1 && remainingOnPage < requiredSpace) {
        section.classList.add('report-section--print-break-before');
      }
    }
  }

  function syncSmartPrintLayout(printMedia?: LegacyMediaQueryList | null) {
    resizeChartsForLayout();
    const update = () => {
      if (printMedia?.matches) {
        applySmartPrintBreaks();
      } else {
        clearSmartPrintBreaks();
      }
    };
    window.requestAnimationFrame(update);
    window.setTimeout(update, 140);
  }

  function mountChart(id: string, config: any) {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (!canvas || !(window as any).Chart) return;
    config.options = {
      ...config.options,
      animation: false,
      transitions: {
        ...(config.options?.transitions || {}),
        active: { animation: { duration: 0 } },
        resize: { animation: { duration: 0 } }
      }
    };
    const chart = new (window as any).Chart(canvas, config);
    chart.update?.('none');
    chartRefs.push(chart);
  }

  async function waitForChart() {
    for (let index = 0; index < 80; index += 1) {
      if ((window as any).Chart) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  function renderCharts() {
    if (!payload || !chartReady) return;
    destroyCharts();

    for (const item of payload.tuning || []) {
      if (!item.fit) continue;
      const previewM =
        Number.isFinite(Number(item.previewM)) && Number(item.previewM) > 0 ? Number(item.previewM) : item.fit.mFit;
      const previewRef = tuningPreviewEoedRef(item.fit, previewM);
      const defaultLine = tuningLogLine(item.fit, item.fit.mDefault, item.fit.eOedRefDefault);
      const previewLine = tuningLogLine(item.fit, previewM, previewRef);
      const hsPreview = tuningHsPreview(item.fit, previewM, previewRef);
      mountChart(
        `stage7-tuning-reg-${item.index}`,
        buildTuningRegressionChartConfig({
          scatter: item.fit.xs.map((x: number, index: number) => ({ x, y: item.fit.ys[index] })),
          defaultLine,
          previewLine,
          mDefault: fmt(item.fit.mDefault, 2),
          mPreview: fmt(previewM, 2),
          quality: item.fit.quality
        })
      );
      mountChart(
        `stage7-tuning-depth-${item.index}`,
        buildTuningDepthChartConfig({
          depths: item.fit.depthPts,
          eoedI: item.fit.eOedIPts,
          hsDefault: item.fit.hsDefaultPts,
          hsPreview,
          layerTop: item.top,
          layerBot: item.bot,
          wt: payload.replication.waterTable,
          mDefault: fmt(item.fit.mDefault, 2),
          mPreview: fmt(previewM, 2),
          quality: item.fit.quality
        })
      );
    }

    if (hasStage6('bearing')) {
      mountChart(
        'stage7-bearing-chart',
        buildBearingChartConfig({
          data: payload.stage6.bearing.analysis,
          cfg: payload.stage6.bearing.config,
          capacityAxisTitle: bearingAxisTitle(payload.stage6.bearing.config),
          showLegend: true
        })
      );
    }

    if (hasStage6('settlement')) {
      mountChart(
        'stage7-settlement-stress',
        buildSettlementStressChartConfig({
          analysis: payload.stage6.settlement.analysis,
          maxDepth: payload.summary.depthMax,
          showLegend: true
        })
      );
      mountChart(
        'stage7-settlement-cumulative',
        buildSettlementCumulativeChartConfig({
          analysis: payload.stage6.settlement.analysis
        })
      );
      if (payload.stage6.settlement.analysis.timeCurve) {
        mountChart(
          'stage7-settlement-time',
          buildTimeChartConfig({
            curve: payload.stage6.settlement.analysis.timeCurve
          })
        );
      }
    }

    if (hasStage6('dewatering')) {
      mountChart(
        'stage7-dewatering-drawdown',
        buildDewateringDrawdownChartConfig({
          analysis: payload.stage6.dewatering.analysis,
          originalWt: payload.replication.waterTable
        })
      );
      mountChart(
        'stage7-dewatering-stress',
        buildDewateringStressChartConfig({
          analysis: payload.stage6.dewatering.analysis,
          maxDepth: payload.summary.depthMax,
          showLegend: true
        })
      );
      mountChart(
        'stage7-dewatering-settlement',
        buildDewateringSettlementChartConfig({
          analysis: payload.stage6.dewatering.analysis
        })
      );
      if (payload.stage6.dewatering.analysis.timeCurve) {
        mountChart(
          'stage7-dewatering-time',
          buildTimeChartConfig({
            curve: payload.stage6.dewatering.analysis.timeCurve
          })
        );
      }
    }

    if (hasStage6('beam')) {
      mountChart(
        'stage7-beam-deflection',
        buildBeamDeflectionChartConfig({
          analysis: payload.stage6.beam.analysis,
          tickFormatter: compactNumber
        })
      );
      mountChart(
        'stage7-beam-moment',
        buildBeamMomentChartConfig({
          analysis: payload.stage6.beam.analysis,
          tickFormatter: compactNumber
        })
      );
    }

    window.requestAnimationFrame(() => {
      syncPrintChartImages();
      window.setTimeout(syncPrintChartImages, 120);
    });
  }

  $: if (payload && chartReady) {
    tick().then(renderCharts);
  }

  onMount(() => {
    const printMedia = window.matchMedia ? (window.matchMedia('print') as LegacyMediaQueryList) : null;
    const legacyPrintMedia = printMedia as LegacyMediaQueryList | null;
    const handlePrintLayout = () => syncSmartPrintLayout(legacyPrintMedia);

    window.addEventListener('beforeprint', handlePrintLayout);
    window.addEventListener('afterprint', handlePrintLayout);

    if (legacyPrintMedia) {
      if (typeof legacyPrintMedia.addEventListener === 'function') {
        legacyPrintMedia.addEventListener('change', handlePrintLayout);
      } else if (typeof legacyPrintMedia.addListener === 'function') {
        legacyPrintMedia.addListener(handlePrintLayout);
      }
    }

    void (async () => {
      const key = new URLSearchParams(window.location.search).get('key') || '';
      if (!key) {
        loadError = missingReportMessage('');
        return;
      }
      payload = loadStage7Payload(window.localStorage, key);
      if (!payload) {
        loadError = missingReportMessage(key);
        return;
      }
      chartReady = await waitForChart();
      if (!chartReady) loadError = 'Chart.js did not load in time, so the report charts could not be rendered.';
    })();
    return () => {
      window.removeEventListener('beforeprint', handlePrintLayout);
      window.removeEventListener('afterprint', handlePrintLayout);
      if (legacyPrintMedia) {
        if (typeof legacyPrintMedia.removeEventListener === 'function') {
          legacyPrintMedia.removeEventListener('change', handlePrintLayout);
        } else if (typeof legacyPrintMedia.removeListener === 'function') {
          legacyPrintMedia.removeListener(handlePrintLayout);
        }
      }
      destroyCharts();
    };
  });
</script>

<svelte:head>
  <title>{payload ? `Stage 7 Report - ${payload.cpt.displayId}` : 'Stage 7 Report'}</title>
  <meta
    name="description"
    content="Printable Stage 7 CPT report for the selected MADEP CPT interpretation."
  />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
</svelte:head>

{#if loadError}
  <div class="report-shell">
    <div class="report-error">
      <h1>Stage 7 report unavailable</h1>
      <p>{loadError}</p>
      <div class="report-error__actions">
        <a class="btn" href="/report">Open saved data</a>
        <a class="btn pri" href="/">Back to CPT app</a>
      </div>
    </div>
  </div>
{:else if !payload}
  <div class="report-shell">
    <div class="report-error">
      <h1>Loading Stage 7 report…</h1>
    </div>
  </div>
{:else}
  <div class="report-shell">
    <div class="report-toolbar no-print">
      <a class="btn sm" href="/">CPT app</a>
      <a class="btn sm" href="/report">Open saved data</a>
      <button class="btn sm" type="button" onclick={downloadPayloadFile}>Download data file</button>
      <label class="report-toolbar__toggle" for="include-print-appendices">
        <input id="include-print-appendices" type="checkbox" bind:checked={includePrintAppendices} />
        <span>Include Appendix A and B in print</span>
      </label>
      <button class="btn pri" type="button" onclick={() => window.print()}>Print / Save as PDF</button>
    </div>

    <table class="report-sheet">
      <thead class="report-running-head">
        <tr>
          <td>
            <div class="report-running-head__inner">
              <span>{payload.project.name} — {payload.cpt.displayId}</span>
              <span>Stage 7 report</span>
            </div>
          </td>
        </tr>
      </thead>
      <tfoot class="report-running-foot">
        <tr>
          <td>
            <div class="report-running-foot__inner">
              <span>CPT Interpreter {payload.appVersion}</span>
              <span>{fmtDateTime(payload.generatedAt)}</span>
            </div>
          </td>
        </tr>
      </tfoot>
      <tbody>
        <tr>
          <td>
    <article class:report--concise-print={!includePrintAppendices} class="report">
      <section class="report-cover">
        <div class="report-cover__topline">
          <div class="report-cover__brand">CPT Interpreter</div>
          <div class="report-cover__eyebrow">Stage 7 report</div>
        </div>
        <h1>{payload.cpt.displayId}</h1>
        <p>
          Single-CPT engineering report with raw CPT data, interpretation settings, final layering,
          characteristic values, model parameters, accepted tuning, and optional Stage 6 annexes.
        </p>
        <div class="report-cover__meta">
          <div><span>Project</span><strong>{payload.project.name}</strong></div>
          <div><span>Phase</span><strong>{payload.project.phase || '—'}</strong></div>
          <div><span>CPT</span><strong>{payload.cpt.displayId}</strong></div>
          <div><span>Generated</span><strong>{fmtDateTime(payload.generatedAt)}</strong></div>
          <div><span>App version</span><strong>{payload.appVersion}</strong></div>
        </div>
      </section>

      <section class="report-section report-section--profile">
        <div class="report-section__head">
          <h2>Document Control</h2>
          <p>Frozen report record for the selected CPT interpretation.</p>
        </div>
        <div class="report-grid report-grid--2">
          <div class="report-card">
            <h3>Source</h3>
            <table class="pt report-pt">
              <tbody>
                <tr><td>Project</td><td>{payload.metadata.project || payload.project.name || '—'}</td></tr>
                <tr><td>Test ID</td><td>{payload.metadata.testid || payload.cpt.displayId}</td></tr>
                <tr><td>Location</td><td>{payload.metadata.location || '—'}</td></tr>
                <tr><td>Owner</td><td>{payload.metadata.owner || '—'}</td></tr>
                <tr><td>Start date</td><td>{payload.metadata.date || '—'}</td></tr>
                <tr><td>Source file</td><td>{payload.metadata.sourceFile || '—'}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="report-card">
            <h3>Replication Summary</h3>
            <table class="pt report-pt">
              <tbody>
                <tr><td>Classification</td><td>{payload.replication.methodLabel}</td></tr>
                <tr><td>Smart merge</td><td>{payload.replication.smartMerge ? 'On' : 'Off'}</td></tr>
                <tr><td>Sensitivity (-)</td><td>{fmt(payload.replication.smartMergeSensitivity, 3)}</td></tr>
                <tr><td>Minimum thickness (m)</td><td>{fmt(payload.replication.minThickness, 3)}</td></tr>
                <tr><td>Parameter method</td><td>{payload.replication.parameterMethodLabel}</td></tr>
                <tr><td>Alpha method</td><td>{payload.replication.alphaMethodLabel}</td></tr>
                <tr><td>Stiffness method</td><td>{payload.replication.stiffnessMethodLabel}</td></tr>
                <tr><td>Accepted tuning (layers)</td><td>{payload.summary.acceptedTuningCount}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="report-section">
        <div class="report-section__head">
          <h2>Executive Summary</h2>
          <p>Core interpretation outcomes for the selected CPT.</p>
        </div>
        <div class="report-grid report-grid--4">
          <div class="report-stat"><span>Layers</span><strong>{payload.summary.layerCount}</strong></div>
          <div class="report-stat"><span>Depth</span><strong>{fmt(payload.summary.depthMax, 2)} m</strong></div>
          <div class="report-stat"><span>Water table</span><strong>{fmt(payload.replication.waterTable, 2)} m bgl</strong></div>
          <div class="report-stat"><span>Stage 6 annexes</span><strong>{payload.summary.stage6Annexes.length}</strong></div>
        </div>
        <div class="report-grid report-grid--2">
          <div class="report-card">
            <h3>Coordinates and levels</h3>
            <table class="pt report-pt">
              <tbody>
                <tr><td>X (m)</td><td>{payload.cpt.coordinates.x != null ? fmt(payload.cpt.coordinates.x, 2) : '—'}</td></tr>
                <tr><td>Y (m)</td><td>{payload.cpt.coordinates.y != null ? fmt(payload.cpt.coordinates.y, 2) : '—'}</td></tr>
                <tr><td>Surface level (m TAW)</td><td>{payload.replication.surfaceElevation != null ? `${fmt(payload.replication.surfaceElevation, 2)} m TAW` : '—'}</td></tr>
                <tr><td>Surface source</td><td>{payload.replication.surfaceElevationSource}</td></tr>
                <tr><td>Water table (m bgl)</td><td>{fmt(payload.replication.waterTable, 2)} m bgl</td></tr>
                <tr><td>WT source</td><td>{payload.replication.waterTableSource}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="report-card">
            <h3>Interpretation status</h3>
            <table class="pt report-pt">
              <tbody>
                <tr><td>Rows (-)</td><td>{fmtInt(payload.metadata.nRows)}</td></tr>
                <tr><td>Has u2</td><td>{payload.metadata.hasU2 ? 'Yes' : 'No'}</td></tr>
                <tr><td>Area ratio a (-)</td><td>{payload.metadata.aRatio != null ? fmt(payload.metadata.aRatio, 3) : '—'}</td></tr>
                <tr><td>Accepted tuning (layers)</td><td>{payload.summary.acceptedTuningCount}</td></tr>
                <tr><td>Manual overrides (-)</td><td>{payload.summary.manualOverrideCount}</td></tr>
                <tr><td>Optional annexes</td><td>{payload.summary.stage6Annexes.length ? payload.summary.stage6Annexes.join(', ') : 'None'}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="report-section report-section--cpt-profile">
        <div class="report-section__head">
          <h2>CPT Profile And Layering</h2>
          <p>Profile rendered from the original CPT data with qc, fs, the water table, and the frozen final layering.</p>
        </div>
        <div class="report-card report-profile">
          <div class="report-profile__visual">
            {#if payload.visuals?.layerProfile}
              <svg
                bind:this={profileSvgEl}
                viewBox={`0 0 ${payload.visuals.layerProfile.width} ${payload.visuals.layerProfile.height}`}
                role="img"
                aria-label="qc profile with final layering"
                onmousemove={handleProfileSvgMove}
                onmouseleave={hideProfileTooltip}
              >
                {@html payload.visuals.layerProfile.markup}
              </svg>
            {:else}
              <p class="report-muted">Profile preview unavailable in this payload.</p>
            {/if}
          </div>
          <div class="report-profile__legend">
            <h3>Layer legend</h3>
            <table class="tbl report-table report-profile__table">
              <colgroup>
                <col class="report-profile__col-index" />
                <col class="report-profile__col-name" />
                <col class="report-profile__col-qc" />
                <col class="report-profile__col-fs" />
              </colgroup>
              <thead>
                <tr>
                  <th>#</th>
                  <th class="txt">EC7 soil</th>
                  <th>avg qc (MPa)</th>
                  <th>avg fs (kPa)</th>
                </tr>
              </thead>
              <tbody>
                {#each payload.layers as layer}
                  <tr
                    class:report-profile__legend-row--hover={hoveredProfileLayerIndex === layer.index}
                    onmouseenter={() => handleProfileLegendEnter(layer.index)}
                    onmouseleave={handleProfileLegendLeave}
                  >
                    <td>{layer.index}</td>
                    <td class="report-profile__type report-profile__name">
                      <span class="report-profile__swatch" style={`background:${soilColor(layer.type)};`}></span>
                      <span>{profileLayerName(layer)}</span>
                    </td>
                    <td>{fmt(layer.avgQc, 2)}</td>
                    <td>{layer.avgFsKPa != null ? fmt(layer.avgFsKPa, 0) : '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="section-tip report-profile__tooltip no-print" bind:this={profileTooltipEl}></div>
        </div>
      </section>

      <section class="report-section report-section--layer-model">
        <div class="report-section__block report-section__block--keep">
          <div class="report-section__head">
            <h2>Final Layer Model</h2>
            <p>Characteristic values and interpretation output for the selected CPT only.</p>
          </div>
          <div class="report-card">
            <table class="tbl report-table report-table--layers">
              <colgroup>
                <col class="report-table__col-index" />
                <col class="report-table__col-depth" />
                <col class="report-table__col-depth" />
                <col class="report-table__col-depth" />
                <col class="report-table__col-depth" />
                <col class="report-table__col-thk" />
                <col class="report-table__col-type" />
                <col class="report-table__col-subtype" />
                <col class="report-table__col-avgwide" />
                <col class="report-table__col-avgwide" />
                <col class="report-table__col-avgnarrow" />
                <col class="report-table__col-param" />
                <col class="report-table__col-param" />
                <col class="report-table__col-smallparam" />
                <col class="report-table__col-smallparam" />
                <col class="report-table__col-smallparam" />
              </colgroup>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Top (m bgl)</th>
                  <th>Bot (m bgl)</th>
                  <th>Top (m TAW)</th>
                  <th>Bot (m TAW)</th>
                  <th>Thk. (m)</th>
                  <th class="txt">Type</th>
                  <th class="txt">Subtype</th>
                  <th>avg qc<span class="report-table__unit">(MPa)</span></th>
                  <th>avg fs<span class="report-table__unit">(kPa)</span></th>
                  <th>avg Rf (%)</th>
                  <th>gamma<span class="report-table__unit">(kN/m³)</span></th>
                  <th>gamma_sat<span class="report-table__unit">(kN/m³)</span></th>
                  <th>phi'<span class="report-table__unit">(°)</span></th>
                  <th>c'<span class="report-table__unit">(kPa)</span></th>
                  <th>cu<span class="report-table__unit">(kPa)</span></th>
                </tr>
              </thead>
              <tbody>
                {#each payload.layers as layer}
                  <tr>
                    <td>{layer.index}</td>
                    <td>{fmt(layer.top, 2)}</td>
                    <td>{fmt(layer.bot, 2)}</td>
                    <td>{layer.topTaw != null ? fmt(layer.topTaw, 2) : '—'}</td>
                    <td>{layer.botTaw != null ? fmt(layer.botTaw, 2) : '—'}</td>
                    <td>{fmt(layer.thickness, 2)}</td>
                    <td class="txt"><span class="report-chip" style={soilChipStyle(layer.type)}>{layer.type}</span></td>
                    <td class="txt">{layer.subtype || '—'}</td>
                    <td>{fmt(layer.avgQc, 3)}</td>
                    <td>{layer.avgFsKPa != null ? fmt(layer.avgFsKPa, 1) : '—'}</td>
                    <td>{layer.avgRf != null ? fmt(layer.avgRf, 2) : '—'}</td>
                    <td>{fmt(layer.gamma, 1)}</td>
                    <td>{fmt(layer.gammaSat, 1)}</td>
                    <td>{fmt(layer.phi, 1)}</td>
                    <td>{fmt(layer.c, 1)}</td>
                    <td>{fmt(layer.cu, 1)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
        {#if payload.layerWarnings.length}
          <div class="report-grid report-grid--2">
            {#each payload.layerWarnings as warning}
              <div class="info">
                <strong>Layer {warning.layer} - {levelLabels[warning.level] || warning.level}</strong><br />
                {warning.message}
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <section class="report-section">
        <div class="report-section__head">
          <h2>Model Parameters</h2>
          <p>Hardening Soil and hydraulic parameters carried into engineering work.</p>
        </div>
        <div class="report-card">
          <table class="tbl report-table report-table--model-params">
            <thead>
              <tr>
                <th>#</th>
                <th>&alpha;<sub>E</sub> (-)</th>
                <th>E<sub>oed,i</sub> (kPa)</th>
                <th>E<sub>oed,ref</sub> (kPa)</th>
                <th>E<sub>50,ref</sub> (kPa)</th>
                <th>E<sub>ur,ref</sub> (kPa)</th>
                <th>m (-)</th>
                <th>K<sub>0,nc</sub> (-)</th>
                <th>&nu;<sub>ur</sub> (-)</th>
                <th>k<sub>h</sub> (m/s)</th>
                <th>k<sub>v</sub> (m/s)</th>
                <th>k<sub>h</sub>/k<sub>v</sub> (-)</th>
                <th>&psi;<sub>unsat</sub> (m)</th>
                <th class="txt">Infiltration</th>
                <th class="txt">Overrides</th>
              </tr>
            </thead>
            <tbody>
              {#each payload.layers as layer}
                <tr>
                  <td>{layer.index}</td>
                  <td>{fmt(layer.hs.alphaE, 2)}</td>
                  <td>{fmtInt(layer.hs.eOedI)}</td>
                  <td>{fmtInt(layer.hs.eOedRef)}</td>
                  <td>{fmtInt(layer.hs.e50Ref)}</td>
                  <td>{fmtInt(layer.hs.eurRef)}</td>
                  <td>{fmt(layer.hs.m, 3)}</td>
                  <td>{fmt(layer.hs.k0nc, 3)}</td>
                  <td>{fmt(layer.hs.nuUr, 2)}</td>
                  <td>{compactNumber(layer.hydraulic.kh)}</td>
                  <td>{compactNumber(layer.hydraulic.kv)}</td>
                  <td>{fmt(layer.hydraulic.khkv, 1)}</td>
                  <td>{fmt(layer.hydraulic.psiUnsat, 2)}</td>
                  <td class="txt">{layer.hydraulic.infiltrationClass}</td>
                  <td class="txt">
                    {#if Object.values(layer.overrides || {}).some(Boolean)}
                      {Object.entries(layer.overrides)
                        .filter(([, active]) => active)
                        .map(([name]) => name)
                        .join(', ')}
                    {:else}
                      —
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section class="report-section">
        <div class="report-section__head">
          <h2>Stage 5 Tuning</h2>
          <p>Per-layer regression output and accepted m updates, if tuning was run.</p>
        </div>
        {#if !payload.tuning}
          <div class="info">Stage 5 tuning was not run for this report. Default layer m-values remain active unless manually overridden.</div>
        {:else}
          <div class="report-grid report-grid--2">
            {#each payload.tuning as item}
              <div class="report-card report-tuning">
                <div class="report-tuning__head">
                  <div>
                    <span class="report-chip" style={soilChipStyle(item.type)}>{item.type}</span>
                    <strong>{item.layerLabel}</strong>
                    <span class="report-muted">{fmt(item.top, 2)} - {fmt(item.bot, 2)} m</span>
                  </div>
                  <div class="report-muted">{item.accepted ? 'Accepted' : 'Preview only'}</div>
                </div>
                {#if item.fit}
                  <div class="report-grid report-grid--2">
                    <div>
                      <div class="report-canvas report-canvas--tuning">
                        <canvas id={`stage7-tuning-depth-${item.index}`}></canvas>
                      </div>
                    </div>
                    <div>
                      <div class="report-canvas report-canvas--tuning">
                        <canvas id={`stage7-tuning-reg-${item.index}`}></canvas>
                      </div>
                    </div>
                  </div>
                  <table class="pt report-pt report-pt--tight">
                    <tbody>
                      <tr><td>Auto-fit m (-)</td><td>{fmt(item.fit.mFit, 3)}</td></tr>
                      <tr><td>Preview / accepted m (-)</td><td>{item.previewM != null ? fmt(item.previewM, 3) : '—'}</td></tr>
                      <tr><td>Auto-fit Eoed,ref (kPa)</td><td>{fmtInt(item.fit.eOedRefFit)} kPa</td></tr>
                      <tr><td>Default m (-)</td><td>{fmt(item.fit.mDefault, 3)}</td></tr>
                      <tr><td>R² (-)</td><td>{fmt(item.fit.r2, 3)}</td></tr>
                      <tr><td>n (-)</td><td>{item.fit.n}</td></tr>
                      <tr><td>Stress range factor (-)</td><td>x{fmt(item.fit.stressRangeFactor, 2)}</td></tr>
                      <tr><td>Status</td><td>{item.fit.message}</td></tr>
                    </tbody>
                  </table>
                {:else}
                  <div class="info">Insufficient data were available for a tuning regression in this layer.</div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>

      {#if payload.stage6}
        <section class="report-section report-section--stage6">
          <div class="report-section__head">
            <h2>Stage 6 Annexes</h2>
            <p>Optional engineering annexes included only for analyses available in the frozen payload.</p>
          </div>

          {#if hasStage6('bearing')}
            <div class="report-card report-annex report-annex--bearing">
              <h3>Bearing capacity</h3>
              <div class="report-grid report-grid--2 report-annex__summary">
                <table class="pt report-pt">
                  <tbody>
                    <tr><td>Df (m)</td><td>{fmt(payload.stage6.bearing.config.Df, 2)} m</td></tr>
                    <tr><td>Foundation type</td><td>{payload.stage6.bearing.config.foundationType}</td></tr>
                    <tr><td>B / L (m)</td><td>{fmt(payload.stage6.bearing.config.B, 2)} / {fmt(payload.stage6.bearing.config.L, 2)} m</td></tr>
                    <tr><td>eB / eL (m)</td><td>{fmt(payload.stage6.bearing.analysis.selected.eB ?? 0, 2)} / {fmt(payload.stage6.bearing.analysis.selected.eL ?? 0, 2)} m</td></tr>
                    <tr><td>B′ / L′ (m)</td><td>{fmt(payload.stage6.bearing.analysis.selected.BEff ?? payload.stage6.bearing.config.B, 2)} / {fmt(payload.stage6.bearing.analysis.selected.LEff ?? payload.stage6.bearing.config.L, 2)} m</td></tr>
                    <tr><td>Shape factors</td><td>{payload.stage6.bearing.analysis.selected.shapeModeLabel || 'Brinch Hansen / Annex D'}</td></tr>
                    <tr><td>Nγ formulation</td><td>{payload.stage6.bearing.analysis.selected.ngammaFormulaLabel || 'EC7 Annex D rough base'}</td></tr>
                    <tr><td>Load q (kPa)</td><td>{fmt(payload.stage6.bearing.config.load, 0)} kPa</td></tr>
                    <tr><td>Selected layer</td><td>{payload.stage6.bearing.analysis.selected.layer.type}</td></tr>
                    <tr><td>Drained qd (kPa)</td><td>{fmtInt(payload.stage6.bearing.analysis.selected.qdDrained)} kPa</td></tr>
                    <tr><td>Undrained qd (kPa)</td><td>{fmtInt(payload.stage6.bearing.analysis.selected.qdUndrained)} kPa</td></tr>
                  </tbody>
                </table>
                <div>
                  <div class="report-canvas report-canvas--annex report-canvas--annex-bearing"><canvas id="stage7-bearing-chart"></canvas></div>
                  <p class="report-note" style="margin-top:10px">
                    This bearing annex uses the EC7 Annex D rough-base
                    <code>Nγ = 2(Nq − 1)tanφ′</code> formulation. Shape factors follow
                    {payload.stage6.bearing.analysis.selected.shapeModeLabel || 'Brinch Hansen / Annex D'}
                    . {bearingShapeModeNote(payload.stage6.bearing.analysis.selected)}
                  </p>
                </div>
              </div>
            </div>
          {/if}

          {#if hasStage6('settlement')}
            <div class="report-card report-annex report-annex--settlement">
              <h3>Settlement</h3>
              <div class="report-grid report-grid--3 report-annex__stats">
                <div class="report-stat"><span>Total settlement</span><strong>{fmt(payload.stage6.settlement.analysis.totalSettlementMm, 2)} mm</strong></div>
                <div class="report-stat"><span>q gross</span><strong>{fmt(payload.stage6.settlement.analysis.qGross, 1)} kPa</strong></div>
                <div class="report-stat"><span>q net</span><strong>{fmt(payload.stage6.settlement.analysis.qNet, 1)} kPa</strong></div>
              </div>
              <div class="report-grid report-grid--2 report-annex__charts">
                <div class="report-canvas report-canvas--annex"><canvas id="stage7-settlement-stress"></canvas></div>
                <div class="report-canvas report-canvas--annex"><canvas id="stage7-settlement-cumulative"></canvas></div>
              </div>
              {#if payload.stage6.settlement.analysis.timeCurve}
                <div class="report-canvas report-canvas--annex report-canvas--annex-time report-canvas--single"><canvas id="stage7-settlement-time"></canvas></div>
              {/if}
            </div>
          {/if}

          {#if hasStage6('dewatering')}
            <div class="report-card report-annex report-annex--dewatering">
              <h3>Dewatering</h3>
              <div class="report-grid report-grid--4 report-annex__stats">
                <div class="report-stat"><span>Target WT</span><strong>{fmt(payload.stage6.dewatering.analysis.targetWt, 2)} m</strong></div>
                <div class="report-stat"><span>WT at CPT</span><strong>{fmt(payload.stage6.dewatering.analysis.newWtAtCpt, 2)} m</strong></div>
                <div class="report-stat"><span>Drawdown at CPT</span><strong>{fmt(payload.stage6.dewatering.analysis.drawdownAtCpt, 2)} m</strong></div>
                <div class="report-stat"><span>Total settlement</span><strong>{fmt(payload.stage6.dewatering.analysis.totalSettlementMm, 2)} mm</strong></div>
              </div>
              <div class="report-grid report-grid--2 report-annex__charts">
                <div class="report-canvas report-canvas--annex"><canvas id="stage7-dewatering-drawdown"></canvas></div>
                <div class="report-canvas report-canvas--annex"><canvas id="stage7-dewatering-stress"></canvas></div>
                <div class="report-canvas report-canvas--annex"><canvas id="stage7-dewatering-settlement"></canvas></div>
                {#if payload.stage6.dewatering.analysis.timeCurve}
                  <div class="report-canvas report-canvas--annex report-canvas--annex-time"><canvas id="stage7-dewatering-time"></canvas></div>
                {/if}
              </div>
            </div>
          {/if}

          {#if hasStage6('beam')}
            <div class="report-card report-annex report-annex--beam">
              <h3>Beam / slab strip</h3>
              <div class="report-grid report-grid--4 report-annex__stats">
                <div class="report-stat"><span>k_s</span><strong>{fmt(payload.stage6.beam.analysis.ksInfo.ks, 0)} kN/m³</strong></div>
                <div class="report-stat"><span>G_p</span><strong>{fmt(payload.stage6.beam.analysis.ksInfo.gp, 0)} kN/m</strong></div>
                <div class="report-stat"><span>Max deflection</span><strong>{fmt(Math.abs(payload.stage6.beam.analysis.sls.maxDeflection.value) * 1000, 2)} mm</strong></div>
                <div class="report-stat"><span>Max moment</span><strong>{fmt(Math.abs(payload.stage6.beam.analysis.uls.maxMoment.value), 2)} kNm/m</strong></div>
              </div>
              <div class="report-grid report-grid--2 report-annex__charts">
                <div class="report-canvas report-canvas--annex"><canvas id="stage7-beam-deflection"></canvas></div>
                <div class="report-canvas report-canvas--annex"><canvas id="stage7-beam-moment"></canvas></div>
              </div>
            </div>
          {/if}

          {#if hasStage6('bishop')}
            {@const bishop = payload.stage6.bishop || {}}
            {@const bishopView = bishop.view || null}
            {@const bishopCriticalFs = Number(bishop.topResults?.[0]?.FS)}
            {@const bishopVerdict =
              bishop.config.strengthSet === 'da1_2' && Number.isFinite(bishopCriticalFs)
                ? bishopCriticalFs >= 1.0
                  ? 'pass'
                  : 'fail'
                : null}
            <div class="report-card report-annex report-annex--bishop">
              <h3>Bishop / Spencer slope check</h3>
              <div class="report-grid report-grid--4">
                <div class={`report-stat${bishopVerdict ? ` report-stat--${bishopVerdict}` : ''}`}><span>{bishop.config.strengthSet === 'da1_2' ? 'Critical Λ (EC7 DA1/2 ODF, require ≥ 1.0)' : bishop.config.strengthSet === 'da1_1' ? 'Critical F (M1 strengths)' : 'Critical F (characteristic)'}</span><strong>{bishop.topResults?.[0] ? fmt(bishop.topResults[0].FS, 3) : '—'}</strong></div>
                <div class="report-stat"><span>Mode</span><strong>{bishop.methodMode === 'bishop_spencer' ? 'Bishop + Spencer' : 'Bishop only'}</strong></div>
                <div class="report-stat"><span>Selected result</span><strong>{bishop.selectedIndex + 1}</strong></div>
                <div class="report-stat"><span>Spencer converged</span><strong>{bishop.methodMode === 'bishop_spencer' ? `${bishop.spencerConverged}/${bishop.spencerRechecked}` : 'off'}</strong></div>
                {#if bishop.config.walls?.length}
                  <div class="report-stat"><span>Retaining walls</span><strong>{bishop.config.walls.length}</strong></div>
                  <div class="report-stat"><span>Critical through wall</span><strong>{bishop.wallSummary?.criticalThroughWall ? fmt(bishop.wallSummary.criticalThroughWall.FS, 3) : '—'}</strong></div>
                  <div class="report-stat"><span>Critical below wall</span><strong>{bishop.wallSummary?.criticalBelowWall ? fmt(bishop.wallSummary.criticalBelowWall.FS, 3) : '—'}</strong></div>
                  <div class="report-stat"><span>Wall effective</span><strong>{bishop.wallSummary?.wallEffective == null ? '—' : bishop.wallSummary.wallEffective ? 'Yes' : 'No / inconclusive'}</strong></div>
                {/if}
              </div>
              <div class={`report-annex__split${bishopView?.image?.dataUrl ? '' : ' report-annex__split--single'}`}>
                <div class="report-annex__main">
                  <table class="pt report-pt">
                    <tbody>
                      <tr><td>Strength set</td><td>{bishop.config.strengthSet === 'da1_2' ? 'DA1/2 (M2 design strengths — reported F is the EC7 over-design factor Λ, require ≥ 1.0)' : bishop.config.strengthSet === 'da1_1' ? 'DA1/1 (M1 strengths — action factors not applied; enter design loads)' : 'Characteristic (unfactored strengths)'}</td></tr>
                      <tr><td>Method mode</td><td>{bishop.methodMode === 'bishop_spencer' ? 'Bishop + Spencer check' : 'Bishop only'}</td></tr>
                      <tr><td>Analysis depth (m)</td><td>{fmt(bishop.config.analysisDepth, 2)} m</td></tr>
                      <tr><td>Retaining walls</td><td>{bishop.config.walls?.length ?? 0}</td></tr>
                      <tr><td>Entry zone x-range (m)</td><td>{bishop.config.entryZone ? `${fmt(bishop.config.entryZone.xStart, 2)} - ${fmt(bishop.config.entryZone.xEnd, 2)} m` : '—'}</td></tr>
                      <tr><td>Exit zone x-range (m)</td><td>{bishop.config.exitZone ? `${fmt(bishop.config.exitZone.xStart, 2)} - ${fmt(bishop.config.exitZone.xEnd, 2)} m` : '—'}</td></tr>
                      <tr><td>Selected method</td><td>{bishop.selected?.methodLabel ?? '—'}</td></tr>
                      <tr><td>Selected wall status</td><td>{bishop.selected?.intersectsWall ? `${bishop.selected.wallIntersectionCount} engaged` : bishop.selected?.passesBelowWall ? 'passes below wall' : 'no wall effect'}</td></tr>
                      <tr><td>Selected wall force</td><td>{bishop.selected?.wallForceTotal != null ? `${fmt(bishop.selected.wallForceTotal, 1)} kN/m` : '—'}</td></tr>
                      <tr><td>Selected Bishop F</td><td>{bishop.selected?.F_bishop != null ? fmt(bishop.selected.F_bishop, 3) : '—'}</td></tr>
                      <tr><td>Selected Spencer F</td><td>{bishop.selected?.method === 'spencer' ? fmt(bishop.selected.FS, 3) : '—'}</td></tr>
                      <tr><td>Selected λ</td><td>{bishop.selected?.lambda != null ? fmt(bishop.selected.lambda, 3) : '—'}</td></tr>
                      <tr><td>Selected wall moment term</td><td>{bishop.selected?.wallMomentTerm != null ? fmt(bishop.selected.wallMomentTerm, 3) : '—'}</td></tr>
                      <tr><td>Selected moment residual</td><td>{bishop.selected?.momentResidual != null ? fmt(bishop.selected.momentResidual, 3) : '—'}</td></tr>
                      <tr><td>Selected force residual</td><td>{bishop.selected?.forceResidual != null ? fmt(bishop.selected.forceResidual, 3) : '—'}</td></tr>
                      <tr><td>Runtime (ms)</td><td>{bishop.timing?.totalMs != null ? `${fmt(bishop.timing.totalMs, 0)} ms` : '—'}</td></tr>
                    </tbody>
                  </table>
                </div>
                {#if bishopView?.image?.dataUrl}
                  <div class="report-annex__aside">
                    <div class="report-card report-card--nested report-card--figure">
                      <h4>Critical Surface View</h4>
                      <figure class="report-figure">
                        <img
                          class="report-figure__image"
                          src={bishopView.image.dataUrl}
                          alt="Frozen Bishop stability view from the Stage 6 canvas"
                        />
                        <figcaption class="report-note">
                          Frozen Stage 6 Bishop stability view at report export time.
                        </figcaption>
                      </figure>
                    </div>
                  </div>
                {/if}
              </div>
              <div class="report-card report-card--nested" style="margin-top:16px">
                <h4>Best circles</h4>
                <table class="tbl report-table">
                  <thead>
                    <tr><th>#</th><th>FS (-)</th><th class="txt">Method</th><th class="txt">Wall</th><th>R_wall (kN/m)</th><th>Bishop F (-)</th><th>λ (-)</th><th>M res.</th><th>F res.</th><th>Iterations (-)</th><th>Radius (m)</th></tr>
                  </thead>
                  <tbody>
                    {#each bishop.topResults as result}
                      <tr>
                        <td>{result.rank}</td>
                        <td>{fmt(result.FS, 3)}</td>
                        <td class="txt">{result.methodLabel}</td>
                        <td class="txt">{result.intersectsWall ? `${result.wallIntersectionCount} engaged` : result.passesBelowWall ? 'below wall' : 'none'}</td>
                        <td>{result.wallForceTotal != null ? fmt(result.wallForceTotal, 1) : '—'}</td>
                        <td>{result.F_bishop != null ? fmt(result.F_bishop, 3) : '—'}</td>
                        <td>{result.lambda != null ? fmt(result.lambda, 3) : '—'}</td>
                        <td>{result.momentResidual != null ? fmt(result.momentResidual, 3) : '—'}</td>
                        <td>{result.forceResidual != null ? fmt(result.forceResidual, 3) : '—'}</td>
                        <td>{result.iterations}</td>
                        <td>{result.circle?.radius != null ? `${fmt(result.circle.radius, 2)} m` : '—'}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              {#if bishop.config.walls?.length}
                <div class="report-grid report-grid--2" style="margin-top:16px">
                  <div class="report-card report-card--nested">
                    <h4>Retaining Walls</h4>
                    <table class="tbl report-table">
                      <thead>
                        <tr><th>#</th><th>x (m)</th><th>Top y (m)</th><th>Tip y (m)</th><th>Length (m)</th><th class="txt">Passive side</th></tr>
                      </thead>
                      <tbody>
                        {#each bishop.config.walls as wall, index}
                          <tr>
                            <td>{index + 1}</td>
                            <td>{fmt(wall.x, 2)}</td>
                            <td>{fmt(wall.yTop, 2)}</td>
                            <td>{fmt(wall.yTip, 2)}</td>
                            <td>{fmt(wall.yTop - wall.yTip, 2)}</td>
                            <td class="txt">{wall.passiveSide === 'left' ? 'Left' : 'Right'}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                  <div class="report-card report-card--nested">
                    <h4>Selected Wall Interaction</h4>
                    {#if bishop.selected?.wallForces?.length}
                      <table class="tbl report-table">
                        <thead>
                          <tr><th>#</th><th>x (m)</th><th>y intersect (m)</th><th>R_wall (kN/m)</th><th>y app (m)</th><th class="txt">Passive side</th></tr>
                        </thead>
                        <tbody>
                          {#each bishop.selected.wallForces as force, index}
                            <tr>
                              <td>{index + 1}</td>
                              <td>{fmt(force.x, 2)}</td>
                              <td>{fmt(force.y_intersect, 2)}</td>
                              <td>{fmt(force.R_wall, 1)}</td>
                              <td>{fmt(force.y_application, 2)}</td>
                              <td class="txt">{force.wall?.passiveSide === 'left' ? 'Left' : 'Right'}</td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    {:else}
                      <p class="report-note" style="margin:0">The selected critical surface does not engage a retaining wall directly.</p>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/if}

          {#if hasStage6('seepage')}
            {@const seepage = payload.stage6.seepage || {}}
            {@const seepageSummary = seepage.summary || {}}
            {@const seepageConfig = seepage.config || {}}
            {@const seepageGeometry = seepage.geometry || {}}
            {@const seepageMesh = seepage.mesh || null}
            {@const seepageResult = seepage.result || null}
            {@const seepageBcs = seepage.boundaryConditions || []}
            {@const seepageMaterials = seepage.materials || []}
            {@const seepageDrains = seepage.drains || []}
            {@const seepageWalls = seepage.walls || []}
            {@const seepageView = seepage.view || null}
            <div class="report-card report-annex report-annex--seepage">
              <h3>Seepage / groundwater flow</h3>
              <div class="report-grid report-grid--4">
                <div class="report-stat"><span>Status</span><strong>{seepageSummary.status || 'idle'}</strong></div>
                <div class="report-stat"><span>Free-surface mode</span><strong>{seepageFreeSurfaceLabel(seepageConfig.freeSurface)}</strong></div>
                <div class="report-stat"><span>Head range</span><strong>{seepageResult ? `${fmt(seepageResult.headMin, 2)} to ${fmt(seepageResult.headMax, 2)} m` : '—'}</strong></div>
                <div class="report-stat"><span>Through-flow</span><strong>{seepageResult ? `${compactNumber(seepageResult.throughFlow, 3)} m³/s/m` : '—'}</strong></div>
                <div class="report-stat"><span>Drain inflow</span><strong>{seepageResult ? `${compactNumber(seepageResult.solver?.boundaryFlux?.drainInflow, 3)} m³/s/m` : '—'}</strong></div>
                <div class="report-stat"><span>Flow-rate error</span><strong>{seepageResult?.flowError != null ? `${compactNumber(100 * seepageResult.flowError, 3)} %` : '—'}</strong></div>
                <div class="report-stat"><span>Runtime</span><strong>{secondsLabelFromMs(seepageResult?.timing?.totalMs)}</strong></div>
                <div class="report-stat"><span>Max exit gradient</span><strong>{seepageResult ? fmt(seepageResult.maxExitGradient, 3) : '—'}</strong></div>
                <div class="report-stat"><span>Dry cells</span><strong>{seepageResult?.dryCellCount ?? '—'}</strong></div>
                <div class="report-stat"><span>Triangles</span><strong>{seepageMesh?.elements ?? 0}</strong></div>
                <div class="report-stat"><span>FEM pore pressure in Bishop</span><strong>{seepageConfig.useFemPorePressure ? 'Yes' : 'No'}</strong></div>
              </div>
              <div class={`report-annex__split${seepageView?.image?.dataUrl ? '' : ' report-annex__split--single'}`}>
                <div class="report-annex__main">
                  <table class="pt report-pt">
                    <tbody>
                      <tr><td>Solver</td><td>{seepageResult?.solver?.meshType || 'triangle-cdt-fem'}</td></tr>
                      <tr><td>Free-surface mode</td><td>{seepageFreeSurfaceLabel(seepageConfig.freeSurface)}</td></tr>
                      <tr><td>Use drawn phreatic as seed</td><td>{seepageConfig.usePhreaticAsSeed ? 'Yes' : 'No'}</td></tr>
                      <tr><td>Target element area (m²)</td><td>{fmt(seepageConfig.meshTargetArea, 2)} m²{seepageConfig.meshTargetAreaAuto ? ' (auto)' : ' (manual)'}</td></tr>
                      <tr><td>Flow-rate error target</td><td>{seepageConfig.freeSurface === 'iterate' && seepageConfig.flowErrorTolerance != null ? `${compactNumber(100 * seepageConfig.flowErrorTolerance, 3)} %` : 'n/a'}</td></tr>
                      <tr><td>Max runtime</td><td>{seepageConfig.freeSurface === 'iterate' && seepageConfig.maxRuntimeMs != null ? secondsLabelFromMs(seepageConfig.maxRuntimeMs) : 'n/a'}</td></tr>
                      <tr><td>Region mode</td><td>{seepageGeometry.regionMode === 'custom' ? 'Custom polygons' : 'CPT-derived polygons'}</td></tr>
                      <tr><td>Regions</td><td>{seepageGeometry.regionCount ?? '—'}</td></tr>
                      <tr><td>Retaining walls</td><td>{seepageGeometry.wallCount ?? '—'}</td></tr>
                      <tr><td>Drains</td><td>{seepageGeometry.drainCount ?? '—'}</td></tr>
                      <tr><td>Boundary edges</td><td>{seepageGeometry.boundaryEdgeCount ?? '—'}</td></tr>
                      <tr><td>Explicit BCs</td><td>{seepageSummary.explicitBcCount ?? '—'}</td></tr>
                      <tr><td>Active / orphaned BCs</td><td>{seepageSummary.activeBcCount ?? '—'} / {seepageSummary.orphanedBcCount ?? '—'}</td></tr>
                      <tr><td>Prescribed head / seepage face / no-flow</td><td>{seepageSummary.prescribedHeadCount ?? '—'} / {seepageSummary.seepageFaceCount ?? '—'} / {seepageSummary.noFlowCount ?? '—'}</td></tr>
                      <tr><td>Mesh nodes</td><td>{seepageMesh?.nodes ?? '—'}</td></tr>
                      <tr><td>Mesh triangles</td><td>{seepageMesh?.elements ?? '—'}</td></tr>
                      <tr><td>Rendered triangles</td><td>{seepageMesh?.cells ?? '—'}</td></tr>
                      <tr><td>Boundary faces</td><td>{seepageMesh?.boundaryFaces ?? '—'}</td></tr>
                      <tr><td>Drain edges</td><td>{seepageMesh?.drainEdges ?? '—'}</td></tr>
                      <tr><td>Mesh build time</td><td>{secondsLabelFromMs(seepageMesh?.generatedMs)}</td></tr>
                      <tr><td>Total runtime</td><td>{secondsLabelFromMs(seepageResult?.timing?.totalMs)}</td></tr>
                      <tr><td>Residual norm</td><td>{seepageResult?.solver?.residualNorm != null ? compactNumber(seepageResult.solver.residualNorm, 3) : '—'}</td></tr>
                      <tr><td>Termination</td><td>{seepageTerminationLabel(seepageResult?.solver?.terminationReason)}</td></tr>
                      <tr><td>Converged</td><td>{seepageResult?.solver?.converged != null ? (seepageResult.solver.converged ? 'Yes' : 'No') : '—'}</td></tr>
                      <tr><td>Inflow / outflow</td><td>{seepageResult ? `${compactNumber(seepageResult.inflow, 3)} / ${compactNumber(seepageResult.outflow, 3)} m³/s/m` : '—'}</td></tr>
                      <tr><td>Drain inflow / outflow</td><td>{seepageResult ? `${compactNumber(seepageResult.solver?.boundaryFlux?.drainInflow, 3)} / ${compactNumber(seepageResult.solver?.boundaryFlux?.drainOutflow, 3)} m³/s/m` : '—'}</td></tr>
                      <tr><td>Drain active nodes</td><td>{seepageResult?.solver?.activeSetSummary?.drains ? `${seepageResult.solver.activeSetSummary.drains.activeNodes ?? 0} / ${seepageResult.solver.activeSetSummary.drains.totalNodes ?? 0}` : '—'}</td></tr>
                      <tr><td>Drain edge/reaction check</td><td>{seepageResult?.solver?.activeSetSummary?.drains?.perEdgeReactionDelta != null ? compactNumber(seepageResult.solver.activeSetSummary.drains.perEdgeReactionDelta, 3) : '—'}</td></tr>
                      <tr><td>Flow-rate error</td><td>{seepageResult?.flowError != null ? `${compactNumber(100 * seepageResult.flowError, 3)} %` : '—'}</td></tr>
                      <tr><td>Dry cells</td><td>{seepageResult?.dryCellCount ?? '—'}</td></tr>
                      <tr><td>Equipotential levels</td><td>{seepageResult?.equipotentialLevelCount ?? '—'}</td></tr>
                      <tr><td>Phreatic segments</td><td>{seepageResult?.phreaticSegmentCount ?? '—'}</td></tr>
                    </tbody>
                  </table>
                </div>
                {#if seepageView?.image?.dataUrl}
                  <div class="report-annex__aside">
                    <div class="report-card report-card--nested report-card--figure">
                      <h4>Calculated Flow Field View</h4>
                      <figure class="report-figure">
                        <img
                          class="report-figure__image"
                          src={seepageView.image.dataUrl}
                          alt="Frozen seepage field view from the Stage 6 canvas"
                        />
                        <figcaption class="report-note">
                          Frozen Stage 6 seepage view at report export time.
                        </figcaption>
                      </figure>
                    </div>
                  </div>
                {/if}
              </div>
              {#if seepageSummary.rejectReason}
                <p class="report-note" style="margin-top:12px">
                  Solver message: {seepageSummary.rejectReason}
                </p>
              {/if}
              <div class="report-grid report-grid--2" style="margin-top:16px">
                <div class="report-card report-card--nested">
                  <h4>Boundary Conditions</h4>
                  <table class="tbl report-table">
                    <thead>
                      <tr><th class="txt">Edge</th><th class="txt">Type</th><th>Head (m)</th><th>Length (m)</th><th class="txt">Status</th></tr>
                    </thead>
                    <tbody>
                      {#if seepageBcs.length}
                        {#each seepageBcs as bc}
                          <tr>
                            <td class="txt">{bc.edgeLabel}</td>
                            <td class="txt">{bc.typeLabel}</td>
                            <td>{bc.head != null ? fmt(bc.head, 2) : '—'}</td>
                            <td>{bc.length != null ? fmt(bc.length, 2) : '—'}</td>
                            <td class="txt">{bc.status}</td>
                          </tr>
                        {/each}
                      {:else}
                        <tr><td colspan="5" style="text-align:center">No explicit seepage boundary conditions were frozen into this report.</td></tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
                <div class="report-card report-card--nested">
                  <h4>Permeability Set</h4>
                  <table class="tbl report-table">
                    <thead>
                      <tr><th class="txt">Material</th><th>k_x (m/s)</th><th>k_y (m/s)</th><th class="txt">Source</th></tr>
                    </thead>
                    <tbody>
                      {#if seepageMaterials.length}
                        {#each seepageMaterials as material}
                          <tr>
                            <td class="txt">{material.label}</td>
                            <td>{material.kx != null ? compactNumber(material.kx, 3) : '—'}</td>
                            <td>{material.ky != null ? compactNumber(material.ky, 3) : '—'}</td>
                            <td class="txt">{material.kSourceLabel}</td>
                          </tr>
                        {/each}
                      {:else}
                        <tr>
                          <td colspan="4" style="text-align:center">No seepage permeability set was frozen into this report.</td>
                        </tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
                <div class="report-card report-card--nested">
                  <h4>Drains</h4>
                  <table class="tbl report-table">
                    <thead>
                      <tr><th class="txt">Drain</th><th class="txt">Gating</th><th>Head (m)</th><th>Inflow</th><th>Active nodes</th></tr>
                    </thead>
                    <tbody>
                      {#if seepageDrains.length}
                        {#each seepageDrains as drain}
                          <tr>
                            <td class="txt">{drain.label}</td>
                            <td class="txt">{drain.gatingLabel || drain.gating}</td>
                            <td>{drain.head?.value != null ? fmt(drain.head.value, 2) : '—'}</td>
                            <td>{drain.result ? `${compactNumber(drain.result.totalInflow, 3)} m³/s/m` : '—'}</td>
                            <td>{drain.result ? `${drain.result.activeNodes ?? 0} / ${drain.result.totalNodes ?? 0}` : '—'}</td>
                          </tr>
                        {/each}
                      {:else}
                        <tr><td colspan="5" style="text-align:center">No drains were frozen into this report.</td></tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
                <div class="report-card report-card--nested">
                  <h4>Wall Conductivity</h4>
                  <table class="tbl report-table">
                    <thead>
                      <tr><th class="txt">Wall</th><th>k_across</th><th>k_along</th><th class="txt">Source</th></tr>
                    </thead>
                    <tbody>
                      {#if seepageWalls.length}
                        {#each seepageWalls as wall}
                          <tr>
                            <td class="txt">{wall.label}</td>
                            <td>{wall.material?.kAcross != null ? compactNumber(wall.material.kAcross, 3) : '—'}</td>
                            <td>{wall.material?.kAlong != null ? compactNumber(wall.material.kAlong, 3) : '—'}</td>
                            <td class="txt">{wall.material?.kSourceLabel || wall.material?.kSource || '—'}</td>
                          </tr>
                        {/each}
                      {:else}
                        <tr><td colspan="4" style="text-align:center">No retaining wall conductivity was frozen into this report.</td></tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          {/if}

          {#if hasStage6('pile')}
            {@const pile = payload.stage6.pile || {}}
            {@const pileCfg = pile.config || {}}
            {@const pileAnalysis = pile.analysis || {}}
            {@const pileCap = pileAnalysis.capacity || {}}
            {@const pileSet = pileAnalysis.settlement || null}
            {@const pileXi = pileCap.xi || {}}
            {@const pilePerLayer = pileCap.perLayer || []}
            {@const pileNotes = pileAnalysis.notes || []}
            <div class="report-card report-annex report-annex--pile">
              <h3>Pile capacity (DM20 / De Beer)</h3>
              <div class="report-grid report-grid--4">
                <div class="report-stat"><span>Pile type</span><strong>{pileCfg.pileType || '—'}</strong></div>
                <div class="report-stat"><span>Shape</span><strong>{pileCfg.shape || '—'}</strong></div>
                <div class="report-stat"><span>D<sub>s</sub> / D<sub>b</sub></span><strong>{fmt(pileCfg.Ds, 3)} / {fmt(pileCfg.Db, 3)} m</strong></div>
                <div class="report-stat"><span>z<sub>head</sub> / z<sub>toe</sub></span><strong>{fmt(pileCfg.zHead, 2)} / {fmt(pileCfg.zToe, 2)} m</strong></div>
                <div class="report-stat"><span>F<sub>c,d</sub></span><strong>{fmtInt(pileCfg.Fcd)} kN</strong></div>
                <div class="report-stat"><span>F<sub>rep</sub></span><strong>{fmtInt(pileCfg.Frep)} kN</strong></div>
                <div class="report-stat"><span>R<sub>c,d</sub></span><strong>{fmtInt(pileCap.R_c_d)} kN</strong></div>
                <div class="report-stat"><span>ULS utilisation</span><strong>{pileCap.ulsUtil != null ? fmt(pileCap.ulsUtil, 3) : '—'}</strong></div>
              </div>
              <div class="report-grid report-grid--2">
                <div class="report-card report-card--nested">
                  <h4>Geometry &amp; base</h4>
                  <table class="pt report-pt">
                    <tbody>
                      <tr><td>D<sub>b,eq</sub></td><td>{fmt(pileCap.Dbeq, 3)} m</td></tr>
                      <tr><td>A<sub>b</sub></td><td>{fmt(pileCap.A_b, 4)} m²</td></tr>
                      <tr><td>χ<sub>s</sub></td><td>{fmt(pileCap.chi_s, 3)} m</td></tr>
                      <tr><td>Layer at toe</td><td>{pileCap.categoryAtToe || '—'}</td></tr>
                      <tr><td>q<sub>b</sub> (De Beer)</td><td>{fmtInt(pileCap.qb_kPa)} kPa</td></tr>
                      <tr><td>α<sub>b</sub> · e<sub>b</sub> · β · λ</td><td>{fmt(pileCap.alphaB ?? 0, 2)} · {fmt(pileCap.eb ?? 1, 3)} · {fmt(pileCap.beta ?? 1, 3)} · {fmt(pileCap.lambda ?? 1, 2)}</td></tr>
                      <tr><td>R<sub>b</sub></td><td>{fmtInt(pileCap.R_b)} kN</td></tr>
                    </tbody>
                  </table>
                </div>
                <div class="report-card report-card--nested">
                  <h4>Factor chain</h4>
                  <table class="pt report-pt">
                    <tbody>
                      <tr><td>R<sub>s</sub></td><td>{fmtInt(pileCap.R_s)} kN</td></tr>
                      <tr><td>R<sub>c</sub> = R<sub>b</sub> + R<sub>s</sub></td><td>{fmtInt(pileCap.R_c)} kN</td></tr>
                      <tr><td>γ<sub>Rd</sub></td><td>{fmt(pileCap.gammaRd, 2)}</td></tr>
                      <tr><td>R<sub>c,cal</sub></td><td>{fmtInt(pileCap.R_c_cal)} kN</td></tr>
                      <tr><td>ξ<sub>3</sub> / ξ<sub>4</sub> / max</td><td>{fmt(pileXi.xi3, 2)} / {fmt(pileXi.xi4, 2)} / <strong>{fmt(pileXi.governing, 2)}</strong></td></tr>
                      <tr><td>R<sub>c,k</sub></td><td>{fmtInt(pileCap.R_c_k)} kN</td></tr>
                      <tr><td>γ<sub>b</sub> / γ<sub>s</sub></td><td>{fmt(pileCap.gamma_b ?? 1, 2)} / {fmt(pileCap.gamma_s ?? 1, 2)}</td></tr>
                      <tr><td>R<sub>c,d</sub></td><td><strong>{fmtInt(pileCap.R_c_d)} kN</strong></td></tr>
                      {#if pileCap.neutralPlane != null}
                        <tr><td>F<sub>nk</sub> slip</td><td>{fmtInt(pileCap.F_nk_slip)} kN</td></tr>
                        <tr><td>F<sub>nk</sub> analogy</td><td>{fmtInt(pileCap.F_nk_analogy)} kN</td></tr>
                        <tr><td>F<sub>nk,d</sub> (governing)</td><td><strong>{fmtInt(pileCap.F_nk_design)} kN</strong></td></tr>
                      {/if}
                      {#if pileSet}
                        <tr><td>s<sub>head</sub> (SLS)</td><td>{fmt(pileSet.sHead_mm, 2)} mm</td></tr>
                        <tr><td>s<sub>allow</sub></td><td>{fmt(pileCfg.sAllowable, 1)} mm</td></tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
              </div>
              {#if pilePerLayer.length}
                <div class="report-card report-card--nested" style="margin-top:16px">
                  <h4>Per-layer shaft resistance</h4>
                  <table class="tbl report-table">
                    <thead>
                      <tr><th>i</th><th>Top (m)</th><th>Bot (m)</th><th class="txt">Cat.</th><th>q<sub>c,m</sub> (MPa)</th><th>η*<sub>p</sub></th><th>q<sub>s</sub> (kPa)</th><th>α<sub>s</sub></th><th>h (m)</th><th class="txt">Status</th><th>R<sub>s</sub> (kN)</th></tr>
                    </thead>
                    <tbody>
                      {#each pilePerLayer as row}
                        <tr>
                          <td>{row.layerIndex + 1}</td>
                          <td>{fmt(row.top, 2)}</td>
                          <td>{fmt(row.bot, 2)}</td>
                          <td class="txt">{row.category}</td>
                          <td>{fmt(row.qcMean, 2)}</td>
                          <td>{row.etaP != null ? row.etaP.toFixed(4) : 'cap'}</td>
                          <td>{fmtInt(row.qs)}</td>
                          <td>{fmt(row.alphaS, 2)}</td>
                          <td>{fmt(row.h, 2)}</td>
                          <td class="txt">{row.excluded ? 'excluded' : row.aboveNeutral ? 'above N.P.' : 'contributing'}</td>
                          <td>{fmtInt(row.RsLayer)}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
              {#if pileNotes.length}
                <div class="report-card report-card--nested" style="margin-top:16px">
                  <h4>Notes</h4>
                  <ul class="report-notes-list">
                    {#each pileNotes as note}
                      <li class={`report-note report-note--${note.level || 'info'}`}>{note.text}</li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          {/if}

          {#if hasStage6('deformation')}
            {@const def = payload.stage6.deformation || {}}
            {@const defSummary = def.summary || {}}
            {@const defView = def.view || null}
            {@const defWarnings = def.warnings || []}
            <div class="report-card report-annex report-annex--deformation">
              <h3>Deformation analysis</h3>
              <div class="report-grid report-grid--4">
                <div class="report-stat"><span>Analysis type</span><strong>{defSummary.analysisType || '—'}</strong></div>
                <div class="report-stat"><span>Constitutive model</span><strong>{defSummary.constitutiveModel || '—'}</strong></div>
                <div class="report-stat"><span>Element</span><strong>{(defSummary.elementType || 't3').toUpperCase()}</strong></div>
                <div class="report-stat"><span>Converged</span><strong>{defSummary.converged ? 'Yes' : 'No'}</strong></div>
                {#if defSummary.safetyFactorOfSafetyLower != null}
                  <div class="report-stat"><span>FoS (c-phi)</span><strong>{fmt(defSummary.safetyFactorOfSafetyLower, 3)}{defSummary.safetyFactorOfSafetyUpper != null && defSummary.safetyFactorOfSafetyUpper !== defSummary.safetyFactorOfSafetyLower ? ` — ${fmt(defSummary.safetyFactorOfSafetyUpper, 3)}` : ''}</strong></div>
                {:else if defSummary.safetyLoadFactor != null}
                  <div class="report-stat"><span>Safety factor (c-phi)</span><strong>{fmt(defSummary.safetyLoadFactor, 3)}</strong></div>
                {:else if defSummary.loadFactor != null}
                  <div class="report-stat"><span>Load factor</span><strong>{fmt(defSummary.loadFactor, 3)}</strong></div>
                {/if}
                {#if defSummary.safetyStatus && defSummary.safetyStatus !== 'not-applicable'}
                  <div class="report-stat"><span>Safety status</span><strong>{defSummary.safetyStatus}</strong></div>
                {/if}
                {#if defSummary.iterations != null}
                  <div class="report-stat"><span>Iterations</span><strong>{defSummary.iterations}</strong></div>
                {/if}
                {#if defSummary.nodeCount != null}
                  <div class="report-stat"><span>Mesh nodes</span><strong>{defSummary.nodeCount}</strong></div>
                {/if}
                {#if defSummary.elementCount != null}
                  <div class="report-stat"><span>Mesh elements</span><strong>{defSummary.elementCount}</strong></div>
                {/if}
                {#if defSummary.timing?.totalMs != null}
                  <div class="report-stat"><span>Runtime</span><strong>{secondsLabelFromMs(defSummary.timing.totalMs)}</strong></div>
                {/if}
              </div>
              {#if defView?.image?.dataUrl}
                <div class="report-card report-card--nested report-card--figure" style="margin-top:16px">
                  <h4>Deformation field view</h4>
                  <figure class="report-figure">
                    <img
                      class="report-figure__image"
                      src={defView.image.dataUrl}
                      alt="Frozen deformation field view from the Stage 6 canvas"
                    />
                    <figcaption class="report-note">
                      {defView.source === 'manual' ? 'User-captured' : 'Auto-captured'} Stage 6 deformation view{defView.capturedAt ? ` at ${new Date(defView.capturedAt).toLocaleString()}` : ''}.
                    </figcaption>
                  </figure>
                </div>
              {:else}
                <p class="report-note" style="margin-top:12px">
                  No deformation view was captured. Open the deformation workspace and press
                  <strong>Capture for report</strong> to include a screenshot.
                </p>
              {/if}
              {#if defWarnings.length}
                <div class="report-card report-card--nested" style="margin-top:16px">
                  <h4>Solver warnings</h4>
                  <ul class="report-notes-list">
                    {#each defWarnings as w}
                      <li class="report-note report-note--warn">{typeof w === 'string' ? w : (w?.text || w?.message || JSON.stringify(w))}</li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      <section class="report-section report-section--appendix">
        <div class="report-section__head">
          <h2>Appendix A - Raw CPT Table</h2>
          <p>Full row set carried into the report payload.</p>
        </div>
        <div class="report-card">
          <table class="tbl report-table">
            <thead>
              <tr>
                <th>Depth (m)</th>
                <th>TAW (m TAW)</th>
                <th>qc (MPa)</th>
                <th>fs (kPa)</th>
                <th>Rf (%)</th>
                <th>u2 (source units)</th>
              </tr>
            </thead>
            <tbody>
              {#each payload.rawRows as row}
                <tr>
                  <td>{fmt(row.depth, 3)}</td>
                  <td>{row.taw != null ? fmt(row.taw, 2) : '—'}</td>
                  <td>{fmt(row.qc, 3)}</td>
                  <td>{row.fsKPa != null ? fmt(row.fsKPa, 2) : '—'}</td>
                  <td>{row.rf != null ? fmt(row.rf, 2) : '—'}</td>
                  <td>{row.u2 != null ? fmt(row.u2, 3) : '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section class="report-section report-section--appendix">
        <div class="report-section__head">
          <h2>Appendix B - Pointwise Classification Table</h2>
          <p>Classification output frozen at report generation time.</p>
        </div>
        <div class="report-card">
          <table class="tbl report-table">
            <thead>
              <tr>
                <th>Depth (m)</th>
                <th>TAW (m TAW)</th>
                <th>qc (MPa)</th>
                <th>fs (kPa)</th>
                <th>Rf (%)</th>
                <th class="txt">Type</th>
                <th class="txt">Subtype</th>
                <th>{methodMetricLabel()}</th>
              </tr>
            </thead>
            <tbody>
              {#each payload.classifiedRows as row}
                <tr>
                  <td>{fmt(row.depth, 3)}</td>
                  <td>{row.taw != null ? fmt(row.taw, 2) : '—'}</td>
                  <td>{fmt(row.qc, 3)}</td>
                  <td>{row.fsKPa != null ? fmt(row.fsKPa, 2) : '—'}</td>
                  <td>{row.rf != null ? fmt(row.rf, 2) : '—'}</td>
                  <td class="txt">{row.type}</td>
                  <td class="txt">{row.subtype || '—'}</td>
                  <td>{methodMetricValue(row)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    </article>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
{/if}

<style>
  /* ============================================================
     Stage 7 report — document design system
     Near-monochrome ink on paper, one brand accent (#3D6B6A),
     semantic color reserved for pass/fail verdicts.
     The report is a fixed light "sheet" in both color schemes so
     the on-screen document matches the printed document.
     ============================================================ */

  :global(body) {
    margin: 0;
    background: var(--color-bg);
  }

  .report-shell {
    --rpt-ink: #1c1c1e;
    --rpt-ink-2: #54545b;
    --rpt-ink-3: #82828a;
    --rpt-paper: #ffffff;
    --rpt-paper-2: #fbfaf7;
    --rpt-hairline: rgba(28, 28, 30, 0.12);
    --rpt-hairline-soft: rgba(28, 28, 30, 0.07);
    --rpt-hairline-strong: rgba(28, 28, 30, 0.28);
    --rpt-rule: #1c1c1e;
    --rpt-accent: #3d6b6a;
    --rpt-pass: #23633f;
    --rpt-fail: #a33425;
    --rpt-warn: #8a620d;

    max-width: var(--container-max);
    margin: 0 auto;
    padding: 24px var(--section-px) 64px;
  }

  /* ---------- toolbar (app chrome, never printed) ---------- */

  .report-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    max-width: 1140px;
    margin: 0 auto 18px;
  }

  .report-toolbar__toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 10px;
    border: 1px solid var(--bd);
    border-radius: var(--radius-sm);
    background: var(--app-panel);
    color: var(--tx);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .report-toolbar__toggle input {
    margin: 0;
  }

  /* ---------- the sheet ---------- */

  .report-sheet {
    width: 100%;
    max-width: 1140px;
    margin: 0 auto;
    border-collapse: collapse;
    table-layout: fixed;
    background: var(--rpt-paper);
    border: 1px solid var(--rpt-hairline);
    box-shadow: 0 1px 2px rgba(18, 18, 20, 0.05), 0 12px 32px rgba(18, 18, 20, 0.06);
  }

  .report-sheet > tbody > tr > td {
    padding: clamp(28px, 4vw, 56px) clamp(22px, 4.5vw, 60px);
    vertical-align: top;
  }

  /* Running header/footer rows exist for print pagination only. */
  .report-running-head,
  .report-running-foot {
    display: none;
  }

  .report {
    display: block;
    color: var(--rpt-ink);
    font-size: 13px;
    line-height: 1.5;
    counter-reset: rpt-section;
  }

  .report-section {
    border-top: 1px solid var(--rpt-hairline);
    padding: 34px 0;
  }

  .report-section:last-child {
    padding-bottom: 0;
  }

  /* ---------- masthead ---------- */

  .report-cover {
    display: block;
    padding: 0 0 30px;
  }

  .report-cover__topline {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 2px solid var(--rpt-rule);
  }

  .report-cover__brand,
  .report-cover__eyebrow {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rpt-ink-2);
  }

  .report-cover__brand::before {
    content: '';
    display: inline-block;
    width: 9px;
    height: 9px;
    margin-right: 9px;
    background: var(--rpt-accent);
    transform: translateY(0.5px);
  }

  .report-cover__eyebrow {
    text-align: right;
    color: var(--rpt-ink-3);
  }

  .report-cover h1 {
    margin: 26px 0 10px;
    font-family: var(--font-heading);
    font-size: clamp(28px, 3.6vw, 40px);
    font-weight: 650;
    letter-spacing: -0.015em;
    line-height: 1.08;
    color: var(--rpt-ink);
  }

  .report-cover p {
    margin: 0;
    max-width: 66ch;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--rpt-ink-2);
  }

  .report-cover__meta {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    margin-top: 28px;
    border-top: 1px solid var(--rpt-hairline-strong);
  }

  .report-cover__meta div {
    min-width: 0;
    padding: 10px 16px 0 0;
    border-left: 1px solid var(--rpt-hairline);
    padding-left: 16px;
  }

  .report-cover__meta div:first-child {
    border-left: none;
    padding-left: 0;
  }

  .report-cover__meta span {
    display: block;
    margin-bottom: 3px;
    font-family: var(--font-mono);
    font-size: 0.62rem;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--rpt-ink-3);
  }

  .report-cover__meta strong {
    display: block;
    font-family: var(--font-heading);
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--rpt-ink);
    overflow-wrap: anywhere;
  }

  /* ---------- section heads ---------- */

  .report-section:not(.report-section--appendix) {
    counter-increment: rpt-section;
  }

  .report-section__head {
    display: grid;
    gap: 5px;
    margin-bottom: 20px;
  }

  .report-section h2 {
    margin: 0;
    font-family: var(--font-heading);
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--rpt-ink);
  }

  .report-section:not(.report-section--appendix) h2::before {
    content: counter(rpt-section, decimal-leading-zero);
    margin-right: 14px;
    font-family: var(--font-mono);
    font-weight: 500;
    color: var(--rpt-accent);
  }

  .report-section__head p {
    margin: 0;
    max-width: 78ch;
    font-size: 12.5px;
    color: var(--rpt-ink-2);
  }

  .report-section__block {
    display: grid;
    align-content: start;
  }

  /* ---------- grids and cards ---------- */

  .report-grid {
    display: grid;
    gap: 16px;
  }

  .report-grid + .report-grid,
  .report-grid + .report-card,
  .report-card + .report-grid {
    margin-top: 16px;
  }

  .report-grid--2 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .report-grid--3 {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .report-grid--4 {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .report-card {
    min-width: 0;
    background: var(--rpt-paper);
    border: 1px solid var(--rpt-hairline);
    border-radius: 0;
    padding: 18px 20px;
  }

  .report-card--nested {
    padding: 14px 16px;
  }

  .report-card h3,
  .report-card h4 {
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rpt-hairline);
    font-family: var(--font-heading);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--rpt-ink-2);
  }

  /* ---------- key figures ---------- */

  .report-stat {
    min-width: 0;
    padding: 9px 0 0;
    border-top: 2px solid var(--rpt-rule);
    background: transparent;
  }

  .report-stat span {
    display: block;
    margin-bottom: 4px;
    font-family: var(--font-mono);
    font-size: 0.62rem;
    font-weight: 500;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    line-height: 1.45;
    color: var(--rpt-ink-3);
  }

  .report-stat strong {
    display: block;
    font-family: var(--font-heading);
    font-size: 18px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    color: var(--rpt-ink);
    overflow-wrap: anywhere;
  }

  /* Verdict stats: semantic color plus a non-color cue (rule weight /
     underline) so pass and fail remain distinct in grayscale print. */
  .report-stat--pass {
    border-top-color: var(--rpt-pass);
  }

  .report-stat--pass strong {
    color: var(--rpt-pass);
  }

  .report-stat--fail {
    border-top-color: var(--rpt-fail);
  }

  .report-stat--fail strong {
    color: var(--rpt-fail);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 4px;
  }

  /* ---------- key/value tables ---------- */

  .report-pt {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  .report-pt td {
    padding: 4.5px 0;
    border-bottom: 1px solid var(--rpt-hairline-soft);
    vertical-align: top;
  }

  .report-pt tr:last-child td {
    border-bottom: none;
  }

  .report-pt td:first-child {
    padding-right: 14px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--rpt-ink-2);
    white-space: nowrap;
  }

  .report-pt td:last-child {
    text-align: right;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: var(--rpt-ink);
  }

  .report-pt--tight td {
    padding: 3px 0;
  }

  /* ---------- data tables ---------- */

  .report-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    margin-top: 0;
    background: transparent;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .report-table th {
    padding: 6px 7px;
    background: transparent;
    border-bottom: 1px solid var(--rpt-hairline-strong);
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: right;
    white-space: normal;
    line-height: 1.35;
    color: var(--rpt-ink-2);
    vertical-align: bottom;
  }

  .report-table td {
    padding: 5px 7px;
    border-bottom: 1px solid var(--rpt-hairline-soft);
    text-align: right;
    vertical-align: top;
    /* Numeric cells must never break inside a number. */
    overflow-wrap: normal;
    word-break: normal;
    color: var(--rpt-ink);
  }

  .report-table td.txt {
    overflow-wrap: anywhere;
  }

  .report-table th:first-child,
  .report-table td:first-child {
    padding-left: 0;
  }

  .report-table th:last-child,
  .report-table td:last-child {
    padding-right: 0;
  }

  .report-table th.txt,
  .report-table td.txt {
    text-align: left;
  }

  .report-table tbody tr:last-child td {
    border-bottom: none;
  }

  /* A static document does not need hover zebra. */
  .report-table tbody tr:hover td {
    background: transparent;
  }

  .report-table sub {
    font-size: 0.78em;
    line-height: 1;
  }

  .report-table__unit {
    display: block;
    white-space: nowrap;
    font-size: 0.92em;
    font-weight: 500;
    color: var(--rpt-ink-3);
  }

  .report-table--model-params th {
    line-height: 1.25;
  }

  /* The model-parameter table has no colgroup; reserve readable width
     for its two text columns (Infiltration, Overrides). */
  .report-table--model-params th.txt {
    width: 9.5%;
  }

  .report-table__col-index {
    width: 3.5%;
  }

  .report-table__col-depth {
    width: 6.3%;
  }

  .report-table__col-thk {
    width: 5%;
  }

  .report-table__col-type {
    width: 9%;
  }

  .report-table__col-subtype {
    width: 11.4%;
  }

  .report-table__col-avgwide {
    width: 7.5%;
  }

  .report-table__col-avgnarrow {
    width: 4.8%;
  }

  .report-table__col-param {
    width: 5.1%;
  }

  .report-table__col-smallparam {
    width: 3.6%;
  }

  /* ---------- soil chips and notes ---------- */

  .report-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 2px;
    border: 1px solid rgba(24, 24, 26, 0.14);
    font-family: var(--font-mono);
    font-size: 0.64rem;
    font-weight: 600;
    margin-right: 8px;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .report-muted {
    color: var(--rpt-ink-3);
  }

  .report-note {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--rpt-ink-2);
  }

  .report-notes-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 6px;
  }

  .report-notes-list .report-note {
    padding-left: 10px;
    border-left: 2px solid var(--rpt-hairline-strong);
  }

  .report-notes-list .report-note--warn {
    border-left-color: var(--rpt-warn);
  }

  .info {
    margin: 0 0 12px;
    padding: 10px 14px;
    background: var(--rpt-paper-2);
    border: 1px solid var(--rpt-hairline);
    border-left: 3px solid var(--rpt-warn);
    border-radius: 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--rpt-ink);
  }

  .report-section__head + .info,
  .report-grid .info {
    margin-bottom: 0;
  }

  /* ---------- profile ---------- */

  .report-profile {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    align-items: start;
    gap: 20px;
    overflow: hidden;
  }

  .report-profile__visual {
    min-width: 0;
    display: flex;
    justify-content: center;
    position: relative;
  }

  .report-profile svg {
    display: block;
    width: 100%;
    max-width: 100%;
    height: auto;
    max-height: 540px;
  }

  .report-profile__legend {
    min-width: 0;
  }

  .report-profile__legend h3 {
    margin-bottom: 8px;
  }

  .report-profile__table {
    font-size: 11px;
    table-layout: auto;
    min-width: 100%;
  }

  .report-profile__col-index {
    width: 3.6ch;
  }

  .report-profile__col-name {
    width: 45%;
  }

  .report-profile__col-qc,
  .report-profile__col-fs {
    width: 24%;
  }

  .report-profile__type {
    display: flex;
    align-items: center;
    gap: 6px;
    text-align: left;
  }

  .report-profile__name {
    white-space: normal;
    overflow-wrap: normal;
    word-break: normal;
    hyphens: auto;
  }

  .report-profile__swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    border: 1px solid rgba(24, 24, 26, 0.18);
    flex: 0 0 auto;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .report-profile__legend-row--hover td {
    background: rgba(61, 107, 106, 0.1) !important;
  }

  .report-profile__tooltip {
    min-width: 220px;
    max-width: 280px;
  }

  /* ---------- figures and charts ---------- */

  .report-canvas {
    position: relative;
    height: 260px;
    border: 1px solid var(--rpt-hairline);
    border-radius: 0;
    background: var(--rpt-paper);
  }

  .report-canvas canvas {
    display: block;
    width: 100% !important;
    height: 100% !important;
  }

  :global(.report-print-chart) {
    display: none;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .report-canvas--single {
    margin-top: 16px;
  }

  .report-canvas--tuning {
    height: 240px;
  }

  .report-canvas--annex {
    height: 220px;
  }

  .report-canvas--annex-bearing {
    height: 240px;
  }

  .report-canvas--annex-time {
    height: 200px;
  }

  .report-card--figure {
    margin-top: 16px;
  }

  .report-figure {
    margin: 0;
  }

  .report-figure__image {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid var(--rpt-hairline);
    border-radius: 0;
    background: var(--rpt-paper-2);
  }

  .report-figure .report-note {
    margin-top: 6px;
  }

  /* ---------- annexes ---------- */

  .report-annex {
    display: grid;
    gap: 16px;
  }

  .report-annex + .report-annex {
    margin-top: 16px;
  }

  .report-annex__summary,
  .report-annex__charts {
    align-items: start;
  }

  .report-annex__split {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
    gap: 16px;
    align-items: start;
    margin-top: 0;
  }

  .report-annex__split--single {
    grid-template-columns: minmax(0, 1fr);
  }

  .report-annex__main,
  .report-annex__aside {
    min-width: 0;
    display: grid;
    gap: 14px;
    align-content: start;
  }

  .report-annex__aside .report-card--figure {
    margin-top: 0;
  }

  .report-tuning__head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
  }

  .report-tuning__head strong {
    font-family: var(--font-heading);
    font-weight: 600;
  }

  /* ---------- error state ---------- */

  .report-error {
    max-width: 560px;
    margin: 12vh auto 0;
    padding: 32px;
    background: var(--rpt-paper);
    border: 1px solid var(--rpt-hairline);
    text-align: center;
    color: var(--rpt-ink);
  }

  .report-error h1 {
    font-family: var(--font-heading);
    font-size: 20px;
    margin: 0 0 10px;
  }

  .report-error__actions {
    display: flex;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 16px;
  }

  /* ---------- responsive ---------- */

  @media (max-width: 980px) {
    .report-toolbar {
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .report-grid--4 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .report-cover__meta {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      row-gap: 14px;
    }

    .report-cover__meta div:nth-child(odd) {
      border-left: none;
      padding-left: 0;
    }

    .report-profile {
      grid-template-columns: 1fr;
    }

    .report-grid--3,
    .report-grid--2,
    .report-annex__split {
      grid-template-columns: 1fr;
    }
  }

  /* ============================================================
     Print: A4 engineering document.
     Margin boxes carry the page counter where the browser
     supports them; the repeating table head/foot rows carry the
     project identification on every page everywhere else.
     ============================================================ */

  @page {
    size: A4 portrait;
    margin: 14mm 13mm 16mm;

    @bottom-right {
      content: counter(page) ' / ' counter(pages);
      font-family: 'JetBrains Mono', monospace;
      font-size: 6.5pt;
      color: #555;
    }
  }

  @media print {
    :global(html),
    :global(body) {
      background: #fff;
      color: #111;
      font-size: 8pt;
      line-height: 1.42;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    :global(article),
    :global(section),
    :global(div),
    :global(table) {
      max-width: 100%;
    }

    .no-print {
      display: none !important;
    }

    .report--concise-print .report-section--appendix {
      display: none !important;
    }

    .report-shell {
      max-width: none;
      padding: 0;
    }

    .report-sheet {
      max-width: none;
      border: none;
      box-shadow: none;
      background: #fff;
    }

    .report-sheet > tbody > tr > td {
      padding: 0;
    }

    /* Running identification on every printed page. */
    .report-running-head {
      display: table-header-group;
    }

    .report-running-foot {
      display: table-footer-group;
    }

    .report-running-head td {
      padding: 0 0 4mm;
    }

    .report-running-foot td {
      padding: 3mm 0 0;
    }

    .report-running-head__inner,
    .report-running-foot__inner {
      display: flex;
      justify-content: space-between;
      gap: 8mm;
      font-family: var(--font-mono);
      font-size: 6pt;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #666;
    }

    .report-running-head__inner {
      border-bottom: 0.5pt solid #999;
      padding-bottom: 1.6mm;
    }

    .report-running-foot__inner {
      border-top: 0.5pt solid #999;
      padding-top: 1.6mm;
    }

    .report {
      font-size: 8pt;
    }

    /* ----- masthead ----- */

    .report-cover {
      padding-bottom: 7mm;
    }

    .report-cover__topline {
      padding-bottom: 2.2mm;
      border-bottom: 1.2pt solid #111;
    }

    .report-cover__brand,
    .report-cover__eyebrow {
      font-size: 6.5pt;
    }

    .report-cover h1 {
      margin: 6mm 0 2.5mm;
      font-size: 21pt;
    }

    .report-cover p {
      font-size: 8.5pt;
    }

    .report-cover__meta {
      margin-top: 6mm;
    }

    .report-cover__meta div {
      padding-top: 2mm;
      padding-right: 3mm;
    }

    .report-cover__meta span {
      font-size: 5.8pt;
    }

    .report-cover__meta strong {
      font-size: 8.5pt;
    }

    /* ----- sections ----- */

    .report-section {
      padding: 5mm 0;
      border-top: 0.5pt solid #c4c2bd;
    }

    .report-section h2 {
      font-size: 10pt;
    }

    .report-section__head {
      gap: 1mm;
      margin-bottom: 3.5mm;
      break-inside: avoid;
      page-break-inside: avoid;
      break-after: avoid;
      page-break-after: avoid;
    }

    .report-section__head + .report-card,
    .report-section__head + .report-grid,
    .report-section__head + .info {
      break-before: avoid;
      page-break-before: avoid;
    }

    .report-section__head p {
      font-size: 7pt;
    }

    .report-muted {
      font-size: 7pt;
    }

    .report-note {
      font-size: 6.5pt;
    }

    .info {
      font-size: 7pt;
      padding: 1.8mm 2.5mm;
      margin-bottom: 2.5mm;
    }

    /* ----- grids and cards ----- */

    .report-grid {
      gap: 2.5mm;
    }

    /* The narrow print viewport triggers the small-screen media query;
       restore the two-column layout on paper. Tuning cards stay full
       width so their chart pairs remain readable. */
    .report-grid--2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .report-grid--2:has(> .report-tuning) {
      grid-template-columns: minmax(0, 1fr);
    }

    .report-cover__meta {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }

    .report-cover__meta div,
    .report-cover__meta div:nth-child(odd) {
      border-left: 0.5pt solid #ccc9c3;
      padding-left: 3mm;
    }

    .report-cover__meta div:first-child {
      border-left: none;
      padding-left: 0;
    }

    .report-grid + .report-grid,
    .report-grid + .report-card,
    .report-card + .report-grid,
    .report-annex + .report-annex,
    .report-card--figure,
    .report-canvas--single {
      margin-top: 2.5mm;
    }

    .report-card {
      border: 0.5pt solid #ccc9c3;
      padding: 2.4mm 2.8mm;
    }

    .report-card h3,
    .report-card h4 {
      font-size: 6.8pt;
      margin-bottom: 1.6mm;
      padding-bottom: 1.1mm;
      border-bottom: 0.5pt solid #dad7d1;
    }

    .report-stat {
      border-top-width: 1pt;
      padding-top: 1.4mm;
    }

    .report-stat span {
      font-size: 5.8pt;
      margin-bottom: 0.8mm;
    }

    .report-stat strong {
      font-size: 9.5pt;
    }

    /* ----- tables ----- */

    .report-pt {
      font-size: 7pt;
    }

    .report-pt td {
      padding: 0.7mm 0;
    }

    .report-pt td:first-child {
      font-size: 6pt;
    }

    .report-table {
      font-size: 7pt;
    }

    .report-table th {
      font-size: 6pt;
      padding: 1mm 1.2mm;
      line-height: 1.2;
      border-bottom: 0.75pt solid #777;
    }

    .report-table td {
      padding: 0.9mm 1.2mm;
      border-bottom: 0.5pt solid #e0ddd8;
    }

    .report-table--layers,
    .report-table--model-params {
      font-size: 6.2pt;
    }

    .report-table--layers th,
    .report-table--model-params th {
      font-size: 5.6pt;
    }

    .report-table--model-params th {
      line-height: 1.25;
    }

    .report-section--appendix .report-table {
      font-size: 6.5pt;
    }

    .tbl thead {
      display: table-header-group;
    }

    .tbl tr,
    .pt tr,
    .report-cover__meta,
    .report-stat,
    .report-card.report-profile,
    .report-tuning,
    .info {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    /* Keep key-figure rows and ordinary cards whole; very tall blocks
       (appendix tables, full annexes) fall back to normal flow. */
    .report-grid--3,
    .report-grid--4,
    .report-card {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-section--appendix .report-card {
      break-inside: auto;
      page-break-inside: auto;
    }

    .report-card h3,
    .report-card h4 {
      break-after: avoid;
      page-break-after: avoid;
    }

    .report-chip {
      padding: 0.2mm 1mm;
      font-size: 5.5pt;
      margin-right: 1mm;
      border-width: 0.5pt;
    }

    /* ----- profile ----- */

    .report-section--cpt-profile {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-section--profile {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-profile {
      grid-template-columns: minmax(0, 1fr) 64mm;
      gap: 3mm;
    }

    .report-profile svg {
      max-height: 110mm;
    }

    .report-profile__legend h3 {
      margin-bottom: 1mm;
      font-size: 6.5pt;
    }

    .report-profile__table {
      font-size: 6pt;
      table-layout: auto;
    }

    .report-profile__swatch {
      width: 2mm;
      height: 2mm;
      border-width: 0.5pt;
    }

    /* ----- charts and figures ----- */

    .report-canvas {
      height: 60mm;
      border: 0.5pt solid #ccc9c3;
    }

    .report-canvas canvas {
      display: none !important;
    }

    :global(.report-print-chart) {
      display: block;
    }

    .report-canvas--tuning {
      height: 50mm;
    }

    .report-section--stage6 .report-canvas--annex {
      height: 40mm;
    }

    .report-section--stage6 .report-canvas--annex-bearing {
      height: 46mm;
    }

    .report-section--stage6 .report-canvas--annex-time {
      height: 34mm;
    }

    .report-figure__image {
      border: 0.5pt solid #ccc9c3;
    }

    .report-section--stage6 .report-figure__image {
      max-height: 64mm;
      object-fit: contain;
    }

    /* ----- page-break management ----- */

    .report-section--layer-model {
      break-before: page;
      page-break-before: always;
    }

    .report-section__block--keep {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    :global(.report-section--print-break-before) {
      break-before: page !important;
      page-break-before: always !important;
    }

    .report-section--stage6 .report-annex {
      gap: 2.5mm;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-section--stage6 .report-annex__summary,
    .report-section--stage6 .report-annex__charts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 2.5mm;
      break-inside: auto;
      page-break-inside: auto;
    }

    .report-section--stage6 .report-annex__split {
      grid-template-columns: minmax(0, 1fr) 68mm;
      gap: 2.5mm;
    }

    .report-section--stage6 .report-annex__split--single {
      grid-template-columns: minmax(0, 1fr);
    }

    .report-section--stage6 .report-annex__stats {
      gap: 2.5mm;
      break-inside: auto;
      page-break-inside: auto;
    }

    .report-section--stage6 .report-canvas,
    .report-section--stage6 .report-stat,
    .report-section--stage6 table {
      break-inside: auto;
      page-break-inside: auto;
    }
  }
</style>
