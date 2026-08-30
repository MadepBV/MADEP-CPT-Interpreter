#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifier for src/lib/cpt-app/model-params/* — the Stage 4 derivation moved out of
// legacy-controller.js in refactor step 2 (PR 5): stressAt(cpt, z, …), hsParams(layer, ctx),
// khParams(layer, ctx), workingLayers(cpt), cptModelCtx(cpt) and the soil tables.
//
// Three parts:
//   1. unit checks of the pure functions under plain Node (no Vite, no DOM stub);
//   2. the recorded goldens under tests/golden/node/model/ are the truth: every
//      <fixture>.<alpha><stiff><khkv>.<paramMethod>.json is recomputed from the golden layer
//      table (<fixture>.layers.<paramMethod>.json) + the fixture's wt/elev/assumedRf (from the
//      import goldens / manifest injection) and must be deep-equal (tolerance class "pure");
//   3. wrapper ⇔ pure agreement: the controller is loaded through the golden Tier-B loader
//      (scripts/golden/lib — DOM stub, no browser) for the demo fixture and the monolith
//      wrappers hsParams/khParams/stressAt/stage6WorkingLayers must return exactly what the
//      pure functions return for cptModelCtx(S). Skip with --pure-only.
//
// Also asserts the extraction is complete (the moved bodies are not declared in the
// controller again, the stratigraphy S-swap is gone, the package is imported).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'tests/golden');
const PURE_ONLY = process.argv.includes('--pure-only');

const {
  DEF, AE, MC_NU_BY_TYPE, MC_NU_BY_SUBTYPE, MC_RSHEAR_BY_TYPE, MC_RSHEAR_BY_SUBTYPE,
  mohrCoulombNuDefault, mohrCoulombRShearDefault,
  sb260GranularAlpha, sb260TransitionAlpha, sb260AlphaFamily, alphaEB,
  stressAt, cptModelCtx, hsParams, khParams, workingLayers
} = await import('../src/lib/cpt-app/model-params/index.js');
const { normalizeAssumedRf, DEFAULT_ASSUMED_RF } = await import('../src/lib/cpt-app/classification-core.js');

let fails = 0;
let count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 12).join('\n      ')}`); }
}
async function checkAsync(name, fn) {
  count++;
  try { await fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 12).join('\n      ')}`); }
}

