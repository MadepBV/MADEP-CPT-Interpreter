// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Vibration impact assessment — inputs + results tab. Prediction: TRL 429 / BS 5228-2 (vibratory)
 * or BS 5228-2 impact relation; receiver limits: SBR-A (default in Belgian practice), DIN 4150-3,
 * BS 7385-2 — never mixed. Site calibration from trial measurements (power law).
 */
import { numberRow, selectRow, checkRow, help, accordion, esc, fmt, num, segmented } from './panel-kit.js';
import { table, kvList, copyButton, toTsv, badge } from '../results/result-kit.js';
import { predictVibratoryPpv, predictImpactPpv, ppvVsDistanceCurve, BS5228_KP } from '../vibration/ppv-prediction.js';
import { assessReceiver, sbrAAllowableVelocity, humanResponseDescriptor } from '../vibration/receiver-criteria.js';
import { buildMonitoringPlan, suggestSensorLayout } from '../vibration/monitoring-plan.js';
import { calibrateLeastSquares, calibrateTwoPoint, upperPrediction, predictFromFit } from '../vibration/attenuation-calibration.js';
import { drawXYChart } from '../retaining-charts.js';
import { retainingVizSeries } from '../../../styles/theme.ts';
import { findHammer } from '../drivability/hammer-catalog.js';

function frameworkArgs(v) {
  if (v.framework === 'DIN4150-3') return { line: Number(v.din.line) || 2, location: v.din.location || 'foundation', duration: v.din.duration || 'short' };
  if (v.framework === 'BS7385-2') return { line: Number(v.bs.line) || 2, continuous: !!v.bs.continuous };
  return { category: Number(v.sbr.category) || 2, condition: v.sbr.condition || 'normal', measurementType: v.sbr.measurement || 'indicative', vibrationType: v.sbr.vibrationType === 'repeated-short' ? 'repeated' : (v.sbr.vibrationType || 'repeated'), part: v.sbr.part || 'structure' };
}

/** Everything the results tab and the note need, computed once. */
export function computeVibration(rw) {
  const v = rw.vibration;
  const x = Math.max(num(v.distance, 30), 0.5);
  const f = Math.max(num(v.frequency, 35), 0);
  const impact = rw.drivability?.method === 'impact';
  const hm = rw.drivability?.hammer || {};
  const catHammer = impact && hm.id && hm.id !== 'custom' ? findHammer(hm.id) : null;
  const energyJ = impact ? num(catHammer?.ratedEnergy_kJ, num(hm.ratedEnergy, 60)) * 1000 * num(hm.efficiency, catHammer?.efficiencyDefault ?? 0.9) : null;
  const rowsPred = [];
  let governing = null;
  if (!impact) {
    for (const phase of ['steady', 'all', 'startup']) {
      const r = { phase };
      for (const p of [50, 33, 5]) r[`p${p}`] = predictVibratoryPpv({ distance_m: x, phase, probability: p }).ppv_mm_s;
      rowsPred.push(r);
    }
    governing = { label: '5 % exceedance, start-up/run-down', ppv: rowsPred[2].p5, steady95: rowsPred[0].p5, median: rowsPred[0].p50 };
  } else {
    const gc = v.groundCondition || 'refusal';
    const r = predictImpactPpv({ distance_m: x, hammerEnergy_J: energyJ, groundCondition: gc, toeDepth_m: num(rw.embedded?.retainedHeight, 0) + num(rw.embedded?.embedment, 0) });
    governing = { label: `BS 5228-2 impact, k_p ${fmt(r.kp ?? r.kpUsed, 1)} (${gc})`, ppv: r.ppv_mm_s, notes: r.notes };
    rowsPred.push({ phase: 'impact', p5: r.ppv_mm_s });
  }
  const args = frameworkArgs(v);
  const assess = assessReceiver({ predictedPpv_mm_s: governing.ppv, frequency_Hz: f, framework: v.framework, frameworkArgs: args, attentionFraction: num(v.warningFraction, 0.75) });
  const plan = buildMonitoringPlan({ framework: v.framework, frameworkArgs: args, dominantFrequency_Hz: f, prediction: { expected_mm_s: governing.median ?? governing.ppv, upper_mm_s: governing.ppv }, warningFraction: num(v.warningFraction, 0.75), receiverDistance_m: x });
  const sensors = suggestSensorLayout(x);
  // calibration
  const pts = (v.calibration?.points || []).filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.v)) && Number(p.x) > 0 && Number(p.v) > 0).map((p) => ({ x_m: Number(p.x), v_mm_s: Number(p.v) }));
  let fit = null, fitAt = null, upper = null;
  if (pts.length >= 3) { fit = calibrateLeastSquares({ points: pts }); if (fit && Number.isFinite(fit.K)) { fitAt = predictFromFit(fit, x); upper = upperPrediction({ K: fit.K, n: fit.n, s: fit.s, distance_m: x, N: pts.length }); } }
  else if (pts.length === 2) { fit = calibrateTwoPoint({ x1_m: pts[0].x_m, v1_mm_s: pts[0].v_mm_s, x2_m: pts[1].x_m, v2_mm_s: pts[1].v_mm_s }); if (fit && Number.isFinite(fit.K)) fitAt = predictFromFit(fit, x); }
  return { x, f, impact, energyJ, rowsPred, governing, assess, plan, sensors, pts, fit, fitAt, upper, args };
}

