#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SH-P0 prerequisite verifier for the Simo-Hughes tangent initiative.
//
// Spec: docs/features/hardening-soil-simo-hughes-upgrade.md section 0 and
// section 7 Phase SH-P0. The goal is not to validate a new tangent yet; it is to
// prove that the existing Hardening Soil return mapping reaches the T6
// flat-strip service case, develops nonzero settlement, and dispatches HS
// plastic global Newton iterations through GMRES. If this fails, later
// tangent phases are blocked until the return-map/app plumbing is fixed.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { encodeInputBuffer, decodeOutputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

const WIDTH = 10.0;
const HEIGHT = 20.0;
const ROWS = Math.max(1, Math.round(envNumber('MADEP_HS_T6_ROWS', 5)));
const COLS = Math.max(1, Math.round(envNumber('MADEP_HS_T6_COLS', 5)));
const STRIP_LEFT = 4.0;
const STRIP_RIGHT = 6.0;
const STRIP_PRESSURE = 5.0;
const GAMMA = 18.0;
const PHI_EFF_DEG = 25.0;
const K0 = 1.0 - Math.sin((PHI_EFF_DEG * Math.PI) / 180.0);
const OCR = envNumber('MADEP_HS_T6_OCR', 1.05);
const NEAR_SURFACE_MIN = envNumber('MADEP_HS_T6_SIGMA3_MIN', 0.0);
const USE_BBAR = envBool('MADEP_HS_T6_USE_BBAR', true);
const USE_GEOSTATIC_INIT = envBool('MADEP_HS_T6_USE_GEOSTATIC_INIT', true);
const MIN_LOAD_STEP = envNumber('MADEP_HS_T6_MIN_LOAD_STEP', 1 / 8192);
const MAX_LOAD_STEPS = Math.max(1, Math.round(envNumber('MADEP_HS_T6_MAX_LOAD_STEPS', 512)));
const NONLINEAR_MAX_ITER = Math.max(1, Math.round(envNumber('MADEP_HS_T6_NONLINEAR_MAX_ITER', 64)));
const T6_GAUSS = [
  { L1: 2.0 / 3.0, L2: 1.0 / 6.0, L3: 1.0 / 6.0 },
  { L1: 1.0 / 6.0, L2: 2.0 / 3.0, L3: 1.0 / 6.0 },
  { L1: 1.0 / 6.0, L2: 1.0 / 6.0, L3: 2.0 / 3.0 }
];

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function buildT6FlatStripMesh({ rows, cols, lx, ly }) {
  const nodes = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      nodes.push({
        x: (i / cols) * lx,
        y: (j / rows) * ly
      });
    }
  }

  const midpointByEdge = new Map();
  const midNode = (a, b) => {
    const key = edgeKey(a, b);
    const cached = midpointByEdge.get(key);
    if (cached !== undefined) return cached;
    const pa = nodes[a];
    const pb = nodes[b];
    const nodeId = nodes.length;
    nodes.push({
      x: 0.5 * (pa.x + pb.x),
      y: 0.5 * (pa.y + pb.y)
    });
    midpointByEdge.set(key, nodeId);
    return nodeId;
  };

  const elements = [];
  const elementCell = [];
  const cells = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const n00 = j * (cols + 1) + i;
      const n10 = n00 + 1;
      const n01 = (j + 1) * (cols + 1) + i;
      const n11 = n01 + 1;
      const cellCentroid = {
        x: ((i + 0.5) / cols) * lx,
        y: ((j + 0.5) / rows) * ly
      };

      const cellA = cells.length;
      cells.push({ regionIndex: 0, centroid: cellCentroid });
      elements.push([
        n00,
        n10,
        n11,
        midNode(n10, n11),
        midNode(n11, n00),
        midNode(n00, n10)
      ]);
      elementCell.push(cellA);

      const cellB = cells.length;
      cells.push({ regionIndex: 0, centroid: cellCentroid });
      elements.push([
        n00,
        n11,
        n01,
        midNode(n11, n01),
        midNode(n01, n00),
        midNode(n00, n11)
      ]);
      elementCell.push(cellB);
    }
  }

  return {
    elementType: 't6',
    nodes,
    elements,
    cells,
    elementCell,
    rows,
    cols,
    lx,
    ly,
    midNode
  };
}

