# Audit — Build, config & tooling
**Subsystem key:** build-config
**Files reviewed:** package.json, vite.config.ts, svelte.config.js, tsconfig.json, nixpacks.toml, src/wasm/deformation/build.sh, src/wasm/deformation/README.md, src/app.d.ts, .npmrc, .nvmrc, .gitignore, src/lib/cpt-app/deformation/wasm/wasm-loader.js, src/lib/cpt-app/deformation/wasm/wasm-runner.js, src/lib/cpt-app/deformation/wasm/wire-format.js (header/version), src/lib/cpt-app/seepage/triangle-runtime.js, src/routes/**/+page.ts, +layout.ts (prerender survey), package-lock.json (xlsx/triangle pins)
**Finding counts:** critical=0 high=1 medium=2 low=4 info=3  |  A=0 B=1 C=2 D=4 info=3  |  total=10

## Overview
This subsystem is in good shape on the most safety-critical axis: I rebuilt the deformation WASM from source with the exact `build.sh` flags using the locally-installed emscripten 5.0.7 and confirmed the committed `static/wasm/deformation/{deformation.wasm,deformation.js}` are **byte-for-byte identical (SHA256 match)** to a fresh build — so no stale/mismatched artifact is shipped. The numerically dangerous `-ffast-math` flag is correctly paired with `-fno-finite-math-only`, which I verified at runtime preserves the dozens of `std::isfinite/isnan` guards the constitutive code depends on; removing that flag would silently break singular-matrix and divergence detection. The remaining issues are non-numerical: a known-vulnerable `xlsx@0.18.5` parsing untrusted user uploads, ~670 KB of orphaned static assets shipped to users (including a full standalone backup of the old app), a README that disagrees with the code on the wire-format version, an unused `adapter-auto` dependency, a hardcoded base-path-unaware WASM URL, and a `package.json` version that lags the branch.

## Findings

### [BUILD-CONFIG-A] (none)
No implementation/correctness bugs found in the build/config layer. The WASM artifact matches source, exported functions match build.sh and JS/script usage, the wire-format magic/version constants agree between C++ and JS (both version 12), node version pins are mutually consistent (.nvmrc 22.12.0 / engines >=22.12.0 / nixpacks nodejs_22), and `-ffast-math -fno-finite-math-only` is numerically safe (verified — see BUILD-CONFIG-INFO-01).

### [BUILD-CONFIG-B-01] low · WASM JS glue dynamically imported through a string URL defeats bundling/integrity
- **Location:** `src/lib/cpt-app/deformation/wasm/wasm-loader.js:18-47`
- **Category:** B — Memory/Performance (build-asset handling)
- **Confidence:** confirmed
- **Analysis:** The loader resolves the glue with `return \`${origin}/wasm/deformation/deformation.js\`` and then `await import(/* @vite-ignore */ moduleUrl)`. Because the URL is an opaque runtime string with `@vite-ignore`, Vite does not fingerprint/hash this asset, cannot apply long-term immutable caching to it, and cannot rewrite the path for a non-root `base`. The artifact is served from `static/` verbatim (no content hash), so cache-busting relies entirely on the filename never changing — which means a redeploy with a changed `.wasm` of the same name can be served stale from an intermediary/browser cache. (Contrast the seepage path `triangle-runtime.js:5`, which uses `new URL('./assets/triangle.out.wasm', import.meta.url)` and so gets a fingerprinted, bundler-managed asset.) This is benign today but is a real cache-correctness/integrity gap.
- **Recommendation:** Consider moving the glue+wasm under `src/lib/.../assets/` and loading via `new URL(..., import.meta.url)` (as seepage does) so Vite fingerprints them, or add a query-string version token to the static URL on each release. At minimum document the manual cache-bust requirement.