export function vibrationPanel(rw) {
  const v = rw.vibration;
  const impact = rw.drivability?.method === 'impact';
  let body = `${numberRow('Distance to receiver x', 'vibration.distance', v.distance, { unit: 'm', step: 1, min: 1, title: 'Shortest horizontal surface distance from the nearest pile position' })}
    ${numberRow('Dominant frequency', 'vibration.frequency', v.frequency, { unit: 'Hz', step: 1, min: 0, title: 'Operating frequency of the vibrator; impact: expected dominant frequency at the receiver' })}
    ${help(impact ? 'Impact driving: BS 5228-2 Annex E, v = k<sub>p</sub>·√W / r<sup>1.3</sup>, W = hammer energy per blow × efficiency; k<sub>p</sub> by ground condition (not a probability level).' : 'Vibratory driving: TRL 429 / BS 5228-2, v = k<sub>v</sub>·x<sup>−δ</sup> with k<sub>v</sub> = 60 / 126 / 266 (50 / 33 / 5 % exceedance) and δ = 1.4 steady, 1.3 all operations, 1.2 start-up/run-down; valid 1–100 m.')}
    ${impact ? selectRow('Ground condition (k<sub>p</sub>)', 'vibration.groundCondition', v.groundCondition || 'refusal', Object.keys(BS5228_KP).map((k) => ({ value: k, label: `${k} (k_p = ${BS5228_KP[k].kp})` }))) : ''}
    <div class="card__eyebrow">Receiver criterion</div>
    ${selectRow('Framework', 'vibration.framework', v.framework, [{ value: 'SBR-A', label: 'SBR-A (2017) — Belgian/Dutch practice' }, { value: 'DIN4150-3', label: 'DIN 4150-3:2016' }, { value: 'BS7385-2', label: 'BS 7385-2:1993' }])}`;
  if (v.framework === 'SBR-A') {
    body += `${selectRow('Building category', 'vibration.sbr.category', v.sbr.category, [{ value: 1, label: '1 — industrial / reinforced (20→40→50)' }, { value: 2, label: '2 — dwellings, masonry (5→15→20)' }, { value: 3, label: '3 — legacy sensitive (3→8→10)' }])}
      ${selectRow('Condition (γ<sub>s</sub>)', 'vibration.sbr.condition', v.sbr.condition, [{ value: 'normal', label: 'normal (1.0)' }, { value: 'sensitive', label: 'sensitive / poor state (1.7)' }, { value: 'monument', label: 'monument (1.7)' }])}
      ${selectRow('Measurement (γ<sub>v</sub>)', 'vibration.sbr.measurement', v.sbr.measurement, [{ value: 'indicative', label: 'indicative, one sensor (1.6)' }, { value: 'limited', label: 'limited (1.4)' }, { value: 'extensive', label: 'extensive (1.0)' }])}
      ${selectRow('Vibration type (γ<sub>t</sub>)', 'vibration.sbr.vibrationType', v.sbr.vibrationType, [{ value: 'short', label: 'short-term (1.0)' }, { value: 'repeated-short', label: 'repeated short-term (1.5 / 1.6)' }, { value: 'continuous', label: 'continuous (2.5 / 2.0)' }])}
      ${selectRow('Building part', 'vibration.sbr.part', v.sbr.part, [{ value: 'structure', label: 'ground-floor load-bearing structure' }, { value: 'topFloor', label: 'top floor' }, { value: 'foundation', label: 'foundation (10·C_D)' }])}`;
  } else if (v.framework === 'DIN4150-3') {
    body += `${selectRow('Line (Table 1)', 'vibration.din.line', v.din.line, [{ value: 1, label: '1 — commercial / industrial' }, { value: 2, label: '2 — dwellings' }, { value: 3, label: '3 — sensitive / monuments' }])}
      ${selectRow('Location', 'vibration.din.location', v.din.location, [{ value: 'foundation', label: 'foundation' }, { value: 'topFloor', label: 'top floor plane' }])}
      ${selectRow('Duration', 'vibration.din.duration', v.din.duration, [{ value: 'short', label: 'short-term' }, { value: 'long', label: 'long-term (Table 3)' }])}`;
  } else {
    body += `${selectRow('Line (Table 1)', 'vibration.bs.line', v.bs.line, [{ value: 1, label: '1 — reinforced / framed industrial (50 mm/s)' }, { value: 2, label: '2 — unreinforced / light-framed residential (15→20→50)' }])}
      ${checkRow('Continuous vibration (−50 %)', 'vibration.bs.continuous', !!v.bs.continuous)}`;
  }
  body += `${numberRow('Warning level (fraction of stop)', 'vibration.warningFraction', v.warningFraction, { step: 0.05, min: 0.3, max: 0.95 })}
    <div class="card__eyebrow">Site calibration (trial measurements)</div>
    ${(v.calibration.points || []).map((p, i) => `<div class="field field--inline"><span class="field__text">point ${i + 1}</span><span class="field__row"><input class="input input--sm input--num input--xs" type="number" step="0.5" value="${esc(p.x)}" onchange="retwallCalPoint(${i},'x',this.value)"><span class="field__unit">m</span><input class="input input--sm input--num input--xs" type="number" step="0.1" value="${esc(p.v)}" onchange="retwallCalPoint(${i},'v',this.value)"><span class="field__unit">mm/s</span><button type="button" class="btn btn--sm btn--icon btn--text" title="remove" onclick="retwallCalPoint(${i},'remove')">×</button></span></div>`).join('')}
    <div class="actions"><button type="button" class="btn btn--sm btn--text" onclick="retwallCalPoint(-1,'add')">+ add measurement (distance, PPV)</button></div>
    ${help('Two points give v = K·x<sup>−n</sup> directly (course §15.5); three or more a least-squares fit with a one-sided 95 % upper prediction (§15.7). Separate fits per source condition (start-up vs steady, different settings).')}`;
  return accordion('vibration', 'Vibration impact', body, { open: false, pill: v.framework });
}

