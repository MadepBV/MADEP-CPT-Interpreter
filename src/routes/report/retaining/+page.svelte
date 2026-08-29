<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<svelte:options runes={false} />

<script lang="ts">
  import '$lib/cpt-app/legacy.css';
  import { onMount } from 'svelte';
  import { loadNotePayload } from '$lib/cpt-app/retaining/report/note-view.js';

  let payload: any = null;
  let loadError = '';

  const fmt = (v: unknown, d = 2) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? '—' : n.toFixed(d); };
  const fmtSci = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n)) return '—'; return Math.abs(n) >= 1e5 ? n.toExponential(3) : fmt(n, Math.abs(n) >= 100 ? 1 : 4); };
  const fmtDateTime = (v: string) => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.valueOf()) ? v : d.toLocaleString('nl-BE', { dateStyle: 'medium', timeStyle: 'short' }); };
  const uc = (u: unknown) => { const n = Number(u); return Number.isFinite(n) ? n.toFixed(3) : '—'; };
  const verdict = (pass: boolean) => (pass ? 'voldoet' : 'voldoet niet');

  $: rw = payload?.state || null;
  $: res = payload?.result || null;
  $: st = payload?.structural || null;
  $: embedded = !!payload?.wall?.embedded;
  $: soldier = payload?.wall?.type === 'soldierpile';
  $: perPile = !!res?.perPile;
  $: uM = perPile ? 'kNm/profiel' : 'kNm/m';
  $: uF = perPile ? 'kN/profiel' : 'kN/m';
  $: branches = res?.branches || [];
  $: da12 = branches.find((b: any) => b.id === 'DA1-2') || null;
  $: overdig = Number(res?.overdigUls) || 0;
  $: H = Number(rw?.embedded?.retainedHeight) || 0;
  $: d = Number(rw?.embedded?.embedment) || 0;
  $: strata = payload?.profile?.strata || [];
  $: checks = res?.checks || [];
  $: steelRows = st?.steel?.rows?.filter((r: any) => !r.info) || [];
  $: drv = payload?.drivability || null;
  $: vib = payload?.vibration || null;
  $: schemeLabel = ({ 0: 'NBN EN 1997-1 ANB — generieke DA1-sets', 1: 'Richtlijnen Beschoeiingen (2022) — RK1', 2: 'Richtlijnen Beschoeiingen (2022) — RK2', 3: 'Richtlijnen Beschoeiingen (2022) — RK3' } as Record<number, string>)[Number(rw?.settings?.riskScheme) || 0];
  $: overdigLabel = ({ belgian: 'Richtlijnen Beschoeiingen (2022) §3.3: +0,30 m in den droge; min(0,1·h; 0,5 m) onder water', en: 'NBN EN 1997-1 §9.3.2.2: 10 % van h, ≤ 0,5 m', custom: 'projectwaarde', none: 'geen (verantwoorde controlemaatregelen)' } as Record<string, string>)[rw?.settings?.overdigRule || 'belgian'];
  $: tlatSet = st?.plaxis?.tlat?.find((t: any) => t.id === 'characteristic') || st?.plaxis?.tlat?.[0] || null;
  $: tlatDesign = st?.plaxis?.tlat?.find((t: any) => t.id === 'design') || null;
  $: allChecks = [
    ...checks.map((c: any) => ({ label: c.label, kader: c.comboLabel || c.combo, Ed: `${fmt(c.Ed, 2)} ${c.unit}`, Rd: `${fmt(c.Rd, 2)} ${c.unit}`, util: c.util, pass: c.pass })),
    ...steelRows.map((r: any) => ({ label: `${r.label} — ${st?.section?.id || ''}`, kader: `STR · ${r.ref || ''}`, Ed: `${fmt(r.Ed, 2)} ${r.unit}`, Rd: `${fmt(r.Rd, 2)} ${r.unit}`, util: r.util, pass: r.pass })),
    ...(st?.lagging ? [{ label: `Beschot ${fmt((rw?.soldier?.laggingThk || 0) * 1000, 0)} mm`, kader: `STR · ${st.lagging.combo || ''}`, Ed: `${fmt(st.lagging.MEd, 3)} kNm/m`, Rd: `${fmt(st.lagging.MRd, 3)} kNm/m`, util: st.lagging.util, pass: st.lagging.pass }] : []),
    ...(st?.vertical ? [{ label: 'Verticaal evenwicht profiel', kader: 'GEO · screening', Ed: `${fmt(st.vertical.G, 2)} kN`, Rd: `${fmt(st.vertical.Rs, 2)} kN`, util: st.vertical.util, pass: st.vertical.pass }] : [])
  ];
  $: overall = allChecks.length > 0 && allChecks.every((c: any) => c.pass);

  onMount(() => {
    const key = new URLSearchParams(window.location.search).get('key') || '';
    payload = loadNotePayload(window.localStorage, key);
    if (!payload) loadError = key ? 'Geen rekennota-data gevonden voor deze sleutel in deze browser. Genereer de nota opnieuw vanuit de toepassing Keerconstructies (Stage 6).' : 'Geen sleutel meegegeven. Genereer de nota vanuit Stage 6 → Retaining walls → Calculation note.';
  });
</script>

<svelte:head>
  <title>Rekennota keerconstructie — MADEP</title>
</svelte:head>

