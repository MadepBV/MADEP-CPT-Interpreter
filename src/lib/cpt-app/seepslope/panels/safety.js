// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/safety.js — the two c-phi reduction read-outs of the deformation results panel
// (refactor step 9f). Moved verbatim out of legacy-controller.js:
//   stage6BishopSafetyCurveHtml     4163-4328 → safetyCurveHtml(solver)
//   stage6BishopSafetyMechanismHtml 4330-4359 → safetyMechanismHtml(mechanism)
// Both are pure functions of the solver block.
import { compactNumber as stage6CompactNumber, escAttr as stage6EscAttr } from '../../core/format.js';

/** The ΣMsf / |u| continuation curve, its table and its SVG. */
export function safetyCurveHtml(solver){
  if(!solver || solver.analysisType !== 'safety-cphi') return '';
  const rawCurve = Array.isArray(solver.safetyCurve) ? solver.safetyCurve : [];
  const rawTargets = Array.isArray(solver.safetyTrialTargets) && solver.safetyTrialTargets.length
    ? solver.safetyTrialTargets
    : (Array.isArray(solver.safetyTrialHistory) ? solver.safetyTrialHistory : []);
  const curve = rawCurve
    .map((point, index)=>({
      index:Number.isFinite(Number(point?.index)) ? Number(point.index) : index,
      trialIndex:Number.isFinite(Number(point?.trialIndex)) ? Number(point.trialIndex) : null,
      sigmaMsf:Number(point?.sigmaMsf),
      uMm:1000 * Math.abs(Number(point?.uMaxAbs) || 0),
      nonlinearIterations:Number(point?.nonlinearIterations) || 0,
      linearIterations:Number(point?.linearIterations) || 0,
      activeCount:Number(point?.activeCount) || 0,
      maxDeltaPlasticStrain:Number(point?.maxDeltaPlasticStrain) || 0
    }))
    .filter((point)=>Number.isFinite(point.sigmaMsf) && Number.isFinite(point.uMm));
  if(!curve.length && rawTargets.length){
    rawTargets.forEach((trial, index)=>{
      if(trial?.converged !== true) return;
      const sigmaMsf = Number(trial?.sigmaMsfCommitted ?? trial?.committed ?? trial?.sigmaMsfTarget ?? trial?.target);
      const uMm = 1000 * Math.abs(Number(trial?.incrementalDisplacementMaxAbs) || 0);
      if(Number.isFinite(sigmaMsf) && Number.isFinite(uMm)){
        curve.push({
          index,
          trialIndex:Number.isFinite(Number(trial?.index)) ? Number(trial.index) : index,
          sigmaMsf,
          uMm,
          nonlinearIterations:Number(trial?.iterations) || 0,
          linearIterations:0,
          activeCount:0,
          maxDeltaPlasticStrain:Number(trial?.maxAccumulatedPlasticIncrement) || 0
        });
      }
    });
  }
  if(!curve.length) return '';

  const lower = Number(solver.safetyFactorOfSafetyLower);
  const upperRaw = Number(solver.safetyFactorOfSafetyUpper);
  const upper = Number.isFinite(upperRaw) && upperRaw > 0 ? upperRaw : null;
  const displayed = Number(solver.safetyDisplayedSigmaMsf);
  const failedTargets = rawTargets
    .map((trial, index)=>({
      index:Number.isFinite(Number(trial?.index)) ? Number(trial.index) : index,
      trialIndex:Number.isFinite(Number(trial?.index)) ? Number(trial.index) : index,
      target:Number(trial?.sigmaMsfTarget ?? trial?.target),
      committed:Number(trial?.sigmaMsfCommitted ?? trial?.committed),
      converged:trial?.converged === true,
      displayed:trial?.displayed === true,
      uMm:1000 * Math.abs(Number(trial?.incrementalDisplacementMaxAbs) || 0)
    }))
    .filter((trial)=>trial.converged === false && Number.isFinite(trial.target));
  const findCurveForSigma = (sigmaMsf)=>{
    if(!Number.isFinite(sigmaMsf)) return curve[curve.length - 1];
    let best = curve[0];
    let bestDiff = Math.abs(best.sigmaMsf - sigmaMsf);
    for(const point of curve){
      const diff = Math.abs(point.sigmaMsf - sigmaMsf);
      if(diff < bestDiff){
        best = point;
        bestDiff = diff;
      }
    }
    return best;
  };
  const targetMarkerPoint = (target)=>{
    const sameTrial = curve.filter((point)=>point.trialIndex === target.trialIndex);
    if(sameTrial.length) return sameTrial[sameTrial.length - 1];
    if(Number.isFinite(target.committed)) return findCurveForSigma(target.committed);
    return curve[curve.length - 1];
  };

  const allX = curve.map((point)=>point.uMm);
  const allY = curve.map((point)=>point.sigmaMsf);
  failedTargets.forEach((target)=>{
    allY.push(target.target);
    if(target.uMm > 0) allX.push(target.uMm);
    else allX.push(targetMarkerPoint(target)?.uMm || 0);
  });
  if(Number.isFinite(lower)) allY.push(lower);
  if(Number.isFinite(upper)) allY.push(upper);
  if(Number.isFinite(displayed)) allY.push(displayed);

  const width = 520;
  const height = 220;
  const ml = 48;
  const mr = 18;
  const mt = 18;
  const mb = 38;
  const pw = width - ml - mr;
  const ph = height - mt - mb;
  const xMaxRaw = Math.max(...allX, 0);
  const xMax = xMaxRaw > 1e-9 ? xMaxRaw * 1.08 : 1;
  const yMinRaw = Math.min(...allY, 1);
  const yMaxRaw = Math.max(...allY, 1.01);
  const yPad = Math.max((yMaxRaw - yMinRaw) * 0.08, 0.01);
  const yMin = Math.max(1, yMinRaw - yPad);
  const yMax = Math.max(yMin + 0.01, yMaxRaw + yPad);
  const px = (uMm)=>ml + Math.min(Math.max(uMm / xMax, 0), 1) * pw;
  const py = (sigmaMsf)=>mt + (1 - Math.min(Math.max((sigmaMsf - yMin) / (yMax - yMin), 0), 1)) * ph;
  const path = curve.map((point, index)=>`${index === 0 ? 'M' : 'L'} ${px(point.uMm).toFixed(1)} ${py(point.sigmaMsf).toFixed(1)}`).join(' ');
  const xTicks = [0, xMax / 2, xMax];
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const finalPoint = findCurveForSigma(Number.isFinite(lower) ? lower : curve[curve.length - 1].sigmaMsf);
  const displayedPoint = Number.isFinite(displayed) ? findCurveForSigma(displayed) : null;
  const bracketBand = Number.isFinite(lower) && Number.isFinite(upper) && upper > lower
    ? `<rect x="${ml}" y="${py(upper).toFixed(1)}" width="${pw}" height="${Math.max(1, py(lower) - py(upper)).toFixed(1)}" fill="var(--acl)" opacity="0.45"></rect>`
    : '';
  const failedMarkers = failedTargets.map((target)=>{
    const anchor = targetMarkerPoint(target);
    const x = target.uMm > 0 ? target.uMm : (anchor?.uMm || 0);
    return `<g>
      <line x1="${px(x).toFixed(1)}" x2="${px(x).toFixed(1)}" y1="${py(target.target).toFixed(1)}" y2="${py(anchor?.sigmaMsf || target.target).toFixed(1)}" stroke="var(--bad)" stroke-width="1" stroke-dasharray="3 3" opacity="0.75"></line>
      <path d="M ${px(x).toFixed(1)} ${(py(target.target) - 5).toFixed(1)} l 5 10 h -10 z" fill="var(--bad)">
        <title>Failed target ${target.index + 1}: SigmaMsf ${stage6EscAttr(target.target.toFixed(3))}</title>
      </path>
    </g>`;
  }).join('');
  const acceptedMarkers = curve.map((point)=>`
    <circle cx="${px(point.uMm).toFixed(1)}" cy="${py(point.sigmaMsf).toFixed(1)}" r="2.6" fill="var(--ac)">
      <title>Step ${point.index + 1}: SigmaMsf ${stage6EscAttr(point.sigmaMsf.toFixed(3))}, u ${stage6EscAttr(point.uMm.toFixed(2))} mm, active ${point.activeCount}</title>
    </circle>
  `).join('');
  const finalMarker = finalPoint ? `
    <circle cx="${px(finalPoint.uMm).toFixed(1)}" cy="${py(Number.isFinite(lower) ? lower : finalPoint.sigmaMsf).toFixed(1)}" r="5" fill="none" stroke="var(--tx)" stroke-width="1.8">
      <title>Reported lower-bound FoS ${Number.isFinite(lower) ? stage6EscAttr(lower.toFixed(3)) : '—'}</title>
    </circle>
  ` : '';
  const displayedMarker = displayedPoint && Math.abs((Number.isFinite(lower) ? lower : displayedPoint.sigmaMsf) - displayed) > 1e-8 ? `
    <circle cx="${px(displayedPoint.uMm).toFixed(1)}" cy="${py(displayed).toFixed(1)}" r="4" fill="var(--chart-orange, #8A620D)" opacity="0.9">
      <title>Displayed SigmaMsf ${stage6EscAttr(displayed.toFixed(3))}</title>
    </circle>
  ` : '';
  const axis = `
    ${xTicks.map((tick)=>`<g><line x1="${px(tick).toFixed(1)}" x2="${px(tick).toFixed(1)}" y1="${mt}" y2="${mt + ph}" stroke="var(--bd)" stroke-width="1"></line><text x="${px(tick).toFixed(1)}" y="${height - 12}" text-anchor="middle">${stage6EscAttr(tick.toFixed(tick >= 10 ? 0 : 1))}</text></g>`).join('')}
    ${yTicks.map((tick)=>`<g><line x1="${ml}" x2="${ml + pw}" y1="${py(tick).toFixed(1)}" y2="${py(tick).toFixed(1)}" stroke="var(--bd)" stroke-width="1"></line><text x="${ml - 8}" y="${(py(tick) + 3).toFixed(1)}" text-anchor="end">${stage6EscAttr(tick.toFixed(3))}</text></g>`).join('')}
    <line x1="${ml}" x2="${ml + pw}" y1="${mt + ph}" y2="${mt + ph}" stroke="var(--tx2)" stroke-width="1.2"></line>
    <line x1="${ml}" x2="${ml}" y1="${mt}" y2="${mt + ph}" stroke="var(--tx2)" stroke-width="1.2"></line>
    <text x="${ml + pw / 2}" y="${height - 1}" text-anchor="middle">u max (mm)</text>
    <text x="12" y="${mt + ph / 2}" text-anchor="middle" transform="rotate(-90 12 ${mt + ph / 2})">SigmaMsf</text>
  `;
  return `
    <div class="st6-safety-curve">
      <div class="st6-safety-curve-head">
        <strong>Safety curve</strong>
        <span>FoS ${Number.isFinite(lower) ? lower.toFixed(3) : '—'}${Number.isFinite(upper) && upper > lower ? ` - ${upper.toFixed(3)}` : ''}</span>
      </div>
      <svg class="st6-safety-curve-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Safety curve SigmaMsf versus displacement">
        ${axis}
        ${bracketBand}
        <path d="${path}" fill="none" stroke="var(--ac)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></path>
        ${acceptedMarkers}
        ${failedMarkers}
        ${displayedMarker}
        ${finalMarker}
      </svg>
      <div class="st6-safety-curve-legend">
        <span><i class="accepted"></i> accepted</span>
        <span><i class="failed"></i> failed target</span>
        <span><i class="reported"></i> reported FoS</span>
      </div>
    </div>
  `;
}

