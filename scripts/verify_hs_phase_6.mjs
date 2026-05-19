#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HS Phase 6 verification — per-Gauss-point HS state into the result
// envelope plus four new HS contour modes in the Stage 6 deformation
// dropdown (spec §10 Phase 6).
//
// Tests:
//   1. Round-trip a tiny HS project end-to-end. Build a small oedometer
//      mesh, run the WASM solver, push the decoded payload through
//      `buildWasmDeformationResult`, and assert:
//        - `result.hasHardeningSoil === true`,
//        - every HS-region Gauss point carries `gp.hs` with non-null
//          gammaP / pP / epsVP / lastActiveSet,
//        - per-element `materialState.hs.gammaPMax` equals
//          `max(gp.hs.gammaP)` within the element,
//        - `materialState.hs.epsVPDilative <= 0` (sign convention).
//   2. Non-HS regression. Same shape as test 1 but with the
//      `mc-plastic` constitutive model. Asserts that
//      `result.hasHardeningSoil === false`, every `gp.hs` is null,
//      and every `materialState.hs` is null.
//   3. Contour mode IDs. Parse the helper functions out of
//      `legacy-controller.js` so we can call them directly. With
//      hasHs=true the dropdown gains the four new IDs (hsGammaP,
//      hsPP, hsEpsVPDilative, hsLastActiveSet); with hasHs=false the
//      dropdown is unchanged.
//   4. Contour value lookup. Hand-craft a synthetic result and verify
//      the four new contour modes pull the right field off
//      `materialState.hs`.
//
// NOTE on the categorical renderer: this phase keeps the existing
// continuous contour interpolation for `hsLastActiveSet` (acceptable:
// the discrete regime values 0,1,2,3,4 still read as five visually
// distinct colour stops). A proper element-fill overlay can land as a
// follow-up; the recommendation is in `docs/features/hardening-soil-model.md`
// §10 Phase 6 item 7.
//
// Reference: docs/features/hardening-soil-model.md §10 Phase 6.

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

import { encodeInputBuffer, decodeOutputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';
import { buildWasmDeformationResult } from '../src/lib/cpt-app/deformation/wasm/build-result.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

// ---------------------------------------------------------------------------
// WASM helpers
// ---------------------------------------------------------------------------

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function runAnalysis(mod, inputBytes) {
  const inputPtr = mod._malloc(inputBytes.byteLength);
  mod.HEAPU8.set(inputBytes, inputPtr);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    const status = mod._madepRunDeformationAnalysis(
      inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    if (!status) {
      const errPtr = mod._madepGetLastErrorMessage();
      const msg = mod.UTF8ToString(errPtr);
      throw new Error(`WASM solver error: ${msg}`);
    }
    const outPtr = mod.HEAPU32[outPtrSlot >> 2];
    const outLen = mod.HEAPU32[outLenSlot >> 2];
    const outBytes = new Uint8Array(outLen);
    outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._madepFreeBuffer(outPtr);
    return decodeOutputBuffer(outBytes);
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

// ---------------------------------------------------------------------------
// Mesh + elementCache builders (small T3 oedometer)
// ---------------------------------------------------------------------------

function triangleArea(corners) {
  return 0.5 * Math.abs(
    (corners[1].x - corners[0].x) * (corners[2].y - corners[0].y) -
    (corners[1].y - corners[0].y) * (corners[2].x - corners[0].x)
  );
}

function buildBMatrixT3(nodes) {
  const [a, b, c] = nodes;
  const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (!(Math.abs(area2) > 1e-12)) {
    throw new Error('Degenerate T3');
  }
  const b1 = b.y - c.y, b2 = c.y - a.y, b3 = a.y - b.y;
  const c1 = c.x - b.x, c2 = a.x - c.x, c3 = b.x - a.x;
  const invArea2 = 1 / area2;
  return [
    [b1 * invArea2, 0, b2 * invArea2, 0, b3 * invArea2, 0],
    [0, c1 * invArea2, 0, c2 * invArea2, 0, c3 * invArea2],
    [c1 * invArea2, b1 * invArea2, c2 * invArea2, b2 * invArea2, c3 * invArea2, b3 * invArea2]
  ];
}

function buildOedometerGrid({ rows, cols, lx, ly }) {
  const nodes = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      nodes.push({ x: (i / cols) * lx, y: (j / rows) * ly });
    }
  }
  const elements = [];
  const elementCell = [];
  const elementData = [];
  const cells = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const n00 = j * (cols + 1) + i;
      const n10 = n00 + 1;
      const n01 = (j + 1) * (cols + 1) + i;
      const n11 = n01 + 1;
      elements.push([n00, n10, n11]);
      elements.push([n00, n11, n01]);
      const cellCentroid = {
        x: ((i + 0.5) / cols) * lx,
        y: ((j + 0.5) / rows) * ly
      };
      const cellIdx = cells.length;
      cells.push({ regionIndex: 0, centroid: cellCentroid, triangleIndices: [elements.length - 2, elements.length - 1] });
      elementCell.push(cellIdx);
      elementCell.push(cellIdx);
      // Per-element centroid for the elementCache fallback path.
      const cornersA = [nodes[n00], nodes[n10], nodes[n11]];
      const cornersB = [nodes[n00], nodes[n11], nodes[n01]];
      elementData.push({ centroid: {
        x: (cornersA[0].x + cornersA[1].x + cornersA[2].x) / 3,
        y: (cornersA[0].y + cornersA[1].y + cornersA[2].y) / 3
      } });
      elementData.push({ centroid: {
        x: (cornersB[0].x + cornersB[1].x + cornersB[2].x) / 3,
        y: (cornersB[0].y + cornersB[1].y + cornersB[2].y) / 3
      } });
    }
  }
  return {
    elementType: 't3',
    nodes,
    elements,
    cells,
    elementCell,
    elementData,
    constraintEdges: [],
    rows,
    cols,
    lx,
    ly
  };
}

