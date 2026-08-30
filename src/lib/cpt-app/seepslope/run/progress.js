// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/run/progress.js — every string the three Seep / Slope runs put on screen, as pure
// functions of the state and of the worker payload. Refactor step 9c (01-monolith-map.md §2.11
// group "Workers & runs" 7582-8178 at 462fc50, §5 rows 1-3; PLAN §2 row 18c). Moved from
// legacy-controller.js (integration-r f5b4a9b):
//
//   stage6BishopMethodModeLabel 4393-4395             → methodModeLabel
//   stage6SecondsLabelFromMs 4397-4401                → secondsLabelFromMs
//   stage6SafetyFinalizationStatusFromSolver 4403-4409 → safetyFinalizationStatusFromSolver
//   stage6SeepageFlowErrorLabel 4637-4639             → seepageFlowErrorLabel
//   stage6BishopRunningMessage 4656-4660              → runningMessage(bishop)
//   stage6BishopReadyMessage 4662-4667                → readyMessage(bishop, runReady)
//   stage6BishopCompleteMessage 4669-4679             → completeMessage(result, timing)
//   stage6BishopSeepageCompleteMessage 4681-4699      → seepageCompleteMessage(result)
//   the 60-line deformation status message inlined in the deformation worker callback
//   (4024-4077)                                       → deformationCompleteMessage(status, output)
//   the two DOM values of stage6BishopUpdateProgressDom 3858-3870 → searchProgressDom(bishop)
//
// The four label helpers keep readers in the results / panel regions (step 9f); the controller
// keeps their monolith names as one-line façades. Nothing here reads `S` or touches the DOM:
// `searchProgressDom` returns the text and the bar width, the host writes them.

import { compactNumber } from '../../core/format.js';

/** The stability method as the progress line and the run button name it. */
export function methodModeLabel(mode){
  return mode === 'bishop_spencer' ? 'Bishop + Spencer check' : 'Bishop only';
}

/** A millisecond duration as `<compact> s`, `—` when it is not a finite number. */
export function secondsLabelFromMs(value){
  const ms = Number(value);
  if(!Number.isFinite(ms)) return '—';
  return `${compactNumber(ms / 1000, 3)} s`;
}

/** The seepage solver's flow-rate error as a percentage, `—` when the result carries none. */
export function seepageFlowErrorLabel(result){
  return result?.flowError != null ? `${compactNumber(100 * result.flowError, 3)} %` : '—';
}

/** The c-phi finalization status of a deformation solver block (the pre-finalization shapes included). */
export function safetyFinalizationStatusFromSolver(solver){
  const finalStatus = solver?.safetyResult?.finalization?.status;
  if(finalStatus) return finalStatus;
  const legacyStatus = solver?.safetyStatus;
  if(legacyStatus === 'bracketed') return 'bracketed-failure';
  return legacyStatus || 'not-applicable';
}

/** `bishop.progress.message` while the search worker is running. */
export function runningMessage(bishop){
  return bishop?.methodMode === 'bishop_spencer'
    ? 'Running Bishop search; Spencer will recheck the shortlist...'
    : 'Running Bishop search...';
}

/** The idle stability message: what is still missing, or what the Run button will do. */
export function readyMessage(bishop, runReady){
  if(!runReady) return 'Draw terrain, place the active CPT, and define entry and exit zones. Retaining walls, load zones, and the phreatic line are optional.';
  return bishop?.methodMode === 'bishop_spencer'
    ? 'Ready to run Bishop + Spencer check.'
    : 'Ready to run Bishop search.';
}

/** `bishop.progress.message` after a search `result` message. */
export function completeMessage(result, timing){
  if(!result?.critical) return 'Search completed with no valid slip circles.';
  const runtime = timing?.totalMs?.toFixed ? timing.totalMs.toFixed(0) : timing?.totalMs || 0;
  if(result.methodMode === 'bishop_spencer'){
    if((result.spencerConverged || 0) > 0){
      return `Search + Spencer check complete in ${runtime} ms.`;
    }
    return `Bishop search complete in ${runtime} ms; Spencer fell back to Bishop results.`;
  }
  return `Search complete in ${runtime} ms.`;
}

