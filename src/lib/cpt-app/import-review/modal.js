// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Import-review dialog. Shown after a CPT file is parsed and before its data
// enters the project: the engineer sees exactly which columns were
// identified, the derived reading statistics and the data-quality notes, and
// can remap columns (Excel/CSV) with live re-derivation. Import only
// proceeds on explicit confirmation.
//
// DOM-only module: one overlay, promise-based, no state outside the call.
//
// The overlay is a native `<dialog>` (design §3.15 / §4.4): `showModal()` supplies the focus trap,
// Escape and the inert page, `::backdrop` carries the one blur of the composition (§4.1 rule 8) and
// the sheet adds none. Every id, `data-*`, handler name and visible string — and the block structure
// the DOM-text goldens read — is unchanged; only the classes moved to components.css §25.

import { buildRowsFromGrid, columnSamples, summarizeRows, normalizeHeaderLabel } from './tabular.js';
import { openModal } from './dialog.js';

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(d));

const CHANNELS = [
  { key: 'z', label: 'Diepte', required: true },
  { key: 'qc', label: 'Conusweerstand qc', required: true },
  { key: 'fs', label: 'Kleefweerstand fs', required: false },
  { key: 'rf', label: 'Wrijvingsgetal Rf', required: false }
];

function sampleText(values) {
  if (!values.length) return '—';
  return values.map((v) => (typeof v === 'number' ? String(+(+v).toFixed(4)) : String(v))).join(' · ');
}

function qualityNotes(summary, assumedRf) {
  const notes = [];
  if (!summary.n) {
    notes.push({ tone: 'bad', text: 'Geen geldige metingen met deze kolomtoewijzing.' });
    return notes;
  }
  const missing = summary.missingFsRfCount;
  if (missing === 0) {
    notes.push({ tone: 'ok', text: 'Alle metingen hebben qc én fs/Rf.' });
  } else if (summary.fsCount === 0 && summary.rfCount === 0) {
    notes.push({
      tone: 'bad',
      text: `Geen gemeten fs/Rf in het bestand — de classificatie gebruikt overal een aangenomen Rf (${assumedRf} %).`
    });
  } else if (summary.missingOnlyTrailing) {
    notes.push({
      tone: 'note',
      text:
        `${missing} van ${summary.n} metingen zonder fs/Rf, alleen aan het einde van het profiel ` +
        `(${summary.missingFsRfDepths.map((z) => z.toFixed(2)).join(', ')} m) — gebruikelijk voor de laatste meetstap.`
    });
  } else {
    notes.push({
      tone: 'warn',
      text: `${missing} van ${summary.n} metingen zonder fs/Rf, op ${summary.missingFsRfDepths
        .slice(0, 6)
        .map((z) => z.toFixed(2))
        .join(', ')}${missing > 6 ? ', …' : ''} m diepte.`
    });
  }
  return notes;
}

/** Quality-note tone → the §3.11 verdict modifier. The tag words stay out: the notes are sentences
 *  and their text is locked by the DOM-text goldens. */
const NOTE_VERDICT = { ok: 'verdict--good', note: 'verdict--inline verdict--neutral', warn: 'verdict--warn', bad: 'verdict--bad' };

/**
 * @param {object} staged
 *   { fileName, format,
 *     grid?, headerIdx?, cols?,          — tabular sources (Excel/CSV)
 *     rows?, channels?,                  — structured sources (GEF)
 *     context: { waterLevel, waterSource, elevation, elevationSource,
 *                x, y, testid, project, assumedRf } }
 * @returns {Promise<{rows: Array, cols?: object} | null>}  null = cancelled
 */