function buildElementCachesForMesh(mesh) {
  let globalIndex = 0;
  return mesh.elements.map((element, elementIndex) => {
    const corners = element.slice(0, 3).map((nodeId) => mesh.nodes[nodeId]);
    const area = triangleArea(corners);
    const centroid = {
      x: (corners[0].x + corners[1].x + corners[2].x) / 3,
      y: (corners[0].y + corners[1].y + corners[2].y) / 3
    };
    const B = buildBMatrixT3(corners);
    const dofs = Int32Array.from([
      2 * element[0], 2 * element[0] + 1,
      2 * element[1], 2 * element[1] + 1,
      2 * element[2], 2 * element[2] + 1
    ]);
    const gp = {
      gpIndex: 0,
      globalIndex,
      materialPointIndex: globalIndex,
      x: centroid.x,
      y: centroid.y,
      areaWeight: area,
      L1: 1 / 3, L2: 1 / 3, L3: 1 / 3, w: 1, areaWeightFactor: 1,
      B
    };
    globalIndex += 1;
    return {
      elementIndex,
      cellIndex: mesh.elementCell[elementIndex],
      element,
      kind: 't3',
      numGaussPoints: 1,
      nodes: element.map((nodeId) => mesh.nodes[nodeId]),
      corners,
      area,
      B,
      bMatricesPerGp: [B],
      useBBar: false,
      centroid,
      integrationPoints: [gp],
      dofs,
      freeRowIndices: null,
      assemblyLocalSlots: null
    };
  });
}

function buildOedometerFixedDofs(mesh) {
  const { rows, cols } = mesh;
  const set = new Set();
  for (let i = 0; i <= cols; i += 1) {
    const id = i;
    set.add(2 * id + 0);
    set.add(2 * id + 1);
  }
  for (let j = 0; j <= rows; j += 1) {
    const left = j * (cols + 1) + 0;
    const right = j * (cols + 1) + cols;
    set.add(2 * left + 0);
    set.add(2 * right + 0);
  }
  return [...set].sort((a, b) => a - b);
}

function makeUniformTopPressureRhs(mesh, pressure) {
  const ndof = 2 * mesh.nodes.length;
  const rhs = new Float64Array(ndof);
  const { rows, cols, lx } = mesh;
  const dx = lx / cols;
  for (let i = 0; i < cols; i += 1) {
    const left = rows * (cols + 1) + i;
    const right = left + 1;
    const half = -pressure * dx / 2;
    rhs[2 * left + 1] += half;
    rhs[2 * right + 1] += half;
  }
  return rhs;
}

