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

import { buildRowsFromGrid, columnSamples, summarizeRows, normalizeHeaderLabel } from './tabular.js';

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

const NOTE_COLORS = { ok: 'var(--ok-text, #2e6f55)', note: 'var(--tx2)', warn: 'var(--wn)', bad: 'var(--bad, #9b3a32)' };

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

    const overlay = document.createElement('div');
    overlay.className = 'import-review-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Import controleren — ${staged.fileName}`);
    document.body.appendChild(overlay);

    function close(result) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }

    function onKey(e) {
      if (e.key === 'Escape') close(null);
    }
    document.addEventListener('keydown', onKey);

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
            <td class="ir-ch">${ch.label}${ch.required ? ' *' : ''}</td>
            <td><select data-col="${ch.key}">${headerOptions(idx, ch.required)}</select></td>
            <td class="ir-samples">${esc(sampleText(samples))}</td>
          </tr>`;
        }).join('');
      }
      return (staged.channels || [])
        .map(
          (ch) => `<tr>
            <td class="ir-ch">${esc(ch.label)}</td>
            <td>${esc(ch.source)}</td>
            <td class="ir-samples">${esc(ch.unit || '—')}</td>
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

      overlay.innerHTML = `
      <div class="import-review">
        <div class="ir-head">
          <div>
            <div class="ir-title">Import controleren</div>
            <div class="ir-file">${esc(staged.fileName)} · ${esc(staged.format)}${ctx.testid ? ` · ${esc(ctx.testid)}` : ''}</div>
          </div>
          <button class="btn sm" data-ir="cancel" aria-label="Annuleer import">✕</button>
        </div>

        <div class="ir-section">
          <div class="ir-sec-title">Herkende kolommen</div>
          <table class="ir-table">
            <thead><tr><th>Grootheid</th><th>${isGrid ? 'Kolom in bestand' : 'Bron'}</th><th>${isGrid ? 'Eerste waarden' : 'Eenheid'}</th></tr></thead>
            <tbody>${channelRows()}</tbody>
          </table>
          ${isGrid ? `<div class="ir-hint">Eenheden worden uit het kolomlabel gelezen (MPa/kPa); pas de toewijzing aan als een kolom verkeerd herkend is — de statistieken hieronder rekenen direct mee.</div>` : ''}
        </div>

        <div class="ir-section">
          <div class="ir-sec-title">Metingen</div>
          <div class="ir-stats">
            <div class="ir-stat"><span>metingen</span><strong>${summary.n}</strong></div>
            <div class="ir-stat"><span>diepte</span><strong>${fmtNum(summary.depthMin)} – ${fmtNum(summary.depthMax)} m</strong></div>
            <div class="ir-stat"><span>met fs</span><strong>${summary.fsCount}</strong></div>
            <div class="ir-stat"><span>met Rf</span><strong>${summary.rfCount}</strong></div>
            ${summary.u2Count ? `<div class="ir-stat"><span>met u2</span><strong>${summary.u2Count}</strong></div>` : ''}
            ${
              current.skipped?.length
                ? `<div class="ir-stat"><span>overgeslagen</span><strong>${current.skipped.length}</strong></div>`
                : ''
            }
          </div>
          ${[...skippedByReason]
            .map(([reason, count]) => `<div class="ir-note" style="color:var(--tx3)">${count}× overgeslagen: ${esc(reason)}</div>`)
            .join('')}
          ${notes.map((n) => `<div class="ir-note" style="color:${NOTE_COLORS[n.tone]}">${esc(n.text)}</div>`).join('')}
        </div>

        <div class="ir-section">
          <div class="ir-sec-title">Bestandsgegevens</div>
          <table class="ir-meta">
            <tr><td>Maaiveld</td><td>${ctx.elevation != null ? `${fmtNum(ctx.elevation)} m TAW <span class="ir-src">(${esc(ctx.elevationSource || 'bestand')})</span>` : 'niet in bestand — stel in bij Stage 1'}</td></tr>
            <tr><td>Waterpeil</td><td>${ctx.waterLevel != null ? `${fmtNum(ctx.waterLevel)} m onder maaiveld <span class="ir-src">(${esc(ctx.waterSource || 'bestand')})</span>` : 'niet in bestand — standaard, instelbaar bij Stage 1'}</td></tr>
            <tr><td>Coördinaten</td><td>${ctx.x != null && ctx.y != null ? `X ${fmtNum(ctx.x, 1)} · Y ${fmtNum(ctx.y, 1)}` : 'niet in bestand'}</td></tr>
            ${ctx.project ? `<tr><td>Project</td><td>${esc(ctx.project)}</td></tr>` : ''}
          </table>
        </div>

        <div class="ir-foot">
          <button class="btn" data-ir="cancel">Annuleer</button>
          <button class="btn pri" data-ir="apply" ${summary.n ? '' : 'disabled'}>Importeer ${summary.n} metingen</button>
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

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    render();
    overlay.querySelector('[data-ir="apply"]')?.focus?.();
  });
}