### [BUILD-CONFIG-C-01] medium · README states wire-format version 2; code uses version 12
- **Location:** `src/wasm/deformation/README.md:28,70,78` vs `src/lib/cpt-app/deformation/wasm/wire-format.js:10` and `src/wasm/deformation/deformation_wasm.cpp:8,65,190,304,760`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) The README says, in three places, "decode the output buffer (**wire version 2**)", "### Wire format (**version 2**)", and "both with **version 2**. Bump the version constant…". (2) The code on **both** sides uses version 12: JS `const WIRE_VERSION = 12;` (`wire-format.js:10`) and the comment `// reader lives in deformation_wasm.cpp. Wire version 12.` (`wire-format.js:6`); C++ `constexpr std::uint32_t WIRE_VERSION = 12u;` (`deformation_wasm.cpp:190`) with the input reader rejecting any other version at `:304` (`if (magic != INPUT_MAGIC || version != WIRE_VERSION)`). (3) The **code is correct** — it is self-consistent across the JS/C++ boundary and is what actually runs; the README is stale (the schema has clearly grown: HS payload gated on `version >= 10`, wall-beam output on `version >= WALL_BEAM_OUTPUT_WIRE_VERSION = 12`). There is no scientific/standards equation at stake here, but a developer trusting the README would write a v2 header that the C++ reader rejects with "WASM input header magic/version mismatch". (4) Fix the **doc**: change all "version 2" references in README.md to 12.
- **Recommendation:** Update `README.md` to say wire version 12 (or, better, reference the `WIRE_VERSION` constant by name and drop the hardcoded number to avoid future drift).

### [BUILD-CONFIG-C-02] low · README "Out of scope: Hardening Soil" contradicts shipped HS exports/wire payload
- **Location:** `src/wasm/deformation/README.md:137` vs `src/wasm/deformation/build.sh:44`, `wire-format.js:484` (`hasHsPayload = version >= 10`)
- **Category:** C — Doc vs Code
- **Confidence:** likely
- **Analysis:** (1) The README's "Out of scope (deliberately)" list ends with "Hardening Soil and other future constitutive plugins." (2) The code ships `_madepRunHsMaterialPoint` as an exported WASM function (`build.sh:44`), the C++ TU implements it (`deformation_wasm.cpp:1077-1135`), the wire format carries an HS payload (`wire-format.js:484`, gated `version >= 10`), and there is a whole HS material header family (`material_hs.hpp` 190 KB, `material_hs_tangent.hpp`). So at least material-point-level HS is implemented and exported, not "out of scope." (3) The doc is stale; the code reflects reality (HS at least partially present). This is lower severity than C-01 because the in-app HS UI is noted elsewhere as hidden in production (commit `1ba72d2` "production: hide HS UI"), so the README may be describing the *globally-dispatched* solver scope rather than the material-point API — but as written it is misleading. (4) Fix the **doc** to distinguish "HS material-point kernel: implemented/exported" from "HS in the global Newton dispatch: gated/hidden in production."
- **Recommendation:** Reword the README out-of-scope bullet to scope it to the global solver dispatch, and acknowledge the exported HS material-point entry point used by the verify scripts.

### [BUILD-CONFIG-D-01] high · ~670 KB of orphaned static assets shipped to every user (incl. full standalone app backup)
- **Location:** `static/cpt_app.backup.html` (161 KB), `static/vendor/gpu-browser.min.js` (389 KB), `static/vendor/triangle-wasm/triangle.out.wasm` (123 KB)
- **Category:** D — Dead code / orphaned files
- **Confidence:** confirmed
- **Analysis:** A full-repo grep across `src/`, `static/*.html`, and `app.html` finds **zero** references to any of these three files (`grep -rn "gpu-browser\|cpt_app\|vendor/triangle" src/ ...` → empty). The static adapter copies everything under `static/` to the build output verbatim — I confirmed all three are present in the local `build/` output (`build/cpt_app.backup.html`, `build/vendor/gpu-browser.min.js`, `build/vendor/triangle-wasm/triangle.out.wasm`). So they are publicly served and inflate the deployed footprint by ~673 KB with no code path using them:
  - `gpu-browser.min.js` is the **gpu.js** library; the app uses native WebGPU/WGSL, not gpu.js — confirmed no import or `<script>` reference anywhere. Added in commit `3bd65e7` "Fix deploy-safe GPU runtime loading" and since superseded.
  - `triangle.out.wasm` under `static/vendor/` is a **third, redundant copy** of the Triangle binary; the seepage runtime loads the binary from `src/lib/cpt-app/seepage/assets/triangle.out.wasm` via `import.meta.url` (and the glue from `node_modules/triangle-wasm/triangle.out.js`). I verified all copies are byte-identical (SHA256 `f7fef02e…`), so the static/vendor copy is purely orphaned.
  - `cpt_app.backup.html` is a **complete old standalone version of the application** (`<title>CPT Interpreter — MADEP</title>`, loads Chart.js from cdnjs). It is reachable at `/cpt_app.backup.html` on the deployed site — a minor information-disclosure / superseded-implementation concern in addition to the byte weight.
- **Recommendation:** Remove all three from `static/` (FLAG ONLY — do not delete in this pass). If the standalone HTML must be retained for reference, move it out of `static/` so it is not published.

