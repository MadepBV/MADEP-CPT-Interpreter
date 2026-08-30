# Audit — Svelte UI components, stages & app shell
**Subsystem key:** ui-components
**Files reviewed:** src/lib/components/cpt/CptInterpreterApp.svelte, src/lib/components/cpt/BannerPhaseShell.svelte, src/lib/components/cpt/StageNav.svelte, src/lib/components/cpt/stages/Stage1Load.svelte, src/lib/components/cpt/stages/Stage2Classification.svelte, src/lib/components/cpt/stages/Stage3Layers.svelte, src/lib/components/cpt/stages/Stage4Model.svelte, src/lib/components/cpt/stages/Stage5Tuning.svelte, src/lib/components/cpt/stages/Stage6Applications.svelte, src/lib/components/DocsHeader.svelte, src/routes/+page.svelte, src/routes/+layout.svelte, src/routes/+error.svelte, src/routes/+page.ts, src/lib/cpt-app/ui.ts, and the bridge surface of src/lib/cpt-app/legacy-controller.js (initLegacyController, bindDropzone, renderBanner, goS, setPhase, selectCpt, input handlers)
**Finding counts:** critical=0 high=2 medium=3 low=5 info=2  |  A=4 B=2 C=1 D=4  |  total=12

## Overview
The Svelte 5 layer is an intentionally thin, mostly-static presentational shell that hands all behaviour to the imperative `legacy-controller.js` (≈18.5k lines) through a single `window`-global bridge (`ui.ts` → `call(name, ...args)`). The Svelte components themselves are clean: no `$effect` loops, no stale-closure runes bugs, no per-render reactive recomputation, and Chart.js instances are destroyed on CPT switch. The real fragility lives at the Svelte↔legacy boundary: the controller's `initLegacyController` returns a **no-op destroy function**, so on SvelteKit client-side unmount/remount (e.g. navigating to `/docs` and back via the in-app footer link) the stage-navigation click listeners are lost and `document`-level dropzone listeners leak/stale. The init/teardown contract that `+page.svelte` carefully sets up is therefore not honoured by the controller it drives. These are the highest-value findings; the remainder are smaller correctness/dead-code items.

## Findings

