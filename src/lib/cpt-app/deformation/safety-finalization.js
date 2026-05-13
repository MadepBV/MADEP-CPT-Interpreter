// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const DEFAULT_BRACKET_TOLERANCE = 0.01;
const DEFAULT_MAX_SEARCH_TRIALS = 32;
const DEFAULT_PLATEAU_WINDOW = 4;
const DEFAULT_PLATEAU_RELATIVE_TOLERANCE = 0.01;
const DEFAULT_MIN_PLATEAU_DISPLACEMENT_GROWTH = 1e-8;
const DEFAULT_MIN_PLATEAU_PLASTIC_GROWTH = 1e-8;
const BRACKET_TOLERANCE_ROUNDOFF = 1e-12;

export function normalizeSafetyFinalizationMode(value, fallback = 'legacy-bracket') {
  const fallbackMode = fallback === 'production-msf' ? 'production-msf' : 'legacy-bracket';
  return value === 'production-msf'
    ? 'production-msf'
    : value === 'legacy-bracket'
      ? 'legacy-bracket'
      : fallbackMode;
}

export function safetyFinalizationStatusFromRaw(rawStatus, rawWireStatus = null) {
  const numericWire = rawWireStatus == null ? null : Number(rawWireStatus);
  if (Number.isInteger(numericWire)) {
    if (numericWire === 0) return 'not-run';
    if (numericWire === 1) return 'bracketed-failure';
    if (numericWire === 2) return 'mechanism-developed';
    if (numericWire === 3) return 'no-failure-found';
    if (numericWire === 4) return 'numerical-nonconvergence';
    if (numericWire === 5) return 'insufficient-mechanism';
    if (numericWire === 6) return 'needs-more-steps';
  }
  const label = String(rawStatus || '').toLowerCase();
  if (label === 'not-run' || label === 'not-applicable') return 'not-run';
  if (label === 'bracketed' || label === 'bracketed-failure') return 'bracketed-failure';
  if (label === 'mechanism' || label === 'mechanism-developed') return 'mechanism-developed';
  if (label === 'no-failure-found') return 'no-failure-found';
  if (label === 'insufficient-mechanism') return 'insufficient-mechanism';
  if (label === 'needs-more-steps') return 'needs-more-steps';
  if (label === 'numerical-limit' || label === 'numerical-nonconvergence') return 'numerical-nonconvergence';
  return 'numerical-nonconvergence';
}

export function safetyStatusAliasFromFinalizationStatus(status) {
  if (status === 'not-run') return 'not-applicable';
  if (status === 'bracketed-failure') return 'bracketed';
  if (status === 'mechanism-developed') return 'mechanism-developed';
  if (status === 'no-failure-found') return 'no-failure-found';
  if (status === 'insufficient-mechanism') return 'insufficient-mechanism';
  if (status === 'needs-more-steps') return 'needs-more-steps';
  return 'numerical-nonconvergence';
}

function finiteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function plateauEvidence(curve, options = {}) {
  const points = Array.isArray(curve)
    ? curve.filter((point) => Number.isFinite(Number(point?.sigmaMsf)))
    : [];
  const windowSize = Math.max(Math.round(Number(options?.safetyMechanismPlateauWindow) || DEFAULT_PLATEAU_WINDOW), 2);
  if (points.length < windowSize) {
    return { detected: false, start: null, end: null };
  }
  const window = points.slice(-windowSize);
  const first = window[0];
  const last = window[window.length - 1];
  const firstSigma = Number(first?.sigmaMsf) || 1;
  const lastSigma = Number(last?.sigmaMsf) || firstSigma;
  const relativeSigmaChange = Math.abs(lastSigma - firstSigma) / Math.max(lastSigma, 1);
  const plateauRelativeTolerance = Math.max(
    Number(options?.safetyMechanismPlateauRelativeTolerance) || DEFAULT_PLATEAU_RELATIVE_TOLERANCE,
    1e-4
  );
  if (relativeSigmaChange > plateauRelativeTolerance) {
    return { detected: false, start: null, end: null };
  }

  const uGrowth = Math.max((Number(last?.uMaxAbs) || 0) - (Number(first?.uMaxAbs) || 0), 0);
  const plasticGrowth = Math.max(
    (Number(last?.maxDeltaPlasticStrain) || 0) - (Number(first?.maxDeltaPlasticStrain) || 0),
    0
  );
  const minDisplacementGrowth = Math.max(
    Number(options?.safetyMechanismMinIncrementalDisplacementNorm) || DEFAULT_MIN_PLATEAU_DISPLACEMENT_GROWTH,
    0
  );
  const minPlasticGrowth = Math.max(
    Number(options?.safetyMechanismMinPlasticIncrement) || DEFAULT_MIN_PLATEAU_PLASTIC_GROWTH,
    0
  );
  const detected = uGrowth >= minDisplacementGrowth || plasticGrowth >= minPlasticGrowth;
  return {
    detected,
    start: detected ? (Number.isFinite(Number(first?.index)) ? Number(first.index) : points.length - window.length) : null,
    end: detected ? (Number.isFinite(Number(last?.index)) ? Number(last.index) : points.length - 1) : null
  };
}