/** Same shape the golden normaliser stores: keys sorted, undefined dropped, non-finite as strings. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) { if (v[k] !== undefined && typeof v[k] !== 'function') o[k] = canon(v[k]); }
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const layer = (over = {}) => ({
  id: 0, top: 2, bot: 6, type: 'Sand', subtype: 'zand, matig', avgQc: 12, avgFs: 0.08, avgRf: 0.7,
  rfIndeterminate: false, g: 19, gs: 20, phi: 34, c: 0, cu: 0, ovr: {}, ...over
});
const ctxOf = (over = {}) => ({ wt: 1.7, elev: 10, alphaMethod: 'B', stiffMethod: 'B', khKvMethod: 'A', assumedRf: 3, ...over });

// ------------------------------------------------------------ 1. unit checks
console.log('\n[1] soil tables and α helpers');
check('DEF / AE cover the seven CPT soil types', () => {
  const types = ['Peat / organic', 'Soft clay', 'Clay', 'Sandy clay', 'Silty sand', 'Sand', 'Gravel'];
  assert.deepEqual(Object.keys(DEF), types);
  assert.deepEqual(Object.keys(AE), types);
  assert.deepEqual(DEF['Clay'], { g: 17, gs: 18, phi: 24, c: 5, cu: 50 });
  assert.equal(AE['Sand'], 13.0);
});
check('sb260GranularAlpha: 4 below 10 MPa, (2qc+20)/qc to 50 MPa, 120/qc above', () => {
  assert.equal(sb260GranularAlpha(5), 4);
  assert.equal(sb260GranularAlpha(10), 4);
  assert.equal(sb260GranularAlpha(20), 3);
  assert.equal(sb260GranularAlpha(50), 2.4);
  assert.equal(sb260GranularAlpha(60), 2);
});
check('sb260TransitionAlpha: 2 below 2.5 MPa, (4qc-5)/qc to 5 MPa, 2 above', () => {
  assert.equal(sb260TransitionAlpha(1), 2);
  assert.equal(sb260TransitionAlpha(4), 2.75);
  assert.equal(sb260TransitionAlpha(5), 2);
});
check('sb260AlphaFamily: subtype wins over type, Rf 1-2 % sends untyped sand to transition', () => {
  assert.equal(sb260AlphaFamily('Sand', 'veen, matig vast'), 'cohesive-peat');
  assert.equal(sb260AlphaFamily('Clay', 'klei (zh), vast'), 'transition');
  assert.equal(sb260AlphaFamily('Clay', 'zand (lh), los'), 'transition');
  assert.equal(sb260AlphaFamily('Clay', 'grind (kh), matig'), 'granular');
  assert.equal(sb260AlphaFamily('Clay', 'zand, dicht'), 'granular');
  assert.equal(sb260AlphaFamily('Sand', 'klei, vast'), 'cohesive-clay');
  assert.equal(sb260AlphaFamily('Sand', 'leem, vast'), 'cohesive-loam');
  assert.equal(sb260AlphaFamily('Sand', '', 1.5), 'transition');
  assert.equal(sb260AlphaFamily('Silty sand', '', 0.5), 'granular');
  assert.equal(sb260AlphaFamily('Sandy clay', ''), 'cohesive-loam');
  assert.equal(sb260AlphaFamily('Soft clay', ''), 'cohesive-clay');
  assert.equal(sb260AlphaFamily('Gravel', ''), 'granular');
  assert.equal(sb260AlphaFamily('Peat / organic', ''), 'cohesive-peat');
});
check('alphaEB per family (clay 5/3/1.5, loam 4/2, peat 1.5, granular, transition), qc floor 0.01', () => {
  assert.equal(alphaEB('Clay', 0.5, 'klei, weinig vast'), 5);
  assert.equal(alphaEB('Clay', 1.0, 'klei, matig vast'), 3);
  assert.equal(alphaEB('Clay', 2.0, 'klei, vast'), 1.5);
  assert.equal(alphaEB('Sandy clay', 1.5, 'leem, matig vast'), 4);
  assert.equal(alphaEB('Sandy clay', 2.5, 'leem, vast'), 2);
  assert.equal(alphaEB('Peat / organic', 0.3, 'veen, matig vast'), 1.5);
  assert.equal(alphaEB('Sand', 20, 'zand, dicht'), 3);
  assert.equal(alphaEB('Sandy clay', 4, 'klei (zh), vrij vast'), 2.75);
  assert.equal(alphaEB('Clay', 0, 'klei, vast'), 5);          // qc 0 → floor 0.01 → < 0.7
  assert.equal(alphaEB('Clay', null, 'klei, vast'), 5);       // null → 0.1
});
check('mohrCoulombNuDefault / RShearDefault: subtype (case-insensitive, trimmed) first, type fallback, then 0.30 / 0.25', () => {
  assert.equal(mohrCoulombNuDefault('Sand', ' Zand, Dicht '), MC_NU_BY_SUBTYPE['zand, dicht']);
  assert.equal(mohrCoulombNuDefault('Sand', 'unknown'), MC_NU_BY_TYPE['Sand']);
  assert.equal(mohrCoulombNuDefault('Nope', ''), 0.30);
  assert.equal(mohrCoulombRShearDefault('Clay', 'klei (zh), vast'), MC_RSHEAR_BY_SUBTYPE['klei (zh), vast']);
  assert.equal(mohrCoulombRShearDefault('Gravel', null), MC_RSHEAR_BY_TYPE['Gravel']);
  assert.equal(mohrCoulombRShearDefault('Nope', undefined), 0.25);
});

console.log('\n[2] stressAt(cpt, z, γsat, γunsat)');
check('above the water table: σv = γunsat·z, u = 0, σ′v = σv', () => {
  assert.deepEqual(stressAt({ wt: 1.7 }, 1.0, 20, 18), { sigV: 18, u: 0, sigVeff: 18 });
});
check('below the water table: σv = γunsat·wt + γsat·(z−wt), u = 9.81·(z−wt)', () => {
  const r = stressAt({ wt: 1.7 }, 4.0, 20, 18);
  const sigV = 18 * 1.7 + 20 * (4.0 - 1.7), u = 9.81 * (4.0 - 1.7);   // sigVeff uses the unrounded values
  assert.deepEqual(r, { sigV: +sigV.toFixed(2), u: +u.toFixed(2), sigVeff: sigV - u });
});
check('γunsat omitted → γsat for both zones (Stage 2 usage); σ′v floored at 1 kPa; wt above surface', () => {
  assert.deepEqual(stressAt({ wt: 1.0 }, 2.0, 18), { sigV: 36, u: 9.81, sigVeff: 36 - 9.81 });
  assert.equal(stressAt({ wt: 0 }, 0.05, 18, 17).sigVeff, 1);
  const sigV = 18 * -0.5 + 20 * (1.0 - -0.5), u = 9.81 * (1.0 - -0.5);
  assert.deepEqual(stressAt({ wt: -0.5 }, 1.0, 20, 18), { sigV: +sigV.toFixed(2), u: +u.toFixed(2), sigVeff: sigV - u });
});
check('reads only cpt.wt — a model ctx works as the first argument', () => {
  assert.deepEqual(stressAt(ctxOf(), 3, 20, 18), stressAt({ wt: 1.7 }, 3, 20, 18));
});

console.log('\n[3] cptModelCtx(cpt)');
check('copies wt/elev/alphaMethod/stiffMethod/khKvMethod and normalises assumedRf', () => {
  const cpt = { wt: 2.1, elev: 12.5, alphaMethod: 'A', stiffMethod: 'B', khKvMethod: 'B', assumedRf: 4.2, layers: [], data: [] };
  assert.deepEqual(cptModelCtx(cpt), { wt: 2.1, elev: 12.5, alphaMethod: 'A', stiffMethod: 'B', khKvMethod: 'B', assumedRf: 4.2 });
  assert.equal(cptModelCtx({ assumedRf: null }).assumedRf, DEFAULT_ASSUMED_RF);
  assert.equal(cptModelCtx({ assumedRf: 0 }).assumedRf, DEFAULT_ASSUMED_RF);
  assert.equal(cptModelCtx({ assumedRf: 50 }).assumedRf, 10);
  assert.equal(cptModelCtx({ assumedRf: '2.5' }).assumedRf, 2.5);
});

console.log('\n[4] khParams(layer, ctx)');
check('sand consistency bands and kh/kv per method (silty sand 3 → 2 under Bear)', () => {
  const dense = khParams(layer({ subtype: 'zand, dicht' }), ctxOf());
  assert.deepEqual([dense.kh_min, dense.kh_max, dense.kh_rep, dense.khkv, dense.kv_rep], [1.2e-4, 2.3e-4, 1.5e-4, 1, 1.5e-4]);
  assert.equal(khParams(layer({ subtype: 'zand, zeer dicht' }), ctxOf()).kh_rep, 2e-4);
  assert.equal(khParams(layer({ subtype: 'zand, los' }), ctxOf()).kh_rep, 3e-6);
  const siltyA = khParams(layer({ type: 'Silty sand', subtype: 'zand (lh), matig' }), ctxOf({ khKvMethod: 'A' }));
  const siltyB = khParams(layer({ type: 'Silty sand', subtype: 'zand (lh), matig' }), ctxOf({ khKvMethod: 'B' }));
  assert.equal(siltyA.khkv, 3); assert.equal(siltyB.khkv, 2);
  assert.equal(siltyA.kv_rep, 1e-6); assert.equal(siltyB.kv_rep, 1.5e-6);
  assert.equal(khParams(layer({ type: 'Clay', subtype: 'klei, vast' }), ctxOf({ khKvMethod: 'B' })).khkv, 3);
  assert.equal(khParams(layer({ type: 'Gravel', subtype: 'grind, matig' }), ctxOf({ khKvMethod: 'B' })).khkv, 1);
});
check('ψ_unsat, infiltration class and the ×10⁻ⁿ formatting', () => {
  const clay = khParams(layer({ type: 'Clay', subtype: 'klei, vast' }), ctxOf());
  assert.equal(clay.psi_unsat, 3);
  assert.equal(clay.infClass, 'Infiltratie + buffer');
  assert.equal(clay.kh_rep_fmt, '5×10⁻8');
  assert.equal(khParams(layer({ type: 'Sandy clay', subtype: 'leem, vast' }), ctxOf()).psi_unsat, 1);
  assert.equal(khParams(layer({ type: 'Soft clay', subtype: '' }), ctxOf()).infClass, 'Infiltratie + buffer');
  assert.equal(khParams(layer({ type: 'Peat / organic', subtype: '' }), ctxOf()).infClass, 'Infiltratie (effectief)');
  assert.equal(khParams(layer(), ctxOf()).infClass, 'Infiltratie (volledig)');
  assert.equal(khParams(layer({ type: 'Unknown' }), ctxOf()).kh_rep, 1e-5);
});

console.log('\n[5] hsParams(layer, ctx)');
check('α: method A table, method B SB260, engineer override wins', () => {
  assert.equal(hsParams(layer(), ctxOf({ alphaMethod: 'A' })).aE, 13);
  assert.equal(hsParams(layer(), ctxOf({ alphaMethod: 'B' })).aE, 3.67);
  assert.equal(hsParams(layer({ ovr: { aE: true }, aE_ovr: 7.25 }), ctxOf()).aE, 7.25);
});
check('method B uses ctx.assumedRf only when the layer has no measured Rf (qc-only CPTs)', () => {
  const untyped = layer({ subtype: '', avgRf: null, avgQc: 12 });
  assert.equal(hsParams(untyped, ctxOf({ assumedRf: 1.5 })).aE, 2);      // Rf 1-2 % → transition family → α = 2 at qc ≥ 5 MPa
  assert.equal(hsParams(untyped, ctxOf({ assumedRf: 3 })).aE, 3.67);     // Rf 3 % → granular → (2·12+20)/12
  assert.equal(hsParams(layer({ subtype: '', avgRf: 0.7 }), ctxOf({ assumedRf: 1.5 })).aE, 3.67); // measured Rf wins
});
check('stiffness A (CUR 2003-7: cohesive incl. leem ×1.25) vs B (E50 = Eoed), Eur = 3·E50_ref', () => {
  const clay = layer({ type: 'Clay', subtype: 'klei, matig vast', avgQc: 1.2, phi: 22, c: 10, g: 17, gs: 18 });
  const a = hsParams(clay, ctxOf({ stiffMethod: 'A' }));
  const b = hsParams(clay, ctxOf({ stiffMethod: 'B' }));
  assert.equal(a.Eoed_i, b.Eoed_i);
  assert.equal(a.E50_i, +(1.25 * a.Eoed_i).toFixed(0));
  assert.equal(b.E50_i, b.Eoed_i);
  assert.equal(a.Eur_ref, +(3 * a.E50_ref).toFixed(0));
  assert.equal(b.Eur_ref, +(3 * b.Eoed_ref).toFixed(0));
  const leem = hsParams(layer({ type: 'Sandy clay', subtype: 'leem, vast', avgQc: 3, phi: 28, c: 2 }), ctxOf({ stiffMethod: 'A' }));
  assert.equal(leem.E50_i, +(1.25 * leem.Eoed_i).toFixed(0));
  assert.equal(leem.m, 1.0);
  const sand = hsParams(layer(), ctxOf({ stiffMethod: 'A' }));
  assert.equal(sand.E50_i, sand.Eoed_i);
  assert.equal(sand.m, 0.5);
});
check('m / ν / R_inter overrides with clamping; β and E_def from the rounded β; ψ = φ−30', () => {
  const h = hsParams(layer({ ovr: { m: true, nu: true, rShear: true }, m_ovr: 0.7, nu_ovr: 0.9, rShear_ovr: 0 }), ctxOf());
  assert.equal(h.m, 0.7);
  assert.equal(h.nu, 0.49);
  assert.equal(h.rShear, 0.25);     // Number(0) || 0.25 → 0.25, clamped to [0.01, 1]
  assert.equal(h.beta, +(((1 + 0.49) * (1 - 2 * 0.49)) / (1 - 0.49)).toFixed(3));
  assert.equal(h.Edef, +(h.beta * h.Eoed_i).toFixed(0));
  assert.equal(h.psi, 4);
  assert.equal(h.nu_ur, 0.20);
  assert.equal(h.Emc, h.E50_i);
  const d = hsParams(layer(), ctxOf());
  assert.equal(d.nu, MC_NU_BY_SUBTYPE['zand, matig']);
  assert.equal(d.rShear, MC_RSHEAR_BY_SUBTYPE['zand, matig']);
  assert.equal(d.K0nc, +(1 - Math.sin(34 * Math.PI / 180)).toFixed(3));
});
check('TAW levels from ctx.elev, "—" without a surface level; stresses from ctx.wt at mid-depth', () => {
  const h = hsParams(layer(), ctxOf({ elev: 10, wt: 1.7 }));
  assert.equal(h.topTAW, '8.00m TAW');
  assert.equal(h.botTAW, '4.00m TAW');
  const s = stressAt({ wt: 1.7 }, 4, 20, 19);
  assert.deepEqual([h.sigV, h.u, h.sigVeff], [+s.sigV.toFixed(1), +s.u.toFixed(1), +s.sigVeff.toFixed(1)]);
  assert.equal(hsParams(layer(), ctxOf({ elev: null })).topTAW, '—');
});
check('ctx.stressAt hook overrides the stress model when supplied', () => {
  const h = hsParams(layer(), ctxOf({ stressAt: () => ({ sigV: 50, u: 0, sigVeff: 50 }) }));
  assert.equal(h.sigVeff, 50);
});

console.log('\n[6] workingLayers(cpt)');
check('copies every layer and adds index + the 13 derived fields of the CPT\'s own ctx', () => {
  const cpt = { wt: 1.7, elev: 10, alphaMethod: 'B', stiffMethod: 'B', khKvMethod: 'A', assumedRf: 3, layers: [layer(), layer({ id: 1, top: 6, bot: 9, type: 'Clay', subtype: 'klei, vast', avgQc: 1.5, phi: 24, c: 5, g: 17, gs: 18 })] };
  const wl = workingLayers(cpt);
  assert.equal(wl.length, 2);
  assert.notEqual(wl[0], cpt.layers[0]);
  assert.deepEqual(Object.keys(wl[0]).filter((k) => !(k in cpt.layers[0])), ['index', 'Eoed_ref', 'Eoed_i', 'E50_ref', 'Eur_ref', 'm', 'Emc', 'nu', 'K0nc', 'rShear', 'psi', 'kh', 'kv', 'nu_ur']);
  const ctx = cptModelCtx(cpt);
  const h = hsParams(cpt.layers[1], ctx), k = khParams(cpt.layers[1], ctx);
  assert.deepEqual([wl[1].index, wl[1].Eoed_ref, wl[1].kh, wl[1].kv, wl[1].nu_ur], [1, h.Eoed_ref, k.kh_rep, k.kv_rep, h.nu_ur]);
  assert.deepEqual(workingLayers({ ...cpt, layers: [] }), []);
});

// ---------------------------------------------- 2. the recorded goldens are the truth
console.log('\n[7] tests/golden/node/model/* recomputed from the golden layer tables');
{
  const modelDir = join(GOLDEN, 'node/model');
  const manifest = readJson(join(GOLDEN, 'fixtures/manifest.json'));
  const fixtureCtx = (fx) => {
    const entry = manifest.fixtures[`cpt/${fx}.gef`] || manifest.fixtures[`cpt/${fx}.state.json`];
    const base = entry?.base ? entry.base.replace(/\.gef$/, '') : fx;
    const imp = readJson(join(GOLDEN, 'node/import', `${base}.gef.json`));
    return { wt: imp.wt, elev: imp.elev, assumedRf: imp.assumedRf, ...(entry?.inject || {}) };
  };
  const files = readdirSync(modelDir).filter((f) => /^[^.]+\.[AB]{3}\.(sb260|def)\.json$/.test(f)).sort();
  assert.ok(files.length >= 144, `expected ≥144 model goldens, found ${files.length}`);
  let cases = 0;
  const fixtures = new Set();
  for (const f of files) {
    const [fx, combo, pm] = f.split('.');
    fixtures.add(fx);
    const layers = readJson(join(modelDir, `${fx}.layers.${pm}.json`));
    const expected = readJson(join(modelDir, f));
    const base = fixtureCtx(fx);
    const ctx = { wt: base.wt, elev: base.elev, alphaMethod: combo[0], stiffMethod: combo[1], khKvMethod: combo[2], assumedRf: normalizeAssumedRf(base.assumedRf) };
    check(`model/${f} (${layers.length} layers, wt ${base.wt}, elev ${base.elev})`, () => {
      const actual = canon(layers.map((l) => ({ hs: hsParams(l, ctx), kh: khParams(l, ctx) })));
      assert.deepStrictEqual(actual, canon(expected));
    });
    cases++;
  }
  check(`covered ${cases} golden cases over ${fixtures.size} fixtures × {A,B}³ × {sb260,def}`, () => {
    assert.equal(cases, files.length);
    assert.ok(fixtures.has('demo-anonymous') && fixtures.has('qc-only') && fixtures.has('wt-above-surface'));
  });
}

// ------------------------------------------------- 3. wrapper ⇔ pure agreement
console.log('\n[8] controller wrappers ⇔ pure functions (demo fixture, Tier-B loader)');
if (PURE_ONLY) {
  console.log('SKIP  --pure-only');
} else {
  const { makeContext } = await import('./golden/lib/context.mjs');
  const gctx = await makeContext();
  try {
    const c = await gctx.controller();
    const { api } = c;
    const S = await gctx.classify('demo-anonymous', 'sb260');
    api.goS(3);
    await checkAsync('demo fixture classified with layers', async () => { assert.ok(S.layers.length >= 3, `layers: ${S.layers.length}`); });
    for (const p of ['sb260', 'def']) {
      api.setParamMethod(p);
      for (const a of ['A', 'B']) for (const s of ['A', 'B']) for (const k of ['A', 'B']) {
        api.setAlphaMethod(a); api.setStiffMethod(s); api.setKhKvMethod(k);
        check(`${a}${s}${k}.${p}: hsParams / khParams wrappers == pure(layer, cptModelCtx(S))`, () => {
          const ctx = cptModelCtx(S);
          assert.deepStrictEqual({ alphaMethod: ctx.alphaMethod, stiffMethod: ctx.stiffMethod, khKvMethod: ctx.khKvMethod }, { alphaMethod: a, stiffMethod: s, khKvMethod: k });
          for (const l of S.layers) {
            assert.deepStrictEqual(canon(api.hsParams(l)), canon(hsParams(l, ctx)));
            assert.deepStrictEqual(canon(api.khParams(l)), canon(khParams(l, ctx)));
          }
        });
      }
    }
    check('stressAt wrapper == stressAt(S, …) on the row grid and at layer mid-depths', () => {
      for (const r of S.data.filter((_, i) => i % 7 === 0)) assert.deepStrictEqual(api.stressAt(r.z, 18, 17), stressAt(S, r.z, 18, 17));
      for (const l of S.layers) assert.deepStrictEqual(api.stressAt((l.top + l.bot) / 2, l.gs, l.g), stressAt(S, (l.top + l.bot) / 2, l.gs, l.g));
    });
    // stage6WorkingLayers() is not published on window (and this PR adds no name to it); the
    // Stage 7 payload embeds safeClone(stage6WorkingLayers()) as stage6.layers once a
    // Stage 6 app has rendered, so the wrapper is observed through buildStage7Payload().
    const activeWorkingLayers = () => {
      api.goS(5); api.setStage6App('bearing');
      c.alerts.length = 0;
      const payload = api.buildStage7Payload();
      assert.ok(payload && payload.stage6 && Array.isArray(payload.stage6.layers), 'Stage 7 payload without stage6.layers');
      return payload.stage6.layers;
    };
    check('stage6WorkingLayers wrapper (via buildStage7Payload().stage6.layers) == workingLayers(S)', () => {
      assert.deepStrictEqual(canon(activeWorkingLayers()), canon(workingLayers(S)));
    });
    check('a second CPT with other settings derives with its own ctx (the stratigraphy path needs no S swap)', () => {
      const other = { ...S, wt: 0.4, elev: 3.5, alphaMethod: 'A', stiffMethod: 'A', khKvMethod: 'B', assumedRf: 2.0 };
      const mine = workingLayers(other);
      const active = activeWorkingLayers();
      assert.equal(mine.length, active.length);
      assert.notDeepStrictEqual(canon(mine), canon(active));
      const ctx = cptModelCtx(other);
      for (let i = 0; i < mine.length; i++) {
        assert.equal(mine[i].Eoed_ref, hsParams(other.layers[i], ctx).Eoed_ref);
        assert.equal(mine[i].kv, khParams(other.layers[i], ctx).kv_rep);
      }
      // the active CPT was not touched by deriving for another one
      assert.deepStrictEqual(canon(activeWorkingLayers()), canon(active));
    });
    check('the window surface still publishes the Stage 4 names', () => {
      for (const n of ['hsParams', 'khParams', 'stressAt', 'alphaEB', 'sb260GranularAlpha', 'sb260TransitionAlpha', 'sb260AlphaFamily']) assert.equal(typeof api[n], 'function', n);
    });
  } finally {
    await gctx.close();
  }
}

// ------------------------------------------------------ 4. extraction complete
console.log('\n[9] extraction complete');
check('legacy-controller.js no longer declares the moved bodies and imports model-params/', () => {
  const src = readFileSync(join(ROOT, 'src/lib/cpt-app/legacy-controller.js'), 'utf8');
  for (const decl of ['const DEF={', 'const AE={', 'const MC_NU_BY_TYPE=', 'const MC_RSHEAR_BY_SUBTYPE=', 'function mohrCoulombNuDefault(', 'function mohrCoulombRShearDefault(',
    'function sb260GranularAlpha(', 'function sb260TransitionAlpha(', 'function sb260AlphaFamily(', 'function alphaEB(']) {
    assert.ok(!src.includes(decl), `still declares ${decl}`);
  }
  assert.ok(!/S\.khKvMethod === 'B'/.test(src), 'khParams body still in the controller');
  assert.ok(!/const cotphi = l\.phi>0/.test(src), 'hsParams body still in the controller');
  assert.ok(!/const wt = S\.wt;/.test(src), 'stressAt body still in the controller');
  assert.ok(!/const prevS = S;\s*\n\s*S = cpt;/.test(src), 'stratigraphy S-swap still present');
  assert.ok(src.includes("} from './model-params/index.js';"), 'model-params import missing');
  // PR 20 (composition root): the four wrappers moved into installModelParamsApp(ctx), which
  // builds the ctx from the live active CPT. The controller keeps the monolith names as bindings
  // of that install, so the inline `on*=` attributes and the Node verifiers still resolve them.
  for (const name of ['stressAt', 'hsParams', 'khParams', 'modelCtx', 'renderModel', 'setAlphaMethod',
    'setStiffMethod', 'setKhKvMethod']) {
    assert.ok(!new RegExp(`^function ${name}\\(`, 'm').test(src), `${name} is still declared in legacy-controller.js`);
  }
  const bindings = src.slice(src.indexOf('} = modelParamsApp;') - 300, src.indexOf('} = modelParamsApp;'));
  for (const name of ['modelCtx', 'stressAt', 'hsParams', 'khParams', 'renderModel', 'setAlphaMethod', 'setStiffMethod', 'setKhKvMethod']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(bindings), `${name} is not bound from modelParamsApp`);
  }
  assert.ok(src.includes('workingLayers: stage6WorkingLayers'), 'stage6WorkingLayers binding');
  const mp = readFileSync(join(ROOT, 'src/lib/cpt-app/model-params/index.js'), 'utf8');
  for (const w of ['modelCtx: () => cptModelCtx(getActive()),',
    'stressAt: (z, gammaSat, gammaUnsat) => stressAtOf(getActive(), z, gammaSat, gammaUnsat),',
    'hsParams: (l) => hsParamsOf(l, app.modelCtx()),', 'khParams: (l) => khParamsOf(l, app.modelCtx()),',
    'workingLayers: () => workingLayersOf(getActive()),']) {
    assert.ok(mp.includes(w), `model-params/index.js wrapper missing: ${w}`);
  }
});
check('model-params modules carry the SPDX header and @ts-nocheck', () => {
  const dir = join(ROOT, 'src/lib/cpt-app/model-params');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['context.js', 'hs-params.js', 'index.js', 'kh-params.js', 'panel.js', 'soil-defaults.js', 'stress.js', 'working-layers.js']);
  for (const f of files) {
    const head = readFileSync(join(dir, f), 'utf8').split('\n').slice(0, 2);
    assert.equal(head[0], '// SPDX-License-Identifier: AGPL-3.0-or-later', f);
    assert.equal(head[1], '// @ts-nocheck', f);
  }
  assert.ok(existsSync(join(dir, 'index.js')));
});

console.log(`\n${count - fails}/${count} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
