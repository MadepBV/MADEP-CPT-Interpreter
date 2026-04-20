<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<svelte:options runes={false} />

<script lang="ts">
  import '$lib/cpt-app/legacy.css';
  import { parseStage7Payload, persistStage7Payload } from '$lib/cpt-app/report-storage';

  let fileInputEl: HTMLInputElement | null = null;
  let isBusy = false;
  let isDragActive = false;
  let selectedFileName = '';
  let error = '';

  function openPicker() {
    if (isBusy) return;
    fileInputEl?.click();
  }

  async function openPayloadFile(files: FileList | File[] | null | undefined) {
    const file = files?.[0];
    if (!file) return;

    selectedFileName = file.name;
    error = '';
    isBusy = true;

    try {
      const raw = await file.text();
      const payload = parseStage7Payload(raw);
      if (!payload) {
        error = 'This file does not contain a valid MADEP Stage 7 report export.';
        return;
      }

      const key = persistStage7Payload(window.localStorage, payload);
      if (!key) {
        error = 'This Stage 7 report file could not be loaded.';
        return;
      }

      window.location.assign(`/report/stage7?key=${encodeURIComponent(key)}`);
    } catch {
      error = 'The selected file could not be read. Please try another exported report file.';
    } finally {
      isBusy = false;
    }
  }

  async function handleFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement | null;
    await openPayloadFile(input?.files);
    if (input) input.value = '';
  }

  function handleDragEnter(event: DragEvent) {
    event.preventDefault();
    isDragActive = true;
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    isDragActive = true;
  }

  function handleDragLeave(event: DragEvent) {
    event.preventDefault();
    isDragActive = false;
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragActive = false;
    await openPayloadFile(event.dataTransfer?.files);
  }
</script>

<svelte:head>
  <title>Open Stage 7 Report</title>
  <meta
    name="description"
    content="Open an exported MADEP Stage 7 report payload and render it in the report viewer."
  />
</svelte:head>