### [BUILD-CONFIG-D-02] low · `@sveltejs/adapter-auto` is an unused devDependency
- **Location:** `package.json:62` vs `svelte.config.js:1,10`
- **Category:** D — Dead code / unused dep
- **Confidence:** confirmed
- **Analysis:** `svelte.config.js` imports and uses only `@sveltejs/adapter-static` (`import adapter from '@sveltejs/adapter-static'; … adapter: adapter()`). A repo-wide grep for `adapter-auto` outside `package.json` returns nothing — it is never imported. The static adapter is the correct choice for this prerender-everything SPA, so `adapter-auto` is dead weight in the dependency tree.
- **Recommendation:** Drop `@sveltejs/adapter-auto` from `devDependencies` (FLAG ONLY).

### [BUILD-CONFIG-D-03] low · Hardcoded `${origin}/wasm/...` ignores SvelteKit `base` (latent dead/incorrect under subpath)
- **Location:** `src/lib/cpt-app/deformation/wasm/wasm-loader.js:19,21,43`
- **Category:** D — superseded/latent-incorrect path logic (also borders A)
- **Confidence:** confirmed
- **Analysis:** Both the glue URL and the emscripten `locateFile` override build paths as `\`${origin}/wasm/deformation/...\`` — i.e. rooted at the **origin**, ignoring any configured `base` path. Currently `svelte.config.js` sets no `kit.paths.base`, so this works. But if the app is ever deployed under a subpath (e.g. `https://host/madep/`), every other asset (which SvelteKit prefixes with `base`) would resolve correctly while the deformation WASM would 404, silently disabling the WASM CPU pipeline. The comment claims this is done "so it works from a Web Worker," but the worker-safe approach would be to import `base` from `$app/paths` (or `$env`) and prefix it. Flagging as D/latent because no `base` is set today.
- **Recommendation:** Prefix with SvelteKit's `base` (from `$app/paths`) instead of bare origin, or document that the app must be served from the origin root.

### [BUILD-CONFIG-D-04] info → low · `package.json` version (0.5.0) lags the release branch (v0.5.3)
- **Location:** `package.json:1-2` (`"version": "0.5.0"`), current branch `v0.5.3`
- **Category:** D — stale config
- **Confidence:** confirmed
- **Analysis:** The package manifest declares `0.5.0` while the active branch is `v0.5.3` (three patch releases beyond the manifest). The package is `"private": true` so it is never published, which limits the impact, but the version is the natural place to stamp builds/reports and a stale value is misleading for support/repro. No git tags exist (`git tag --list` empty), so the branch name is the only version signal and it disagrees with the manifest.
- **Recommendation:** Bump `package.json` version to match the branch on each release, or wire it from a single source of truth.

### [BUILD-CONFIG-INFO-01] info · `-ffast-math -fno-finite-math-only` is correct and load-bearing — do NOT "simplify" it
- **Location:** `src/wasm/deformation/build.sh:26`
- **Category:** A-adjacent (positive verification)
- **Confidence:** confirmed (runtime-tested)
- **Analysis:** The constitutive/solver code relies on `std::isfinite/isnan/isinf` in dozens of places as hard guards (singular-matrix detection `material_hs_tangent.hpp:952,1003`, beam validity `beam.hpp:23-26`, MC apex `material_mc.hpp:158,424`, condition-number checks `material_mc_exact.hpp:550`, etc.). Plain `-ffast-math` implies `-ffinite-math-only`, which lets the compiler assume operands are never NaN/Inf and constant-fold `isfinite(x)→true`, `isnan(x)→false` — silently disabling every one of those guards. I verified this empirically: compiled a small harness with `clang++ -O3 -ffast-math -fno-finite-math-only` → `isfinite(inf)=0, isnan(nan)=1, isinf(inf)=1` (correct); the same harness with plain `-ffast-math` → `isfinite(inf)=1, isnan(nan)=0, isinf(inf)=0` (broken). The build.sh combination is therefore deliberate and necessary. A future "cleanup" that drops `-fno-finite-math-only` would produce plausible-but-wrong engineering results by defeating divergence/singularity detection.
- **Recommendation:** Keep the flag pair; add a one-line comment in build.sh noting that `-fno-finite-math-only` is required because the solvers depend on NaN/Inf detection.