export function vibrationView(rw) {
  const V = computeVibration(rw);
  const v = rw.vibration;
  const A = V.assess;
  const human = humanResponseDescriptor(V.governing.ppv);
  const predTable = V.impact
    ? kvList([['PPV (BS 5228-2 impact)', fmt(V.governing.ppv, 2), 'mm/s'], ['hammer energy W', fmt(V.energyJ / 1000, 1), 'kJ per blow (rated × efficiency)']])
    : table([{ label: 'Operating phase', render: (r) => ({ steady: 'steady-state driving (δ 1.4)', all: 'all operations (δ 1.3)', startup: 'start-up / run-down (δ 1.2)' }[r.phase]) }, { label: 'k<sub>v</sub> 60 — 50 %', num: true, render: (r) => fmt(r.p50, 2) }, { label: 'k<sub>v</sub> 126 — 33 %', num: true, render: (r) => fmt(r.p33, 2) }, { label: 'k<sub>v</sub> 266 — 5 %', num: true, render: (r) => fmt(r.p5, 2) }], V.rowsPred);
  const verdictCls = A.verdict === 'ok' ? 'ok' : A.verdict === 'attention' ? 'warn' : 'bad';
  const limitRows = A.detail && v.framework === 'SBR-A' ? kvList([['V<sub>kar</sub> at f', fmt(A.detail.vKar, 2), 'mm/s'], ['γ<sub>s</sub> · γ<sub>v</sub> · γ<sub>t</sub>', `${fmt(A.detail.gammaS, 1)} · ${fmt(A.detail.gammaV, 1)} · ${fmt(A.detail.gammaT, 1)}`, ''], ['V<sub>top,allow</sub> = V<sub>kar</sub>/(γ<sub>s</sub>γ<sub>v</sub>γ<sub>t</sub>)', fmt(A.detail.vAllow, 2), 'mm/s']]) : kvList([['Limit at f', fmt(A.limit_mm_s, 2), 'mm/s']]);
  const freqRows = (V.plan.frequencyTable || []).map((r) => [r.f, r.vKar, r.vAllow, r.warning]);
  const tsv = toTsv(['f_Hz', 'V_kar_mm_s', 'V_allow_mm_s', 'warning_mm_s'], freqRows);
  const cal = V.fit && Number.isFinite(V.fit.K)
    ? kvList([['n', fmt(V.fit.n, 4), ''], ['K', fmt(V.fit.K, 2), 'mm/s at 1 m'], ['v at x (best fit)', fmt(typeof V.fitAt === 'number' ? V.fitAt : V.fitAt?.ppv_mm_s ?? V.fitAt?.v_mm_s, 2), 'mm/s'], ...(V.upper ? [['v<sub>95</sub> at x', fmt(V.upper.v95_mm_s, 2), `mm/s (N = ${V.pts.length})`]] : []), ...(V.fit.r2 != null ? [['r²', fmt(V.fit.r2, 3), '']] : [])])
    : '<div class="card card--quiet card--note">Enter at least two trial measurements in the panel to calibrate the site attenuation law.</div>';
  return `<div class="cols-2">
      <div class="stack--sections">
        <div class="card__eyebrow">Prediction at x = ${fmt(V.x, 1)} m</div>${predTable}
        <div class="card__text">${V.impact ? (V.governing.notes || []).map(esc).join(' ') : 'Resultant PPV; the 5 % curve is a screening envelope, not a maximum (TRL 429).'}</div>
        <div class="card__eyebrow">Receiver assessment — ${esc(v.framework)}</div>
        <div class="verdict ${verdictCls === 'ok' ? 'verdict--good' : verdictCls === 'bad' ? 'verdict--bad' : 'verdict--warn'}"><span class="verdict__tag">${A.verdict === 'ok' ? 'BELOW LIMIT' : A.verdict === 'attention' ? 'ATTENTION' : 'EXCEEDS'}</span><span class="verdict__body">${fmt(V.governing.ppv, 2)} mm/s vs ${fmt(A.limit_mm_s, 2)} mm/s · utilisation ${fmt(A.utilisation, 2)} · ${esc(V.governing.label)}</span></div>
        ${limitRows}
        <div class="card__text">Human response (BS 5228-2 Table B.1): ${esc(human.descriptor || human.text || human)}. ${(A.notes || []).map(esc).join(' ')}</div>
        <div class="card__eyebrow">Trigger levels</div>
        ${kvList([['expected (median)', fmt(V.plan.expected?.value, 2), 'mm/s'], ['upper prediction', fmt(V.plan.upper?.value, 2), 'mm/s'], ['warning (SMS)', fmt(V.plan.warning?.value, 2), `mm/s (${fmt(num(v.warningFraction, 0.75) * 100, 0)} % of stop)`], ['stop', fmt(V.plan.stop?.value, 2), 'mm/s'], ['human objective', fmt(V.plan.humanObjective?.value, 2), 'mm/s']])}
        <div class="card__text">Sensors: ${esc((V.sensors?.sensors || []).map((s) => `${fmt(s.distance_m, 0)} m — ${s.role}`).join('; '))}.</div>
        <div class="card__eyebrow">Site calibration</div>${cal}
      </div>
      <div class="stack--sections">
        <div class="viz viz--chart"><canvas id="retwallChartPpv"></canvas></div>
        <div class="card__eyebrow">Limit vs frequency (${esc(v.framework)})</div>
        <div class="viz viz--chart viz--short"><canvas id="retwallChartLimit"></canvas></div>
        <div class="actions">${copyButton('copy frequency table (TSV)', tsv)}</div>
      </div>
    </div>`;
}

