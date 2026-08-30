export const meta = {
  name: 'madep-cp-engineering-audit',
  description: 'Exhaustive engineering audit of madep-cp (implementation errors, perf/memory, doc-vs-code scientific consistency, dead code). Each auditor writes its own /audit report. Batched via args to survive rate limits.',
  phases: [
    { title: 'Audit', detail: 'one domain-expert auditor per subsystem; each writes its own /audit report' },
    { title: 'Synthesis', detail: 'cross-implementation parity + completeness critic' },
  ],
}

const ROOT = '/Users/mathiasdepelsmaeker/Projects/madep-cp'
const AUDIT_DIR = ROOT + '/audit'

const APP_CONTEXT = `
You are a senior computational-geomechanics + numerical-methods + software engineer auditing
"madep-cp" (MADEP CPT Interpreter), a browser-based (SvelteKit/Svelte5 + JS + WebGPU/WGSL + C++/WASM)
geotechnical app for Belgian/Dutch practice. It interprets Cone Penetration Test (CPT) data and runs
Stage-6 checks: EC7 shallow bearing capacity, settlement, dewatering, Bishop-Simplified + Spencer slope
stability, steady-state 2D FEM seepage, plane-strain T3/T6 FEM deformation (linear-elastic, Mohr-Coulomb,
Hardening-Soil), beam/slab-on-elastic-foundation (Winkler/Pasternak), retaining walls, piles, EC2
reinforcement screening. Standards: Robertson 1990 & 2016, NEN 6740, NEN Tabel 3 / Eurocode 7, CUR. Repo
root and working dir: ${ROOT} (use absolute paths).

This is engineering-critical scientific software: a wrong formula, sign error, unit slip, wrong constant,
bad return-mapping/consistent-tangent, wrong convergence criterion, or a doc that disagrees with the code
can produce a plausible-but-wrong engineering answer. Numerical and constitutive correctness is the top
priority.
`.trim()

const DIMENSIONS = `
Audit FOUR dimensions; tag every finding with its category:

A — IMPLEMENTATION MISTAKES & ERRORS: logic/sign/index/off-by-one bugs, wrong constants, unit
   inconsistencies (kPa/MPa, kN/N, rad/deg, gamma_w 9.81 vs 10), wrong governing equation, incorrect FEM
   assembly / shape functions / Gauss quadrature / Jacobian / B-matrix, bad BC application, incorrect
   return-mapping or consistent tangent, wrong yield/potential surface, wrong K0 / stress init, bad
   convergence/tolerance logic, races, NaN/Inf handling, broken error handling, incorrect JS<->WASM<->GPU
   serialization, wrong DOF ordering/striding.
B — MEMORY LEAKS & PERFORMANCE: leaks (listeners/observers/workers/GPU buffers/WASM heap never freed,
   retained closures, growing arrays/maps, unbounded caches), O(n^2)+ hot loops, per-iteration allocation,
   dense-where-sparse, missing memoization, redundant recompute, main-thread blocking, large copies across
   worker/WASM/GPU boundaries.
C — DOC vs CODE CONSISTENCY (and which is scientifically correct): compare code against paired docs
   (docs/*.md and in-app docs src/routes/docs/**). For each discrepancy state (1) what the doc says, (2)
   what the code does, (3) which is scientifically/standards correct and why (cite the governing
   equation/standard), (4) fix direction (fix code or fix doc).
D — DEAD CODE: unused exports/functions/vars/branches, unreachable code, orphaned files, commented-out
   blocks, flag-disabled paths, superseded implementations, duplicate logic. FLAG ONLY — never delete or
   edit source.
`.trim()

const SELF_VERIFY = `
Before finalizing: re-open and independently double-check every finding you intend to mark critical or
high. If you cannot confirm it directly from the actual code/doc, either downgrade it and set
confidence=uncertain, or drop it. Do not pad the report with plausible-but-unconfirmed claims; precision
beats volume. But DO be exhaustive on a large subsystem — a thin report is a failure.
`.trim()

function reportTemplate(u, outPath) {
  return `
## Deliverable
Using the Write tool, write ONE markdown file to EXACTLY this path: ${outPath}
Do NOT modify or create any other file. Do NOT edit source code. Read freely (Read/Grep/Bash for wc/grep).

Use this structure exactly:

# Audit — ${u.title}
**Subsystem key:** ${u.key}
**Files reviewed:** <comma list of files you actually read>
**Finding counts:** critical=N high=N medium=N low=N info=N  |  A=N B=N C=N D=N  |  total=N

## Overview
<2-5 sentence honest health summary of this subsystem.>

## Findings
Group by category in order A, B, C, D. Within each, order by severity (critical -> info). For EACH finding:

### [${u.key.toUpperCase()}-A-01] critical · <short title>
- **Location:** \`file.js:123\` (and any related lines)
- **Category:** A — Implementation
- **Confidence:** confirmed | likely | uncertain
- **Analysis:** <evidence; quote the offending code; explain what is wrong; for A/C give the scientific
  reasoning and which side (doc or code) is correct, citing the governing equation/standard.>
- **Recommendation:** <suggested fix direction — we will NOT apply it now.>

(Repeat for every finding. Use stable ids ${u.key.toUpperCase()}-<A|B|C|D>-NN.)

## Notes / limitations of this audit pass
<what you could not fully verify, assumptions, areas needing a second pass.>

After writing the file, return a SHORT plain-text summary (<= 8 lines): the path, the counts line, and the
2-4 highest-severity finding titles. The file is the deliverable; keep the returned text terse.
`.trim()
}