function buildFixedDofs(mesh) {
  const fixed = new Set();
  const tol = 1e-12;
  for (let nodeId = 0; nodeId < mesh.nodes.length; nodeId += 1) {
    const p = mesh.nodes[nodeId];
    if (Math.abs(p.y) <= tol) {
      fixed.add(2 * nodeId + 0);
      fixed.add(2 * nodeId + 1);
    }
    if (Math.abs(p.x) <= tol || Math.abs(p.x - mesh.lx) <= tol) {
      fixed.add(2 * nodeId + 0);
    }
  }
  return [...fixed].sort((a, b) => a - b);
}

function triangleArea(mesh, el) {
  const a = mesh.nodes[el[0]];
  const b = mesh.nodes[el[1]];
  const c = mesh.nodes[el[2]];
  return 0.5 * Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

function makeT6GravityRhs(mesh, gamma) {
  const rhs = new Float64Array(2 * mesh.nodes.length);
  for (const el of mesh.elements) {
    const share = -gamma * triangleArea(mesh, el) / 3.0;
    // T6 corner-shape integrals vanish for a constant body force; the
    // three midpoint nodes carry the constant gravity load.
    for (let k = 3; k < 6; k += 1) {
      rhs[2 * el[k] + 1] += share;
    }
  }
  return rhs;
}

function makeT6TopStripRhs(mesh, pressure, xStart, xEnd) {
  const rhs = new Float64Array(2 * mesh.nodes.length);
  const topJ = mesh.rows;
  const dx = mesh.lx / mesh.cols;
  const alignmentTol = 1e-10;
  for (let i = 0; i < mesh.cols; i += 1) {
    const left = topJ * (mesh.cols + 1) + i;
    const right = left + 1;
    const xa = mesh.nodes[left].x;
    const xb = mesh.nodes[right].x;
    const overlap = Math.max(0, Math.min(xb, xEnd) - Math.max(xa, xStart));
    if (!(overlap > 0)) continue;
    if (Math.abs(overlap - dx) > alignmentTol) {
      throw new Error('SH-P0 strip load must align with T6 top edges for exact quadratic edge integration.');
    }
    const mid = mesh.midNode(left, right);
    rhs[2 * left + 1] += -pressure * overlap / 6.0;
    rhs[2 * mid + 1] += -pressure * overlap * (2.0 / 3.0);
    rhs[2 * right + 1] += -pressure * overlap / 6.0;
  }
  return rhs;
}

function makeDepthK0Seed(mesh, gamma, k0) {
  const numGpTotal = mesh.elements.length * 3;
  const sigma = new Float64Array(6 * numGpTotal);
  for (let e = 0; e < mesh.elements.length; e += 1) {
    const el = mesh.elements[e];
    const a = mesh.nodes[el[0]];
    const b = mesh.nodes[el[1]];
    const c = mesh.nodes[el[2]];
    for (let gpLocal = 0; gpLocal < 3; gpLocal += 1) {
      const gpRule = T6_GAUSS[gpLocal];
      const y = gpRule.L1 * a.y + gpRule.L2 * b.y + gpRule.L3 * c.y;
      const sigmaV = Math.max((mesh.ly - y) * gamma, 0.0);
      const gp = 3 * e + gpLocal;
      sigma[6 * gp + 0] = -k0 * sigmaV;
      sigma[6 * gp + 1] = -sigmaV;
      sigma[6 * gp + 2] = -k0 * sigmaV;
    }
  }
  return sigma;
}

function hsRegion() {
  return {
    Emc: 30000,
    nu: 0.3,
    cEff: 5,
    phiEffDeg: PHI_EFF_DEG,
    psiEffDeg: 0,
    K0nc: K0,
    gamma: GAMMA,
    gammaSat: GAMMA,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: false,
    symmetrizeEpTangent: false,
    E50_ref: 30000,
    Eoed_ref: 30000,
    Eur_ref: 90000,
    m: 0.5,
    nu_ur: 0.2,
    hs: {
      E50_ref: 30000,
      Eoed_ref: 30000,
      Eur_ref: 90000,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: K0,
      e_init: -1,
      e_max: -1,
      OCR,
      nearSurfaceMinConfiningStress: NEAR_SURFACE_MIN
    }
  };
}

function defaultOptions() {
  return {
    constitutiveModel: 'hardening-soil',
    analysisType: 'deformation',
    nonlinearMaxIter: NONLINEAR_MAX_ITER,
    maxLoadSteps: MAX_LOAD_STEPS,
    initialLoadStep: 0.1,
    minLoadStep: MIN_LOAD_STEP,
    loadStepGrowthFactor: 1.2,
    loadStepCutbackFactor: 0.5,
    plasticLoadStepGrowthFactor: 1.1,
    plasticLoadStepCutbackFactor: 0.5,
    initialGravityPlasticLoadStepGrowthFactor: 1.1,
    initialGravityPlasticLoadStepCutbackFactor: 0.5,
    residualRelTol: 1e-3,
    residualAbsTol: 1e-2,
    displacementRelTol: 1e-4,
    displacementAbsTol: 1e-7,
    cgMaxIter: 25000,
    cgRelTol: 1e-6,
    cgAbsTol: 1e-6,
    plasticLineSearchReductionFactor: 0.5,
    plasticLineSearchMinScale: 1 / 32,
    initialGravityPlasticLineSearchMinScale: 1 / 16,
    plasticLineSearchArmijoCoefficient: 1e-4,
    plasticLineSearchMaxBacktracks: 5,
    initialGravityPlasticLineSearchMaxBacktracks: 5,
    useTensionCutoff: false,
    symmetrizeTangent: false,
    useBBar: USE_BBAR,
    useK0Init: true,
    useGeostaticInit: USE_GEOSTATIC_INIT,
    robustNonlinearMode: false,
    hasSurfaceLoad: true
  };
}

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function runAnalysis(mod, inputBytes) {
  const inputPtr = mod._malloc(inputBytes.byteLength);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    mod.HEAPU8.set(inputBytes, inputPtr);
    const ok = mod._madepRunDeformationAnalysis(inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    if (!ok) {
      throw new Error(`WASM solver error: ${mod.UTF8ToString(mod._madepGetLastErrorMessage())}`);
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

function summarizeHsState(decoded) {
  const activeSetCounts = new Map();
  let maxGammaP = 0;
  let plasticEverCount = 0;
  for (const gp of decoded.gpStates) {
    const activeSet = gp.hs?.lastActiveSet ?? 0;
    activeSetCounts.set(activeSet, (activeSetCounts.get(activeSet) ?? 0) + 1);
    if (gp.hs?.gammaP > maxGammaP) maxGammaP = gp.hs.gammaP;
    if (gp.plasticEverActive) plasticEverCount += 1;
  }
  return { activeSetCounts, maxGammaP, plasticEverCount };
}

function settlementMm(decoded) {
  let minUy = 0;
  for (let nodeId = 0; nodeId < decoded.numNodes; nodeId += 1) {
    minUy = Math.min(minUy, decoded.displacements[2 * nodeId + 1]);
  }
  return -minUy * 1000.0;
}

async function main() {
  const mesh = buildT6FlatStripMesh({ rows: ROWS, cols: COLS, lx: WIDTH, ly: HEIGHT });
  const fixedDofs = buildFixedDofs(mesh);
  const numGpTotal = mesh.elements.length * 3;
  const loadRhsFull = makeT6TopStripRhs(mesh, STRIP_PRESSURE, STRIP_LEFT, STRIP_RIGHT);
  const loadSum = Array.from(loadRhsFull).reduce((sum, value) => sum + value, 0);

  const inputBytes = encodeInputBuffer({
    mesh,
    options: defaultOptions(),
    regions: [hsRegion()],
    gravityRhsFull: makeT6GravityRhs(mesh, GAMMA),
    loadRhsFull,
    initialSigmaByGp: makeDepthK0Seed(mesh, GAMMA, K0),
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });

  const mod = await loadWasm();
  const decoded = runAnalysis(mod, inputBytes);
  const settleMm = settlementMm(decoded);
  const hsSummary = summarizeHsState(decoded);
  const activeSetSummary = [...hsSummary.activeSetCounts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([activeSet, count]) => `${activeSet}:${count}`)
    .join(' ');

  console.log('SH-P0 T6 flat-strip summary:', {
    nodes: mesh.nodes.length,
    elements: mesh.elements.length,
    numGpTotal,
    decodedNodes: decoded.numNodes,
    decodedElements: decoded.numElements,
    loadSum,
    OCR,
    nearSurfaceMinConfiningStress: NEAR_SURFACE_MIN,
    useBBar: USE_BBAR,
    useGeostaticInit: USE_GEOSTATIC_INIT,
    minLoadStep: MIN_LOAD_STEP,
    maxLoadSteps: MAX_LOAD_STEPS,
    nonlinearMaxIter: NONLINEAR_MAX_ITER,
    geostaticConverged: decoded.summary.geostaticConverged,
    serviceConverged: decoded.summary.serviceConverged,
    finalLoadFactor: decoded.summary.finalLoadFactor,
    geostaticLoadFactor: decoded.summary.geostaticLoadFactor,
    residualNorm: decoded.summary.residualNorm,
    newtonIterations: decoded.summary.newtonIterations,
    cgIterations: decoded.summary.cgIterations,
    loadStepsAccepted: decoded.summary.loadStepsAccepted,
    loadStepsRejected: decoded.summary.loadStepsRejected,
    finalActiveCount: decoded.summary.finalActiveCount,
    lastLinearSolverKind: decoded.summary.lastLinearSolverKind,
    hsPlasticUsedGmres: decoded.summary.hsPlasticUsedGmres,
    settlementMm: settleMm
  });
  console.log(`  active-set histogram: ${activeSetSummary}`);
  console.log(`  plasticEverCount=${hsSummary.plasticEverCount} maxGammaP=${hsSummary.maxGammaP.toExponential(6)}`);

  if (decoded.numGpTotal !== numGpTotal) {
    throw new Error(`Expected ${numGpTotal} T6 Gauss points, got ${decoded.numGpTotal}`);
  }
  if (!decoded.hasHsPayload) {
    throw new Error('Output does not carry the HS payload');
  }
  if (!decoded.summary.geostaticConverged) {
    throw new Error('Geostatic phase did not converge');
  }
  if (!decoded.summary.serviceConverged || Math.abs(decoded.summary.finalLoadFactor - 1.0) > 1e-12) {
    throw new Error(`Service phase did not reach full load (lambda=${decoded.summary.finalLoadFactor})`);
  }
  if (!(settleMm > 0.01 && settleMm < 20.0)) {
    throw new Error(`Settlement ${settleMm} mm is outside the nonzero engineering band`);
  }
  if (!(decoded.summary.finalActiveCount > 0 || hsSummary.plasticEverCount > 0)) {
    throw new Error('HS plasticity was not activated on the SH-P0 strip case');
  }
  if (!decoded.summary.hsPlasticUsedGmres) {
    throw new Error('HS plasticity did not dispatch through GMRES');
  }

  console.log('PASS: SH-P0 T6 flat-strip prerequisite reached full service load with HS plastic GMRES dispatch.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
