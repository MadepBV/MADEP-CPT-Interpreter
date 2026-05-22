#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-pipeline regression for HS geostatic seeding. This goes through
// analyzeDeformationModel rather than the direct WASM harness so the JS
// initial-stress builder is covered.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  __resetDeformationWasmModuleForTests,
  __setDeformationWasmModuleForTests
} from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

async function loadWasmModule() {
  const glue = await import(pathToFileURL(resolve('static/wasm/deformation/deformation.js')).href);
  const factory = glue.default || glue.createDeformationModule;
  const wasmBinary = readFileSync(resolve('static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function hardeningSoilMaterial() {
  const nearSurfaceMinConfiningStress = envNumber('MADEP_HS_APP_NEAR_SURFACE_MIN', 1);
  const cEff = envNumber('MADEP_HS_APP_C_EFF', 0);
  const phiEffDeg = envNumber('MADEP_HS_APP_PHI_EFF_DEG', 30);
  const k0 = envNumber('MADEP_HS_APP_K0', 0.5);
  const ocr = envNumber('MADEP_HS_APP_OCR', 1);
  const useTensionCutoff = envBool('MADEP_HS_APP_TENSION_CUTOFF', true);
  const hs = {
    E50_ref: 30000,
    Eoed_ref: 30000,
    Eur_ref: 90000,
    m: 0.5,
    nu_ur: 0.2,
    p_ref: 100,
    Rf: 0.9,
    K0_nc: k0,
    OCR: ocr,
    e_init: -1,
    e_max: -1,
    nearSurfaceMinConfiningStress,
    useConsistentTangent: envBool('MADEP_HS_APP_USE_SH_TANGENT', true)
  };
  return {
    id: 'hs-sand',
    label: 'HS sand',
    Emc: 30000,
    E50_ref: hs.E50_ref,
    Eoed_ref: hs.Eoed_ref,
    Eur_ref: hs.Eur_ref,
    m: hs.m,
    nu: 0.3,
    nu_ur: hs.nu_ur,
    cEff,
    phiEffDeg,
    psiEffDeg: 0,
    gamma: 18,
    gammaSat: 18,
    K0nc: k0,
    rShear: 0.25,
    sigmaTAllow: 0,
    useTensionCutoff,
    nearSurfaceMinConfiningStress,
    hs
  };
}

function appModel() {
  return {
    terrain: { vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
    phreatic: null,
    regions: [{
      id: 'domain',
      label: 'Domain',
      polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: -20 }, { x: 0, y: -20 }],
      material: hardeningSoilMaterial()
    }],
    analysisLeftX: 0,
    analysisRightX: 20,
    analysisBottomY: -20,
    analysisTopY: 0,
    walls: [],
    surfaceLoad: { xStart: 9, xEnd: 11, q: 5 },
    seepage: null
  };
}

function appOptions() {
  return {
    analysisType: 'deformation',
    meshElementType: 't3',
    meshTargetArea: 1.3,
    loadMode: 'pressure',
    constitutiveModel: 'hardening-soil',
    outOfPlaneLength: 10,
    useSeepagePorePressures: false,
    initialStressMode: 'plastic-geostatic',
    residualRelTol: envNumber('MADEP_HS_APP_RESIDUAL_REL_TOL', 1e-3),
    residualAbsTol: envNumber('MADEP_HS_APP_RESIDUAL_ABS_TOL', 1e-3),
    displacementRelTol: 1e-4,
    displacementAbsTol: 1e-6,
    nonlinearMaxIterations: 32,
    initialLoadStep: 0.25,
    minLoadStep: envNumber('MADEP_HS_APP_MIN_LOAD_STEP', 1 / 2048),
    maxLoadSteps: Math.max(1, Math.round(envNumber('MADEP_HS_APP_MAX_LOAD_STEPS', 512))),
    loadStepGrowthFactor: 1.25,
    loadStepCutbackFactor: 0.5,
    plasticLoadStepGrowthFactor: 1.05,
    plasticLoadStepCutbackFactor: 0.4,
    useUnsymmetricPlasticSolver: true,
    preconditionerLevel: 'jacobi',
    wasmRobustNonlinearMode: envBool('MADEP_HS_APP_ROBUST_NONLINEAR', false),
    requestedContinuationMode: process.env.MADEP_HS_APP_CONTINUATION_MODE || 'auto',
    useWasmCpuPipeline: true,
    useNewGpuPipeline: false
  };
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());
  try {
    const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
    const result = await analyzeDeformationModel({ model: appModel(), options: appOptions() });
    const solver = result?.solver || {};
    const activeSetCounts = Array.from({ length: 8 }, () => 0);
    const tangentModeCounts = new Map();
    let maxGammaP = 0;
    let maxPP = 0;
    for (const element of result?.elementResults || []) {
      for (const gp of element?.gaussPoints || []) {
        const hs = gp?.materialDiagnostics?.hs || gp?.materialState?.hs || null;
        if (!hs) continue;
        const activeSet = Number(hs.lastActiveSet) || 0;
        if (activeSet >= 0 && activeSet < activeSetCounts.length) activeSetCounts[activeSet] += 1;
        const tangentMode = hs.tangentMode || 'unknown';
        tangentModeCounts.set(tangentMode, (tangentModeCounts.get(tangentMode) || 0) + 1);
        maxGammaP = Math.max(maxGammaP, Number(hs.gammaP) || 0);
        maxPP = Math.max(maxPP, Number(hs.pP) || 0);
      }
    }
    const summary = {
      converged: solver.converged,
      loadFactorCommitted: solver.loadFactorCommitted,
      initialPredictorMode: solver.initialPredictorMode,
      initialPredictorSeedMode: solver.initialPredictorSeedMode,
      geostaticInitializationMethod: solver.geostaticInitializationMethod,
      geostaticIterations: solver.geostaticIterations,
      initialPhaseConvergenceState: solver.initialPhaseConvergenceState,
      servicePhaseConvergenceState: solver.servicePhaseConvergenceState,
      failureCode: solver.failureCode,
      failureReason: solver.failureReason,
      terminalFailureCode: solver.terminalFailureCode,
      terminalFailureReason: solver.terminalFailureReason,
      acceptedLoadSteps: solver.acceptedLoadSteps,
      rejectedLoadSteps: solver.rejectedLoadSteps,
      nonlinearIterations: solver.nonlinearIterations,
      linearIterations: solver.linearIterations,
      residualNorm: solver.residualNorm,
      hsPlasticUsedGmres: solver.hsPlasticUsedGmres,
      lastHsFailureCode: solver.lastHsFailureCode,
      activeSetCounts,
      tangentModeCounts: Object.fromEntries(tangentModeCounts),
      maxGammaP,
      maxPP
    };
    console.log('HS app analytical-K0 seed summary:', summary);
    assert.equal(solver.initialPredictorMode, 'hs-analytical-k0');
    assert.equal(solver.initialPredictorSeedMode, 'analytical-k0');
    assert.equal(solver.geostaticInitializationMethod, 'hs-analytical-k0');
    assert.ok(
      Number(solver.geostaticIterations) > 0,
      `expected elastic predictor CG metadata to be retained, got ${solver.geostaticIterations}`
    );
    assert.equal(solver.converged, true);
    assert.equal(solver.servicePhaseConvergenceState, 'converged');
    assert.ok(Math.abs((Number(solver.loadFactorCommitted) || 0) - 1) <= 1e-8);
    assert.equal(solver.hsPlasticUsedGmres, true);
    console.log('HS app analytical-K0 seed verification PASSED.');
  } finally {
    __resetDeformationWasmModuleForTests();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