/** `seepage.progress.message` after a successful seepage run, by termination reason. */
export function seepageCompleteMessage(result){
  const runtime = secondsLabelFromMs(result?.timing?.totalMs);
  const flowError = seepageFlowErrorLabel(result);
  const terminationReason = result?.solver?.terminationReason || 'flow-error';
  if(terminationReason === 'time-limit'){
    return flowError !== '—'
      ? `Seepage stopped after ${runtime} at the configured runtime limit. Latest flow-rate error: ${flowError}.`
      : `Seepage stopped after ${runtime} at the configured runtime limit; showing the best available result.`;
  }
  if(terminationReason === 'interrupted'){
    return flowError !== '—'
      ? `Seepage interrupted after ${runtime}. Showing the latest solved state with flow-rate error ${flowError}.`
      : `Seepage interrupted after ${runtime}. Showing the latest solved state.`;
  }
  if(terminationReason === 'fixed-boundary'){
    return `Seepage solved in ${runtime} with a fixed phreatic boundary.`;
  }
  return `Seepage solved in ${runtime} with flow-rate error ${flowError}.`;
}

/**
 * `deformation.progress.message` after a deformation `result` message — the 60-line status of the
 * monolith's worker callback (4024-4077), verbatim. `status` is the `'success' | 'failed'` the
 * reducer derived from mesh + result, `output` the worker's `payload.output`.
 *
 * Every derivation is evaluated before the branch, exactly as the monolith did (they are all
 * optional-chained reads and cannot throw), so the failed branch is reached with the same work
 * done and the same absence of side effects.
 */
