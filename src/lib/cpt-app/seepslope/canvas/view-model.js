// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/view-model.js — the one pure derivation step between the Seep / Slope state and
// the drawing (refactor step 9e, PLAN §2 row 18e; 01-monolith-map.md §6.3 item 4: "single functions
// with ~130 local derivations shared across the template; they must be split by … draw layer **with
// an explicit view-model**").
//
// `stage6BishopDrawCanvas` (1 139 lines) opened with a run of local `const`s and then closed over
// them from fourteen drawing blocks. That closure is what made the function unsplittable. This
// module is that run of locals, as one pure function:
//
//     state + results + viewport  →  viewModel
//
// and every `draw/*.js` layer takes `(ctx2d, viewModel, theme)`. Nothing here reads `S`, the DOM,
// the canvas or the clock, and **nothing here writes**: the model cache write the monolith did on
// the same line (`S.stage6Cache.bishopModel = model`) stays in the host sequencer, and PR 18b's
// fix — a frame must not mutate the state (PLAN §4 defect 3) — is a property of this file being
// pure. The verifier asserts it (N frames leave `S.stage6.bishop` byte-identical).
//
// The host `env` carries the derivations whose source region is not extracted yet:
//   · the seepage-contour catalogue      (map §2.11 "Seepage state + contours")
//   · the deformation-contour catalogue  (map §2.11 "Deformation contours")
//   · the wall-response overlay + the selected search result (map §2.11 "Result HTML / labels",
//     step 9f)
//   · the seepage boundary and its selection / hover (map §2.11 "Seepage BC handlers")
// Everything else is imported from the packages PRs 18a–d already carved out.
import { displayRegions, showingCustomRegionPreview } from '../geometry/regions.js';
import { selectedCustomRegion } from '../state/regions.js';
import { wallEndpoints } from '../../wall-geometry.js';
import { gridSpec, worldToScreen } from './viewport.js';
import { snapWorldPoint } from './picking.js';

/** The three-way workspace switch the whole frame branches on. */
export function canvasWorkspace(bishop){
  return bishop.workspace === 'seepage' ? 'seepage' : bishop.workspace === 'deformation' ? 'deformation' : 'stability';
}

/**
 * Every derivation the fourteen draw layers share.
 *
 * @param input  `{bishop, model, viewport, width, height, hoverWorld, excludeKey}` — `width` /
 *               `height` are the canvas' CSS pixels, `model` the section model the host built for
 *               this frame, `hoverWorld` the pointer's last world point (or null), `excludeKey` the
 *               drag key excluded from snap candidates.
 * @param env    the host hooks listed in the file header.
 */