### [BUILD-CONFIG-INFO-02] info · Committed deformation WASM matches source (reproduced byte-for-byte)
- **Location:** `static/wasm/deformation/deformation.{wasm,js}` vs `src/wasm/deformation/*` + `build.sh`
- **Category:** A-adjacent (positive verification)
- **Confidence:** confirmed (rebuilt)
- **Analysis:** Using the locally-installed emcc 5.0.7 and the exact flags from `build.sh`, I rebuilt into `/tmp` and compared SHA256: committed and rebuilt `.wasm` are identical (`6cdd2467e1b4…`) and committed and rebuilt `.js` are identical (`7d3a52ea3957…`). The exported-function set in `build.sh` (`_madepRunDeformationAnalysis`, `_madepRunMcPlasticMaterialPoint`, `_madepRunHsMaterialPoint`, `_madepGetLastErrorMessage`, `_madepGetLastNewtonStepIterationsJson`, `_madepFreeBuffer`, `_malloc`, `_free`) matches the C++ `extern "C"` definitions and all JS/verify-script call sites. `madepGetLastNewtonStepIterationsJson` is unused by the production JS bridge but IS used by `scripts/verify_hs_newton_count.mjs`, `verify_mc_simo_hughes_newton_count.mjs`, `verify_hs_simo_hughes_d6.mjs`, so it is a legitimate diagnostic export, not dead. This is the highest-value positive result of the audit.
- **Recommendation:** None. Consider a CI step that rebuilds and diffs the artifact to keep this guarantee enforced.

### [BUILD-CONFIG-INFO-03] info → medium (security-adjacent) · `xlsx@0.18.5` has 2 known high CVEs and parses untrusted uploads
- **Location:** `package.json:73` (`"xlsx": "^0.18.5"`), used at `src/lib/cpt-app/legacy-controller.js:1321` (`XLSX.read(buffer,{type:'array',cellDates:true})`), upload entry `src/lib/components/cpt/stages/Stage1Load.svelte:46`
- **Category:** Build/dependency security (cross-cuts A/D)
- **Confidence:** confirmed
- **Analysis:** `npm audit --omit=dev` reports `xlsx *` as **high**: Prototype Pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9), with "No fix available" on the npm registry package — SheetJS publishes patched releases only via their own CDN (`cdn.sheetjs.com`), not npm. The vulnerable code path is reached: `XLSX.read(buffer)` parses user-dropped `.xls/.xlsx` files (`Stage1Load.svelte:46` accepts these), so a malicious workbook can trigger prototype pollution in the page context. Blast radius is limited because parsing is client-side in the browser (no server), but prototype pollution in-page can still corrupt app state / enable downstream XSS depending on sinks. Flagged at medium given the client-only context.
- **Recommendation:** Either upgrade to the SheetJS CDN-hosted patched build (`xlsx` from `cdn.sheetjs.com`), pin a non-vulnerable alternative, or sandbox parsing in a worker and harden against prototype pollution (e.g. `Object.create(null)` result handling). Track via an audit-exception note if accepting the risk.

## Notes / limitations of this audit pass
- I confirmed the deformation WASM matches source by rebuilding with the host emcc 5.0.7. The build is reproducible on this machine; I did not test reproducibility across a different emscripten minor version (the README says "5.x is sufficient" — different 5.x patch releases could change codegen and break the SHA match, but that is a CI concern, not a current defect).
- I did not exhaustively diff every committed JS bridge file against the C++ wire reader field-by-field (that is the deformation-subsystem auditor's remit); I verified the magic/version handshake and the high-level encode/call/decode round trip only.
- The `report` routes set both `ssr=false` and `prerender=true`; this is a valid SvelteKit combination (prerenders a CSR shell) and the static build's prerender coverage looks complete (root `/`, `/report`, `/report/stage7` explicit; all `/docs/**` inherit `prerender=true` from `src/routes/docs/+layout.ts`; no dynamic `[param]` routes). I did not run a full `npm run build` to completion in this pass to confirm zero prerender errors — recommend that as a quick sanity gate.
- `xlsx` and `triangle-wasm` are both actively used (not dead deps); the vendored `src/lib/.../assets/triangle.out.wasm` is the one actually loaded and is byte-identical to node_modules, but being a manual copy it can silently drift on a `triangle-wasm` upgrade — worth a comment or a copy-in-build step.
- No COOP/COEP headers are set and none are needed: a repo-wide grep found no `SharedArrayBuffer` / `crossOriginIsolated` usage; the deformation WASM uses single-threaded `ALLOW_MEMORY_GROWTH` (no `-pthread`), and WebGPU does not require cross-origin isolation. So the absence of those headers is correct, not a defect.