{#if loadError}
  <div class="report-shell"><div class="report-error"><h1>Rekennota niet beschikbaar</h1><p>{loadError}</p><div class="report-error__actions"><a class="btn pri" href="/">Naar de CPT-app</a></div></div></div>
{:else if !payload || !rw || !res}
  <div class="report-shell"><div class="report-error"><h1>Rekennota laden…</h1></div></div>
{:else}
  <svelte:boundary>
  {#snippet failed(err, reset)}
    {@const e = err as any}
    <div class="report-shell"><div class="report-error"><h1>Rekennota kon niet worden opgebouwd</h1>
      <p>{String(e?.message || e)}</p>
      <pre class="rn-errstack">{String(e?.stack || '').split('\n').slice(0, 6).join('\n')}</pre>
      <p class="rn-note">Genereer de nota opnieuw vanuit de toepassing na een nieuwe berekening. Neem deze melding over bij een bugrapport (sleutel {new URLSearchParams(window.location.search).get('key') || '—'}).</p>
      <div class="report-error__actions"><button class="btn" type="button" onclick={reset}>Opnieuw proberen</button><a class="btn pri" href="/">Naar de CPT-app</a></div>
    </div></div>
  {/snippet}
  <div class="report-shell">
    <div class="report-toolbar no-print">
      <a class="btn sm" href="/">CPT app</a>
      <button class="btn pri" type="button" onclick={() => window.print()}>Print / Save as PDF</button>
    </div>
    <table class="report-sheet">
      <thead class="report-running-head"><tr><td><div class="report-running-head__inner"><span>{payload.project.name}</span><span>Rekennota keerconstructie · {payload.wall.label}</span></div></td></tr></thead>
      <tfoot class="report-running-foot"><tr><td><div class="report-running-foot__inner"><span>MADEP BV · Nederholbeekstraat 68, 9680 Maarkedal · BTW BE0779808833</span><span>{fmtDateTime(payload.generatedAt)}</span></div></td></tr></tfoot>
      <tbody><tr><td>
        <article class="report">
          <section class="report-cover">
            <header class="report-masthead">
              <div class="report-masthead__brand"><img class="report-masthead__logo" src="/MADEP_logo.svg" alt="MADEP" /><div class="report-masthead__tagline">Geotechnical engineering</div></div>
              <dl class="report-masthead__meta">
                <div><dt>Project</dt><dd>{payload.project.name}</dd></div>
                <div><dt>Sondering</dt><dd>{payload.project.cptId || '—'}</dd></div>
                <div><dt>Datum</dt><dd>{fmtDateTime(payload.generatedAt)}</dd></div>
                <div><dt>Versie app</dt><dd>{payload.project.appVersion || '—'}</dd></div>
              </dl>
            </header>
            <div class="report-masthead__rule"></div>
            <p class="report-cover__kicker">Geotechnische rekennota · NBN EN 1997-1 + ANB:2022 · Richtlijnen Beschoeiingen (2022)</p>
            <h1 class="report-cover__title">Verificatie {payload.wall.label.toLowerCase()}</h1>
            <p class="report-cover__lede">Automatisch gegenereerde rekennota uit de MADEP CPT Interpreter op basis van het geïnterpreteerde sondeerprofiel. Alle tussenwaarden zijn opgenomen zodat de berekening met de hand kan worden nagerekend. De met «te bevestigen» aangeduide uitgangspunten dienen tegen het uitvoeringsplan te worden getoetst.</p>
            <div class="rn-verdict {overall ? 'ok' : 'bad'}"><strong>{overall ? 'ALLE TOETSINGEN VOLDOEN' : 'NIET ALLE TOETSINGEN VOLDOEN'}</strong><span>maatgevende benuttingsgraad {uc(Math.max(...allChecks.map((c: any) => Number(c.util) || 0)))}</span></div>
          </section>

          <section class="report-section">
            <div class="report-section__head"><h2>1. Referenties</h2><p>Normen, richtlijnen en rekenmethoden die in deze nota worden toegepast.</p></div>
            <ul class="rn-list">
              <li>NBN EN 1997-1:2005 + A1:2014 en NBN EN 1997-1 ANB:2022 — Eurocode 7, geotechnisch ontwerp.</li>
              <li>BGGG/Buildwise (2022). Richtlijnen voor de toepassing van EC7 in België volgens NBN EN 1997-1 ANB — Het grondmechanische ontwerp van ingebedde kerende constructies: beschoeiingen (maart 2022).</li>
              <li>NBN EN 1993-1-1:2005 + ANB:2018; NBN EN 1993-5:2007 + ANB:2011 — staalconstructies, palen en damwanden.</li>
              <li>NBN EN 10365:2017 (H-profielen); ArcelorMittal Sheet Piling, General Catalogue 2024 (damwandprofielen).</li>
              <li>Blum, H. (1931). Einspannungsverhältnisse bei Bohlwerken. — Brinch Hansen, J. (1961). The ultimate resistance of rigid piles against transversal forces, DGI Bulletin 12. — Andersen, F. &amp; Lodahl, M.R. (2023). Modelling of soldier pile walls in Plaxis 2D, NUMGE 2023 (doi 10.53243/NUMGE2023-25).</li>
              <li>Bentley Systems (2024). PLAXIS 2D Reference Manual V24.</li>
              {#if drv}<li>Van Rompaey, Legrand &amp; Holeyman (1995); Holeyman (2002); Holeyman &amp; Whenham (2017) — trilvoorspelling (Hypervib1). Smith, E.A.L. (1960) — golfvergelijking; FHWA GEC-12 (2016) — parameters.</li>{/if}
              {#if vib}<li>Hiller &amp; Crabb (2000), TRL Report 429; BS 5228-2:2009+A1:2014; SBR Trillingsrichtlijn A (2017); DIN 4150-3:2016; BS 7385-2:1993.</li>{/if}
            </ul>
          </section>

          <section class="report-section">
            <div class="report-section__head"><h2>2. Uitgangspunten</h2><p>Geometrie, grondwater, grondlagen en materialen.</p></div>
            <h3>2.1 Geometrie</h3>
            <table class="rn-table">
              <thead><tr><th>Grootheid</th><th>Symbool</th><th class="num">Waarde</th><th>Opmerking</th></tr></thead>
              <tbody>
                {#if embedded}
                  <tr><td>Nominale kerende hoogte</td><td>H_nom</td><td class="num">{fmt(H, 3)} m</td><td>te bevestigen</td></tr>
                  <tr><td>Overdiepte (UGT)</td><td>Δa</td><td class="num">{fmt(overdig, 2)} m</td><td>{overdigLabel}</td></tr>
                  <tr><td>Rekenkundige kerende hoogte (UGT)</td><td>H_d</td><td class="num">{fmt(H + overdig, 3)} m</td><td>= H_nom + Δa</td></tr>
                  <tr><td>Inbedding onder rekenkundig uitgraafniveau</td><td>D_d</td><td class="num">{fmt(d, 3)} m</td><td>voorzien</td></tr>
                  <tr><td>Vereiste inbedding</td><td>D_req</td><td class="num">{fmt(res?.structural?.requiredD, 3)} m</td><td>{res?.structural?.requiredDCombo}{!(rw?.wallType === 'anchored' || rw?.embedded?.anchored) ? ' · incl. 20 % Blum' : ''}</td></tr>
                  <tr><td>Profiellengte</td><td>L</td><td class="num">{fmt(H + overdig + d + (Number(rw?.soldier?.pileHeadAbove) || 0), 3)} m</td><td>= H_d + D_d{soldier && rw?.soldier?.pileHeadAbove ? ' + kop boven maaiveld' : ''}</td></tr>
                  {#if soldier}
                    <tr><td>Profiel</td><td>—</td><td class="num">{rw.soldier.sectionId} – {rw.soldier.grade}</td><td>NBN EN 10365</td></tr>
                    <tr><td>Tussenafstand (h.o.h.)</td><td>s</td><td class="num">{fmt(rw.soldier.spacing, 2)} m</td><td></td></tr>
                    <tr><td>Beschot</td><td>t</td><td class="num">staalplaat {fmt(rw.soldier.laggingThk * 1000, 0)} mm – {rw.soldier.laggingGrade}</td><td>overspanning {rw.soldier.laggingSpan === 'clear' ? 'vrij (s − b)' : 'h.o.h. (conservatief)'}</td></tr>
                    <tr><td>Weerstandsmodel onder uitgraafniveau (handberekening)</td><td>—</td><td class="num">{rw.soldier.resistanceModel === 'brinch-hansen' ? 'Brinch Hansen (netto lijnweerstand)' : `werkzame breedte b_eff = min(${fmt(rw.soldier.effectiveWidthFactor, 1)}·b; s)`}</td><td>Richtlijnen 2022 §5</td></tr>
                  {:else}
                    <tr><td>Damwandprofiel</td><td>—</td><td class="num">{rw.sheet.sectionId} – {rw.sheet.grade}</td><td>ArcelorMittal 2024{rw.sheet.corrosionLoss ? `, corrosie −${fmt(rw.sheet.corrosionLoss * 100, 0)} %` : ''}</td></tr>
                  {/if}
                  {#if rw?.wallType === 'anchored' || rw?.embedded?.anchored}
                    <tr><td>Anker: diepte / helling / h.o.h.</td><td>—</td><td class="num">{fmt(rw.embedded.anchorDepth, 2)} m / {fmt(rw.embedded.anchorAngle, 0)}° / {fmt(rw.embedded.anchorSpacing, 2)} m</td><td>groutlichaam Ø {fmt(rw.embedded.anchorDia, 2)} m × {fmt(rw.embedded.fixedLen, 1)} m, τ = {fmt(rw.embedded.anchorTfk, 0)} kPa</td></tr>
                  {/if}
                  {#if rw?.loads?.berm?.enabled}
                    <tr><td>Talud achter de wand</td><td>Δh / β</td><td class="num">{fmt(rw.loads.berm.height, 3)} m / {fmt(rw.loads.berm.slopeDeg, 0)}°</td><td>als equivalente bovenbelasting, gespreid onder 45° (benadering)</td></tr>
                  {/if}
                  <tr><td>Veranderlijke bovenbelasting</td><td>q_k</td><td class="num">{fmt(Math.max(Number(rw?.surcharge) || 0, Number(rw?.settings?.surchargeFloor) || 0), 1)} kPa</td><td>{Number(rw?.settings?.surchargeFloor) > Number(rw?.surcharge) ? `praktijkondergrens ${fmt(rw.settings.surchargeFloor, 0)} kPa toegepast` : ''}</td></tr>
                  {#if Number(rw?.loads?.surchargePermanent) > 0}<tr><td>Permanente bovenbelasting</td><td>g_k</td><td class="num">{fmt(rw.loads.surchargePermanent, 1)} kPa</td><td></td></tr>{/if}
                {:else}
                  <tr><td>Stamhoogte / dikte top / dikte voet</td><td>—</td><td class="num">{fmt((rw?.wallType === 'gravity' ? rw?.gravity : rw?.cantilever).stemHeight, 2)} / {fmt((rw?.wallType === 'gravity' ? rw?.gravity : rw?.cantilever).stemThkTop, 2)} / {fmt((rw?.wallType === 'gravity' ? rw?.gravity : rw?.cantilever).stemThkBot, 2)} m</td><td></td></tr>
                  <tr><td>Voetplaat: teen / hiel / dikte</td><td>—</td><td class="num">{fmt((rw?.wallType === 'gravity' ? rw?.gravity : rw?.cantilever).toe, 2)} / {fmt((rw?.wallType === 'gravity' ? rw?.gravity : rw?.cantilever).heel, 2)} / {fmt((rw?.wallType === 'gravity' ? rw?.gravity : rw?.cantilever).baseThk, 2)} m</td><td>B = {fmt(res?.B, 2)} m</td></tr>
                  <tr><td>Bovenbelasting</td><td>q_k</td><td class="num">{fmt(rw?.surcharge, 1)} kPa</td><td></td></tr>
                {/if}
              </tbody>
            </table>
            <h3>2.2 Grondwater</h3>
            <p>{rw?.water?.mode === 'none' ? 'Geen waterdruk in rekening gebracht: de grondwaterstand blijft onder het teenpeil gedurende de volledige openstaande periode. Dit uitgangspunt is bindend (uitvoeringsvoorwaarde).' : rw?.water?.mode === 'retained' ? `Grondwaterstand op ${fmt(rw.water.retainedDepth, 2)} m onder het kerend maaiveld; bouwput droog (bemaling / kwelscherm). Waterdrukken hydrostatisch per zijde, zonder stroming (NBN EN 1997-1 §9.3.1.6).` : `Grondwaterstand op ${fmt(rw.water.retainedDepth, 2)} m onder het kerend maaiveld en ${fmt(rw.water.frontDepth, 2)} m onder het uitgraafniveau. Waterdrukken hydrostatisch per zijde.`}{soldier && rw?.water?.mode !== 'none' && !rw?.soldier?.laggingWatertight ? ' Het beschot wordt waterdoorlatend uitgevoerd: geen waterdruk op de wand (bindende uitvoeringsvoorwaarde).' : ''}</p>
            <h3>2.3 Grondlagen en karakteristieke parameters</h3>
            {#if payload.profile?.notes?.length}<p class="rn-note">{payload.profile.notes.join(' ')}</p>{/if}
            <table class="rn-table">
              <thead><tr><th>Laag</th><th class="num">Top [m]</th><th class="num">γ [kN/m³]</th><th class="num">γ_sat</th><th class="num">φ′_k [°]</th><th class="num">c′_k [kPa]</th><th class="num">c_u,k [kPa]</th><th>Kader</th><th class="num">q_c [MPa]</th><th>Overrides</th></tr></thead>
              <tbody>
                {#each strata as s}
                  <tr><td>{s.label || 'laag'}</td><td class="num">{fmt(s.topEl, 2)}</td><td class="num">{fmt(s.gammaMoist, 1)}</td><td class="num">{fmt(s.gammaSat, 1)}</td><td class="num">{fmt(s.phi, 1)}</td><td class="num">{fmt(s.c, 1)}</td><td class="num">{fmt(s.cu, 0)}</td><td>{s.drained === false ? 'ongedraineerd' : 'gedraineerd'}</td><td class="num">{fmt((s.qc || 0) / 1000, 1)}</td><td>{(s.overridden || []).length ? `aangepast: ${s.overridden.join(', ')}` : ''}</td></tr>
                {/each}
              </tbody>
            </table>
            <p class="rn-note">Karakteristieke waarden afgeleid uit de sondering (Stage 4 van de MADEP CPT Interpreter). Aangepaste waarden ("overrides") zijn bewuste ontwerpkeuzes van de ontwerper — met name een lage c′ is conservatief (hogere actieve druk, lagere passieve weerstand). Peilen in het wandassenstelsel: kerend maaiveld = +{fmt(H, 3)} m, nominaal uitgraafniveau = 0.</p>
            {#if embedded}
              <h3>2.4 Wandwrijving en gronddrukcoëfficiënten</h3>
              <p>Actieve zijde: Rankine op de verticale wand (δ = 0). Passieve zijde: NBN EN 1997-1 Bijlage C (gekromd glijvlak) met δ_p/φ′ = {fmt(soldier ? rw.settings.deltaPassiveSoldier : rw.settings.deltaPassiveSheet, 2)}, toegepast op φ′_d per laag. Belgische bovengrens: {soldier ? 'berlijnse wand φ′_k/3 (recht) en φ′_k/2 (gekromd)' : 'stalen damwand 2φ′_k/3 (recht), φ′_k − 2,5° en ≤ 30° (gekromd)'} (Richtlijnen 2022, Tabel 4). Trekscheur {rw.settings.assumeCrackWater ? 'watergevuld verondersteld (NBN EN 1997-1 §9.6(5)P)' : 'niet met water gevuld'}.</p>
            {/if}
          </section>

          <section class="report-section">
            <div class="report-section__head"><h2>3. Veiligheidsniveau en partiële factoren</h2><p>{schemeLabel}.</p></div>
            {#if embedded}
              <table class="rn-table">
                <thead><tr><th>Tak</th><th class="num">γ_G</th><th class="num">γ_G,pass.</th><th class="num">γ_Q</th><th class="num">γ_φ</th><th class="num">γ_c</th><th class="num">γ_cu</th><th class="num">× effecten</th><th class="num">Uitgraafniveau</th><th>Doel</th></tr></thead>
                <tbody>
                  {#each branches as b}
                    <tr><td>{b.id}</td><td class="num">{fmt(b.factors.gG, 2)}</td><td class="num">{fmt(b.factors.gGResist, 2)}</td><td class="num">{fmt(b.factors.gQ, 2)}</td><td class="num">{fmt(b.factors.gPhi, 2)}</td><td class="num">{fmt(b.factors.gC, 2)}</td><td class="num">{fmt(b.factors.gCu, 2)}</td><td class="num">{fmt(b.factors.effectFactor, 2)}</td><td class="num">{fmt(-b.excavationEl, 2)} m onder nominaal</td><td>{b.id === 'DA1-2' ? 'inbedding (GEO)' : b.id === 'SLS' ? 'referentie BGT' : 'snedekrachten (STR)'}</td></tr>
                  {/each}
                </tbody>
              </table>
              <p class="rn-note">De inbedding wordt getoetst in DA1/2 met het rekenkundig uitgraafniveau (Richtlijnen 2022 §3.3–3.5). De snedekrachten zijn de omhullende van DA1/2, DA1/1 ({rw.settings.da11Mode === 'single-source' ? 'γ_G = 1,35 aan beide zijden, enkelvoudige bron' : 'γ_G = 1,35 op de kerende zijde, 1,00 op de gunstige passieve weerstand'}) en 1,35 × (BGT + α_ver = {fmt(rw.settings.alphaVer, 2)}). {Number(rw.settings.riskScheme) === 0 ? `K_FI volgens gevolgklasse CC${rw.settings.consequenceClass}.` : 'K_FI wordt niet bovenop de risicoklasse toegepast.'}{rw.settings.materialOverride?.enabled ? ` Gevoeligheidsset γ_φ = γ_c = ${fmt(rw.settings.materialOverride.gPhi, 2)}${rw.settings.materialOverride.applyToDA12 ? ' toegepast als materiaalset van DA1/2 (bv. SB260)' : ' enkel in de PLAXIS T_lat-tabellen'}.` : ''}</p>
            {:else}
              <p>DA1: combinatie 1 (A1 + M1 + R1: γ_G 1,35, γ_Q 1,50) en combinatie 2 (A2 + M2 + R1: γ_Q 1,30, γ_φ = γ_c = 1,25, γ_cu = 1,40); EQU 1,10/0,90; K_FI volgens CC{rw.settings.consequenceClass}. De ongunstigste combinatie is per toetsing maatgevend.</p>
            {/if}
          </section>

          {#if embedded && st?.plaxis}
            <section class="report-section">
              <div class="report-section__head"><h2>4. Modellering in PLAXIS 2D</h2><p>{soldier ? 'Plaatelement boven het rekenkundig uitgraafniveau, embedded beam row eronder (Andersen & Lodahl 2023).' : 'Plaatelement over de volledige wandlengte met interfaces aan beide zijden.'}</p></div>
              <div class="rn-grid2">
                <div>
                  <h3>{soldier ? '4.1 Plaatelement boven het uitgraafniveau' : '4.1 Plaatelement'}</h3>
                  <table class="rn-table"><thead><tr><th>Parameter</th><th class="num">Waarde</th><th>Eenheid / opmerking</th></tr></thead><tbody>
                    {#each st.plaxis.plate.rows as r}<tr><td>{r[0]}</td><td class="num">{typeof r[1] === 'number' ? fmtSci(r[1]) : r[1]}</td><td>{r[2]}</td></tr>{/each}
                  </tbody></table>
                  <p class="rn-note">{st.plaxis.plate.notes.join(' ')}</p>
                </div>
                {#if soldier}
                  <div>
                    <h3>4.2 Embedded beam row onder het uitgraafniveau</h3>
                    <table class="rn-table"><thead><tr><th>Parameter</th><th class="num">Waarde</th><th>Eenheid / opmerking</th></tr></thead><tbody>
                      {#each st.plaxis.ebr.rows as r}<tr><td>{r[0]}</td><td class="num">{typeof r[1] === 'number' ? fmtSci(r[1]) : r[1]}</td><td>{r[2]}</td></tr>{/each}
                    </tbody></table>
                    <p class="rn-note">{st.plaxis.ebr.notes.join(' ')}</p>
                  </div>
                {/if}
              </div>
              {#if soldier}
                <div class="rn-grid2">
                  <div><h3>4.3 Axiale schachtweerstand T_skin (Linear)</h3>
                    <table class="rn-table"><thead><tr><th>Parameter</th><th class="num">Waarde</th><th>Opmerking</th></tr></thead><tbody>{#each st.plaxis.tskin.rows as r}<tr><td>{r[0]}</td><td class="num">{typeof r[1] === 'number' ? fmt(r[1], 4) : r[1]}</td><td>{r[2]}</td></tr>{/each}</tbody></table>
                    <p class="rn-note">{st.plaxis.tskin.notes.join(' ')}</p></div>
                  <div><h3>4.4 Voetweerstand F_max</h3>
                    {#if st.plaxis.fmax}<table class="rn-table"><thead><tr><th>Parameter</th><th class="num">Waarde</th><th>Opmerking</th></tr></thead><tbody>{#each st.plaxis.fmax.rows as r}<tr><td>{r[0]}</td><td class="num">{typeof r[1] === 'number' ? fmt(r[1], 3) : r[1]}</td><td>{r[2]}</td></tr>{/each}</tbody></table><p class="rn-note">{st.plaxis.fmax.notes.join(' ')}</p>{:else}<p class="rn-note">Geen conusweerstand ter hoogte van de teen beschikbaar.</p>{/if}</div>
                </div>
                {#if tlatSet}
                  <h3>4.5 Laterale weerstand T_lat volgens Brinch Hansen (Multi-linear, per profiel, B = b = {fmt(tlatSet.B * 1000, 0)} mm)</h3>
                  <table class="rn-table">
                    <thead><tr><th class="num">Afstand [m]</th><th class="num">σ′_v,f [kPa]</th><th class="num">Δq [kPa]</th><th class="num">K_q</th><th class="num">K_c</th><th class="num">gelijk niveau [kN/m]</th><th class="num">Andersen–Lodahl [kN/m]</th><th class="num">s·p_net [kN/m]</th><th class="num">T_lat karakt. [kN/m]</th>{#if tlatDesign}<th class="num">T_lat ontwerp γ_φ {fmt(tlatDesign.gPhi, 2)} [kN/m]</th>{/if}</tr></thead>
                    <tbody>
                      {#each tlatSet.plaxisRows as r, i}
                        <tr><td class="num">{fmt(r.distance, 3)}</td><td class="num">{fmt(r.sigmaVf, 2)}</td><td class="num">{fmt(r.dq, 2)}</td><td class="num">{fmt(r.Kq, 3)}</td><td class="num">{fmt(r.Kc, 3)}</td><td class="num">{fmt(tlatSet.rows[i]?.tlatEqual, 2)}</td><td class="num">{fmt(tlatSet.rows[i]?.tlatAL, 2)}</td><td class="num">{fmt(r.rowCap, 2)}</td><td class="num"><strong>{fmt(r.tlat, 2)}</strong></td>{#if tlatDesign}<td class="num">{fmt(tlatDesign.plaxisRows[i]?.tlat, 2)}</td>{/if}</tr>
                      {/each}
                    </tbody>
                  </table>
                  <p class="rn-note">Conventie ingevoerd in PLAXIS: {rw.soldier.tlatConvention === 'equal' ? 'gelijk niveau (Rekennota-conventie, zonder de bijkomende actieve term van de hogere kerende zijde)' : 'Andersen–Lodahl (met de bijkomende actieve term −Δq·K_q^A van de hogere kerende zijde)'}{rw.soldier.rowCap !== false ? ', begrensd door de weerstand van de doorgaande wand over de tussenafstand s·p_net' : ''}. Coëfficiënten per laag: K_q(z/B) en K_c(z/B) volgens Brinch Hansen (1961); ontwerpset herberekend met φ′_d (T_lat,d ≠ T_lat,k/γ_φ). Waarden per profiel — niet delen door de tussenafstand.</p>
                  {#each tlatSet.layers as L}
                    <p class="rn-note">Laag top {fmt(L.topEl, 2)} m, φ = {fmt(L.phi, 3)}°: K_q^A = {fmt(L.KqA, 4)}, K_q⁰ = {fmt(L.Kq0, 4)}, K_c⁰ = {fmt(L.Kc0, 4)}, K₀ = {fmt(L.K0, 4)}, d_c^∞ = {fmt(L.dcInf, 4)}, N_c = {fmt(L.Nc, 4)}, K_q^∞ = {fmt(L.KqInf, 4)}, K_c^∞ = {fmt(L.KcInf, 4)}, a_q = {fmt(L.aq, 5)}, a_c = {fmt(L.ac, 5)}.</p>
                  {/each}
                {/if}
              {/if}
              {#if st.plaxis.interfaces?.length}
                <h3>{soldier ? '4.6' : '4.2'} Interfaces</h3>
                <table class="rn-table"><thead><tr><th>Laag</th><th class="num">φ′_k [°]</th><th class="num">δ [°]</th><th class="num">R_inter</th></tr></thead><tbody>{#each st.plaxis.interfaces as r}<tr><td>{r.label || '—'}</td><td class="num">{fmt(r.phi, 1)}</td><td class="num">{fmt(r.delta, 1)}</td><td class="num">{fmt(r.Rinter, 3)}</td></tr>{/each}</tbody></table>
              {/if}
              <p class="rn-note">Rekenschema (Richtlijnen 2022 §3.5): alle fasen met BGT-factoren en α_ver = 1,1 op veranderlijke belastingen; snedekrachten × 1,35 voor UGT; phi-c reductie op de maatgevende fase met SF ≥ 1,25 (RK2). Resultaten van het PLAXIS-model: «PLAXIS — in te vullen».</p>
            </section>
          {/if}

          {#if embedded}
            <section class="report-section">
              <div class="report-section__head"><h2>{st?.plaxis ? '5' : '4'}. Handberekening: grensevenwicht per ontwerptak</h2><p>{(rw?.wallType === 'anchored' || rw?.embedded?.anchored) ? 'Vrije-oplegging (free-earth support): momentenevenwicht om het steunpunt, steunpuntsreactie uit horizontaal evenwicht.' : 'Blum: momentenevenwicht om het theoretisch draaipunt t₀; D_req = 1,2·t₀ (de toeslag van 20 % maakt deel uit van de methode).'}</p></div>
              {#each branches as b}
                <h3>{b.id} — {b.label}</h3>
                <table class="rn-table"><thead><tr><th>Laag (top)</th><th>Kader</th><th class="num">φ′_k → φ′_d</th><th class="num">c′_k → c′_d</th><th class="num">c_u,k → c_u,d</th><th class="num">K_a</th><th class="num">K_ac</th><th class="num">δ_p</th><th class="num">K_p</th><th class="num">K_pc</th></tr></thead><tbody>
                  {#each b.back as L}<tr><td>{fmt(L.topEl, 2)} m</td><td>{L.drained ? 'gedr.' : 'ongedr.'}</td><td class="num">{fmt(L.phiK, 1)} → {fmt(L.phiD, 3)}°</td><td class="num">{fmt(L.cK, 1)} → {fmt(L.cD, 2)}</td><td class="num">{fmt(L.cuK, 0)} → {fmt(L.cuD, 1)}</td><td class="num">{fmt(L.Ka, 4)}</td><td class="num">{fmt(L.Kac, 4)}</td><td class="num">{fmt(L.deltaP, 1)}°</td><td class="num">{fmt(L.Kp, 4)}</td><td class="num">{fmt(L.Kpc, 4)}</td></tr>{/each}
                </tbody></table>
                <table class="rn-table rn-kv"><tbody>
                  <tr><td>Uitgraafniveau van deze tak</td><td class="num">{fmt(-b.excavationEl, 2)} m onder nominaal</td><td>Rekendruk maaiveld / uitgraafniveau / netto teen</td><td class="num">{fmt(b.pSurface, 2)} / {fmt(b.pExcavation, 2)} / {fmt(b.pToeBack - b.pToeFront, 2)} kPa</td></tr>
                  <tr><td>Vrije-inbeddingsdiepte t₀ (d₀)</td><td class="num">{fmt(b.d0, 3)} m</td><td>Ontwerpinbedding{!(rw?.wallType === 'anchored' || rw?.embedded?.anchored) ? ' 1,2·t₀' : ''}</td><td class="num">{fmt(b.dDesign, 3)} m</td></tr>
                  <tr><td>ODF bij voorziene inbedding {fmt(b.dProvided, 3)} m</td><td class="num">{fmt(b.odfProvided, 3)}</td><td>Nulpunt netto druk onder uitgraafniveau</td><td class="num">{b.zNetZero >= 0 ? fmt(b.zNetZero, 2) + ' m' : '—'}</td></tr>
                  {#if b.T > 0}<tr><td>Steunpuntsreactie T</td><td class="num">{fmt(b.T, 2)} {uF}</td><td>T_Ed (× {fmt(b.factors.effectFactor, 2)})</td><td class="num">{fmt(b.TEd, 2)} {uF}</td></tr>{/if}
                  <tr><td>M_max op {fmt(b.yMmax, 2)} m onder maaiveld</td><td class="num">{fmt(b.Mmax, 2)} {uM}</td><td>M_Ed (× {fmt(b.factors.effectFactor, 2)})</td><td class="num">{fmt(b.MEd, 2)} {uM}</td></tr>
                  <tr><td>V_max op {fmt(b.yVmax, 2)} m onder maaiveld</td><td class="num">{fmt(b.Vmax, 2)} {uF}</td><td>V_Ed (× {fmt(b.factors.effectFactor, 2)})</td><td class="num">{fmt(b.VEd, 2)} {uF}</td></tr>
                  {#if b.lagging}<tr><td>Rekendruk op het beschot ter hoogte van het uitgraafniveau</td><td class="num">{fmt(b.lagging.total, 2)} kPa</td><td>waarvan grond / bovenbelasting / water</td><td class="num">{fmt(b.lagging.pEarth, 2)} / {fmt(b.lagging.pSurch, 2)} / {fmt(b.lagging.u, 2)} kPa</td></tr>{/if}
                </tbody></table>
                {#if !b.bracketed}<p class="rn-note rn-warn">Geen evenwicht binnen 40 m inbedding.</p>{/if}
              {/each}
              <p class="rn-note">{perPile ? 'Alle krachten per profiel: boven het uitgraafniveau werkt de gronddruk via het beschot over de tussenafstand s; eronder ' + (rw.soldier.resistanceModel === 'brinch-hansen' ? 'de netto lijnweerstand van Brinch Hansen B·[e_w]⁺ (Andersen–Lodahl).' : 'actief over de flensbreedte b en passief over b_eff = min(k·b; s) met de vlakke-rek K_p.') : 'Alle krachten per lopende meter wand.'} Netto drukken per tak gefactoriseerd: aandrijvend γ_G·(p_a + u) + γ_Q·p_q, weerstand γ_G,pass·(p_p + u).</p>
            </section>
          {/if}

          <section class="report-section">
            <div class="report-section__head"><h2>{embedded ? (st?.plaxis ? '6' : '5') : '4'}. Toetsingen</h2><p>Grenstoestanden GEO, STR{!embedded ? ', EQU' : ''} en de bijkomende controles.</p></div>
            <table class="rn-table"><thead><tr><th>Toetsing</th><th>Toetsingskader</th><th class="num">Rekenwaarde effect</th><th class="num">Weerstand</th><th class="num">UC</th><th>Besluit</th></tr></thead><tbody>
              {#each allChecks as c}<tr class={c.pass ? '' : 'rn-fail'}><td>{c.label}</td><td>{c.kader}</td><td class="num">{c.Ed}</td><td class="num">{c.Rd}</td><td class="num">{uc(c.util)}</td><td>{verdict(c.pass)}</td></tr>{/each}
            </tbody></table>
            {#if embedded && st?.steel}
              <h3>Doorsnedecontrole {st.section?.id} ({soldier ? rw.soldier.grade : rw.sheet.grade}, f_y = {st.fy} N/mm², γ_M0 = 1,00)</h3>
              <p>{soldier ? `Doorsnedeklasse ${st.steel.resistance?.cls?.cls} (NBN EN 1993-1-1 Tabel 5.2: flens c/t = ${fmt(st.steel.resistance?.cls?.flange?.ct, 2)} ≤ ${fmt(st.steel.resistance?.cls?.flange?.limit1, 1)}, lijf c/t = ${fmt(st.steel.resistance?.cls?.web?.ct, 2)} ≤ ${fmt(st.steel.resistance?.cls?.web?.limit1, 1)}). M_pl,Rd = ${fmt(st.steel.resistance?.MplRd, 2)} kNm, M_el,Rd = ${fmt(st.steel.resistance?.MelRd, 2)} kNm, V_pl,Rd = ${fmt(st.steel.resistance?.VplRd, 1)} kN (A_v,z = ${fmt(st.section?.Avz * 1e4, 2)} cm²), N_pl,Rd = ${fmt(st.steel.resistance?.NplRd, 0)} kN.` : `${st.steel.resistance?.plasticAllowed ? `Plastische weerstand (klasse ${st.steel.resistance?.cls}, β_B = ${fmt(rw.sheet.betaB, 2)})` : 'Elastische weerstand'}: M_c,Rd = ${fmt(st.steel.resistance?.McRd, 1)} kNm/m; V_pl,Rd = ${fmt(st.steel.resistance?.VplRd, 1)} kN/m (${fmt(st.steel.resistance?.websPerM, 2)} lijven/m, helling verwaarloosd); N_pl,Rd = ${fmt(st.steel.resistance?.NplRd, 0)} kN/m (NBN EN 1993-5 §5.2.2).`}</p>
            {/if}
            {#if st?.lagging}
              <p>Beschot: p_Ed = {fmt(res.structural.laggingPressure, 2)} kPa ({res.structural.laggingCombo}), L = {fmt(st.lagging.L, 3)} m → M_Ed = p·L²/8 = {fmt(st.lagging.MEd, 3)} kNm/m; W_el = t²/6 = {fmt(st.lagging.Wel * 1e6, 2)} cm³/m, σ = {fmt(st.lagging.sigma, 1)} N/mm²; UC elastisch {uc(st.lagging.utilElastic)} / plastisch {uc(st.lagging.utilPlastic)}{st.lagging.deflection != null ? `; doorbuiging onder p_k ≈ ${fmt(st.lagging.deflection * 1000, 1)} mm` : ''}. Geen aanspraak op gewelfwerking.</p>
            {/if}
            {#if st?.vertical}
              <p>Verticaal evenwicht: G = {fmt(st.vertical.Gpile, 2)} (profiel) + {fmt(st.vertical.Glagging, 2)} (beschot) = {fmt(st.vertical.G, 2)} kN; R_s = ∫T_skin dz = {fmt(st.vertical.Rs, 2)} kN over {fmt(d, 3)} m; UC = {uc(st.vertical.util)}. Voetweerstand niet benut.</p>
            {/if}
          </section>

          {#if drv?.ok}
            <section class="report-section">
              <div class="report-section__head"><h2>Heipredictie — {drv.method === 'impact' ? 'heien (golfvergelijking, Smith 1960)' : drv.method === 'push' ? 'statisch drukken (krachtenevenwicht)' : 'trillen (Hypervib1-type krachtenvelop)'}</h2><p>Niet-normatief empirisch model; geen partiële factoren op de installatieweerstand (bovengrens van de weerstand).</p></div>
              <p>Element: {drv.element?.label}, teenoppervlak {fmt(drv.element?.toeArea_m2 * 1e4, 1)} cm², contactomtrek {fmt(drv.element?.shaftPerimeter_m, 2)} m; doeldiepte {fmt(drv.target, 2)} m onder het werkvlak; statisch referentieprofiel {drv.profile?.method === 'alm-hamre' ? 'Alm & Hamre (2001)' : 'q_s = q_c, τ_s = f_s'}.</p>
              {#if drv.vibratory}
                <table class="rn-table rn-kv"><tbody>
                  <tr><td>F_c,min (m_R = 1,0)</td><td class="num">{fmt(drv.vibratory.FcRequired_kN, 1)} kN op {fmt(drv.vibratory.governingDepth_m, 2)} m</td><td>F_c,min (m_R = 1,25)</td><td class="num">{fmt(drv.vibratory.FcRequired125_kN, 1)} kN op {fmt(drv.vibratory.governingDepth125_m, 2)} m</td></tr>
                  <tr><td>Frequentie / dynamische massa</td><td class="num">{fmt(drv.vibratory.frequency_Hz, 1)} Hz / {fmt(drv.vibratory.dynamicMass_kg, 0)} kg</td><td>Excentrisch moment bij F_c,min(1,25)</td><td class="num">{fmt(drv.vibratory.machine?.atRequired125?.eccentricMoment_kgm, 2)} kg·m</td></tr>
                  <tr><td>Vrije amplitude s₀ / A_pp</td><td class="num">{fmt(drv.vibratory.machine?.atRequired125?.amplitude_mm, 2)} / {fmt(drv.vibratory.machine?.atRequired125?.amplitudePp_mm, 2)} mm</td><td>Λ / δ_H / W_eff</td><td class="num">{fmt(drv.vibratory.lambda, 0)} / {fmt(drv.vibratory.deltaH, 2)} / {fmt(drv.vibratory.Weff_kN, 1)} kN</td></tr>
                </tbody></table>
                {#if drv.vibratory.candidateCheck}
                  {@const cc = drv.vibratory.candidateCheck}
                  <h3>Haalbare diepte met het beschouwde trilblok — {drv.machineLabel || 'kandidaat'}</h3>
                  <div class="rn-verdict {cc.reachesTarget125 ? 'ok' : 'bad'}"><strong>{cc.reachesTarget125 ? 'DOELDIEPTE HAALBAAR (m_R = 1,25)' : cc.reachesTarget ? 'DOELDIEPTE HAALBAAR ZONDER RESERVE (m_R = 1,0)' : 'WEIGERING VOORSPELD'}</strong><span>{cc.reachesTarget ? `krachtenvelop open tot ${fmt(cc.targetDepth_m, 2)} m` : `weigering op ${fmt(cc.refusalDepth_m, 2)} m; mechanisch haalbaar tot ${fmt(cc.achievableDepth_m, 2)} m van de ${fmt(cc.targetDepth_m, 2)} m`}{cc.reachesTarget && !cc.reachesTarget125 ? `; met reserve 1,25 weigering op ${fmt(cc.refusalDepth125_m, 2)} m` : ''}</span></div>
                  <table class="rn-table rn-kv"><tbody>
                    <tr><td>F_c beschikbaar</td><td class="num">{fmt(cc.Fc_kN, 1)} kN bij {fmt(drv.vibratory.frequency_Hz, 1)} Hz{drv.datasheet ? ` (${fmt(drv.datasheet.rpmOperating, 0)} tpm)` : ''}</td><td>Marge op de doeldiepte (m_R 1,0 / 1,25)</td><td class="num">{fmt(cc.marginAtTarget_kN, 1)} / {fmt(cc.marginAtTarget125_kN, 1)} kN</td></tr>
                    <tr><td>Kleinste marge</td><td class="num">{fmt(cc.margin_kN, 1)} / {fmt(cc.margin125_kN, 1)} kN op {fmt(cc.z, 2)} m</td><td>Excentrisch moment / trillende massa</td><td class="num">{fmt(cc.eccentricMoment_kgm, 2)} kg·m / {fmt(drv.vibratory.dynamicMass_kg, 0)} kg{drv.datasheet ? ` (${drv.datasheet.eccentricMomentSource === 'stated' ? 'datablad' : 'uit F_c en tpm'} / ${drv.datasheet.dynamicMassSource === 'stated' ? 'datablad' : 'uit amplitude'})` : ''}</td></tr>
                    <tr><td>Amplitude met element s₀ / A_pp</td><td class="num">{fmt(cc.amplitude_mm, 2)} / {fmt(cc.amplitudePp_mm, 2)} mm</td><td>Spanningsscreening (F_c + W_eff)/A_s</td><td class="num">{fmt(cc.stressScreen_MPa, 1)} MPa</td></tr>
                  </tbody></table>
                  {#if drv.carrier?.rows}
                    <table class="rn-table"><thead><tr><th>Drager</th><th>Vereist (datablad)</th><th>Beschikbaar</th><th>Toets</th></tr></thead><tbody>
                      {#each drv.carrier.rows as r}<tr><td>{r.label}</td><td class="num">{r.required}</td><td class="num">{r.available}</td><td>{r.ok === null ? 'niet getoetst' : r.ok ? 'voldoet' : 'voldoet niet'}{r.note ? ` — ${r.note}` : ''}</td></tr>{/each}
                    </tbody></table>
                  {/if}
                {/if}
                <table class="rn-table"><thead><tr><th class="num">z [m]</th><th class="num">R_s [kN]</th><th class="num">R_b [kN]</th><th class="num">R_drive [kN]</th><th class="num">α</th><th class="num">F_c,min [kN]</th><th class="num">F_c,min,1.25 [kN]</th></tr></thead><tbody>
                  {#each drv.vibratory.perDepth.filter((_: any, i: number) => i % Math.max(1, Math.round(drv.vibratory.perDepth.length / 20)) === 0 || i === drv.vibratory.perDepth.length - 1) as r}<tr><td class="num">{fmt(r.z, 2)}</td><td class="num">{fmt(r.Rs_kN, 1)}</td><td class="num">{fmt(r.Rb_kN, 1)}</td><td class="num">{fmt(r.Rdrive_kN, 1)}</td><td class="num">{fmt(r.alpha, 2)}</td><td class="num">{fmt(r.FcMin_kN, 1)}</td><td class="num">{fmt(r.FcMin125_kN, 1)}</td></tr>{/each}
                </tbody></table>
              {/if}
              {#if drv.push}
                <div class="rn-verdict {drv.push.reachesTarget125 ? 'ok' : 'bad'}"><strong>{drv.push.reachesTarget125 ? 'DOELDIEPTE HAALBAAR (m_R = 1,25)' : drv.push.reachesTarget ? 'DOELDIEPTE HAALBAAR ZONDER RESERVE' : 'WEIGERING VOORSPELD'}</strong><span>drukkracht {fmt(drv.push.force_kN, 0)} kN; {drv.push.reachesTarget ? `statisch evenwicht open tot ${fmt(drv.push.targetDepth_m, 2)} m` : `weigering op ${fmt(drv.push.refusalDepth_m, 2)} m, haalbaar tot ${fmt(drv.push.achievableDepth_m, 2)} m`}; vereiste drukkracht {fmt(drv.push.requiredForce_kN, 0)} / {fmt(drv.push.requiredForce125_kN, 0)} kN (m_R 1,0 / 1,25) op {fmt(drv.push.governingDepth_m, 2)} m</span></div>
                <table class="rn-table"><thead><tr><th class="num">z [m]</th><th class="num">R_s [kN]</th><th class="num">R_b [kN]</th><th class="num">R_statisch [kN]</th><th class="num">W [kN]</th><th class="num">F_vereist [kN]</th><th class="num">G [kN]</th></tr></thead><tbody>
                  {#each drv.push.perDepth.filter((_: any, i: number) => i % Math.max(1, Math.round(drv.push.perDepth.length / 20)) === 0 || i === drv.push.perDepth.length - 1) as r}<tr><td class="num">{fmt(r.z, 2)}</td><td class="num">{fmt(r.Rs_kN, 0)}</td><td class="num">{fmt(r.Rb_kN, 0)}</td><td class="num">{fmt(r.Rstatic_kN, 0)}</td><td class="num">{fmt(r.W_kN, 1)}</td><td class="num">{fmt(r.Frequired_kN, 0)}</td><td class="num">{fmt(r.G_kN, 0)}</td></tr>{/each}
                </tbody></table>
              {/if}
              {#if drv.impact}
                <p>Heiblok: {drv.hammer?.type}, valgewicht {fmt(drv.hammer?.ramMass_kg, 0)} kg, {fmt(drv.hammer?.ratedEnergy_kJ, 0)} kJ × η = {fmt(drv.hammer?.efficiency, 2)}. {drv.impact.refusalDepth_m != null ? `Weigering (≥ 250 slagen / 25 cm) voorspeld op ${fmt(drv.impact.refusalDepth_m, 2)} m van de ${fmt(drv.target, 2)} m doeldiepte.` : `De doeldiepte ${fmt(drv.target, 2)} m wordt bereikt.`}</p>
                <table class="rn-table"><thead><tr><th class="num">z [m]</th><th class="num">R_static [kN]</th><th class="num">zakking/slag [mm]</th><th class="num">slagen/25 cm</th><th class="num">σ_c,max [MPa]</th><th class="num">σ_t,max [MPa]</th><th class="num">ENTHRU [kJ]</th></tr></thead><tbody>
                  {#each drv.impact.perDepth as r}<tr><td class="num">{fmt(r.z, 2)}</td><td class="num">{fmt(r.Rstatic_kN, 0)}</td><td class="num">{fmt(r.set_mm, 1)}</td><td class="num">{r.refusal ? 'stuit' : fmt(r.blows_per_25cm, 0)}</td><td class="num">{fmt(r.maxCompStress_MPa, 0)}</td><td class="num">{fmt(r.maxTensStress_MPa, 0)}</td><td class="num">{fmt(r.enthru_kJ, 1)}</td></tr>{/each}
                </tbody></table>
              {/if}
              <p class="rn-note">{(drv.notes || []).join(' ')}</p>
            </section>
          {/if}

          {#if vib}
            <section class="report-section">
              <div class="report-section__head"><h2>Trillingen bij de belending</h2><p>Voorspelling {vib.impact ? 'BS 5228-2 (heien)' : 'TRL 429 / BS 5228-2 (trillen)'}; toetsing {rw.vibration.framework}. Kaders worden niet gemengd.</p></div>
              <p>Afstand x = {fmt(vib.x, 1)} m, dominante frequentie {fmt(vib.f, 0)} Hz. Voorspelde PPV (maatgevend, {vib.governing?.label}): <strong>{fmt(vib.governing?.ppv, 2)} mm/s</strong>. Grenswaarde {rw.vibration.framework}: {fmt(vib.assess?.limit_mm_s, 2)} mm/s → benutting {uc(vib.assess?.utilisation)} ({vib.assess?.verdict}).{rw.vibration.framework === 'SBR-A' && vib.assess?.detail ? ` SBR-A: categorie ${rw.vibration.sbr.category}, V_kar = ${fmt(vib.assess.detail.vKar, 2)} mm/s, γ_s = ${fmt(vib.assess.detail.gammaS, 1)}, γ_v = ${fmt(vib.assess.detail.gammaV, 1)}, γ_t = ${fmt(vib.assess.detail.gammaT, 1)} → V_top,allow = ${fmt(vib.assess.detail.vAllow, 2)} mm/s.` : ''}</p>
              {#if !vib.impact}
                <table class="rn-table"><thead><tr><th>Fase</th><th class="num">k_v 60 (50 %)</th><th class="num">k_v 126 (33 %)</th><th class="num">k_v 266 (5 %)</th></tr></thead><tbody>{#each vib.rowsPred as r}<tr><td>{r.phase}</td><td class="num">{fmt(r.p50, 2)}</td><td class="num">{fmt(r.p33, 2)}</td><td class="num">{fmt(r.p5, 2)}</td></tr>{/each}</tbody></table>
              {/if}
              <p>Alarmniveaus: verwacht {fmt(vib.plan?.expected?.value, 2)} mm/s · bovengrens voorspelling {fmt(vib.plan?.upper?.value, 2)} mm/s · waarschuwing {fmt(vib.plan?.warning?.value, 2)} mm/s · stop {fmt(vib.plan?.stop?.value, 2)} mm/s · menselijke hinder (BS 5228-2) {fmt(vib.plan?.humanObjective?.value, 2)} mm/s.</p>
              {#if vib.plan?.frequencyTable?.length}
                <table class="rn-table"><thead><tr><th class="num">f [Hz]</th><th class="num">V_kar [mm/s]</th><th class="num">toelaatbaar [mm/s]</th><th class="num">waarschuwing [mm/s]</th></tr></thead><tbody>{#each vib.plan.frequencyTable as r}<tr><td class="num">{fmt(r.f, 0)}</td><td class="num">{fmt(r.vKar, 2)}</td><td class="num">{fmt(r.vAllow, 2)}</td><td class="num">{fmt(r.warning, 2)}</td></tr>{/each}</tbody></table>
              {/if}
              {#if vib.fit && Number.isFinite(vib.fit.K)}<p>Terreinkalibratie: v = {fmt(vib.fit.K, 2)}·x<sup>−{fmt(vib.fit.n, 3)}</sup> (N = {vib.pts?.length}); v(x) = {fmt(typeof vib.fitAt === 'number' ? vib.fitAt : vib.fitAt?.ppv_mm_s, 2)} mm/s{vib.upper ? `, v95 = ${fmt(vib.upper.v95_mm_s, 2)} mm/s` : ''}.</p>{/if}
              <p class="rn-note">{(vib.assess?.notes || []).join(' ')}</p>
            </section>
          {/if}

          <section class="report-section">
            <div class="report-section__head"><h2>Besluit en aandachtspunten</h2></div>
            <p>De {payload.wall.label.toLowerCase()} {overall ? 'voldoet aan de beschouwde grenstoestanden' : 'voldoet niet aan alle beschouwde grenstoestanden'} onder de hierboven vermelde uitgangspunten; maatgevende benuttingsgraad {uc(Math.max(...allChecks.map((c: any) => Number(c.util) || 0)))}.</p>
            <ul class="rn-list">
              {#each (res?.notes || []) as n}<li>{n}</li>{/each}
              {#each (payload.profile?.notes || []) as n}<li>{n}</li>{/each}
              {#if embedded}<li>Niet in deze nota: globale stabiliteit, hydraulische grondbreuk/piping bij een aanzienlijk drukverschil (stroomnet), verankeringsproeven (EN 1537), uitvoeringstoleranties (NBN EN 12063:2024 / NBN EN 12699:2015), corrosie op lange termijn tenzij ingevoerd, en vervormingen (BGT) — die volgen uit het PLAXIS-model.</li>{/if}
              <li>Deze nota is gegenereerd met de MADEP CPT Interpreter {payload.project.appVersion || ''}; de ontwerper blijft verantwoordelijk voor de uitgangspunten, de karakteristieke waarden en de uitvoeringsvoorwaarden.</li>
            </ul>
          </section>
        </article>
      </td></tr></tbody>
    </table>
  </div>
  </svelte:boundary>
{/if}

<style>
  :global(body) { margin: 0; background: var(--color-bg); }
  .report-shell { --rpt-ink: #18181a; --rpt-ink-2: #4a4a52; --rpt-ink-3: #65656d; --rpt-paper: #fff; --rpt-paper-2: #fbf9f5; --rpt-hairline: rgba(24,24,26,0.12); --rpt-hairline-soft: rgba(24,24,26,0.07); --rpt-accent: #3d6b6a; --rpt-accent-text: #2e5150; max-width: var(--container-max); margin: 0 auto; padding: 24px var(--section-px) 64px; }
  .report-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 10px; max-width: 1140px; margin: 0 auto 18px; }
  .report-error { max-width: 560px; margin: 80px auto; text-align: center; color: var(--tx); }
  .report-error__actions { display: flex; justify-content: center; gap: 10px; margin-top: 18px; }
  .report-sheet { width: 100%; max-width: 1140px; margin: 0 auto; border-collapse: collapse; table-layout: fixed; background: var(--rpt-paper); border: 1px solid var(--rpt-hairline); box-shadow: 0 1px 2px rgba(18,18,20,0.04), 0 18px 48px rgba(18,18,20,0.12); }
  .report-sheet > tbody > tr > td { padding: clamp(28px, 4vw, 56px) clamp(22px, 4.5vw, 60px); vertical-align: top; }
  .report-running-head, .report-running-foot { display: none; }
  .report { display: block; color: var(--rpt-ink); font-size: 13px; line-height: 1.5; }
  .report-cover { padding: 0 0 26px; }
  .report-masthead { display: flex; justify-content: space-between; align-items: flex-start; gap: 32px; }
  .report-masthead__brand { display: flex; flex-direction: column; gap: 8px; }
  .report-masthead__logo { height: 52px; width: auto; display: block; }
  .report-masthead__tagline { font-family: var(--font-mono); font-size: 0.62rem; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--rpt-ink-3); }
  .report-masthead__meta { display: grid; grid-template-columns: repeat(2, minmax(0, auto)); gap: 4px 26px; margin: 0; font-family: var(--font-mono); font-size: 0.68rem; }
  .report-masthead__meta div { display: flex; gap: 8px; }
  .report-masthead__meta dt { color: var(--rpt-ink-3); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.6rem; align-self: center; }
  .report-masthead__meta dd { margin: 0; font-weight: 600; }
  .report-masthead__rule { height: 2px; background: var(--rpt-accent); margin: 16px 0 22px; }
  .report-cover__kicker { margin: 0 0 6px; font-family: var(--font-mono); font-size: 0.66rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--rpt-accent-text); }
  .report-cover__title { margin: 0 0 10px; font-size: 30px; line-height: 1.15; letter-spacing: -0.01em; }
  .report-cover__lede { margin: 0; max-width: 680px; color: var(--rpt-ink-2); }
  .report-section { padding: 26px 0 0; break-inside: auto; }
  .report-section__head { border-bottom: 1px solid var(--rpt-hairline); padding-bottom: 8px; margin-bottom: 14px; }
  .report-section__head h2 { margin: 0 0 2px; font-size: 16px; }
  .report-section__head p { margin: 0; color: var(--rpt-ink-3); font-size: 12px; }
  .report h3 { font-size: 13px; margin: 16px 0 6px; }
  .rn-verdict { display: flex; gap: 16px; align-items: baseline; margin-top: 18px; padding: 10px 14px; border-radius: 6px; font-size: 12px; }
  .rn-verdict.ok { background: rgba(46,111,85,0.10); color: #2e6f55; }
  .rn-verdict.bad { background: rgba(155,58,50,0.10); color: #9b3a32; }
  .rn-verdict strong { font-family: var(--font-mono); letter-spacing: 0.06em; font-size: 11px; }
  .rn-table { width: 100%; border-collapse: collapse; font-size: 11.5px; font-variant-numeric: tabular-nums; margin-bottom: 8px; }
  .rn-table th { text-align: left; font-family: var(--font-mono); font-size: 0.6rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--rpt-ink-3); border-bottom: 1px solid var(--rpt-hairline); padding: 5px 7px; }
  .rn-table td { padding: 4px 7px; border-bottom: 1px solid var(--rpt-hairline-soft); vertical-align: top; }
  .rn-table th.num, .rn-table td.num { text-align: right; font-family: var(--font-mono); font-size: 11px; }
  .rn-table tr.rn-fail td { color: #9b3a32; }
  .rn-kv td:nth-child(odd) { color: var(--rpt-ink-2); }
  .rn-list { padding-left: 18px; margin: 0; font-size: 12px; }
  .rn-list li { margin: 3px 0; }
  .rn-note { font-size: 11px; color: var(--rpt-ink-3); margin: 4px 0 10px; }
  .rn-warn { color: #9b3a32; }
  .rn-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 18px; }
  @media print {
    :global(html), :global(body) { background: #fff; color: #111; font-size: 8pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
    .rn-errstack { font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; text-align: left; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 6px; }
    .report-shell { max-width: none; padding: 0; }
    .report-sheet { max-width: none; border: none; box-shadow: none; background: #fff; }
    .report-sheet > tbody > tr > td { padding: 0; }
    .report-running-head { display: table-header-group; }
    .report-running-foot { display: table-footer-group; }
    .report-running-head td { padding: 0 0 4mm; }
    .report-running-foot td { padding: 3mm 0 0; }
    .report-running-head__inner, .report-running-foot__inner { display: flex; justify-content: space-between; gap: 8mm; font-family: var(--font-mono); font-size: 6pt; letter-spacing: 0.1em; text-transform: uppercase; color: #666; }
    .report-running-head__inner { border-bottom: 0.5pt solid #999; padding-bottom: 1.6mm; }
    .report-running-foot__inner { border-top: 0.5pt solid #999; padding-top: 1.6mm; }
    .report { font-size: 8pt; }
    .report-cover__title { font-size: 20pt; }
    .rn-table { font-size: 7.5pt; }
    .rn-grid2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .report-section { break-inside: auto; }
    .rn-table tr { break-inside: avoid; }
  }
</style>