### [UI-COMPONENTS-A-01] high · Stage-nav click handlers are lost after unmount/remount; `initLegacyController` returns a no-op destroy
- **Location:** `src/routes/+page.svelte:27-41` (onMount handoff), `src/lib/cpt-app/legacy-controller.js:18444-18456` (`initLegacyController`), `:1142-1146` (module-level `.si` binding), `src/lib/components/cpt/StageNav.svelte:1-10`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `StageNav.svelte` emits six `<button class="si" data-s="N">` elements with **no Svelte `onclick`** — they are wired exclusively by the controller at *module-evaluation time*:
  ```js
  // legacy-controller.js:1142
  document.querySelectorAll('.si').forEach(s=>{
    s.addEventListener('click',()=>{ if(!s.classList.contains('locked'))goS(+s.dataset.s); });
  });
  ```
  `+page.svelte` mounts the component, then `onMount` dynamically imports the controller and calls `initLegacyController()`, capturing its return value as `destroy` and invoking `destroy?.()` on unmount. But `initLegacyController` returns `()=>{}` (line 18455) and is guarded by `__legacyControllerInitialized` so it only ever runs its body **once per page lifetime**. On a SvelteKit client-side navigation away from `/` (the app's own `<a href="/docs">` footer link, `CptInterpreterApp.svelte:30`, has no `data-sveltekit-reload`) the component unmounts and the `.si` DOM nodes are destroyed. On navigating back, Svelte creates *fresh* `.si` nodes, but the module top-level binding (line 1142) does not re-run (module is cached) and `initLegacyController` early-returns at line 18445. The new stage buttons therefore have **zero click listeners** — stage navigation is silently dead until a full page reload. The carefully-built onMount/destroy contract in `+page.svelte` is effectively inert because the controller never returns a real teardown nor re-binds on re-init.
- **Recommendation:** Make `initLegacyController` idempotently (re-)bind DOM-coupled listeners on every call (move the `.si` binding and `bindDropzone` out of module top-level and out from behind the `__legacyControllerInitialized` guard, or key them off a fresh DOM `dataset.bound` flag like `bindDropzone` already does), and return a real destroy function that removes the listeners it added. Alternatively, give the `.si` buttons inline Svelte `onclick={() => call('goS', +n)}` so navigation survives remount independently of the controller.

### [UI-COMPONENTS-A-02] high · `document`-level dropzone listeners leak and capture a stale `dz` node across remount
- **Location:** `src/lib/cpt-app/legacy-controller.js:1955-1966` (`bindDropzone`), `:18447` (called from init), `src/routes/+page.svelte:37-41` (no-op cleanup)
- **Category:** A — Implementation (with B leak aspect)
- **Confidence:** confirmed
- **Analysis:** `bindDropzone` attaches three listeners to `document` (not to the dropzone), each closing over a captured `const dz`:
  ```js
  const dz=document.getElementById('dz');
  if(!dz || dz.dataset.bound==='1') return;
  document.addEventListener('dragover', e=>{...dz.classList.add('drag')});
  document.addEventListener('dragleave', e=>{ if(!dz.contains(e.relatedTarget)) dz.classList.remove('drag') });
  document.addEventListener('drop', e=>{ ... importGEFFiles(...) });
  dz.dataset.bound='1';
  ```
  These are never removed (the init contract's `destroy?.()` is a no-op). On unmount/remount the old `dz` element is detached but the three `document` listeners survive and keep referencing it. The `dz.dataset.bound` guard is on the *new* element (which is `undefined`), so `bindDropzone` would re-bind a *second* set if it were ever called again — but it isn't, because `initLegacyController` early-returns on re-init (see A-01). Net effect: leaked `document` listeners retaining a detached DOM node, plus drag-and-drop on the live dropzone after remount operates against a stale element and stale `drag` styling. Even within a single page lifetime these `document`-wide `dragover`/`drop` handlers fire for the whole document, not just the dropzone.
- **Recommendation:** Bind drag listeners to the `dz` element (or scope by checking `e.target.closest('#dz')`), store handler references, and remove them in a real teardown returned by `initLegacyController`. Re-resolve `dz` on each (re-)init rather than capturing it once at module scope.

### [UI-COMPONENTS-A-03] low · `+page.svelte` fast-unmount race leaves controller half-initialized (top-level side effects ran, `window` API not assigned)
- **Location:** `src/routes/+page.svelte:27-41`
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** `onMount` does `const mod = await import(...); if (cancelled) return; destroy = mod.initLegacyController?.()`. The cleanup sets `cancelled = true`. If the component unmounts before the dynamic import resolves, `initLegacyController()` is never called, so `Object.assign(window, legacyApi)` (line 18446) never runs and the `window.goS`/`window.call` targets are absent — yet the controller module's *top-level* side effect (line 1142 `.si` binding) has already executed against now-detached DOM. The window guard means a subsequent successful mount can still recover because `initLegacyController` body runs then, but during the gap any `call('...')` from a Svelte handler silently no-ops (`getLegacy()[name]?.()` in `ui.ts:7`). This is an unlikely timing window (import of an already-loaded module is fast) and degrades gracefully, hence low.
- **Recommendation:** Move *all* DOM-coupling side effects into `initLegacyController` (none at module top level), and have the cleanup actively unbind. Optionally surface a console warning when `call()` targets a missing function so silent no-ops are observable in dev.

### [UI-COMPONENTS-A-04] low · DocsHeader Escape-to-close handler is on a non-focusable element and effectively never fires
- **Location:** `src/lib/components/DocsHeader.svelte:43-52`
- **Category:** A — Implementation (accessibility/behaviour)
- **Confidence:** confirmed
- **Analysis:** The Escape handler is attached to the backdrop div:
  ```svelte
  <div class="dh__backdrop" ... role="button" tabindex="-1"
       onclick={close}
       onkeydown={(e) => { if (e.key === 'Escape') close(); }}></div>
  ```
  `tabindex="-1"` makes the element programmatically-focusable only; nothing focuses it when the menu opens, so it never has keyboard focus and its `onkeydown` will not receive Escape. There is no document/window-level `keydown` listener either. Therefore Escape never closes the mobile nav — only backdrop click or toggling the hamburger does. Backdrop click-to-close works, so this is a minor a11y gap, not a functional break.
- **Recommendation:** Attach the Escape handler at the window level via `<svelte:window onkeydown={...} />` guarded by `menuOpen`, or move focus to the panel/close button when the menu opens. (No `$effect` cleanup concern since `<svelte:window>` auto-teardowns.)

### [UI-COMPONENTS-B-01] medium · Leaked global listeners (`hashchange`, document drag listeners, `.si` clicks) are never removed for the lifetime of the tab
- **Location:** `src/lib/cpt-app/legacy-controller.js:18450-18453` (`hashchange`), `:1958-1964` (document drag), `:1142-1146` (`.si`); contract origin `src/routes/+page.svelte:37-41`
- **Category:** B — Memory/Performance
- **Confidence:** confirmed
- **Analysis:** `initLegacyController` adds `window.addEventListener('hashchange', stage6BishopHandleHashChange)` (guarded by `__legacyControllerHashBound`, so single-instance) and `bindDropzone` adds three `document` listeners. None of these are ever removed because the returned destroy is `()=>{}`. In a single-page session this is a bounded, one-time leak (not unbounded growth), but it violates the unmount contract `+page.svelte` defines and retains the controller's entire closure graph (incl. `S`/`PROJECT`, charts, workers) alive even after the app UI is unmounted to view docs. Combined with A-01/A-02 the practical symptom is broken behaviour on return rather than runaway memory, so medium not high.
- **Recommendation:** Track every global listener added and remove them in a real teardown; this also resolves A-01/A-02.

### [UI-COMPONENTS-B-02] low · Web workers (bishop/seepage/deformation) are not terminated on app unmount
- **Location:** `src/lib/cpt-app/legacy-controller.js:7906, 7954, 8030` (worker creation), `:7825, 7853, 7880, 7945, 8021, 8143` (terminate sites); unmount path `src/routes/+page.svelte:37-41`
- **Category:** B — Memory/Performance
- **Confidence:** likely
- **Analysis:** Three `new Worker(...)` are created for Stage-6 Bishop/seepage/deformation. They are terminated at the end of each run (the terminate sites exist) and on CPT switch (`selectCpt` calls `stage6BishopStopSearch`/`stage6BishopStopSeepage` at lines 149-150), which is good hygiene during normal use. However, because `initLegacyController` returns a no-op destroy, a worker still running when the user navigates away from the app route (`CptInterpreterApp` unmount) is **not** terminated by any unmount hook — it would only stop on its natural completion or next user action after remount. Given runs are user-triggered and usually short, and most paths self-terminate, this is low.
- **Recommendation:** In the controller teardown, call the existing stop/terminate helpers for any live workers so background compute is cancelled when the app UI unmounts.

### [UI-COMPONENTS-C-01] info · Stage4Model docstring claims "Hardening Soil" while the Stage-6 deformation HS UI is hard-disabled by a flag (Stage-4 HS params *are* shown — no real conflict)
- **Location:** `src/lib/components/cpt/stages/Stage4Model.svelte:11-12` ("Mohr-Coulomb and Hardening Soil (p_ref = 100 kPa)"), `src/lib/cpt-app/legacy-controller.js:104` (`STAGE6_ENABLE_HARDENING_SOIL_UI = false`), `:3480-3524` (`renderModel` still renders the HS parameter block)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) The Stage-4 UI subtitle states Hardening-Soil parameters are produced at `p_ref = 100 kPa`. (2) The code: `renderModel` (the function backing Stage 4) DOES render a "Hardening Soil — p_ref = 100 kPa" block (line 3524) and `hsParams()` computes `Eoed,ref`, `E50,ref`, `Eur,ref`, `m`. The `STAGE6_ENABLE_HARDENING_SOIL_UI=false` flag only gates the *Stage-6 deformation solver's* HS constitutive option (lines 4603, 7001, 15377, etc.), not the Stage-4 parameter table. (3) Scientifically the Stage-4 docstring is correct and consistent with what Stage 4 shows; the `Eoed,i = αE·qc` claim matches `legacy-controller.js:3428` (`aE*l.avgQc*1000`, MPa→kPa) and the cohesion-corrected `Eoed,ref = Eoed,i / ratio^m` matches line 3445. (4) No fix needed for the Stage-4 doc. Flagged only so a reviewer does not mistake the disabled Stage-6 HS path (see D-01) for a Stage-4 doc/code conflict.
- **Recommendation:** No change to Stage4Model.svelte. If the disabled Stage-6 HS solver is intended to stay off long-term, note that in the engineering docs to avoid confusion; otherwise see D-01.

### [UI-COMPONENTS-D-01] medium · Hardening-Soil Stage-6 deformation UI is dead behind a `false` compile-time flag at ~18 call sites
- **Location:** `src/lib/cpt-app/legacy-controller.js:104` (`const STAGE6_ENABLE_HARDENING_SOIL_UI = false;`), referenced at lines 3522, 4603, 4739, 4922, 7001, 7028, 7031, 7044, 7049, 9187, 9876, 14604, 14672, 14763, 15377, 15690, 16242
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** The constant is `false` and never reassigned, so every `STAGE6_ENABLE_HARDENING_SOIL_UI && ...` branch is statically unreachable and the HS deformation constitutive-model UI, material tables, and result-rendering paths are all dead. The surrounding solver code is retained deliberately (comment at lines 101-102: "Hardening Soil remains in the lower-level solver code while it is being [stabilized]"). This is intentional feature-gating, but it is a large block of currently-unreachable UI logic that a reader of the Stage-4/Stage-6 surface should be aware of. FLAG ONLY — do not remove (the solver may be re-enabled).
- **Recommendation:** Keep as-is if HS is genuinely "in progress"; otherwise either re-enable behind a runtime toggle or remove the dead UI branches once a decision is made. Add a single comment near line 104 enumerating that the flag gates Stage-6 deformation HS only (not Stage-4 HS parameters) to prevent misreads.

### [UI-COMPONENTS-D-02] low · Redundant phase-active toggling in `setPhase`
- **Location:** `src/lib/cpt-app/legacy-controller.js:280-291`
- **Category:** D — Dead code (redundant logic)
- **Confidence:** confirmed
- **Analysis:** `setPhase` toggles the `active` class on `#phaseA/#phaseB/#phaseC` twice: once via the loop over `['analysis','correlation','section']` (lines 282-284) and again with three explicit `getElementById('phaseA'/'phaseB'/'phaseC').classList.toggle('active', ...)` calls (lines 285-287). The two do the same work. The explicit trio also assumes the elements exist (no `?.`), unlike the loop which uses `?.`. Harmless duplication; mildly increases the chance of divergence if one block is edited.
- **Recommendation:** Drop one of the two blocks (keep the `?.`-guarded loop).

### [UI-COMPONENTS-D-03] low · `setElev` dead sub-condition `v===''` after numeric coercion
- **Location:** `src/lib/components/cpt/stages/Stage1Load.svelte:67` (passes `+value`), `src/lib/cpt-app/legacy-controller.js:1662`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** The Svelte handler calls `call('setElev', +(event.currentTarget).value)`, so `v` is already a `number` (`NaN` for empty input). In `setElev`, `S.elev=(isNaN(v)||v==='')?null:v;` — the `v===''` branch can never be true because `v` is numeric; `isNaN(v)` already covers the empty case. Pure dead operand. (No correctness impact: empty → `NaN` → `null` works.)
- **Recommendation:** Simplify to `isNaN(v) ? null : v`.

### [UI-COMPONENTS-D-04] info · `+error.svelte` props `error`/`status` and `+layout.svelte` are standard scaffold; `StageNav`/panels rely entirely on external DOM IDs
- **Location:** `src/routes/+error.svelte:3`, `src/routes/+layout.svelte`, `src/lib/components/cpt/StageNav.svelte`
- **Category:** D — Dead code / coupling note
- **Confidence:** confirmed
- **Analysis:** Not dead per se, but worth recording for the subsystem map: every interactive Svelte stage component (`StageNav`, `Stage1..6`, `BannerPhaseShell`) is a static template whose behaviour depends on string-matched DOM IDs (`#nav`, `.si`, `#p0..#p5`, `#dz`, `#cptTabs`, `#wtR`, `#chartArea`, etc.) consumed by `legacy-controller.js`. There is no compile-time contract linking the two; renaming an ID in markup silently breaks the controller. This is the structural root cause behind A-01/A-02 and should be treated as a known design constraint when editing these components.
- **Recommendation:** Document the ID contract (or migrate critical wiring to inline Svelte handlers / `bind:this`) so the markup↔controller coupling is explicit and remount-safe.

## Notes / limitations of this audit pass
- I read all 14 in-scope Svelte/route files in full plus `ui.ts`, and the bridge-relevant portions of the 906 KB `legacy-controller.js` (init/teardown, `bindDropzone`, `renderBanner`, `goS`, `setPhase`, `selectCpt`, all Stage-1/2 input handlers, chart lifecycle, worker create/terminate sites, and the HS flag). I did **not** exhaustively read the full controller — numerical/constitutive correctness inside it (Bishop, seepage, deformation, pile, EC2) belongs to other subsystem passes and is out of scope here.
- The remount findings (A-01, A-02, B-01) were verified by tracing: (a) `StageNav.svelte` has no inline handlers; (b) the only `.si` binding is module top-level at line 1142; (c) `initLegacyController` early-returns on re-init and returns a no-op; (d) the in-app `/docs` footer link uses default client-side navigation. I did not execute the app to capture a runtime repro; the conclusion is from static control-flow and SvelteKit's documented client-side navigation/component-lifecycle behaviour. Confidence is "confirmed" for the code facts and "likely" for the precise runtime symptom timing.
- I could not rule out that a higher-level layout or store keeps `CptInterpreterApp` mounted across `/` ↔ `/docs` navigation in some configuration; the layout (`+layout.svelte`) simply renders `{@render children()}`, which swaps page components, so I judged remount to occur — but a second pass with an actual navigation trace would make A-01 airtight.
- `setMinThk`/`setWT`/`setElev`/`setCptCoord` NaN/range guards were checked and are correct; no A-category unit/sign issues were found in the Svelte→controller argument marshalling (MPa/kPa handling for `Eoed,i` is consistent with the Stage-4 docstring).