export function presentImportReview(staged) {
  return new Promise((resolve) => {
    const isGrid = Array.isArray(staged.grid);
    let cols = { ...(staged.cols || {}) };
    let current = isGrid ? buildRowsFromGrid(staged.grid, staged.headerIdx, cols) : { rows: staged.rows, skipped: staged.skipped || [] };

    // A native <dialog>: focus trap, Escape and an inert page come from showModal(); openModal()
    // adds the backdrop click, the focus restore and the removal (dialog.js).
    // `className` stays the single name `import-review-overlay` — the Node golden harness
    // (scripts/golden/lib/load-controller.mjs) recognises the overlay by an exact match, and the
    // browser journeys, the visual suite and components.css §25 all select on it.
    const overlay = document.createElement('dialog');
    overlay.className = 'import-review-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Import controleren — ${staged.fileName}`);
    document.body.appendChild(overlay);

    const close = openModal(overlay, resolve);

    function headerOptions(selectedIdx, required) {
      const headers = staged.grid[staged.headerIdx] || [];
      const opts = headers
        .map((h, i) => ({ h, i }))
        .filter(({ h }) => h != null && String(h).trim() !== '')
        .map(
          ({ h, i }) =>
            `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>kolom ${i + 1} — ${esc(String(h))}</option>`
        )
        .join('');
      return (required ? '' : `<option value="-1" ${selectedIdx < 0 ? 'selected' : ''}>— niet aanwezig —</option>`) + opts;
    }

    function channelRows() {
      if (isGrid) {
        return CHANNELS.map((ch) => {
          const idx = cols[ch.key];
          const samples = columnSamples(staged.grid, staged.headerIdx, idx);
          return `<tr>
            <td class="modal__ch">${ch.label}${ch.required ? ' *' : ''}</td>
            <td><select class="input input--sm" data-col="${ch.key}">${headerOptions(idx, ch.required)}</select></td>
            <td class="modal__samples">${esc(sampleText(samples))}</td>
          </tr>`;
        }).join('');
      }
      return (staged.channels || [])
        .map(
          (ch) => `<tr>
            <td class="modal__ch">${esc(ch.label)}</td>
            <td>${esc(ch.source)}</td>
            <td class="modal__samples">${esc(ch.unit || '—')}</td>
          </tr>`
        )
        .join('');
    }

    function render() {
      const summary = summarizeRows(current.rows);
      const notes = qualityNotes(summary, staged.context.assumedRf);
      const ctx = staged.context;
      const skippedByReason = new Map();
      (current.skipped || []).forEach((s) => skippedByReason.set(s.reason, (skippedByReason.get(s.reason) || 0) + 1));

      // The block structure below is load-bearing: `htmlToText` (Node goldens) turns every closing
      // div / tr / option into a line and every closing td into a tab, and the browser goldens read
      // `innerText`. Tags, their nesting and the source line *breaks* stay as they were (leading
      // indentation is trimmed by both, so only the breaks matter) — the classes and the two ARIA
      // attributes are the change.
      overlay.innerHTML = `
      <div class="import-review modal glass-sheet">
        <div class="modal__head">
          <div>
            <h2 class="modal__title">Import controleren</h2>
            <div class="modal__meta">${esc(staged.fileName)} · ${esc(staged.format)}${ctx.testid ? ` · ${esc(ctx.testid)}` : ''}</div>
          </div>
          <button type="button" class="btn btn--sm btn--icon" data-ir="cancel" aria-label="Annuleer import">✕</button>
        </div>

        <div class="modal__body">
          <div class="modal__section">
            <div class="eyebrow">Herkende kolommen</div>
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr><th>Grootheid</th><th>${isGrid ? 'Kolom in bestand' : 'Bron'}</th><th>${isGrid ? 'Eerste waarden' : 'Eenheid'}</th></tr></thead>
                <tbody>${channelRows()}</tbody>
              </table>
            </div>
            ${isGrid ? `<div class="field__hint">Eenheden worden uit het kolomlabel gelezen (MPa/kPa); pas de toewijzing aan als een kolom verkeerd herkend is — de statistieken hieronder rekenen direct mee.</div>` : ''}
          </div>

          <div class="modal__section">
            <div class="eyebrow">Metingen</div>
            <div class="stats stats--dense stats--meta">
              <div class="stat"><span class="stat__label">metingen</span><strong class="stat__value">${summary.n}</strong></div>
              <div class="stat"><span class="stat__label">diepte</span><strong class="stat__value">${fmtNum(summary.depthMin)} – ${fmtNum(summary.depthMax)} m</strong></div>
              <div class="stat"><span class="stat__label">met fs</span><strong class="stat__value">${summary.fsCount}</strong></div>
              <div class="stat"><span class="stat__label">met Rf</span><strong class="stat__value">${summary.rfCount}</strong></div>
              ${summary.u2Count ? `<div class="stat"><span class="stat__label">met u2</span><strong class="stat__value">${summary.u2Count}</strong></div>` : ''}
              ${
                current.skipped?.length
                  ? `<div class="stat"><span class="stat__label">overgeslagen</span><strong class="stat__value">${current.skipped.length}</strong></div>`
                  : ''
              }
            </div>
            ${[...skippedByReason]
              .map(([reason, count]) => `<div class="verdict verdict--inline verdict--neutral">${count}× overgeslagen: ${esc(reason)}</div>`)
              .join('')}
            ${notes.map((n) => `<div class="verdict ${NOTE_VERDICT[n.tone] || NOTE_VERDICT.note}">${esc(n.text)}</div>`).join('')}
          </div>

          <div class="modal__section">
            <div class="eyebrow">Bestandsgegevens</div>
            <table class="modal__meta-table">
              <tr><td>Maaiveld</td><td>${ctx.elevation != null ? `${fmtNum(ctx.elevation)} m TAW <span class="modal__src">(${esc(ctx.elevationSource || 'bestand')})</span>` : 'niet in bestand — stel in bij Stage 1'}</td></tr>
              <tr><td>Waterpeil</td><td>${ctx.waterLevel != null ? `${fmtNum(ctx.waterLevel)} m onder maaiveld <span class="modal__src">(${esc(ctx.waterSource || 'bestand')})</span>` : 'niet in bestand — standaard, instelbaar bij Stage 1'}</td></tr>
              <tr><td>Coördinaten</td><td>${ctx.x != null && ctx.y != null ? `X ${fmtNum(ctx.x, 1)} · Y ${fmtNum(ctx.y, 1)}` : 'niet in bestand'}</td></tr>
              ${ctx.project ? `<tr><td>Project</td><td>${esc(ctx.project)}</td></tr>` : ''}
            </table>
          </div>
        </div>

        <div class="modal__foot">
          <button type="button" class="btn" data-ir="cancel">Annuleer</button>
          <button type="button" class="btn btn--primary" data-ir="apply" ${summary.n ? '' : 'disabled'}>Importeer ${summary.n} metingen</button>
        </div>
      </div>`;

      overlay.querySelectorAll('[data-col]').forEach((sel) => {
        sel.addEventListener('change', () => {
          cols = { ...cols, [sel.dataset.col]: +sel.value };
          current = buildRowsFromGrid(staged.grid, staged.headerIdx, cols);
          render();
        });
      });
      overlay.querySelector('[data-ir="cancel"]')?.focus?.();
      overlay.querySelectorAll('[data-ir]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.ir === 'cancel') close(null);
          else if (!btn.disabled) close(isGrid ? { rows: current.rows, cols } : { rows: current.rows });
        });
      });
    }

    render();
    overlay.querySelector('[data-ir="apply"]')?.focus?.();
  });
}