function auditorPrompt(u, outPath) {
  return [
    APP_CONTEXT,
    `\n## Your subsystem: ${u.title}  (key: ${u.key})`,
    u.focus.trim(),
    `\n### Code files (read the numerically/critically important ones in full; map huge files with wc/grep first):\n` +
      u.files.map((f) => '- ' + ROOT + '/' + f).join('\n'),
    u.docs && u.docs.length
      ? `\n### Paired documentation to cross-reference (dimension C):\n` +
          u.docs.map((d) => '- ' + ROOT + '/' + d).join('\n')
      : `\n(No tightly-paired docs; still check inline comments / README claims for dimension C.)`,
    `\n## Dimensions\n` + DIMENSIONS,
    `\n## Self-verification\n` + SELF_VERIFY,
    `\n` + reportTemplate(u, outPath),
  ].join('\n')
}

const UNITS = [
  { key: 'def-materials', title: 'Constitutive models — Mohr-Coulomb & Hardening Soil (JS)',
    files: ['src/lib/cpt-app/deformation/material-models.js', 'src/lib/cpt-app/deformation/material.js', 'src/lib/cpt-app/deformation/material-plugin.js'],
    docs: ['docs/deformation/MC.md', 'docs/deformation/MC_pl.md', 'docs/deformation/ML_pl_fix.md', 'docs/deformation/material-plugin-architecture.md', 'docs/features/hardening-soil-simo-hughes-implementation-log.md'],
    focus: `The constitutive integration — the most error-prone code. Verify Mohr-Coulomb: yield function and
      sign convention (is compression negative or positive here?), non-associated potential with dilatancy
      psi, return-mapping (smooth vs corner/apex return, the apex/tension-cutoff singularity), consistent
      (algorithmic) tangent vs continuum tangent, spectral decomposition / principal-stress eigen-derivatives.
      Hardening Soil: stress-dependent stiffness (E50, Eoed, Eur, power m, pref), deviatoric (shear) hardening
      with Rf, cap hardening, the Simo-Hughes implementation. Cross-check formulas against MC.md / MC_pl.md /
      HS log and state which is scientifically correct. Watch sign conventions, deg vs rad, divide-by-zero
      near apex, tangent symmetry.` },
  { key: 'def-solver', title: 'Deformation FEM — JS CPU solver & elements',
    files: ['src/lib/cpt-app/deformation/solver.js', 'src/lib/cpt-app/deformation/element-kernel.js', 'src/lib/cpt-app/deformation/element-t3.js', 'src/lib/cpt-app/deformation/element-t6.js'],
    docs: ['docs/deformation/T6_mesh.md', 'docs/deformation/geostatic-init.md', 'src/routes/docs/engineering/deformation/+page.svelte'],
    focus: `Core plane-strain FEM (the trusted CPU reference). Verify B-matrix/strain-displacement for T3
      (constant strain) and T6 (quadratic), Gauss quadrature points/weights, Jacobian determinant & area
      sign/orientation (CCW), plane-strain elastic D-matrix factors and out-of-plane sigma_zz term, element
      stiffness assembly, global DOF ordering (2/node), Dirichlet BC (penalty vs elimination, symmetry),
      traction/body-force (gravity) load vectors, geostatic K0 initial stress, Newton-Raphson loop,
      residual/force convergence norms & tolerances, stress recovery. Map functions first, deep-read assembly
      + integration + Newton.` },
  { key: 'bishop-spencer', title: 'Slope stability — Bishop Simplified & Spencer',
    files: ['src/lib/cpt-app/stage6-bishop.js', 'src/lib/cpt-app/stage6-bishop-worker.js', 'src/lib/cpt-app/stage6-canvas-utils.js'],
    docs: ['docs/bishop/bishop_simplified_v1_spec.html', 'docs/bishop/spencer_extension_v2_spec.html', 'docs/bishop/retaining_walls_extension_spec.md', 'src/routes/docs/engineering/bishop/+page.svelte', 'docs/deformation/ENGINEERING_AUDIT.md'],
    focus: `Limit-equilibrium. Bishop Simplified F = Σ[(c'·b + (W - u·b)·tanφ')/m_α] / Σ[W·sinα], m_α = cosα +
      sinα·tanφ'/F, fixed-point on F. VERIFY pore-pressure uplift uses u·b (slice width) not u·l — the prior
      audit fixed exactly this; confirm it stayed fixed (stage6-bishop.js around line 628). Spencer: force +
      moment equilibrium with interslice inclination θ, two-equation Newton for (F,θ). Check slice
      discretization, circular slip-surface search, tension-crack handling, submerged unit weights,
      surcharge/line loads, retaining-wall extension, FoS tol (1e-4). Cross-check the HTML specs and in-app
      doc; state which is correct. Watch base-angle sign, negative m_α (steep base), water-table uplift.` },
  { key: 'seepage', title: 'Steady-state 2D FEM seepage (Triangle mesh, drains, BCs)',
    files: ['src/lib/cpt-app/seepage/solver.js', 'src/lib/cpt-app/seepage/boundary.js', 'src/lib/cpt-app/seepage/drains.js', 'src/lib/cpt-app/seepage/material.js', 'src/lib/cpt-app/seepage/mesh-triangle.js', 'src/lib/cpt-app/seepage/pslg.js', 'src/lib/cpt-app/seepage/triangle-runtime.js', 'src/lib/cpt-app/seepage/seepage-worker.js'],
    docs: ['docs/seep/seepage_analysis_v1_spec.md', 'docs/seep/drain.md', 'docs/seep/seepage_fix.md', 'src/routes/docs/engineering/seepage/+page.svelte'],
    focus: `Steady groundwater flow: Darcy/Laplace FEM (anisotropic kx,ky), unconfined free-surface (phreatic)
      iteration (element on/off or reduced-permeability above water table), BCs (fixed-head Dirichlet, flux
      Neumann, seepage face h=z complementarity), drains/wells (head=elevation sink), Triangle WASM mesher.
      Verify element conductivity matrix, free-surface convergence loop, mass conservation / flux, seepage-face
      complementarity (h<=z and q outward), hydraulic FS contour. Cross-check seepage_analysis_v1_spec.md and
      drain.md. Watch flux sign, elevation-head convention, phreatic non-convergence.` },
  { key: 'stage6-engineering', title: 'Stage 6 — bearing capacity, settlement, dewatering, EC2 reinforcement',
    files: ['src/lib/cpt-app/stage6-engineering.js'],
    docs: ['src/routes/docs/engineering/bearing/+page.svelte', 'src/routes/docs/engineering/settlement/+page.svelte', 'src/routes/docs/engineering/dewatering/+page.svelte', 'src/routes/docs/engineering/reinforcement/+page.svelte', 'docs/logic.md', 'scripts/ec2_durability.py'],
    focus: `EC7 shallow bearing capacity: Nq=e^{π tanφ}tan²(45+φ/2), Nc=(Nq-1)cotφ, Nγ — verify exact form
      (Vesic 2(Nq+1)tanφ vs EC7 Annex D 2(Nq-1)tanφ) against the doc; shape/depth/inclination/base/ground
      factors; drained vs undrained (φ=0, Nc=5.14); effective-area (Meyerhof eccentricity). Settlement
      (elastic/Oedometer/strain-influence). Dewatering (Dupuit/Thiem, influence radius). EC2 reinforcement
      (design moment->As, min/max steel, cover) cross-checked against scripts/ec2_durability.py (reference).
      Cross-check every formula/partial-factor against the paired in-app docs; state which is correct. Watch φ
      deg vs rad inside trig, Nγ convention, water-table effective-stress.` },
  { key: 'cpt-classification', title: 'CPT soil classification (Robertson 1990/2016, NEN 6740, CUR, EC7 Tabel 3)',
    files: ['src/lib/cpt-app/legacy-controller.js', 'src/lib/cpt-app/nen6740.js', 'src/lib/cpt-app/soil-regions.js', 'src/lib/cpt-app/soil-styles.js'],
    docs: ['docs/logic.md', 'docs/classification/robertson-2016.md', 'docs/classification/nen6740.md', 'docs/deformation/ENGINEERING_AUDIT.md'],
    focus: `Classification math only. Robertson 1990 SBT (Ic, normalized Qt/Fr, Qtn iteration with stress
      exponent n), Robertson 2016 SBTn, NEN 6740 (nen6740.js — NEN6740_RF_SLOPE constant, 0.67 stress
      correction, nearest-score), CUR broad zones, EC7/NEN Tabel 3 routing, soil-region point-in-polygon, color
      mapping. Verify Ic formula, Qtn iteration convergence, boundary thresholds, log/log10 base, atmospheric
      pressure pa, and that prior ENGINEERING_AUDIT.md resolutions match current code. Watch boundary
      off-by-one and normalization exponents.` },
  { key: 'cpt-parameters', title: 'Geotechnical parameter derivation & PLAXIS export',
    files: ['src/lib/cpt-app/legacy-controller.js'],
    docs: ['docs/logic.md', 'docs/plaxis/plaxis_matdb_export.md', 'docs/classification/nen6740.md'],
    focus: `Parameter derivation from the interpreted profile: unit weights gamma/gamma_sat, phi', su (Nkt),
      stiffness (E50, Eoed, Eur, m, stress-dependent fitting), K0,nc (Jaky 1-sinφ), OCR/POP, permeability k,
      PLAXIS material export (MC & HS blocks, E relationships, the Emc=E50_i fix from the prior audit). Verify
      every correlation constant against docs/logic.md and plaxis_matdb_export.md; state which is correct.
      Watch unit errors (kPa/MPa/kN/m^3), drained/undrained mixups, reference-stress pref=100 kPa
      consistency.` },
  { key: 'def-cpp-materials', title: 'WASM C++ constitutive models (MC exact, HS, tangents, JS mirror)',
    files: ['src/wasm/deformation/material_mc.hpp', 'src/wasm/deformation/material_mc_exact.hpp', 'src/wasm/deformation/material_hs.hpp', 'src/wasm/deformation/material_hs_tangent.hpp', 'src/wasm/deformation/math_js_mirror.hpp'],
    docs: ['docs/deformation/MC.md', 'docs/deformation/MC_pl.md', 'docs/features/hardening-soil-simo-hughes-implementation-log.md', 'scripts/scratch/mc_sh_phase_0_report.md'],
    focus: `C++ constitutive integration — must mirror JS exactly. Verify MC exact return mapping (apex, corner
      regions of the hexagonal MC surface, eigenvalue derivatives for spectral tangent), HS deviatoric+cap
      hardening, consistent tangent. math_js_mirror.hpp claims to mirror JS math — verify every mirrored
      function (pow, trig, eigen-decomposition, tolerances) is truly convention-equivalent to JS (atan2 branch,
      eigenvector sign, sqrt near-zero), since subtle divergence silently breaks parity. Flag any formula
      differing from MC.md or material-models.js.` },
  { key: 'def-cpp-core', title: 'WASM C++ core — solver, elements, CG, sparse, linalg, beam',
    files: ['src/wasm/deformation/deformation_wasm.cpp', 'src/wasm/deformation/solver.hpp', 'src/wasm/deformation/element.hpp', 'src/wasm/deformation/cg.hpp', 'src/wasm/deformation/sparse.hpp', 'src/wasm/deformation/linalg.hpp', 'src/wasm/deformation/types.hpp', 'src/wasm/deformation/beam.hpp'],
    docs: ['src/wasm/deformation/README.md', 'docs/deformation/certification-log.md'],
    focus: `Compiled C++ FEM core. Verify same FEM correctness as JS (B-matrix, quadrature, plane-strain D,
      assembly, BC, Newton) AND C++ hazards: buffer overruns, uninitialized memory, size_t/integer overflow in
      indexing, CSR/sparse assembly, CG preconditioner & convergence test, alignment, UB. CRITICAL: must equal
      the JS reference — note any divergence in formulas/constants/tolerances/DOF ordering. beam.hpp wall-beam
      element (Euler-Bernoulli/Timoshenko? Winkler coupling) — check stiffness matrix & coupling to soil DOFs.` },
  { key: 'def-wasm-glue', title: 'WASM bridge — wire format, pipeline, loader, runner, build-result',
    files: ['src/lib/cpt-app/deformation/wasm/wire-format.js', 'src/lib/cpt-app/deformation/wasm/pipeline.js', 'src/lib/cpt-app/deformation/wasm/wasm-loader.js', 'src/lib/cpt-app/deformation/wasm/wasm-runner.js', 'src/lib/cpt-app/deformation/wasm/build-result.js'],
    docs: ['src/wasm/deformation/README.md'],
    focus: `The JS<->C++ serialization boundary — prime source of silent wrong-answer bugs. Verify wire format:
      field order, types (f32 vs f64), endianness, array lengths, struct padding/stride, WIRE_VERSION
      handshake, heap alloc/free around calls (_malloc/_free, HEAPF64/HEAPF32 views invalidated after growth),
      pointer arithmetic, and that every field written on JS side is read at the same offset on C++ side. Check
      WASM heap leaks (un-freed blocks, stale views across growth), and build-result reconstructs
      displacements/stresses with correct units & DOF ordering. Cross-check types.hpp structs.` },
  { key: 'def-solver-robustness', title: 'Solver robustness — arc-length, line search, safety/strength-reduction, post',
    files: ['src/lib/cpt-app/deformation/safety-mechanism.js', 'src/lib/cpt-app/deformation/safety-finalization.js', 'src/lib/cpt-app/deformation/post.js', 'src/lib/cpt-app/deformation/diagnostics-depth-bands.js'],
    docs: ['docs/deformation/solver_robustness_path_following.md', 'docs/features/arc-length-riks-continuation.md', 'docs/features/strength-reduction-msf-safety.md'],
    focus: `Path-following & safety. Verify arc-length/Riks (constraint equation, predictor sign/root selection,
      step adaptation), line search, divergence handling, and strength-reduction (phi-c reduction, MSF): how c
      and tanφ are reduced, bracketing/bisection on the reduction factor, the non-convergence criterion
      defining FoS, finalization summary. Also post-processing (stress/strain recovery, displacement
      extraction, depth-band diagnostics). Cross-check the path-following & MSF docs; verify FoS = SRF =
      available/required and that the convergence-failure proxy for collapse is sound.` },
  { key: 'def-mesh', title: 'Deformation meshing (T3/T6 generation, PSLG, section mesh)',
    files: ['src/lib/cpt-app/deformation/mesh.js', 'src/lib/cpt-app/mesh/section-mesh.js', 'src/lib/cpt-app/mesh/section-pslg.js'],
    docs: ['docs/deformation/T6_mesh.md', 'docs/deformation/T6_mesh_v1.md'],
    focus: `Mesh generation/topology. Verify PSLG (segments, holes, region markers), T6 mid-side node insertion
      (correct edge midpoints, shared-edge node dedup so adjacent elements share midside nodes — classic bug),
      node/element numbering, boundary tagging, material-region assignment, mesh quality (slivers), and
      consistency with solver expectations (DOF count, CCW connectivity). Watch duplicate nodes, unshared
      midside nodes, wrong region/material tagging.` },
  { key: 'piles', title: 'Pile design (axial capacity, settlement) & canvas',
    files: ['src/lib/cpt-app/stage6-pile.js', 'src/lib/cpt-app/stage6-pile-canvas.js'],
    docs: ['src/routes/docs/engineering/pile/+page.svelte', 'scripts/validate-pile.js', 'docs/logic.md'],
    focus: `CPT-based pile capacity (Belgian/Dutch: Koppejan/De Beer/alpha-beta — base resistance qb from
      averaged qc over the influence zone, the 4D/8D Koppejan averaging rule; shaft friction from qc or fs with
      alpha factors), negative skin friction, group effects, settlement. Cross-check averaging windows,
      qc-limiting values, resistance & safety factors against the in-app pile doc and scripts/validate-pile.js
      (reference). Verify the De Beer/Koppejan qc-averaging algorithm carefully — the descending/ascending qc
      envelope is a common implementation error.` },
  { key: 'walls', title: 'Retaining/sheet-pile walls — geometry & beam coupling',
    files: ['src/lib/cpt-app/wall-geometry.js'],
    docs: ['docs/bishop/retaining_walls_extension_spec.md', 'src/routes/docs/engineering/beam/+page.svelte'],
    focus: `Wall geometry (two-point inclined wall per recent commits), embedding into section/mesh,
      classification of stability surfaces above/below the wall, and JS-side mechanical wall-beam activation
      (beam element math is in beam.hpp/def-cpp-core; check geometry/activation here). Verify earth-pressure
      assumptions (active/passive, Ka/Kp Rankine vs Coulomb), wall inclination handling, geometric
      intersection math. Watch inclination sign, active/passive side, degenerate vertical geometry.` },
  { key: 'beam-winkler', title: 'Beam/slab on elastic foundation (Winkler/Pasternak)',
    files: ['src/routes/docs/engineering/beam/+page.svelte', 'src/wasm/deformation/beam.hpp'],
    docs: ['src/routes/docs/engineering/beam/+page.svelte'],
    focus: `Beam/slab-on-elastic-foundation (Winkler/Pasternak). Find the actual implementation (grep src for
      winkler, pasternak, subgrade, beam, EI, kSpring). Verify beam stiffness matrix (Euler-Bernoulli 4x4
      Hermitian), Winkler reaction (k·w), Pasternak shear term (Gp·w''), BCs, modulus of subgrade reaction from
      soil stiffness, and moment/shear/deflection recovery feeding EC2 reinforcement. Cross-check the in-app
      beam doc against the implementation. (Coordinate with def-cpp-core on beam.hpp.)` },
  { key: 'cpt-parse-import', title: 'CPT file import, parsing & layer detection',
    files: ['src/lib/cpt-app/legacy-controller.js', 'src/lib/cpt-app/dxf-terrain.js'],
    docs: ['docs/logic.md'],
    focus: `Data-ingest half of legacy-controller.js: GEF parsing (#COLUMNINFO mapping, units, sign of
      depth/penetration, qc/fs/u2 columns), Excel and CSV import, header metadata (water level, ground level,
      alpha/beta), friction-ratio computation, pre-drilling/zero handling, depth monotonicity, unit
      conversions (MPa/kPa), automatic layer detection/segmentation. Also DXF terrain import. grep parse, gef,
      COLUMNINFO, xlsx, layer, detect, friction. Watch unit slips, off-by-one column indexing, NaN propagation
      from missing columns, locale decimal parsing, silent data corruption.` },
  { key: 'def-gpu-v1', title: 'Deformation GPU v1 (WebGPU resident CG/GMRES, assembly, WGSL)',
    files: ['src/lib/cpt-app/deformation/gpu/gpu-controller.js', 'src/lib/cpt-app/deformation/gpu/gpu-assembly.js', 'src/lib/cpt-app/deformation/gpu/gpu-mesh-pack.js', 'src/lib/cpt-app/deformation/gpu/gpu-plastic-newton.js', 'src/lib/cpt-app/deformation/gpu/resident-buffers.js', 'src/lib/cpt-app/deformation/gpu/resident-cg.js', 'src/lib/cpt-app/deformation/gpu/resident-gmres.js', 'src/lib/cpt-app/deformation/gpu/resident-geostatic.js', 'src/lib/cpt-app/deformation/gpu/resident-newton.js', 'src/lib/cpt-app/deformation/gpu/wgsl/blas.js', 'src/lib/cpt-app/deformation/gpu/wgsl/ds.js', 'src/lib/cpt-app/deformation/gpu/wgsl/elements.js', 'src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js', 'src/lib/cpt-app/deformation/gpu/wgsl/plastic-trial.js'],
    docs: ['docs/deformation/T6_gpu_acceleration.md', 'docs/deformation/certification-log.md', 'docs/deformation/incident-log.md'],
    focus: `Experimental WebGPU path (README: CPU is trusted reference, GPU uncertified). (B) GPU buffer
      lifecycle — GPUBuffers destroy()'d? bind groups/pipelines cached or leaked? mapped buffers unmapped?
      staging reuse? (A) WGSL numerical correctness — f32 precision in CG/GMRES, workgroup reductions (dot
      products), atomic-add races in assembly, barrier correctness, parity with CPU kernels. Certification:
      is any uncertified GPU path silently reachable as a default for engineering-critical runs (serious
      finding)? Cross-check certification-log claims vs what code enables.` },
  { key: 'def-gpu-v2', title: 'Deformation GPU v2 (matrix-free, BiCGSTAB/CG, CPU-ref parity)',
    files: ['src/lib/cpt-app/deformation/gpu/v2/gpu-v2-controller.js', 'src/lib/cpt-app/deformation/gpu/v2/gpu-v2-newton.js', 'src/lib/cpt-app/deformation/gpu/v2/gpu-v2-state.js', 'src/lib/cpt-app/deformation/gpu/v2/gpu-v2-dispatch.js', 'src/lib/cpt-app/deformation/gpu/v2/gpu-v2-cg.js', 'src/lib/cpt-app/deformation/gpu/v2/gpu-v2-bicgstab.js', 'src/lib/cpt-app/deformation/gpu/v2/cpu-ref-mf.js', 'src/lib/cpt-app/deformation/gpu/v2/cpu-ref-plastic.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-kx-element.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-blas.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-block-jacobi.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-apply-jacobi.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-jacobi-diag.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-elastic-d.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-plastic-strain.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-residual-and-flag.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-stress-slice.js', 'src/lib/cpt-app/deformation/gpu/v2/wgsl-v2/mf-trial-stress.js'],
    docs: ['src/lib/cpt-app/deformation/gpu/v2/README.md', 'docs/deformation/T6_gpu_acceleration.md'],
    focus: `Matrix-free GPU v2 with explicit CPU reference (cpu-ref-mf/cpu-ref-plastic). Verify matrix-free
      element apply (K*x without assembling K), block-Jacobi preconditioner, BiCGSTAB/CG stability (breakdown
      handling, f32 stagnation), and that cpu-ref matches the WGSL math. (B) buffer residency/reuse and leaks;
      (A) reduction correctness, plastic-strain matrix-free apply, CPU-reference parity. Note certification
      status as in v1.` },
  { key: 'cpt-controller-ui', title: 'Legacy controller orchestration, state & UI wiring',
    files: ['src/lib/cpt-app/legacy-controller.js', 'src/lib/cpt-app/legacy.css'],
    docs: [],
    focus: `Controller mechanics of the 18k-line monolith (NOT classification/param math — other auditors own
      that): global mutable state, event-listener registration/teardown, worker lifecycle, canvas redraw
      scheduling, debounce/throttle, large-array copies per render, retained closures. Emphasis on B (memory
      leaks: listeners/observers/workers never removed, unbounded caches, growing arrays) and D (dead/
      duplicated/unreachable code, disabled feature flags, orphaned helpers). Map structure first (grep
      "function ", addEventListener, "new Worker", removeEventListener). Report architectural health.` },
  { key: 'ui-components', title: 'Svelte UI components, stages & app shell',
    files: ['src/lib/components/cpt/CptInterpreterApp.svelte', 'src/lib/components/cpt/BannerPhaseShell.svelte', 'src/lib/components/cpt/StageNav.svelte', 'src/lib/components/cpt/stages/Stage1Load.svelte', 'src/lib/components/cpt/stages/Stage2Classification.svelte', 'src/lib/components/cpt/stages/Stage3Layers.svelte', 'src/lib/components/cpt/stages/Stage4Model.svelte', 'src/lib/components/cpt/stages/Stage5Tuning.svelte', 'src/lib/components/cpt/stages/Stage6Applications.svelte', 'src/lib/components/DocsHeader.svelte', 'src/routes/+page.svelte', 'src/routes/+layout.svelte', 'src/routes/+error.svelte', 'src/routes/+page.ts'],
    docs: [],
    focus: `Svelte 5 UI. (A) reactivity bugs (runes $state/$derived/$effect misuse, stale closures, effect loops,
      missing $effect cleanup, prop/binding errors, key-block list bugs); (B) leaks (listeners, intervals,
      subscriptions, workers, ResizeObserver not cleaned up; large reactive arrays recomputed each render); (D)
      dead components/props/state. Check the bridge between the Svelte shell and the imperative
      legacy-controller.js (DOM handoff; lifecycle teardown; worker termination on unmount).` },
  { key: 'reporting', title: 'Reporting, SVG/chart generation & report storage',
    files: ['src/lib/cpt-app/report-svg.js', 'src/lib/cpt-app/report-storage.js', 'src/lib/cpt-app/chart-factories.js', 'src/routes/report/+page.svelte', 'src/routes/report/+page.ts', 'src/routes/report/stage7/+page.svelte', 'src/routes/report/stage7/+page.ts'],
    docs: [],
    focus: `Report generation & persistence. (B) large SVG/string building, localStorage/IndexedDB quota &
      serialization cost, retained report blobs, redundant chart re-render. (A) numeric formatting/units in
      reports must match computed values (rounding, unit labels), axis scaling, report data round-trips through
      storage without loss. (D) dead chart factories / unused report fields. Verify reported engineering
      quantities are not silently mis-scaled vs source modules.` },
  { key: 'docs-site-integrity', title: 'In-app docs site (theory/reference/full/workflow) vs implementation',
    files: ['src/routes/docs/+page.svelte', 'src/routes/docs/theory/+page.svelte', 'src/routes/docs/reference/+page.svelte', 'src/routes/docs/full/+page.svelte', 'src/routes/docs/workflow/+page.svelte', 'src/routes/docs/engineering/+page.svelte', 'src/lib/docs/site.ts', 'src/lib/docs/workflow-content.ts'],
    docs: ['docs/logic.md'],
    focus: `Published documentation pages (the app's public scientific claims). Dimension C primary: sample
      formulas/constants/partial-factors/method descriptions in theory/reference/full pages and verify they
      match the implementation. Flag any published formula/constant that disagrees with code, broken internal
      doc links, stale version numbers, capability claims the code doesn't implement (or vice-versa). Also
      dead/duplicated doc content (full/+page.svelte at 2816 lines may duplicate per-topic pages). Be specific
      about which published statement is scientifically wrong if any.` },
  { key: 'verification-harness', title: 'Verification & regression scripts (the de-facto test suite)',
    files: ['scripts/verify_deformation_phase_1.mjs', 'scripts/verify_nen6740.mjs', 'scripts/verify_bishop_phase_a_parity.mjs', 'scripts/verify_seepage_phase_2.mjs', 'scripts/verify_wasm_cpu_parity.mjs', 'scripts/verify_integrated_plan.mjs', 'scripts/validate-pile.js', 'scripts/verify_safety_mechanism_summary.mjs', 'scripts/verify_hs_acceptance.mjs'],
    docs: [],
    focus: `These scripts ARE the trust anchor — they define intended behavior. Audit whether they test what
      they claim: are tolerances meaningful or so loose a broken solver passes? Do "parity" checks compare
      against an independent oracle or the same code path (circular)? Are exit codes correct (a failing
      assertion exits non-zero, not just console.log)? (D) stale/orphaned/superseded scripts (the many
      verify_arc_length_phase_N / verify_hs_phase_N — which are live regressions vs one-off scaffolding). (A)
      any script whose oracle math is itself wrong is dangerous false-confidence — flag those. Sample broadly;
      grep across scripts/ for these patterns (need not read all ~90).` },
  { key: 'build-config', title: 'Build, config & tooling',
    files: ['package.json', 'vite.config.ts', 'svelte.config.js', 'tsconfig.json', 'nixpacks.toml', 'src/wasm/deformation/build.sh', 'src/app.d.ts', '.npmrc', '.nvmrc'],
    docs: [],
    focus: `Build/config correctness. (A) Vite/Svelte/TS config, adapter (static vs auto), WASM/worker asset
      handling & base path, missing COOP/COEP headers if WebGPU/SharedArrayBuffer need them, wasm build.sh
      flags (optimization, -msimd, exported functions, memory growth) and whether committed
      static/wasm/deformation/*.wasm matches source. (D) unused scripts/deps, dead config. (B) minor. Focus on
      correctness and any config that could ship a broken/mismatched artifact.` },
]

