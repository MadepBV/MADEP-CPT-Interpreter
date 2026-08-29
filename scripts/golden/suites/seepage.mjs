// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier A lock of the seepage solver (design §1.8, §2.1, §3.3): analyzeSeepageModel
// (buildTriangleMesh → FE solve → post) on the models lifted from
// scripts/verify_seepage_phase_2.mjs and scripts/verify_seepage_drains_walls.mjs
// (fixtures/models/seepage-*.json), the point samplers on a grid, the guard errors,
// and — through the Tier B controller — the model the app builds for a CPT profile with
// side boundary conditions assigned the way stage6BishopSetSeepageBcType does.
// Triangle (Shewchuk) is deterministic for a fixed PSLG; the free-surface iteration is
// the `iterative` class. `result.timing` carries the iteration counts next to the
// millisecond timings, so it is re-exposed as `solverStats` (the *Ms keys stay masked).
import { analyzeSeepageModel, sampleSeepageHead, sampleSeepageFlowState } from '../../../src/lib/cpt-app/seepage/solver.js';
import { buildOuterBoundary, makeBoundaryCondition, seepageGeometryHash } from '../../../src/lib/cpt-app/seepage/boundary.js';
import { digest } from '../lib/normalize.mjs';

export const name = 'seepage';
export const tolerance = 'iterative';
export const description = 'Seepage: analyzeSeepageModel (mesh + FE solve + post) on the lifted models and a CPT-built model';

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in (o || {})).map((k) => [k, o[k]]));

/** Mesh: connectivity + boundary in full, per-cell geometry (derived from nodes/elements) digested. */
export function slimMesh(mesh) {
  if (!mesh) return mesh;
  const cells = mesh.cells || [];
  const regionCounts = {};
  let areaSum = 0;
  for (const cell of cells) { regionCounts[cell.regionIndex] = (regionCounts[cell.regionIndex] || 0) + 1; areaSum += Number(cell.area) || 0; }
  const faceTypeCounts = {};
  for (const f of mesh.boundaryFaces || []) faceTypeCounts[f.type] = (faceTypeCounts[f.type] || 0) + 1;
  return {
    ...pick(mesh, ['kind', 'elementType', 'nodes', 'elements', 'elementCell', 'meshStats', 'phreaticNodeIds', 'drainNodeIdsByDrain', 'drainNodeArcLengthByNode', 'drainEdgesByDrain', 'domainPolygon', 'mechanicalWalls', 'interfacePairs', 'ndofTotal', 'warnings']),
    cells: { count: cells.length, areaSum, regionCounts, digest: digest(cells) },
    elementData: digest(mesh.elementData || []),
    constraintEdges: (mesh.constraintEdges || []).map((e) => pick(e, ['n1', 'n2', 'nMid', 'markerType', 'edgeKey', 'source', 'sourceIndex', 'bcType'])),
    boundaryFaces: (mesh.boundaryFaces || []).map((f) => pick(f, ['n1', 'n2', 'edgeKey', 'source', 'sourceIndex', 'type', 'head', 'length'])),
    boundaryFaceTypeCounts: faceTypeCounts,
    elementNeighbors: mesh.elementNeighbors ? digest(mesh.elementNeighbors) : null
  };
}

/** Result: nodal heads, element fields and scalars in full; the per-cell aliases of the element fields digested. */
export function slimResult(result) {
  if (!result) return result;
  const { timing, ...rest } = result;
  const out = { ...rest };
  for (const k of ['triangleHeads', 'cellHeads', 'gradients', 'cellGradients', 'cellWetFraction', 'dryMask', 'cellDryMask']) if (k in out) out[k] = digest(out[k]);
  if (Array.isArray(out.elementGradients)) {
    // one flat row per element: [dh/dx, dh/dy, |i|, qx, qy] (object per element would be ≈ 5× the bytes)
    const keys = Object.keys(out.elementGradients[0] || {});
    out.elementGradients = { rowKeys: keys, rows: out.elementGradients.map((g) => keys.map((k) => g?.[k] ?? null)) };
  }
  out.solverStats = { ...(timing || {}) };
  return out;
}