export function deformationCompleteMessage(status, output){
  const solver = output?.solver || {};
  const analysisType = solver?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const convergenceState = solver?.convergenceState || 'converged';
  const shownLoadFactor = 100 * Math.max(Number(solver?.displayedLoadFactor) || 0, 0);
  const stableLoadFactor = 100 * Math.max(Number(solver?.loadFactorCommitted) || 0, 0);
  const shownGravityFactor = 100 * Math.max(Number(solver?.initialPhaseDisplayedGravityFactor) || 0, 0);
  const initialPhaseDisplayedContinuationMode = String(solver?.initialPhaseDisplayedContinuationMode || 'gravity');
  const initialPhaseTargetLabel = initialPhaseDisplayedContinuationMode === 'predictor-to-full-gravity correction'
    ? `${shownGravityFactor.toFixed(1)}% of the predictor-to-full-gravity correction`
    : `${shownGravityFactor.toFixed(1)}% gravity`;
  const initialPhaseStarted = solver?.initialPhaseStarted === true;
  const servicePhaseStarted = solver?.servicePhaseStarted === true;
  const shownPhasePeakTensionCutoff = initialPhaseStarted && !servicePhaseStarted
    ? Math.max(Math.round(Number(solver?.initialPhasePeakTensionCutoffActiveElements ?? solver?.initialPhasePeakTensionPendingElements) || 0), 0)
    : Math.max(Math.round(Number(solver?.peakTensionCutoffActiveElements ?? solver?.peakTensionPendingElements) || 0), 0);
  const maxMcEtaLabel = shownPhasePeakTensionCutoff > 0
    ? 'n/a (tension cut-off active)'
    : output?.summaries?.hasInfiniteMcEta
      ? '∞'
    : (Number(output?.summaries?.maxMcEta) || 0).toFixed(2);
  const maxSettlementLabel = ((output?.summaries?.maxSettlement || 0) * 1000).toFixed(1);
  const maxSafetyPlasticLabel = `${(100 * (output?.summaries?.maxSafetyEquivalentPlasticIncrement || 0)).toFixed(3)} %`;
  const inadmissibleInitialCount = Math.max(Math.round(Number(output?.summaries?.inadmissibleInitialElementCount) || 0), 0);
  const inadmissibleInitialSuffix = inadmissibleInitialCount > 0
    ? ` Initial exact MC audit flagged ${inadmissibleInitialCount} inadmissible predictor element${inadmissibleInitialCount === 1 ? '' : 's'}.`
    : '';
  const safetyFinalization = solver?.safetyResult?.finalization || null;
  const safetyFinalizationStatus = safetyFinalizationStatusFromSolver(solver);
  const safetyOpenEnded = safetyFinalization?.factorOfSafetyIsOpenEnded === true
    || safetyFinalizationStatus === 'no-failure-found';
  const safetyPhysicalFailure = safetyFinalizationStatus === 'bracketed-failure'
    || safetyFinalizationStatus === 'mechanism-developed';
  const safetyPhysicalLead = safetyFinalizationStatus === 'mechanism-developed'
    ? `C-phi reduction developed a coherent mechanism at ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}.`
    : `C-phi reduction bracketed failure between ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)} and ${Number(solver?.safetyFactorOfSafetyUpper || solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}.`;
  return status === 'success'
    ? (
        analysisType === 'safety-cphi'
          ? (
              safetyPhysicalFailure
                ? `${safetyPhysicalLead} Conservative FoS ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Showing the near-failure mechanism at ΣMsf ${Number(solver?.safetyDisplayedSigmaMsf || solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Max additional settlement ${maxSettlementLabel} mm; max safety Δε̄ᵖ ${maxSafetyPlasticLabel}.${inadmissibleInitialSuffix}`
                : safetyOpenEnded
                  ? `C-phi reduction remained stable up to ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Report FoS > ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Max additional settlement ${maxSettlementLabel} mm; max safety Δε̄ᵖ ${maxSafetyPlasticLabel}.${inadmissibleInitialSuffix}`
                  : `C-phi reduction stopped at ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)} with status ${safetyFinalizationStatus.replaceAll('-', ' ')}. Treat the FoS as a lower-bound numerical result, not confirmed soil body failure. Max additional settlement ${maxSettlementLabel} mm; max safety Δε̄ᵖ ${maxSafetyPlasticLabel}.${inadmissibleInitialSuffix}`
            )
          : convergenceState === 'partial'
          ? (
              initialPhaseStarted && !servicePhaseStarted
                ? `Showing a non-converged initial self-weight equilibration state at ${initialPhaseTargetLabel}. Service loading was not started. Max settlement ${maxSettlementLabel} mm; max MC eta ${maxMcEtaLabel}.${inadmissibleInitialSuffix}`
                : `Showing a non-converged near-failure deformation state at ${shownLoadFactor.toFixed(1)}% load${shownLoadFactor > stableLoadFactor + 1e-6 ? ` (last fully converged state ${stableLoadFactor.toFixed(1)}%)` : ''}. Max settlement ${maxSettlementLabel} mm; max MC eta ${maxMcEtaLabel}.${inadmissibleInitialSuffix}`
            )
          : `Deformation screen ready. Max settlement ${maxSettlementLabel} mm; max MC eta ${maxMcEtaLabel}.${inadmissibleInitialSuffix}`
      )
    : 'Deformation solve failed.';
}

/**
 * The two values `stage6BishopUpdateProgressDom` writes on `#stage6BishopProgress` (textContent)
 * and `#stage6BishopProgressBar` (style.width). The host does the two DOM writes; this is the
 * whole of the computation.
 */
export function searchProgressDom(bishop){
  const p = bishop.progress;
  return {
    text: p.running
      ? `${methodModeLabel(bishop.methodMode)} · ${p.trial||0}/${p.total||0} Bishop trials (${(p.percent||0).toFixed(0)}%)`
      : (p.message || 'Idle'),
    width: `${Math.max(0, Math.min(100, bishop.progress.percent || 0))}%`
  };
}
