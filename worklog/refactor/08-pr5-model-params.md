# 08 — PR 5 `refactor(model-params): hsParams/khParams/stressAt with explicit ctx`

Branch `v0.6.0` (base 9391124), strangler step 2 of `01-monolith-map.md` §6.2 (PLAN §2 row 5). Executed by a
Fable agent in an isolated worktree. File set: `src/lib/cpt-app/legacy-controller.js`, new
`src/lib/cpt-app/model-params/**` (7 files), new `scripts/verify_model_params.mjs`, this report. Nothing under
`src/lib/cpt-app/stratigraphy/**` needed a change (the S-swap lived in the controller, and `store.js` already
calls `ctx.layerParamsFor(cpt, layer)` with the member's own CPT). `package.json`, `tests/`, `scripts/golden`
untouched.

One commit, one pure move: `npm run golden:check` 1 619 / 0 / 0 / 0 before and after — no golden updated,
no `tests/golden/CHANGELOG.md` entry needed. No behaviour-change commit was necessary.

## 1. What moved (verbatim bodies; only the `S` reads renamed)

Old line numbers are those of the branch tip 9391124 (the map's numbers shifted by +11 after PR 4).

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `DEF` 821-829, `AE` 831-834 | `model-params/soil-defaults.js` → `DEF`, `AE` | none | `import { DEF, AE }` (used by `segmentSummary` 2230/2233 → now ≈2016, `fitLayer` ≈3006/3022) |
| `MC_NU_BY_TYPE` 858-866, `MC_NU_BY_SUBTYPE` 868-903, `MC_RSHEAR_BY_TYPE` 906-914, `MC_RSHEAR_BY_SUBTYPE` 916-951 (+ the 22-line provenance comment 836-857) | `soil-defaults.js` → same names | none | not imported (only `hsParams` read them) |
| `mohrCoulombNuDefault` 954-958, `mohrCoulombRShearDefault` 960-964 | `soil-defaults.js` → same names | none | not imported (only `hsParams`) |
| `sb260GranularAlpha` 987-991, `sb260TransitionAlpha` 993-997, `sb260AlphaFamily` 999-1022, `alphaEB` 1024-1035 (+ Tabel 21-6-5 comment 966-986) | `soil-defaults.js` → same names | none | imported under the same names (`legacyApi` keeps exporting the four; `fitLayer` calls `alphaEB`) |
| `stressAt(z, γsat, γunsat)` 1935-1951 | `model-params/stress.js` → `stressAt(cpt, z, γsat, γunsat)` | `S.wt` → `cpt.wt` | wrapper `stressAt(z,gs,gu){ return stressAtPure(S, z, gs, gu); }` at the old place (Stage 2 classifiers 2009/2023/2089 and Stage 5 `fitLayer` keep calling it) |
| `khParams(l)` 2948-3031 | `model-params/kh-params.js` → `khParams(l, ctx)` | `S.khKvMethod` → `ctx.khKvMethod` | wrapper `khParams(l){ return khParamsPure(l, modelCtx()); }` |
| `hsParams(l)` 3074-3157 | `model-params/hs-params.js` → `hsParams(l, ctx)` | `S.alphaMethod`, `S.stiffMethod`, `S.elev` → `ctx.*`; `assumedRfValue()` → `ctx.assumedRf`; `stressAt(midZ, gs, g)` → `(ctx.stressAt \|\| stressAt)(ctx, midZ, gs, g)` | `modelCtx(){ return cptModelCtx(S); }` + wrapper `hsParams(l){ return hsParamsPure(l, modelCtx()); }` |
| `stage6WorkingLayers()` 4168-4190 | `model-params/working-layers.js` → `workingLayers(cpt)` | `S.layers` → `cpt.layers`; per-layer calls get `cptModelCtx(cpt)` | wrapper `stage6WorkingLayers(){ return workingLayersPure(S); }` (13 callers + `retainingApp.workingLayers` unchanged) |
| — (new) | `model-params/context.js` → `cptModelCtx(cpt)` | builds the ctx below from a CPT state; imports `normalizeAssumedRf` from `../classification-core.js` (what `assumedRfValue()` 1994-1996 did) | used by `modelCtx()` and by the stratigraphy `layerParamsFor` |
| — (new) | `model-params/index.js` | re-exports the package surface | the controller imports only from `index.js` |

The tables' comment blocks (ν' provenance 836-857, SB260 Tabel 21-6-5 rules 966-986) moved with their constants.
The `SOIL DEFS` header and `SC`/`SCFILL` (815-820, aliases of `soil-styles` imports used by the Stage 2/3 render)
stay in the controller.

### The ctx (`cptModelCtx(cpt)`)

| Field | Was | Read by |
|---|---|---|
| `wt` | `S.wt` (inside `stressAt`) | `stressAt`, hence `hsParams` (σv/u/σ′v at layer mid-depth) |
| `elev` | `S.elev` | `hsParams` (`topTAW`/`botTAW`, `'—'` when null) |
| `alphaMethod` | `S.alphaMethod` | `hsParams` (A: `AE[type]`, B: `alphaEB`) |
| `stiffMethod` | `S.stiffMethod` | `hsParams` (A: CUR 2003-7 ×1.25 cohesive, B: E50 = Eoed) |
| `khKvMethod` | `S.khKvMethod` | `khParams` (silty sand k_h/k_v 3 → 2 under B) |
| `assumedRf` | `assumedRfValue()` = `normalizeAssumedRf(S.assumedRf)` | `hsParams` method B when `l.avgRf == null` (qc-only CPTs) |
| `stressAt` (optional) | — | `hsParams`: override hook, `(ctx, z, γsat, γunsat) → {sigV,u,sigVeff}`; defaults to `stress.js`; unused by the app |

`assumedRf` is normalised eagerly in the ctx builder instead of lazily inside `hsParams`; `normalizeAssumedRf` is
total (finite clamp / default 3.0), so this is not observable — the goldens (incl. `qc-only`, `trailing-qc-only`,
where every layer has `avgRf: null`) are bit-identical.

## 2. The stratigraphy `S`-swap — deleted

Old 163-180 (map §1.1 "160-166"):

```js
  layerParamsFor: (cpt, layer) => {
    const prevS = S;
    S = cpt;
    try { return { hs: hsParams(layer), kh: khParams(layer) }; }
    finally { S = prevS; }
  },
```

is now

```js
  layerParamsFor: (cpt, layer) => {
    const ctx = cptModelCtx(cpt);
    return { hs: hsParamsPure(layer, ctx), kh: khParamsPure(layer, ctx) };
  },
```

Equivalence: the swapped `S` was only read for `wt / elev / alphaMethod / stiffMethod / khKvMethod / assumedRf`
by the two functions — exactly the six fields `cptModelCtx(cpt)` copies from the same `cpt`. Proof:
`npm run verify:stratigraphy` green (the store's `paramsFor` path), golden `report/*` (SOILIN payload through
the controller) and `project-io/*` bit-identical, and `verify_model_params.mjs` §8 derives a second CPT with
different settings next to the active one and shows the active CPT's working layers are untouched.

**`importCptFiles` swap (old 439-470) left in place.** It exists for a different reason: the parsers →
`applyParsedCpt` → `renderBanner`/`S.id=` chain *writes* into the active CPT and the Stage 1 DOM, which
`hsParams/khParams/stressAt` never do. It disappears in step 5 (`load/apply-parsed-cpt.js` returning a patch
for an explicit target CPT), not here. The remaining reassignment sites of `S` are `selectCpt`, `removeCpt` and
`importCptFiles` only.

## 3. Controller line-count delta

| | lines (`wc -l`) |
|---|---|
| before (9391124) | 18 446 |
| after | **18 047** (net **−399**) |

`git diff --stat`: `legacy-controller.js | 449 ++--- (25 insertions, 424 deletions)`. Insertions: the 13-line
import block after `core/chart-host.js`, the 3-line `layerParamsFor` body + 1 comment line, `modelCtx()` (5 lines
incl. comment) and the four 1-line wrapper bodies. `legacyApi` exports the same 167 names (`verify:handlers`:
180 published names, unchanged). `model-params/`: 555 lines in 7 files (`soil-defaults.js` 233, `hs-params.js`
105, `kh-params.js` 95, `working-layers.js` 38, `context.js` 28, `stress.js` 28, `index.js` 28) — the extra
over the 399 cut is headers + the ctx builder + package index.

Every module: SPDX header, `// @ts-nocheck`, header comment naming source + old line range, `.js` imports so
the package loads under plain Node (`verify_model_params.mjs` §1-7 need no Vite). Dependencies: `hs-params.js`
→ `soil-defaults.js`, `stress.js`; `working-layers.js` → `context.js`, `hs-params.js`, `kh-params.js`;
`context.js` → `../classification-core.js` (pure, already Node-loaded by `verify_qc_only_handling.mjs`).
No `S`, no DOM, no `document`.

## 4. Callers, unchanged

`renderModel` (Stage 4 card), `fitLayer` (Stage 5, also `stressAt`/`alphaEB`/`AE`), `stage6WorkingLayers`
(13 callers: bishop soil model 6385/7162/11161, bearing/settlement/dewatering/beam, pile, `retainingApp`
`workingLayers`, Stage 7 payload), `exportCSV`, `exportPlaxisCommands` (3 sites), `stage7WorkingLayerPayload`,
the Stage 2 classifiers (`stressAt(r.z, 18, 17)`) — all still call the monolith names. Stage 7 payload and
`legacyApi` unchanged.

Not moved (deliberately, per the map's `model-params/` row): `renderModel` 3159-3286 and the toggles
`setAlphaMethod/setStiffMethod/setKhKvMethod/setParamMethod` (DOM; `panel.js`/handlers of a later step), and
`assumedRfValue()` (19 Stage 1/2/7 callers; `context.js` reproduces it for the ctx).

## 5. `scripts/verify_model_params.mjs` — 188 checks, exit 0

| Part | What |
|---|---|
| §1-6 unit (pure, no Vite) | tables' key sets; `sb260GranularAlpha`/`TransitionAlpha` bands; `sb260AlphaFamily` subtype-before-type and the Rf 1-2 % transition rule; `alphaEB` per family incl. the qc floor; `mohrCoulomb*` subtype-first lookup + fallbacks; `stressAt` above/below/at/above-surface WT, γunsat fallback, σ′v floor, ctx as first arg; `cptModelCtx` field copy + `assumedRf` normalisation; `khParams` sand bands, k_h/k_v per method, ψ_unsat, infiltration classes, `×10⁻ⁿ` format; `hsParams` α A/B/override, `ctx.assumedRf` only for `avgRf == null`, stiffness A vs B (leem in the cohesive set), m/ν/R_inter overrides with clamps, β/E_def from rounded β, ψ, TAW strings, the `ctx.stressAt` hook; `workingLayers` copy + the 14 added keys in order |
| §7 goldens are the truth | every `tests/golden/node/model/<fx>.<ASK>.<pm>.json` (**144 cases**, 9 fixtures × {A,B}³ × {sb260, def}) recomputed from `<fx>.layers.<pm>.json` + `wt/elev/assumedRf` of `node/import/<fx>.gef.json` (manifest `inject` applied for `wt-above-surface`) and compared `deepStrictEqual` after the goldens' normalisation (sorted keys) — tolerance class "pure", exact |
| §8 wrappers ⇔ pure (Tier-B loader, DOM stub) | demo fixture through `ctx.classify`, all 16 method combos via the real setters: `api.hsParams(l)`/`api.khParams(l)` == pure with `cptModelCtx(S)`; `api.stressAt` == `stressAt(S, …)` on the row grid + layer mid-depths; `stage6WorkingLayers()` observed through `buildStage7Payload().stage6.layers` (the wrapper is not on `legacyApi`, and no name was added) == `workingLayers(S)`; a second CPT with other wt/elev/methods derives independently and leaves the active CPT untouched; the Stage 4 names still on `legacyApi` |
| §9 extraction complete | none of the 12 moved declarations, the three function bodies or the `prevS = S; S = cpt;` swap remain; the import block and the four wrappers are present; every module carries SPDX + `@ts-nocheck` |

`--pure-only` skips §8 (no Vite): 167 checks in 0.1 s; the full run with the Tier-B loader takes ≈ 3.4 s.

## 6. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (9391124) | 1 619 PASS / 0 FAIL / 0 NEW / 0 MISSING, 30.3 s, exit 0 |
| `npm run golden:check` — after the move | 1 619 / 0 / 0 / 0, 28.5 s, exit 0 (bit-identical: `model` 180, `tuning` 63, `report` 22, `exports`, `project-io`, all stage6-* unchanged) |
| `npm run golden:check` — final (with the verifier + report in the tree) | 1 619 / 0 / 0 / 0, 28.3 s, exit 0 |
| `npm run verify:handlers` | OK — 428 inline handlers, 70 callees, 180 published names (legacyApi 167), exit 0 |
| `npm run verify:core-helpers` | 18/18, exit 0 |
| `npm run verify:stratigraphy` | all checks passed, exit 0 |
| `npm run verify:retaining` | wasm 0 failures · ui PASSED · behaviour 31/31 · soil-profile 23/23 · sections-plaxis 81/81 · request 24/24 (226 OK lines), exit 0 |
| `node scripts/verify_model_params.mjs` | 188/188, exit 0 |
| `npm run build` | `✓ built in 2.97s`, exit 0 |
| `npm run check` | 389 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 in this PR's files (the `tests/golden/vendor` noise of PR 4's report is gone on the branch tip) |

Playwright / dev server not run (pure compute move; README protocol step 5).

## 7. `package.json` line for the main session

```json
"verify:model-params": "node scripts/verify_model_params.mjs",
```

Suggested: add `&& npm run verify:model-params` to `verify:core` (it needs `tests/golden/**` and, for §8, the
Vite dev dependency — both present in CI).

## 8. Left in place / follow-ups

- `importCptFiles` S-swap (see §2) — step 5.
- `modelCtx()` is rebuilt on every wrapper call (6 object fields + one clamp): negligible, and it guarantees the
  wrappers always see the current `S`. When step 8 introduces `setActive()`, `modelCtx` becomes
  `cptModelCtx(getActive())` and the wrappers can go.
- `fitLayer` (Stage 5) still reads `S.alphaMethod` directly for its pointwise α (old 3306/3322) and calls the
  `stressAt` wrapper — it moves with `tuning/` (step 8) and should take the same ctx then.
- The `qc-only` goldens exercise the `ctx.assumedRf` path (all layers `avgRf: null`); a Tier-A case for
  `hsParams` on those fixtures is effectively §7 of the verifier. When the goldens migrate from tier B to tier A
  (README step 8) the `model` suite can call the package directly.
- `SOIL DEFS` header + `SC`/`SCFILL` remain in the controller for the Stage 2/3 render; they belong to
  `classification/panel.js` / `layers/table.js` (step 3).