export function buildSafetyFinalization({
  mode,
  rawStatus,
  rawWireStatus = null,
  factorOfSafetyLower,
  factorOfSafetyUpper = null,
  strengthRetained,
  displayedSigmaMsf,
  mechanism,
  curve = [],
  trialTargets = [],
  options = {}
}) {
  const finalizationMode = normalizeSafetyFinalizationMode(mode);
  const rawFinalStatus = safetyFinalizationStatusFromRaw(rawStatus, rawWireStatus);
  const lower = Math.max(finiteNumber(factorOfSafetyLower, 1), 1);
  const finiteUpper = finiteNumber(factorOfSafetyUpper, null);
  const upper = rawFinalStatus === 'no-failure-found' ? null : (finiteUpper != null && finiteUpper >= lower ? finiteUpper : null);
  const bracketWidth = upper != null ? Math.max(upper - lower, 0) : null;
  const bracketTolerance = Math.max(
    Number(options?.safetySigmaMsfBracketTolerance) || DEFAULT_BRACKET_TOLERANCE,
    1e-4
  );
  const bracketWithinTolerance = bracketWidth != null
    && bracketWidth <= bracketTolerance + BRACKET_TOLERANCE_ROUNDOFF;
  const plateau = plateauEvidence(curve, options);
  const score = Number(mechanism?.score) || 0;
  const threshold = Number(mechanism?.threshold) || 0.65;
  const mechanismStatus = mechanism?.status || 'none';
  const mechanismCoherent = mechanismStatus === 'coherent' || score >= threshold;
  const mechanismHasPlasticity = (Number(mechanism?.activePlasticElementCount) || 0) > 0;
  const maxTrials = Math.max(Math.round(Number(options?.safetyMaxSearchTrials) || DEFAULT_MAX_SEARCH_TRIALS), 1);
  const trialCount = Array.isArray(trialTargets) ? trialTargets.length : 0;
  const searchBudgetExhausted = trialCount >= maxTrials;
  const hasRejectedTrial = Array.isArray(trialTargets)
    && trialTargets.some((trial) => trial?.converged === false);

  let status = rawFinalStatus;
  if (finalizationMode === 'production-msf') {
    if (rawFinalStatus === 'not-run') {
      status = 'not-run';
    } else if (rawFinalStatus === 'no-failure-found') {
      status = 'no-failure-found';
    } else if (rawFinalStatus === 'mechanism-developed') {
      status = 'mechanism-developed';
    } else if (bracketWithinTolerance) {
      status = 'bracketed-failure';
    } else if ((plateau.detected || hasRejectedTrial) && mechanismCoherent) {
      status = 'mechanism-developed';
    } else if (rawFinalStatus === 'bracketed-failure' || searchBudgetExhausted) {
      status = searchBudgetExhausted ? 'needs-more-steps' : 'insufficient-mechanism';
    } else if (mechanismHasPlasticity) {
      status = 'insufficient-mechanism';
    } else {
      status = 'numerical-nonconvergence';
    }
  }

  return {
    status,
    factorOfSafety: lower,
    factorOfSafetyLower: lower,
    factorOfSafetyUpper: status === 'no-failure-found' ? null : upper,
    factorOfSafetyIsOpenEnded: status === 'no-failure-found',
    bracketWidth: status === 'no-failure-found' ? null : bracketWidth,
    strengthRetained: finiteNumber(strengthRetained, 1 / Math.max(lower, 1)),
    displayedSigmaMsf: finiteNumber(displayedSigmaMsf, lower),
    plateauDetected: status === 'mechanism-developed' && (plateau.detected || rawFinalStatus === 'mechanism-developed'),
    plateauWindowStart: plateau.detected ? plateau.start : null,
    plateauWindowEnd: plateau.detected ? plateau.end : null
  };
}