function makeUniformK0Seed(numGpTotal, sigma_v, K0) {
  const arr = new Float64Array(6 * numGpTotal);
  for (let gp = 0; gp < numGpTotal; gp += 1) {
    arr[6 * gp + 0] = -K0 * sigma_v;
    arr[6 * gp + 1] = -sigma_v;
    arr[6 * gp + 2] = -K0 * sigma_v;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Region presets
// ---------------------------------------------------------------------------

function granularHsPreset() {
  return {
    Emc: 30000,
    nu: 0.3,
    cEff: 0,
    phiEffDeg: 30,
    psiEffDeg: 0,
    K0nc: 0.5,
    gamma: 0,
    gammaSat: 0,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: false,
    symmetrizeEpTangent: false,
    hs: {
      E50_ref: 30000,
      Eoed_ref: 30000,
      Eur_ref: 90000,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: 0.5,
      e_init: -1,
      e_max: -1,
      OCR: 1.0,
      nearSurfaceMinConfiningStress: 0
    }
  };
}

function mcPlasticPreset() {
  return {
    Emc: 30000,
    nu: 0.3,
    cEff: 10,
    phiEffDeg: 30,
    psiEffDeg: 0,
    K0nc: 0.5,
    gamma: 0,
    gammaSat: 0,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: false,
    symmetrizeEpTangent: false
  };
}

function defaultOpts(extra = {}) {
  return {
    nonlinearMaxIter: 64,
    maxLoadSteps: 256,
    initialLoadStep: 0.25,
    minLoadStep: 1 / 2048,
    loadStepGrowthFactor: 1.25,
    loadStepCutbackFactor: 0.5,
    plasticLoadStepGrowthFactor: 1.05,
    plasticLoadStepCutbackFactor: 0.4,
    initialGravityPlasticLoadStepGrowthFactor: 1.12,
    initialGravityPlasticLoadStepCutbackFactor: 0.5,
    residualRelTol: 1e-3,
    residualAbsTol: 1e-2,
    displacementRelTol: 1e-4,
    displacementAbsTol: 1e-7,
    cgMaxIter: 25000,
    cgRelTol: 1e-5,
    cgAbsTol: 5e-5,
    plasticLineSearchReductionFactor: 0.5,
    plasticLineSearchMinScale: 1 / 32,
    initialGravityPlasticLineSearchMinScale: 1 / 16,
    plasticLineSearchArmijoCoefficient: 1e-4,
    plasticLineSearchMaxBacktracks: 4,
    initialGravityPlasticLineSearchMaxBacktracks: 5,
    useTensionCutoff: false,
    symmetrizeTangent: false,
    useBBar: false,
    hasSurfaceLoad: true,
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Test 1 — HS round-trip
// ---------------------------------------------------------------------------

async function testHsRoundTrip(mod) {
  console.log('\n[1/4] Round-trip a tiny HS project (3x2 oedometer)');
  const mesh = buildOedometerGrid({ rows: 2, cols: 3, lx: 1.5, ly: 1.0 });
  const regions = [granularHsPreset()];
  const fixedDofs = buildOedometerFixedDofs(mesh);
  const PRESSURE = 100;
  const SIGMA_V_INITIAL = 50;
  const K0 = 0.5;
  const loadRhs = makeUniformTopPressureRhs(mesh, PRESSURE);
  const numGpTotal = mesh.elements.length;
  const initialSigmaByGp = makeUniformK0Seed(numGpTotal, SIGMA_V_INITIAL, K0);
  const ndof = 2 * mesh.nodes.length;
  const options = defaultOpts({
    constitutiveModel: 'hardening-soil',
    analysisType: 'deformation',
    useK0Init: true,
    useGeostaticInit: true
  });

  const inputBytes = encodeInputBuffer({
    mesh,
    options,
    regions,
    gravityRhsFull: new Float64Array(ndof),
    loadRhsFull: loadRhs,
    predictorSolutionFull: new Float64Array(ndof),
    initialSigmaByGp,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });
  const wasmResult = runAnalysis(mod, inputBytes);
  assert.equal(wasmResult.hasHsPayload, true, 'wire-level HS payload must be present');
  for (let gp = 0; gp < wasmResult.numGpTotal; gp += 1) {
    const state = wasmResult.gpStates[gp];
    assert.ok(state.hs !== null, `gpStates[${gp}].hs must be present for HS run`);
    assert.equal(typeof state.hs.gammaP, 'number', `gp.hs.gammaP numeric (gp=${gp})`);
    assert.equal(typeof state.hs.pP, 'number', `gp.hs.pP numeric (gp=${gp})`);
    assert.equal(typeof state.hs.epsVP, 'number', `gp.hs.epsVP numeric (gp=${gp})`);
    assert.ok(Number.isInteger(state.hs.lastActiveSet), `gp.hs.lastActiveSet integer (gp=${gp})`);
  }

  const elementCaches = buildElementCachesForMesh(mesh);
  const result = buildWasmDeformationResult({
    mesh,
    load: { q: PRESSURE, xStart: 0, xEnd: mesh.lx },
    warnings: [],
    elementCaches,
    options: { ...options, constitutiveModel: 'hardening-soil' },
    wasmResult,
    startedAt: 0,
    predictorSolution: new Float64Array(ndof),
    initialField: null,
    porePressureByIntegrationPoint: new Float64Array(numGpTotal),
    analysisType: 'deformation'
  });

  assert.equal(result.hasHardeningSoil, true, 'result.hasHardeningSoil must be true for HS run');
  assert.equal(result.elementResults.length, mesh.elements.length, 'one element-result per element');

  let maxObservedGammaP = 0;
  let totalGpsWithHs = 0;
  for (const item of result.elementResults) {
    const gps = item.gaussPoints;
    assert.ok(Array.isArray(gps) && gps.length > 0, 'element has gaussPoints');
    const hsList = gps.map((gp) => gp.materialState?.hs).filter((hs) => hs != null);
    assert.equal(hsList.length, gps.length, 'every GP in HS element has a materialState.hs');
    totalGpsWithHs += hsList.length;
    const localMaxGamma = hsList.reduce((m, hs) => Math.max(m, hs.gammaP), 0);
    if (item.materialState.hs == null) {
      throw new Error(`HS element ${item.elementIndex} missing materialState.hs aggregate`);
    }
    assert.equal(item.materialState.hs.gammaPMax, localMaxGamma,
      `materialState.hs.gammaPMax mismatch (element ${item.elementIndex}): expected ${localMaxGamma}, got ${item.materialState.hs.gammaPMax}`);
    const localMaxPp = hsList.reduce((m, hs) => Math.max(m, hs.pP), 0);
    assert.equal(item.materialState.hs.pPMax, localMaxPp,
      `materialState.hs.pPMax mismatch (element ${item.elementIndex})`);
    assert.ok(item.materialState.hs.epsVPDilative <= 0,
      `epsVPDilative must be <= 0 (got ${item.materialState.hs.epsVPDilative} on element ${item.elementIndex})`);
    assert.ok(item.materialState.hs.epsVPContractive >= 0,
      `epsVPContractive must be >= 0 (got ${item.materialState.hs.epsVPContractive} on element ${item.elementIndex})`);
    if (localMaxGamma > maxObservedGammaP) maxObservedGammaP = localMaxGamma;
  }
  assert.ok(totalGpsWithHs === wasmResult.numGpTotal,
    `total GPs with hs must equal numGpTotal (got ${totalGpsWithHs}, expected ${wasmResult.numGpTotal})`);
  console.log(`  numGpTotal=${wasmResult.numGpTotal} (all carry hs), max gammaP=${maxObservedGammaP.toExponential(3)}`);
  console.log('  PASS — HS aggregates + sign convention');
}

// ---------------------------------------------------------------------------
// Test 2 — Non-HS regression
// ---------------------------------------------------------------------------

async function testNonHsRegression(mod) {
  console.log('\n[2/4] Non-HS regression (same shape, mc-plastic)');
  const mesh = buildOedometerGrid({ rows: 2, cols: 3, lx: 1.5, ly: 1.0 });
  const regions = [mcPlasticPreset()];
  const fixedDofs = buildOedometerFixedDofs(mesh);
  const PRESSURE = 100;
  const SIGMA_V_INITIAL = 50;
  const K0 = 0.5;
  const loadRhs = makeUniformTopPressureRhs(mesh, PRESSURE);
  const numGpTotal = mesh.elements.length;
  const initialSigmaByGp = makeUniformK0Seed(numGpTotal, SIGMA_V_INITIAL, K0);
  const ndof = 2 * mesh.nodes.length;
  const options = defaultOpts({
    constitutiveModel: 'mc-plastic',
    analysisType: 'deformation',
    useK0Init: true,
    useGeostaticInit: true
  });

  const inputBytes = encodeInputBuffer({
    mesh,
    options,
    regions,
    gravityRhsFull: new Float64Array(ndof),
    loadRhsFull: loadRhs,
    predictorSolutionFull: new Float64Array(ndof),
    initialSigmaByGp,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });
  const wasmResult = runAnalysis(mod, inputBytes);
  assert.equal(wasmResult.hasHsPayload, false, 'mc-plastic run must NOT emit HS payload');
  for (let gp = 0; gp < wasmResult.numGpTotal; gp += 1) {
    assert.equal(wasmResult.gpStates[gp].hs, null, `non-HS run: gpStates[${gp}].hs must be null`);
  }

  const elementCaches = buildElementCachesForMesh(mesh);
  const result = buildWasmDeformationResult({
    mesh,
    load: { q: PRESSURE, xStart: 0, xEnd: mesh.lx },
    warnings: [],
    elementCaches,
    options: { ...options, constitutiveModel: 'mc-plastic' },
    wasmResult,
    startedAt: 0,
    predictorSolution: new Float64Array(ndof),
    initialField: null,
    porePressureByIntegrationPoint: new Float64Array(numGpTotal),
    analysisType: 'deformation'
  });

  assert.equal(result.hasHardeningSoil, false,
    `non-HS run: result.hasHardeningSoil must be false (got ${result.hasHardeningSoil})`);
  for (const item of result.elementResults) {
    assert.equal(item.materialState.hs, null,
      `non-HS element ${item.elementIndex}: materialState.hs must be null`);
    for (const gp of item.gaussPoints) {
      assert.equal(gp.materialState?.hs ?? null, null,
        `non-HS element ${item.elementIndex} gp ${gp.gpIndex}: materialState.hs must be null`);
      assert.equal(gp.materialDiagnostics?.hs ?? null, null,
        `non-HS element ${item.elementIndex} gp ${gp.gpIndex}: materialDiagnostics.hs must be null`);
    }
  }
  console.log('  PASS — non-HS regression: hasHardeningSoil=false, all materialState.hs null');
}

// ---------------------------------------------------------------------------
// Test 3 — Contour mode IDs (parse helpers out of legacy-controller.js)
// ---------------------------------------------------------------------------

function loadLegacyHelpers() {
  // The controller is one big script with no public exports for the
  // stage6 helpers, so we slice the function definitions out of the
  // source and eval them in a tiny sandbox. The functions we care about
  // are pure (no DOM, no fetch); they only touch a top-level `S` object
  // when no explicit `analysisType` is passed, which we stub to {}.
  const controllerPath = resolve(repoRoot, 'src/lib/cpt-app/legacy-controller.js');
  const source = readFileSync(controllerPath, 'utf-8');

  function sliceFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Could not find function ${name}() in controller source`);
    let depth = 0;
    let braceOpen = source.indexOf('{', start);
    if (braceOpen < 0) throw new Error(`No body found for ${name}`);
    let i = braceOpen;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, i + 1);
        }
      }
    }
    throw new Error(`Unterminated function body for ${name}`);
  }

  const code = [
    'const S = {};',
    sliceFunction('stage6BishopNormalizedDeformationAnalysisType'),
    sliceFunction('stage6BishopDeformationQuantityIds'),
    sliceFunction('stage6BishopDeformationContourMeta'),
    sliceFunction('stage6BishopDeformationFiniteScalar'),
    sliceFunction('stage6BishopDeformationElementContourValue'),
    'return { ',
    '  stage6BishopDeformationQuantityIds,',
    '  stage6BishopDeformationContourMeta,',
    '  stage6BishopDeformationFiniteScalar,',
    '  stage6BishopDeformationElementContourValue',
    '};'
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function(code);
  return factory();
}

function testContourModeIds(helpers) {
  console.log('\n[3/4] Contour mode IDs');
  const baseDeformation = helpers.stage6BishopDeformationQuantityIds('deformation', false);
  const baseSafety = helpers.stage6BishopDeformationQuantityIds('safety-cphi', false);
  const hsDeformation = helpers.stage6BishopDeformationQuantityIds('deformation', true);
  const hsSafety = helpers.stage6BishopDeformationQuantityIds('safety-cphi', true);

  const hsExtras = ['hsGammaP', 'hsPP', 'hsEpsVPDilative', 'hsLastActiveSet'];

  // No HS added when hasHs=false.
  for (const id of hsExtras) {
    assert.ok(!baseDeformation.includes(id), `non-HS deformation dropdown must NOT contain ${id}`);
    assert.ok(!baseSafety.includes(id), `non-HS safety dropdown must NOT contain ${id}`);
  }

  // HS extras appended (in that order) when hasHs=true.
  assert.equal(hsDeformation.length, baseDeformation.length + hsExtras.length);
  assert.deepEqual(hsDeformation.slice(0, baseDeformation.length), baseDeformation,
    'HS dropdown preserves the original IDs in order');
  assert.deepEqual(hsDeformation.slice(-hsExtras.length), hsExtras,
    'HS dropdown appends the four new IDs in the expected order');

  // Safety-mode with HS keeps the safety-only safetyEquivalentPlasticIncrement
  // entry AND appends the HS extras.
  assert.ok(hsSafety.includes('safetyEquivalentPlasticIncrement'),
    'HS+safety dropdown still includes safetyEquivalentPlasticIncrement');
  for (const id of hsExtras) {
    assert.ok(hsSafety.includes(id), `HS+safety dropdown must include ${id}`);
  }

  // Meta sanity: HS contour entries must have signed flags matching the spec.
  const metaGamma = helpers.stage6BishopDeformationContourMeta('hsGammaP', 'deformation');
  assert.equal(metaGamma.unit, '%');
  assert.equal(metaGamma.signed, false);
  const metaPP = helpers.stage6BishopDeformationContourMeta('hsPP', 'deformation');
  assert.equal(metaPP.unit, 'kPa');
  assert.equal(metaPP.signed, false);
  const metaEpsV = helpers.stage6BishopDeformationContourMeta('hsEpsVPDilative', 'deformation');
  assert.equal(metaEpsV.signed, true,
    'hsEpsVPDilative is a diverging-palette mode (signed)');
  const metaActive = helpers.stage6BishopDeformationContourMeta('hsLastActiveSet', 'deformation');
  assert.equal(metaActive.categorical, true,
    'hsLastActiveSet meta must carry categorical=true');

  console.log(`  hasHs=false dropdown: ${baseDeformation.length} IDs (HS extras absent)`);
  console.log(`  hasHs=true  dropdown: ${hsDeformation.length} IDs (4 HS extras appended)`);
  console.log('  PASS — dropdown gating + meta');
}

// ---------------------------------------------------------------------------
// Test 4 — Contour value lookup (synthetic result)
// ---------------------------------------------------------------------------

function testContourValueLookup(helpers) {
  console.log('\n[4/4] Contour value lookup');
  const fakeResult = {
    elementResults: [
      {
        materialState: {
          accumulatedPlasticStrain: 0,
          hs: {
            gammaPMax: 0.0123,
            pPMax: 137.5,
            epsVPContractive: 0.002,
            epsVPDilative: -0.004,
            dominantActiveSet: 3
          }
        }
      }
    ]
  };
  assert.equal(
    helpers.stage6BishopDeformationElementContourValue(fakeResult, 0, 'hsGammaP'),
    0.0123,
    'hsGammaP returns materialState.hs.gammaPMax'
  );
  assert.equal(
    helpers.stage6BishopDeformationElementContourValue(fakeResult, 0, 'hsPP'),
    137.5,
    'hsPP returns materialState.hs.pPMax'
  );
  // Dilative is reported as positive magnitude (UI sign flip).
  assert.equal(
    helpers.stage6BishopDeformationElementContourValue(fakeResult, 0, 'hsEpsVPDilative'),
    -1 * -0.004,
    'hsEpsVPDilative returns flipped sign of materialState.hs.epsVPDilative'
  );
  assert.equal(
    helpers.stage6BishopDeformationElementContourValue(fakeResult, 0, 'hsLastActiveSet'),
    3,
    'hsLastActiveSet returns materialState.hs.dominantActiveSet'
  );
  // Missing aggregate → fallback to 0 (Number-finite-or-fallback contract).
  // Use `+value === 0` to handle the -0 the sign-flipped epsVPDilative path
  // emits when the field is absent (`-1 * 0 === -0`).
  const emptyResult = { elementResults: [{ materialState: { accumulatedPlasticStrain: 0, hs: null } }] };
  for (const mode of ['hsGammaP', 'hsPP', 'hsEpsVPDilative', 'hsLastActiveSet']) {
    const value = helpers.stage6BishopDeformationElementContourValue(emptyResult, 0, mode);
    assert.ok(value === 0, `${mode}: missing aggregate returns 0 (got ${value})`);
  }
  console.log('  PASS — contour value lookup');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const helpers = loadLegacyHelpers();
  testContourModeIds(helpers);
  testContourValueLookup(helpers);

  const mod = await loadWasm();
  await testHsRoundTrip(mod);
  await testNonHsRegression(mod);

  console.log('\nHS Phase 6 verification PASSED.');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