function sampleGrid(model, mesh, result) {
  const xs = model.terrain.vertices.map((v) => v.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yTop = Math.max(...model.terrain.vertices.map((v) => v.y));
  const y0 = model.analysisBottomY;
  const out = [];
  for (let i = 1; i <= 4; i++) for (let j = 1; j <= 3; j++) {
    const x = x0 + (x1 - x0) * i / 5, y = y0 + (yTop - y0) * j / 4;
    out.push({ x, y, head: sampleSeepageHead(mesh, result, x, y), flow: sampleSeepageFlowState(mesh, result, x, y) });
  }
  return out;
}

async function* lockModel(id, model) {
  const out = await analyzeSeepageModel({ model: JSON.parse(JSON.stringify(model)) });
  yield { id: `${id}.mesh`, value: slimMesh(out.mesh) };
  yield { id: `${id}.result`, value: slimResult(out.result) };
  yield { id: `${id}.samples`, value: sampleGrid(model, out.mesh, out.result) };
  yield { id: `${id}.boundary`, value: { edges: buildOuterBoundary(model), geometryHash: seepageGeometryHash(model, model.seepage?.options || {}) } };
}

export async function* cases(ctx) {
  const fixtureNames = Object.keys(ctx.manifest.fixtures).filter((k) => /^models\/seepage-.*\.json$/.test(k)).sort();
  for (const key of fixtureNames) {
    const id = key.replace(/^models\/seepage-/, '').replace(/\.json$/, '');
    yield* lockModel(id, ctx.fixtures.json(key));
  }
  // guard paths
  const base = ctx.fixtures.json('models/seepage-base-fixed-head.json');
  const errors = {};
  for (const [label, model] of [
    ['no-terrain', { ...base, terrain: { vertices: [] } }],
    ['no-bottom', { ...base, analysisBottomY: null }],
    ['fixed-without-phreatic', { ...base, phreatic: null }]
  ]) {
    try { await analyzeSeepageModel({ model }); errors[label] = null; } catch (e) { errors[label] = String(e?.message || e); }
  }
  yield { id: 'guards', value: errors };
  yield { id: 'make-boundary-condition', value: buildOuterBoundary(base).map((edge) => makeBoundaryCondition(edge, { id: 'bc-fixed-id', type: 'head', head: edge.mid.y })) };

  // the app's model for a CPT profile (Tier B glue): terrain by state, side BCs assigned like
  // stage6BishopSelectSeepageBoundary + stage6BishopSetSeepageBcType/Head, then the solver in-process
  const c = await ctx.controller();
  const { api } = c;
  const S = await ctx.classify('layered', 'sb260');
  api.goS(3); api.goS(5);
  Object.assign(S.stage6.bishop, { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } });
  api.setStage6App('bishop');
  api.stage6BishopSetWorkspace('seepage');
  const boundary = S.stage6Cache.bishopSeepageBoundary;
  yield { id: 'cpt.layered.app-boundary', value: boundary };   // S.stage6Cache.bishopSeepageBoundary (stage6BishopCurrentSeepageBoundary)
  for (const [source, head] of [['side-left', 3.0], ['side-right', -0.5]]) {
    const edge = boundary.find((e) => e.source === source);
    api.stage6BishopSelectSeepageBoundary(edge.edgeKey);
    api.stage6BishopSetSeepageBcType('head');
    api.stage6BishopSetSeepageBcHead(head);
  }
  api.stage6BishopSetField('seepage.options.meshTargetArea', 1.0);
  yield { id: 'cpt.layered.state', value: { bcs: S.stage6.bishop.seepage.bcs, options: S.stage6.bishop.seepage.options, selectedEdgeKey: S.stage6.bishop.seepage.selectedEdgeKey, geometryHash: S.stage6.bishop.seepage.geometryHash } };
  api.stage6BishopRunSeepage();     // Node: no Worker → the guard is what the handler does today
  yield { id: 'cpt.layered.run-handler', value: { status: S.stage6.bishop.seepage.status, rejectReason: S.stage6.bishop.seepage.rejectReason } };
  const model = S.stage6Cache.bishopModel;
  yield* lockModel('cpt.layered', { ...model, seepage: { ...(model.seepage || {}), mesh: null, result: null } });
}