export function drawVibrationCharts(rw) {
  const V = computeVibration(rw);
  const c1 = document.getElementById('retwallChartPpv');
  const c2 = document.getElementById('retwallChartLimit');
  const S = retainingVizSeries();
  const distances = []; for (let x = 2; x <= 100; x += 2) distances.push(x);
  if (c1) {
    const series = [];
    if (!V.impact) {
      for (const [p, color, label] of [[50, S.p50, 'steady 50 %'], [5, S.p5, 'steady 5 %']]) {
        const c = ppvVsDistanceCurve({ predictor: 'vibratory', args: { phase: 'steady', probability: p }, distances });
        series.push({ x: c.points.map((q) => q.distance_m ?? q.x_m ?? q.x), y: c.points.map((q) => q.ppv_mm_s), color, label });
      }
      const c = ppvVsDistanceCurve({ predictor: 'vibratory', args: { phase: 'startup', probability: 5 }, distances });
      series.push({ x: c.points.map((q) => q.distance_m ?? q.x_m ?? q.x), y: c.points.map((q) => q.ppv_mm_s), color: S.startup, label: 'start-up 5 %' });
    } else {
      const c = ppvVsDistanceCurve({ predictor: 'impact', args: { hammerEnergy_J: V.energyJ, groundCondition: rw.vibration.groundCondition || 'refusal' }, distances });
      series.push({ x: c.points.map((q) => q.distance_m ?? q.x_m ?? q.x), y: c.points.map((q) => q.ppv_mm_s), color: S.impact, label: 'BS 5228-2 impact' });
    }
    if (V.fit && Number.isFinite(V.fit.K)) series.push({ x: distances, y: distances.map((x) => V.fit.K * Math.pow(x, -V.fit.n)), color: S.fit, dash: [4, 3], label: 'site fit' });
    if (V.pts.length) series.push({ x: V.pts.map((p) => p.x_m), y: V.pts.map((p) => p.v_mm_s), color: S.measurements, label: 'measurements', points: true, width: 0.1 });
    drawXYChart(c1, { title: 'PPV vs distance', xLabel: 'distance (m)', yLabel: 'PPV (mm/s)', logY: true, series, hlines: Number.isFinite(V.assess.limit_mm_s) ? [{ y: V.assess.limit_mm_s, label: `limit ${fmt(V.assess.limit_mm_s, 2)} mm/s` }] : [], vlines: [{ x: V.x, label: `receiver ${fmt(V.x, 0)} m` }] });
  }
  if (c2 && V.plan.frequencyTable?.length) {
    const t = V.plan.frequencyTable;
    drawXYChart(c2, { xLabel: 'frequency (Hz)', yLabel: 'mm/s', series: [{ x: t.map((r) => r.f), y: t.map((r) => r.vKar), color: S.characteristic, label: 'V_kar (characteristic)' }, { x: t.map((r) => r.f), y: t.map((r) => r.vAllow), color: S.limit, label: 'allowable (stop)' }, { x: t.map((r) => r.f), y: t.map((r) => r.warning), color: S.warning, dash: [4, 3], label: 'warning' }], vlines: [{ x: V.f, label: `f = ${fmt(V.f, 0)} Hz` }], yMin: 0 });
  }
}