<div class="report-shell">
  <section class="report-cover">
    <div class="report-cover__topline">
      <div class="report-cover__brand">CPT Interpreter</div>
      <div class="report-cover__eyebrow">Portable Stage 7 report</div>
    </div>

    <h1>Open a saved report file</h1>
    <p>
      Reports launched from the CPT app still open directly. This page is for reopening an exported
      Stage 7 payload on another browser or device.
    </p>

    <div class="report-cover__meta">
      <div><span>Input</span><strong>Stage 7 JSON export</strong></div>
      <div><span>Output</span><strong>Full report view</strong></div>
      <div><span>Use case</span><strong>Portable review & archiving</strong></div>
    </div>
  </section>

  <section class="report-section report-gateway">
    <div class="report-section__head">
      <h2>Load saved data</h2>
      <p>Select a file downloaded from the Stage 7 report toolbar.</p>
    </div>

    <input
      bind:this={fileInputEl}
      class="report-gateway__input"
      type="file"
      accept=".json,application/json"
      onchange={handleFileChange}
    />

    <div
      class:report-gateway__dropzone--active={isDragActive}
      class="dz report-gateway__dropzone"
      role="button"
      tabindex="0"
      aria-busy={isBusy}
      ondragenter={handleDragEnter}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
      onclick={openPicker}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPicker();
        }
      }}
    >
      <strong>{isBusy ? 'Opening report…' : 'Drop a Stage 7 file here'}</strong>
      <p>or click to choose the `.json` file exported from a report view</p>
      {#if selectedFileName}
        <span class="report-gateway__file">{selectedFileName}</span>
      {/if}
    </div>

    <div class="report-gateway__actions">
      <button class="btn pri" type="button" onclick={openPicker} disabled={isBusy}>
        Choose data file
      </button>
      <a class="btn" href="/">Back to CPT app</a>
    </div>

    {#if error}
      <p class="report-gateway__error">{error}</p>
    {/if}
  </section>

  <section class="report-section">
    <div class="report-section__head">
      <h2>How it fits the current flow</h2>
      <p>The in-app report handoff still works unchanged. Export is only needed when the payload must travel.</p>
    </div>

    <div class="report-gateway__grid">
      <article class="report-gateway__card">
        <h3>From the app</h3>
        <p>Open the Stage 7 report the usual way from the CPT workflow.</p>
      </article>

      <article class="report-gateway__card">
        <h3>From the report</h3>
        <p>Use the new download button to save the payload as a portable JSON file.</p>
      </article>

      <article class="report-gateway__card">
        <h3>Later or elsewhere</h3>
        <p>Visit <code>/report</code>, upload that file, and the same Stage 7 view opens again.</p>
      </article>
    </div>
  </section>
</div>

<style>
  :global(body) {
    margin: 0;
  }

  .report-shell {
    max-width: 980px;
    margin: 0 auto;
    padding: 24px 24px 56px;
    display: grid;
    gap: 22px;
  }

  .report-cover,
  .report-section {
    background: var(--panel-solid);
    border: 1px solid var(--bd);
    border-radius: var(--r2);
    box-shadow: var(--sh);
    padding: 28px;
  }

  .report-cover {
    min-height: 260px;
    display: grid;
    align-content: start;
    gap: 14px;
    background:
      linear-gradient(135deg, rgba(61, 107, 106, 0.16), transparent 36%),
      var(--panel-strong);
  }

  .report-cover__topline {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }

  .report-cover__brand,
  .report-cover__eyebrow {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .report-cover__brand {
    color: var(--acb);
  }

  .report-cover__eyebrow {
    color: var(--tx2);
  }

  .report-cover h1 {
    margin: 0;
    font-family: var(--font-heading);
    font-size: clamp(32px, 7vw, 56px);
    line-height: 0.94;
    letter-spacing: -0.05em;
  }

  .report-cover p,
  .report-section__head p,
  .report-gateway__card p {
    margin: 0;
    color: var(--tx2);
  }

  .report-cover__meta {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .report-cover__meta div,
  .report-gateway__card {
    background: rgba(255, 255, 255, 0.24);
    border: 1px solid var(--bd);
    border-radius: var(--r);
    padding: 16px 18px;
  }

  .report-cover__meta span {
    display: block;
    margin-bottom: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--tx2);
  }

  .report-cover__meta strong,
  .report-gateway__card h3,
  .report-section__head h2 {
    font-family: var(--font-heading);
    letter-spacing: -0.02em;
  }

  .report-cover__meta strong {
    font-size: 16px;
  }

  .report-section__head {
    display: grid;
    gap: 4px;
    margin-bottom: 16px;
  }

  .report-section__head h2 {
    margin: 0;
    font-size: 24px;
  }

  .report-gateway {
    display: grid;
    gap: 16px;
  }

  .report-gateway__input {
    display: none;
  }

  .report-gateway__dropzone {
    min-height: 220px;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 10px;
    text-align: center;
  }

  .report-gateway__dropzone strong {
    font-family: var(--font-heading);
    font-size: 22px;
    letter-spacing: -0.03em;
  }

  .report-gateway__dropzone p {
    max-width: 32rem;
    margin: 0;
    color: var(--tx2);
  }

  .report-gateway__dropzone--active {
    border-color: var(--acb);
    background:
      linear-gradient(135deg, rgba(61, 107, 106, 0.12), rgba(61, 107, 106, 0.04)),
      var(--panel-soft);
  }

  .report-gateway__file {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--bd);
    background: var(--panel-solid);
    font-size: 12px;
    font-weight: 700;
  }

  .report-gateway__actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .report-gateway__error {
    margin: 0;
    padding: 12px 14px;
    border: 1px solid rgba(159, 45, 45, 0.24);
    border-radius: var(--r);
    background: rgba(159, 45, 45, 0.08);
    color: #7f1f1f;
    font-size: 13px;
    font-weight: 600;
  }

  .report-gateway__grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  :global(.btn[disabled]) {
    opacity: 0.6;
    pointer-events: none;
  }

  @media (max-width: 820px) {
    .report-cover__meta,
    .report-gateway__grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .report-shell {
      padding-inline: 16px;
    }

    .report-cover,
    .report-section {
      padding: 22px;
    }
  }
</style>
