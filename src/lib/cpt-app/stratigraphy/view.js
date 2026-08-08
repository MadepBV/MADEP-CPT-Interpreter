// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stratigraphy panel view. Renders the Correlatie phase into its mount node
// and translates DOM events into store calls — no correlation logic lives
// here. Follows the retaining-ui pattern: innerHTML rendering + one
// delegated event listener, reusing the app's existing CSS vocabulary.

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : (+v).toFixed(d));

function range(a, d = 1) {
  if (!a || a.min == null) return '—';
  if (a.min === a.max) return fmt(a.min, d);
  return `${fmt(a.min, d)}–${fmt(a.max, d)}`;
}

export function createStratigraphyView({ store, actions }) {
  // actions: { onChanged(), export(kind), openSoilinReport() } — provided by
  // index.js so the view stays free of file/window concerns.
  let mount = null;

  function render() {
    mount = document.getElementById('stratPanel');
    if (!mount) return;
    const d = store.derived();
    mount.innerHTML = [
      renderToolbar(d),
      renderNotices(d),
      d.hasResult && !d.stale ? renderDiagram(d) : '',
      d.hasResult && !d.stale ? renderUnitTable(d) : ''
    ].join('');
  }

  // ── toolbar ────────────────────────────────────────────────────────────

  function renderToolbar(d) {
    const s = d.settings;
    const canExport = d.hasResult && !d.stale && d.units.length > 0;
    return `
    <div class="strat-toolbar" style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:12px">
      <button class="btn pri sm" data-act="run">${d.hasResult ? 'Hercorreleer' : 'Correleer lagen'}</button>
      <label class="ctrl-lbl" style="display:inline-flex;align-items:center;gap:6px">Gevoeligheid
        <select data-setting="minMatch" style="font-size:12px">
          <option value="0.35" ${s.minMatch <= 0.38 ? 'selected' : ''}>ruim (meer verbonden)</option>
          <option value="0.45" ${s.minMatch > 0.38 && s.minMatch < 0.52 ? 'selected' : ''}>normaal</option>
          <option value="0.55" ${s.minMatch >= 0.52 ? 'selected' : ''}>strikt (meer lenzen)</option>
        </select>
      </label>
      <label class="ctrl-lbl" style="display:inline-flex;align-items:center;gap:6px">Karakteristiek
        <select data-setting="characteristic" style="font-size:12px">
          <option value="wmean" ${s.characteristic === 'wmean' ? 'selected' : ''}>gewogen gemiddelde</option>
          <option value="min" ${s.characteristic === 'min' ? 'selected' : ''}>ondergrens (min)</option>
        </select>
      </label>
      <span style="flex:1"></span>
      <span class="ctrl-lbl">Export</span>
      <button class="btn sm" data-act="export-csv" ${canExport ? '' : 'disabled'}>CSV</button>
      <button class="btn sm" data-act="export-plaxis" ${canExport ? '' : 'disabled'}>PLAXIS materialen</button>
      <button class="btn sm" data-act="export-dxf" ${canExport ? '' : 'disabled'}>DXF doorsnede</button>
      <button class="btn sm" data-act="soilin-report" ${canExport ? '' : 'disabled'}>SOILIN rapport</button>
    </div>`;
  }

  // ── notices ────────────────────────────────────────────────────────────

  function renderNotices(d) {
    const blocks = [];
    if (d.profiles.cpts.length < 2) {
      blocks.push(
        `<div class="info">Minimaal 2 CPTs met bevestigde maaiveldhoogte en laagindeling vereist. ` +
          `Doorloop Stage 1–3 per CPT en bevestig de maaiveldhoogte (m TAW).</div>`
      );
    } else if (d.stale) {
      blocks.push(
        `<div class="info" style="display:flex;align-items:center;gap:12px;justify-content:space-between">` +
          `<span>De laagindeling of maaiveldhoogte van een CPT is gewijzigd sinds de correlatie. ` +
          `Herbereken om de stratigrafie bij te werken${store.hasManualEdits() ? ' (handmatige aanpassingen gaan hierbij verloren)' : ''}.</span>` +
          `<button class="btn pri sm" data-act="run">Herbereken</button></div>`
      );
    } else if (!d.hasResult) {
      blocks.push(`<div class="info">Klik op "Correleer lagen" om de stratigrafie op te bouwen.</div>`);
    }
    d.excluded.forEach((x) => {
      blocks.push(
        `<div style="font-size:12px;color:var(--tx3);padding:2px 0">· ${esc(x.id)} niet opgenomen: ${esc(x.reason)}.</div>`
      );
    });
    d.warnings.forEach((w) => {
      blocks.push(
        `<div class="layerwarn layerwarn-adj" style="margin-top:6px"><span class="layerwarn-msg">${esc(w.text)}</span></div>`
      );
    });
    return blocks.length ? `<div style="margin-bottom:10px">${blocks.join('')}</div>` : '';
  }

  // ── correlation diagram ────────────────────────────────────────────────

  function renderDiagram(d) {
    const cpts = d.profiles.cpts;
    if (cpts.length < 2) return '';

    const ML = 56;
    const MR = 24;
    const MT = 34;
    const MB = 26;
    const W = Math.max(620, cpts.length * 210);
    const elevs = [];
    cpts.forEach((c) => {
      elevs.push(c.elev);
      c.layers.forEach((l) => elevs.push(l.botTaw));
    });
    const maxE = Math.max(...elevs) + 0.6;
    const minE = Math.min(...elevs) - 0.6;
    const H = Math.max(300, (maxE - minE) * 22);
    const distMin = cpts[0].dist;
    const distMax = cpts[cpts.length - 1].dist;
    const px = (dist) => ML + ((dist - distMin) / Math.max(distMax - distMin, 1)) * W;
    const py = (taw) => MT + ((maxE - taw) / Math.max(maxE - minE, 0.01)) * H;

    const unitById = new Map(d.units.map((u) => [u.id, u]));
    let s = '';

    // Elevation grid.
    const span = maxE - minE;
    const step = span <= 6 ? 1 : span <= 15 ? 2 : 5;
    for (let e = Math.ceil(minE / step) * step; e <= maxE; e += step) {
      s += `<line x1="${ML}" x2="${ML + W}" y1="${py(e)}" y2="${py(e)}" stroke="rgba(128,128,128,0.12)" stroke-width="0.5"/>`;
      s += `<text x="${ML - 6}" y="${py(e) + 3.5}" font-size="9" text-anchor="end" fill="var(--tx3)">${e.toFixed(0)}</text>`;
    }

    // Unit ribbons — the exact section polygons, so the correlation view and
    // the Doorsnede can never disagree.
    d.polygons.forEach((poly) => {
      const pts = poly.points.map((p) => `${px(p.dist).toFixed(1)},${py(p.taw).toFixed(1)}`).join(' ');
      s += `<polygon points="${pts}" fill="${poly.color}" fill-opacity="0.30" stroke="${poly.color}" stroke-opacity="0.8" stroke-width="1"/>`;
      const unit = unitById.get(poly.unitId);
      if (unit) {
        const mid = poly.points[Math.floor(poly.points.length / 4)];
        s += `<text x="${px(mid.dist).toFixed(1)}" y="${(py(mid.taw) + 12).toFixed(1)}" font-size="10" font-weight="700" fill="var(--tx2)">${esc(unit.letter)}</text>`;
      }
    });

    // CPT columns on top.
    const colW = 20;
    cpts.forEach((c) => {
      const x = px(c.dist);
      s += `<text x="${x}" y="${MT - 18}" font-size="11" font-weight="600" text-anchor="middle" fill="var(--tx)">${esc(c.id)}</text>`;
      s += `<text x="${x}" y="${MT - 6}" font-size="9" text-anchor="middle" fill="var(--tx3)">${c.dist.toFixed(0)} m · mv ${c.elev.toFixed(2)}</text>`;
      c.layers.forEach((l) => {
        const unit = d.units.find((u) => u.members.some((m) => m.cptIdx === c.cptIdx && m.layerIdx === l.layerIdx));
        const y1 = py(l.topTaw);
        const y2 = py(l.botTaw);
        s += `<rect x="${(x - colW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${colW}" height="${Math.max(y2 - y1, 1.5).toFixed(1)}"
          fill="${unit ? unit.color : '#D3D1C7'}" stroke="rgba(0,0,0,0.35)" stroke-width="0.6">
          <title>${esc(c.id)} — ${esc(l.subtype || l.type)}
${l.topTaw.toFixed(2)} → ${l.botTaw.toFixed(2)} m TAW · qc ${fmt(l.avgQc)} MPa${unit ? `\nEenheid ${esc(unit.letter)}` : ''}</title></rect>`;
        if (unit && y2 - y1 > 11) {
          s += `<text x="${x}" y="${((y1 + y2) / 2 + 3.5).toFixed(1)}" font-size="9" font-weight="700" text-anchor="middle" fill="rgba(0,0,0,0.6)">${esc(unit.letter)}</text>`;
        }
      });
    });

    const totalW = W + ML + MR;
    const totalH = H + MT + MB;
    return `
    <div style="overflow-x:auto;border:1px solid var(--bd);border-radius:var(--r);background:var(--bg);margin-bottom:14px">
      <svg viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" style="display:block" role="img" aria-label="Stratigrafische correlatie">${s}</svg>
    </div>`;
  }

  // ── unit table ─────────────────────────────────────────────────────────

  function unitOptions(d, selectedId) {
    const opts = d.units
      .map(
        (u) =>
          `<option value="${esc(u.id)}" ${u.id === selectedId ? 'selected' : ''}>${esc(u.letter)} — ${esc(u.subtype || u.type)}</option>`
      )
      .join('');
    return opts + `<option value="new">→ nieuwe eenheid</option>`;
  }

  function renderUnitTable(d) {
    if (!d.units.length) return '';
    const cpts = d.profiles.cpts;
    const head =
      `<tr><th style="min-width:170px">Eenheid</th>` +
      cpts.map((c) => `<th style="min-width:130px">${esc(c.id)}</th>`).join('') +
      `<th>Dikte (m)</th><th>qc (MPa)</th><th>φ′ (°)</th><th>c′ (kPa)</th><th>E_def (MPa)</th><th></th></tr>`;

    const rows = d.units
      .map((u) => {
        const cells = cpts
          .map((c) => {
            const members = u.members.filter((m) => m.cptIdx === c.cptIdx);
            if (!members.length) {
              return `<td style="text-align:center;color:var(--tx3);font-size:10px">— uitwiggend</td>`;
            }
            const inner = members
              .map((m) => {
                const layer = c.layers.find((l) => l.layerIdx === m.layerIdx);
                if (!layer) return '';
                return `<div style="margin-bottom:4px">
                <div style="font-size:10px;color:var(--tx2)">${layer.topTaw.toFixed(2)} → ${layer.botTaw.toFixed(2)} TAW · ${fmt(layer.thk)} m</div>
                <select data-assign data-cpt="${m.cptIdx}" data-layer="${m.layerIdx}" style="font-size:10px;max-width:120px">${unitOptions(d, u.id)}</select>
              </div>`;
              })
              .join('');
            return `<td style="vertical-align:top;padding:5px 8px">${inner}</td>`;
          })
          .join('');

        const mergeTargets = d.units
          .filter((v) => v.id !== u.id)
          .map((v) => `<option value="${esc(v.id)}">${esc(v.letter)} — ${esc(v.subtype || v.type)}</option>`)
          .join('');

        return `<tr>
        <td style="vertical-align:top">
          <div style="display:flex;align-items:center;gap:7px">
            <span style="width:12px;height:12px;border-radius:3px;background:${u.color};border:1px solid rgba(0,0,0,0.25);flex:none"></span>
            <input type="text" value="${esc(u.name)}" data-rename="${esc(u.id)}" aria-label="Naam eenheid ${esc(u.letter)}"
              style="font-size:11px;font-weight:600;width:150px;background:transparent;border:1px solid transparent;border-radius:4px;padding:2px 4px"
              onfocus="this.style.borderColor='var(--bd)'" onblur="this.style.borderColor='transparent'">
          </div>
          <div style="font-size:10px;color:var(--tx3);margin:3px 0 0 19px">${esc(u.type)} · ${u.members.length} ${u.members.length === 1 ? 'laag (lens)' : 'lagen'}</div>
        </td>
        ${cells}
        <td style="font-size:11px">${range(u.agg.thk)}</td>
        <td style="font-size:11px">${fmt(u.agg.qc.wmean)}<div style="font-size:9px;color:var(--tx3)">${range(u.agg.qc)}</div></td>
        <td style="font-size:11px">${fmt(u.characteristic.phi, 1)}<div style="font-size:9px;color:var(--tx3)">${range(u.agg.phi)}</div></td>
        <td style="font-size:11px">${fmt(u.characteristic.c, 1)}<div style="font-size:9px;color:var(--tx3)">${range(u.agg.c)}</div></td>
        <td style="font-size:11px">${u.params ? fmt(u.params.Edef.wmean / 1000, 1) : '—'}</td>
        <td style="vertical-align:top">
          ${
            mergeTargets
              ? `<select data-merge="${esc(u.id)}" style="font-size:10px;max-width:110px">
                   <option value="">Voeg samen met…</option>${mergeTargets}
                 </select>`
              : ''
          }
        </td>
      </tr>`;
      })
      .join('');

    return `
    <div style="overflow-x:auto">
      <table class="tbl"><thead>${head}</thead><tbody>${rows}</tbody></table>
    </div>
    <div style="font-size:10px;color:var(--tx3);margin-top:8px">
      Waarden per eenheid: dikte-gewogen gemiddelde over de deelnemende lagen, met min–max eronder.
      Wijs een laag aan een andere eenheid toe via de dropdown in de CPT-kolom.
    </div>`;
  }

  // ── events ─────────────────────────────────────────────────────────────

  function confirmRerun() {
    if (!store.hasManualEdits()) return true;
    return window.confirm('Hercorreleren verwijdert de handmatige aanpassingen (toewijzingen, namen). Doorgaan?');
  }

  function handleClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'run') {
      if (!confirmRerun()) return;
      store.run();
      render();
      actions.onChanged();
    } else if (act === 'export-csv') actions.export('csv');
    else if (act === 'export-plaxis') actions.export('plaxis');
    else if (act === 'export-dxf') actions.export('dxf');
    else if (act === 'soilin-report') actions.openSoilinReport();
  }

  function handleChange(e) {
    const t = e.target;
    if (t.matches('[data-setting]')) {
      const key = t.dataset.setting;
      store.setSetting(key, t.value);
      if (key === 'minMatch') {
        if (!confirmRerun()) {
          render();
          return;
        }
        store.run();
      }
      render();
      actions.onChanged();
    } else if (t.matches('[data-assign]')) {
      store.assignMember(+t.dataset.cpt, +t.dataset.layer, t.value);
      render();
      actions.onChanged();
    } else if (t.matches('[data-merge]')) {
      if (t.value) {
        store.mergeUnits(t.dataset.merge, t.value);
        render();
        actions.onChanged();
      }
    } else if (t.matches('[data-rename]')) {
      store.renameUnit(t.dataset.rename, t.value);
      render();
      actions.onChanged();
    }
  }

  function install() {
    const host = document.getElementById('phaseCorr');
    if (!host || host.__stratBound) return;
    host.__stratBound = true;
    host.addEventListener('click', handleClick);
    host.addEventListener('change', handleChange);
  }

  return { render, install };
}
