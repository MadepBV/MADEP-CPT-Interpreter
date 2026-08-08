<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<svelte:options runes={false} />

<script lang="ts">
  import '$lib/cpt-app/legacy.css';
  import { onMount } from 'svelte';
  import { loadSoilinPayload } from '$lib/cpt-app/stratigraphy/soilin-report';

  let payload: any = null;
  let loadError = '';

  function fmt(value: unknown, digits = 2) {
    const num = Number(value);
    if (value == null || !Number.isFinite(num)) return '—';
    return num.toFixed(digits);
  }

  function fmtDateTime(value: string) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return date.toLocaleString('nl-BE', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function boreholeDepth(borehole: any) {
    return borehole.rows.reduce((sum: number, row: any) => sum + (row.thickness || 0), 0);
  }

  onMount(() => {
    const key = new URLSearchParams(window.location.search).get('key') || '';
    payload = loadSoilinPayload(window.localStorage, key);
    if (!payload) {
      loadError = key
        ? 'Geen SOILIN-rapportdata gevonden voor deze sleutel in deze browser. Genereer het rapport opnieuw vanuit de Stratigrafie-fase.'
        : 'Geen rapportsleutel meegegeven. Genereer het rapport vanuit de Stratigrafie-fase van de CPT-app.';
    }
  });
</script>

<svelte:head>
  <title>SOILIN invoerparameters — MADEP</title>
</svelte:head>

{#if loadError}
  <div class="report-shell">
    <div class="report-error">
      <h1>SOILIN-rapport niet beschikbaar</h1>
      <p>{loadError}</p>
      <div class="report-error__actions">
        <a class="btn pri" href="/">Naar de CPT-app</a>
      </div>
    </div>
  </div>
{:else if !payload}
  <div class="report-shell">
    <div class="report-error"><h1>SOILIN-rapport laden…</h1></div>
  </div>
{:else}
  <div class="report-shell">
    <div class="report-toolbar no-print">
      <a class="btn sm" href="/">CPT app</a>
      <button class="btn pri" type="button" onclick={() => window.print()}>Print / Save as PDF</button>
    </div>

    <table class="report-sheet">
      <thead class="report-running-head">
        <tr>
          <td>
            <div class="report-running-head__inner">
              <span>{payload.project.name}</span>
              <span>SOILIN invoerparameters</span>
            </div>
          </td>
        </tr>
      </thead>
      <tfoot class="report-running-foot">
        <tr>
          <td>
            <div class="report-running-foot__inner">
              <span>MADEP BV · Nederholbeekstraat 68, 9680 Maarkedal · BTW BE0779808833</span>
              <span>{fmtDateTime(payload.generatedAt)}</span>
            </div>
          </td>
        </tr>
      </tfoot>
      <tbody>
        <tr>
          <td>
            <article class="report">
              <section class="report-cover">
                <header class="report-masthead">
                  <div class="report-masthead__brand">
                    <img class="report-masthead__logo" src="/MADEP_logo.svg" alt="MADEP" />
                    <div class="report-masthead__tagline">Geotechnical engineering</div>
                  </div>
                  <dl class="report-masthead__meta">
                    <div><dt>Project</dt><dd>{payload.project.name}</dd></div>
                    <div><dt>Datum</dt><dd>{fmtDateTime(payload.generatedAt)}</dd></div>
                    <div><dt>Eenheden</dt><dd>{payload.units.length}</dd></div>
                    <div><dt>Boringen</dt><dd>{payload.boreholes.length}</dd></div>
                  </dl>
                </header>
                <div class="report-masthead__rule"></div>
                <p class="report-cover__kicker">SCIA Engineer · Soilin subsoil input</p>
                <h1 class="report-cover__title">SOILIN invoerparameters</h1>
                <p class="report-cover__lede">
                  Grondeenheden afgeleid uit de multi-CPT stratigrafie. Elke boring vermeldt
                  <strong>alle</strong> eenheden in vaste stratigrafische volgorde; waar een eenheid
                  lokaal ontbreekt (uitwiggend / lens) staat ze met dikte 0,00&nbsp;m — SOILIN
                  vereist dezelfde laagvolgorde in elke boring.
                </p>
              </section>

              <section class="report-section">
                <div class="report-section__head">
                  <h2>Grondeenheden — parameterlegenda</h2>
                  <p>
                    Dikte-gewogen gemiddelden over de deelnemende CPT-lagen; volumegewichten volgens
                    karakteristieke keuze "{payload.characteristic === 'min' ? 'ondergrens' : 'gewogen gemiddelde'}".
                  </p>
                </div>
                <table class="soilin-table">
                  <thead>
                    <tr>
                      <th class="soilin-table__unit">Eenheid</th>
                      <th>Grondsoort</th>
                      <th class="num">E_def [MN/m²]</th>
                      <th class="num">ν [-]</th>
                      <th class="num">γ_dry [kN/m³]</th>
                      <th class="num">γ_sat [kN/m³]</th>
                      <th class="num">m [-]</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each payload.units as unit}
                      <tr>
                        <td class="soilin-table__unit">
                          <span class="soilin-chip" style={`background:${unit.color}`}></span>
                          <strong>{unit.letter}</strong>
                        </td>
                        <td>{unit.subtype}</td>
                        <td class="num">{fmt(unit.EdefMPa, 1)}</td>
                        <td class="num">{fmt(unit.nu, 2)}</td>
                        <td class="num">{fmt(unit.gammaDry, 1)}</td>
                        <td class="num">{fmt(unit.gammaSat, 1)}</td>
                        <td class="num">{fmt(unit.m, 2)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                <p class="soilin-footnote">
                  E_def = β·E_oed,i met β = (1+ν)(1−2ν)/(1−ν) (ČSN 73 1001-conventie, zie Stage 4).
                  m is de spanningsexponent uit Stage 4 (CUR 2003-7); controleer of dit overeenkomt
                  met de door uw SOILIN-werkwijze verwachte coëfficiënt m.
                </p>
              </section>

              <section class="report-section">
                <div class="report-section__head">
                  <h2>Boorprofielen — over te nemen in SCIA Engineer</h2>
                  <p>Eén boring per CPT. Rijen met dikte 0,00 m ook invoeren: de volgorde telt.</p>
                </div>
                <div class="soilin-boreholes">
                  {#each payload.boreholes as borehole}
                    <div class="soilin-borehole">
                      <div class="soilin-borehole__head">
                        <h3>{borehole.id}</h3>
                        <span>
                          maaiveld {fmt(borehole.elev, 2)} m TAW
                          {#if borehole.dist != null}
                            · meetlijn {fmt(borehole.dist, 1)} m
                          {/if}
                        </span>
                      </div>
                      <table class="soilin-table">
                        <thead>
                          <tr>
                            <th class="soilin-table__unit">Laag</th>
                            <th class="num">Dikte [m]</th>
                            <th class="num">E_def [MN/m²]</th>
                            <th class="num">ν [-]</th>
                            <th class="num">γ_dry [kN/m³]</th>
                            <th class="num">γ_sat [kN/m³]</th>
                            <th class="num">m [-]</th>
                          </tr>
                        </thead>
                        <tbody>
                          {#each borehole.rows as row, i}
                            {@const unit = payload.units[row.unit]}
                            <tr class:soilin-row--absent={!row.thickness}>
                              <td class="soilin-table__unit">
                                <span class="soilin-chip" style={`background:${unit.color}`}></span>
                                <strong>{unit.letter}</strong>
                                <span class="soilin-table__subtype">{unit.subtype}</span>
                              </td>
                              <td class="num soilin-table__thickness">{fmt(row.thickness, 2)}</td>
                              <td class="num">{fmt(unit.EdefMPa, 1)}</td>
                              <td class="num">{fmt(unit.nu, 2)}</td>
                              <td class="num">{fmt(unit.gammaDry, 1)}</td>
                              <td class="num">{fmt(unit.gammaSat, 1)}</td>
                              <td class="num">{fmt(unit.m, 2)}</td>
                            </tr>
                          {/each}
                          <tr class="soilin-row--total">
                            <td>Totale dikte</td>
                            <td class="num soilin-table__thickness">{fmt(boreholeDepth(borehole), 2)}</td>
                            <td colspan="5"></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  {/each}
                </div>
              </section>
            </article>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
{/if}

<style>
  /* Compact instance of the MADEP report design system (see Stage 7 report):
     near-monochrome ink on a light sheet, one brand accent, print-first. */

  :global(body) {
    margin: 0;
    background: var(--color-bg);
  }

  .report-shell {
    --rpt-ink: #18181a;
    --rpt-ink-2: #4a4a52;
    --rpt-ink-3: #65656d;
    --rpt-paper: #ffffff;
    --rpt-paper-2: #fbf9f5;
    --rpt-hairline: rgba(24, 24, 26, 0.12);
    --rpt-hairline-soft: rgba(24, 24, 26, 0.07);
    --rpt-rule: #18181a;
    --rpt-accent: #3d6b6a;
    --rpt-accent-text: #2e5150;

    max-width: var(--container-max);
    margin: 0 auto;
    padding: 24px var(--section-px) 64px;
  }

  .report-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    max-width: 1140px;
    margin: 0 auto 18px;
  }

  .report-error {
    max-width: 560px;
    margin: 80px auto;
    text-align: center;
    color: var(--tx);
  }

  .report-error__actions {
    display: flex;
    justify-content: center;
    gap: 10px;
    margin-top: 18px;
  }

  .report-sheet {
    width: 100%;
    max-width: 1140px;
    margin: 0 auto;
    border-collapse: collapse;
    table-layout: fixed;
    background: var(--rpt-paper);
    border: 1px solid var(--rpt-hairline);
    box-shadow: 0 1px 2px rgba(18, 18, 20, 0.04), 0 18px 48px rgba(18, 18, 20, 0.12);
  }

  .report-sheet > tbody > tr > td {
    padding: clamp(28px, 4vw, 56px) clamp(22px, 4.5vw, 60px);
    vertical-align: top;
  }

  .report-running-head,
  .report-running-foot {
    display: none;
  }

  .report {
    display: block;
    color: var(--rpt-ink);
    font-size: 13px;
    line-height: 1.5;
  }

  /* ---------- masthead ---------- */

  .report-cover {
    padding: 0 0 26px;
  }

  .report-masthead {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 32px;
  }

  .report-masthead__brand {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .report-masthead__logo {
    height: 52px;
    width: auto;
    display: block;
  }

  .report-masthead__tagline {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rpt-ink-3);
  }

  .report-masthead__meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, auto));
    gap: 4px 26px;
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.68rem;
  }

  .report-masthead__meta div {
    display: flex;
    gap: 8px;
  }

  .report-masthead__meta dt {
    color: var(--rpt-ink-3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.6rem;
    align-self: center;
  }

  .report-masthead__meta dd {
    margin: 0;
    font-weight: 600;
  }

  .report-masthead__rule {
    height: 2px;
    background: var(--rpt-accent);
    margin: 16px 0 22px;
  }

  .report-cover__kicker {
    margin: 0 0 6px;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--rpt-accent-text);
  }

  .report-cover__title {
    margin: 0 0 10px;
    font-size: 30px;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }

  .report-cover__lede {
    margin: 0;
    max-width: 640px;
    color: var(--rpt-ink-2);
  }

  /* ---------- sections ---------- */

  .report-section {
    padding: 26px 0 0;
  }

  .report-section__head {
    border-bottom: 1px solid var(--rpt-hairline);
    padding-bottom: 8px;
    margin-bottom: 14px;
  }

  .report-section__head h2 {
    margin: 0 0 2px;
    font-size: 16px;
    letter-spacing: -0.005em;
  }

  .report-section__head p {
    margin: 0;
    color: var(--rpt-ink-3);
    font-size: 12px;
  }

  /* ---------- tables ---------- */

  .soilin-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .soilin-table th {
    text-align: left;
    font-family: var(--font-mono);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rpt-ink-3);
    border-bottom: 1px solid var(--rpt-hairline);
    padding: 6px 8px;
  }

  .soilin-table td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--rpt-hairline-soft);
  }

  .soilin-table th.num,
  .soilin-table td.num {
    text-align: right;
  }

  .soilin-table__unit {
    white-space: nowrap;
  }

  .soilin-table__subtype {
    color: var(--rpt-ink-2);
    margin-left: 6px;
  }

  .soilin-table__thickness {
    font-weight: 700;
  }

  .soilin-chip {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 3px;
    border: 1px solid rgba(24, 24, 26, 0.25);
    margin-right: 7px;
    vertical-align: -1px;
  }

  .soilin-row--absent td {
    color: var(--rpt-ink-3);
  }

  .soilin-row--absent .soilin-table__thickness {
    color: var(--rpt-ink);
  }

  .soilin-row--total td {
    border-bottom: none;
    border-top: 1px solid var(--rpt-hairline);
    font-family: var(--font-mono);
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--rpt-ink-2);
  }

  .soilin-footnote {
    margin: 10px 0 0;
    font-size: 11px;
    color: var(--rpt-ink-3);
    max-width: 680px;
  }

  /* ---------- boreholes ---------- */

  .soilin-boreholes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 18px;
  }

  .soilin-borehole {
    border: 1px solid var(--rpt-hairline);
    border-radius: 6px;
    padding: 12px 14px 8px;
    background: var(--rpt-paper-2);
    break-inside: avoid;
  }

  .soilin-borehole__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .soilin-borehole__head h3 {
    margin: 0;
    font-size: 14px;
  }

  .soilin-borehole__head span {
    font-family: var(--font-mono);
    font-size: 0.64rem;
    color: var(--rpt-ink-3);
  }

  /* ---------- print ---------- */

  @media print {
    :global(html),
    :global(body) {
      background: #fff;
      color: #111;
      font-size: 8pt;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .no-print {
      display: none !important;
    }

    .report-shell {
      max-width: none;
      padding: 0;
    }

    .report-sheet {
      max-width: none;
      border: none;
      box-shadow: none;
      background: #fff;
    }

    .report-sheet > tbody > tr > td {
      padding: 0;
    }

    .report-running-head {
      display: table-header-group;
    }

    .report-running-foot {
      display: table-footer-group;
    }

    .report-running-head td {
      padding: 0 0 4mm;
    }

    .report-running-foot td {
      padding: 3mm 0 0;
    }

    .report-running-head__inner,
    .report-running-foot__inner {
      display: flex;
      justify-content: space-between;
      gap: 8mm;
      font-family: var(--font-mono);
      font-size: 6pt;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #666;
    }

    .report-running-head__inner {
      border-bottom: 0.5pt solid #999;
      padding-bottom: 1.6mm;
    }

    .report-running-foot__inner {
      border-top: 0.5pt solid #999;
      padding-top: 1.6mm;
    }

    .report {
      font-size: 8pt;
    }

    .report-cover__title {
      font-size: 20pt;
    }

    .soilin-boreholes {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .soilin-borehole {
      background: #fff;
    }

    .soilin-table {
      font-size: 7.5pt;
    }
  }
</style>