export function buildCanvasViewModel(input, env){
  const { bishop, model, viewport, width, height, hoverWorld = null, excludeKey = '' } = input;
  const workspace = canvasWorkspace(bishop);
  const deformationAnalysisType = env.normalizedDeformationAnalysisType();

  const vm = {
    env,
    bishop,
    model,
    viewport,
    width,
    height,
    hoverWorld,
    workspace,
    deformationAnalysisType,
    /** World → screen for this frame's viewport (the monolith's stage6BishopWorldToScreen). */
    toScreen: (pt)=>worldToScreen(pt, viewport),
    /** The snap the hover previews apply, with this frame's drag exclusion. */
    snap: (pt, mode)=>snapWorldPoint(pt, mode, bishop, viewport, excludeKey),
    /** The terrain in the `{vertices}` shape `terrainY` wants — built once, not per block. */
    terrain: {vertices: bishop.terrain},
    /** The background grid, or `{show:false}` when the lines would crowd (< 18 px apart). */
    grid: gridSpec(viewport, width, height, bishop.snapSize)
  };

  // ── soil regions ────────────────────────────────────────────────────────────────────────────
  vm.regions = {
    show: !!model && bishop.display?.showRegions !== false,
    showLabels: bishop.display?.showRegionLabels !== false,
    items: displayRegions(model, bishop),
    preview: showingCustomRegionPreview(model),
    opacity: bishop.display?.regionOpacity ?? 0.22,
    selectedId: bishop.selectedRegionId
  };

  // ── seepage field ───────────────────────────────────────────────────────────────────────────
  const seepageMesh = bishop.seepage?.mesh || null;
  const seepageResult = bishop.seepage?.result || null;
  vm.seepage = null;
  if(workspace === 'seepage' && seepageMesh && seepageResult){
    const contourMode = bishop.seepage?.display?.contourMode || 'head';
    const contourDerived = env.seepageContourDerived(seepageResult, seepageMesh, contourMode);
    vm.seepage = {
      mesh: seepageMesh,
      result: seepageResult,
      display: bishop.seepage.display,
      contourMode,
      contourDerived,
      stats: contourDerived.stats
    };
  }

  // ── deformation field ───────────────────────────────────────────────────────────────────────
  const deformationMesh = bishop.deformation?.mesh || null;
  const deformationResult = bishop.deformation?.result || null;
  vm.deformation = null;
  if(workspace === 'deformation' && deformationMesh && deformationResult){
    const contourMode = bishop.deformation?.display?.contourMode || 'uTotal';
    const contourDerived = env.deformationContourDerived(deformationResult, deformationMesh, contourMode);
    const dispScale = Math.max(Number(bishop.deformation?.options?.displacementScale) || 1, 0.05);
    const vectorMode = env.deformationVectorMode(contourMode);
    const vectorReference = vectorMode
      ? Math.max(
          (deformationResult?.nodalDisplacements || []).reduce((max, disp)=>{
            const ux = Number(disp?.ux) || 0;
            const uy = Number(disp?.uy) || 0;
            const mag = contourMode === 'ux'
              ? Math.abs(ux)
              : contourMode === 'uy' || contourMode === 'settlement'
                ? Math.abs(uy)
                : Math.hypot(ux, uy);
            return Math.max(max, mag);
          }, 0),
          1e-12
        )
      : 1e-12;
    vm.deformation = {
      mesh: deformationMesh,
      result: deformationResult,
      display: bishop.deformation?.display,
      contourMode,
      contourDerived,
      stats: contourDerived.stats,
      dispScale,
      vectorMode,
      vectorReference,
      /** A mesh node at its displaced position, in screen coordinates. */
      deformedPoint: (nodeId)=>{
        const node = deformationMesh.nodes?.[nodeId];
        const disp = deformationResult.nodalDisplacements?.[nodeId];
        return vm.toScreen({
          x:(node?.x || 0) + (disp?.ux || 0) * dispScale,
          y:(node?.y || 0) + (disp?.uy || 0) * dispScale
        });
      }
    };
  }

  // ── the slip-circle results (computed unconditionally, drawn in `stability` only) ────────────
  const results = bishop.results?.allResults || [];
  vm.circles = {
    results,
    keepBest: Math.min(results.length, bishop.search.keepBest || 10),
    selectedIndex: bishop.selectedResult || 0,
    previewCircle: bishop.progress?.running ? bishop.progress.previewCircle : null,
    selected: workspace === 'stability' ? env.selectedResult() : null
  };

  // ── the seepage boundary conditions ─────────────────────────────────────────────────────────
  vm.boundary = null;
  if(workspace === 'seepage' && model && bishop.seepage?.display?.showBoundaryConditions !== false){
    vm.boundary = {
      edges: env.seepageBoundary(model),
      selected: env.selectedBoundaryEdge(model),
      hovered: env.hoveredSeepageEdge(model),
      showLabels: bishop.seepage.display?.showBoundaryLabels !== false
    };
  }

  // ── the active-CPT marker ───────────────────────────────────────────────────────────────────
  vm.cptMarker = null;
  if(Number.isFinite(bishop.activeCptX) && bishop.terrain.length >= 2){
    vm.cptMarker = { x: bishop.activeCptX, offset: Number(bishop.cptInsertionOffset) || 0 };
  }

  // ── the edit-mode handles ───────────────────────────────────────────────────────────────────
  vm.editHandles = bishop.tool === 'edit' ? handlePoints(bishop) : null;

  // ── the polygon the split / hole tools and the vertex handles work on ────────────────────────
  vm.selectedRegion = selectedCustomRegion(bishop);

  return vm;
}

/**
 * Every point the Edit tool shows a round handle on: terrain and phreatic vertices, both endpoints
 * of every wall, every drain vertex and the selected custom polygon's vertices. Kept as its own
 * function because it is also the answer to "what can be grabbed" (`picking.nearestHandle` builds
 * the same set with its kinds and indices attached).
 */
export function handlePoints(bishop){
  return [
    ...(bishop.terrain || []),
    ...(bishop.phreatic || []),
    ...(bishop.walls || []).flatMap((wall)=>{
      const endpoints = wallEndpoints(wall);
      return endpoints ? [endpoints.head, endpoints.tip] : [];
    }),
    ...(bishop.drains || []).flatMap((drain)=>drain.vertices || []),
    ...((bishop.customRegions?.length ? selectedCustomRegion(bishop)?.polygon : []) || [])
  ];
}
