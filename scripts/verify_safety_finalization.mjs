#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {
  buildSafetyFinalization,
  normalizeSafetyFinalizationMode,
  safetyStatusAliasFromFinalizationStatus
} from '../src/lib/cpt-app/deformation/safety-finalization.js';

const coherentMechanism = {
  status: 'coherent',
  score: 0.82,
  threshold: 0.65,
  activePlasticElementCount: 12
};
const scatteredMechanism = {
  status: 'scattered',
  score: 0.21,
  threshold: 0.65,
  activePlasticElementCount: 3
};
const emptyMechanism = {
  status: 'none',
  score: 0,
  threshold: 0.65,
  activePlasticElementCount: 0
};

assert.equal(normalizeSafetyFinalizationMode(undefined), 'legacy-bracket');
assert.equal(normalizeSafetyFinalizationMode(undefined, 'production-msf'), 'production-msf');
assert.equal(normalizeSafetyFinalizationMode('legacy-bracket', 'production-msf'), 'legacy-bracket');

const base = {
  factorOfSafetyLower: 1.46,
  factorOfSafetyUpper: 1.467,
  strengthRetained: 1 / 1.46,
  displayedSigmaMsf: 1.467,
  curve: [
    { index: 0, sigmaMsf: 1.45, uMaxAbs: 0.001, maxDeltaPlasticStrain: 0.001 },
    { index: 1, sigmaMsf: 1.455, uMaxAbs: 0.0015, maxDeltaPlasticStrain: 0.0015 },
    { index: 2, sigmaMsf: 1.459, uMaxAbs: 0.002, maxDeltaPlasticStrain: 0.002 },
    { index: 3, sigmaMsf: 1.46, uMaxAbs: 0.003, maxDeltaPlasticStrain: 0.003 }
  ],
  options: {
    safetySigmaMsfBracketTolerance: 0.01,
    safetyMaxSearchTrials: 32,
    safetyMechanismPlateauWindow: 4,
    safetyMechanismPlateauRelativeTolerance: 0.01,
    safetyMechanismMinIncrementalDisplacementNorm: 1e-8,
    safetyMechanismMinPlasticIncrement: 1e-8
  }
};

const legacy = buildSafetyFinalization({
  ...base,
  mode: 'legacy-bracket',
  rawStatus: 'bracketed',
  mechanism: scatteredMechanism,
  trialTargets: [{ converged: false }]
});
assert.equal(legacy.status, 'bracketed-failure');
assert.equal(safetyStatusAliasFromFinalizationStatus(legacy.status), 'bracketed');

const productionBracket = buildSafetyFinalization({
  ...base,
  mode: 'production-msf',
  rawStatus: 'bracketed',
  mechanism: scatteredMechanism,
  trialTargets: [{ converged: false }]
});
assert.equal(productionBracket.status, 'bracketed-failure');
assert.equal(productionBracket.factorOfSafety, productionBracket.factorOfSafetyLower);

const productionBracketAtRoundoffBoundary = buildSafetyFinalization({
  ...base,
  mode: 'production-msf',
  rawStatus: 'bracketed',
  factorOfSafetyLower: 1.4609375,
  factorOfSafetyUpper: 1.4709375000000001,
  mechanism: coherentMechanism,
  trialTargets: [{ converged: false }]
});
assert.equal(productionBracketAtRoundoffBoundary.status, 'bracketed-failure');

const productionMechanism = buildSafetyFinalization({
  ...base,
  mode: 'production-msf',
  rawStatus: 'numerical-limit',
  factorOfSafetyUpper: 1.58,
  mechanism: coherentMechanism,
  trialTargets: [{ converged: false }]
});
assert.equal(productionMechanism.status, 'mechanism-developed');
assert.equal(productionMechanism.factorOfSafety, productionMechanism.factorOfSafetyLower);

const productionScattered = buildSafetyFinalization({
  ...base,
  mode: 'production-msf',
  rawStatus: 'numerical-limit',
  factorOfSafetyUpper: null,
  mechanism: scatteredMechanism,
  trialTargets: [{ converged: false }]
});
assert.equal(productionScattered.status, 'insufficient-mechanism');

const productionOpenEnded = buildSafetyFinalization({
  ...base,
  mode: 'production-msf',
  rawStatus: 'no-failure-found',
  factorOfSafetyUpper: 1.5,
  mechanism: emptyMechanism,
  trialTargets: [{ converged: true }]
});
assert.equal(productionOpenEnded.status, 'no-failure-found');
assert.equal(productionOpenEnded.factorOfSafetyUpper, null);
assert.equal(productionOpenEnded.factorOfSafetyIsOpenEnded, true);
assert.equal(safetyStatusAliasFromFinalizationStatus(productionOpenEnded.status), 'no-failure-found');

const productionNeedsMoreSteps = buildSafetyFinalization({
  ...base,
  mode: 'production-msf',
  rawStatus: 'bracketed',
  factorOfSafetyUpper: 1.60,
  mechanism: scatteredMechanism,
  trialTargets: Array.from({ length: 32 }, () => ({ converged: false }))
});
assert.equal(productionNeedsMoreSteps.status, 'needs-more-steps');

console.log('Safety finalization checks passed.');