// stable 1-based number per unit (drives /audit/NN-key.md so batches don't collide)
const NUM = {}
UNITS.forEach((u, i) => { NUM[u.key] = i + 1 })

function outPathFor(u) {
  return `${AUDIT_DIR}/${String(NUM[u.key]).padStart(2, '0')}-${u.key}.md`
}

// ----- mode selection via args (robust to string-encoded lists) -----
// args undefined                          -> run ALL auditors
// args 'synthesis'                         -> run the 2 synthesis agents
// args ['k1','k2'] OR 'k1,k2' OR '["k1"]'  -> run just those auditors (a batch)
let parsedArgs = args
if (typeof args === 'string') {
  const s = args.trim()
  if (s === 'synthesis') parsedArgs = 'synthesis'
  else if (s.startsWith('[')) {
    try { parsedArgs = JSON.parse(s) }
    catch (e) { parsedArgs = s.replace(/[[\]"']/g, '').split(',').map((x) => x.trim()).filter(Boolean) }
  } else parsedArgs = s.split(',').map((x) => x.trim()).filter(Boolean)
}
const mode = parsedArgs === 'synthesis' ? 'synthesis'
  : Array.isArray(parsedArgs) && parsedArgs.length ? 'batch'
  : 'all'

if (mode === 'synthesis') {
  phase('Synthesis')
  const parityPath = `${AUDIT_DIR}/90-cross-implementation-parity.md`
  const completenessPath = `${AUDIT_DIR}/91-completeness-and-gaps.md`
  const synth = await parallel([
    () => agent([
      APP_CONTEXT,
      `\n## Cross-implementation PARITY audit`,
      `The deformation engine has THREE parallel implementations that must give the SAME engineering answer:`,
      `(1) JS CPU reference (deformation/solver.js + material-models.js), (2) C++/WASM (src/wasm/deformation/*),`,
      `(3) WebGPU v1 & v2 (deformation/gpu/**). Read enough of all three plus parity scripts`,
      `(scripts/verify_wasm_cpu_parity.mjs, verify_gpu_e2e_parity.mjs, verify_gpu_v2_parity.mjs,`,
      `verify_wasm_mc_local_parity.mjs) to find DIVERGENCES in formulas, constants/tolerances, DOF ordering,`,
      `Gauss rules, MC/HS return-mapping, convergence criteria, f32-vs-f64 policy, geostatic init. Check`,
      `dispatch: which backend runs by default for engineering-critical results, and can an uncertified GPU`,
      `path leak into a trusted answer? Read existing per-subsystem reports in ${AUDIT_DIR} (the NN-*.md files)`,
      `to connect findings without duplicating. Write with Write to EXACTLY ${parityPath} (only that file).`,
      `Structure: # Audit — Cross-Implementation Parity, ## Default-backend dispatch & certification risk,`,
      `## Numerical divergences (table: item | JS | WASM | GPU | which is correct), ## Parity-test adequacy,`,
      `## Findings (A/B/C/D + file:line + severity). Return a terse summary of the top parity risks.`,
    ].join('\n'), { label: 'synth:parity', phase: 'Synthesis' }),
    () => agent([
      APP_CONTEXT,
      `\n## Completeness critic`,
      `Read ALL per-subsystem audit reports in ${AUDIT_DIR} (every NN-*.md). Find GAPS in the audit itself,`,
      `don't re-audit. Identify: (1) source files no auditor covered — compare against`,
      `\`find ${ROOT}/src ${ROOT}/scripts -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.svelte'`,
      `-o -name '*.hpp' -o -name '*.cpp'\` and the file lists in the reports; (2) cross-cutting concerns nobody`,
      `owned (error handling, input validation at boundaries, units discipline, numerical-precision policy,`,
      `worker/WASM/GPU teardown, security of file parsing/localStorage); (3) under-investigated or contradictory`,
      `findings between reports; (4) the single highest-risk thing to check first. Write with Write to EXACTLY`,
      `${completenessPath} (only that file). Structure: # Audit — Completeness & Gaps, ## Files not covered,`,
      `## Cross-cutting gaps, ## Suggested second-pass targets, ## Top engineering risks (ranked). Return a`,
      `terse summary.`,
    ].join('\n'), { label: 'synth:completeness', phase: 'Synthesis' }),
  ])
  return { parity: synth[0] || null, completeness: synth[1] || null, files: [parityPath, completenessPath] }
}

const selected = mode === 'batch' ? UNITS.filter((u) => parsedArgs.includes(u.key)) : UNITS
log(`Auditing ${selected.length} subsystem(s): ${selected.map((u) => u.key).join(', ')}`)

const summaries = await parallel(
  selected.map((u) => () =>
    agent(auditorPrompt(u, outPathFor(u)), { label: `audit:${u.key}`, phase: 'Audit' })
      .then((s) => ({ key: u.key, path: outPathFor(u), summary: s })),
  ),
)

return {
  audited: summaries.filter(Boolean).map((s) => s.key),
  reports: summaries.filter(Boolean),
}