/** The failure-mechanism summary of a converged safety run. */
export function safetyMechanismHtml(mechanism){
  if(!mechanism) return '';
  const activeElements = Math.max(Math.round(Number(mechanism.activePlasticElementCount) || 0), 0);
  const largestComponent = Math.max(Math.round(Number(mechanism.largestConnectedComponentElementCount) || 0), 0);
  const activePoints = Math.max(Math.round(Number(mechanism.activePlasticPointCount) || 0), 0);
  const components = Math.max(Math.round(Number(mechanism.connectedComponentCount) || 0), 0);
  const score = Number(mechanism.score) || 0;
  const threshold = Number(mechanism.threshold) || 0.65;
  const flags = [
    mechanism.mechanismTouchesLoadedZone ? 'loaded zone' : '',
    mechanism.mechanismTouchesFreeSurface ? 'free surface' : '',
    mechanism.mechanismTouchesBoundary ? 'outer boundary' : '',
    mechanism.mechanismCrossesSlopeOrFoundationZone ? 'connected path' : ''
  ].filter(Boolean);
  return `
    <div class="info st6-safety-mechanism" style="background:var(--bg2);border-color:var(--bd2)">
      <strong>Mechanism</strong>
      <div class="st6-safety-mechanism-grid">
        <span>Status</span><b>${stage6EscAttr(mechanism.status || 'none')}</b>
        <span>Score</span><b>${stage6CompactNumber(score, 3)} / ${stage6CompactNumber(threshold, 3)}</b>
        <span>Active elements</span><b>${activeElements}</b>
        <span>Largest component</span><b>${largestComponent} of ${components || 0}</b>
        <span>Active points</span><b>${activePoints}</b>
        <span>Length</span><b>${stage6CompactNumber(Number(mechanism.mechanismLength) || 0, 3)} m</b>
        <span>Direction coherence</span><b>${stage6CompactNumber(Number(mechanism.displacementDirectionCoherence) || 0, 3)}</b>
        <span>Contact</span><b>${flags.length ? flags.map(stage6EscAttr).join(', ') : 'none'}</b>
      </div>
    </div>
  `;
}
